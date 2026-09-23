/** Read-only observations; never a validator result, commit receipt or replay authority. */
export interface AutobizRecoveryInspection {
  operationId: string
  journalStatus: "pending" | "unknown" | "committed"
  state: "before" | "after" | "mixed" | "changed" | "unavailable"
  observedAt: number
  files: Array<{
    path: string
    before: string
    after: string
    current?: string
  }>
}
