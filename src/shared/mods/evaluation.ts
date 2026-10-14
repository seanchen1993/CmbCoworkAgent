export interface HarnessEvaluationBinding {
  schemaVersion: 1
  experimentId: string
  taskSetDigest: string
  runnerDigest: string
  environmentDigest: string
  modelFingerprint: string
  baselineDigest: string
  candidateDigest: string
  changeKind: "skill" | "prompt" | "flow"
  provider: "real" | "controlled"
  caseIds: string[]
}

/** Host-collected facts only. A serialized record is not a test receipt or apply permission. */
export interface HarnessEvaluationRun {
  binding: HarnessEvaluationBinding
  variant: "baseline" | "candidate"
  sourceDigest: string
  cases: HarnessEvaluationCase[]
}

export interface HarnessEvaluationCase {
  caseId: string
  runId: string
  result: "passed" | "failed" | "unknown" | "cancelled"
  /** IDs resolved by the recorder against actual host evidence, never model text. */
  evidenceIds: string[]
  humanTakeovers: number | null
  durationMs: number | null
  modelCalls: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export interface HarnessEvaluationMetric {
  known: number
  unknown: number
  sum: number | null
  mean: number | null
}
export interface HarnessEvaluationSummary {
  total: number
  passed: number
  failed: number
  unknown: number
  cancelled: number
  /** Unobserved and missing cases remain in the denominator. */
  confirmedPassRate: number
  metrics: Record<
    "humanTakeovers" | "durationMs" | "modelCalls" | "inputTokens" | "outputTokens",
    HarnessEvaluationMetric
  >
}
export interface HarnessEvaluationComparison {
  comparable: boolean
  reasons: string[]
  scope: "controlled-runtime-validation" | "observed-real-provider-runs"
  baseline: HarnessEvaluationSummary
  candidate: HarnessEvaluationSummary
  confirmedPassRateDelta: number | null
  regressions: string[]
  improvements: string[]
  unresolved: string[]
  recommendation:
    | "inspect-regressions"
    | "collect-missing-evidence"
    | "review-candidate"
    | "incomparable"
  /** Evaluation never installs source, grants capabilities or accepts external business effects. */
  canAutoApply: false
}
