export type AgentAutoCommitMode = "off" | "ask" | "always"
export type AgentAutoCommitMessageStrategy = "template" | "prompt" | "diff"

export interface AgentAutoCommitSettings {
  mode: AgentAutoCommitMode
  push: boolean
  messageStrategy: AgentAutoCommitMessageStrategy
  /** Deprecated: task cards are stored per workspace. Kept only for old settings files. */
  cardNumber?: string
  template?: string
}

export interface AgentAutoCommitWorkspaceCard {
  workspacePath: string
  cardNumber?: string
  updatedAt?: string
}

export type AgentAutoCommitStatus =
  | "disabled"
  | "committed"
  | "skipped"
  | "failed"
  | "needs_confirmation"

export interface AgentAutoCommitResult {
  status: AgentAutoCommitStatus
  message?: string
  commitMessage?: string
  commitHash?: string
  committedFiles?: string[]
  skippedFiles?: string[]
  warnings?: string[]
  reasons?: string[]
  /** Whether the post-commit push was attempted and succeeded. */
  pushed?: boolean
  /** Error message from the push attempt, if it failed. Commit still succeeded. */
  pushError?: string
}
