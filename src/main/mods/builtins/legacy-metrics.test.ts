import { expect, it } from "vitest"
import { projectLegacyExecutionMetrics } from "./legacy-metrics"
import type {
  LegacyProjectOperation,
  LegacyProjectRuntimeBinding
} from "../../../shared/project-runtime/legacy-operations"
const scope = { threadId: "thread", workspace: "workspace", incarnationKey: "original" }
const binding: LegacyProjectRuntimeBinding = {
  schemaVersion: 1,
  packageId: "test-package",
  packageVersion: "1.0.0",
  mods: null,
  enabledAt: 1,
  projectId: "project",
  workspace: "workspace",
  installedPluginId: "plugin",
  packageDigest: "a".repeat(64)
}
function operation(
  id: string,
  start: number,
  end: number | null,
  status: LegacyProjectOperation["status"] = "succeeded"
): LegacyProjectOperation {
  return {
    ...binding,
    operationId: id,
    featureId: "feature",
    threadId: "thread",
    threadIncarnation: "original",
    requestId: `request-${id}`,
    inputDigest: "b".repeat(64),
    terminalCode: end === null ? null : "ORIGINAL_TERMINAL",
    businessStateValidity: "unknown",
    startedAt: start,
    settledAt: end,
    status
  }
}
it("joins only fixed project/feature evidence and unions overlapping durations", () => {
  const a = operation("a", 10, 30),
    b = operation("b", 20, 40),
    unknown = operation("c", 40, 50, "unknown")
  const result = projectLegacyExecutionMetrics(scope, "project", "feature", binding, [
    a,
    a,
    b,
    unknown,
    { ...b, operationId: "other", featureId: "foreign" }
  ])
  expect(result).toMatchObject({
    state: "observed",
    counts: { succeeded: 2, unknown: 1 },
    totalSettledExecutionMs: 30,
    observedExecutionSpanMs: 30,
    approvalWaitMs: null,
    cost: null,
    businessStateValidity: "unknown"
  })
  if (result.state === "observed")
    expect(result.executions.find((row) => row.operationId === "c")?.durationMs).toBeNull()
})
it("does not infer an original stage result from absence, changed binding, or another workspace", () => {
  expect(projectLegacyExecutionMetrics(scope, "project", "feature", undefined, [])).toEqual({
    state: "unavailable"
  })
  expect(
    projectLegacyExecutionMetrics(
      { ...scope, workspace: "elsewhere" },
      "project",
      "feature",
      binding,
      []
    )
  ).toEqual({ state: "unavailable" })
  const result = projectLegacyExecutionMetrics(scope, "project", "feature", binding, [
    { ...operation("a", 10, 30), packageDigest: "old" }
  ])
  expect(result).toMatchObject({
    counts: { succeeded: 0 },
    totalSettledExecutionMs: null,
    businessStateValidity: "unknown"
  })
})

it("projects an original managed snapshot without enabling the new ledger or conflating task completion", () => {
  const managed: import("../../../shared/harness-board-types").ManagedRunSnapshot = {
    version: 2.5,
    updatedAt: "2026-10-12 10:00:05",
    projectId: "project",
    featureId: "feature",
    runId: "mr_original",
    workspacePath: "workspace",
    status: "completed",
    startedAt: "2026-10-12 10:00:00",
    completedAt: "2026-10-12 10:00:05",
    providerRetryCount: 2,
    decisionBaseline: {
      nodeId: "design",
      featureStateHash: "fixture-state",
      featureStatus: "in_progress",
      nodeStatus: "in_progress",
      nextActionHash: "fixture-next"
    },
    currentSession: { threadId: "thread" }
  }
  const result = projectLegacyExecutionMetrics(scope, "project", "feature", undefined, [], managed)
  expect(result).toMatchObject({
    state: "observed",
    managedRun: { runId: "mr_original", durationMs: 5000, providerRetries: 2, nodeId: "design" },
    businessStateValidity: "unknown",
    approvalWaitMs: null
  })
  expect(
    projectLegacyExecutionMetrics(scope, "project", "feature", undefined, [], {
      ...managed,
      workspacePath: "other"
    })
  ).toEqual({ state: "unavailable" })
})
