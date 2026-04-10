// Re-export types from electron for use in renderer

export interface FileAttachment {
  filename: string
  filePath: string    // full path for display
  content: string     // extracted text content
  mimeType: string
  size: number
  truncated: boolean
}

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error"

export interface Thread {
  thread_id: string
  created_at: Date
  updated_at: Date
  metadata?: Record<string, unknown>
  status: ThreadStatus
  thread_values?: Record<string, unknown>
  title?: string
}

export type RunStatus = "pending" | "running" | "error" | "success" | "interrupted"

export interface Run {
  run_id: string
  thread_id: string
  assistant_id?: string
  created_at: Date
  updated_at: Date
  status: RunStatus
  metadata?: Record<string, unknown>
}

// Provider configuration
export type ProviderId = "custom"

export interface Provider {
  id: ProviderId
  name: string
  hasAnyModelApiKey: boolean
}

export interface ModelConfig {
  id: string
  name: string
  provider: ProviderId
  model: string
  description?: string
  available: boolean
  /** Routing tier — absent means premium */
  tier?: "premium" | "economy"
}

import type {
  McpConnectorAdvanced,
  McpConnectorConfig,
  McpConnectorUpsert,
  Subagent,
  ScheduledTask,
  ScheduledTaskUpsert,
  ScheduledTaskFrequency,
  ScheduledTaskType,
  HeartbeatConfig,
  PluginMetadata,
  PluginManifest,
  ChatXConfig,
  ChatXRobotConfig
} from "../../main/types"
import type {
  ManagedSavedCodeExecTool,
  SavedCodeExecPreviewResult,
  SavedCodeExecToolUpdatePayload
} from "../../main/ipc/code-exec-tools"

export type {
  McpConnectorAdvanced,
  McpConnectorConfig,
  McpConnectorUpsert,
  Subagent,
  ScheduledTask,
  ScheduledTaskUpsert,
  ScheduledTaskFrequency,
  ScheduledTaskType,
  HeartbeatConfig,
  PluginMetadata,
  PluginManifest,
  ChatXConfig,
  ChatXRobotConfig
}

export type {
  ManagedSavedCodeExecTool,
  SavedCodeExecPreviewResult,
  SavedCodeExecToolUpdatePayload
}

export type StreamEvent =
  | { type: "message"; message: Message }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "tool_result"; toolResult: ToolResult }
  | { type: "interrupt"; request: HITLRequest }
  | { type: "token"; token: string }
  | { type: "todos"; todos: Todo[] }
  | { type: "workspace"; files: FileInfo[]; path: string }
  | { type: "subagents"; subagents: Subagent[] }
  | { type: "done"; result: unknown }
  | { type: "error"; error: string }

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentBlock[]
  tool_calls?: ToolCall[]
  // For tool messages - links result to its tool call
  tool_call_id?: string
  // For tool messages - the name of the tool
  name?: string
  created_at: Date
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result"
  text?: string
  tool_use_id?: string
  name?: string
  input?: unknown
  content?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  tool_call_id: string
  content: string | unknown
  is_error?: boolean
}

export interface HITLRequest {
  id: string
  tool_call: ToolCall
  allowed_decisions: HITLDecision["type"][]
  pendingCount?: number
  pendingToolCallIds?: string[]
}

export interface HITLDecision {
  type: "approve" | "reject" | "edit"
  tool_call_id: string
  edited_args?: Record<string, unknown>
  feedback?: string
}

export interface Todo {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

export interface FileInfo {
  path: string
  is_dir?: boolean
  size?: number
  modified_at?: string
}

export interface GrepMatch {
  path: string
  line: number
  text: string
}

export interface SkillMetadata {
  name: string
  description: string
  path: string
  source: "user" | "project"
  license?: string | null
  compatibility?: string | null
  metadata?: Record<string, string>
  allowedTools?: string[]
}


export type { HookConfig, HookEvent, HookType, PromptHookFallback, HookUpsert } from "../../main/hooks/types"
