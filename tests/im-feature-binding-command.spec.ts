import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import type { ThreadRow } from "../src/main/db"
import { ImRemoteCapabilityGuard } from "../src/main/services/im/capability-guard"
import { ImCommandRouter, parseImCommand } from "../src/main/services/im/command-router"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImEventStore, type ImEventRecord } from "../src/main/services/im/event-store"
import { ImFeatureBindingService } from "../src/main/services/im/feature-binding-service"
import type {
  ImExecutionPermitResult,
  ImGatewayClientPort,
  ImReplySubmissionResult
} from "../src/main/services/im/gateway-client"
import { ImInboxService } from "../src/main/services/im/inbox-service"
import { ImIngressSequencer } from "../src/main/services/im/ingress-sequencer"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImReplyClient } from "../src/main/services/im/reply-client"
import {
  ImRemoteAccessError,
  ImRemoteAccessService
} from "../src/main/services/im/remote-access-service"
import { ImRemoteGrantStore } from "../src/main/services/im/remote-grant-store"
import { eventShortCode } from "../src/main/services/im/reply-segmentation"
import {
  ImSelectionContextError,
  ImSelectionContextStore
} from "../src/main/services/im/selection-context"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import type {
  RemoteImAckV1,
  RemoteImEventV1,
  RemoteImReplyV1
} from "../src/shared/im-gateway-contract"

class TestGateway implements ImGatewayClientPort {
  readonly acknowledgements: RemoteImAckV1[] = []
  readonly replies: RemoteImReplyV1[] = []

  isAuthenticated(): boolean {
    return true
  }

  async sendAcknowledgement(ack: RemoteImAckV1): Promise<void> {
    this.acknowledgements.push(ack)
  }

  async acquireExecutionPermit(): Promise<ImExecutionPermitResult> {
    return { status: "denied" }
  }

  async renewExecutionPermit(): Promise<ImExecutionPermitResult> {
    return { status: "denied" }
  }

  async submitReply(reply: RemoteImReplyV1): Promise<ImReplySubmissionResult> {
    this.replies.push(reply)
    return { state: "accepted", platformReplyId: `reply-${this.replies.length}` }
  }
}

function eventFixture(sequence: number, text: string): RemoteImEventV1 {
  return {
    schemaVersion: 1,
    eventId: `command-${sequence}`,
    platformMessageId: `platform-command-${sequence}`,
    principalId: "principal-1",
    conversationKey: "conversation-1",
    conversationSeq: sequence,
    message: { type: "text", text },
    occurredAt: `2026-07-23T08:00:${String(sequence).padStart(2, "0")}.000Z`,
    lease: { id: `lease-${sequence}`, expiresAt: "2026-07-23T09:00:00.000Z" }
  }
}

async function createContext() {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-feature-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-07-23T08:00:00.000Z") }
  const persistence: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => clock.now
  }
  const conversations = new ImConversationStateStore(persistence)
  const events = new ImEventStore(persistence)
  const selections = new ImSelectionContextStore(persistence, () => "selection-token", 60_000)
  await conversations.ensureConversation({
    conversationKey: "conversation-1",
    principalId: "principal-1"
  })

  const threads = new Map<string, ThreadRow>()
  const makeThread = (threadId: string, metadata?: Record<string, unknown>): ThreadRow => {
    const row: ThreadRow = {
      thread_id: threadId,
      created_at: clock.now,
      updated_at: clock.now,
      title: typeof metadata?.title === "string" ? metadata.title : null,
      status: "idle",
      thread_values: null,
      metadata: JSON.stringify(metadata ?? {})
    }
    threads.set(threadId, row)
    return row
  }
  const updateLocalThread = (threadId: string, patch: { metadata?: string }): void => {
    const row = threads.get(threadId)
    if (!row) return
    threads.set(threadId, { ...row, ...patch, updated_at: clock.now })
  }
  let id = 0
  const featureService = new ImFeatureBindingService({
    conversationState: conversations,
    getSettings: () => ({ enabled: true, remoteAccess: "inbox-and-features" }),
    projectModeEnabled: async () => true,
    listProjects: () =>
      [
        {
          projectId: "project-secret-id",
          name: "支付平台",
          lifecycle: { status: "active", createAt: "2026-07-23T00:00:00.000Z" },
          boardCompatibility: { compatible: true }
        }
      ] as never,
    getProjectDetail: () =>
      ({
        project: {
          projectId: "project-secret-id",
          name: "支付平台",
          projectRootPath: root,
          workspacePath: "/must-not-leak",
          sessionWorkspacePath: root
        },
        projectState: { label: "active", uiKind: "active" },
        runs: [
          {
            slug: "feature-pay",
            title: "快捷支付",
            location: "active",
            featureStatus: "in_progress",
            overallStatus: { label: "进行中", uiKind: "active" }
          }
        ],
        error: null
      }) as never,
    getRunDetail: () => ({ sessions: [] }) as never,
    buildFeatureContext: () => ({ featureId: "feature-pay" }) as never,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createThread: makeThread as never,
    updateThread: updateLocalThread as never,
    deleteThread: (threadId) => {
      threads.delete(threadId)
    },
    createId: () => `generated-${++id}`,
    getRunLease: () => undefined
  })
  const inbox = new ImInboxService({
    conversationState: conversations,
    openworkDirectory: () => root,
    createId: () => `inbox-${++id}`,
    createThread: makeThread,
    getThread: (threadId) => threads.get(threadId) ?? null,
    ensureDirectory: async () => undefined
  })
  const grants = new ImRemoteGrantStore(persistence, () => `grant-${++id}`)
  const access = new ImRemoteAccessService({
    conversations,
    grants,
    features: featureService,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createId: () => `target-${++id}`,
    getGoal: () => null,
    coordinator: {
      hasRunningWorkersForThread: () => false,
      hasNotifications: () => false,
      hasTerminalWorkerAwaitingNotificationForThread: () => false
    },
    workflow: { isBusyForThread: () => false },
    hasPendingApproval: () => false,
    hasPendingUserInput: () => false
  })
  return {
    root,
    database,
    clock,
    persistence,
    conversations,
    events,
    selections,
    threads,
    updateLocalThread,
    featureService,
    grants,
    access,
    makeThread,
    inbox
  }
}

async function testFeatureBindingIsImmutableAndCommandListsDoNotLeakPaths(): Promise<void> {
  const context = await createContext()
  const router = new ImCommandRouter({
    conversations: context.conversations,
    events: context.events,
    inbox: context.inbox,
    access: context.access,
    selections: context.selections,
    getCurrentEventId: () => null,
    abortCurrent: () => false
  })
  const commandInput = {
    conversationKey: "conversation-1",
    principalId: "principal-1"
  }
  try {
    const retired = await router.handle({
      ...commandInput,
      command: parseImCommand("/项目")!
    })
    assert(retired.includes("已合并为 /会话"))

    const grant = await context.access.enableFeature({
      route: commandInput,
      projectId: "project-secret-id",
      featureSlug: "feature-pay"
    })
    const sessions = await router.handle({
      ...commandInput,
      command: parseImCommand("/会话")!
    })
    assert(sessions.includes("支付平台 / 快捷支付"))
    assert(!sessions.includes(context.root))
    assert(!sessions.includes("project-secret-id"))
    assert(!sessions.includes("must-not-leak"))

    const bound = await router.handle({
      ...commandInput,
      command: parseImCommand("/绑定 1")!
    })
    assert(bound.includes("支付平台 / 快捷支付"))
    const target = context.conversations.getActiveTarget("conversation-1")
    assert.equal(target?.kind, "feature")
    if (target?.kind !== "feature") throw new Error("feature target expected")
    const metadata = JSON.parse(context.threads.get(target.threadId)!.metadata!) as Record<
      string,
      unknown
    >
    assert.deepEqual(metadata.harnessFeature, {
      projectId: "project-secret-id",
      slug: "feature-pay",
      source: "autobizdevops"
    })
    assert.equal(
      (metadata.imDeliveryContext as Record<string, unknown>).bindingId,
      target.bindingId
    )

    const rebound = await context.featureService.bindFeature({
      ...commandInput,
      projectId: "project-secret-id",
      featureSlug: "feature-pay",
      grantId: grant.grantId,
      grantVersion: grant.grantVersion
    })
    assert.equal(rebound.threadId, target.threadId)
    assert.equal(context.threads.size, 1)

    await router.handle({ ...commandInput, command: parseImCommand("/会话")! })
    await context.access.disableFeature("project-secret-id", "feature-pay")
    const stale = await router.handle({ ...commandInput, command: parseImCommand("/绑定 1")! })
    assert(stale.includes("授权已变化"))

    const switched = await router.handle({
      ...commandInput,
      command: parseImCommand("/收件箱")!
    })
    assert(switched.includes("已切换到【收件箱】"))
    assert.equal(context.conversations.getActiveTarget("conversation-1")?.kind, "inbox")
  } finally {
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testFeatureRevalidationSuspendsBinding(): Promise<void> {
  const context = await createContext()
  try {
    const grant = await context.access.enableFeature({
      route: {
        conversationKey: "conversation-1",
        principalId: "principal-1"
      },
      projectId: "project-secret-id",
      featureSlug: "feature-pay"
    })
    const target = await context.access.bindFeatureGrant({
      route: {
        conversationKey: "conversation-1",
        principalId: "principal-1"
      },
      grantId: grant.grantId,
      grantVersion: grant.grantVersion
    })
    const event: ImEventRecord = {
      eventId: "feature-event",
      platformMessageId: "feature-platform",
      conversationKey: "conversation-1",
      conversationSeq: 1,
      principalId: "principal-1",
      leaseId: "lease",
      leaseExpiresAt: context.clock.now + 60_000,
      permitState: "unacquired",
      permitExpiresAt: null,
      messageText: "hello",
      occurredAt: context.clock.now,
      targetSnapshot: target,
      state: "queued",
      runId: null,
      retryOfEventId: null,
      resultText: null,
      reasonCode: null,
      retryable: null,
      createdAt: context.clock.now,
      updatedAt: context.clock.now,
      acceptedAt: context.clock.now,
      executionStartedAt: null,
      finishedAt: null
    }
    const guard = new ImRemoteCapabilityGuard({
      conversationState: context.conversations,
      getThread: (threadId) => context.threads.get(threadId) ?? null,
      updateThread: context.updateLocalThread as never,
      getGoal: () => null,
      coordinator: {
        hasRunningWorkersForThread: () => false,
        hasNotifications: () => false,
        hasTerminalWorkerAwaitingNotificationForThread: () => false
      },
      workflow: { isBusyForThread: () => false },
      hasPendingApproval: () => false,
      hasPendingUserInput: () => false,
      grants: context.grants,
      validateFeatureTarget: async () => ({
        valid: false,
        reasonCode: "REMOTE_FEATURE_UNAVAILABLE",
        message: "Feature 已归档。"
      })
    })
    const decision = await guard.evaluate(event)
    assert.equal(decision.allowed, false)
    assert.equal(
      context.conversations
        .listTargets("conversation-1")
        .find((candidate) => candidate.snapshot.targetId === target.targetId)?.state,
      "suspended"
    )
    const metadata = JSON.parse(context.threads.get(target.threadId)!.metadata!) as Record<
      string,
      unknown
    >
    assert.equal(metadata.remoteState, "suspended")
    assert.equal(
      context.grants.getFeatureGrant("project-secret-id", "feature-pay")?.state,
      "suspended"
    )
  } finally {
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testDesktopThreadGrantBindsWithoutMutatingMetadata(): Promise<void> {
  const context = await createContext()
  const router = new ImCommandRouter({
    conversations: context.conversations,
    events: context.events,
    inbox: context.inbox,
    access: context.access,
    selections: context.selections
  })
  const route = {
    conversationKey: "conversation-1",
    principalId: "principal-1"
  }
  try {
    const originalMetadata = {
      title: "支付排障会话",
      workspacePath: context.root,
      agentMode: "normal"
    }
    context.makeThread("desktop-thread", originalMetadata)
    await context.access.enableThread({ route, threadId: "desktop-thread" })

    const sessions = await router.handle({ ...route, command: parseImCommand("/会话")! })
    assert(sessions.includes("支付排障会话"))
    const bound = await router.handle({ ...route, command: parseImCommand("/绑定 1")! })
    assert(bound.includes("支付排障会话"))
    const target = context.conversations.getActiveTarget(route.conversationKey)
    assert.equal(target?.kind, "thread")
    assert.equal(target?.threadId, "desktop-thread")
    if (target?.kind !== "thread") throw new Error("thread target expected")
    assert.deepEqual(
      JSON.parse(context.threads.get("desktop-thread")!.metadata!),
      originalMetadata,
      "grant authority stays in dedicated tables and does not mutate desktop metadata"
    )

    const event: ImEventRecord = {
      eventId: "desktop-thread-event",
      platformMessageId: "desktop-thread-platform",
      conversationKey: route.conversationKey,
      conversationSeq: 1,
      principalId: route.principalId,
      leaseId: "lease",
      leaseExpiresAt: context.clock.now + 60_000,
      permitState: "unacquired",
      permitExpiresAt: null,
      messageText: "检查支付代码",
      occurredAt: context.clock.now,
      targetSnapshot: target,
      state: "queued",
      runId: null,
      retryOfEventId: null,
      resultText: null,
      reasonCode: null,
      retryable: null,
      createdAt: context.clock.now,
      updatedAt: context.clock.now,
      acceptedAt: context.clock.now,
      executionStartedAt: null,
      finishedAt: null
    }
    const guard = new ImRemoteCapabilityGuard({
      conversationState: context.conversations,
      getThread: (threadId) => context.threads.get(threadId) ?? null,
      getGoal: () => null,
      coordinator: {
        hasRunningWorkersForThread: () => false,
        hasNotifications: () => false,
        hasTerminalWorkerAwaitingNotificationForThread: () => false
      },
      workflow: { isBusyForThread: () => false },
      hasPendingApproval: () => false,
      hasPendingUserInput: () => false,
      grants: context.grants
    })
    const allowed = await guard.evaluate(event)
    assert.equal(allowed.allowed, true, JSON.stringify(allowed))

    const transientlyBusyAccess = new ImRemoteAccessService({
      conversations: context.conversations,
      grants: context.grants,
      features: context.featureService,
      getThread: (threadId) => context.threads.get(threadId) ?? null,
      getGoal: () => ({ status: "active" }),
      coordinator: {
        hasRunningWorkersForThread: () => true,
        hasNotifications: () => true,
        hasTerminalWorkerAwaitingNotificationForThread: () => true
      },
      workflow: { isBusyForThread: () => true },
      hasPendingApproval: () => true,
      hasPendingUserInput: () => true
    })
    const deliveryTarget =
      transientlyBusyAccess.validateThreadForCompletionDelivery("desktop-thread")
    assert.equal(deliveryTarget.thread.thread_id, "desktop-thread")
    assert.equal(deliveryTarget.workspacePath, await realpath(context.root))
    assert.throws(
      () => transientlyBusyAccess.validateThreadForRemoteAccess("desktop-thread"),
      (error) => error instanceof ImRemoteAccessError && error.code === "REMOTE_THREAD_UNSUPPORTED"
    )

    context.updateLocalThread("desktop-thread", {
      metadata: JSON.stringify({ ...originalMetadata, agentMode: "coordinator" })
    })
    assert.equal(
      context.access.validateThreadForCompletionDelivery("desktop-thread").thread.thread_id,
      "desktop-thread"
    )
    assert.throws(
      () => context.access.validateThreadForRemoteAccess("desktop-thread"),
      (error) => error instanceof ImRemoteAccessError && error.code === "REMOTE_THREAD_UNSUPPORTED"
    )
    const unsupported = await guard.evaluate(event)
    assert.equal(unsupported.allowed, false)
    assert.equal(
      unsupported.allowed ? null : unsupported.reasonCode,
      "REMOTE_AGENT_MODE_UNSUPPORTED"
    )

    context.updateLocalThread("desktop-thread", { metadata: JSON.stringify(originalMetadata) })
    await context.grants.revokeThreadGrant("desktop-thread")
    const revoked = await guard.evaluate(event)
    assert.equal(revoked.allowed, false)
    assert.equal(revoked.allowed ? null : revoked.reasonCode, "REMOTE_GRANT_INVALID")

    await context.access.disableThread("desktop-thread")
    assert.equal(context.conversations.getSelectedTarget(route.conversationKey)?.state, "suspended")
    const recovered = await router.handle({ ...route, command: parseImCommand("/收件箱")! })
    assert(recovered.includes("已切换到【收件箱】"))
  } finally {
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testControlIngressCompletesOutsideTurnQueueAndSelectionExpires(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  const replyClient = new ImReplyClient(gateway, context.events, () => context.clock.now)
  const ingress = new ImIngressSequencer({
    conversationState: context.conversations,
    eventStore: context.events,
    inboxService: context.inbox,
    replyClient,
    emitAcknowledgement: (ack) => gateway.sendAcknowledgement(ack)
  })
  try {
    const result = await ingress.receiveControlEvent(
      eventFixture(1, "/当前"),
      async () => "当前目标：收件箱"
    )
    assert.equal(result.event.state, "completed")
    assert.deepEqual(
      gateway.acknowledgements.map((ack) => ack.type),
      ["received", "completed"]
    )
    assert.equal(gateway.replies[0].message.content, "当前目标：收件箱")

    await context.selections.create("conversation-1", "project", [
      { id: "project-1", label: "项目一" }
    ])
    context.clock.now += 60_001
    await assert.rejects(
      () => context.selections.select("conversation-1", "project", 1),
      (error: unknown) =>
        error instanceof ImSelectionContextError && error.code === "SELECTION_EXPIRED"
    )
  } finally {
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

async function testExplicitRetryCreatesNewEventWithOriginalSnapshot(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  const replyClient = new ImReplyClient(gateway, context.events, () => context.clock.now)
  const ingress = new ImIngressSequencer({
    conversationState: context.conversations,
    eventStore: context.events,
    inboxService: context.inbox,
    replyClient,
    emitAcknowledgement: (ack) => gateway.sendAcknowledgement(ack)
  })
  const router = new ImCommandRouter({
    conversations: context.conversations,
    events: context.events,
    inbox: context.inbox,
    access: context.access,
    selections: context.selections
  })
  try {
    const inbox = await context.inbox.ensureInbox({
      conversationKey: "conversation-1",
      principalId: "principal-1"
    })
    const originalRemote = eventFixture(1, "执行一次可能有副作用的任务")
    await context.events.receiveEvent(originalRemote, inbox)
    await context.events.queueEvent(originalRemote.eventId)
    await context.events.recordExecutionPermit({
      eventId: originalRemote.eventId,
      leaseId: originalRemote.lease.id,
      expiresAt: "2026-07-23T09:00:00.000Z"
    })
    await context.events.beginExecution(originalRemote.eventId, "run-original")
    await context.events.handlePermitRevoked(originalRemote.eventId)

    const code = eventShortCode(originalRemote.eventId)
    const resolved = router.resolveRetryEvent("conversation-1", code)
    assert("event" in resolved)
    if (!("event" in resolved)) throw new Error("retry event expected")
    const retryRemote = eventFixture(2, `/重试 ${code}`)
    const queued = await ingress.receiveOrdinaryEvent(
      { ...retryRemote, message: { type: "text", text: resolved.event.messageText } },
      {
        targetSnapshot: resolved.event.targetSnapshot!,
        retryOfEventId: resolved.event.eventId
      }
    )
    assert.equal(queued.event.state, "queued")
    assert.equal(queued.event.retryOfEventId, originalRemote.eventId)
    assert.equal(queued.event.messageText, "执行一次可能有副作用的任务")
    assert.deepEqual(queued.event.targetSnapshot, inbox)
  } finally {
    context.database.close()
    await rm(context.root, { recursive: true, force: true })
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "testFeatureBindingIsImmutableAndCommandListsDoNotLeakPaths",
    testFeatureBindingIsImmutableAndCommandListsDoNotLeakPaths
  ],
  ["testFeatureRevalidationSuspendsBinding", testFeatureRevalidationSuspendsBinding],
  [
    "testDesktopThreadGrantBindsWithoutMutatingMetadata",
    testDesktopThreadGrantBindsWithoutMutatingMetadata
  ],
  [
    "testControlIngressCompletesOutsideTurnQueueAndSelectionExpires",
    testControlIngressCompletesOutsideTurnQueueAndSelectionExpires
  ],
  [
    "testExplicitRetryCreatesNewEventWithOriginalSnapshot",
    testExplicitRetryCreatesNewEventWithOriginalSnapshot
  ]
]

async function main(): Promise<void> {
  for (const [name, test] of tests) {
    await test()
    console.log(`PASS ${name}`)
  }
  console.log("im-feature-binding-command.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
