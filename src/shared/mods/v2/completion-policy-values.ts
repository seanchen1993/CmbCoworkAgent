export const COMPLETION_MODES = ["off", "report", "check", "repair"] as const
export const COMPLETION_SCOPES = ["file", "diff", "feature", "project"] as const
export const COMPLETION_CHECKS = ["code-review", "unit-test", "e2e", "autobiz-validator"] as const

export type CompletionMode = (typeof COMPLETION_MODES)[number]
export type CompletionScope = (typeof COMPLETION_SCOPES)[number]
export type CompletionCheck = (typeof COMPLETION_CHECKS)[number]

export interface CompletionPolicy {
  mode: CompletionMode
  scope: CompletionScope
  target?: string
  feature?: string
  checks: CompletionCheck[]
  maxRepairs: number
  timeoutMs: number
  modelTokenBudget: number
  /** Application-owned stage opt-in; ignored by the guest policy parser. */
  autobizStartCheckpoint?: string
}

export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  mode: "off",
  scope: "project",
  checks: [...COMPLETION_CHECKS],
  maxRepairs: 2,
  timeoutMs: 120_000,
  modelTokenBudget: 8_192
}

export interface CompletionPolicyView {
  source: "application" | "plugin" | "default"
  policy: CompletionPolicy
}
