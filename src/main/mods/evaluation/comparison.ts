import type {
  HarnessEvaluationBinding,
  HarnessEvaluationCase,
  HarnessEvaluationComparison,
  HarnessEvaluationRun,
  HarnessEvaluationSummary
} from "../../../shared/mods/evaluation"

const metricNames = [
  "humanTakeovers",
  "durationMs",
  "modelCalls",
  "inputTokens",
  "outputTokens"
] as const
const bindingNames = [
  "schemaVersion",
  "experimentId",
  "taskSetDigest",
  "runnerDigest",
  "environmentDigest",
  "modelFingerprint",
  "baselineDigest",
  "candidateDigest",
  "changeKind",
  "provider"
] as const
function bindingEqual(left: HarnessEvaluationBinding, right: HarnessEvaluationBinding): boolean {
  return (
    bindingNames.every((key) => left[key] === right[key]) &&
    left.caseIds.length === right.caseIds.length &&
    left.caseIds.every((id, index) => id === right.caseIds[index])
  )
}
function assertRun(run: HarnessEvaluationRun): void {
  const b = run.binding
  if (
    b.schemaVersion !== 1 ||
    !["real", "controlled"].includes(b.provider) ||
    !["skill", "prompt", "flow"].includes(b.changeKind) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(b.experimentId) ||
    ![
      b.taskSetDigest,
      b.runnerDigest,
      b.environmentDigest,
      b.modelFingerprint,
      b.baselineDigest,
      b.candidateDigest
    ].every((d) => /^[a-f0-9]{64}$/.test(d)) ||
    b.caseIds.length < 1 ||
    b.caseIds.length > 100 ||
    new Set(b.caseIds).size !== b.caseIds.length ||
    b.caseIds.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id)) ||
    !["baseline", "candidate"].includes(run.variant) ||
    run.sourceDigest !== (run.variant === "baseline" ? b.baselineDigest : b.candidateDigest) ||
    run.cases.length > b.caseIds.length
  )
    throw Error("HARNESS_EVALUATION_INVALID")
  const ids = new Set<string>(),
    runs = new Set<string>(),
    evidence = new Set<string>()
  for (const row of run.cases) {
    if (
      !b.caseIds.includes(row.caseId) ||
      ids.has(row.caseId) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(row.runId) ||
      runs.has(row.runId) ||
      !["passed", "failed", "unknown", "cancelled"].includes(row.result) ||
      row.evidenceIds.length > 32 ||
      (row.result === "passed" && row.evidenceIds.length === 0)
    )
      throw Error("HARNESS_EVALUATION_INVALID")
    ids.add(row.caseId)
    runs.add(row.runId)
    for (const id of row.evidenceIds) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || evidence.has(id))
        throw Error("HARNESS_EVALUATION_INVALID")
      evidence.add(id)
    }
    for (const name of metricNames) {
      const value = row[name]
      if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000))
        throw Error("HARNESS_EVALUATION_INVALID")
    }
  }
}
function summarize(run: HarnessEvaluationRun): HarnessEvaluationSummary {
  const counts = {
    passed: 0,
    failed: 0,
    unknown: run.binding.caseIds.length - run.cases.length,
    cancelled: 0
  }
  for (const row of run.cases) counts[row.result]++
  const metrics = Object.fromEntries(
    metricNames.map((name) => {
      const known = run.cases
        .map((row) => row[name])
        .filter((value): value is number => value !== null)
      const sum = known.length ? known.reduce((left, right) => left + right, 0) : null
      return [
        name,
        {
          known: known.length,
          unknown: run.binding.caseIds.length - known.length,
          sum,
          mean: sum === null ? null : sum / known.length
        }
      ]
    })
  ) as HarnessEvaluationSummary["metrics"]
  return {
    total: run.binding.caseIds.length,
    ...counts,
    confirmedPassRate: counts.passed / run.binding.caseIds.length,
    metrics
  }
}

/** Pure comparison of already recorded host facts; it neither authenticates receipts nor runs tasks. */
export function compareHarnessEvaluations(
  baseline: HarnessEvaluationRun,
  candidate: HarnessEvaluationRun
): HarnessEvaluationComparison {
  assertRun(baseline)
  assertRun(candidate)
  if (baseline.variant !== "baseline" || candidate.variant !== "candidate")
    throw Error("HARNESS_EVALUATION_VARIANT")
  const reasons: string[] = []
  if (!bindingEqual(baseline.binding, candidate.binding))
    reasons.push("experiment-binding-mismatch")
  const baselineRuns = new Set(baseline.cases.map((row) => row.runId))
  const baselineEvidence = new Set(baseline.cases.flatMap((row) => row.evidenceIds))
  if (
    candidate.cases.some(
      (row) => baselineRuns.has(row.runId) || row.evidenceIds.some((id) => baselineEvidence.has(id))
    )
  )
    reasons.push("shared-execution-or-evidence")
  const left = summarize(baseline),
    right = summarize(candidate)
  const regressions: string[] = [],
    improvements: string[] = [],
    unresolved: string[] = []
  const settled = (row: HarnessEvaluationCase | undefined) =>
    row?.result === "passed" || row?.result === "failed"
  if (!reasons.length)
    for (const id of baseline.binding.caseIds) {
      const a = baseline.cases.find((row) => row.caseId === id),
        b = candidate.cases.find((row) => row.caseId === id)
      if (!settled(a) || !settled(b)) unresolved.push(id)
      else if (a!.result === "passed" && b!.result === "failed") regressions.push(id)
      else if (a!.result === "failed" && b!.result === "passed") improvements.push(id)
    }
  return {
    comparable: reasons.length === 0,
    reasons,
    scope:
      baseline.binding.provider === "real" && candidate.binding.provider === "real"
        ? "observed-real-provider-runs"
        : "controlled-runtime-validation",
    baseline: left,
    candidate: right,
    confirmedPassRateDelta: reasons.length
      ? null
      : right.confirmedPassRate - left.confirmedPassRate,
    regressions,
    improvements,
    unresolved,
    recommendation: reasons.length
      ? "incomparable"
      : regressions.length
        ? "inspect-regressions"
        : unresolved.length
          ? "collect-missing-evidence"
          : "review-candidate",
    canAutoApply: false
  }
}
