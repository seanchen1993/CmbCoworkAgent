export interface BuiltinChangeReviewFile {
  path: string
  status: "added" | "deleted" | "modified"
  binary: boolean
  beforeFingerprint: string | null
  afterFingerprint: string | null
  patch?: string
}

export type BuiltinChangeReviewBaseline = "head" | "task" | "stage" | "project"

export interface BuiltinChangeReviewEvidence {
  projectName: string
  stageTitle: string
  operationId: string
  matchesProjectVersion: boolean
  checks: Array<{
    checkId: string
    label?: string
    result: "passed" | "failed" | "blocked" | "unknown"
    checkedAt: number
  }>
}

export interface BuiltinChangeReview {
  status: "available" | "unavailable"
  baseline: BuiltinChangeReviewBaseline
  baselineLabel: string
  head: string | null
  capturedAt?: number
  fingerprint?: string
  files: BuiltinChangeReviewFile[]
  message: string
  limitations: string[]
  evidence?: BuiltinChangeReviewEvidence
}
