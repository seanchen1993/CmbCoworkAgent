export type SubagentTranscriptRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export type SubagentTranscriptCompleteness = "recording" | "complete" | "partial" | "storage_error"

export interface SubagentTranscriptRunSummary {
  version: 1
  threadId: string
  subagentId: string
  name?: string
  description?: string
  subagentType?: string
  status: SubagentTranscriptRunStatus
  completeness: SubagentTranscriptCompleteness
  startedAt: number
  completedAt?: number
  lastActivityAt: number
  totalMessages: number
  totalChars: number
  storedBytes: number
  storageError?: string
}

export interface PersistedSubagentTranscriptMessage {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: unknown
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  tool_call_id?: string
  name?: string
  status?: string
  is_error?: boolean
  created_at: number
}
