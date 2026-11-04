/** Main-owned authority captured before waiting for a human decision. */
export interface ModOperationApprovalScope {
  workspace: string
  modId: string
  assertCurrent(): void
}
