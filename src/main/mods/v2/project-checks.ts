export type ProjectCheckKind = "unit-test" | "e2e"
export interface ProjectCheckResult {
  kind: ProjectCheckKind
  passed: boolean
  exitCode: number
  executionId?: string
  outputFingerprint: string
  output: string
  reason?: string
}
