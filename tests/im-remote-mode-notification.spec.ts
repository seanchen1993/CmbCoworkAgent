import assert from "node:assert/strict"
import type { ThreadRow } from "../src/main/db"
import type { PersistedWorkflowRun } from "../src/main/agent/workflow/types"
import type { ImRemoteCapabilityDecision } from "../src/main/services/im/capability-guard"
import type { ImTargetSnapshot } from "../src/main/services/im/conversation-state"
import { ImRemoteModeNotificationPump } from "../src/main/services/im/remote-mode-notification-pump"
import type {
  ImDetachedResultNotice,
  PreparedRemoteStandardTurnInput
} from "../src/main/services/im/remote-runner"

const target: Extract<ImTargetSnapshot, { kind: "thread" }> = {
  kind: "thread",
  targetId: "target-1",
  grantId: "grant-1",
  grantVersion: 1,
  threadId: "thread-1",
  title: "并行任务",
  workspacePath: "/workspace"
}

function notice(kind: "coordinator" | "workflow", runId?: string): ImDetachedResultNotice {
  return {
    kind,
    ...(runId ? { runId } : {}),
    threadId: target.threadId,
    conversationKey: "conversation-1",
    principalId: "principal-1",
    targetSnapshot: target
  }
}

function thread(agentMode: "coordinator" | "workflow"): ThreadRow {
  return {
    thread_id: target.threadId,
    created_at: 1,
    updated_at: 1,
    status: "idle",
    title: target.title,
    thread_values: null,
    metadata: JSON.stringify({ workspacePath: target.workspacePath, agentMode })
  }
}

function allowed(agentMode: "coordinator" | "workflow"): ImRemoteCapabilityDecision {
  return {
    allowed: true,
    thread: thread(agentMode),
    metadata: { workspacePath: target.workspacePath, agentMode },
    workspacePath: target.workspacePath,
    target
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function conversations() {
  return {
    listConversations: () => [],
    listTargets: () => [],
    getActiveTarget: () => target
  }
}

async function testCoordinatorResultIsFoldedAndAcknowledged(): Promise<void> {
  const first = `<task-notification><task-id>worker-a</task-id><turn>1</turn><result>A</result></task-notification>`
  const second = `<task-notification><task-id>worker-b</task-id><turn>2</turn><result>B</result></task-notification>`
  let queued = [first, second]
  const acknowledged: string[][] = []
  const deliveries: Array<{ deliveryId: string; content: string }> = []
  const executions: PreparedRemoteStandardTurnInput[] = []
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("coordinator") } as never,
    getThread: () => thread("coordinator"),
    coordinator: {
      restoreWorkersForThread: async () => [],
      drainNotifications: () => {
        const current = queued
        queued = []
        return current
      },
      hasNotifications: () => queued.length > 0,
      hasAutoRunnableNotifications: () => queued.length > 0,
      restoreNotifications: (_threadId, messages) => queued.push(...messages),
      restoreNotificationMessages: async (_threadId, messages) => queued.push(...messages),
      acknowledgeNotificationMessages: async (_threadId, messages) => {
        acknowledged.push(messages)
      },
      getWorkerSelectedSkill: async (_threadId, workerId) => ({
        skillName: `skill-${workerId}`,
        skillPath: `/skills/${workerId}/SKILL.md`
      })
    } as never,
    workflow: {} as never,
    executeTurn: async (input) => {
      executions.push(input)
      assert.equal(input.agentMode, "coordinator")
      assert.equal(input.internalNotificationTurn, true)
      assert.equal(input.persistUserMessage, false)
      assert.equal(input.disableAutoCommit, true)
      assert.match(input.rawMessage, /notification_id: worker-a@turn-1/u)
      assert.equal(
        input.coordinatorNotificationSelectedSkills?.["worker-a@turn-1"]?.skillName,
        "skill-worker-a"
      )
      return "两个并行任务均已完成。"
    },
    events: {
      enqueueProactiveReplies: async (replies) => {
        deliveries.push({
          deliveryId: replies[0].deliveryId,
          content: replies.map((reply) => reply.message.content).join("")
        })
        return []
      }
    },
    replyClient: { sendPending: async () => ({ sent: 1, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-coordinator",
    hasActiveGoal: () => false
  })
  try {
    pump.schedule(notice("coordinator"))
    await waitFor(() => deliveries.length === 1, "coordinator result was not delivered")
    assert.equal(executions.length, 1)
    assert.deepEqual(acknowledged, [[first, second]])
    assert.match(deliveries[0].content, /【会话：并行任务】/u)
    assert.match(deliveries[0].content, /两个并行任务均已完成/u)
  } finally {
    pump.stop()
  }
}

function workflowRun(): PersistedWorkflowRun {
  return {
    version: 1,
    runId: "wf_result_1",
    threadId: target.threadId,
    workflowName: "并行检查",
    description: "检查所有模块",
    script: "export default async () => true",
    scriptSha256: "sha",
    status: "completed",
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [],
    result: { ok: true },
    resultSidecarStatus: "unavailable",
    stats: {
      agentsTotal: 2,
      agentsCached: 0,
      agentsFailed: 0,
      outputTokens: 12,
      durationMs: 500
    },
    startedAt: "2026-09-02T01:00:00.000Z",
    updatedAt: "2026-09-02T01:01:00.000Z",
    completedAt: "2026-09-02T01:01:00.000Z",
    notificationDelivered: false
  }
}

async function testWorkflowResultIsFoldedAndSettled(): Promise<void> {
  const workflow = workflowRun()
  let claimed = false
  let marked = 0
  let cleared = 0
  let lifecycleWaited = 0
  const deliveries: string[] = []
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("workflow") } as never,
    getThread: () => thread("workflow"),
    coordinator: {} as never,
    workflow: {
      activeRunId: () => (claimed ? undefined : workflow.runId),
      waitForRunLifecycle: async () => {
        lifecycleWaited += 1
      },
      claimPendingNotificationAsync: async () => {
        if (claimed) return null
        claimed = true
        return workflow
      },
      findPendingNotificationAsync: async () => null,
      markNotified: async () => {
        marked += 1
        return true
      },
      recoverFlushFailedRun: async () => false,
      clearNotificationInFlight: () => {
        cleared += 1
      },
      clearRenotify: () => undefined
    } as never,
    executeTurn: async (input) => {
      assert.equal(input.agentMode, "workflow")
      assert.equal(input.internalNotificationTurn, true)
      assert.equal(input.persistUserMessage, false)
      assert.match(input.rawMessage, /CMB_WORKFLOW_NOTIFICATION_V1/u)
      return "工作流检查完成，没有发现问题。"
    },
    events: {
      enqueueProactiveReplies: async (replies) => {
        deliveries.push(replies.map((reply) => reply.message.content).join(""))
        return []
      }
    },
    replyClient: { sendPending: async () => ({ sent: 1, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-workflow",
    hasActiveGoal: () => false
  })
  try {
    pump.schedule(notice("workflow", workflow.runId))
    await waitFor(() => deliveries.length === 1, "workflow result was not delivered")
    assert.equal(lifecycleWaited, 1)
    assert.equal(marked, 1)
    assert.equal(cleared, 1)
    assert.match(deliveries[0], /工作流检查完成/u)
  } finally {
    pump.stop()
  }
}

async function testActiveGoalConsumesCoordinatorNotificationThroughSharedRun(): Promise<void> {
  let hasNotification = true
  let goalRuns = 0
  const deliveries: string[] = []
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("coordinator") } as never,
    getThread: () => thread("coordinator"),
    coordinator: {
      restoreWorkersForThread: async () => [],
      hasNotifications: () => hasNotification,
      hasAutoRunnableNotifications: () => hasNotification
    } as never,
    workflow: {} as never,
    executeTurn: async () => {
      throw new Error("active Goal notification must not use the standalone mode runner")
    },
    goalRuns: {
      run: async (input) => {
        goalRuns += 1
        assert.equal(input.coordinatorInternalNotification, true)
        assert.match(input.prepared.visibleText, /CMB_COORDINATOR_WORKER_NOTIFICATION/u)
        hasNotification = false
        await input.onFinalAssistant?.({
          messageId: "assistant-goal-notification",
          finalText: "Goal 已吸收并行任务结果。"
        })
        return "Goal 已吸收并行任务结果。"
      }
    } as never,
    events: {
      enqueueProactiveReplies: async (replies) => {
        deliveries.push(replies.map((reply) => reply.message.content).join(""))
        return []
      }
    },
    replyClient: { sendPending: async () => ({ sent: 1, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-active-goal",
    hasActiveGoal: () => true
  })
  try {
    pump.schedule(notice("coordinator"))
    await waitFor(() => deliveries.length === 1, "active Goal result was not delivered")
    assert.equal(goalRuns, 1)
    assert.match(deliveries[0], /Goal 已吸收并行任务结果/u)
  } finally {
    pump.stop()
  }
}

async function main(): Promise<void> {
  await testCoordinatorResultIsFoldedAndAcknowledged()
  console.log("PASS testCoordinatorResultIsFoldedAndAcknowledged")
  await testWorkflowResultIsFoldedAndSettled()
  console.log("PASS testWorkflowResultIsFoldedAndSettled")
  await testActiveGoalConsumesCoordinatorNotificationThroughSharedRun()
  console.log("PASS testActiveGoalConsumesCoordinatorNotificationThroughSharedRun")
  console.log("im-remote-mode-notification.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
