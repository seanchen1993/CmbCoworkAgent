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

/**
 * 桌面发起的结果推到招乎时，必须标出它不是当前绑定的会话。
 *
 * 读者没有在招乎里发起过这一轮，落在一串对话里看不出它来自别处；不标注就会被当成
 * 当前会话的回复。IM 发起的和模式通知两条路一直都标，唯独这条漏了。
 */
async function testADesktopResultFromAnotherThreadSaysSo(): Promise<void> {
  const context = await createContext()
  try {
    // 把另一个会话设为当前绑定，桌面这一轮仍然发生在 thread-1。
    const bound = await context.conversations.registerTarget(
      "conversation-1",
      {
        kind: "thread",
        targetId: "target-bound",
        threadId: "thread-bound",
        grantId: "grant-bound",
        grantVersion: 1,
        title: "你好",
        workspacePath: "/workspace"
      },
      { activate: true }
    )
    assert.equal(
      context.conversations.getActiveTarget("conversation-1")?.threadId,
      "thread-bound",
      "前置条件：当前绑定的必须是另一个会话"
    )
    assert.equal(bound.snapshot.targetId, "target-bound")

    await context.observer.observe({
      source: "desktop" as const,
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-final-switched",
      finalText: "桌面最终答复"
    })
    const outbox = context.events.listOutbox()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].content, `【会话：桌面会话】（非当前绑定会话）\n桌面最终答复`)
  } finally {
    context.database.close()
  }
}

/** 反面:桌面这一轮就发生在当前绑定的会话里，不能平白多出一行提示。 */
async function testADesktopResultFromTheBoundThreadStaysQuiet(): Promise<void> {
  const context = await createContext()
  try {
    await context.conversations.registerTarget(
      "conversation-1",
      {
        kind: "thread",
        targetId: "target-same",
        threadId: "thread-1",
        grantId: "grant-same",
        grantVersion: 1,
        title: "桌面会话",
        workspacePath: "/workspace"
      },
      { activate: true }
    )
    await context.observer.observe({
      source: "desktop" as const,
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-final-same",
      finalText: "桌面最终答复"
    })
    const outbox = context.events.listOutbox()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].content, `【会话：桌面会话】\n桌面最终答复`)
  } finally {
    context.database.close()
  }
}

/**
 * 绑定的目标授权失效时，提示不能跟着消失。
 *
 * 这里原来用的是 getActiveTarget，它在目标不是 active 时抛异常，异常被吞成「没切换」，
 * 于是授权一挂提示就没了——而那正是最该提示的时候:读者既不知道结果来自别的会话，也
 * 不知道自己绑的那个已经不能用了。
 */
async function testASuspendedBindingStillGetsTheNotice(): Promise<void> {
  const context = await createContext()
  try {
    await context.conversations.registerTarget(
      "conversation-1",
      {
        kind: "thread",
        targetId: "target-suspended",
        threadId: "thread-bound",
        grantId: "grant-suspended",
        grantVersion: 1,
        title: "你好",
        workspacePath: "/workspace"
      },
      { activate: true }
    )
    // 生产上的真实顺序:绑定时是好的，之后授权才失效。registerTarget 也不允许直接
    // 激活一个非 active 的目标。
    await context.conversations.updateTargetState("target-suspended", "suspended", "grant revoked")
    await context.observer.observe({
      source: "desktop" as const,
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-final-suspended",
      finalText: "桌面最终答复"
    })
    const outbox = context.events.listOutbox()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].content, `【会话：桌面会话】（非当前绑定会话）\n桌面最终答复`)
  } finally {
    context.database.close()
  }
}

/**
 * 反面，也是不能简单地把「取不到活动目标」当成「不是当前绑定」的原因:
 * 挂掉的那个目标完全可能就是本会话，那样标注是错的。判的是身份，不是状态。
 */
async function testASuspendedBindingOnThisVeryThreadStaysQuiet(): Promise<void> {
  const context = await createContext()
  try {
    await context.conversations.registerTarget(
      "conversation-1",
      {
        kind: "thread",
        targetId: "target-suspended-same",
        threadId: "thread-1",
        grantId: "grant-suspended-same",
        grantVersion: 1,
        title: "桌面会话",
        workspacePath: "/workspace"
      },
      { activate: true }
    )
    await context.conversations.updateTargetState(
      "target-suspended-same",
      "suspended",
      "grant revoked"
    )
    await context.observer.observe({
      source: "desktop" as const,
      threadId: "thread-1",
      finalAssistantMessageId: "assistant-final-suspended-same",
      finalText: "桌面最终答复"
    })
    const outbox = context.events.listOutbox()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].content, `【会话：桌面会话】\n桌面最终答复`)
  } finally {
    context.database.close()
  }
}

async function main(): Promise<void> {
  for (const test of [
    testStableDesktopDeliveryIsDurableAndIdempotent,
    testADesktopResultFromAnotherThreadSaysSo,
    testADesktopResultFromTheBoundThreadStaysQuiet,
    testASuspendedBindingStillGetsTheNotice,
    testASuspendedBindingOnThisVeryThreadStaysQuiet,
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
