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

/**
 * The Goal branch sits in front of both plain paths and asked a different
 * question than they do: "does this thread have pending work" rather than "does
 * it have pending work of mine". Once this transport had reported its own share,
 * the desktop's leftovers kept it answering yes — taking the run lease, starting
 * another Goal summary, and retrying against a queue it was never going to
 * consume.
 *
 * The fakes below honour the owner argument, which the existing ones ignore.
 * That is what makes the difference visible at all.
 */
async function testActiveGoalLeavesDesktopCoordinatorResultsAlone(): Promise<void> {
  let goalRuns = 0
  const asked: (string | undefined)[] = []
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("coordinator") } as never,
    getThread: () => thread("coordinator"),
    coordinator: {
      restoreWorkersForThread: async () => [],
      // The only thing queued belongs to the desktop.
      hasNotifications: (_threadId: string, options?: { owner?: string }) => {
        asked.push(options?.owner)
        return options?.owner !== "managed"
      },
      hasAutoRunnableNotifications: (_threadId: string, options?: { owner?: string }) =>
        options?.owner !== "managed"
    } as never,
    workflow: {} as never,
    executeTurn: async () => {
      throw new Error("active Goal notification must not use the standalone mode runner")
    },
    goalRuns: {
      run: async () => {
        goalRuns += 1
        return ""
      }
    } as never,
    events: { enqueueProactiveReplies: async () => [] },
    replyClient: { sendPending: async () => ({ sent: 0, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-active-goal-foreign",
    hasActiveGoal: () => true
  })
  try {
    pump.schedule(notice("coordinator"))
    await waitFor(() => asked.length > 0, "the Goal branch never checked for pending work")
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(goalRuns, 0, "a desktop-owned result must not drive a Zhaohu Goal summary")
    assert.ok(
      asked.every((owner) => owner === "managed"),
      "the Goal branch must ask only about its own results"
    )
  } finally {
    pump.stop()
  }
}

async function testActiveGoalLeavesDesktopWorkflowRunsAlone(): Promise<void> {
  let goalRuns = 0
  const asked: (string | undefined)[] = []
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("workflow") } as never,
    getThread: () => thread("workflow"),
    coordinator: {} as never,
    workflow: {
      activeRunId: () => null,
      findPendingNotificationAsync: async (
        _workspacePath: string,
        _threadId: string,
        options?: { owner?: string }
      ) => {
        asked.push(options?.owner)
        // A desktop-started run is pending; nothing here is this transport's.
        return options?.owner === "managed" ? null : { runId: "wf_desktop" }
      }
    } as never,
    executeTurn: async () => {
      throw new Error("active Goal notification must not use the standalone mode runner")
    },
    goalRuns: {
      run: async () => {
        goalRuns += 1
        return ""
      }
    } as never,
    events: { enqueueProactiveReplies: async () => [] },
    replyClient: { sendPending: async () => ({ sent: 0, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-active-goal-foreign-workflow",
    hasActiveGoal: () => true
  })
  try {
    pump.schedule(notice("workflow"))
    await waitFor(() => asked.length > 0, "the Goal branch never looked for a pending run")
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(goalRuns, 0, "a desktop-started workflow must not drive a Zhaohu Goal summary")
    assert.ok(
      asked.every((owner) => owner === "managed"),
      "the Goal branch must look only for runs its own transport started"
    )
  } finally {
    pump.stop()
  }
}

/**
 * A background summary the user can watch has to be one they can stop.
 *
 * Stop dispatches on who owns the run, and these were owned by neither place it
 * looked: not in IM's turn queue, and holding their lease under "im" rather
 * than "desktop". Pressing Stop returned false and the summary ran on.
 */
async function testStopReachesASummaryThisPumpIsRunning(): Promise<void> {
  let aborted = false
  let started = false
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("coordinator") } as never,
    getThread: () => thread("coordinator"),
    coordinator: {
      restoreWorkersForThread: async () => [],
      hasNotifications: () => true,
      hasAutoRunnableNotifications: () => true,
      drainNotifications: () => ["<task-notification><task-id>w1</task-id></task-notification>"],
      getWorkerSelectedSkill: async () => undefined,
      restoreNotifications: () => undefined,
      restoreNotificationMessages: async () => undefined,
      acknowledgeNotificationMessages: async () => undefined
    } as never,
    workflow: {} as never,
    executeTurn: async (input) =>
      await new Promise<string>((resolve, reject) => {
        started = true
        input.signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      }),
    goalRuns: {} as never,
    events: { enqueueProactiveReplies: async () => [] },
    replyClient: { sendPending: async () => ({ sent: 0, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-stoppable",
    hasActiveGoal: () => false
  })
  try {
    pump.schedule(notice("coordinator"))
    await waitFor(() => started, "the summary never started")

    assert.equal(pump.cancelThread(target.threadId), true, "stop should own this run")
    await waitFor(() => aborted, "the running summary was not aborted")
    assert.equal(
      pump.cancelThread("some-other-thread"),
      false,
      "stopping another thread must not claim this one"
    )
  } finally {
    pump.stop()
  }
}

/**
 * Stop has to mean stopped, not paused for a second.
 *
 * The abort reaches the delivery loop as a thrown error, and that loop treats
 * anything thrown as a transient failure worth retrying — so the run the user
 * stopped came back on the retry timer about a second later. The test above
 * ends at the abort, which is why this was invisible: the defect is entirely in
 * what happens afterwards.
 */
async function testAStoppedSummaryIsNotRetried(): Promise<void> {
  let runs = 0
  const pump = new ImRemoteModeNotificationPump({
    conversations: conversations() as never,
    capabilityGuard: { evaluate: async () => allowed("coordinator") } as never,
    getThread: () => thread("coordinator"),
    coordinator: {
      restoreWorkersForThread: async () => [],
      hasNotifications: () => true,
      hasAutoRunnableNotifications: () => true,
      drainNotifications: () => ["<task-notification><task-id>w1</task-id></task-notification>"],
      getWorkerSelectedSkill: async () => undefined,
      restoreNotifications: () => undefined,
      restoreNotificationMessages: async () => undefined,
      acknowledgeNotificationMessages: async () => undefined
    } as never,
    workflow: {} as never,
    executeTurn: async (input) =>
      await new Promise<string>((resolve, reject) => {
        runs += 1
        input.signal.addEventListener("abort", () => reject(new Error("aborted")))
      }),
    goalRuns: {} as never,
    events: { enqueueProactiveReplies: async () => [] },
    replyClient: { sendPending: async () => ({ sent: 0, unknown: 0, failed: 0, deferred: 0 }) },
    createRunId: () => "run-stopped-once",
    hasActiveGoal: () => false
  })
  try {
    pump.schedule(notice("coordinator"))
    await waitFor(() => runs === 1, "the summary never started")
    assert.equal(pump.cancelThread(target.threadId), true, "stop should own this run")

    // Past the first retry delay, which is where it used to come back.
    await new Promise((resolve) => setTimeout(resolve, 1_400))
    assert.equal(runs, 1, `a stopped summary must not run again, but it ran ${runs} times`)
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
  await testActiveGoalLeavesDesktopCoordinatorResultsAlone()
  console.log("PASS testActiveGoalLeavesDesktopCoordinatorResultsAlone")
  await testActiveGoalLeavesDesktopWorkflowRunsAlone()
  console.log("PASS testActiveGoalLeavesDesktopWorkflowRunsAlone")
  await testAStoppedSummaryIsNotRetried()
  console.log("PASS testAStoppedSummaryIsNotRetried")
  await testStopReachesASummaryThisPumpIsRunning()
  console.log("PASS testStopReachesASummaryThisPumpIsRunning")
  console.log("im-remote-mode-notification.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
