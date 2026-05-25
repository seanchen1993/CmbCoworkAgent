export type TaskMmdScope = "main" | "subagent"

export type TaskMmdCompileStatus = "idle" | "compiling" | "error"
export type TaskMmdCompileMode = "llm" | "fallback"

export interface TaskMmdSettings {
  enabled: boolean
  compileModelTier: "economy" | "premium"
  l2NullThreshold: number
  l2TimeoutSeconds: number
  maxEntriesPerCompile: number
  maxMmdChars: number
  argsPreviewChars: number
  resultPreviewChars: number
}

export interface TaskMmdToolEntry {
  id: string
  threadId: string
  scope: TaskMmdScope
  toolCallId: string
  toolName: string
  argsPreview: string
  resultPreview: string
  status: "success" | "error"
  timestamp: string
  durationMs: number
  nodeId?: string
}

export interface TaskMmdState {
  lastCompiledAt: string | null
  compiledEntryCount: number
  totalEntryCount: number
  compileStatus: TaskMmdCompileStatus
  lastCompileMode?: TaskMmdCompileMode
  lastError?: string
  lastFailedAt?: string | null
  lastFailureCount?: number
  userEdited?: boolean
}

export interface TaskMmdSnapshot {
  threadId: string
  directory: string
  settings: TaskMmdSettings
  state: TaskMmdState
  mmd: string
  entries: TaskMmdToolEntry[]
}

export interface TaskMmdCompileModelInfo {
  requestedTier: "economy" | "premium"
  resolvedTier: "economy" | "premium" | null
  id: string | null
  name: string | null
  model: string | null
  baseUrl: string | null
  hasApiKey: boolean
  source: "tier" | "routing" | "fallback" | "none"
  reason: string
}

export interface TaskMmdCompileResult {
  mmd: string
  reason: string
}

export const DEFAULT_TASK_MMD_SETTINGS: TaskMmdSettings = {
  enabled: false,
  compileModelTier: "economy",
  l2NullThreshold: 4,
  l2TimeoutSeconds: 300,
  maxEntriesPerCompile: 20,
  maxMmdChars: 6000,
  argsPreviewChars: 1200,
  resultPreviewChars: 1800
}

export const DEFAULT_TASK_MMD_STATE: TaskMmdState = {
  lastCompiledAt: null,
  compiledEntryCount: 0,
  totalEntryCount: 0,
  compileStatus: "idle"
}
