import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import type {
  ManagedFeatureStatusSnapshot,
  ManagedRunSnapshot
} from "../../shared/harness-board-types"

const dependencies = vi.hoisted(() => ({
  isWorkflowBusy: vi.fn(),
  inspectFeature: vi.fn(),
  requestBizRetry: vi.fn(),
  createSession: vi.fn(),
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
vi.mock("../agent/agent-run-service", () => ({ hasActiveTopLevelAgentRun: () => false }))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: { isBusyForThreadAsync: dependencies.isWorkflowBusy }
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
  createAndStartManagedHarnessSession: dependencies.createSession
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
  dependencies.inspectFeature.mockResolvedValue(feature)
  dependencies.requestBizRetry.mockReturnValue(true)
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
