import type { BotRunAddress } from "./bot-run-history"

export interface BotWorktreeSummary {
  id: string
  branch: string
  sourceBranch: string
  directory: string
  baseCommit: string
  headCommit?: string
  dirty: boolean
  status:
    | "provisioning"
    | "running"
    | "ready"
    | "recoverable"
    | "integrating"
    | "merged"
    | "discarded"
  error?: string
  cleanupPending?: boolean
}
export interface BotWorktreeDetail {
  worktree: BotWorktreeSummary
  summary: string
  patch: string
  patchTruncated: boolean
}
export interface BotWorktreeMerge extends BotRunAddress {
  nonce: string
  expectedHeadCommit: string
}
export interface BotWorktreeCleanup extends BotWorktreeMerge {
  operation: "discard" | "cleanup"
}
