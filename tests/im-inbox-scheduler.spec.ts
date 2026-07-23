import assert from "node:assert/strict"
import initSqlJs from "sql.js"
import type { ThreadRow } from "../src/main/db"
import type { ScheduledTask } from "../src/main/types"
import { getLocalThreadRunLease } from "../src/main/agent/thread-run-lease"
import { ImRemoteCapabilityGuard } from "../src/main/services/im/capability-guard"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImEventStore } from "../src/main/services/im/event-store"
import type {
  ImExecutionPermitResult,
  ImGatewayClientPort,
  ImReplySubmissionResult
} from "../src/main/services/im/gateway-client"
import { executeImInboxScheduledTask } from "../src/main/services/im/inbox-scheduler"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ImReplyClient } from "../src/main/services/im/reply-client"
import type { PreparedRemoteStandardTurnInput } from "../src/main/services/im/remote-runner"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import type { RemoteImAckV1, RemoteImReplyV1 } from "../src/shared/im-gateway-contract"

const target = {
  kind: "inbox" as const,
  targetId: "inbox-target",
  threadId: "inbox-thread",
  workspacePath: "/managed/inbox"
}

function taskFixture(expectedDeviceEpoch = 1): ScheduledTask {
  return {
    id: "reminder-1",
    name: "喝水",
    description: "喝水提醒",
    prompt: "该喝水了",
    taskType: "reminder",
    modelId: null,
    workDir: target.workspacePath,
    chatxRobotChatId: null,
    imDeliveryContext: {
      provider: "zhaohu",
      conversationKey: "conversation-1",
      expectedDeviceEpoch,
      inboxThreadId: target.threadId
    },
    frequency: "once",
    intervalMinutes: null,
    runAt: "2026-07-23T16:05:00+08:00",
    runAtTime: null,
    weekday: null,
    enabled: true,
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    nextRunAt: "2026-07-23T08:05:00.000Z"
  }
}

class TestGateway implements ImGatewayClientPort {
  readonly replies: RemoteImReplyV1[] = []
  authenticated = true

  isAuthenticated(): boolean {
    return this.authenticated
  }

  async sendAcknowledgement(_ack: RemoteImAckV1): Promise<void> {}

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

function threadRow(): ThreadRow {
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
      imDeliveryContext: {
        provider: "zhaohu",
        conversationKey: "conversation-1",
        deviceEpoch: 1,
        targetId: target.targetId
      }
    })
  }
}

async function createContext() {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => Date.parse("2026-07-23T08:05:00.000Z")
  }
  const conversationState = new ImConversationStateStore(dependencies)
  const eventStore = new ImEventStore(dependencies)
  await conversationState.ensureConversation({
    conversationKey: "conversation-1",
    principalId: "principal-1",
    deviceEpoch: 1
  })
  await conversationState.registerTarget("conversation-1", target, { activate: true })
  const capabilityGuard = new ImRemoteCapabilityGuard({
    conversationState,
    getThread: () => threadRow(),
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
  return { database, conversationState, eventStore, capabilityGuard }
}

async function testScheduledInboxUsesLeaseAndStableProactiveOutbox(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  const replyClient = new ImReplyClient(gateway, context.eventStore, () =>
    Date.parse("2026-07-23T08:05:00.000Z")
  )
  let executions = 0
  try {
    const execute = async (input: PreparedRemoteStandardTurnInput): Promise<string> => {
      executions += 1
      assert.equal(getLocalThreadRunLease(target.threadId)?.owner, "scheduler")
      assert.equal(input.source, "scheduler")
      assert.equal(input.remotePolicy?.disableScheduler, true)
      assert.equal(input.targetKind, "inbox")
      return "记得喝水。"
    }
    const options = {
      occurrence: taskFixture().nextRunAt!,
      gateway,
      conversationState: context.conversationState,
      eventStore: context.eventStore,
      capabilityGuard: context.capabilityGuard,
      replyClient,
      executeTurn: execute,
      createRunId: () => "scheduler-run-1"
    }
    const first = await executeImInboxScheduledTask(
      taskFixture(),
      new AbortController().signal,
      options
    )
    assert.equal(first.status, "completed")
    assert.equal(executions, 1)
    assert.equal(gateway.replies.length, 1)
    assert.equal(gateway.replies[0].eventId, undefined)
    assert.equal(gateway.replies[0].expectedDeviceEpoch, 1)
    assert.equal(context.eventStore.listOutbox("sent").length, 1)
    assert.equal(getLocalThreadRunLease(target.threadId), undefined)

    const replay = await executeImInboxScheduledTask(
      taskFixture(),
      new AbortController().signal,
      options
    )
    assert.equal(replay.status, "completed")
    assert.equal(executions, 1)
    assert.equal(gateway.replies.length, 1)
  } finally {
    context.database.close()
  }
}

async function testOldEpochAndOfflineDeferWithoutExecution(): Promise<void> {
  const context = await createContext()
  const gateway = new TestGateway()
  let executions = 0
  const common = {
    gateway,
    conversationState: context.conversationState,
    eventStore: context.eventStore,
    capabilityGuard: context.capabilityGuard,
    executeTurn: async () => {
      executions += 1
      return "unexpected"
    }
  }
  try {
    const oldEpoch = await executeImInboxScheduledTask(
      taskFixture(2),
      new AbortController().signal,
      common
    )
    assert.deepEqual(oldEpoch, { status: "deferred", reasonCode: "DEVICE_EPOCH_MISMATCH" })
    gateway.authenticated = false
    const offline = await executeImInboxScheduledTask(
      taskFixture(),
      new AbortController().signal,
      common
    )
    assert.deepEqual(offline, { status: "deferred", reasonCode: "DEVICE_OFFLINE" })
    assert.equal(executions, 0)
  } finally {
    context.database.close()
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "testScheduledInboxUsesLeaseAndStableProactiveOutbox",
    testScheduledInboxUsesLeaseAndStableProactiveOutbox
  ],
  ["testOldEpochAndOfflineDeferWithoutExecution", testOldEpochAndOfflineDeferWithoutExecution]
]

async function main(): Promise<void> {
  for (const [name, test] of tests) {
    await test()
    console.log(`PASS ${name}`)
  }
  console.log("im-inbox-scheduler.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
