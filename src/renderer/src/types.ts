// Re-export types from electron for use in renderer

import type {
  ForkableCheckpoint as SharedForkableCheckpoint,
  ThreadForkCheckpointForMessageParams as SharedThreadForkCheckpointForMessageParams,
  ThreadForkOverrides as SharedThreadForkOverrides,
  ThreadForkParams as SharedThreadForkParams,
  ThreadForkResponse as SharedThreadForkResponse
} from "../../shared/checkpoint-forkability"

export type { ForkBoundarySource, ForkUnstableReason } from "../../shared/checkpoint-forkability"

export interface FileAttachment {
  filename: string
  filePath: string // full path for display
  content: string // extracted text content
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

export type ThreadForkOverrides = SharedThreadForkOverrides
export type ThreadForkParams = SharedThreadForkParams
export type ThreadForkResponse = SharedThreadForkResponse<Thread>
export type ThreadForkCheckpointForMessageParams = SharedThreadForkCheckpointForMessageParams
export type ForkableCheckpoint = SharedForkableCheckpoint

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

import type {
  McpConnectorAdvanced,
  McpConnectorConfig,
  McpConnectorUpsert,
  McpImportApplyResult,
  McpImportConfigApplyRequest,
  McpImportConfigRequest,
  McpImportConflictStrategy,
  McpImportPreviewResult,
  Subagent,
  ScheduledTask,
  ScheduledTaskUpsert,
  ScheduledTaskFrequency,
  ScheduledTaskType,
  HeartbeatConfig,
  PluginMetadata,
  PluginManifest,
  ChatXConfig,
  ChatXRobotConfig,
  LspConfig,
  LspDiagnostic,
  LspLocation,
  LspHoverResult,
  LspSymbol,
  LspCallHierarchyItem,
  LspCallHierarchyIncomingCall,
  LspCallHierarchyOutgoingCall,
  LspStatus,
  UserInputRequest,
  UserInputResponse,
  UserInputAnswer
} from "../../main/types"
import type {
  AgentAutoCommitMessageStrategy,
  AgentAutoCommitMode,
  AgentAutoCommitResult,
  AgentAutoCommitSettings,
  AgentAutoCommitWorkspaceCard
} from "../../shared/auto-commit-types"
import type {
  ManagedSavedCodeExecTool,
  SavedCodeExecPreviewResult,
  SavedCodeExecToolUpdatePayload
} from "../../main/ipc/code-exec-tools"
import type {
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchItem,
  HarnessEnterpriseProjectSearchResult,
  HarnessArtifact,
  HarnessArtifactStatus,
  HarnessArtifactType,
  HarnessEventStatus,
  HarnessFeatureStatus,
  HarnessHookLogView,
  HarnessNodeStatus,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessKnowledgePreviewFile,
  HarnessKnowledgePreviewResult,
  HarnessProjectReviewInput,
  HarnessProjectReviewItem,
  HarnessProjectReviewResult,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessFeatureDeployUnitBinding,
  HarnessDynamicWorkflowConfig,
  HarnessDynamicWorkflowNode,
  HarnessDynamicWorkflowTemplate,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessDeployUnitMapping,
  HarnessLeanTokenConfig,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessRunNode,
  HarnessFeatureSummary,
  HarnessSessionBinding,
  HarnessAdapterRegistryItem,
  HarnessBoardCompatibility,
  HarnessStatus,
  HarnessWatchRefChangedEvent,
  HarnessWorkflowNextAction,
  HarnessWorkflow
} from "../../shared/harness-board-types"

export type {
  McpConnectorAdvanced,
  McpConnectorConfig,
  McpConnectorUpsert,
  McpImportApplyResult,
  McpImportConfigApplyRequest,
  McpImportConfigRequest,
  McpImportConflictStrategy,
  McpImportPreviewResult,
  Subagent,
  ScheduledTask,
  ScheduledTaskUpsert,
  ScheduledTaskFrequency,
  ScheduledTaskType,
  HeartbeatConfig,
  PluginMetadata,
  PluginManifest,
  ChatXConfig,
  ChatXRobotConfig,
  LspConfig,
  LspDiagnostic,
  LspLocation,
  LspHoverResult,
  LspSymbol,
  LspCallHierarchyItem,
  LspCallHierarchyIncomingCall,
  LspCallHierarchyOutgoingCall,
  LspStatus,
  UserInputRequest,
  UserInputResponse,
  UserInputAnswer,
  AgentAutoCommitMode,
  AgentAutoCommitMessageStrategy,
  AgentAutoCommitSettings,
  AgentAutoCommitWorkspaceCard,
  AgentAutoCommitResult
}

export type { ManagedSavedCodeExecTool, SavedCodeExecPreviewResult, SavedCodeExecToolUpdatePayload }

export type {
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchItem,
  HarnessEnterpriseProjectSearchResult,
  HarnessArtifact,
  HarnessArtifactStatus,
  HarnessArtifactType,
  HarnessEventStatus,
  HarnessFeatureStatus,
  HarnessHookLogView,
  HarnessNodeStatus,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessKnowledgePreviewFile,
  HarnessKnowledgePreviewResult,
  HarnessProjectReviewInput,
  HarnessProjectReviewItem,
  HarnessProjectReviewResult,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessDynamicWorkflowConfig,
  HarnessDynamicWorkflowNode,
  HarnessDynamicWorkflowTemplate,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessFeatureDeployUnitBinding,
  HarnessDeployUnitMapping,
  HarnessLeanTokenConfig,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessRunNode,
  HarnessFeatureSummary,
  HarnessSessionBinding,
  HarnessAdapterRegistryItem,
  HarnessBoardCompatibility,
  HarnessStatus,
  HarnessWatchRefChangedEvent,
  HarnessWorkflowNextAction,
  HarnessWorkflow
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
  | { type: "error"; error: string; message?: string }

export interface Message {
  id: string
  provider_source_id?: string
  provider_occurrence?: number
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentBlock[]
  content_priority?: number
  reasoning?: string
  tool_calls?: ToolCall[]
  // For tool messages - links result to its tool call
  tool_call_id?: string
  // For tool messages - the name of the tool
  name?: string
  // For tool messages - provider/tool execution status
  status?: string
  // For tool messages - whether the tool call failed
  is_error?: boolean
  created_at: Date
  start_at?: Date
  end_at?: Date
  goal_id?: string | null
  active_window_id?: string | null
}

/**
 * A user message parked in the per-thread draft queue while a run is active or a
 * tool approval is pending. It carries the fully-composed payload so it can be
 * sent verbatim once the run ends (auto-drain) or steered into the running turn:
 *   - `text`                    the raw user text (what the edit box shows)
 *   - `attachmentModelBlocks`   <attachment>…</attachment> XML appended for the model
 *   - `attachmentDisplayPrefix` "📎 name" lines shown in the user's bubble
 *   - `skillBlock`              trailing slash-command skill block, if any
 *   - `modelId`                 model selected when the draft was composed
 *   - `handoffRequestedAt`      set once the message has been steered into the
 *                               current run (awaiting injection); cleared on run end
 */
export interface QueuedMessage {
  id: string
  text: string
  attachmentModelBlocks?: string
  attachmentDisplayPrefix?: string
  skillBlock?: string
  modelId?: string
  handoffRequestedAt?: Date
  created_at: Date
  updated_at: Date
}

export interface GoalEvent {
  event_id: number
  thread_id: string
  goal_id: string | null
  active_window_id?: string | null
  message: string
  created_at: Date | string | number
}

export interface GoalSnapshot {
  threadId: string
  goalId: string
  activeWindowId: string
  objective: string
  completionCondition: string
  context: {
    explicitSkill?: { name: string; path: string }
    transportSummary?: string
  }
  status: "active" | "paused" | "complete"
  turnsUsed: number
  maxTurns: number
  lastVerdict: string | null
  lastReason: string | null
  pausedReason: string | null
  consecutiveParseFailures: number
  ledger: {
    progress: string[]
    evidence: string[]
    blockers: string[]
  }
  createdAt: number
  updatedAt: number
}

export interface GoalUiState {
  goal: GoalSnapshot | null
  events: GoalEvent[]
  lastUpdated: Date | null
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

export type ToolCallStatus =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "rejected"

export interface ToolCallState {
  id: string
  status: ToolCallStatus
  name?: string
  args?: Record<string, unknown>
  command?: string
  filePath?: string
  reason?: string
  operation?: string
  code?: string
  timeoutMs?: number
  updatedAt: Date
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
  allowRuntimeRestoredCheckpointResume?: boolean
  operation?: string
  command?: string
  reason?: string
  suggestedCommitMessage?: string
  suggestedCommitFilePaths?: string[]
  suggestedCommitFileBasePath?: string
  suggestedCommitFileSelectionSource?: "pathspec" | "staged"
}

export interface HITLDecision {
  type: "approve" | "reject" | "edit"
  tool_call_id: string
  edited_args?: Record<string, unknown>
  feedback?: string
  allowRuntimeRestoredCheckpointResume?: boolean
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
export type {
  HookConfig,
  HookEvent,
  HookType,
  PromptHookFallback,
  HookUpsert,
  HookInjectUserContext,
  HookUserContextField
} from "../../main/hooks/types"
