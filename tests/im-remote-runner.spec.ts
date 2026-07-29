import assert from "node:assert/strict"
import initSqlJs from "sql.js"
import type {
  RemoteImAckV1,
  RemoteImEventV1,
  RemoteImReplyV1
} from "../src/shared/im-gateway-contract"
import { ImRemoteCapabilityGuard } from "../src/main/services/im/capability-guard"
import {
  ImConversationStateStore,
  type ImTargetSnapshot
} from "../src/main/services/im/conversation-state"
import { ImEventStore } from "../src/main/services/im/event-store"
import type {
  ImExecutionPermitResult,
  ImGatewayClientPort,
  ImReplySubmissionResult
} from "../src/main/services/im/gateway-client"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImReplyClient } from "../src/main/services/im/reply-client"
import {
  ImRemoteRunner,
  createImInboxRemotePolicy,
  resolveImInboxDeliveryContextForRuntime
} from "../src/main/services/im/remote-runner"
import { ImConversationTurnQueue } from "../src/main/services/im/conversation-turn-queue"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease,
  type LocalThreadRunOwner
} from "../src/main/agent/thread-run-lease"
import type { ThreadRow } from "../src/main/db"

interface Context {
  database: Awaited<ReturnType<typeof initSqlJs>>["Database"]["prototype"]
  conversations: ImConversationStateStore
  events: ImEventStore
  clock: { now: number }
}

const target: ImTargetSnapshot = {
  kind: "inbox",
  targetId: "target-inbox",
  threadId: "thread-inbox",
  workspacePath: "/managed/inbox"
}

const featureTarget: Extract<ImTargetSnapshot, { kind: "feature" }> = {
  kind: "feature",
  targetId: "target-feature",
  threadId: "thread-feature",
  workspacePath: "/managed/feature",
  bindingId: "binding-feature",
  projectId: "project-1",
  projectName: "统一机器人",
  featureSlug: "approval-flow",
  featureTitle: "审批流程"
}

function eventFixture(index: number): RemoteImEventV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${index}`,
    platformMessageId: `platform-${index}`,
    principalId: "principal-1",
    conversationKey: "conversation-1",
    conversationSeq: index,
    deviceEpoch: 1,
    message: { type: "text", text: `message-${index}` },
    occurredAt: `2026-07-23T08:00:${String(index).padStart(2, "0")}.000Z`,
    lease: { id: `lease-${index}`, expiresAt: "2026-07-23T09:00:00.000Z" }
  }
}

async function createContext(): Promise<Context> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-07-23T08:00:00.000Z") }
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => clock.now
  }
  const conversations = new ImConversationStateStore(dependencies)
  const events = new ImEventStore(dependencies)
  await conversations.ensureConversation({
    conversationKey: "conversation-1",
    principalId: "principal-1",
    deviceEpoch: 1
  })
  await conversations.registerTarget("conversation-1", target, { activate: true })
  return { database: database as never, conversations, events, clock }
}

async function queueEvent(context: Context, index: number) {
  const remote = eventFixture(index)
  await context.events.receiveEvent(remote, target)
  return context.events.queueEvent(remote.eventId)
}

async function queueFeatureEvent(context: Context, index: number) {
  await context.conversations.registerTarget("conversation-1", featureTarget, { activate: true })
  const remote = eventFixture(index)
  await context.events.receiveEvent(remote, featureTarget)
  return context.events.queueEvent(remote.eventId)
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

class TestGateway implements ImGatewayClientPort {
  readonly acknowledgements: RemoteImAckV1[] = []
  readonly replies: RemoteImReplyV1[] = []
  authenticated = true
  denyRenewal = false

  isAuthenticated(): boolean {
    return this.authenticated
  }

  async sendAcknowledgement(ack: RemoteImAckV1): Promise<void> {
    this.acknowledgements.push(ack)
  }

  async acquireExecutionPermit(event: { leaseId: string }): Promise<ImExecutionPermitResult> {
    return {
      status: "granted",
      leaseId: event.leaseId,
      expiresAt: "2026-07-23T09:00:00.000Z"
    }
  }

  async renewExecutionPermit(event: { leaseId: string }): Promise<ImExecutionPermitResult> {
    return this.denyRenewal
      ? { status: "denied", reasonCode: "LEASE_REVOKED" }
      : {
          status: "granted",
          leaseId: event.leaseId,
          expiresAt: "2026-07-23T09:00:00.000Z"
        }
  }

  async submitReply(reply: RemoteImReplyV1): Promise<ImReplySubmissionResult> {
    this.replies.push(reply)
    return { state: "accepted", platformReplyId: `platform-reply-${this.replies.length}` }
  }
}

function testThreadRow(): ThreadRow {
  return {
    thread_id: target.threadId,
    created_at: Date.now(),
    updated_at: Date.now(),
    status: "idle",
    title: "远程收件箱",
    thread_values: null,
    metadata: JSON.stringify({
      workspacePath: target.workspacePath,
      targetKind: "inbox",
      agentMode: "normal",
      memoryEnabled: false,
      imDeliveryContext: {
        provider: "zhaohu",
        conversationKey: "conversation-1",
        deviceEpoch: 1,
        targetId: target.targetId
      }
    })
  }
}

function capabilityGuard(context: Context): ImRemoteCapabilityGuard {
  return new ImRemoteCapabilityGuard({
    conversationState: context.conversations,
    getThread: () => testThreadRow(),
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
}

function featureCapabilityGuard(context: Context): ImRemoteCapabilityGuard {
  const thread: ThreadRow = {
    thread_id: featureTarget.threadId,
    created_at: Date.now(),
    updated_at: Date.now(),
    status: "idle",
    title: "远程 Feature",
    thread_values: null,
    metadata: JSON.stringify({
      workspacePath: featureTarget.workspacePath,
      agentMode: "normal",
      harnessFeature: {
        projectId: featureTarget.projectId,
        slug: featureTarget.featureSlug,
        source: "harness"
      },
      imDeliveryContext: {
        provider: "zhaohu",
        conversationKey: "conversation-1",
        deviceEpoch: 1,
        targetId: featureTarget.targetId,
        bindingId: featureTarget.bindingId
      }
    })
  }
  return new ImRemoteCapabilityGuard({
    conversationState: context.conversations,
    getThread: () => thread,
    getGoal: () => null,
    coordinator: {
      hasRunningWorkersForThread: () => false,
      hasNotifications: () => false,
      hasTerminalWorkerAwaitingNotificationForThread: () => false
    },
    workflow: { isBusyForThread: () => false },
    hasPendingApproval: () => false,
    hasPendingUserInput: () => false,
    validateFeatureTarget: async () => ({
      valid: true,
      project: { id: featureTarget.projectId, name: featureTarget.projectName ?? "Project" },
      feature: {
        projectId: featureTarget.projectId,
        slug: featureTarget.featureSlug,
        title: featureTarget.featureTitle ?? "Feature",
        status: "in_progress"
      },
      workspacePath: featureTarget.workspacePath
    })
  })
}

async function testSuccessfulRunAndDurableOutbox(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  let executions = 0
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    capabilityGuard: capabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events, () => context.clock.now),
    setThreadLifecycle: async () => undefined,
    createRunId: () => "run-1",
    executeTurn: async ({ event }) => {
      executions += 1
      assert.equal(context.events.getEvent(event.eventId)?.state, "executing")
      assert.equal(getLocalThreadRunLease(target.threadId)?.owner, "im")
      return "完成回复"
    }
  })
  try {
    const queued = await queueEvent(context, 1)
    assert.equal(await runner.invoke(queued, new AbortController().signal), "completed")
    assert.equal(executions, 1)
    assert.equal(context.events.getEvent(queued.eventId)?.state, "completed")
    assert.equal(context.events.listOutbox("sent").length, 1)
    assert.equal(gateway.replies[0].message.content, "完成回复")
    assert.equal(gateway.acknowledgements.at(-1)?.type, "completed")
    assert.equal(getLocalThreadRunLease(target.threadId), undefined)
  } finally {
    context.database.close()
  }
}

async function testForeignOwnerDefersWithoutRuntime(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  let executions = 0
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    capabilityGuard: capabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events),
    setThreadLifecycle: async () => undefined,
    createRunId: () => "run-im",
    executeTurn: async () => {
      executions += 1
      return "should not run"
    }
  })
  claimLocalThreadRunLease({ threadId: target.threadId, owner: "desktop", runId: "desktop-run" })
  try {
    const queued = await queueEvent(context, 1)
    assert.equal(await runner.invoke(queued, new AbortController().signal), "deferred_thread_busy")
    assert.equal(executions, 0)
    assert.equal(context.events.getEvent(queued.eventId)?.state, "queued")
  } finally {
    releaseLocalThreadRunLease(target.threadId, "desktop", "desktop-run")
    context.database.close()
  }
}

async function runForeignOwnerReleaseWakeScenario(
  owner: Extract<LocalThreadRunOwner, "desktop" | "scheduler">
): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  let executions = 0
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    capabilityGuard: capabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events, () => context.clock.now),
    setThreadLifecycle: async () => undefined,
    createRunId: () => `im-after-${owner}`,
    executeTurn: async () => {
      executions += 1
      return `${owner} released`
    }
  })
  const queue = new ImConversationTurnQueue(async (event, signal) => {
    await runner.invoke(event, signal)
  }, context.events)
  const foreignRunId = `${owner}-run`
  assert(
    claimLocalThreadRunLease({ threadId: target.threadId, owner, runId: foreignRunId }).acquired
  )
  try {
    const queued = await queueEvent(context, 1)
    await queue.notify(queued.conversationKey)
    assert.equal(context.events.getEvent(queued.eventId)?.state, "queued")
    assert.equal(executions, 0)

    assert(releaseLocalThreadRunLease(target.threadId, owner, foreignRunId))
    await waitFor(
      () => context.events.getEvent(queued.eventId)?.state === "completed",
      `${owner} lease release did not wake the queued IM event`
    )

    assert.equal(executions, 1)
    assert.equal(gateway.replies.at(-1)?.message.content, `${owner} released`)
  } finally {
    await queue.stop()
    releaseLocalThreadRunLease(target.threadId, owner, foreignRunId)
    context.database.close()
  }
}

async function testDesktopAndSchedulerReleaseWakeDeferredEvents(): Promise<void> {
  await runForeignOwnerReleaseWakeScenario("desktop")
  await runForeignOwnerReleaseWakeScenario("scheduler")
}

async function testLeaseReleaseDuringDeferredPumpIsNotLost(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  let executions = 0
  let releasedInsideHandler = false
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    capabilityGuard: capabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events, () => context.clock.now),
    setThreadLifecycle: async () => undefined,
    createRunId: () => "im-after-racing-release",
    executeTurn: async () => {
      executions += 1
      return "race recovered"
    }
  })
  const queue = new ImConversationTurnQueue(async (event, signal) => {
    const disposition = await runner.invoke(event, signal)
    if (disposition === "deferred_thread_busy" && !releasedInsideHandler) {
      releasedInsideHandler = true
      assert(releaseLocalThreadRunLease(target.threadId, "desktop", "racing-desktop-run"))
      // Let the release callback call notify() while this pump is still active.
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
  }, context.events)
  assert(
    claimLocalThreadRunLease({
      threadId: target.threadId,
      owner: "desktop",
      runId: "racing-desktop-run"
    }).acquired
  )
  try {
    const queued = await queueEvent(context, 1)
    await queue.notify(queued.conversationKey)
    await waitFor(
      () => context.events.getEvent(queued.eventId)?.state === "completed",
      "release notification was lost while the deferred pump was unwinding"
    )
    assert.equal(releasedInsideHandler, true)
    assert.equal(executions, 1)
  } finally {
    await queue.stop()
    releaseLocalThreadRunLease(target.threadId, "desktop", "racing-desktop-run")
    context.database.close()
  }
}

async function testPermitRevocationBecomesOutcomeUnknown(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  gateway.denyRenewal = true
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    capabilityGuard: capabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events, () => context.clock.now),
    setThreadLifecycle: async () => undefined,
    permitRenewIntervalMs: 5,
    createRunId: () => "run-revoked",
    executeTurn: ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
  })
  try {
    const queued = await queueEvent(context, 1)
    assert.equal(await runner.invoke(queued, new AbortController().signal), "outcome_unknown")
    const terminal = context.events.getEvent(queued.eventId)
    assert.equal(terminal?.state, "outcome_unknown")
    assert.equal(terminal?.reasonCode, "LEASE_REVOKED")
    assert(gateway.replies[0].message.content.includes("事件短码"))
  } finally {
    context.database.close()
  }
}

async function testFeatureDesktopWaitPersistsAndRevalidatesBeforeResume(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    conversationState: context.conversations,
    capabilityGuard: featureCapabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events, () => context.clock.now),
    setThreadLifecycle: async () => undefined,
    createRunId: () => "run-feature-wait",
    executeTurn: async ({ event, interactionWaitHooks }) => {
      assert(interactionWaitHooks)
      await interactionWaitHooks.onWaitStart({
        id: "approval-1",
        kind: "approval",
        threadId: featureTarget.threadId
      })
      assert.equal(context.events.getEvent(event.eventId)?.state, "waiting_desktop")
      assert.equal(gateway.acknowledgements.at(-1)?.type, "waiting_desktop")
      assert(gateway.replies.at(-1)?.message.content.includes("等待桌面确认"))
      assert(gateway.replies.at(-1)?.message.content.includes("【统一机器人 / 审批流程】"))
      await interactionWaitHooks.onWaitEnd({
        id: "approval-1",
        kind: "approval",
        threadId: featureTarget.threadId
      })
      assert.equal(context.events.getEvent(event.eventId)?.state, "executing")
      await context.conversations.setActiveTarget("conversation-1", target.targetId)
      return "审批后完成"
    }
  })
  try {
    const queued = await queueFeatureEvent(context, 1)
    assert.equal(await runner.invoke(queued, new AbortController().signal), "completed")
    assert.deepEqual(
      gateway.acknowledgements.map((ack) => ack.type),
      ["waiting_desktop", "completed"]
    )
    assert.equal(context.events.getEvent(queued.eventId)?.state, "completed")
    assert(gateway.replies.at(-1)?.message.content.includes("审批后完成"))
    assert(gateway.replies.at(-1)?.message.content.includes("切换前任务"))
  } finally {
    context.database.close()
  }
}

async function testFeatureDesktopWaitTimeoutCancelsOnlyEvent(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  const runner = new ImRemoteRunner({
    gateway,
    eventStore: context.events,
    conversationState: context.conversations,
    capabilityGuard: featureCapabilityGuard(context),
    replyClient: new ImReplyClient(gateway, context.events, () => context.clock.now),
    setThreadLifecycle: async () => undefined,
    createRunId: () => "run-feature-timeout",
    waitingDesktopTtlMs: 5,
    executeTurn: async ({ interactionWaitHooks, signal }) => {
      assert(interactionWaitHooks)
      await interactionWaitHooks.onWaitStart({
        id: "input-1",
        kind: "user_input",
        threadId: featureTarget.threadId
      })
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
  })
  try {
    const queued = await queueFeatureEvent(context, 1)
    assert.equal(await runner.invoke(queued, new AbortController().signal), "cancelled")
    const terminal = context.events.getEvent(queued.eventId)
    assert.equal(terminal?.state, "cancelled")
    assert.equal(terminal?.reasonCode, "REMOTE_INTERACTION_TIMEOUT")
    assert.equal(
      context.conversations
        .listTargets("conversation-1")
        .find(({ snapshot }) => snapshot.targetId === featureTarget.targetId)?.state,
      "active",
      "waiting timeout must not revoke the Feature binding"
    )
    assert(gateway.replies.at(-1)?.message.content.includes("Feature Binding 保持不变"))
    assert.equal(gateway.acknowledgements.at(-1)?.type, "cancelled")
  } finally {
    context.database.close()
  }
}

function testInboxPolicyKeepsSchedulerButCutsRemoteRisks(): void {
  const policy = createImInboxRemotePolicy()
  assert.equal(policy.disableScheduler, undefined)
  assert.equal(policy.disableMcpTools, true)
  assert.equal(policy.disableRequestUserInput, true)
  assert.equal(policy.disableSubagents, true)
  assert(policy.blockedToolNames?.includes("execute"))
  assert(!policy.blockedToolNames?.includes("manage_scheduler"))
}

function testInboxSchedulerDeliveryContextIsExplicitAndStrict(): void {
  const metadata = {
    targetKind: "inbox",
    imDeliveryContext: {
      provider: "zhaohu",
      conversationKey: "conversation-1",
      deviceEpoch: 7
    }
  }
  assert.deepEqual(
    resolveImInboxDeliveryContextForRuntime({
      threadId: "inbox-thread",
      targetKind: "inbox",
      metadata
    }),
    {
      provider: "zhaohu",
      conversationKey: "conversation-1",
      expectedDeviceEpoch: 7,
      inboxThreadId: "inbox-thread"
    }
  )
  assert.equal(
    resolveImInboxDeliveryContextForRuntime({
      threadId: "feature-thread",
      targetKind: "feature",
      metadata
    }),
    undefined,
    "Feature runtimes never receive inbox scheduler delivery"
  )
  assert.equal(
    resolveImInboxDeliveryContextForRuntime({
      threadId: "inbox-thread",
      targetKind: "inbox",
      metadata: {
        ...metadata,
        imDeliveryContext: { ...metadata.imDeliveryContext, deviceEpoch: 0 }
      }
    }),
    undefined,
    "non-positive epochs retain the previous rejection semantics"
  )
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["testSuccessfulRunAndDurableOutbox", testSuccessfulRunAndDurableOutbox],
  ["testForeignOwnerDefersWithoutRuntime", testForeignOwnerDefersWithoutRuntime],
  [
    "testDesktopAndSchedulerReleaseWakeDeferredEvents",
    testDesktopAndSchedulerReleaseWakeDeferredEvents
  ],
  ["testLeaseReleaseDuringDeferredPumpIsNotLost", testLeaseReleaseDuringDeferredPumpIsNotLost],
  ["testPermitRevocationBecomesOutcomeUnknown", testPermitRevocationBecomesOutcomeUnknown],
  [
    "testFeatureDesktopWaitPersistsAndRevalidatesBeforeResume",
    testFeatureDesktopWaitPersistsAndRevalidatesBeforeResume
  ],
  ["testFeatureDesktopWaitTimeoutCancelsOnlyEvent", testFeatureDesktopWaitTimeoutCancelsOnlyEvent],
  [
    "testInboxPolicyKeepsSchedulerButCutsRemoteRisks",
    testInboxPolicyKeepsSchedulerButCutsRemoteRisks
  ],
  [
    "testInboxSchedulerDeliveryContextIsExplicitAndStrict",
    testInboxSchedulerDeliveryContextIsExplicitAndStrict
  ]
]

async function main(): Promise<void> {
  for (const [name, test] of tests) {
    await test()
    console.log(`PASS ${name}`)
  }
  console.log("im-remote-runner.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
