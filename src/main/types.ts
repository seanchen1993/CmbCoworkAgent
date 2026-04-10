// Thread types matching langgraph-api
export type ThreadStatus = "idle" | "busy" | "interrupted" | "error"

// =============================================================================
// IPC Handler Parameter Types
// =============================================================================

// Agent IPC
export interface AgentInvokeParams {
  threadId: string
  message: string
  modelId?: string
}

export interface AgentResumeParams {
  threadId: string
  command: { resume?: { decision?: string; pendingCount?: number } }
  modelId?: string
}

export interface AgentInterruptParams {
  threadId: string
  decision: HITLDecision
}

export interface AgentCancelParams {
  threadId: string
}

// Thread IPC
export interface ThreadUpdateParams {
  threadId: string
  updates: Partial<Thread>
}

// Workspace IPC
export interface WorkspaceSetParams {
  threadId?: string
  path: string | null
}

export interface WorkspaceLoadParams {
  threadId: string
}

export interface WorkspaceFileParams {
  threadId: string
  filePath: string
}

export interface Thread {
  thread_id: string
  created_at: Date
  updated_at: Date
  metadata?: Record<string, unknown>
  status: ThreadStatus
  thread_values?: Record<string, unknown>
  title?: string
}

// Run types
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

// Model configuration
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

// Subagent types (from deepagentsjs)
export interface Subagent {
  id: string
  name: string
  description: string
  status: "pending" | "running" | "completed" | "failed"
  startedAt?: Date
  completedAt?: Date
  toolCallId?: string
  subagentType?: string
}

// Stream events from agent
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

// Human-in-the-loop
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

// Todo types (from deepagentsjs)
export interface Todo {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

// File types (from deepagentsjs backends)
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

// MCP Connector types
export interface McpConnectorAdvanced {
  headers?: Record<string, string>
  transport?: "sse" | "streamable-http"
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    delayMs?: number
  }
}

export interface McpConnectorConfig {
  id: string
  name: string
  url: string
  enabled: boolean
  advanced?: McpConnectorAdvanced
  lazyLoad?: boolean  // true = lazy load tools, false/undefined = load all tools
  createdAt: string
  updatedAt: string
}

export interface McpConnectorUpsert {
  name: string
  url: string
  enabled?: boolean
  advanced?: McpConnectorAdvanced
  lazyLoad?: boolean  // true = lazy load tools, false/undefined = load all tools
}

// Scheduled Task types
export type ScheduledTaskFrequency = "once" | "manual" | "hourly" | "daily" | "weekdays" | "weekly" | "interval"
export type ScheduledTaskType = "action" | "reminder"

export interface ScheduledTask {
  id: string
  name: string
  description: string
  prompt: string
  taskType: ScheduledTaskType       // "action" = agent 执行操作, "reminder" = 暖心提醒
  modelId: string | null
  workDir: string | null
  chatxRobotChatId: string | null // 关联的机器人会话ID，执行完后 HTTP 回复
  frequency: ScheduledTaskFrequency
  intervalMinutes: number | null    // 仅 interval 类型使用，如 5 表示每5分钟
  runAt: string | null            // ISO 时间戳，仅 once 类型使用
  runAtTime: string | null       // "HH:mm" 格式，如 "09:00"
  weekday: number | null          // 0=周日, 1=周一, ..., 6=周六 (仅 weekly 使用)
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  lastRunStatus: "ok" | "error" | null
  lastRunError: string | null
  nextRunAt: string | null
}

export interface ScheduledTaskUpsert {
  name: string
  description: string
  prompt: string
  taskType?: ScheduledTaskType
  modelId: string | null
  workDir: string | null
  chatxRobotChatId?: string | null
  frequency: ScheduledTaskFrequency
  intervalMinutes?: number | null
  runAt?: string | null
  runAtTime?: string | null
  weekday?: number | null
  enabled?: boolean
}

export interface TaskRunRecord {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  finishedAt: string
  status: "ok" | "error"
  error: string | null
  durationMs: number
}

// Heartbeat types
export interface HeartbeatConfig {
  enabled: boolean
  intervalMinutes: number
  prompt: string
  modelId: string | null
  workDir: string | null
  lastRunAt: string | null
  lastRunStatus: "ok" | "ok_silent" | "skipped" | "error" | null
  lastRunError: string | null
}

// Plugin types
export interface PluginManifest {
  name: string
  version?: string
  description?: string
  author?: { name?: string; email?: string; url?: string } | string
  license?: string
  keywords?: string[]
  skills?: string | string[]
  mcpServers?: string
}

export interface PluginMetadata {
  id: string
  name: string
  version: string
  description: string
  author: string
  path: string
  enabled: boolean
  skillCount: number
  mcpServerCount: number
  createdAt: string
  updatedAt: string
}

export interface PluginMcpServerConfig {
  command?: string
  args?: string[]
  url?: string
  transport?: "sse" | "streamable-http"
  headers?: Record<string, string>
}

// ── Approval / Sandbox Policy Types ──

/** Review decision for command approval */
export type ReviewDecision =
  | "approved"            // approve this invocation only
  | "approved_session"    // approve for the remainder of this session (cached)
  | "approved_permanent"  // always allow this command pattern (persisted)
  | "denied"              // reject
  | "abort"               // abort the entire run

/** Command safety classification */
export type ExecSafetyLevel = "safe" | "needs_approval" | "forbidden"

/** Fine-grained approval request sent to the renderer */
export interface ApprovalRequest extends HITLRequest {
  safety_level: ExecSafetyLevel
  /** Operation type: "execute" for shell commands, "write_file"/"edit_file" for file operations */
  operation?: "execute" | "write_file" | "edit_file" | "code_exec" | "prepare_save_code_exec_tool" | "save_code_exec_tool"
  command?: string           // shell command (for execute operations)
  filePath?: string          // target file path (for write_file/edit_file operations)
  code?: string              // code_exec script preview
  params?: unknown           // code_exec params preview
  timeoutMs?: number         // code_exec timeout preview
  savedToolName?: string     // proposed saved tool name before slug normalization
  savedToolId?: string       // proposed saved tool ID
  savedToolDescription?: string // proposed saved tool description
  savedToolMetadataError?: string // metadata generation failure message for manual fallback
  cwd: string
  reason?: string           // why approval is needed
  retry_reason?: string     // sandbox-failure retry context
  allowed_approval_types: ApprovalDecisionType[]
}

export type ApprovalDecisionType = "approve" | "approve_session" | "approve_permanent" | "reject"

/** Fine-grained approval decision from the renderer */
export interface ApprovalDecision {
  type: ApprovalDecisionType
  tool_call_id: string
  savedToolName?: string
  savedToolDescription?: string
}

// ChatX types
export interface ChatXRobotConfig {
  chatId: string
  httpUrl: string
  fromId: string
  clientId: string
  clientSecret: string
  channel: string
  toUserList: string[]
  modelId: string | null
  workDir: string | null
}

export interface ChatXConfig {
  enabled: boolean
  wsUrl: string
  userIp: string
  robots: ChatXRobotConfig[]
}

// Skills types
export interface SkillMetadata {
  name: string
  description: string
  path: string
  source: "user" | "project"
  /** Skill version from SKILL.md frontmatter, defaults to "v1.0.0" */
  version: string
  license?: string | null
  compatibility?: string | null
  metadata?: Record<string, string>
  allowedTools?: string[]
}
