import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import * as managedPolicy from "./managed-run-policy"
import type {
  ManagedFeatureStatusSnapshot,
  ManagedRunSnapshot
} from "../../shared/harness-board-types"

const dependencies = vi.hoisted(() => ({
  hasActiveAgentRun: vi.fn(),
  isWorkflowBusy: vi.fn(),
  hasRunningWorkers: vi.fn(),
  hasFinalizingWorkers: vi.fn(),
  hasWorkerNotifications: vi.fn(),
  inspectFeature: vi.fn(),
  requestBizRetry: vi.fn(),
  createSession: vi.fn(),
  startRetry: vi.fn(),
  prepareRetry: vi.fn(),
  getRun: vi.fn(),
  findRunningRun: vi.fn(),
  getLatestRun: vi.fn(),
  appendEvent: vi.fn(),
  updateSnapshot: vi.fn(),
  emitAttention: vi.fn()
}))

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../db", () => ({
  getThread: () => ({ metadata: "{}" }),
  getAllThreadSummaries: () => []
}))
vi.mock("../agent/agent-run-service", () => ({
  hasActiveTopLevelAgentRun: dependencies.hasActiveAgentRun
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: { isBusyForThreadAsync: dependencies.isWorkflowBusy }
}))
vi.mock("../agent/coordinator-worker-manager", () => ({
  coordinatorWorkerManager: {
    hasRunningWorkersForThread: dependencies.hasRunningWorkers,
    hasTerminalWorkerAwaitingNotificationForThread: dependencies.hasFinalizingWorkers,
    hasAutoRunnableNotifications: dependencies.hasWorkerNotifications
  }
}))
vi.mock("../app-attention-events", () => ({ emitAppAttention: dependencies.emitAttention }))
vi.mock("./service", () => ({
  readHarnessFeatureMetadata: () => ({ projectId: "project", slug: "feature", runId: "mr_test" })
}))
vi.mock("./managed-feature-status", () => ({
  inspectHarnessManagedFeatureStatus: dependencies.inspectFeature
}))
vi.mock("./biz-retry-service", () => ({
  managedBizRetryService: {
    request: dependencies.requestBizRetry,
    removeRunNotifications: vi.fn()
  }
}))
vi.mock("./notifications", () => ({ harnessNotifications: { invalidateRun: vi.fn() } }))
vi.mock("./human-gate-service", () => ({
  hasPendingHumanGateForThread: () => false,
  interruptHumanGatesForRun: vi.fn()
}))
vi.mock("./auto-mode-action-executor", () => ({
  ManagedActionValidationError: class extends Error {},
  createAndStartManagedHarnessSession: dependencies.createSession,
  prepareManagedProviderRetryRun: dependencies.prepareRetry,
  startPreparedManagedAgentRun: dependencies.startRetry
}))
vi.mock("./managed-run-store", () => ({
  managedRunStore: {
    getRun: dependencies.getRun,
    findRunningRun: dependencies.findRunningRun,
    getLatestRun: dependencies.getLatestRun,
    appendEvent: dependencies.appendEvent,
    updateSnapshot: dependencies.updateSnapshot
  }
}))
vi.mock("./managed-run-telemetry", () => ({ reportManagedRunEnded: vi.fn() }))

import {
  handleAutoModeAgentCancelled,
  handleAutoModeAgentTurnEnd,
  stopManagedRun,
  type AutoModeAgentTurnEndInput
} from "./auto-mode-controller"

let run: ManagedRunSnapshot
const feature: ManagedFeatureStatusSnapshot = {
  featureStatus: "in_progress",
  currentNodeId: "dev.code",
  currentNodeStatus: "in_progress",
  isFinalNode: false,
  nextAction: { slashSkill: "dev-code", userMessage: "继续实现" },
  featureStateHash: `v1:sha256:${"a".repeat(64)}`,
  nextActionHash: `v1:sha256:${"b".repeat(64)}`
}
const delivery = { send: vi.fn(), isAvailable: () => true } as unknown as AgentRunDelivery

function turnEnd(overrides: Partial<AutoModeAgentTurnEndInput> = {}): AutoModeAgentTurnEndInput {
  return {
    threadId: "thread",
    outcome: "success",
    endReason: { code: "normal" },
    delivery,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.spyOn(console, "info").mockImplementation(() => undefined)
  run = {
    version: 2.5,
    runId: "mr_test",
    projectId: "project",
    featureId: "feature",
    status: "running",
    workspacePath: "/workspace/project",
    currentSession: { threadId: "thread" },
    decisionBaseline: {
      nodeId: feature.currentNodeId,
      featureStateHash: feature.featureStateHash,
      featureStatus: feature.featureStatus,
      nodeStatus: feature.currentNodeStatus,
      nextActionHash: feature.nextActionHash
    },
    providerRetryCount: 0,
    startedAt: "2026-10-10 10:00:00",
    updatedAt: "2026-10-10 10:00:00"
  }
  dependencies.getRun.mockImplementation(() => ({ snapshot: run, corrupt: false }))
  dependencies.findRunningRun.mockImplementation(() =>
    run.status === "running" ? { snapshot: run, corrupt: false } : null
  )
  dependencies.getLatestRun.mockImplementation(() => run)
  dependencies.appendEvent.mockImplementation((_snapshot, event) => ({
    ...event,
    eventId: `event-${dependencies.appendEvent.mock.calls.length}`,
    createTime: "2026-10-10 10:00:00"
  }))
  dependencies.updateSnapshot.mockImplementation((next) => {
    run = next
    return next
  })
  dependencies.isWorkflowBusy.mockResolvedValue(false)
  dependencies.hasActiveAgentRun.mockReturnValue(false)
  dependencies.hasRunningWorkers.mockReturnValue(false)
  dependencies.hasFinalizingWorkers.mockReturnValue(false)
  dependencies.hasWorkerNotifications.mockReturnValue(false)
  dependencies.inspectFeature.mockResolvedValue(feature)
  dependencies.requestBizRetry.mockReturnValue(true)
  dependencies.startRetry.mockResolvedValue(undefined)
  dependencies.prepareRetry.mockImplementation(() => ({}))
})

describe("managed provider retries and the cumulative limit", () => {
  it("ends the run if a future timer policy returns an unsupported decision", async () => {
    const resolve = managedPolicy.resolveManagedRunDecision
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(managedPolicy, "resolveManagedRunDecision")
      .mockImplementationOnce(resolve)
      .mockReturnValueOnce({
        policyResult: {
          type: "biz_retry",
          proposedAction: "continue_current_thread",
          reasonCode: "biz_retry_no_progress"
        },
        summary: "unsupported timer action"
      })
    await handleAutoModeAgentTurnEnd(
      turnEnd({
        outcome: "error",
        endReason: { code: "provider_error", retryable: true }
      })
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.status).toBe("failed")
    expect(run.lastDecision?.policyResult.reasonCode).toBe("controller_processing_failed")
    expect(vi.getTimerCount()).toBe(0)
    expect(dependencies.startRetry).not.toHaveBeenCalled()
  })

  it("ends the run when a scheduling decision has no execution plan", async () => {
    vi.spyOn(managedPolicy, "resolveManagedRunDecision").mockReturnValueOnce({
      policyResult: {
        type: "provider_retry",
        proposedAction: "schedule_provider_retry",
        reasonCode: "provider_error"
      },
      summary: "missing plan"
    })
    await handleAutoModeAgentTurnEnd(
      turnEnd({
        outcome: "error",
        endReason: { code: "provider_error", retryable: true }
      })
    )
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("缺少执行计划")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports a missing retry session rather than an exhausted provider budget", async () => {
    const append = dependencies.appendEvent.getMockImplementation()!
    dependencies.appendEvent.mockImplementation((snapshot, event) => {
      if (
        event.type === "managed_run_decision" &&
        event.decisionAction === "schedule_provider_retry"
      ) {
        delete snapshot.currentSession
        delete snapshot.decisionBaseline
      }
      return append(snapshot, event)
    })
    await handleAutoModeAgentTurnEnd(
      turnEnd({
        outcome: "error",
        endReason: { code: "provider_error", retryable: true }
      })
    )
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("缺少当前会话或阶段基线")
    expect(
      dependencies.appendEvent.mock.calls.some(
        ([, event]) => event.reasonCode === "provider_retry_missing_session"
      )
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retries a temporary failure in a final feature and records counts after submission", async () => {
    dependencies.inspectFeature.mockResolvedValue({
      ...feature,
      isFinalNode: true,
      featureStatus: "done",
      currentNodeStatus: "done"
    })
    await handleAutoModeAgentTurnEnd(
      turnEnd({ outcome: "error", endReason: { code: "provider_error", retryable: true } })
    )
    expect(run.status).toBe("running")
    expect(run.providerRetryCount).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.providerRetryCount).toBe(1)
    expect(run.totalRetryCount).toBe(1)
    const execution = dependencies.appendEvent.mock.calls.find(
      ([, event]) =>
        event.type === "managed_run_decision" && event.decisionAction === "continue_current_thread"
    )
    expect(execution?.[1].policyResult.facts).toMatchObject({
      providerRetryCount: 1,
      totalRetryCount: 1
    })
  })

  it("reuses the timer inspection for termination and writes one terminal decision", async () => {
    await handleAutoModeAgentTurnEnd(
      turnEnd({ outcome: "error", endReason: { code: "provider_error", retryable: true } })
    )
    run.totalRetryCount = 5
    dependencies.inspectFeature.mockClear()
    dependencies.appendEvent.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.status).toBe("failed")
    expect(dependencies.inspectFeature).toHaveBeenCalledTimes(1)
    expect(
      dependencies.appendEvent.mock.calls.filter(
        ([, event]) => event.type === "managed_run_decision"
      )
    ).toHaveLength(1)
    expect(dependencies.startRetry).not.toHaveBeenCalled()
  })

  it("reads the latest count immediately before a retry attempt", async () => {
    await handleAutoModeAgentTurnEnd(
      turnEnd({ outcome: "error", endReason: { code: "provider_error", retryable: true } })
    )
    dependencies.prepareRetry.mockImplementationOnce(() => {
      run = { ...run, totalRetryCount: 4 }
      return {}
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.totalRetryCount).toBe(5)
  })

  it("does not record a continue decision when stop is requested during preparation", async () => {
    await handleAutoModeAgentTurnEnd(
      turnEnd({ outcome: "error", endReason: { code: "provider_error", retryable: true } })
    )
    dependencies.prepareRetry.mockImplementationOnce(() => {
      void stopManagedRun(run)
      return {}
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(dependencies.startRetry).not.toHaveBeenCalled()
    expect(
      dependencies.appendEvent.mock.calls.some(
        ([, event]) => event.decisionAction === "continue_current_thread"
      )
    ).toBe(false)
    expect(run.totalRetryCount ?? 0).toBe(0)
  })

  const providerFailure = () =>
    turnEnd({
      outcome: "error",
      endReason: { code: "provider_error", retryable: true }
    })

  it("stops a forbidden provider call even if the stage was already completed", async () => {
    run.decisionBaseline!.nodeStatus = "done"
    dependencies.inspectFeature.mockResolvedValue({ ...feature, currentNodeStatus: "done" })
    await handleAutoModeAgentTurnEnd(
      turnEnd({
        outcome: "error",
        endReason: {
          code: "provider_error",
          retryable: false,
          message: "403 当前时段不允许调用该接口"
        }
      })
    )
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("403")
    expect(dependencies.createSession).not.toHaveBeenCalled()
    expect(dependencies.startRetry).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("counts only submitted retries and stops after three failures in the same session", async () => {
    run.decisionBaseline!.nodeStatus = "done"
    dependencies.inspectFeature.mockResolvedValue({ ...feature, currentNodeStatus: "done" })
    for (const [index, delay] of [5_000, 30_000, 120_000].entries()) {
      await handleAutoModeAgentTurnEnd(providerFailure())
      expect(run.totalRetryCount ?? 0).toBe(index)
      await vi.advanceTimersByTimeAsync(delay)
      expect(run.totalRetryCount).toBe(index + 1)
      expect(run.currentSession?.threadId).toBe("thread")
    }
    await handleAutoModeAgentTurnEnd(providerFailure())
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("模型服务重试已达到上限")
    expect(dependencies.startRetry).toHaveBeenCalledTimes(3)
    expect(dependencies.createSession).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("allows the fifth cumulative retry and refuses the sixth", async () => {
    run.totalRetryCount = 4
    await handleAutoModeAgentTurnEnd(providerFailure())
    expect(run.totalRetryCount).toBe(4)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.totalRetryCount).toBe(5)
    await handleAutoModeAgentTurnEnd(providerFailure())
    expect(run.status).toBe("failed")
    expect(run.failureReason).toContain("累计重试上限")
    expect(dependencies.startRetry).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not consume retry budget when a pending retry is cancelled", async () => {
    run.totalRetryCount = 4
    await handleAutoModeAgentTurnEnd(providerFailure())
    await stopManagedRun(run)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run.totalRetryCount).toBe(4)
    expect(dependencies.startRetry).not.toHaveBeenCalled()
  })

  it("retains the cumulative count across successful turns and normal stage advances", async () => {
    run.totalRetryCount = 4
    run.providerRetryCount = 2
    dependencies.createSession.mockResolvedValue({ threadId: "next" })
    dependencies.inspectFeature.mockResolvedValue({ ...feature, currentNodeId: "next-stage" })
    await handleAutoModeAgentTurnEnd(turnEnd())
    expect(run.status).toBe("running")
    expect(run.currentSession?.threadId).toBe("next")
    expect(run.providerRetryCount).toBe(0)
    expect(run.totalRetryCount).toBe(4)
  })
})

const workerBusyStates = [
  { state: "running", query: dependencies.hasRunningWorkers },
  { state: "saving its result", query: dependencies.hasFinalizingWorkers },
  { state: "awaiting result delivery", query: dependencies.hasWorkerNotifications }
]

describe("managed turn-end decisions with background workers", () => {
  describe.each(workerBusyStates)("worker $state", ({ query }) => {
    it.each([
      turnEnd(),
      turnEnd({ outcome: "error", endReason: { code: "provider_error" } }),
      turnEnd({ outcome: "error", endReason: { code: "unknown" } })
    ])("defers $outcome/$endReason.code without requesting a decision or retry", async (input) => {
      query.mockReturnValue(true)

      await handleAutoModeAgentTurnEnd(input)

      expect(query).toHaveBeenCalledWith("thread")
      expect(dependencies.inspectFeature).not.toHaveBeenCalled()
      expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
      expect(dependencies.createSession).not.toHaveBeenCalled()
      expect(dependencies.emitAttention).not.toHaveBeenCalled()
      expect(dependencies.appendEvent).not.toHaveBeenCalled()
      expect(dependencies.updateSnapshot).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(run.status).toBe("running")
    })

    it.each([
      { action: "Biz Retry", snapshot: feature },
      {
        action: "completion",
        snapshot: {
          ...feature,
          featureStatus: "done" as const,
          currentNodeStatus: "done" as const,
          isFinalNode: true
        }
      },
      { action: "failure", snapshot: { ...feature, featureStatus: "error" as const } }
    ])("defers $action if worker work appears during feature inspection", async ({ snapshot }) => {
      dependencies.inspectFeature.mockImplementation(async () => {
        query.mockReturnValue(true)
        return snapshot
      })

      await handleAutoModeAgentTurnEnd(turnEnd())

      expect(dependencies.inspectFeature).toHaveBeenCalledOnce()
      expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
      expect(dependencies.createSession).not.toHaveBeenCalled()
      expect(dependencies.updateSnapshot).not.toHaveBeenCalled()
      expect(dependencies.appendEvent.mock.calls.map(([, event]) => event.type)).toEqual([
        "managed_agent_turn_ended"
      ])
      expect(run.status).toBe("running")
    })
  })

  it("waits through worker completion until the main agent has processed the result", async () => {
    dependencies.hasRunningWorkers.mockReturnValue(true)
    await handleAutoModeAgentTurnEnd(turnEnd())

    dependencies.hasRunningWorkers.mockReturnValue(false)
    dependencies.hasFinalizingWorkers.mockReturnValue(true)
    await handleAutoModeAgentTurnEnd(turnEnd())

    dependencies.hasFinalizingWorkers.mockReturnValue(false)
    dependencies.hasWorkerNotifications.mockReturnValue(true)
    await handleAutoModeAgentTurnEnd(turnEnd())
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()

    dependencies.hasWorkerNotifications.mockReturnValue(false)
    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(dependencies.inspectFeature).toHaveBeenCalledOnce()
    expect(dependencies.requestBizRetry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        run,
        policyResult: expect.objectContaining({ reasonCode: "biz_retry_no_progress" })
      })
    )
  })

  it("completes the feature after the last worker result has been processed", async () => {
    dependencies.inspectFeature.mockResolvedValue({
      ...feature,
      featureStatus: "done",
      currentNodeStatus: "done",
      isFinalNode: true
    })
    dependencies.hasWorkerNotifications.mockReturnValue(true)
    await handleAutoModeAgentTurnEnd(turnEnd())
    expect(run.status).toBe("running")

    dependencies.hasWorkerNotifications.mockReturnValue(false)
    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(run.status).toBe("completed")
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
  })

  it("does not defer for workers belonging to another thread", async () => {
    for (const { query } of workerBusyStates) {
      query.mockImplementation((threadId) => threadId === "other-thread")
    }

    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(dependencies.requestBizRetry).toHaveBeenCalledOnce()
    for (const { query } of workerBusyStates) {
      expect(query).toHaveBeenCalledWith("thread")
    }
  })

  it("does not inspect worker state for an old managed session", async () => {
    run.currentSession = { threadId: "new-thread" }

    await handleAutoModeAgentTurnEnd(turnEnd())

    for (const { query } of workerBusyStates) {
      expect(query).not.toHaveBeenCalled()
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("managed turn-end decisions with background workflows", () => {
  it.each([
    turnEnd(),
    turnEnd({ outcome: "error", endReason: { code: "provider_error" } }),
    turnEnd({ outcome: "error", endReason: { code: "unknown" } })
  ])("defers an additional $outcome/$endReason.code turn while workflow is busy", async (input) => {
    dependencies.isWorkflowBusy.mockResolvedValue(true)

    await handleAutoModeAgentTurnEnd(input)

    expect(dependencies.isWorkflowBusy).toHaveBeenCalledExactlyOnceWith("thread", run.workspacePath)
    expect(dependencies.inspectFeature).not.toHaveBeenCalled()
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
    expect(dependencies.createSession).not.toHaveBeenCalled()
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
    expect(dependencies.updateSnapshot).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(run.status).toBe("running")
  })

  it("keeps the launch-turn protection even when a fast workflow is no longer busy", async () => {
    await handleAutoModeAgentTurnEnd(
      turnEnd({ executionFacts: { workflowLaunchedRunIds: ["wf_fast"] } })
    )

    expect(dependencies.isWorkflowBusy).not.toHaveBeenCalled()
    expect(dependencies.inspectFeature).not.toHaveBeenCalled()
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
  })

  it("resumes the existing Biz Retry policy when a later result-delivery turn ends idle", async () => {
    dependencies.isWorkflowBusy.mockResolvedValueOnce(true)
    await handleAutoModeAgentTurnEnd(turnEnd())
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()

    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(dependencies.inspectFeature).toHaveBeenCalledExactlyOnceWith("project", "feature")
    expect(dependencies.requestBizRetry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        run,
        delivery,
        policyResult: expect.objectContaining({
          type: "biz_retry",
          proposedAction: "start_new_thread",
          reasonCode: "biz_retry_no_progress"
        })
      })
    )
    expect(dependencies.appendEvent).toHaveBeenCalledOnce()
  })

  it("does not complete a feature if workflow becomes busy during the asynchronous inspection", async () => {
    dependencies.isWorkflowBusy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    dependencies.inspectFeature.mockResolvedValue({
      ...feature,
      featureStatus: "done",
      currentNodeStatus: "done",
      isFinalNode: true
    })

    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(dependencies.inspectFeature).toHaveBeenCalledOnce()
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
    expect(dependencies.updateSnapshot).not.toHaveBeenCalled()
    expect(dependencies.createSession).not.toHaveBeenCalled()
    expect(dependencies.appendEvent.mock.calls.map(([, event]) => event.type)).toEqual([
      "managed_agent_turn_ended"
    ])
    expect(run.status).toBe("running")
  })

  it("allows normal completion after the workflow result is delivered", async () => {
    dependencies.inspectFeature.mockResolvedValue({
      ...feature,
      featureStatus: "done",
      currentNodeStatus: "done",
      isFinalNode: true
    })

    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(run.status).toBe("completed")
    expect(dependencies.appendEvent.mock.calls.map(([, event]) => event.type)).toEqual([
      "managed_agent_turn_ended",
      "managed_run_decision",
      "run_completed"
    ])
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
  })

  it.each([
    { action: "Biz Retry", snapshot: feature },
    {
      action: "completion",
      snapshot: {
        ...feature,
        featureStatus: "done" as const,
        currentNodeStatus: "done" as const,
        isFinalNode: true
      }
    },
    { action: "failure", snapshot: { ...feature, featureStatus: "error" as const } }
  ])("honors a stop during the second busy query before $action", async ({ snapshot }) => {
    let releaseBusy!: (busy: boolean) => void
    let signalEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const busyQuery = new Promise<boolean>((resolve) => {
      releaseBusy = resolve
    })
    dependencies.isWorkflowBusy.mockResolvedValueOnce(false).mockImplementationOnce(() => {
      signalEntered()
      return busyQuery
    })
    dependencies.inspectFeature.mockResolvedValue(snapshot)

    const ending = handleAutoModeAgentTurnEnd(turnEnd())
    await entered
    const stopping = stopManagedRun(run)
    releaseBusy(false)
    await ending

    expect(await stopping).toBe(true)
    expect(run.status).toBe("cancelled")
    expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
    expect(dependencies.createSession).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(
      dependencies.appendEvent.mock.calls
        .filter(([, event]) => event.type === "managed_run_decision")
        .map(([, event]) => event.decisionAction)
    ).toEqual(["stop_managed_run"])
  })

  it("does not inspect workflow state for an old managed session", async () => {
    run.currentSession = { threadId: "new-thread" }

    await handleAutoModeAgentTurnEnd(turnEnd())

    expect(dependencies.isWorkflowBusy).not.toHaveBeenCalled()
    expect(dependencies.inspectFeature).not.toHaveBeenCalled()
  })
})

describe("managed run after a user cancels background work", () => {
  it.each(["worker", "workflow"])(
    "stops an idle managed session after cancelling its %s",
    async (kind) => {
      if (kind === "worker") dependencies.hasRunningWorkers.mockReturnValue(true)
      else dependencies.isWorkflowBusy.mockResolvedValue(true)
      await handleAutoModeAgentTurnEnd(turnEnd())
      expect(dependencies.requestBizRetry).not.toHaveBeenCalled()

      dependencies.hasRunningWorkers.mockReturnValue(false)
      dependencies.isWorkflowBusy.mockResolvedValue(false)
      handleAutoModeAgentCancelled("thread", "background")
      await vi.runAllTimersAsync()

      expect(run.status).toBe("cancelled")
      expect(dependencies.appendEvent.mock.calls.map(([, event]) => event.type)).toEqual([
        "session_run_aborted",
        "managed_run_decision",
        "run_cancelled"
      ])
      expect(dependencies.appendEvent.mock.calls[0][1]).toMatchObject({
        threadId: "thread",
        reasonCode: "user_aborted_background_work"
      })
      expect(dependencies.requestBizRetry).not.toHaveBeenCalled()
      expect(dependencies.createSession).not.toHaveBeenCalled()
    }
  )

  it("leaves a foreground agent running after cancelling background work", async () => {
    dependencies.hasActiveAgentRun.mockReturnValue(true)

    handleAutoModeAgentCancelled("thread", "background")
    await vi.runAllTimersAsync()

    expect(run.status).toBe("running")
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
    expect(dependencies.updateSnapshot).not.toHaveBeenCalled()
  })

  it("rechecks foreground activity after waiting for an existing managed operation", async () => {
    let releaseBusy!: (busy: boolean) => void
    let signalEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    dependencies.isWorkflowBusy.mockImplementationOnce(() => {
      signalEntered()
      return new Promise<boolean>((resolve) => {
        releaseBusy = resolve
      })
    })
    const ending = handleAutoModeAgentTurnEnd(turnEnd())
    await entered

    handleAutoModeAgentCancelled("thread", "background")
    dependencies.hasActiveAgentRun.mockReturnValue(true)
    releaseBusy(true)
    await ending
    await vi.runAllTimersAsync()

    expect(run.status).toBe("running")
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
  })

  it("does not stop a newer managed session when an old session's work is cancelled", async () => {
    run.currentSession = { threadId: "new-thread" }

    handleAutoModeAgentCancelled("thread", "background")
    await vi.runAllTimersAsync()

    expect(run.status).toBe("running")
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
  })

  it("still stops the managed run when the user cancels the foreground agent", async () => {
    dependencies.hasActiveAgentRun.mockReturnValue(true)

    handleAutoModeAgentCancelled("thread")
    await vi.runAllTimersAsync()

    expect(run.status).toBe("cancelled")
    expect(dependencies.appendEvent.mock.calls[0][1]).toMatchObject({
      reasonCode: "user_aborted_agent_run"
    })
  })
})
