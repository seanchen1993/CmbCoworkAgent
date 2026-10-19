import assert from "node:assert/strict"
import { getWorkflowAgentTimeoutMs, getWorkflowMaxRuntimeMs,
  getWorkflowRunWallClockMs } from "../../src/main/agent/workflow/types"

export type FullAppAcceptanceMode = "strict90" | "bounded-functional" | "native-functional"
type Boundary = "native" | "http" | "workflow"
const STAGE_MS = 90000
const OVERALL_MS = 900000

export function fullAppAcceptanceMode(value: string | undefined): FullAppAcceptanceMode {
  assert(value === undefined || value === "strict90" || value === "bounded-functional" || value === "native-functional",
    "Unknown Full10 acceptance mode")
  return value ?? "strict90"
}

/** Test-only reporting and deadlines; never alters a native Workflow/business timeout. */
export function createFullAppAcceptancePolicy(mode: FullAppAcceptanceMode, startedAt: number) {
  assert(Number.isFinite(startedAt))
  const nativeRuntime = Object.freeze({ maxRuntimeMs: getWorkflowMaxRuntimeMs(),
    inactivityMs: getWorkflowRunWallClockMs(), perAgentTimeoutMs: getWorkflowAgentTimeoutMs() ?? null,
    source: "Original src/main/agent/workflow/types.ts runtime getters; native engine remains the timeout owner" })
  const overallBudgetMs = mode === "native-functional" ? nativeRuntime.maxRuntimeMs + OVERALL_MS : OVERALL_MS
  const absoluteDeadline = startedAt + overallBudgetMs
  let lastObservedAt = startedAt
  const timings = new Map<string, { boundary: Boundary; stage: string; startedAt: number;
    lastObservedAt: number; elapsedMs: number; exceeded90: boolean }>()
  const deadline = (stage: string, stageStartedAt: number): number =>
    mode !== "strict90" && stage === "dev.code"
      ? absoluteDeadline : Math.min(stageStartedAt + STAGE_MS, absoluteDeadline)
  return {
    mode,
    absoluteDeadline,
    overallBudgetMs,
    nativeRuntime,
    deadline,
    observe(boundary: Boundary, stage: string, stageStartedAt: number, at: number): void {
      assert(stage.length > 0 && Number.isFinite(stageStartedAt) && Number.isFinite(at) &&
        stageStartedAt >= startedAt && at >= stageStartedAt, "Invalid original stage timing")
      const key = `${boundary}:${stage}`, previous = timings.get(key)
      assert(!previous || previous.startedAt === stageStartedAt,
        "Retry/first HTTP must not reset the original timing boundary")
      lastObservedAt = Math.max(lastObservedAt, at)
      const elapsedMs = Math.max(previous?.elapsedMs ?? 0, at - stageStartedAt)
      timings.set(key, { boundary, stage, startedAt: stageStartedAt, lastObservedAt: at,
        elapsedMs, exceeded90: elapsedMs >= STAGE_MS })
      if (mode === "strict90" || stage !== "dev.code")
        assert(elapsedMs < STAGE_MS, boundary === "native"
          ? `Original native stage exceeded90s: ${stage}` : `Original ${boundary} stage exceeded90s: ${stage}`)
      assert(at < absoluteDeadline, mode === "native-functional"
        ? "Full10 original Workflow-runtime-derived outer safety bound exceeded"
        : "Full10 original15min absolute acceptance deadline exceeded")
    },
    evidence(functionalPassed: boolean, finishedAt = lastObservedAt) {
      assert(Number.isFinite(finishedAt) && finishedAt >= startedAt)
      const overallElapsedMs = Math.max(lastObservedAt, finishedAt) - startedAt
      const overall15Exceeded = overallElapsedMs >= OVERALL_MS
      const observedTimings = [...timings.values()]
      const performanceBreaches = observedTimings.filter(row => row.exceeded90)
      const performanceFailed = performanceBreaches.length > 0 || overall15Exceeded
      return { mode, functionalAcceptance: functionalPassed,
        performanceAcceptance: performanceFailed ? false : functionalPassed ? true : null,
        performanceStatus: performanceFailed ? "failed" : functionalPassed ? "passed" : "not_evaluated",
        performanceTargetMs: STAGE_MS, overallDeadline: absoluteDeadline,
        overallBudgetMs, overallElapsedMs, overallPerformanceTargetMs: OVERALL_MS,
        bounded15Acceptance: overall15Exceeded ? false : functionalPassed ? true : null,
        overall15Exceeded, timings: observedTimings, performanceBreaches, nativeRuntime,
        scope: mode === "native-functional"
          ? "Native Workflow timeout chain owns Code; outer safety bound derives from original max-runtime plus15min allowance; not a4h whole-Code promise or enterprise acceptance"
          : "15min bounded local functional integration; not the4h native business contract or enterprise acceptance" }
    }
  }
}
