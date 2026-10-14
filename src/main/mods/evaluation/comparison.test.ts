import { describe, expect, it } from "vitest"
import { compareHarnessEvaluations } from "./comparison"
import type { HarnessEvaluationRun, HarnessEvaluationCase } from "../../../shared/mods/evaluation"

function run(variant: "baseline" | "candidate"): HarnessEvaluationRun {
  const binding = {
    schemaVersion: 1 as const,
    experimentId: "experiment",
    taskSetDigest: "a".repeat(64),
    runnerDigest: "b".repeat(64),
    environmentDigest: "c".repeat(64),
    modelFingerprint: "d".repeat(64),
    baselineDigest: "e".repeat(64),
    candidateDigest: "f".repeat(64),
    changeKind: "prompt" as const,
    provider: "controlled" as const,
    caseIds: ["first", "second"]
  }
  return {
    binding,
    variant,
    sourceDigest: variant === "baseline" ? binding.baselineDigest : binding.candidateDigest,
    cases: binding.caseIds.map((caseId) => ({
      caseId,
      runId: `${variant}-${caseId}`,
      result: "passed" as const,
      evidenceIds: [`evidence-${variant}-${caseId}`],
      humanTakeovers: 0,
      durationMs: 100,
      modelCalls: 1,
      inputTokens: null,
      outputTokens: null
    }))
  }
}
describe("host evaluation comparison", () => {
  it("separates controlled runtime checks from business quality and never auto applies", () => {
    const report = compareHarnessEvaluations(run("baseline"), run("candidate"))
    expect(report.scope).toBe("controlled-runtime-validation")
    expect(report.canAutoApply).toBe(false)
    expect(report.baseline.metrics.inputTokens).toEqual({
      known: 0,
      unknown: 2,
      sum: null,
      mean: null
    })
    expect(report.baseline.metrics.humanTakeovers).toEqual({
      known: 2,
      unknown: 0,
      sum: 0,
      mean: 0
    })
  })
  it("keeps missing and cancelled cases in the denominator and never imputes zero usage", () => {
    const baseline = run("baseline"),
      candidate = run("candidate")
    candidate.cases.pop()
    candidate.cases[0]!.inputTokens = 20
    const report = compareHarnessEvaluations(baseline, candidate)
    expect(report.candidate).toMatchObject({
      total: 2,
      passed: 1,
      unknown: 1,
      confirmedPassRate: 0.5
    })
    expect(report.unresolved).toEqual(["second"])
    expect(report.candidate.metrics.inputTokens).toEqual({
      known: 1,
      unknown: 1,
      sum: 20,
      mean: 20
    })
    expect(report.recommendation).toBe("collect-missing-evidence")
    candidate.cases[0]!.result = "cancelled"
    expect(compareHarnessEvaluations(baseline, candidate).candidate).toMatchObject({
      cancelled: 1,
      confirmedPassRate: 0
    })
  })
  it("shows paired regressions even when another case improves and aggregate pass rate ties", () => {
    const baseline = run("baseline"),
      candidate = run("candidate")
    baseline.cases[0]!.result = "failed"
    candidate.cases[1]!.result = "failed"
    const report = compareHarnessEvaluations(baseline, candidate)
    expect(report.confirmedPassRateDelta).toBe(0)
    expect(report.improvements).toEqual(["first"])
    expect(report.regressions).toEqual(["second"])
    expect(report.recommendation).toBe("inspect-regressions")
  })
  it.each(["taskSetDigest", "runnerDigest", "environmentDigest", "modelFingerprint"] as const)(
    "refuses to compare changed %s",
    (key) => {
      const baseline = run("baseline"),
        candidate = run("candidate")
      candidate.binding[key] = "1".repeat(64)
      const report = compareHarnessEvaluations(baseline, candidate)
      expect(report.comparable).toBe(false)
      expect(report.confirmedPassRateDelta).toBeNull()
      expect(report.improvements).toEqual([])
    }
  )
  it("rejects variant/source mismatch, duplicated cases, and passed cases without host evidence references", () => {
    const baseline = run("baseline")
    for (const mutate of [
      (r: HarnessEvaluationRun) => {
        r.sourceDigest = baseline.sourceDigest
      },
      (r: HarnessEvaluationRun) => {
        r.cases[1] = { ...r.cases[0]! }
      },
      (r: HarnessEvaluationRun) => {
        r.cases[0]!.evidenceIds = []
      }
    ]) {
      const candidate = run("candidate")
      mutate(candidate)
      expect(() => compareHarnessEvaluations(baseline, candidate)).toThrow(
        "HARNESS_EVALUATION_INVALID"
      )
    }
  })
  it("refuses one actual execution or evidence ID reused as both variants", () => {
    const baseline = run("baseline"),
      candidate = run("candidate")
    candidate.cases[0]!.runId = baseline.cases[0]!.runId
    expect(compareHarnessEvaluations(baseline, candidate).reasons).toContain(
      "shared-execution-or-evidence"
    )
    candidate.cases[0]!.runId = "new-run"
    candidate.cases[0]!.evidenceIds = baseline.cases[0]!.evidenceIds
    expect(compareHarnessEvaluations(baseline, candidate).comparable).toBe(false)
  })
  it.each([NaN, Infinity, -1, 0.5, 1_000_000_001])("rejects invalid host metric %s", (value) => {
    const candidate = run("candidate")
    candidate.cases[0]!.durationMs = value
    expect(() => compareHarnessEvaluations(run("baseline"), candidate)).toThrow(
      "HARNESS_EVALUATION_INVALID"
    )
  })
  it("does not mutate input or promote failed/unknown outcomes from model opinion", () => {
    const baseline = run("baseline"),
      candidate = run("candidate")
    const row = candidate.cases[0]! as HarnessEvaluationCase & { modelOpinion?: string }
    row.result = "unknown"
    row.modelOpinion = "All requirements passed"
    const before = JSON.stringify({ baseline, candidate })
    expect(compareHarnessEvaluations(baseline, candidate).candidate.unknown).toBe(1)
    expect(JSON.stringify({ baseline, candidate })).toBe(before)
  })
})
