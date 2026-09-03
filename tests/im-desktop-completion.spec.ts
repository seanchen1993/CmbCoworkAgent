import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import initSqlJs from "sql.js"
import type { ThreadRow } from "../src/main/db"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImDesktopCompletionObserver } from "../src/main/services/im/desktop-completion"
import { ImEventStore } from "../src/main/services/im/event-store"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImRemoteGrantStore } from "../src/main/services/im/remote-grant-store"
import { ensureImServiceSchema } from "../src/main/services/im/schema"

async function createContext(options: { sendFails?: boolean } = {}) {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const persistence = { flushCount: 0 }
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => {
      persistence.flushCount += 1
    },
    now: () => Date.parse("2026-07-29T08:00:00.000Z")
  }
  const conversations = new ImConversationStateStore(dependencies)
  const grants = new ImRemoteGrantStore(dependencies, () => "desktop-grant")
  const events = new ImEventStore(dependencies)
  const route = {
    principalId: "principal-1",
    conversationKey: "conversation-1"
  }
  await conversations.ensureConversation(route)
  await grants.enableThreadGrant({ route, threadId: "thread-1", title: "桌面会话" })
  const thread: ThreadRow = {
    thread_id: "thread-1",
    created_at: Date.now(),
    updated_at: Date.now(),
    title: "桌面会话",
    status: "idle",
    thread_values: null,
    metadata: JSON.stringify({ workspacePath: "/workspace", agentMode: "normal" })
  }
  let sendCount = 0
  const warnings: unknown[] = []
  const observer = new ImDesktopCompletionObserver({
    conversations,
    access: {
      getThreadGrant: (threadId) => grants.getThreadGrant(threadId),
      validateThreadForCompletionDelivery: () => ({ thread, workspacePath: "/workspace" })
    },
    events,
    getReplyDrainer: () => ({
      sendPending: async () => {
        sendCount += 1
        if (options.sendFails) throw new Error("gateway offline")
        return { sent: 0, unknown: 0, failed: 0, deferred: 0 }
      }
    }),
    warn: (_message, error) => warnings.push(error)
  })
  return {
    database,
    conversations,
    grants,
    events,
    observer,
    persistence,
    warnings,
    sendCount: () => sendCount
  }
}

async function testStableDesktopDeliveryIsDurableAndIdempotent(): Promise<void> {
  const context = await createContext()
  try {
    const completion = {
      source: "desktop" as const,
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-final-1",
      finalText: "桌面最终答复"
    }
    const first = await context.observer.observe(completion)
    const second = await context.observer.observe(completion)
    assert.deepEqual(first, {
      status: "enqueued",
      deliveryId: "desktop-turn:thread-1:assistant-final-1"
    })
    assert.deepEqual(second, first)
    const outbox = context.events.listOutbox()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].content, `【会话：桌面会话】\n${completion.finalText}`)
    assert.equal(outbox[0].eventId, null)
    assert(context.persistence.flushCount > 0, "proactive outbox must cross a strict flush")
  } finally {
    context.database.close()
  }
}

async function testRevocationAndRouteChangeFailClosed(): Promise<void> {
  const context = await createContext()
  try {
    await context.grants.revokeThreadGrant("thread-1")
    assert.deepEqual(
      await context.observer.observe({
        source: "desktop",
        threadId: "thread-1",
        finalAssistantMessageId: "assistant-after-revoke",
        finalText: "不应外发"
      }),
      { status: "skipped", reasonCode: "THREAD_GRANT_INACTIVE" }
    )
    assert.equal(context.events.listOutbox().length, 0)

    const nextGrant = await context.grants.enableThreadGrant({
      route: {
        principalId: "principal-2",
        conversationKey: "conversation-1"
      },
      threadId: "thread-1",
      title: "桌面会话"
    })
    assert.equal(nextGrant.state, "active")
    assert.deepEqual(
      await context.observer.observe({
        source: "desktop",
        threadId: "thread-1",
        finalAssistantMessageId: "assistant-wrong-owner",
        finalText: "错误身份结果"
      }),
      { status: "skipped", reasonCode: "GRANT_ROUTE_STALE" }
    )
  } finally {
    context.database.close()
  }
}

async function testOutboxAndGatewayFailuresNeverEscapeObserver(): Promise<void> {
  const gatewayFailure = await createContext({ sendFails: true })
  try {
    const result = await gatewayFailure.observer.observe({
      source: "desktop",
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-offline",
      finalText: "仍应进入 outbox"
    })
    assert.equal(result.status, "enqueued")
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(gatewayFailure.events.listOutbox().length, 1)
    assert.equal(gatewayFailure.sendCount(), 1)
    assert.equal(gatewayFailure.warnings.length, 1)

    const outboxFailureObserver = new ImDesktopCompletionObserver({
      conversations: gatewayFailure.conversations,
      access: {
        getThreadGrant: (threadId) => gatewayFailure.grants.getThreadGrant(threadId),
        validateThreadForCompletionDelivery: () =>
          ({
            thread: { title: "桌面会话" },
            workspacePath: "/workspace"
          }) as never
      },
      events: {
        enqueueProactiveReplies: async () => {
          throw new Error("disk full")
        }
      },
      getReplyDrainer: () => null,
      warn: () => undefined
    })
    assert.deepEqual(
      await outboxFailureObserver.observe({
        source: "desktop",
        threadId: "thread-1",
        finalAssistantMessageId: "assistant-disk-failure",
        finalText: "桌面仍成功"
      }),
      { status: "failed", reasonCode: "DESKTOP_COMPLETION_OBSERVER_FAILED" }
    )
  } finally {
    gatewayFailure.database.close()
  }
}

async function testInboundConfirmedRouteRebindsGrantAndRejectedProactiveReply(): Promise<void> {
  const context = await createContext()
  try {
    await context.observer.observe({
      source: "desktop",
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-stale-route",
      finalText: "需要改投到当前招乎会话"
    })
    await context.observer.observe({
      source: "desktop",
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-route-sync-pending",
      finalText: "等待真实入站消息确认路由"
    })
    const [rejected, deferred] = context.events.listOutbox()
    await context.events.markOutboxSending(rejected.outboxId)
    await context.events.markOutboxFailed(rejected.outboxId, "ROUTE_NOT_FOUND")
    await context.events.markOutboxSending(deferred.outboxId)
    await context.events.rescheduleOutbox(
      deferred.outboxId,
      Date.parse("2026-07-29T08:01:00.000Z"),
      "ROUTE_SYNC_PENDING"
    )

    // SYNC_STATE can contain multiple historical ACTIVE routes. The App must
    // not migrate anything until a real inbound event confirms one of them.
    assert.equal(context.grants.getThreadGrant("thread-1")!.conversationKey, "conversation-1")
    assert.deepEqual(
      context.events.listOutbox().map((reply) => reply.state),
      ["failed", "pending"]
    )

    // This is the route carried by the next REMOTE_EVENT.
    const currentRoute = {
      principalId: "principal-1",
      conversationKey: "conversation-current"
    }
    await context.conversations.ensureConversation(currentRoute)
    assert.equal(await context.grants.rebindActiveThreadGrants(currentRoute), 1)
    assert.equal(
      await context.events.rerouteUnacceptedProactiveReplies({
        fromConversationKeys: ["conversation-1"],
        toConversationKey: currentRoute.conversationKey
      }),
      2
    )

    const grant = context.grants.getThreadGrant("thread-1")!
    assert.equal(grant.conversationKey, currentRoute.conversationKey)
    assert.equal(grant.grantVersion, 2)
    const rerouted = context.events.listOutbox()
    assert.equal(rerouted.length, 2)
    assert(
      rerouted.every(
        (reply) =>
          reply.conversationKey === currentRoute.conversationKey &&
          reply.state === "pending" &&
          reply.reasonCode === null
      )
    )
  } finally {
    context.database.close()
  }
}

function testDesktopEntrypointsUseNarrowCompletionSeam(): void {
  const source = readFileSync(resolve(__dirname, "../src/main/ipc/agent.ts"), "utf8")
  assert.equal(
    (source.match(/captureStreamAssistantCursor\(threadId\)/gu) ?? []).length,
    3,
    "invoke, resume and interrupt each capture their own stream cursor"
  )
  assert.equal(
    (
      source.match(
        /scheduleDesktopTurnCompletion\(threadId, runToken, desktopCompletionCursor\)/gu
      ) ?? []
    ).length,
    2,
    "resume and interrupt use the desktop completion observer directly"
  )
  assert(
    source.includes(
      "deliverManagedAgentRunCompletion(\n                runExecutionContext,\n                threadId,\n                runToken,\n                desktopCompletionCursor"
    ) && source.includes("scheduleDesktopTurnCompletion(threadId, runToken, cursor)"),
    "invoke routes through the managed completion seam, which preserves desktop observation by default"
  )
  assert(
    source.includes('invokeFinalOutcome === "success" && !isInternalNotificationTurn'),
    "ordinary invoke must exclude internal notification turns"
  )
}

async function main(): Promise<void> {
  for (const test of [
    testStableDesktopDeliveryIsDurableAndIdempotent,
    testRevocationAndRouteChangeFailClosed,
    testOutboxAndGatewayFailuresNeverEscapeObserver,
    testInboundConfirmedRouteRebindsGrantAndRejectedProactiveReply,
    testDesktopEntrypointsUseNarrowCompletionSeam
  ]) {
    await test()
    console.log(`PASS ${test.name}`)
  }
  console.log("im-desktop-completion.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
