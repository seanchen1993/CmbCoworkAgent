import type { HookConfig } from "./hooks/types"
import type {
  ForkableCheckpoint as SharedForkableCheckpoint,
  ThreadForkCheckpointForMessageParams as SharedThreadForkCheckpointForMessageParams,
  ThreadForkOverrides as SharedThreadForkOverrides,
  ThreadForkParams as SharedThreadForkParams,
  ThreadForkResponse as SharedThreadForkResponse
} from "../shared/checkpoint-forkability"

export type { ForkBoundarySource, ForkUnstableReason } from "../shared/checkpoint-forkability"

export type {
  AgentAutoCommitMessageStrategy,
  AgentAutoCommitMode,
  AgentAutoCommitResult,
  AgentAutoCommitRepoResult,
  AgentAutoCommitSettings,
  AgentAutoCommitWorkspaceCard,
  AgentAutoCommitStatus
} from "../shared/auto-commit-types"

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
  agentMode?: "normal" | "coordinator" | "workflow"
  coordinatorInternalNotification?: boolean
  /** Renderer user message id for the turn, used to group hook log events. */
  userMessageId?: string
}

export interface AgentResumeParams {
  threadId: string
  command: {
    resume?: {
      decision?: string
      pendingCount?: number
      allowRuntimeRestoredCheckpointResume?: boolean
    }
  }
  modelId?: string
  agentMode?: "normal" | "coordinator" | "workflow"
}

export interface AgentInterruptParams {
  threadId: string
  decision: HITLDecision
}

export interface AgentCancelParams {
  threadId: string
  cancelWorkers?: boolean
}

// Thread IPC
export interface ThreadUpdateParams {
  threadId: string
  updates: Partial<Thread>
}

export interface ThreadValuesMergeParams {
  threadId: string
  patch: Record<string, unknown>
}

export type ThreadForkOverrides = SharedThreadForkOverrides
export type ThreadForkParams = SharedThreadForkParams
export type ThreadForkResponse = SharedThreadForkResponse<Thread>
export type ThreadForkCheckpointForMessageParams = SharedThreadForkCheckpointForMessageParams
export type ForkableCheckpoint = SharedForkableCheckpoint

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
export type ProviderId = "builtin" | "custom"

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
  source: ProviderId
  origin?: "remote" | "fallback"
  maxTokens?: number
  /** Routing tier — absent means premium */
  tier?: "premium" | "economy"
}

// Subagent types (from deepagentsjs)
export interface Subagent {
  id: string
  name: string
  description: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  startedAt?: Date
  completedAt?: Date
  toolCallId?: string
  subagentType?: string
  /** Latest interior tool the subagent invoked — drives the collapsed status line. */
  currentTool?: string
  /** ISO timestamp of the subagent's most recent interior activity (heartbeat). */
  lastActivityAt?: string
  /** Registration order (0-based). Used to match LangGraph checkpoint_ns index (e.g. "tools:0"). */
  spawnIndex?: number
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
  | { type: "custom"; data: Record<string, unknown> }
  | { type: "done"; result: unknown }
  | { type: "error"; error: string; message?: string }

export interface Message {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentBlock[]
  content_priority?: number
  reasoning?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
  status?: string
  is_error?: boolean
  goal_id?: string | null
  active_window_id?: string | null
  created_at: Date
  start_at?: Date
  end_at?: Date
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
  allowRuntimeRestoredCheckpointResume?: boolean
}

export interface HITLDecision {
  type: "approve" | "reject" | "edit"
  tool_call_id: string
  edited_args?: Record<string, unknown>
  feedback?: string
  allowRuntimeRestoredCheckpointResume?: boolean
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

export type SupportedIde = "idea" | "vscode" | "webstorm"

export type PreferredIde = SupportedIde | null

export interface IdeSettings {
  preferredIde: PreferredIde
  executablePaths: Partial<Record<SupportedIde, string>>
}

export interface ConfigurePreferredIdeRequest {
  preferredIde: SupportedIde
  executablePath?: string
}

export interface ConfigurePreferredIdeResult {
  status: "configured" | "needs_executable_path"
  settings: IdeSettings
  message?: string
}

export interface OpenIdeRequest {
  ide: SupportedIde
  workspacePath: string
  filePath?: string
  line?: number
}

// MCP Connector types
export type McpConnectorKind = "remote" | "stdio"

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
  kind?: McpConnectorKind
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
  advanced?: McpConnectorAdvanced
  lazyLoad?: boolean // true = lazy load tools, false/undefined = load all tools
  createdAt: string
  updatedAt: string
}

export interface McpConnectorUpsert {
  name: string
  kind?: McpConnectorKind
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  advanced?: McpConnectorAdvanced
  lazyLoad?: boolean // true = lazy load tools, false/undefined = load all tools
}

export type McpImportConflict = "existing" | "duplicate"
export type McpImportConflictStrategy = "update" | "rename" | "skip"

export interface McpImportPreviewConnector {
  name: string
  sourceName?: string
  kind: McpConnectorKind
  url?: string
  command?: string
  args?: string[]
  hasHeaders: boolean
  hasEnv: boolean
  enabled: boolean
  lazyLoad: boolean
  conflict?: McpImportConflict
  existingId?: string
}

export interface McpImportPreviewResult {
  connectors: McpImportPreviewConnector[]
  errors: string[]
}

export interface McpImportConfigRequest {
  rawJson: string
  autoEnable?: boolean
}

export interface McpImportConfigApplyRequest extends McpImportConfigRequest {
  conflictStrategy?: McpImportConflictStrategy
}

export interface McpImportApplyResult {
  created: Array<{ id: string; name: string }>
  updated: Array<{ id: string; name: string }>
  skipped: Array<{ name: string; reason: string }>
  errors: string[]
}

// Scheduled Task types
export type ScheduledTaskFrequency =
  | "once"
  | "manual"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "interval"
export type ScheduledTaskType = "action" | "reminder"

export interface ScheduledTaskImDeliveryContext {
  provider: "zhaohu"
  conversationKey: string
  expectedDeviceEpoch: number
  inboxThreadId: string
}

export interface ScheduledTask {
  id: string
  name: string
  description: string
  prompt: string
  taskType: ScheduledTaskType // "action" = agent 执行操作, "reminder" = 暖心提醒
  modelId: string | null
  workDir: string | null
  chatxRobotChatId: string | null // 关联的机器人会话ID，执行完后 HTTP 回复
  imDeliveryContext: ScheduledTaskImDeliveryContext | null
  frequency: ScheduledTaskFrequency
  intervalMinutes: number | null // 仅 interval 类型使用，如 5 表示每5分钟
  runAt: string | null // ISO 时间戳，仅 once 类型使用
  runAtTime: string | null // "HH:mm" 格式，如 "09:00"
  weekday: number | null // 0=周日, 1=周一, ..., 6=周六 (仅 weekly 使用)
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
  imDeliveryContext?: ScheduledTaskImDeliveryContext | null
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

export interface BuiltinRobotSettings {
  enabled: boolean
  remoteAccess: "inbox-only" | "inbox-and-features"
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
  useScenario?: string
  author?: { name?: string; email?: string; url?: string } | string
  license?: string
  keywords?: string[]
  skills?: string | string[]
  mcpServers?: string
  /** Path to hooks config file relative to plugin root (default: "hooks/hooks.json") */
  hooks?: string
}

export interface PluginMetadata {
  id: string
  name: string
  version: string
  description: string
  useScenario?: string
  author: string
  path: string
  enabled: boolean
  /**
   * Display-only. Counted once at install/update time by walking the plugin's
   * skill sources. Never gate runtime behavior on this — actual skill
   * discovery (slash popover, hook scope, etc.) re-walks the filesystem
   * through `getEnabledPluginSkillSourceMetadata`, so a stale `skillCount`
   * here cannot hide skills. Used for the "{n} skills" badge in PluginsPanel.
   */
  skillCount: number
  /**
   * Display-only. Same contract as skillCount: counted at install time, never
   * used for gating. getEnabledPluginMcpConfigs re-reads .mcp.json live.
   */
  mcpServerCount: number
  hookCount?: number
  /** Cached hooks config path relative to plugin root, read from manifest at install/inspect time. */
  hookPath?: string
  /**
   * Where this plugin was installed from. Used by the UI to decide whether to
   * expose component details. Older installs lack this field — when undefined,
   * the renderer falls back to a legacy heuristic (name match against the
   * current market list plus a localStorage-tracked "I uploaded this locally"
   * set). The renderer also runs a one-time per-session migration that
   * backfills a concrete value once the market list is successfully loaded,
   * so legacy plugins are eventually pinned to "market" or "local" on disk
   * and stop relying on the heuristic.
   */
  origin?: "market" | "local"
  createdAt: string
  updatedAt: string
}

export interface PluginHookMetadata extends HookConfig {
  pluginId: string
  pluginName: string
  pluginRoot: string
  pluginEnabled: boolean
  hookPath: string
}

export interface SkillHookMetadata extends HookConfig {
  skillName: string
  skillPath: string
  skillRoot: string
  hookPath: string
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
}

export interface PluginMcpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: "sse" | "streamable-http"
  headers?: Record<string, string>
  /** Remote plugin MCP defaults to injecting yst_id_token / sap_id / name. Set false to opt out. */
  injectUserHeaders?: boolean
  /** Base priority, clamped to 0..100. Defaults to 50; global MCP connectors default to 100. */
  priority?: number
  /** plugin-active keeps the plugin MCP lazy until its plugin or skill is used. */
  scope?: "plugin-active" | "plugin-installed"
  /** Optional fallback to a compatible global MCP. Requires safeToRetry=true to avoid duplicate writes. */
  fallback?: {
    enabled?: boolean
    to?: "global"
    match?: "toolNameAndSchema" | "toolName"
    safeToRetry?: boolean
  }
}

export interface PluginMcpServerDetail {
  name: string
  kind: "remote" | "stdio"
  transport?: "sse" | "streamable-http"
  injectUserHeaders: boolean
  priority: number
  scope: "plugin-active" | "plugin-installed"
  fallbackEnabled: boolean
  fallbackTo?: "global"
  fallbackMatch?: "toolNameAndSchema" | "toolName"
  fallbackSafeToRetry: boolean
}

export interface PluginDetail {
  skills: string[]
  mcpServers: string[]
  mcpServerDetails: PluginMcpServerDetail[]
  hookCount: number
  hooks: PluginHookMetadata[]
  manifest: PluginManifest | null
}

// LSP types
export const LSP_JAVA_RUNTIME_NAMES = ["JavaSE-1.8", "JavaSE-11", "JavaSE-17", "JavaSE-21"] as const
export type LspJavaRuntimeName = (typeof LSP_JAVA_RUNTIME_NAMES)[number]
export type LspJavaRuntimeSource = "configured" | "env" | "java_home" | "scan"
export type LspServerState = "stopped" | "starting" | "running" | "error"
export type LspLifecycleState =
  | "stopped"
  | "starting"
  | "importing"
  | "ready"
  | "degraded"
  | "error"

export interface LspJavaRuntime {
  name: LspJavaRuntimeName
  path: string
  source: LspJavaRuntimeSource
  version: string | null
  valid: boolean
  error?: string
}

export interface LspProjectRequirement {
  javaVersion: string
  runtimeName: LspJavaRuntimeName
  source: "pom.xml" | "build.gradle" | "build.gradle.kts" | ".classpath"
}

export interface LspStatus {
  projectRoot: string | null
  state: LspServerState
  lifecycle: LspLifecycleState
  statusText: string
  projectStatusText: string
  progressMessage: string | null
  vsixAvailable: boolean
  vsixSource: "user" | null
  vsixPath: string | null
  serviceReady: boolean
  serviceReadyTimedOut: boolean
  projectReady: boolean
  projectReadyTimedOut: boolean
  projectStatus: string | null
  projectRequirement: LspProjectRequirement | null
  runtimes: LspJavaRuntime[]
  selectedRuntime: LspJavaRuntime | null
  manualJavaHomeStatus: {
    path: string
    version: string | null
    valid: boolean
    error?: string
  } | null
  missingRuntime: LspJavaRuntimeName | null
  degradedReason: string | null
  warningReason: string | null
}

export interface LspConfig {
  enabled: boolean
  maxHeapMb: number
  lastError: string | null
  manualJavaHome: string | null
}

export interface LspDiagnostic {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: "error" | "warning" | "info" | "hint"
  message: string
  source?: string
}

export interface LspLocation {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export interface LspHoverResult {
  contents: string
  range?: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
}

export interface LspSymbol {
  name: string
  kind: string
  file?: string
  line?: number
  column?: number
  containerName?: string
}

export interface LspCallHierarchyItem {
  name: string
  kind: string
  detail?: string
  file: string
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  selectionRange: { startLine: number; startColumn: number; endLine: number; endColumn: number }
}

export interface LspCallHierarchyIncomingCall {
  from: LspCallHierarchyItem
  fromRanges: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>
}

export interface LspCallHierarchyOutgoingCall {
  to: LspCallHierarchyItem
  fromRanges: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>
}

// ── Approval / Sandbox Policy Types ──

/** Review decision for command approval */
export type ReviewDecision =
  | "approved" // approve this invocation only
  | "approved_session" // approve for the remainder of this session (cached)
  | "approved_permanent" // always allow this command pattern (persisted)
  | "denied" // reject
  | "abort" // abort the entire run

/** Command safety classification */
export type ExecSafetyLevel = "safe" | "needs_approval" | "forbidden"

/** Fine-grained approval request sent to the renderer */
export interface ApprovalRequest extends HITLRequest {
  safety_level: ExecSafetyLevel
  /** Operation type: "execute" for shell commands, "write_file"/"edit_file" for file operations */
  operation?:
    | "execute"
    | "write_file"
    | "edit_file"
    | "code_exec"
    | "save_code_exec_tool"
    | "git_commit"
    | "git_push"
  command?: string // shell command (for execute operations)
  /** For git_commit: the message the agent passed via -m, used to pre-fill the dialog */
  suggestedCommitMessage?: string
  /** For git_commit: file paths the agent selected via pathspecs or existing staged files */
  suggestedCommitFilePaths?: string[]
  /** For git_commit: cwd that explicit pathspecs are relative to (after git -C) */
  suggestedCommitFileBasePath?: string
  /** For git_commit/git_push: Git working directory resolved from cd / git -C. */
  suggestedGitWorktreePath?: string
  /** For git_commit: where suggestedCommitFilePaths came from */
  suggestedCommitFileSelectionSource?: "pathspec" | "staged"
  filePath?: string // target file path (for write_file/edit_file operations)
  code?: string // code_exec script preview
  params?: unknown // code_exec params preview
  timeoutMs?: number // code_exec timeout preview
  savedToolName?: string // proposed saved tool name before slug normalization
  savedToolId?: string // proposed saved tool ID
  savedToolDescription?: string // proposed saved tool description
  cwd: string
  reason?: string // why approval is needed
  retry_reason?: string // sandbox-failure retry context
  allowed_approval_types: ApprovalDecisionType[]
}

export type ApprovalDecisionType =
  | "approve"
  | "approve_session"
  | "approve_permanent"
  | "reject"
  | "error"

/** Fine-grained approval decision from the renderer */
export interface ApprovalDecision {
  type: ApprovalDecisionType
  tool_call_id: string
  savedToolName?: string
  savedToolDescription?: string
  /**
   * For git_commit approvals: the outcome of the commit the renderer performed
   * (via workspace:commitWorktree) after the user picked a task card and confirmed.
   * Present only when operation === "git_commit".
   */
  commitResult?: {
    success: boolean
    commitMessage?: string
    error?: string
  }
  /**
   * For git_push approvals: the outcome of the push the renderer performed (via
   * workspace:pushWorktree, the same path as the Git Panel) after the user approved.
   * Present only when operation === "git_push".
   */
  pushResult?: {
    success: boolean
    error?: string
  }
}

// User input request tool
export interface UserInputOption {
  label: string
  description: string
}

export interface UserInputQuestion {
  header: string
  id: string
  question: string
  options: UserInputOption[]
}

export interface UserInputRequest {
  requestId: string
  threadId: string
  questions: UserInputQuestion[]
  createdAt: string
}

export type UserInputAnswer =
  | {
      type: "option"
      questionId: string
      optionIndex: number
      label: string
      description: string
    }
  | {
      type: "other"
      questionId: string
      text: string
    }

export interface UserInputResponse {
  requestId: string
  answers: Record<string, UserInputAnswer>
  submittedAt?: string
  ignored?: boolean
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

/**
 * Hook execution logging configuration.
 *
 * - `enabled = false` (default): no logs collected anywhere — IPC events skipped,
 *   no in-memory ring buffer, no jsonl writes. Zero overhead.
 * - `enabled = true`: per-turn log chips appear in the chat. Click opens a modal
 *   with that turn's hook execution records.
 * - `diagnostic = true` (requires enabled): adds stdin payload, full command,
 *   cwd, env subset; emits "skipped" entries for hooks filtered out by scope;
 *   persists everything to `<openworkDir>/hooks/log/hooks.<YYYY-MM-DD>.jsonl`.
 *   Off by default because the stdin payload can contain sensitive user input.
 */
export interface HookLoggingConfig {
  enabled: boolean
  diagnostic: boolean
}

// Skills types
export interface SkillMetadata {
  id?: string
  name: string
  description: string
  path: string
  source: "user" | "project"
  relativePath?: string
  pluginId?: string
  pluginName?: string
  /** Skill version from SKILL.md frontmatter, defaults to "v1.0.0" */
  version: string
  license?: string | null
  compatibility?: string | null
  metadata?: Record<string, string>
  allowedTools?: string[]
}
