import { expect, it, vi } from "vitest"
import type { CompositionInternalProject } from "./composition-internal-projects"
import type { CompositionExecutionContext } from "./composition-coordinator"
import type { AgentRunDelivery } from "../../agent/agent-run-service"
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  create: vi.fn(async () => undefined),
  workflow: vi.fn(async () => ({ templates: [{ id: "custom" }], nodes: [{ id: "dev.code" }] })),
  start: vi.fn(async () => ({ runId: "managed" })),
  stop: vi.fn(async () => true),
  cancel: vi.fn(() => true),
  busy: vi.fn(() => false),
  getRun: vi.fn(() => ({
    corrupt: false,
    snapshot: { runId: "managed", status: "cancelled", currentSession: { threadId: "child" } }
  })),
  validate: vi.fn(),
  events: vi.fn(() => ({ events: [], hasMore: false })),
  detail: vi.fn(async () => ({ run: {} })),
  approve: vi.fn(async () => true),
  reject: vi.fn(async () => true),
  pending: vi.fn<() => unknown[]>(() => []),
  liveDecision: vi.fn(() => true),
  decide: vi.fn(async () => ({ applied: true, message: "continued" })),
  preflight: vi.fn(async () => undefined)
}))
vi.mock("./composition-legacy-preflight", () => ({
  preflightLegacyCompositionSource: mocks.preflight
}))
vi.mock("../biz-retry-service", () => ({
  managedBizRetryService: { isLiveDecision: mocks.liveDecision, resolveDecision: mocks.decide }
}))
vi.mock("../service", () => ({
  initializeInternalHarnessProject: mocks.initialize,
  createHarnessFeature: mocks.create,
  getHarnessDynamicWorkflowConfig: mocks.workflow,
  getHarnessRunDetail: mocks.detail
}))
vi.mock("../auto-mode-controller", () => ({
  startManagedRun: mocks.start,
  stopManagedRun: mocks.stop
}))
vi.mock("../managed-run-store", () => ({
  managedRunStore: {
    getRun: mocks.getRun,
    validateRunEvents: mocks.validate,
    listEvents: mocks.events
  }
}))
vi.mock("../human-gate-service", () => ({
  approveHumanGate: mocks.approve,
  rejectHumanGate: mocks.reject
}))
vi.mock("../notifications", () => ({ harnessNotifications: { pending: mocks.pending } }))
vi.mock("../../agent/agent-run-service", () => ({
  cancelActiveAgentRun: mocks.cancel,
  isAgentRunBusy: mocks.busy
}))
vi.mock("../../db", () => ({ getThreadCore: () => undefined }))
// These tests exercise managed adapter routing, not MCP lifecycle. Real peers and
// the internal admission settlement contract have their own dedicated regressions.
vi.mock("../../mcp/capability-service", () => ({
  closeProjectCapabilityMcpService: vi.fn(async () => undefined)
}))
import { createLegacyCompositionDependencies } from "./composition-legacy-production"
const record = {
  projectId: "composition-legacy:parent:unit",
  parentProjectId: "parent",
  featureId: "feature",
  engineRunId: "managed",
  workspace: "fixture-only",
  goal: "真实用户目标",
  compositionRunId: "parent",
  unitId: "unit"
} as CompositionInternalProject
const context = {
  inputs: [{ inputId: "source", destinationPath: "incoming/report.md" }]
} as CompositionExecutionContext
it("passes frozen selected nodes to the original feature creator using retained adapter config", async () => {
  await deps().createFeature({ ...record, workflow: { templateId: "custom", nodeIds: ["dev.code", "ops.archive"] } })
  expect(mocks.workflow).toHaveBeenCalledWith(record.projectId)
  expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({
    workflowTemplate: "custom", workflowNodes: ["dev.code", "ops.archive"],
    workflowConfig: { templates: [{ id: "custom" }], nodes: [{ id: "dev.code" }] }
  }), expect.any(Function))
})
function deps() {
  return createLegacyCompositionDependencies({
    resolveSource: vi.fn(),
    authorize: async () => undefined,
    authorizeCancellation: async () => undefined,
    delivery: () => ({ source: "desktop" }) as unknown as AgentRunDelivery
  })
}
it("calls original initialization, feature creation and managed run with the real goal and resolved inputs", async () => {
  const original = deps()
  await original.initialize(record)
  await original.createFeature(record)
  expect(mocks.initialize).toHaveBeenCalledWith(record.projectId)
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: record.projectId,
      feature: "feature",
      sessionWorkspace: { source: "directory", path: record.workspace }
    }),
    expect.any(Function)
  )
  expect(mocks.create.mock.lastCall).toEqual([
    expect.not.objectContaining({ selectedDeployUnits: expect.anything() }),
    expect.any(Function)
  ])
  expect(await original.start(record, context)).toBe("managed")
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ initialUserMessage: expect.stringContaining("真实用户目标") })
  )
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ initialUserMessage: expect.stringContaining("incoming/report.md") })
  )
})
it("stops the original controller and the active agent, and rejects corrupt completion observations", async () => {
  const original = deps()
  expect(await original.cancel(record)).toBe(true)
  expect(mocks.stop).toHaveBeenCalledWith({
    projectId: record.projectId,
    featureId: record.featureId,
    runId: "managed"
  })
  expect(mocks.cancel).toHaveBeenCalledWith("child")
  mocks.getRun.mockReturnValueOnce({
    corrupt: true,
    snapshot: { runId: "managed", status: "completed", currentSession: { threadId: "child" } }
  })
  await expect(original.observe(record)).rejects.toThrow("JOURNAL_UNHEALTHY")
})
function gate(runId = "managed", sourceThreadId = "child") {
  return {
    notificationId: "gate",
    type: "human_gate",
    status: "pending",
    message: "Review",
    createdAt: "2026-10-14T00:00:00Z",
    payload: {
      projectId: record.projectId,
      featureId: record.featureId,
      sourceThreadId,
      runId,
      humanGate: { hookId: "check" }
    }
  }
}
it("routes an explicit user decision to the original gate service with stored identity", async () => {
  mocks.getRun.mockReturnValue({
    corrupt: false,
    snapshot: { runId: "managed", status: "running", currentSession: { threadId: "child" } }
  })
  const original = deps()
  mocks.pending.mockReturnValue([gate()])
  expect(await original.decideGate(record, "gate", "approve")).toBe(true)
  expect(mocks.approve).toHaveBeenCalledWith({
    projectId: record.projectId,
    featureId: record.featureId,
    gateId: "gate"
  })
})

it("rejects stale gates from another managed run or session at read and decision time", async () => {
  const original = deps()
  const count = mocks.approve.mock.calls.length
  for (const stale of [gate("older-run"), gate("managed", "older-thread")]) {
    mocks.pending.mockReturnValue([stale])
    expect(original.pendingGate(record)).toBeUndefined()
    expect(await original.decideGate(record, "gate", "approve")).toBe(false)
  }
  expect(mocks.approve.mock.calls.length).toBe(count)
  mocks.pending.mockReturnValue([])
})

it("binds original Biz Retry to the live engine session and rechecks before deciding", async () => {
  const original = deps()
  const notice = {
    type: "biz_retry",
    notificationId: "decision",
    message: "retry",
    projectId: record.projectId,
    featureId: record.featureId,
    runId: "managed",
    sourceThreadId: "child"
  }
  mocks.pending.mockReturnValue([notice])
  mocks.getRun.mockReturnValue({
    corrupt: false,
    snapshot: { runId: "managed", status: "running", currentSession: { threadId: "child" } }
  })
  expect(original.pendingDecision!(record)).toMatchObject({
    notificationId: "decision",
    engineRunId: "managed",
    threadId: "child"
  })
  await original.decideDecision!(record, context, {
    notificationId: "decision",
    action: "continue",
    message: "fix"
  })
  expect(mocks.decide).toHaveBeenCalledWith(
    expect.objectContaining({
      notificationId: "decision",
      choice: "continue",
      message: "fix",
      channel: "desktop"
    })
  )
  const count = mocks.decide.mock.calls.length
  mocks.getRun.mockReturnValue({
    corrupt: false,
    snapshot: { runId: "managed", status: "running", currentSession: { threadId: "replacement" } }
  })
  expect(original.pendingDecision!(record)).toBeUndefined()
  await expect(
    original.decideDecision!(record, context, { notificationId: "decision", action: "new_thread" })
  ).rejects.toThrow("COMPOSITION_DECISION_CHANGED")
  expect(mocks.decide).toHaveBeenCalledTimes(count)
  mocks.getRun.mockReturnValue({
    corrupt: true,
    snapshot: { runId: "managed", status: "running", currentSession: { threadId: "child" } }
  })
  expect(original.pendingDecision!(record)).toBeUndefined()
})
