import type { HookConfig } from "./hooks/types"
import type { ImChannelId } from "../shared/im-gateway-contract"
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
  streamRequestId?: string
  message: string
  modelId?: string
  agentMode?: "normal" | "coordinator" | "workflow"
  /** One-run ManagedRun launch authorization; bridges currentSession persistence startup races. */
  managedExecution?: boolean
  coordinatorInternalNotification?: boolean
  /** Renderer user message id for the turn, used to group hook log events. */
  userMessageId?: string
}

export interface AgentResumeParams {
  threadId: string
  streamRequestId?: string
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
  streamRequestId?: string
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

export interface ThreadMetadataPatch {
  set?: Record<string, unknown>
  remove?: string[]
}

export interface ThreadMetadataPatchParams {
  threadId: string
  patch: ThreadMetadataPatch
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
  workspacePath?: string
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
  /** True only after this execution was observed in the current live stream. */
  observedLive?: boolean
  /** Renderer-only provenance for a prompt row restored without a stable final. */
  restoredFromPromptOnly?: boolean
}

export interface SubagentTranscriptPage {
  messages: unknown[]
  deferredHydration: boolean
  deferredExport?: {
    messageIndex: number
    expectedMessageId: string
    fields: SubagentTranscriptBlobField[]
  }
  end: number
  start: number
  nextBefore?: number
  total: number
}

export type SubagentTranscriptBlobField = "content" | "reasoning" | "tool_calls"

export interface SubagentTranscriptBlobExportResult {
  success: boolean
  canceled?: boolean
  filePath?: string
  error?: string
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
  /** Durable transcript order. Present on messages read from thread_messages pages. */
  ordinal?: number
  provider_source_id?: string
  provider_occurrence?: number
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

export interface ThreadMessagesPageOptions {
  /**
   * Cursor returned by the previous page. `beforeOrdinal` and
   * `beforeMessageId` must be supplied together so duplicate legacy ordinals
   * cannot make pagination skip or repeat messages.
   */
  beforeOrdinal?: number
  beforeMessageId?: string
  /**
   * Read a backward window that is guaranteed to contain this exact durable
   * message. This is mutually exclusive with every other page cursor and is
   * used for virtualized search reveals where repeated ordinals make a guessed
   * 500-row page unsafe.
   */
  targetMessageId?: string
  /**
   * Read forward from this exact durable message (inclusive). This is mutually
   * exclusive with the backward compound cursor and is used to close a released
   * renderer window without guessing ordinals.
   */
  anchorMessageId?: string
  limit?: number
  /**
   * Optional response budget. Values above the process-wide 4 MiB ceiling are
   * clamped. An individually oversized message is returned as an explicit
   * bounded preview so the cursor advances without breaking the IPC budget.
   */
  byteBudget?: number
  /**
   * Foreground hydration is latest-wins per renderer. Starting a newer request
   * cancels the previous foreground page without affecting history pagination.
   */
  requestScope?: "foreground-hydration"
  /**
   * Ask the off-main-thread reader to resolve whether any durable row belongs
   * to the visible conversation. Initial hydration requests this once; history
   * pagination reuses the resulting renderer scalar and avoids repeated scans.
   */
  includeVisibleMessagePresence?: boolean
  /**
   * Internal checkpoint-recovery fence. Rows persisted after this timestamp
   * belong to a later graph input and must not be folded into the old state.
   */
  notAfterCreatedAt?: number
  /** Checkpoint identity paired with notAfterCreatedAt for legacy ordinal fencing. */
  recoveryCheckpointId?: string
}

export interface ThreadHydrationOptions {
  /** Cancel an older selected-task metadata read from the same renderer. */
  requestScope?: "foreground-hydration"
}

export interface ThreadSummaryPageOptions {
  beforeUpdatedAt?: number
  beforeThreadId?: string
  limit?: number
  byteBudget?: number
}

export interface ThreadSummaryPage {
  threads: Thread[]
  beforeUpdatedAt: number | null
  beforeThreadId: string | null
  hasMore: boolean
}

export type ThreadGroupSelector =
  | { type: "workspace"; workspacePath: string | null }
  | { type: "harness-project"; projectId: string }
  | { type: "harness-feature"; projectId: string; slug: string }

export interface ThreadGroupIdsOptions {
  selector: ThreadGroupSelector
}

/** Stable identity captured with a destructive group-selection snapshot. */
export interface ThreadIncarnationSnapshot {
  token: string | null
  legacyCreatedAt: number
}

export interface ThreadGroupSelectionEntry {
  threadId: string
  incarnation: ThreadIncarnationSnapshot
}

export interface ThreadGroupIdsResult {
  entries: ThreadGroupSelectionEntry[]
}

export interface ThreadGroupDeleteGuard {
  selector: ThreadGroupSelector
  incarnation: ThreadIncarnationSnapshot
}

export interface ThreadDeleteOptions {
  requireIdle?: boolean
  /**
   * Bind a bulk-delete request to the exact row and group membership the user
   * confirmed. Main rechecks this inside the same-thread mutation lock.
   */
  groupGuard?: ThreadGroupDeleteGuard
}

export interface ThreadMessagesPage {
  /** Messages are always returned in durable ascending transcript order. */
  messages: Message[]
  /** Cursor for the next older page; explicit forward reads always return null here. */
  beforeOrdinal: number | null
  beforeMessageId: string | null
  /** Whether more rows remain in the requested direction. */
  hasMore: boolean
  /** Echoed only for a successful explicit forward read after the durable anchor is verified. */
  verifiedAnchorMessageId?: string
  /** Total durable messages for the thread, independent of the cursor. */
  total: number
  /** Present only when includeVisibleMessagePresence was requested. */
  hasVisibleMessages?: boolean
  /**
   * Present only with the initial presence summary. `migrating` means a legacy
   * checkpoint copy was interrupted and must be resumed before an empty
   * conversation can be trusted; `complete` makes the durable table authoritative.
   */
  legacyCheckpointMigrationStatus?: "migrating" | "complete" | null
  /** Durable rows represented by bounded previews because their payload exceeded the page budget. */
  truncatedMessageIds?: string[]
}

export interface ThreadLegacyCheckpointMigrationStats {
  checkpointId: string | null
  totalMessages: number
  migratedMessages: number
  batches: number
  payloadBytes: number
}

export interface ThreadLegacyCheckpointBootstrapResult {
  checkpoint: unknown | null
  page: ThreadMessagesPage
  migration: ThreadLegacyCheckpointMigrationStats
}

export interface ThreadMessageSearchOptions {
  /**
   * Cursor returned by the previous search page. Both fields must be supplied
   * together so duplicate legacy ordinals cannot skip or repeat messages.
   */
  beforeOrdinal?: number
  beforeMessageId?: string
  /** Maximum matches returned by one bounded database scan. */
  limit?: number
}

export interface ThreadMessageSearchMatch {
  messageId: string
  ordinal: number
  role: Message["role"]
  createdAt: number
  /** Non-overlapping occurrences, matching the renderer's existing search semantics. */
  occurrenceCount: number
  /** Query-centred, bounded plain-text preview. */
  preview: string
}

export interface ThreadMessageSearchPage {
  /** Matches are returned from newest to oldest. */
  matches: ThreadMessageSearchMatch[]
  /** Cursor for continuing toward older durable messages. */
  beforeOrdinal: number | null
  beforeMessageId: string | null
  /**
   * True when more durable search space remains. A later page can legitimately
   * contain no matches because each call scans a bounded transcript window.
   */
  hasMore: boolean
  /** Number of durable message headers inspected by this page. */
  scanned: number
  /** True when an individual oversized row could not be inspected within the hard byte budget. */
  truncated: boolean
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
  provider: ImChannelId
  principalId: string
  conversationKey: string
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
  /** Optional runtime override. When null, the build-time environment value is used. */
  gatewayUrl: string | null
  remoteAccess: "inbox-only" | "inbox-and-features"
  remoteApprovalEnabled: boolean
  waitingDesktopTtlMinutes: number
}

export type BuiltinRobotConnectionState = "connecting" | "online" | "offline" | "error"
export type BuiltinRobotIdentityState = "verified" | "verifying" | "missing" | "error"

export interface BuiltinRobotRouteStatus {
  /** Opaque enterprise subject asserted by the authenticated Gateway session. */
  principalId: string
  conversationKey: string
  state: "active" | "suspended" | "revoked"
}

export interface BuiltinRobotFeatureBindingStatus {
  conversationKey: string
  bindingId: string
  projectId: string
  featureSlug: string
  threadId: string
  state: "pending" | "active" | "suspended" | "revoked" | "historical"
  suspendReason: string | null
  activeTarget: boolean
}

export interface BuiltinRobotThreadGrantStatus {
  kind: "thread"
  grantId: string
  threadId: string
  title: string
  state: "active" | "suspended" | "revoked"
  grantVersion: number
  conversationKey: string
  suspendReason: string | null
}

export interface BuiltinRobotFeatureGrantStatus {
  kind: "feature"
  grantId: string
  projectId: string
  featureSlug: string
  projectName: string
  featureTitle: string
  state: "active" | "suspended" | "revoked"
  grantVersion: number
  suspendReason: string | null
}

export interface BuiltinRobotRemoteAccessOverview {
  principalAvailable: boolean
  principalReason: string | null
  routeAvailable: boolean
  routeReason: string | null
  activeRoute: BuiltinRobotRouteStatus | null
  threadGrants: BuiltinRobotThreadGrantStatus[]
  featureGrants: BuiltinRobotFeatureGrantStatus[]
}

export interface BuiltinRobotGrantableFeature {
  projectId: string
  projectName: string
  featureSlug: string
  featureTitle: string
  featureStatus: string
  granted: boolean
}

export interface BuiltinRobotDiagnostics {
  appVersion: string
  gatewayUrl: string | null
  authenticationFailed: boolean
  lastHandshakeStatus: number | null
  lastCloseCode: number | null
  lastCloseReason: string | null
  lastTransportError: string | null
  reconnectAttempt: number
}

export interface BuiltinRobotStatus {
  settings: BuiltinRobotSettings
  connectionState: BuiltinRobotConnectionState
  identityState: BuiltinRobotIdentityState
  sessionId: string | null
  principalId: string | null
  lastConnectedAt: string | null
  lastError: string | null
  legacyConfigDetected: boolean
  routes: BuiltinRobotRouteStatus[]
  featureBindings: BuiltinRobotFeatureBindingStatus[]
  eventCounts: Record<string, number>
  pendingOutboxCount: number
  diagnostics: BuiltinRobotDiagnostics
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

/**
 * Bounded, display-only hook catalog used by the right panel. Runtime hook
 * resolution deliberately does not consume this projection: large values and
 * catalogs may be truncated here to keep renderer IPC and Electron's main
 * thread responsive without changing hook execution semantics.
 */
export interface HookCatalogPageInput {
  /** Latest-wins namespace scoped by the main process to the calling renderer. */
  requestScope: string
  workspacePath?: string
  /** Optional renderer token used only to fence stale UI results; main epochs own cache identity. */
  revision?: string
  /** Opaque continuation returned by the previous page. */
  cursor?: string
  /** Requested rows. Clamped to the catalog's hard page limit. */
  limit?: number
}

export interface HookCatalogPageStats {
  durationMs: number
  responseBytes: number
  /** True when this request reused the process-wide global skill/plugin snapshot. */
  globalScanReused: boolean
  /** True when this request reused its workspace-only hook overlay. */
  workspaceScanReused: boolean
  scannedDirectories: number
  scannedFiles: number
  discoveredSkills: number
  readBytes: number
}

/**
 * Counts produced while the hook worker is already discovering plugins and
 * skills. Keeping these beside the hook totals lets collapsed consumers render
 * all three badges without starting two more filesystem scans.
 */
export interface HookCatalogRelatedSummary {
  skillEntries: number
  enabledSkillEntries: number
  skillTruncated: boolean
  skillTruncatedReasons: string[]
  pluginEntries: number
  pluginTruncated: boolean
  pluginTruncatedReasons: string[]
}

export interface HookCatalogPage {
  globalHooks: HookConfig[]
  workspaceHooks: HookConfig[]
  pluginHooks: PluginHookMetadata[]
  skillHooks: SkillHookMetadata[]
  /** Opaque continuation for the same worker snapshot. */
  nextCursor?: string
  /** Total projected entries retained in this bounded snapshot. */
  totalEntries: number
  /** Enabled entries in the whole snapshot, independent of the current page. */
  enabledEntries: number
  /** Skill/plugin totals discovered by the same bounded filesystem pass. */
  relatedSummary: HookCatalogRelatedSummary
  /** True only when source data was omitted by a hard safety cap. */
  truncated: boolean
  truncatedReasons: string[]
  stats: HookCatalogPageStats
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
  /** For git_commit/git_push: preferred Git operation target (normally the repository root). */
  suggestedGitWorktreePath?: string
  /** For git_commit: concrete repository targets when the command cwd contains multiple repos. */
  suggestedGitRepositories?: Array<{
    path: string
    displayPath: string
    gitRoot: string
  }>
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
  autoResolutionMs?: number
  createdAt: string
}

export type UserInputAnswer =
  | {
      type: "option"
      questionId: string
      optionIndex: number
      label: string
      description: string
      additionalText?: string
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

export type SkillPluginCatalogKind = "skills" | "plugins" | "disabled"

export interface SkillPluginCatalogPageInput {
  kind: SkillPluginCatalogKind
  cursor?: string | null
  limit?: number
  /** Main-process-only legacy migration entries resolved by the disabled projection. */
  mergeDisabledSkillIds?: string[]
  /**
   * Renderer cache token used for latest-wins UI state. Worker snapshot
   * identity comes from the main-process source epoch so different windows can
   * safely share one scan even though their renderer tokens differ.
   */
  revision?: string
}

export interface SkillPluginCatalogPageStats {
  scannedDirectories: number
  scannedFiles: number
  discoveredSkills: number
  readBytes: number
}

export interface SkillPluginCatalogPage {
  kind: SkillPluginCatalogKind
  /** Opaque Worker snapshot identity; stable across every page of one scan. */
  sourceKey: string
  /** Skill/plugin topology epoch captured before the Worker scan. */
  catalogGlobalRevision: number
  /** Disabled-store epoch captured by the main process before the scan. */
  disabledSkillsRevision: number
  /** Exact disabled-store content identity for projections that read that store. */
  disabledStoreFingerprint?: string
  skills: SkillMetadata[]
  plugins: PluginMetadata[]
  disabledSkillIds: string[]
  cursor: string | null
  total: number
  /** Enabled skills in the whole skills snapshot; zero for plugin-only projections. */
  enabledSkillCount: number
  truncated: boolean
  truncatedReasons: string[]
  stats: SkillPluginCatalogPageStats
}
