export type AgentAutoCommitMode = "off" | "ask" | "always"
export type AgentAutoCommitMessageStrategy = "template" | "prompt" | "diff"

export interface AgentAutoCommitSettings {
  mode: AgentAutoCommitMode
  push: false
  messageStrategy: AgentAutoCommitMessageStrategy
  cardNumber?: string
  template?: string
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
}
