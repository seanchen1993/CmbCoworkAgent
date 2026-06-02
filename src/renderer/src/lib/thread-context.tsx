import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
  type ReactNode
} from "react"

/* eslint-disable react-refresh/only-export-components */
import { useStream } from "@langchain/langgraph-sdk/react"
import { ElectronIPCTransport, type StreamFallbackIndexBaselines } from "./electron-transport"
import { isCoordinatorModeMetadata, isExplicitNormalModeMetadata } from "./coordinator-mode-helpers"
import {
  coordinatorWorkersEqual,
  mergeCoordinatorWorkers,
  upsertSubagentLogEntry,
  type CoordinatorWorkerView,
  type SubagentInternalLogEntry
} from "./thread-state-helpers"

export type { CoordinatorWorkerView, SubagentInternalLogEntry } from "./thread-state-helpers"
import type {
  Message,
  Todo,
  FileInfo,
  Subagent,
  HITLRequest,
  ToolCallState,
  SkillMetadata,
  AgentAutoCommitResult,
  UserInputRequest,
  GoalUiState,
  GoalEvent
} from "@/types"
import { useAppStore } from "@/lib/store"
import type { DeepAgent } from "../../../main/agent/types"
import { toast } from "sonner"
import { formatAutoCommitText } from "../../../shared/auto-commit-format"
import {
  isInternalGoalPromptMessage,
  shouldSuppressCheckpointApprovalRestore,
  type GoalNoticeEvent
} from "./goal-notice-messages"
import {
  buildRestoredCheckpointTranscript,
  formatGoalEventMessage,
  goalNoticeEventsToGoalUiEvents,
  isVisibleCheckpointTranscriptMessage
} from "./goal-transcript"
import { mergeGoalUiEvents } from "./goal-ui-events"
import {
  restoreRawCheckpointMessageTime,
  restoreVisibleCheckpointMessageTimes
} from "./checkpoint-message-times"
import { mergeLiveStreamMessages, type LiveStreamMessage } from "./live-stream-messages"
import { buildSyntheticCheckpointBaselineIds } from "./stream-message-ids"
import {
  liveStreamMessageToStoreMessage,
  resolveLiveStreamMessageEndAt,
  shouldSkipLiveStreamAccumulatorMessage
} from "./live-stream-transcript"
import { disableChatReportUploadForThread } from "./chat-report-upload-cache"

const MESSAGE_TIMES_THREAD_VALUE_KEY = "messageTimes"
const MESSAGE_TIME_ORDER_THREAD_VALUE_KEY = "messageTimeOrder"
const INTERNAL_GOAL_MESSAGE_TIMES_THREAD_VALUE_KEY = "internalGoalMessageTimes"
const INTERNAL_GOAL_MESSAGE_TIME_ORDER_THREAD_VALUE_KEY = "internalGoalMessageTimeOrder"

type MessageTimeMap = Record<string, { start_at?: string; end_at?: string }>
type MessageTimeEntry = MessageTimeMap[string] & { id: string }
type LiveMessageTimeMap = Record<string, { start_at: Date; end_at?: Date }>

type LiveStreamAccumulator = {
  active: boolean
  baselineIds: Set<string>
  messages: LiveStreamMessage[]
  messageTimes: LiveMessageTimeMap
  lastStartedAtMs?: number
  pendingGoalSubturnMessages: LiveStreamMessage[][]
}

type StreamUpdateOptions = {
  ignoreHistoryLoading?: boolean
  preserveExistingBaseline?: boolean
  finalizeCachedSnapshot?: boolean
}

type StableFallbackType = "ai" | "tool" | "system" | "human"

const isMessageTimeMap = (value: unknown): value is MessageTimeMap => {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stableFallbackTypeForMessage(message: Message): StableFallbackType {
  if (message.role === "tool") return "tool"
  if (message.role === "system") return "system"
  if (message.role === "user") return "human"
  return "ai"
}

function stableClassNameForFallbackType(type: StableFallbackType): string {
  if (type === "tool") return "ToolMessage"
  if (type === "system") return "SystemMessage"
  if (type === "human") return "HumanMessage"
  return "AIMessage"
}

function isSyntheticCheckpointMessageId(messageId: string): boolean {
  return /^msg-\d+$/.test(messageId)
}

function hasMessageId(message: { id?: string | null }): message is { id: string } {
  return typeof message.id === "string" && message.id.length > 0
}

function fallbackIndexBaselinesFromMessages(messages: Message[]): StreamFallbackIndexBaselines {
  const baselines: StreamFallbackIndexBaselines = { ai: 0, tool: 0, system: 0, human: 0 }
  for (const message of messages) {
    if (message.role === "user") {
      if (isInternalGoalPromptMessage(message)) baselines.human += 1
      continue
    }
    if (message.role === "tool") {
      baselines.tool += 1
      continue
    }
    if (message.role === "system") {
      baselines.system += 1
      continue
    }
    baselines.ai += 1
  }
  return baselines
}

function mergeFallbackIndexBaselines(
  left: StreamFallbackIndexBaselines | undefined,
  right: StreamFallbackIndexBaselines
): StreamFallbackIndexBaselines {
  if (!left) return right
  return {
    ai: Math.max(left.ai, right.ai),
    tool: Math.max(left.tool, right.tool),
    system: Math.max(left.system, right.system),
    human: Math.max(left.human, right.human)
  }
}

const isMessageTimeEntryArray = (value: unknown): value is MessageTimeEntry[] => {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
    )
  )
}

const getMessageTimeMap = (threadValues?: Record<string, unknown>): MessageTimeMap => {
  const value = threadValues?.[MESSAGE_TIMES_THREAD_VALUE_KEY]
  return isMessageTimeMap(value) ? value : {}
}

const getInternalGoalMessageTimeMap = (threadValues?: Record<string, unknown>): MessageTimeMap => {
  const value = threadValues?.[INTERNAL_GOAL_MESSAGE_TIMES_THREAD_VALUE_KEY]
  return isMessageTimeMap(value) ? value : {}
}

const getInternalGoalMessageTimeOrder = (
  threadValues?: Record<string, unknown>
): MessageTimeEntry[] => {
  const value = threadValues?.[INTERNAL_GOAL_MESSAGE_TIME_ORDER_THREAD_VALUE_KEY]
  if (isMessageTimeEntryArray(value)) return value
  return Object.entries(getInternalGoalMessageTimeMap(threadValues)).map(([id, time]) => ({
    id,
    ...time
  }))
}

const getMessageTimeOrder = (threadValues?: Record<string, unknown>): MessageTimeEntry[] => {
  const value = threadValues?.[MESSAGE_TIME_ORDER_THREAD_VALUE_KEY]
  if (isMessageTimeEntryArray(value)) return value
  return Object.entries(getMessageTimeMap(threadValues)).map(([id, time]) => ({ id, ...time }))
}

const messageTimeOrderEntries = (updates: MessageTimeMap): MessageTimeEntry[] => {
  return Object.entries(updates).map(([id, time]) => ({ id, ...time }))
}

const toDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

const latestDate = (dates: Array<Date | undefined>): Date | undefined => {
  return dates.reduce<Date | undefined>((latest, date) => {
    if (!date) return latest
    if (!latest || date > latest) return date
    return latest
  }, undefined)
}

const getLatestTrustedCheckpointMessageAt = (
  visibleMessages: Message[],
  persistedMessageTimes: MessageTimeMap,
  persistedMessageTimeOrder: MessageTimeEntry[],
  persistedInternalGoalMessageTimes: MessageTimeMap,
  persistedInternalGoalMessageTimeOrder: MessageTimeEntry[],
  rawMessages: Message[] = visibleMessages
): Date | undefined => {
  const idTimes = rawMessages.flatMap((message) => [
    toDate(persistedMessageTimes[message.id]?.start_at),
    toDate(persistedInternalGoalMessageTimes[message.id]?.start_at)
  ])
  const rawInternalGoalMessages = rawMessages.filter(isInternalGoalPromptMessage)
  const latestInternalGoalOrderTime = latestDate(
    rawInternalGoalMessages.map((_, index) =>
      toDate(persistedInternalGoalMessageTimeOrder[index]?.start_at)
    )
  )
  const latestExactOrInternalGoalTime = latestDate([
    latestDate(idTimes),
    latestInternalGoalOrderTime
  ])
  if (latestExactOrInternalGoalTime) return latestExactOrInternalGoalTime

  // Match restoreVisibleCheckpointMessageTimes(): if checkpoint message ids changed across
  // serialization, use the post-normalization visible-message index as the only
  // trusted fallback. Never use the synthetic "now" fallback for approval restore
  // gating, or old checkpoints would look newer than a runtime-restore pause.
  return latestDate(
    visibleMessages.map((_, index) => toDate(persistedMessageTimeOrder[index]?.start_at))
  )
}

// Open file tab type
export interface OpenFile {
  path: string
  name: string
}

// Token usage tracking for context window monitoring
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  lastUpdated: Date
}

// Routing result from auto-routing engine
export interface RoutingResultState {
  resolvedModelId: string
  resolvedTier: "premium" | "economy"
  routeReason: string
}

// Model retry indicator — shown inline in chat while the fetch layer is
// retrying a transient model error. Cleared when the retry resolves.
export interface ModelRetryState {
  attempt: number
  maxRetries: number
  reason: string
  delayMs: number
  startedAt: Date
}

export interface HookLogEntry {
  id: string
  /** "executed" = ran to completion; "skipped" = matched event but scope-filtered. */
  kind: "executed" | "skipped"
  event: string
  hookType: string
  label: string
  command?: string
  toolSuffix: string
  pluginId?: string
  pluginName?: string
  skillName?: string
  skillPath?: string
  hookSourcePath?: string
  cwd?: string
  durationMs?: number
  exitCode: number | null
  blocked: boolean
  continue?: boolean
  stopReason?: string
  decision?: string
  reason?: string
  stdout: string
  stderr: string
  additionalContext?: string
  systemMessage?: string
  stdinPayload?: string
  skipReason?: string
  timestamp: Date
  turnId?: string
}

/**
 * Per-turn bucket of hook log entries.
 *
 * `turnId` is the id of the user message that opened the turn — used as the
 * grouping key so historical turns can still be looked up after subsequent
 * user messages arrive. Without this we'd lose old turns the moment a new
 * user message landed (the original behavior, which made post-mortem
 * debugging impossible).
 */
export interface HookLogBucket {
  turnId: string
  /** First user message text preview — shown in the modal title. */
  turnPreview: string
  /**
   * True when this bucket was opened by an early hook event (or the
   * background sentinel) and is still waiting for the real user message to
   * arrive. `openHookLogBucket` upgrades placeholders in place; we use this
   * flag (not a `turnPreview.startsWith("(")` heuristic) so users whose own
   * messages happen to start with `(` aren't misclassified.
   */
  isPlaceholder?: boolean
  startedAt: Date
  entries: HookLogEntry[]
}

/** Max per-thread retention of historical turn buckets, in-memory. */
const HOOK_LOG_BUCKET_RING_SIZE = 10

export interface HookInterruptionState {
  event: string
  action: "block" | "halt"
  reason: string
  systemMessage?: string
  timestamp: Date
}

export interface ThreadGitContext {
  isGitRepo?: boolean
  isWorktree?: boolean
  branch?: string | null
}

export interface TurnTiming {
  duration: number
  thread_id: string
  user_id: string
  sendTime?: number
}

interface SetTurnTimingsOptions {
  persist?: boolean
}

const TURN_TIMINGS_THREAD_VALUE_KEY = "turnTimings"

const isTurnTiming = (value: unknown): value is TurnTiming => {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { duration?: unknown }).duration === "number" &&
    Number.isFinite((value as { duration?: number }).duration) &&
    typeof (value as { thread_id?: unknown }).thread_id === "string" &&
    typeof (value as { user_id?: unknown }).user_id === "string" &&
    ((value as { sendTime?: unknown }).sendTime === undefined ||
      (typeof (value as { sendTime?: unknown }).sendTime === "number" &&
        Number.isFinite((value as { sendTime?: number }).sendTime)))
  )
}

const getTurnTimings = (threadValues?: Record<string, unknown>): TurnTiming[] => {
  const value = threadValues?.[TURN_TIMINGS_THREAD_VALUE_KEY]
  return Array.isArray(value) ? value.filter(isTurnTiming) : []
}

// Per-thread state (persisted/restored from checkpoints)
export interface ThreadState {
  messages: Message[]
  turnTimings: TurnTiming[]
  goalUi: GoalUiState
  todos: Todo[]
  workspaceFiles: FileInfo[]
  workspacePath: string | null
  gitContext: ThreadGitContext | null
  subagents: Subagent[]
  coordinatorWorkers: CoordinatorWorkerView[]
  subagentToolCallCount: number
  subagentInternalLogs: SubagentInternalLogEntry[]
  toolCallStates: Record<string, ToolCallState>
  pendingApprovals: HITLRequest[]
  pendingApproval: HITLRequest | null
  approvalQueue: HITLRequest[]
  pendingUserInput: UserInputRequest | null
  error: string | null
  hookInterruption: HookInterruptionState | null
  currentModel: string
  openFiles: OpenFile[]
  activeTab: "agent" | string
  fileContents: Record<string, string>
  tokenUsage: TokenUsage | null
  draftInput: string
  /**
   * Skill chip the user has selected for the next send. Kept alongside
   * draftInput so the chip survives view switches (chat → customize → back),
   * matching how draftInput already behaves.
   */
  draftSkill: SkillMetadata | null
  scheduledTaskLoading: boolean
  historyLoading: boolean
  scheduledTaskId: string | null
  routingResult: RoutingResultState | null
  modelRetry: ModelRetryState | null
}

function debugMessageContentLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0

  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
}

function debugMessagesTextLength(messages: Message[] | undefined): number {
  if (!Array.isArray(messages)) return 0
  return messages.reduce((total, message) => total + debugMessageContentLength(message.content), 0)
}

function debugRuntimeMessagesLength(messages: StreamData["messages"] | undefined): number {
  if (!Array.isArray(messages)) return 0
  return messages.reduce((total, message) => {
    const content = (message as { content?: Message["content"] }).content
    return total + debugMessageContentLength(content)
  }, 0)
}

type CmbMemoryDebugWindow = Window & {
  __cmbCoworkMemorySnapshot?: () => unknown
}

// Stream instance type
type StreamInstance = ReturnType<typeof useStream<DeepAgent>>

// Stream data that we want to be reactive
interface StreamData {
  messages: StreamInstance["messages"]
  liveMessages: LiveStreamMessage[]
  isLoading: boolean
  stream: StreamInstance | null
}

// Actions available on a thread
export interface ThreadActions {
  appendMessage: (message: Message) => void
  setMessages: (messages: Message[]) => void
  setTurnTimings: (turnTimings: TurnTiming[], options?: SetTurnTimingsOptions) => void
  setGoalUi: (goalUi: GoalUiState) => void
  refreshGoalUi: (options?: { includeEvents?: boolean }) => Promise<void>
  setTodos: (todos: Todo[]) => void
  setWorkspaceFiles: (files: FileInfo[] | ((prev: FileInfo[]) => FileInfo[])) => void
  setWorkspacePath: (path: string | null) => void
  setGitContext: (context: ThreadGitContext | null) => void
  setSubagents: (subagents: Subagent[]) => void
  setToolCallState: (toolCallId: string, updates: Partial<ToolCallState>) => void
  setPendingApproval: (request: HITLRequest | null) => void
  clearPendingApprovals: () => void
  enqueuePendingApproval: (request: HITLRequest) => void
  removePendingApproval: (requestId?: string) => void
  setPendingUserInput: (request: UserInputRequest | null) => void
  setError: (error: string | null) => void
  clearError: () => void
  clearHookInterruption: () => void
  setCurrentModel: (modelId: string) => void
  openFile: (path: string, name: string) => void
  closeFile: (path: string) => void
  setActiveTab: (tab: "agent" | string) => void
  setFileContents: (path: string, content: string) => void
  setDraftInput: (input: string) => void
  setDraftSkill: (skill: SkillMetadata | null) => void
}

// Context value
interface ThreadContextValue {
  getThreadState: (threadId: string) => ThreadState
  getThreadActions: (threadId: string) => ThreadActions
  initializeThread: (threadId: string) => void
  cleanupThread: (threadId: string) => void
  // Stream subscription
  subscribeToStream: (threadId: string, callback: () => void) => () => void
  getStreamData: (threadId: string) => StreamData
  // Hook log subscription (external store — no re-renders on ThreadProvider).
  // Returns the per-turn buckets in chronological order; the most recent
  // bucket is the current turn. Capped at HOOK_LOG_BUCKET_RING_SIZE buckets
  // per thread to bound memory.
  subscribeToHookLogs: (threadId: string, callback: () => void) => () => void
  getHookLogBuckets: (threadId: string) => HookLogBucket[]
  // Get all initialized thread states (for kanban view)
  getAllThreadStates: () => Record<string, ThreadState>
  // Get all stream loading states (for kanban view)
  getAllStreamLoadingStates: () => Record<string, boolean>
  // Subscribe to all stream updates
  subscribeToAllStreams: (callback: () => void) => () => void
  suppressCoordinatorNotificationAutoRun: (threadId: string) => void
}

// Default thread state
const createDefaultThreadState = (): ThreadState => ({
  messages: [],
  turnTimings: [],
  goalUi: { goal: null, events: [], lastUpdated: null },
  todos: [],
  workspaceFiles: [],
  workspacePath: null,
  gitContext: null,
  subagents: [],
  coordinatorWorkers: [],
  subagentToolCallCount: 0,
  subagentInternalLogs: [],
  toolCallStates: {},
  pendingApprovals: [],
  pendingApproval: null,
  approvalQueue: [],
  pendingUserInput: null,
  error: null,
  hookInterruption: null,
  currentModel: "",
  openFiles: [],
  activeTab: "agent",
  fileContents: {},
  tokenUsage: null,
  draftInput: "",
  draftSkill: null,
  scheduledTaskLoading: false,
  historyLoading: false,
  scheduledTaskId: null,
  routingResult: null,
  modelRetry: null
})

function isThreadMetadataInCoordinatorMode(threadId: string): boolean {
  const thread = useAppStore.getState().threads.find((item) => item.thread_id === threadId)
  return isCoordinatorModeMetadata(thread?.metadata)
}

function isThreadMetadataExplicitNormalMode(threadId: string): boolean {
  const thread = useAppStore.getState().threads.find((item) => item.thread_id === threadId)
  return isExplicitNormalModeMetadata(thread?.metadata)
}

/**
 * 从持久化的 thread metadata 中提取 renderer 可直接消费的 Git context。
 *
 * metadata 是数据库里的存储格式，里面既可能有新版 `gitContext` 对象，也可能有旧版
 * `cached*` 顶层字段。ThreadState 则是 UI 运行时状态，只需要知道：
 * - 是否是 Git 仓库；
 * - 是否是 worktree；
 * - 当前 worktree 分支名。
 *
 * 这个函数负责把存储格式归一化成 `ThreadGitContext`，让 GitPanel 首屏可以先展示已有
 * repo/worktree/branch 信息，而不必等一次 GitPanel meta IPC 返回。
 */
function getGitContextFromMetadata(metadata: Record<string, unknown>): ThreadGitContext | null {
  const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  // 新版结构：Git 探测结果统一收敛在 metadata.gitContext。
  const gitContext =
    metadata.gitContext &&
    typeof metadata.gitContext === "object" &&
    !Array.isArray(metadata.gitContext)
      ? (metadata.gitContext as Record<string, unknown>)
      : null
  const contextMatchesWorkspace = Boolean(
    workspacePath &&
    typeof gitContext?.workspacePath === "string" &&
    gitContext.workspacePath === workspacePath
  )
  const metadataMarkedWorktree = Boolean(metadata.isWorktree)

  if (contextMatchesWorkspace && gitContext) {
    // 如果 isGitRepo 缺失，但 gitRoot 存在，也可以推断当前 workspace 是 Git 仓库。
    const isGitRepo =
      typeof gitContext.isGitRepo === "boolean"
        ? gitContext.isGitRepo
        : typeof gitContext.gitRoot === "string" && gitContext.gitRoot
          ? true
          : metadataMarkedWorktree
            ? true
            : undefined
    const isWorktree =
      metadataMarkedWorktree ||
      (typeof gitContext.isWorktreePath === "boolean" ? gitContext.isWorktreePath : undefined)
    const branch = typeof metadata.worktreeBranch === "string" ? metadata.worktreeBranch : null

    if (isGitRepo === undefined && isWorktree === undefined && !branch) return null
    return { isGitRepo, isWorktree, branch }
  }

  // 兼容旧 metadata：新写入都会使用 metadata.gitContext 对象。
  const cachedWorkspacePath =
    typeof metadata.cachedGitContextWorkspacePath === "string"
      ? metadata.cachedGitContextWorkspacePath
      : null
  const cachedMatchesWorkspace = Boolean(
    workspacePath && cachedWorkspacePath && cachedWorkspacePath === workspacePath
  )
  const cachedIsGitRepo =
    cachedMatchesWorkspace && typeof metadata.cachedIsGitRepo === "boolean"
      ? metadata.cachedIsGitRepo
      : undefined
  const cachedIsWorktree =
    cachedMatchesWorkspace && typeof metadata.cachedIsWorktreePath === "boolean"
      ? metadata.cachedIsWorktreePath
      : undefined
  const cachedGitRoot =
    cachedMatchesWorkspace && typeof metadata.cachedGitRoot === "string" && metadata.cachedGitRoot
      ? metadata.cachedGitRoot
      : null
  const branch = typeof metadata.worktreeBranch === "string" ? metadata.worktreeBranch : null
  const isGitRepo =
    cachedIsGitRepo ?? (cachedGitRoot ? true : metadataMarkedWorktree ? true : undefined)
  const isWorktree = metadataMarkedWorktree || cachedIsWorktree

  if (isGitRepo === undefined && isWorktree === undefined && !branch) return null
  return { isGitRepo, isWorktree, branch }
}

const defaultStreamData: StreamData = {
  messages: [],
  liveMessages: [],
  isLoading: false,
  stream: null
}
const EMPTY_HOOK_LOG_BUCKETS: HookLogBucket[] = []
const COORDINATOR_NOTIFICATION_RETRY_MS = 1_000
const COORDINATOR_NOTIFICATION_MAX_RETRIES = 30
const COORDINATOR_NOTIFICATION_SUPPRESS_MS = 15_000

function isTerminalCoordinatorWorker(worker: CoordinatorWorkerView): boolean {
  return (
    worker.status === "completed" || worker.status === "failed" || worker.status === "cancelled"
  )
}

function getPendingApprovalId(request: HITLRequest): string {
  const approval = request as unknown as Record<string, unknown>
  const orchestratorRequestId = approval._orchestratorRequestId
  if (typeof orchestratorRequestId === "string" && orchestratorRequestId.trim()) {
    return orchestratorRequestId
  }
  return request.id
}

function getPendingApprovalOperation(request: HITLRequest | null | undefined): string | null {
  const approval = request as unknown as Record<string, unknown> | null | undefined
  const operation = approval?.operation
  return typeof operation === "string" ? operation : null
}

function approvalOperation(request: HITLRequest | null | undefined): string | null {
  return getPendingApprovalOperation(request)
}

function buildPendingApprovalState(
  queue: HITLRequest[]
): Pick<ThreadState, "pendingApprovals" | "pendingApproval" | "approvalQueue"> {
  return {
    pendingApprovals: queue,
    pendingApproval: queue[0] ?? null,
    approvalQueue: queue.slice(1)
  }
}

function enqueuePendingApproval(queue: HITLRequest[], request: HITLRequest): HITLRequest[] {
  const requestId = getPendingApprovalId(request)
  const nextQueue = queue.filter((item) => getPendingApprovalId(item) !== requestId)
  const state = buildPendingApprovalState(nextQueue)
  if (
    nextQueue.length === 1 &&
    approvalOperation(state.pendingApproval) === "prepare_save_code_exec_tool" &&
    approvalOperation(request) === "save_code_exec_tool"
  ) {
    return [request]
  }
  nextQueue.push(request)
  return nextQueue
}

function removePendingApproval(queue: HITLRequest[], requestId?: string): HITLRequest[] {
  if (queue.length === 0) return queue
  if (!requestId) return queue.slice(1)
  return queue.filter((item) => getPendingApprovalId(item) !== requestId)
}

function advancePendingApproval(queue: HITLRequest[], requestId?: string): HITLRequest[] {
  return removePendingApproval(queue, requestId)
}

function removePendingApprovalByRequestId(
  state: ThreadState,
  requestId?: string
): Pick<ThreadState, "pendingApprovals" | "pendingApproval" | "approvalQueue"> {
  return buildPendingApprovalState(advancePendingApproval(state.pendingApprovals, requestId))
}

function normalizeApprovalPayload(request: unknown): HITLRequest & Record<string, unknown> {
  const req = request as Record<string, unknown>
  return {
    id: (req.id as string) || "",
    tool_call: (req.tool_call as { id: string; name: string; args: Record<string, unknown> }) || {
      id: "",
      name: "execute",
      args: {}
    },
    allowed_decisions: ["approve", "reject"],
    command: req.command,
    reason: req.reason,
    operation: req.operation,
    filePath: req.filePath,
    code: req.code,
    params: req.params,
    timeoutMs: req.timeoutMs,
    savedToolName: req.savedToolName,
    savedToolId: req.savedToolId,
    savedToolDescription: req.savedToolDescription,
    savedToolMetadataError: req.savedToolMetadataError,
    _orchestratorRequestId: req.id,
    _retryReason: req.retry_reason,
    _approvalTypes: req.allowed_approval_types
  } as HITLRequest & Record<string, unknown>
}

function normalizeThreadState(state: ThreadState): ThreadState {
  const pendingQueue = Array.isArray(state.pendingApprovals)
    ? state.pendingApprovals
    : state.pendingApproval
      ? [state.pendingApproval]
      : []
  return {
    ...state,
    toolCallStates: state.toolCallStates || {},
    ...buildPendingApprovalState(pendingQueue)
  }
}

function mergeToolCallArgs(
  existingArgs?: Record<string, unknown>,
  incomingArgs?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!existingArgs && !incomingArgs) return undefined
  return {
    ...(existingArgs || {}),
    ...(incomingArgs || {})
  }
}

function upsertToolCallState(
  states: Record<string, ToolCallState>,
  toolCallId: string | undefined,
  updates: Partial<ToolCallState>
): Record<string, ToolCallState> {
  if (!toolCallId?.trim()) return states
  const existing = states[toolCallId]
  return {
    ...states,
    [toolCallId]: {
      id: toolCallId,
      status: updates.status || existing?.status || "queued",
      name: updates.name ?? existing?.name,
      args: mergeToolCallArgs(existing?.args, updates.args),
      command: updates.command ?? existing?.command,
      filePath: updates.filePath ?? existing?.filePath,
      reason: updates.reason ?? existing?.reason,
      operation: updates.operation ?? existing?.operation,
      code: updates.code ?? existing?.code,
      timeoutMs: updates.timeoutMs ?? existing?.timeoutMs,
      updatedAt: new Date()
    }
  }
}

function upsertToolCallStateFromRequest(
  states: Record<string, ToolCallState>,
  request: HITLRequest & Record<string, unknown>,
  status: ToolCallState["status"] = "awaiting_approval"
): Record<string, ToolCallState> {
  const toolCall = request.tool_call
  if (!toolCall?.id) return states

  const mergedArgs: Record<string, unknown> = {
    ...(toolCall.args || {})
  }
  if (typeof request.command === "string" && !mergedArgs.command) {
    mergedArgs.command = request.command
  }
  if (typeof request.filePath === "string") {
    if (!mergedArgs.path) mergedArgs.path = request.filePath
    if (!mergedArgs.file_path) mergedArgs.file_path = request.filePath
  }
  if (typeof request.code === "string" && mergedArgs.code === undefined) {
    mergedArgs.code = request.code
  }
  if (request.params !== undefined && mergedArgs.params === undefined) {
    mergedArgs.params = request.params
  }
  if (typeof request.timeoutMs === "number" && mergedArgs.timeoutMs === undefined) {
    mergedArgs.timeoutMs = request.timeoutMs
  }

  return upsertToolCallState(states, toolCall.id, {
    status,
    name: toolCall.name,
    args: mergedArgs,
    command: typeof request.command === "string" ? request.command : undefined,
    filePath: typeof request.filePath === "string" ? request.filePath : undefined,
    reason: typeof request.reason === "string" ? request.reason : undefined,
    operation: typeof request.operation === "string" ? request.operation : undefined,
    code: typeof request.code === "string" ? request.code : undefined,
    timeoutMs: typeof request.timeoutMs === "number" ? request.timeoutMs : undefined
  })
}

const ThreadContext = createContext<ThreadContextValue | null>(null)

// Custom event types from the stream
interface CustomEventData {
  type?: string
  request?: HITLRequest
  files?: Array<{ path: string; is_dir?: boolean; size?: number }>
  path?: string
  subagents?: Array<{
    id?: string
    toolCallId?: string
    name?: string
    description?: string
    status?: string
    startedAt?: Date
    completedAt?: Date
    subagentType?: string
  }>
  workers?: CoordinatorWorkerView[]
  worker?: CoordinatorWorkerView
  workerThreadId?: string
  workerMessage?: Message
  notification?: string
  suppressNotificationAutoRun?: boolean
  mode?: "normal" | "coordinator"
  source?: string
  persisted?: boolean
  count?: number
  entry?: SubagentInternalLogEntry
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  // routing result fields
  resolvedModelId?: string
  resolvedTier?: "premium" | "economy"
  routeReason?: string
  // model_retry fields
  attempt?: number
  maxRetries?: number
  reason?: string
  message?: string
  goalId?: string | null
  activeWindowId?: string | null
  eventId?: number | null
  createdAt?: Date | string | number
  delayMs?: number
  // hook_executed fields
  kind?: "executed" | "skipped"
  event?: string
  hookType?: string
  hookEvent?: string
  action?: string
  label?: string
  command?: string
  toolSuffix?: string
  pluginId?: string
  pluginName?: string
  skillName?: string
  skillPath?: string
  hookSourcePath?: string
  cwd?: string
  durationMs?: number
  exitCode?: number | null
  blocked?: boolean
  continue?: boolean
  stopReason?: string
  decision?: string
  stdout?: string
  stderr?: string
  additionalContext?: string
  systemMessage?: string
  stdinPayload?: string
  skipReason?: string
  timestamp?: string
  turnId?: string
  messages?: LiveStreamMessage[]
  result?: AgentAutoCommitResult
}

// Component that holds a stream and notifies subscribers
function ThreadStreamHolder({
  threadId,
  fallbackIndexBaselines,
  onStreamUpdate,
  onCustomEvent,
  onError
}: {
  threadId: string
  fallbackIndexBaselines: StreamFallbackIndexBaselines
  onStreamUpdate: (data: StreamData) => void
  onCustomEvent: (data: CustomEventData) => void
  onError: (error: Error) => void
}): null {
  const transport = useMemo(() => new ElectronIPCTransport(), [])

  useEffect(() => {
    transport.setFallbackIndexBaselines(fallbackIndexBaselines)
  }, [fallbackIndexBaselines, transport])

  // Use refs to avoid stale closures
  const onCustomEventRef = useRef(onCustomEvent)
  useEffect(() => {
    onCustomEventRef.current = onCustomEvent
  })

  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })

  const stream = useStream<DeepAgent>({
    transport,
    threadId,
    messagesKey: "messages",
    onCustomEvent: (data) => {
      onCustomEventRef.current(data as CustomEventData)
    },
    onError: (error: unknown) => {
      onErrorRef.current(error instanceof Error ? error : new Error(String(error)))
    }
  })

  // Notify parent whenever stream data changes
  // Use refs to avoid stale closures and ensure we always have latest callback
  const onStreamUpdateRef = useRef(onStreamUpdate)
  useEffect(() => {
    onStreamUpdateRef.current = onStreamUpdate
  })

  // Track previous values to detect actual changes
  const prevMessagesRef = useRef(stream.messages)
  const prevIsLoadingRef = useRef(stream.isLoading)

  // Always sync on mount and when values actually change
  useEffect(() => {
    const messagesChanged = prevMessagesRef.current !== stream.messages
    const loadingChanged = prevIsLoadingRef.current !== stream.isLoading

    if (messagesChanged || loadingChanged || !prevMessagesRef.current) {
      prevMessagesRef.current = stream.messages
      prevIsLoadingRef.current = stream.isLoading

      onStreamUpdateRef.current({
        messages: stream.messages,
        liveMessages: [],
        isLoading: stream.isLoading,
        stream
      })
    }
  })

  // Also sync immediately when stream instance changes
  useEffect(() => {
    onStreamUpdateRef.current({
      messages: stream.messages,
      liveMessages: [],
      isLoading: stream.isLoading,
      stream
    })
  }, [stream])

  return null
}

export function ThreadProvider({ children }: { children: ReactNode }) {
  const currentThreadId = useAppStore((state) => state.currentThreadId)
  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({})
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(new Set())
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({})
  const initializedThreadsRef = useRef<Set<string>>(new Set())
  const previousCurrentThreadIdRef = useRef<string | null>(null)
  const actionsCache = useRef<Record<string, ThreadActions>>({})
  const threadStatesRef = useRef<Record<string, ThreadState>>({})

  // Stream data store (not React state - we use subscriptions)
  const streamDataRef = useRef<Record<string, StreamData>>({})
  const streamSubscribersRef = useRef<Record<string, Set<() => void>>>({})
  const previousLoadingStatesRef = useRef<Record<string, boolean>>({})
  const coordinatorNotificationTimersRef = useRef<Record<string, number>>({})
  const coordinatorNotificationAttemptsRef = useRef<Record<string, number>>({})
  const coordinatorNotificationRetryOnIdleRef = useRef<Record<string, boolean>>({})
  const coordinatorNotificationAutoRunSuppressedRef = useRef<Set<string>>(new Set())
  const coordinatorNotificationSuppressTimersRef = useRef<Record<string, number>>({})
  const environmentCoordinatorThreadIdsRef = useRef<Set<string>>(new Set())
  const allStreamSubscribersRef = useRef<Set<() => void>>(new Set())
  const liveStreamAccumulatorsRef = useRef<Record<string, LiveStreamAccumulator>>({})
  const checkpointFallbackIndexBaselinesRef = useRef<Record<string, StreamFallbackIndexBaselines>>(
    {}
  )

  // Hook logs store (not React state — avoids re-rendering chat on every hook fire).
  //
  // Structure: per-thread → ordered list of per-turn buckets (oldest first).
  // A bucket is opened by `openHookLogBucket(threadId, userMessage)` at the
  // start of each new user turn; subsequent `hook_executed` events append to
  // the most recent bucket. Buckets are not cleared on new user messages —
  // they're kept up to HOOK_LOG_BUCKET_RING_SIZE so the user can scroll back
  // and inspect what hooks ran in earlier turns. Old buckets fall off the
  // front when the ring fills; the jsonl log file (diagnostic mode) holds
  // anything older.
  const hookLogBucketsRef = useRef<Record<string, HookLogBucket[]>>({})
  const hookLogsSubscribersRef = useRef<Record<string, Set<() => void>>>({})

  useEffect(() => {
    threadStatesRef.current = threadStates
  }, [threadStates])

  useEffect(() => {
    if (!import.meta.env.DEV) return

    const snapshot = (): unknown => {
      const appState = useAppStore.getState()
      const states = threadStatesRef.current
      const streamData = streamDataRef.current
      const workerFocusMessages = appState.workerFocusMessages
      const currentThreadId = appState.currentThreadId
      const currentThreadState = currentThreadId ? states[currentThreadId] : undefined
      const allThreadMessages = Object.values(states).reduce(
        (total, state) => total + state.messages.length,
        0
      )
      const allThreadMessageChars = Object.values(states).reduce(
        (total, state) => total + debugMessagesTextLength(state.messages),
        0
      )
      const streamMessages = Object.values(streamData).reduce(
        (total, data) => total + (Array.isArray(data.messages) ? data.messages.length : 0),
        0
      )
      const streamMessageChars = Object.values(streamData).reduce(
        (total, data) => total + debugRuntimeMessagesLength(data.messages),
        0
      )
      const performanceMemory = (
        performance as Performance & {
          memory?: {
            usedJSHeapSize?: number
            totalJSHeapSize?: number
            jsHeapSizeLimit?: number
          }
        }
      ).memory
      const result = {
        usedJSHeapMB: performanceMemory?.usedJSHeapSize
          ? Math.round(performanceMemory.usedJSHeapSize / 1024 / 1024)
          : null,
        totalJSHeapMB: performanceMemory?.totalJSHeapSize
          ? Math.round(performanceMemory.totalJSHeapSize / 1024 / 1024)
          : null,
        domNodes: document.getElementsByTagName("*").length,
        currentThreadId,
        currentThreadMessages: currentThreadState?.messages.length ?? 0,
        currentThreadMessageChars: debugMessagesTextLength(currentThreadState?.messages),
        allThreadCount: Object.keys(states).length,
        allThreadMessages,
        allThreadMessageChars,
        streamThreadCount: Object.keys(streamData).length,
        streamMessages,
        streamMessageChars,
        workerFocusOpen: Boolean(appState.workerFocusView),
        workerFocusMessages: workerFocusMessages.length,
        workerFocusMessageChars: debugMessagesTextLength(workerFocusMessages),
        coordinatorWorkers: currentThreadState?.coordinatorWorkers.length ?? 0
      }
      console.info("[CMBMemorySnapshot]", result)
      return result
    }

    ;(window as CmbMemoryDebugWindow).__cmbCoworkMemorySnapshot = snapshot

    const interval = window.setInterval(() => {
      const hasLoadingStream = Object.values(streamDataRef.current).some((data) => data.isLoading)
      const hasWorkerFocus = Boolean(useAppStore.getState().workerFocusView)
      if (hasLoadingStream || hasWorkerFocus) {
        snapshot()
      }
    }, 10000)

    return () => {
      window.clearInterval(interval)
      const debugWindow = window as CmbMemoryDebugWindow
      if (debugWindow.__cmbCoworkMemorySnapshot === snapshot) {
        delete debugWindow.__cmbCoworkMemorySnapshot
      }
    }
  }, [])

  const notifyHookLogSubscribers = useCallback((threadId: string) => {
    hookLogsSubscribersRef.current[threadId]?.forEach((cb) => cb())
  }, [])

  const subscribeToHookLogs = useCallback((threadId: string, callback: () => void) => {
    if (!hookLogsSubscribersRef.current[threadId]) {
      hookLogsSubscribersRef.current[threadId] = new Set()
    }
    hookLogsSubscribersRef.current[threadId].add(callback)
    return () => {
      hookLogsSubscribersRef.current[threadId]?.delete(callback)
    }
  }, [])

  const getHookLogBuckets = useCallback((threadId: string): HookLogBucket[] => {
    return hookLogBucketsRef.current[threadId] ?? EMPTY_HOOK_LOG_BUCKETS
  }, [])

  // Opens a new bucket for the incoming user turn. Trims the ring to size.
  // Called from appendMessage when a `role === "user"` message arrives.
  const openHookLogBucket = useCallback(
    (threadId: string, userMessage: Message): void => {
      const preview =
        typeof userMessage.content === "string"
          ? userMessage.content
          : Array.isArray(userMessage.content)
            ? userMessage.content
                .map((block) => {
                  const text = (block as { text?: unknown })?.text
                  return typeof text === "string" ? text : ""
                })
                .join(" ")
            : ""
      const bucket: HookLogBucket = {
        turnId: userMessage.id,
        turnPreview: preview.trim().slice(0, 120),
        startedAt: new Date(),
        entries: []
      }
      const existing = hookLogBucketsRef.current[threadId] ?? []
      // Idempotent: if appendMessage fires twice for the same id, don't open
      // duplicate buckets. If a hook event arrived first and created a
      // placeholder bucket, fill in the real user preview while preserving
      // existing entries. Use the explicit isPlaceholder flag (not a
      // turnPreview prefix heuristic) so user messages that legitimately start
      // with "(" aren't misclassified.
      const existingIdx = existing.findIndex((b) => b.turnId === bucket.turnId)
      if (existingIdx >= 0) {
        const current = existing[existingIdx]
        if (current.isPlaceholder && bucket.turnPreview) {
          hookLogBucketsRef.current[threadId] = [
            ...existing.slice(0, existingIdx),
            {
              ...current,
              turnPreview: bucket.turnPreview,
              startedAt: bucket.startedAt,
              isPlaceholder: false
            },
            ...existing.slice(existingIdx + 1)
          ]
          notifyHookLogSubscribers(threadId)
        }
        return
      }
      const next = [...existing, bucket]
      if (next.length > HOOK_LOG_BUCKET_RING_SIZE) {
        next.splice(0, next.length - HOOK_LOG_BUCKET_RING_SIZE)
      }
      hookLogBucketsRef.current[threadId] = next
      notifyHookLogSubscribers(threadId)
    },
    [notifyHookLogSubscribers]
  )

  // Notify subscribers for a thread
  const notifyStreamSubscribers = useCallback((threadId: string) => {
    const subscribers = streamSubscribersRef.current[threadId]
    if (subscribers) {
      subscribers.forEach((callback) => callback())
    }
    allStreamSubscribersRef.current.forEach((callback) => callback())
  }, [])

  const getCurrentThreadMessageIds = useCallback((threadId: string): Set<string> => {
    return new Set((threadStatesRef.current[threadId]?.messages ?? []).map((message) => message.id))
  }, [])

  const getOrCreateLiveStreamAccumulator = useCallback(
    (threadId: string): LiveStreamAccumulator => {
      const existing = liveStreamAccumulatorsRef.current[threadId]
      if (existing) return existing

      const created: LiveStreamAccumulator = {
        active: false,
        baselineIds: getCurrentThreadMessageIds(threadId),
        messages: [],
        messageTimes: {},
        lastStartedAtMs: undefined,
        pendingGoalSubturnMessages: []
      }
      liveStreamAccumulatorsRef.current[threadId] = created
      return created
    },
    [getCurrentThreadMessageIds]
  )

  const seedLiveStreamBaselineFromMessages = useCallback(
    (threadId: string, messages: Array<{ id?: string }> | undefined): void => {
      if (!messages || messages.length === 0) return
      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      for (const message of messages) {
        if (message.id) accumulator.baselineIds.add(message.id)
      }
    },
    [getOrCreateLiveStreamAccumulator]
  )

  const seedLiveStreamBaselineFromCheckpoint = useCallback(
    (threadId: string, rawCheckpointMessages: Message[]): void => {
      if (rawCheckpointMessages.length === 0) return

      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      checkpointFallbackIndexBaselinesRef.current[threadId] = mergeFallbackIndexBaselines(
        checkpointFallbackIndexBaselinesRef.current[threadId],
        fallbackIndexBaselinesFromMessages(rawCheckpointMessages)
      )
      const fallbackIndexes: Record<StableFallbackType, number> = {
        ai: 0,
        tool: 0,
        system: 0,
        human: 0
      }

      for (const checkpointMessage of rawCheckpointMessages) {
        accumulator.baselineIds.add(checkpointMessage.id)

        // Ordinary user messages are filtered from values snapshots because the
        // local UI already owns those bubbles. Other checkpoint messages can
        // reappear in a cached values snapshot with transport fallback ids.
        if (checkpointMessage.role === "user" && !isInternalGoalPromptMessage(checkpointMessage)) {
          continue
        }

        const fallbackType = stableFallbackTypeForMessage(checkpointMessage)
        const fallbackIndex = fallbackIndexes[fallbackType]++
        if (!isSyntheticCheckpointMessageId(checkpointMessage.id)) continue

        for (const baselineId of buildSyntheticCheckpointBaselineIds({
          index: fallbackIndex,
          type: fallbackType,
          className: stableClassNameForFallbackType(fallbackType),
          content:
            typeof checkpointMessage.content === "string" ? checkpointMessage.content : undefined,
          toolCallId: checkpointMessage.tool_call_id,
          name: checkpointMessage.name,
          toolCalls: checkpointMessage.tool_calls
        })) {
          accumulator.baselineIds.add(baselineId)
        }
      }
    },
    [getOrCreateLiveStreamAccumulator]
  )

  const liveMessagesWithTimes = useCallback(
    (accumulator: LiveStreamAccumulator): LiveStreamMessage[] =>
      accumulator.messages.map((message) => ({
        ...message,
        ...(message.id && accumulator.messageTimes[message.id]?.start_at
          ? { start_at: accumulator.messageTimes[message.id].start_at }
          : {}),
        ...(message.id && accumulator.messageTimes[message.id]?.end_at
          ? { end_at: accumulator.messageTimes[message.id].end_at }
          : {})
      })),
    []
  )

  const accumulateLiveStreamMessages = useCallback(
    (
      threadId: string,
      rawMessages: StreamData["messages"] | LiveStreamMessage[]
    ): LiveStreamMessage[] => {
      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      const existingMessageIds = getCurrentThreadMessageIds(threadId)
      const incoming: Array<LiveStreamMessage & { id: string }> = []
      for (const message of (rawMessages || []) as LiveStreamMessage[]) {
        const messageId = message.id
        if (
          !messageId ||
          accumulator.baselineIds.has(messageId) ||
          existingMessageIds.has(messageId)
        ) {
          continue
        }

        const messageWithId = message as LiveStreamMessage & { id: string }
        if (shouldSkipLiveStreamAccumulatorMessage(messageWithId)) {
          accumulator.baselineIds.add(messageId)
          continue
        }

        incoming.push(messageWithId)
      }

      if (incoming.length > 0) {
        const batchStartMs = Math.max(Date.now(), (accumulator.lastStartedAtMs ?? 0) + 1)
        // Only advance the clock for newly timed messages; repeated snapshots can include
        // already-timed messages that are still waiting for the next flush.
        let assignedCount = 0
        incoming.forEach((message) => {
          if (!accumulator.messageTimes[message.id]) {
            const startedAt = new Date(batchStartMs + assignedCount)
            accumulator.messageTimes[message.id] = { start_at: startedAt, end_at: startedAt }
            assignedCount += 1
          }
        })
        if (assignedCount > 0) {
          accumulator.lastStartedAtMs = batchStartMs + assignedCount - 1
        }
        accumulator.messages = mergeLiveStreamMessages(accumulator.messages, incoming)
      }

      return liveMessagesWithTimes(accumulator)
    },
    [getCurrentThreadMessageIds, getOrCreateLiveStreamAccumulator, liveMessagesWithTimes]
  )

  const flushLiveStreamAccumulator = useCallback(
    (threadId: string, options: { keepActive?: boolean } = {}): LiveStreamMessage[] => {
      const accumulator = liveStreamAccumulatorsRef.current[threadId]
      if (!accumulator) return []

      const completedAt = new Date()
      const existingMessageIds = getCurrentThreadMessageIds(threadId)
      const currentTurnMessages = accumulator.messages.filter(
        (message): message is LiveStreamMessage & { id: string } =>
          !!message.id &&
          !!accumulator.messageTimes[message.id] &&
          !existingMessageIds.has(message.id)
      )
      const nextMessageTimes: MessageTimeMap = {}
      const nextInternalGoalMessageTimes: MessageTimeMap = {}
      const messagesToAppend: Message[] = []
      const retainedVisibleLiveMessages: LiveStreamMessage[] = []

      currentTurnMessages.forEach((streamMessage, index) => {
        const trackedTime = accumulator.messageTimes[streamMessage.id]
        const nextStreamMessage = currentTurnMessages[index + 1]
        trackedTime.end_at = resolveLiveStreamMessageEndAt(
          trackedTime.start_at,
          nextStreamMessage ? accumulator.messageTimes[nextStreamMessage.id]?.start_at : undefined,
          completedAt
        )

        const storeMessage = liveStreamMessageToStoreMessage(streamMessage, trackedTime)

        accumulator.baselineIds.add(streamMessage.id)

        if (isInternalGoalPromptMessage(storeMessage)) {
          nextInternalGoalMessageTimes[streamMessage.id] = {
            start_at: trackedTime.start_at.toISOString(),
            end_at: trackedTime.end_at.toISOString()
          }
          return
        }
        if (!isVisibleCheckpointTranscriptMessage(storeMessage)) return

        nextMessageTimes[streamMessage.id] = {
          start_at: trackedTime.start_at.toISOString(),
          end_at: trackedTime.end_at.toISOString()
        }
        messagesToAppend.push(storeMessage)
        retainedVisibleLiveMessages.push({
          ...streamMessage,
          start_at: trackedTime.start_at,
          end_at: trackedTime.end_at
        })
      })

      if (messagesToAppend.length > 0) {
        setThreadStates((prev) => {
          const currentState = prev[threadId] || createDefaultThreadState()
          const currentIds = new Set(currentState.messages.map((message) => message.id))
          const newMessages = messagesToAppend.filter((message) => !currentIds.has(message.id))
          if (newMessages.length === 0) return prev
          const next = {
            ...prev,
            [threadId]: {
              ...currentState,
              messages: [...currentState.messages, ...newMessages]
            }
          }
          threadStatesRef.current = next
          return next
        })
      }

      if (
        Object.keys(nextMessageTimes).length > 0 ||
        Object.keys(nextInternalGoalMessageTimes).length > 0
      ) {
        window.api.threads
          .mergeThreadValues(threadId, {
            [MESSAGE_TIMES_THREAD_VALUE_KEY]: nextMessageTimes,
            [INTERNAL_GOAL_MESSAGE_TIMES_THREAD_VALUE_KEY]: nextInternalGoalMessageTimes,
            [INTERNAL_GOAL_MESSAGE_TIME_ORDER_THREAD_VALUE_KEY]: messageTimeOrderEntries(
              nextInternalGoalMessageTimes
            ),
            [MESSAGE_TIME_ORDER_THREAD_VALUE_KEY]: messageTimeOrderEntries(nextMessageTimes)
          })
          .catch((error) => console.warn("[ThreadContext] Failed to save message times:", error))
      }

      if (options.keepActive) {
        accumulator.active = true
        accumulator.messages = []
        accumulator.messageTimes = {}
      } else {
        delete liveStreamAccumulatorsRef.current[threadId]
      }

      const currentStreamData = streamDataRef.current[threadId]
      if (currentStreamData) {
        const retainedLiveMessages = mergeLiveStreamMessages(
          currentStreamData.liveMessages ?? [],
          retainedVisibleLiveMessages
        )
        // Keep just-flushed visible messages in the live layer until React commits
        // the threadMessages update. ChatContainer filters live messages by id, so
        // they disappear naturally after the persisted transcript catches up.
        streamDataRef.current[threadId] = {
          ...currentStreamData,
          liveMessages: retainedLiveMessages
        }
        notifyStreamSubscribers(threadId)
      }

      return streamDataRef.current[threadId]?.liveMessages ?? retainedVisibleLiveMessages
    },
    [getCurrentThreadMessageIds, notifyStreamSubscribers]
  )

  const flushGoalSubturnComplete = useCallback(
    (threadId: string, messages: LiveStreamMessage[]) => {
      if (messages.length > 0) {
        accumulateLiveStreamMessages(threadId, messages)
      }
      flushLiveStreamAccumulator(threadId, { keepActive: true })
    },
    [accumulateLiveStreamMessages, flushLiveStreamAccumulator]
  )

  // Handle stream updates from ThreadStreamHolder
  const handleStreamUpdate = useCallback(
    (threadId: string, data: StreamData, options: StreamUpdateOptions = {}) => {
      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      if (!options.ignoreHistoryLoading && threadStatesRef.current[threadId]?.historyLoading) {
        streamDataRef.current[threadId] = { ...data, liveMessages: [] }
        notifyStreamSubscribers(threadId)
        setLoadingStates((prev) => {
          if (prev[threadId] === data.isLoading) return prev
          return { ...prev, [threadId]: data.isLoading }
        })
        return
      }

      if (!accumulator.active && (data.isLoading || options.finalizeCachedSnapshot)) {
        accumulator.active = true
        if (!options.preserveExistingBaseline) {
          const nextBaselineIds = getCurrentThreadMessageIds(threadId)
          for (const baselineId of accumulator.baselineIds) {
            nextBaselineIds.add(baselineId)
          }
          accumulator.baselineIds = nextBaselineIds
          seedLiveStreamBaselineFromMessages(threadId, streamDataRef.current[threadId]?.messages)
        }
        accumulator.messages = []
        accumulator.messageTimes = {}
      }

      let liveMessages = accumulator.active
        ? accumulateLiveStreamMessages(threadId, data.messages)
        : []

      const currentMessageIds = getCurrentThreadMessageIds(threadId)
      const retainedLiveMessages = (streamDataRef.current[threadId]?.liveMessages ?? []).filter(
        (message) => hasMessageId(message) && !currentMessageIds.has(message.id)
      )
      if (retainedLiveMessages.length > 0) {
        liveMessages = mergeLiveStreamMessages(retainedLiveMessages, liveMessages)
      }

      if (accumulator.active && (!data.isLoading || options.finalizeCachedSnapshot)) {
        liveMessages = flushLiveStreamAccumulator(threadId)
      }

      streamDataRef.current[threadId] = { ...data, liveMessages }
      notifyStreamSubscribers(threadId)
      // Update loading states for kanban view
      setLoadingStates((prev) => {
        if (prev[threadId] === data.isLoading) return prev
        return { ...prev, [threadId]: data.isLoading }
      })
      // Fallback clear: drop the retry indicator when the stream stops (isLoading=false).
      // The primary clear path is the explicit model_retry_clear custom event sent by
      // the main process when a retry succeeds. This fallback covers error paths and
      // any edge case where model_retry_clear was not sent.
      if (!data.isLoading) {
        setThreadStates((prev) => {
          const cur = prev[threadId]
          if (!cur || !cur.modelRetry) return prev
          const next = { ...prev, [threadId]: { ...cur, modelRetry: null } }
          threadStatesRef.current = next
          return next
        })
      }
    },
    [
      accumulateLiveStreamMessages,
      flushLiveStreamAccumulator,
      getCurrentThreadMessageIds,
      getOrCreateLiveStreamAccumulator,
      notifyStreamSubscribers,
      seedLiveStreamBaselineFromMessages
    ]
  )

  // Subscribe to stream updates for a thread
  const subscribeToStream = useCallback((threadId: string, callback: () => void) => {
    if (!streamSubscribersRef.current[threadId]) {
      streamSubscribersRef.current[threadId] = new Set()
    }
    streamSubscribersRef.current[threadId].add(callback)

    return () => {
      streamSubscribersRef.current[threadId]?.delete(callback)
    }
  }, [])

  // Get current stream data for a thread
  const getStreamData = useCallback((threadId: string): StreamData => {
    return streamDataRef.current[threadId] || defaultStreamData
  }, [])

  const getThreadState = useCallback(
    (threadId: string): ThreadState => {
      const state = normalizeThreadState(threadStates[threadId] || createDefaultThreadState())
      if (state.pendingApprovals.length > 0) {
        console.log(
          "[ThreadContext] getThreadState returning pending approvals for:",
          threadId,
          state.pendingApprovals.length
        )
      }
      return state
    },
    [threadStates]
  )

  const getAllThreadStates = useCallback((): Record<string, ThreadState> => {
    return threadStates
  }, [threadStates])

  const getAllStreamLoadingStates = useCallback((): Record<string, boolean> => {
    return loadingStates
  }, [loadingStates])

  const subscribeToAllStreams = useCallback((callback: () => void) => {
    allStreamSubscribersRef.current.add(callback)
    return () => {
      allStreamSubscribersRef.current.delete(callback)
    }
  }, [])

  const unresolvedCoordinatorThreadIdsKey = useMemo(() => {
    return Object.entries(threadStates)
      .filter(([threadId, state]) => {
        const hasRunningWorker = state.coordinatorWorkers.some(
          (worker) => worker.status === "running"
        )
        if (hasRunningWorker) return true

        const hasPendingTerminalNotification = state.coordinatorWorkers.some(
          (worker) =>
            worker.status !== "running" &&
            worker.notification_acknowledged === false &&
            worker.suppress_notification_auto_run !== true
        )
        if (!hasPendingTerminalNotification) return false

        if (!initializedThreadsRef.current.has(threadId)) return false

        const isEnvironmentCoordinatorMode =
          environmentCoordinatorThreadIdsRef.current.has(threadId)
        if (isThreadMetadataExplicitNormalMode(threadId) && !isEnvironmentCoordinatorMode) {
          return false
        }

        return true
      })
      .map(([threadId]) => threadId)
      .sort()
      .join("\n")
  }, [threadStates])

  const updateThreadState = useCallback(
    (threadId: string, updater: (prev: ThreadState) => Partial<ThreadState>) => {
      setThreadStates((prev) => {
        const currentState = normalizeThreadState(prev[threadId] || createDefaultThreadState())
        const updates = updater(currentState)
        const updateKeys = Object.keys(updates) as Array<keyof ThreadState>
        if (updateKeys.length === 0) return prev
        const hasChanged = updateKeys.some((key) => !Object.is(currentState[key], updates[key]))
        if (!hasChanged) return prev
        const next = {
          ...prev,
          [threadId]: { ...currentState, ...updates }
        }
        threadStatesRef.current = next
        return next
      })
    },
    []
  )

  const scheduleCoordinatorNotificationTurn = useCallback((threadId: string) => {
    if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return
    if (coordinatorNotificationTimersRef.current[threadId] !== undefined) return

    coordinatorNotificationTimersRef.current[threadId] = window.setTimeout(async () => {
      delete coordinatorNotificationTimersRef.current[threadId]
      if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return

      try {
        const hasPendingNotification =
          await window.api.agent.hasCoordinatorWorkerNotifications(threadId)
        if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return
        if (!hasPendingNotification) {
          delete coordinatorNotificationAttemptsRef.current[threadId]
          delete coordinatorNotificationRetryOnIdleRef.current[threadId]
          return
        }

        let isEnvironmentCoordinatorMode = environmentCoordinatorThreadIdsRef.current.has(threadId)
        if (!isThreadMetadataInCoordinatorMode(threadId) && !isEnvironmentCoordinatorMode) {
          try {
            isEnvironmentCoordinatorMode = await window.api.agent.isCoordinatorModeForced()
            if (isEnvironmentCoordinatorMode) {
              environmentCoordinatorThreadIdsRef.current.add(threadId)
            }
          } catch (error) {
            console.warn("[ThreadContext] Failed to check coordinator mode override:", error)
          }
          if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return
        }

        if (isThreadMetadataExplicitNormalMode(threadId) && !isEnvironmentCoordinatorMode) {
          delete coordinatorNotificationAttemptsRef.current[threadId]
          delete coordinatorNotificationRetryOnIdleRef.current[threadId]
          return
        }

        const streamData = streamDataRef.current[threadId]
        if (!streamData?.stream) {
          coordinatorNotificationRetryOnIdleRef.current[threadId] = true
          const attempts = (coordinatorNotificationAttemptsRef.current[threadId] ?? 0) + 1
          coordinatorNotificationAttemptsRef.current[threadId] = attempts
          if (attempts <= COORDINATOR_NOTIFICATION_MAX_RETRIES) {
            scheduleCoordinatorNotificationTurn(threadId)
          } else {
            delete coordinatorNotificationAttemptsRef.current[threadId]
          }
          return
        }

        if (streamData.isLoading) {
          coordinatorNotificationRetryOnIdleRef.current[threadId] = true
          const attempts = (coordinatorNotificationAttemptsRef.current[threadId] ?? 0) + 1
          coordinatorNotificationAttemptsRef.current[threadId] = attempts
          if (attempts <= COORDINATOR_NOTIFICATION_MAX_RETRIES) {
            scheduleCoordinatorNotificationTurn(threadId)
          } else {
            delete coordinatorNotificationAttemptsRef.current[threadId]
          }
          return
        }

        const threadState = threadStatesRef.current[threadId] ?? createDefaultThreadState()
        if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return
        await streamData.stream.submit(null, {
          config: {
            configurable: {
              thread_id: threadId,
              model_id: threadState.currentModel || undefined,
              agent_mode: "coordinator",
              coordinator_internal_notification: true
            }
          }
        })
        delete coordinatorNotificationAttemptsRef.current[threadId]
        delete coordinatorNotificationRetryOnIdleRef.current[threadId]
      } catch (error) {
        if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return
        console.warn("[ThreadContext] Failed to auto-run coordinator notification turn:", error)
        const attempts = (coordinatorNotificationAttemptsRef.current[threadId] ?? 0) + 1
        coordinatorNotificationAttemptsRef.current[threadId] = attempts
        if (attempts <= COORDINATOR_NOTIFICATION_MAX_RETRIES) {
          scheduleCoordinatorNotificationTurn(threadId)
        } else {
          delete coordinatorNotificationAttemptsRef.current[threadId]
        }
      }
    }, COORDINATOR_NOTIFICATION_RETRY_MS)
  }, [])

  const suppressCoordinatorNotificationAutoRun = useCallback(
    (threadId: string) => {
      coordinatorNotificationAutoRunSuppressedRef.current.add(threadId)
      const existingSuppressTimer = coordinatorNotificationSuppressTimersRef.current[threadId]
      if (existingSuppressTimer !== undefined) {
        window.clearTimeout(existingSuppressTimer)
      }
      const coordinatorNotificationTimer = coordinatorNotificationTimersRef.current[threadId]
      if (coordinatorNotificationTimer !== undefined) {
        window.clearTimeout(coordinatorNotificationTimer)
      }
      delete coordinatorNotificationTimersRef.current[threadId]
      delete coordinatorNotificationAttemptsRef.current[threadId]
      delete coordinatorNotificationRetryOnIdleRef.current[threadId]
      coordinatorNotificationSuppressTimersRef.current[threadId] = window.setTimeout(() => {
        delete coordinatorNotificationSuppressTimersRef.current[threadId]
        if (!coordinatorNotificationAutoRunSuppressedRef.current.delete(threadId)) return
        scheduleCoordinatorNotificationTurn(threadId)
      }, COORDINATOR_NOTIFICATION_SUPPRESS_MS)
    },
    [scheduleCoordinatorNotificationTurn]
  )

  useEffect(() => {
    const previous = previousLoadingStatesRef.current
    for (const [threadId, wasLoading] of Object.entries(previous)) {
      if (wasLoading && loadingStates[threadId] === false) {
        const workers = threadStatesRef.current[threadId]?.coordinatorWorkers ?? []
        if (workers.length === 0) continue
        if (
          (coordinatorNotificationAttemptsRef.current[threadId] ?? 0) <= 0 &&
          !coordinatorNotificationRetryOnIdleRef.current[threadId]
        ) {
          continue
        }
        scheduleCoordinatorNotificationTurn(threadId)
      }
    }
    previousLoadingStatesRef.current = loadingStates
  }, [loadingStates, scheduleCoordinatorNotificationTurn])

  useEffect(() => {
    const unresolvedThreadIds = unresolvedCoordinatorThreadIdsKey
      ? unresolvedCoordinatorThreadIdsKey.split("\n")
      : []
    if (unresolvedThreadIds.length === 0) return

    let cancelled = false

    const refreshCoordinatorWorkers = async (): Promise<void> => {
      await Promise.all(
        unresolvedThreadIds.map(async (threadId) => {
          try {
            const workers = await window.api.agent.getCoordinatorWorkers(threadId, {
              subscribeUpdates: false
            })
            if (cancelled) return
            const previousWorkers = threadStatesRef.current[threadId]?.coordinatorWorkers ?? []
            const previousById = new Map(
              previousWorkers.map((worker) => [worker.worker_id, worker])
            )
            const hasNewTerminalWorker = workers.some((worker) => {
              const previous = previousById.get(worker.worker_id)
              return (
                previous?.status === "running" &&
                isTerminalCoordinatorWorker(worker) &&
                worker.suppress_notification_auto_run !== true
              )
            })
            const hasPendingTerminalNotification = workers.some(
              (worker) =>
                isTerminalCoordinatorWorker(worker) &&
                worker.notification_acknowledged === false &&
                worker.suppress_notification_auto_run !== true
            )
            updateThreadState(threadId, (prev) => {
              const merged = mergeCoordinatorWorkers(prev.coordinatorWorkers, workers, {
                authoritative: true
              })
              if (coordinatorWorkersEqual(prev.coordinatorWorkers, merged)) return {}
              return { coordinatorWorkers: merged }
            })
            if (hasNewTerminalWorker || hasPendingTerminalNotification) {
              scheduleCoordinatorNotificationTurn(threadId)
            }
          } catch (error) {
            console.warn("[ThreadContext] Failed to refresh coordinator workers:", error)
          }
        })
      )
    }

    void refreshCoordinatorWorkers()
    const timer = window.setInterval(() => {
      void refreshCoordinatorWorkers()
    }, 2_000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [unresolvedCoordinatorThreadIdsKey, scheduleCoordinatorNotificationTurn, updateThreadState])

  const loadWorkspaceFilesInBackground = useCallback(
    (threadId: string, workspacePath: string) => {
      // 工作区文件树可能很大，不能阻塞会话历史首屏恢复。
      // 这里后台加载，避免 “正在加载会话历史” 被完整目录扫描拖住。
      window.api.workspace
        .loadFromDisk(threadId)
        .then((diskResult) => {
          if (!diskResult.success) return

          // 后台扫描期间用户可能切走/关闭了这个线程，避免把旧结果写回已清理状态。
          if (!initializedThreadsRef.current.has(threadId)) return

          updateThreadState(threadId, (state) => {
            // 如果扫描完成前用户切换了工作区，丢弃旧 workspace 的文件树结果。
            if (state.workspacePath !== workspacePath) return {}
            return { workspaceFiles: diskResult.files }
          })
        })
        .catch((error) => {
          console.error("[ThreadContext] Failed to load workspace files:", error)
        })
    },
    [updateThreadState]
  )

  const refreshGoalUi = useCallback(
    async (threadId: string, options: { includeEvents?: boolean } = {}): Promise<void> => {
      try {
        const includeEvents = options.includeEvents !== false
        const goalUi = await window.api.threads.getGoalState(threadId, { includeEvents })
        updateThreadState(threadId, (state) => ({
          goalUi: {
            goal: goalUi.goal,
            events: includeEvents ? goalUi.events : state.goalUi.events,
            lastUpdated: new Date()
          }
        }))
      } catch (error) {
        console.warn("[ThreadContext] Failed to refresh goal UI state:", error)
      }
    },
    [updateThreadState]
  )

  // Parse error messages into user-friendly format
  const parseErrorMessage = useCallback((error: Error | string): string => {
    const raw = typeof error === "string" ? error : error.message

    // Strip LangChain troubleshooting URL suffix (appended by @langchain/openai on 4xx errors)
    const errorMessage = raw
      .replace(/\n\nTroubleshooting URL: https:\/\/docs\.langchain\.com\S*/g, "")
      .trim()

    // Check for context window exceeded errors
    const contextWindowMatch = errorMessage.match(
      /prompt is too long: (\d+) tokens > (\d+) maximum/i
    )
    if (contextWindowMatch) {
      const [, usedTokens, maxTokens] = contextWindowMatch
      const usedK = Math.round(parseInt(usedTokens) / 1000)
      const maxK = Math.round(parseInt(maxTokens) / 1000)
      return `上下文窗口已满 (${usedK}K / ${maxK}K tokens)，请开启新对话。`
    }

    // Check for rate limit errors
    if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
      return "请求频率超限，请稍后再试。"
    }

    // Check for authentication errors
    if (
      errorMessage.includes("401") ||
      errorMessage.includes("invalid_api_key") ||
      errorMessage.includes("authentication")
    ) {
      return "认证失败，请检查设置中的 API Key。"
    }

    // Check for model not found (404 — wrong model name)
    // Use lc_error_code as primary signal; fall back to pattern matching "404" + model-related keywords
    const lcCode = (error as Error & { lc_error_code?: string }).lc_error_code
    if (
      lcCode === "MODEL_NOT_FOUND" ||
      (/\b404\b/.test(errorMessage) && /model|not.found|does.not.exist/i.test(errorMessage))
    ) {
      return `模型不存在，请检查设置中的模型名称是否正确。\n${errorMessage}`
    }

    // Check for API-side termination (common with proxy/relay services)
    if (errorMessage.toLowerCase() === "terminated") {
      return "API 服务端中断了响应，请重试。如果频繁出现，请检查 API 服务状态。"
    }

    // Return the cleaned message for other errors
    return errorMessage
  }, [])

  // Handle errors from ThreadStreamHolder
  const handleError = useCallback(
    (threadId: string, error: Error) => {
      console.error("[ThreadContext] Stream error:", { threadId, error })
      const userFriendlyMessage = parseErrorMessage(error)
      updateThreadState(threadId, () => ({ error: userFriendlyMessage, modelRetry: null }))
    },
    [parseErrorMessage, updateThreadState]
  )

  // Handle custom events from ThreadStreamHolder (interrupts, workspace updates, etc.)
  const handleCustomEvent = useCallback(
    (threadId: string, data: CustomEventData) => {
      console.log("[ThreadContext] Custom event received:", {
        threadId,
        type: data.type,
        fileCount: Array.isArray(data.files) ? data.files.length : undefined,
        workerCount: Array.isArray(data.workers) ? data.workers.length : undefined,
        subagentCount: Array.isArray(data.subagents) ? data.subagents.length : undefined
      })
      switch (data.type) {
        case "interrupt":
          if (data.request) {
            console.log(
              "[ThreadContext] Setting pendingApproval for thread:",
              threadId,
              data.request
            )
            updateThreadState(threadId, (state) => ({
              ...buildPendingApprovalState(
                enqueuePendingApproval(state.pendingApprovals, {
                  ...data.request!,
                  allowRuntimeRestoredCheckpointResume:
                    data.request!.allowRuntimeRestoredCheckpointResume ?? true
                })
              ),
              toolCallStates: upsertToolCallStateFromRequest(
                state.toolCallStates,
                data.request as HITLRequest & Record<string, unknown>
              )
            }))
          }
          break
        case "workspace":
          if (Array.isArray(data.files)) {
            updateThreadState(threadId, (state) => {
              const fileMap = new Map(state.workspaceFiles.map((f) => [f.path, f]))
              for (const f of data.files!) {
                fileMap.set(f.path, { path: f.path, is_dir: f.is_dir, size: f.size })
              }
              return { workspaceFiles: Array.from(fileMap.values()) }
            })
          }
          if (data.path) {
            updateThreadState(threadId, (state) =>
              state.workspacePath === data.path
                ? { workspacePath: data.path }
                : { workspacePath: data.path, coordinatorWorkers: [] }
            )
          }
          break
        case "subagents":
          if (Array.isArray(data.subagents)) {
            updateThreadState(threadId, () => ({
              subagents: data.subagents!.map((s) => ({
                id: s.id || crypto.randomUUID(),
                toolCallId: s.toolCallId,
                name: s.name || "Subagent",
                description: s.description || "",
                status: (s.status || "pending") as "pending" | "running" | "completed" | "failed",
                startedAt: s.startedAt,
                completedAt: s.completedAt,
                subagentType: s.subagentType
              }))
            }))
          }
          break
        case "coordinator_workers":
          if (Array.isArray(data.workers)) {
            updateThreadState(threadId, (prev) => {
              const merged = mergeCoordinatorWorkers(prev.coordinatorWorkers, data.workers!, {
                authoritative: true
              })
              if (coordinatorWorkersEqual(prev.coordinatorWorkers, merged)) return {}
              return { coordinatorWorkers: merged }
            })
          } else if (data.worker) {
            updateThreadState(threadId, (prev) => {
              const merged = mergeCoordinatorWorkers(prev.coordinatorWorkers, [data.worker!])
              if (coordinatorWorkersEqual(prev.coordinatorWorkers, merged)) return {}
              return { coordinatorWorkers: merged }
            })
          }
          if (data.notification && !data.suppressNotificationAutoRun) {
            scheduleCoordinatorNotificationTurn(threadId)
          }
          break
        case "coordinator_notification_deferred":
          scheduleCoordinatorNotificationTurn(threadId)
          break
        case "coordinator_worker_stream_message":
          // Focused coordinator worker streams are delivered through App.tsx's
          // dedicated side channel. Keeping a second append path here doubles
          // renderer churn when a worker emits values snapshots.
          break
        case "subagent_tool_count":
          if (typeof data.count === "number" && Number.isFinite(data.count)) {
            updateThreadState(threadId, () => ({
              subagentToolCallCount: Math.max(0, Math.floor(data.count!))
            }))
          }
          break
        case "subagent_log_reset":
          updateThreadState(threadId, () => ({ subagentInternalLogs: [] }))
          break
        case "subagent_log_entry":
          if (data.entry?.id) {
            updateThreadState(threadId, (prev) => ({
              subagentInternalLogs: upsertSubagentLogEntry(prev.subagentInternalLogs, data.entry!)
            }))
          }
          break
        case "routing_result":
          if (data.resolvedModelId && data.resolvedTier) {
            updateThreadState(threadId, () => ({
              routingResult: {
                resolvedModelId: data.resolvedModelId!,
                resolvedTier: data.resolvedTier!,
                routeReason: data.routeReason ?? ""
              },
              // Sync currentModel to the routing-resolved model so that
              // ContextUsageIndicator tracks the correct context window.
              // Note: only update in-memory state, do NOT persist to thread
              // metadata — that stays as the user's manual selection for
              // pinned mode fallback.
              currentModel: data.resolvedModelId!
            }))
          }
          break
        case "agent_mode":
          if (data.mode === "normal" || data.mode === "coordinator") {
            if (
              data.mode === "coordinator" &&
              data.persisted === false &&
              data.source === "environment"
            ) {
              environmentCoordinatorThreadIdsRef.current.add(threadId)
            } else if (data.mode === "normal") {
              environmentCoordinatorThreadIdsRef.current.delete(threadId)
            }
            if (data.persisted === false) {
              break
            }
            // The main process already persisted this mode. Keep the UI in sync
            // without writing stale renderer metadata back over newer main updates.
            useAppStore.setState((state) => ({
              threads: state.threads.map((thread) =>
                thread.thread_id === threadId
                  ? {
                      ...thread,
                      metadata: { ...(thread.metadata ?? {}), agentMode: data.mode }
                    }
                  : thread
              )
            }))
          }
          break
        case "model_retry":
          if (typeof data.attempt === "number" && typeof data.maxRetries === "number") {
            updateThreadState(threadId, () => ({
              modelRetry: {
                attempt: data.attempt!,
                maxRetries: data.maxRetries!,
                reason: data.reason ?? "",
                delayMs: data.delayMs ?? 0,
                startedAt: new Date()
              }
            }))
          }
          break
        case "model_retry_clear":
          updateThreadState(threadId, () => ({ modelRetry: null }))
          break
        case "goal_subturn_complete":
          {
            const messages = Array.isArray(data.messages) ? data.messages : []
            if (threadStatesRef.current[threadId]?.historyLoading) {
              getOrCreateLiveStreamAccumulator(threadId).pendingGoalSubturnMessages.push(messages)
              break
            }
            flushGoalSubturnComplete(threadId, messages)
          }
          break
        case "hook_notice":
          if (typeof data.message === "string" && data.message.trim()) {
            toast.info(data.message)
          }
          break
        case "goal_notice":
          if (typeof data.message === "string" && data.message.trim()) {
            const message = formatGoalEventMessage(data.message)
            if (message.startsWith("✓ Goal 已完成") || message.startsWith("Goal 已完成")) {
              toast.success(message)
            } else if (
              message.startsWith("Goal 已暂停") ||
              message.startsWith("Ⅱ Goal 已暂停") ||
              message.startsWith("Goal 等待补充信息")
            ) {
              toast.warning(message)
            } else if (message.startsWith("Goal 已清除")) {
              toast.info(message)
            }
            const liveEvent =
              typeof data.eventId === "number"
                ? ({
                    event_id: data.eventId,
                    thread_id: threadId,
                    goal_id: typeof data.goalId === "string" ? data.goalId : null,
                    active_window_id:
                      typeof data.activeWindowId === "string" ? data.activeWindowId : null,
                    message: data.message,
                    created_at:
                      typeof data.createdAt === "number" ||
                      typeof data.createdAt === "string" ||
                      data.createdAt instanceof Date
                        ? data.createdAt
                        : new Date()
                  } satisfies GoalEvent)
                : null
            if (liveEvent) {
              updateThreadState(threadId, (state) => ({
                goalUi: {
                  goal: state.goalUi.goal,
                  events: mergeGoalUiEvents(state.goalUi.events, [liveEvent]),
                  lastUpdated: new Date()
                }
              }))
            }
            void refreshGoalUi(threadId, { includeEvents: !liveEvent })
          }
          break
        case "hook_blocked": {
          const reason =
            (typeof data.reason === "string" && data.reason.trim()) ||
            (typeof data.message === "string" && data.message.trim()) ||
            "Hook 已阻断本轮"
          const action = data.action === "halt" ? "halt" : "block"
          const eventName =
            (typeof data.hookEvent === "string" && data.hookEvent) ||
            (typeof data.event === "string" && data.event) ||
            "Hook"
          const systemMessage =
            typeof data.systemMessage === "string" && data.systemMessage.trim()
              ? data.systemMessage
              : undefined
          updateThreadState(threadId, () => ({
            error: null,
            hookInterruption: {
              event: eventName,
              action,
              reason,
              systemMessage,
              timestamp: new Date()
            }
          }))
          toast.warning(action === "halt" ? `Hook 已停止本轮：${reason}` : `Hook 已阻断：${reason}`)
          break
        }
        case "auto_commit_result":
          if (data.result) {
            const message = formatAutoCommitText(data.result)
            if (data.result.status === "committed") {
              toast.success(message || "自动提交成功")
            } else if (data.result.status === "failed") {
              toast.error(message || "自动提交失败")
            } else if (data.result.status === "skipped") {
              toast.info(message || "自动提交已跳过")
            }
          }
          break
        case "hook_executed": {
          const entry: HookLogEntry = {
            id: `${Date.now()}-${Math.random()}`,
            kind: data.kind === "skipped" ? "skipped" : "executed",
            event: data.event ?? "",
            hookType: data.hookType ?? "command",
            label: data.label ?? "",
            command: data.command,
            toolSuffix: data.toolSuffix ?? "",
            pluginId: data.pluginId,
            pluginName: data.pluginName,
            skillName: data.skillName,
            skillPath: data.skillPath,
            hookSourcePath: data.hookSourcePath,
            cwd: data.cwd,
            durationMs: data.durationMs,
            exitCode: data.exitCode ?? null,
            blocked: data.blocked ?? false,
            continue: data.continue,
            stopReason: data.stopReason,
            decision: data.decision,
            reason: data.reason,
            stdout: data.stdout ?? "",
            stderr: data.stderr ?? "",
            additionalContext: data.additionalContext,
            systemMessage: data.systemMessage,
            stdinPayload: data.stdinPayload,
            skipReason: data.skipReason,
            timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
            turnId: data.turnId
          }
          // Prefer the explicit turn id from main. Falling back to the latest
          // bucket keeps legacy/background events visible, but normal chat
          // turns no longer drift when async hook events arrive late.
          //
          // IMPORTANT: we MUST produce a new outer array (and a new bucket
          // object). useSyncExternalStore compares the snapshot by reference
          // identity — mutating bucket.entries in place would leave the outer
          // array pointer unchanged and the chip would never re-render.
          // Bucket assignment rules:
          //   1. entry.turnId matches an existing bucket → append.
          //   2. entry.turnId set but no matching bucket → create a new
          //      "earlier hook event" bucket (subject to ring trim).
          //   3. entry.turnId missing → create / append to a dedicated
          //      background-events bucket. Older code routed these to
          //      `buckets[last]` which polluted whichever user turn happened
          //      to be most recent (e.g. SessionStart firing after a new
          //      conversation began would inflate the previous chip).
          const buckets = hookLogBucketsRef.current[threadId] ?? []
          const BACKGROUND_BUCKET_ID = "__background__"
          const trim = (list: HookLogBucket[]): HookLogBucket[] => {
            if (list.length > HOOK_LOG_BUCKET_RING_SIZE) {
              list.splice(0, list.length - HOOK_LOG_BUCKET_RING_SIZE)
            }
            return list
          }
          let nextBuckets: HookLogBucket[]
          if (entry.turnId) {
            const explicitIdx = buckets.findIndex((bucket) => bucket.turnId === entry.turnId)
            if (explicitIdx >= 0) {
              const target = buckets[explicitIdx]
              nextBuckets = [
                ...buckets.slice(0, explicitIdx),
                { ...target, entries: [...target.entries, entry] },
                ...buckets.slice(explicitIdx + 1)
              ]
            } else {
              nextBuckets = trim([
                ...buckets,
                {
                  turnId: entry.turnId,
                  turnPreview: "(较早的 Hook 事件)",
                  isPlaceholder: true,
                  startedAt: new Date(),
                  entries: [entry]
                }
              ])
            }
          } else {
            const bgIdx = buckets.findIndex((bucket) => bucket.turnId === BACKGROUND_BUCKET_ID)
            if (bgIdx >= 0) {
              const target = buckets[bgIdx]
              nextBuckets = [
                ...buckets.slice(0, bgIdx),
                { ...target, entries: [...target.entries, entry] },
                ...buckets.slice(bgIdx + 1)
              ]
            } else {
              // The background bucket has no corresponding user message so it
              // never gets "upgraded" — mark it placeholder anyway for any
              // future code that wants to treat it as not-a-real-turn.
              nextBuckets = trim([
                ...buckets,
                {
                  turnId: BACKGROUND_BUCKET_ID,
                  turnPreview: "(会话生命周期事件)",
                  isPlaceholder: true,
                  startedAt: new Date(),
                  entries: [entry]
                }
              ])
            }
          }
          hookLogBucketsRef.current[threadId] = nextBuckets
          notifyHookLogSubscribers(threadId)
          break
        }
        case "token_usage":
          // Only update if we have meaningful token values (> 0)
          // This prevents resetting the usage when streaming ends
          if (data.usage && data.usage.inputTokens !== undefined && data.usage.inputTokens > 0) {
            console.log("[ThreadContext] Token usage update:", {
              threadId,
              inputTokens: data.usage.inputTokens,
              outputTokens: data.usage.outputTokens,
              totalTokens: data.usage.totalTokens
            })
            updateThreadState(threadId, () => {
              const newInputTokens = data.usage!.inputTokens || 0

              return {
                tokenUsage: {
                  inputTokens: newInputTokens,
                  outputTokens: data.usage!.outputTokens || 0,
                  totalTokens: data.usage!.totalTokens || 0,
                  cacheReadTokens: data.usage!.cacheReadTokens,
                  cacheCreationTokens: data.usage!.cacheCreationTokens,
                  lastUpdated: new Date()
                }
              }
            })
          }
          break
      }
    },
    [
      flushGoalSubturnComplete,
      getOrCreateLiveStreamAccumulator,
      notifyHookLogSubscribers,
      refreshGoalUi,
      scheduleCoordinatorNotificationTurn,
      updateThreadState
    ]
  )

  const getThreadActions = useCallback(
    (threadId: string): ThreadActions => {
      if (actionsCache.current[threadId]) {
        return actionsCache.current[threadId]
      }

      const actions: ThreadActions = {
        appendMessage: (message: Message) => {
          // Open a new hook-log bucket for each user turn instead of clearing.
          // Old buckets stay around (up to HOOK_LOG_BUCKET_RING_SIZE) so a
          // user can scroll back and inspect what hooks ran in earlier turns.
          if (message.role === "user") {
            coordinatorNotificationAutoRunSuppressedRef.current.delete(threadId)
            const suppressTimer = coordinatorNotificationSuppressTimersRef.current[threadId]
            if (suppressTimer !== undefined) {
              window.clearTimeout(suppressTimer)
            }
            delete coordinatorNotificationSuppressTimersRef.current[threadId]
            openHookLogBucket(threadId, message)
          }
          updateThreadState(threadId, (state) => {
            const exists = state.messages.some((m) => m.id === message.id)
            let nextToolCallStates = state.toolCallStates
            if (Array.isArray(message.tool_calls)) {
              for (const toolCall of message.tool_calls) {
                nextToolCallStates = upsertToolCallState(nextToolCallStates, toolCall.id, {
                  name: toolCall.name,
                  args: toolCall.args,
                  status: "queued"
                })
              }
            }
            if (message.role === "tool" && message.tool_call_id) {
              nextToolCallStates = upsertToolCallState(nextToolCallStates, message.tool_call_id, {
                name: message.name,
                status: message.is_error ? "failed" : "completed"
              })
            }
            if (exists) {
              return {
                messages: state.messages.map((m) => (m.id === message.id ? message : m)),
                toolCallStates: nextToolCallStates,
                hookInterruption: message.role === "user" ? null : state.hookInterruption
              }
            }
            return {
              messages: [...state.messages, message],
              toolCallStates: nextToolCallStates,
              hookInterruption: message.role === "user" ? null : state.hookInterruption
            }
          })
        },
        setMessages: (messages: Message[]) => {
          updateThreadState(threadId, (state) => {
            const nextToolCallStates = messages.reduce<Record<string, ToolCallState>>(
              (acc, message) => {
                if (Array.isArray(message.tool_calls)) {
                  for (const toolCall of message.tool_calls) {
                    acc = upsertToolCallState(acc, toolCall.id, {
                      name: toolCall.name,
                      args: toolCall.args,
                      status: "queued"
                    })
                  }
                }
                if (message.role === "tool" && message.tool_call_id) {
                  acc = upsertToolCallState(acc, message.tool_call_id, {
                    name: message.name,
                    status: message.is_error ? "failed" : "completed"
                  })
                }
                return acc
              },
              state.toolCallStates
            )

            return { messages, toolCallStates: nextToolCallStates }
          })
        },
        setTurnTimings: (turnTimings: TurnTiming[], options?: SetTurnTimingsOptions) => {
          updateThreadState(threadId, () => ({ turnTimings }))
          if (options?.persist === false) return

          window.api.threads
            .get(threadId)
            .then((thread) => {
              if (!thread) return
              return window.api.threads.update(threadId, {
                thread_values: {
                  ...(thread.thread_values || {}),
                  [TURN_TIMINGS_THREAD_VALUE_KEY]: turnTimings
                }
              })
            })
            .catch((error) => {
              console.warn("[ThreadContext] Failed to persist turn timings:", error)
            })
        },
        setGoalUi: (goalUi: GoalUiState) => {
          updateThreadState(threadId, () => ({ goalUi }))
        },
        refreshGoalUi: (options = {}) => refreshGoalUi(threadId, options),
        setTodos: (todos: Todo[]) => {
          updateThreadState(threadId, () => ({ todos }))
        },
        setWorkspaceFiles: (files: FileInfo[] | ((prev: FileInfo[]) => FileInfo[])) => {
          updateThreadState(threadId, (state) => ({
            workspaceFiles: typeof files === "function" ? files(state.workspaceFiles) : files
          }))
        },
        setWorkspacePath: (path: string | null) => {
          updateThreadState(threadId, (state) =>
            state.workspacePath === path
              ? { workspacePath: path }
              : { workspacePath: path, coordinatorWorkers: [] }
          )
        },
        setGitContext: (context: ThreadGitContext | null) => {
          updateThreadState(threadId, () => ({ gitContext: context }))
        },
        setSubagents: (subagents: Subagent[]) => {
          updateThreadState(threadId, () => ({ subagents }))
        },
        setToolCallState: (toolCallId: string, updates: Partial<ToolCallState>) => {
          updateThreadState(threadId, (state) => ({
            toolCallStates: upsertToolCallState(state.toolCallStates, toolCallId, updates)
          }))
        },
        setPendingApproval: (request: HITLRequest | null) => {
          updateThreadState(threadId, (state) => ({
            ...buildPendingApprovalState(request ? [request] : []),
            ...(request
              ? {
                  toolCallStates: upsertToolCallStateFromRequest(
                    state.toolCallStates,
                    request as HITLRequest & Record<string, unknown>
                  )
                }
              : {})
          }))
        },
        enqueuePendingApproval: (request: HITLRequest) => {
          updateThreadState(threadId, (state) => ({
            ...buildPendingApprovalState(enqueuePendingApproval(state.pendingApprovals, request)),
            toolCallStates: upsertToolCallStateFromRequest(
              state.toolCallStates,
              request as HITLRequest & Record<string, unknown>
            )
          }))
        },
        removePendingApproval: (requestId?: string) => {
          updateThreadState(threadId, (state) =>
            buildPendingApprovalState(advancePendingApproval(state.pendingApprovals, requestId))
          )
        },
        clearPendingApprovals: () => {
          updateThreadState(threadId, () => buildPendingApprovalState([]))
        },
        setPendingUserInput: (request: UserInputRequest | null) => {
          updateThreadState(threadId, () => ({ pendingUserInput: request }))
        },
        setError: (error: string | null) => {
          updateThreadState(threadId, () => ({ error }))
        },
        clearError: () => {
          updateThreadState(threadId, () => ({ error: null }))
        },
        clearHookInterruption: () => {
          updateThreadState(threadId, () => ({ hookInterruption: null }))
        },
        setCurrentModel: (modelId: string) => {
          updateThreadState(threadId, () => ({ currentModel: modelId }))
          // Persist to backend
          window.api.threads.get(threadId).then((thread) => {
            if (thread) {
              const metadata = thread.metadata || {}
              window.api.threads.update(threadId, {
                metadata: { ...metadata, model: modelId }
              })
            }
          })
        },
        openFile: (path: string, name: string) => {
          updateThreadState(threadId, (state) => {
            if (state.openFiles.some((f) => f.path === path)) {
              return { activeTab: path }
            }
            return { openFiles: [...state.openFiles, { path, name }], activeTab: path }
          })
        },
        closeFile: (path: string) => {
          updateThreadState(threadId, (state) => {
            const newOpenFiles = state.openFiles.filter((f) => f.path !== path)
            const newFileContents = { ...state.fileContents }
            delete newFileContents[path]
            let newActiveTab = state.activeTab
            if (state.activeTab === path) {
              const closedIndex = state.openFiles.findIndex((f) => f.path === path)
              if (newOpenFiles.length === 0) newActiveTab = "agent"
              else if (closedIndex > 0) newActiveTab = newOpenFiles[closedIndex - 1].path
              else newActiveTab = newOpenFiles[0].path
            }
            return {
              openFiles: newOpenFiles,
              activeTab: newActiveTab,
              fileContents: newFileContents
            }
          })
        },
        setActiveTab: (tab: "agent" | string) => {
          updateThreadState(threadId, () => ({ activeTab: tab }))
        },
        setFileContents: (path: string, content: string) => {
          updateThreadState(threadId, (state) => ({
            fileContents: { ...state.fileContents, [path]: content }
          }))
        },
        setDraftInput: (input: string) => {
          updateThreadState(threadId, () => ({ draftInput: input }))
        },
        setDraftSkill: (skill: SkillMetadata | null) => {
          updateThreadState(threadId, () => ({ draftSkill: skill }))
        }
      }

      actionsCache.current[threadId] = actions
      return actions
    },
    [openHookLogBucket, refreshGoalUi, updateThreadState]
  )

  const loadThreadHistory = useCallback(
    async (threadId: string) => {
      const actions = getThreadActions(threadId)
      let persistedMessageTimes: MessageTimeMap = {}
      let persistedInternalGoalMessageTimes: MessageTimeMap = {}
      let persistedInternalGoalMessageTimeOrder: MessageTimeEntry[] = []
      let persistedMessageTimeOrder: MessageTimeEntry[] = []
      let rawRestoredMessages: Message[] = []
      let restoredMessages: Message[] = []
      let restoredGoalEvents: GoalNoticeEvent[] = []
      let skipCheckpointPendingApproval = false
      let latestTrustedCheckpointMessageAt: Date | undefined
      updateThreadState(threadId, () => ({ historyLoading: true }))

      // Load workspace path and thread metadata
      try {
        const thread = await window.api.threads.get(threadId)
        if (thread) {
          persistedMessageTimes = getMessageTimeMap(thread.thread_values)
          persistedInternalGoalMessageTimes = getInternalGoalMessageTimeMap(thread.thread_values)
          persistedInternalGoalMessageTimeOrder = getInternalGoalMessageTimeOrder(
            thread.thread_values
          )
          persistedMessageTimeOrder = getMessageTimeOrder(thread.thread_values)
          const metadata = thread.metadata || {}
          actions.setTurnTimings(getTurnTimings(thread.thread_values), { persist: false })
          actions.setGitContext(getGitContextFromMetadata(metadata))
          if (metadata.workspacePath) {
            const workspacePath = metadata.workspacePath as string
            actions.setWorkspacePath(workspacePath)
            // 文件树仅用于侧边栏/文件面板展示，和聊天历史恢复解耦后可显著缩短首屏等待。
            loadWorkspaceFilesInBackground(threadId, workspacePath)
          }
          // Restore the effective model: prefer the routing-resolved model (smart routing),
          // fall back to user's pinned model selection.
          const routingState = metadata.routingState as
            | { lastResolvedModelId?: string; lastResolvedTier?: string }
            | undefined
          const effectiveModel =
            routingState?.lastResolvedModelId || (metadata.model as string) || ""
          if (effectiveModel) {
            updateThreadState(threadId, () => ({
              currentModel: effectiveModel,
              ...(routingState?.lastResolvedModelId
                ? {
                    routingResult: {
                      resolvedModelId: routingState.lastResolvedModelId!,
                      resolvedTier:
                        (routingState.lastResolvedTier as "premium" | "economy") ?? "premium",
                      routeReason: "restored from thread state"
                    }
                  }
                : {})
            }))
          }
          if (metadata.scheduledTaskId) {
            const taskId = metadata.scheduledTaskId as string
            updateThreadState(threadId, () => ({ scheduledTaskId: taskId }))
            window.api.scheduledTasks
              .isRunning(taskId)
              .then((running) => {
                if (running) {
                  updateThreadState(threadId, () => ({ scheduledTaskLoading: true }))
                }
              })
              .catch(() => {})
          }
          if (metadata.isHeartbeat) {
            window.api.heartbeat
              .isRunning()
              .then((running) => {
                if (running) {
                  updateThreadState(threadId, () => ({ scheduledTaskLoading: true }))
                }
              })
              .catch(() => {})
          }

          window.api.agent
            .getCoordinatorWorkers(threadId, { subscribeUpdates: false })
            .then((workers) => {
              updateThreadState(threadId, (prev) => ({
                coordinatorWorkers: mergeCoordinatorWorkers(prev.coordinatorWorkers, workers, {
                  authoritative: true
                })
              }))
            })
            .catch((error) => {
              console.warn("[ThreadContext] Failed to load coordinator workers:", error)
            })
          window.api.agent
            .hasCoordinatorWorkerNotifications(threadId)
            .then((hasPending) => {
              if (hasPending) scheduleCoordinatorNotificationTurn(threadId)
            })
            .catch((error) => {
              console.warn("[ThreadContext] Failed to check coordinator notifications:", error)
            })
        }
      } catch (error) {
        console.error("[ThreadContext] Failed to load thread details:", error)
      }

      try {
        restoredGoalEvents = await window.api.threads.getGoalEvents(threadId, { restore: true })
      } catch (error) {
        console.error("[ThreadContext] Failed to load goal events:", error)
      }

      // Load thread history from checkpoints
      try {
        const history = await window.api.threads.getHistory(threadId)
        if (history.length > 0) {
          const latestCheckpoint = history[0] as {
            checkpoint?: {
              channel_values?: {
                messages?: Array<{
                  id?: string | string[]
                  _getType?: () => string
                  type?: string
                  content?: string | unknown[]
                  tool_calls?: unknown[]
                  tool_call_id?: string
                  name?: string
                  additional_kwargs?: Record<string, unknown>
                  kwargs?: {
                    id?: string
                    type?: string
                    content?: string | unknown[]
                    tool_calls?: unknown[]
                    tool_call_id?: string
                    name?: string
                    additional_kwargs?: Record<string, unknown>
                  }
                }>
                todos?: Array<{ id?: string; content?: string; status?: string }>
                __interrupt__?: Array<{
                  value?: {
                    actionRequests?: Array<{
                      action: string
                      args: Record<string, unknown>
                    }>
                    reviewConfigs?: Array<{
                      toolName: string
                      toolArgs: Record<string, unknown>
                    }>
                  }
                }>
              }
            }
            pending_sends?: Array<unknown>
          }

          const channelValues = latestCheckpoint.checkpoint?.channel_values

          if (channelValues?.messages && Array.isArray(channelValues.messages)) {
            let internalGoalPromptIndex = 0
            rawRestoredMessages = channelValues.messages.flatMap((msg, index): Message | [] => {
              const additionalKwargs = msg.additional_kwargs ?? msg.kwargs?.additional_kwargs
              if (additionalKwargs?.cmb_internal_coordinator_notification === true) {
                return []
              }

              let role: "user" | "assistant" | "system" | "tool" = "assistant"
              if (typeof msg._getType === "function") {
                const type = msg._getType()
                if (type === "human") role = "user"
                else if (type === "ai") role = "assistant"
                else if (type === "system") role = "system"
                else if (type === "tool") role = "tool"
              } else if (Array.isArray(msg.id)) {
                const constructorName = msg.id[msg.id.length - 1]
                if (constructorName === "HumanMessage") role = "user"
                else if (constructorName === "SystemMessage") role = "system"
                else if (constructorName === "ToolMessage") role = "tool"
                else if (constructorName === "AIMessage" || constructorName === "AIMessageChunk")
                  role = "assistant"
              } else if (msg.type) {
                if (msg.type === "human") role = "user"
                else if (msg.type === "ai") role = "assistant"
                else if (msg.type === "system") role = "system"
                else if (msg.type === "tool") role = "tool"
              }

              let content: Message["content"] = ""
              const visibleUserMessage = additionalKwargs?.cmb_visible_user_message
              const rawContent =
                role === "user" &&
                typeof visibleUserMessage === "string" &&
                visibleUserMessage.length > 0
                  ? visibleUserMessage
                  : (msg.content ?? msg.kwargs?.content)
              if (typeof rawContent === "string") content = rawContent
              else if (Array.isArray(rawContent)) content = rawContent as Message["content"]

              const toolCalls = msg.tool_calls ?? msg.kwargs?.tool_calls
              const toolCallId = msg.tool_call_id ?? msg.kwargs?.tool_call_id
              const toolName = msg.name ?? msg.kwargs?.name
              const messageId =
                msg.kwargs?.id ?? (typeof msg.id === "string" ? msg.id : `msg-${index}`)
              const fallbackTime = new Date()
              // Visible messages only use id-based restore here. Their order fallback
              // is applied after hidden internal goal prompts are replaced/filtered and
              // restored /goal user bubbles are inserted, otherwise messageTimeOrder
              // indexes can shift across the final transcript.
              // Internal goal prompts have a separate order list because they are hidden
              // from the checkpoint transcript but still anchor restored /goal user bubbles.
              const isInternalGoalPrompt =
                role === "user" &&
                typeof content === "string" &&
                isInternalGoalPromptMessage({ role, content })
              const currentInternalGoalPromptIndex = isInternalGoalPrompt
                ? internalGoalPromptIndex++
                : -1
              const { startAt, endAt } = restoreRawCheckpointMessageTime({
                messageId,
                fallbackTime,
                isInternalGoalPrompt,
                internalGoalPromptIndex: currentInternalGoalPromptIndex,
                persistedMessageTimes,
                persistedInternalGoalMessageTimes,
                persistedInternalGoalMessageTimeOrder
              })

              return {
                id: messageId,
                role,
                content,
                tool_calls: toolCalls as Message["tool_calls"],
                ...(role === "tool" && toolCallId && { tool_call_id: toolCallId }),
                ...(role === "tool" && toolName && { name: toolName }),
                created_at: startAt,
                start_at: startAt,
                end_at: endAt
              }
            })

            const visibleRestoredMessages = rawRestoredMessages.filter(
              isVisibleCheckpointTranscriptMessage
            )
            latestTrustedCheckpointMessageAt = getLatestTrustedCheckpointMessageAt(
              visibleRestoredMessages,
              persistedMessageTimes,
              persistedMessageTimeOrder,
              persistedInternalGoalMessageTimes,
              persistedInternalGoalMessageTimeOrder,
              rawRestoredMessages
            )
            restoredMessages = visibleRestoredMessages
          }

          if (channelValues?.todos && Array.isArray(channelValues.todos)) {
            const todos: Todo[] = channelValues.todos.map((todo, index) => ({
              id: todo.id || `todo-${index}`,
              content: todo.content || "",
              status: (todo.status as Todo["status"]) || "pending"
            }))
            actions.setTodos(todos)
          }

          // Restore interrupt state if present
          skipCheckpointPendingApproval = shouldSuppressCheckpointApprovalRestore(
            restoredGoalEvents,
            latestTrustedCheckpointMessageAt
          )
          const interruptData = channelValues?.__interrupt__
          if (
            !skipCheckpointPendingApproval &&
            interruptData &&
            Array.isArray(interruptData) &&
            interruptData.length > 0
          ) {
            const interruptValue = interruptData[0]?.value
            const actionRequests = interruptValue?.actionRequests
            const reviewConfigs = interruptValue?.reviewConfigs

            if (actionRequests && actionRequests.length > 0) {
              // New langchain HITL format
              const req = actionRequests[0]
              const hitlRequest: HITLRequest = {
                id: crypto.randomUUID(),
                tool_call: {
                  id: crypto.randomUUID(),
                  name: req.action,
                  args: req.args
                },
                allowed_decisions: ["approve", "reject", "edit"],
                allowRuntimeRestoredCheckpointResume: false
              }
              actions.setPendingApproval(hitlRequest)
            } else if (reviewConfigs && reviewConfigs.length > 0) {
              // Alternative format
              const config = reviewConfigs[0]
              const hitlRequest: HITLRequest = {
                id: crypto.randomUUID(),
                tool_call: {
                  id: crypto.randomUUID(),
                  name: config.toolName,
                  args: config.toolArgs
                },
                allowed_decisions: ["approve", "reject", "edit"],
                allowRuntimeRestoredCheckpointResume: false
              }
              actions.setPendingApproval(hitlRequest)
            }
          }
        }
      } catch (error) {
        console.error("[ThreadContext] Failed to load thread history:", error)
      }

      const checkpointTranscript = buildRestoredCheckpointTranscript(
        rawRestoredMessages,
        restoredMessages,
        goalNoticeEventsToGoalUiEvents(threadId, restoredGoalEvents)
      )
      actions.setMessages(
        restoreVisibleCheckpointMessageTimes(
          checkpointTranscript,
          persistedMessageTimes,
          persistedMessageTimeOrder
        )
      )
      try {
        const goalUi = await window.api.threads.getGoalState(threadId, { includeEvents: false })
        const restoredEvents = goalNoticeEventsToGoalUiEvents(threadId, restoredGoalEvents)
        updateThreadState(threadId, (state) => ({
          goalUi: {
            goal: goalUi.goal,
            events: mergeGoalUiEvents(restoredEvents, state.goalUi.events),
            lastUpdated: new Date()
          }
        }))
      } catch (error) {
        console.warn("[ThreadContext] Failed to load goal UI state:", error)
        const restoredEvents = goalNoticeEventsToGoalUiEvents(threadId, restoredGoalEvents)
        updateThreadState(threadId, (state) => ({
          goalUi: {
            goal: state.goalUi.goal,
            events: mergeGoalUiEvents(restoredEvents, state.goalUi.events),
            lastUpdated: new Date()
          }
        }))
      }

      seedLiveStreamBaselineFromCheckpoint(threadId, rawRestoredMessages)
      updateThreadState(threadId, () => ({ historyLoading: false }))

      const pendingGoalSubturnMessages =
        liveStreamAccumulatorsRef.current[threadId]?.pendingGoalSubturnMessages.splice(0) ?? []
      for (const pendingMessages of pendingGoalSubturnMessages) {
        flushGoalSubturnComplete(threadId, pendingMessages)
      }

      const currentStreamData = streamDataRef.current[threadId]
      if (
        currentStreamData &&
        (currentStreamData.isLoading || currentStreamData.messages.length > 0)
      ) {
        handleStreamUpdate(threadId, currentStreamData, {
          ignoreHistoryLoading: true,
          preserveExistingBaseline: true,
          finalizeCachedSnapshot: !currentStreamData.isLoading
        })
      }
    },
    [
      flushGoalSubturnComplete,
      getThreadActions,
      handleStreamUpdate,
      loadWorkspaceFilesInBackground,
      scheduleCoordinatorNotificationTurn,
      seedLiveStreamBaselineFromCheckpoint,
      updateThreadState
    ]
  )

  // Track passive scheduler/heartbeat stream listeners per thread
  const schedulerListenerCleanups = useRef<Record<string, () => void>>({})
  const heartbeatListenerCleanups = useRef<Record<string, () => void>>({})
  // Track approval listeners per thread (registered globally, not per-component)
  const approvalListenerCleanups = useRef<Record<string, Array<() => void>>>({})
  // Track request_user_input listeners per thread.
  const userInputListenerCleanups = useRef<Record<string, Array<() => void>>>({})

  // Track streaming AI message state per thread (for token-by-token accumulation)
  const schedulerStreamingRef = useRef<
    Record<string, { currentMsgId: string | null; accumulatedContent: string }>
  >({})

  // Process standardised events from scheduler (produced by StreamConverter)
  const processSchedulerEvent = useCallback(
    (threadId: string, event: { type: string; [key: string]: unknown }) => {
      // Lifecycle events
      if (event.type === "done") {
        delete schedulerStreamingRef.current[threadId]
        updateThreadState(threadId, () => ({ scheduledTaskLoading: false }))
        loadThreadHistory(threadId)
        return
      }
      if (event.type === "error") {
        delete schedulerStreamingRef.current[threadId]
        updateThreadState(threadId, () => ({
          scheduledTaskLoading: false,
          error: (event.error as string) || "Scheduled task failed"
        }))
        return
      }

      // "started" fires before agent runtime creation — show loading immediately.
      // Hook-log buckets are now per-turn and not cleared here; the new bucket
      // is opened when the scheduled task's user message lands via appendMessage.
      if (event.type === "started") {
        updateThreadState(threadId, () => ({ scheduledTaskLoading: true }))
        return
      }

      // Mark as loading on first data event
      updateThreadState(threadId, (prev) => {
        if (prev.scheduledTaskLoading) return {}
        return { scheduledTaskLoading: true }
      })

      switch (event.type) {
        // Reuse handleCustomEvent for workspace / subagents / token_usage / interrupt
        case "custom":
          handleCustomEvent(threadId, event.data as CustomEventData)
          break

        // Full message list from a values snapshot
        case "full-messages": {
          delete schedulerStreamingRef.current[threadId]
          const msgs = event.messages as Array<{
            id: string
            role: string
            content: string
            tool_calls?: unknown[]
            tool_call_id?: string
            name?: string
            is_error?: boolean
          }>
          const nextToolCallStates = msgs.reduce<Record<string, ToolCallState>>((acc, msg) => {
            if (Array.isArray(msg.tool_calls)) {
              for (const toolCall of msg.tool_calls as Array<{
                id?: string
                name?: string
                args?: Record<string, unknown>
              }>) {
                if (!toolCall.id) continue
                acc = upsertToolCallState(acc, toolCall.id, {
                  name: toolCall.name,
                  args: toolCall.args,
                  status: "queued"
                })
              }
            }
            if (msg.role === "tool" && msg.tool_call_id) {
              acc = upsertToolCallState(acc, msg.tool_call_id, {
                name: msg.name,
                status: msg.is_error ? "failed" : "completed"
              })
            }
            return acc
          }, {})
          updateThreadState(threadId, () => ({
            messages: msgs.map((m) => {
              const now = new Date()
              return { ...m, created_at: now } as Message
            }),
            toolCallStates: nextToolCallStates
          }))
          break
        }

        // Todos from a values snapshot
        case "todos": {
          const todos = event.todos as Array<{
            id?: string
            content?: string
            status?: string
          }>
          updateThreadState(threadId, () => ({
            todos: todos.map((t) => ({
              id: t.id || crypto.randomUUID(),
              content: t.content || "",
              status: (t.status || "pending") as
                | "pending"
                | "in_progress"
                | "completed"
                | "cancelled"
            }))
          }))
          break
        }

        // Incremental AI message token
        case "message-delta": {
          const id = event.id as string
          const content = event.content as string
          const toolCalls = event.toolCalls as Message["tool_calls"] | undefined
          const tracker = (schedulerStreamingRef.current[threadId] ||= {
            currentMsgId: null,
            accumulatedContent: ""
          })
          if (id !== tracker.currentMsgId) {
            tracker.currentMsgId = id
            tracker.accumulatedContent = content
          } else {
            tracker.accumulatedContent += content
          }
          const finalContent = tracker.accumulatedContent
          updateThreadState(threadId, (prev) => {
            const nextToolCallStates = (toolCalls || []).reduce<Record<string, ToolCallState>>(
              (acc, toolCall) =>
                upsertToolCallState(acc, toolCall.id, {
                  name: toolCall.name,
                  args: toolCall.args,
                  status: "queued"
                }),
              prev.toolCallStates
            )
            const idx = prev.messages.findIndex((m) => m.id === id)
            // Defensive clear: any real assistant token means data is flowing
            // again, so a stale retry indicator must disappear.
            const clearRetry = prev.modelRetry ? { modelRetry: null } : {}
            if (idx >= 0) {
              const updated = [...prev.messages]
              updated[idx] = {
                ...updated[idx],
                content: finalContent,
                ...(toolCalls?.length && { tool_calls: toolCalls })
              }
              return { ...clearRetry, messages: updated, toolCallStates: nextToolCallStates }
            }
            const now = new Date()
            return {
              ...clearRetry,
              toolCallStates: nextToolCallStates,
              messages: [
                ...prev.messages,
                {
                  id,
                  role: "assistant" as const,
                  content: finalContent,
                  ...(toolCalls?.length && { tool_calls: toolCalls }),
                  created_at: now
                }
              ]
            }
          })
          break
        }

        // Tool result message
        case "tool-message": {
          const id = event.id as string
          const content = event.content as string
          const toolCallId = event.toolCallId as string
          const name = event.name as string | undefined
          const isError = event.isError as boolean | undefined
          const now = new Date()
          updateThreadState(threadId, (prev) => {
            if (prev.messages.some((m) => m.id === id)) return {}
            return {
              toolCallStates: upsertToolCallState(prev.toolCallStates, toolCallId, {
                name,
                status: isError ? "failed" : "completed"
              }),
              messages: [
                ...prev.messages,
                {
                  id,
                  role: "tool" as const,
                  content,
                  tool_call_id: toolCallId,
                  name,
                  is_error: isError,
                  created_at: now
                }
              ]
            }
          })
          break
        }
      }
    },
    [updateThreadState, loadThreadHistory, handleCustomEvent]
  )

  const initializeThread = useCallback(
    (threadId: string) => {
      if (initializedThreadsRef.current.has(threadId)) return
      initializedThreadsRef.current.add(threadId)

      // Add to active threads (this will render a ThreadStreamHolder)
      setActiveThreadIds((prev) => new Set([...prev, threadId]))

      setThreadStates((prev) => {
        if (prev[threadId]) return prev
        const next = {
          ...prev,
          [threadId]: { ...createDefaultThreadState(), historyLoading: true }
        }
        threadStatesRef.current = next
        return next
      })

      loadThreadHistory(threadId)

      // Register listeners synchronously so no stream events are missed
      if (threadId === "heartbeat") {
        const heartbeatCleanup = window.api.heartbeat.listenToStream(threadId, (event) => {
          processSchedulerEvent(threadId, event)
        })
        heartbeatListenerCleanups.current[threadId] = heartbeatCleanup
      } else {
        const schedulerCleanup = window.api.scheduledTasks.listenToStream(threadId, (event) => {
          processSchedulerEvent(threadId, event)
        })
        schedulerListenerCleanups.current[threadId] = schedulerCleanup
      }

      const cancelledApprovalRequestIds = new Set<string>()

      // Register global approval listeners for this thread (not tied to ChatContainer mount)
      const cleanupApproval = window.api.sandbox.onApprovalRequest(threadId, (request: unknown) => {
        console.log(`[ThreadProvider] Approval request for thread ${threadId}:`, request)
        if (!initializedThreadsRef.current.has(threadId)) return
        const approvalRequest = normalizeApprovalPayload(request)
        if (cancelledApprovalRequestIds.has(getPendingApprovalId(approvalRequest))) return
        updateThreadState(threadId, (state) => {
          return {
            ...buildPendingApprovalState(
              enqueuePendingApproval(state.pendingApprovals, approvalRequest)
            ),
            toolCallStates: upsertToolCallStateFromRequest(state.toolCallStates, approvalRequest)
          }
        })
        // Auto-switch to this thread so the approval UI is visible
        const currentId = useAppStore.getState().currentThreadId
        if (currentId !== threadId) {
          console.log(`[ThreadProvider] Auto-switching to thread ${threadId} for pending approval`)
          useAppStore.getState().selectThread(threadId)
        }
      })
      const cleanupTimeout = window.api.sandbox.onApprovalTimeout(threadId, (data) => {
        console.warn(
          `[ThreadProvider] Approval timed out for thread ${threadId}: requestId=${data.requestId}`
        )
        if (!initializedThreadsRef.current.has(threadId)) return
        cancelledApprovalRequestIds.add(data.requestId)
        updateThreadState(threadId, (state) => {
          const timedOutApproval = state.pendingApprovals.find(
            (approval) => getPendingApprovalId(approval) === data.requestId
          )
          return {
            ...removePendingApprovalByRequestId(state, data.requestId),
            ...(timedOutApproval?.tool_call?.id
              ? {
                  toolCallStates: upsertToolCallState(
                    state.toolCallStates,
                    timedOutApproval.tool_call.id,
                    { status: "interrupted" }
                  )
                }
              : {})
          }
        })
      })
      const cleanupCancel = window.api.sandbox.onApprovalCancel(threadId, (data) => {
        console.log(
          `[ThreadProvider] Approval cancelled for thread ${threadId}: requestId=${data.requestId}, reason=${data.reason ?? "unknown"}`
        )
        if (!initializedThreadsRef.current.has(threadId)) return
        cancelledApprovalRequestIds.add(data.requestId)
        updateThreadState(threadId, (state) => {
          const cancelledApproval = state.pendingApprovals.find(
            (approval) => getPendingApprovalId(approval) === data.requestId
          )
          return {
            ...buildPendingApprovalState(
              removePendingApproval(state.pendingApprovals, data.requestId)
            ),
            ...(cancelledApproval?.tool_call?.id
              ? {
                  toolCallStates: upsertToolCallState(
                    state.toolCallStates,
                    cancelledApproval.tool_call.id,
                    { status: "interrupted" }
                  )
                }
              : {})
          }
        })
      })
      approvalListenerCleanups.current[threadId] = [cleanupApproval, cleanupTimeout, cleanupCancel]
      window.api.sandbox
        .getPendingApprovals(threadId)
        .then((requests) => {
          if (!initializedThreadsRef.current.has(threadId)) return
          if (!Array.isArray(requests) || requests.length === 0) return
          const approvalRequests = requests
            .map((request) => normalizeApprovalPayload(request))
            .filter((request) => !cancelledApprovalRequestIds.has(getPendingApprovalId(request)))
          if (approvalRequests.length === 0) return
          updateThreadState(threadId, (state) => {
            let pendingApprovals = state.pendingApprovals
            let toolCallStates = state.toolCallStates
            for (const approvalRequest of approvalRequests) {
              pendingApprovals = enqueuePendingApproval(pendingApprovals, approvalRequest)
              toolCallStates = upsertToolCallStateFromRequest(toolCallStates, approvalRequest)
            }
            return {
              ...buildPendingApprovalState(pendingApprovals),
              toolCallStates
            }
          })
          const currentId = useAppStore.getState().currentThreadId
          if (currentId !== threadId && initializedThreadsRef.current.has(threadId)) {
            console.log(
              `[ThreadProvider] Auto-switching to thread ${threadId} for restored pending approval`
            )
            useAppStore.getState().selectThread(threadId)
          }
        })
        .catch((error) => {
          console.warn(
            `[ThreadProvider] Failed to restore pending approvals for thread ${threadId}:`,
            error
          )
        })

      const cleanupUserInput = window.api.userInput.onRequest(threadId, (request) => {
        console.log(`[ThreadProvider] User input request for thread ${threadId}:`, request)
        updateThreadState(threadId, () => ({ pendingUserInput: request }))
      })
      const cleanupUserInputCancel = window.api.userInput.onCancel(threadId, (data) => {
        console.log(
          `[ThreadProvider] User input cancelled for thread ${threadId}: requestId=${data.requestId}`
        )
        updateThreadState(threadId, (state) => {
          if (state.pendingUserInput?.requestId !== data.requestId) return {}
          return { pendingUserInput: null }
        })
      })
      userInputListenerCleanups.current[threadId] = [cleanupUserInput, cleanupUserInputCancel]
    },
    [loadThreadHistory, processSchedulerEvent, updateThreadState]
  )

  useEffect(() => {
    const previousThreadId = previousCurrentThreadIdRef.current
    if (previousThreadId && previousThreadId !== currentThreadId) {
      void window.api.agent.unbindCoordinatorWorkers(previousThreadId).catch((error: unknown) => {
        console.warn(
          "[ThreadProvider] Failed to unbind inactive coordinator worker updates:",
          error
        )
      })
    }
    previousCurrentThreadIdRef.current = currentThreadId

    if (!currentThreadId) return

    let cancelled = false
    void window.api.agent
      .getCoordinatorWorkers(currentThreadId, { subscribeUpdates: true })
      .then((workers) => {
        if (cancelled) return
        updateThreadState(currentThreadId, (prev) => {
          const merged = mergeCoordinatorWorkers(prev.coordinatorWorkers, workers, {
            authoritative: true
          })
          if (coordinatorWorkersEqual(prev.coordinatorWorkers, merged)) return {}
          return { coordinatorWorkers: merged }
        })
      })
      .catch((error) => {
        console.warn("[ThreadProvider] Failed to bind active coordinator worker updates:", error)
      })

    return () => {
      cancelled = true
    }
  }, [currentThreadId, updateThreadState])

  const cleanupThread = useCallback((threadId: string) => {
    void window.api.agent.unbindCoordinatorWorkers(threadId).catch((error: unknown) => {
      console.warn("[ThreadProvider] Failed to unbind coordinator worker updates:", error)
    })
    schedulerListenerCleanups.current[threadId]?.()
    delete schedulerListenerCleanups.current[threadId]
    heartbeatListenerCleanups.current[threadId]?.()
    delete heartbeatListenerCleanups.current[threadId]
    approvalListenerCleanups.current[threadId]?.forEach((c) => c())
    delete approvalListenerCleanups.current[threadId]
    userInputListenerCleanups.current[threadId]?.forEach((c) => c())
    delete userInputListenerCleanups.current[threadId]
    delete schedulerStreamingRef.current[threadId]
    const coordinatorNotificationTimer = coordinatorNotificationTimersRef.current[threadId]
    if (coordinatorNotificationTimer !== undefined) {
      window.clearTimeout(coordinatorNotificationTimer)
    }
    delete coordinatorNotificationTimersRef.current[threadId]
    delete coordinatorNotificationAttemptsRef.current[threadId]
    delete coordinatorNotificationRetryOnIdleRef.current[threadId]
    coordinatorNotificationAutoRunSuppressedRef.current.delete(threadId)
    const coordinatorNotificationSuppressTimer =
      coordinatorNotificationSuppressTimersRef.current[threadId]
    if (coordinatorNotificationSuppressTimer !== undefined) {
      window.clearTimeout(coordinatorNotificationSuppressTimer)
    }
    delete coordinatorNotificationSuppressTimersRef.current[threadId]

    initializedThreadsRef.current.delete(threadId)
    delete actionsCache.current[threadId]
    delete streamDataRef.current[threadId]
    delete streamSubscribersRef.current[threadId]
    delete hookLogBucketsRef.current[threadId]
    delete liveStreamAccumulatorsRef.current[threadId]
    delete checkpointFallbackIndexBaselinesRef.current[threadId]
    disableChatReportUploadForThread(threadId)
    delete hookLogsSubscribersRef.current[threadId]
    setActiveThreadIds((prev) => {
      const next = new Set(prev)
      next.delete(threadId)
      return next
    })
    setThreadStates((prev) => {
      const { [threadId]: _removed, ...rest } = prev
      void _removed // Explicitly mark as intentionally unused
      threadStatesRef.current = rest
      return rest
    })
  }, [])

  const contextValue = useMemo<ThreadContextValue>(
    () => ({
      getThreadState,
      getThreadActions,
      initializeThread,
      cleanupThread,
      subscribeToStream,
      getStreamData,
      subscribeToHookLogs,
      getHookLogBuckets,
      getAllThreadStates,
      getAllStreamLoadingStates,
      subscribeToAllStreams,
      suppressCoordinatorNotificationAutoRun
    }),
    [
      getThreadState,
      getThreadActions,
      initializeThread,
      cleanupThread,
      subscribeToStream,
      getStreamData,
      subscribeToHookLogs,
      getHookLogBuckets,
      getAllThreadStates,
      getAllStreamLoadingStates,
      subscribeToAllStreams,
      suppressCoordinatorNotificationAutoRun
    ]
  )

  return (
    <ThreadContext.Provider value={contextValue}>
      {/* Render stream holders for all active threads */}
      {Array.from(activeThreadIds).map((threadId) => (
        <ThreadStreamHolder
          key={threadId}
          threadId={threadId}
          fallbackIndexBaselines={mergeFallbackIndexBaselines(
            checkpointFallbackIndexBaselinesRef.current[threadId],
            fallbackIndexBaselinesFromMessages(threadStates[threadId]?.messages ?? [])
          )}
          onStreamUpdate={(data) => handleStreamUpdate(threadId, data)}
          onCustomEvent={(data) => handleCustomEvent(threadId, data)}
          onError={(error) => handleError(threadId, error)}
        />
      ))}
      {children}
    </ThreadContext.Provider>
  )
}

export function useThreadContext(): ThreadContextValue {
  const context = useContext(ThreadContext)
  if (!context) throw new Error("useThreadContext must be used within a ThreadProvider")
  return context
}

// Hook to subscribe to stream data for a thread using useSyncExternalStore
export function useThreadStream(threadId: string): StreamData {
  const context = useThreadContext()

  const subscribe = useCallback(
    (callback: () => void) => context.subscribeToStream(threadId, callback),
    [context, threadId]
  )

  const getSnapshot = useCallback(() => context.getStreamData(threadId), [context, threadId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Hook to access current thread's state and actions
export function useCurrentThread(threadId: string): ThreadState & ThreadActions {
  const context = useThreadContext()

  useEffect(() => {
    context.initializeThread(threadId)
  }, [threadId, context])

  const state = context.getThreadState(threadId)
  const actions = context.getThreadActions(threadId)

  return { ...state, ...actions }
}

// Hook for nullable threadId
export function useThreadState(threadId: string | null): (ThreadState & ThreadActions) | null {
  const context = useThreadContext()

  useEffect(() => {
    if (threadId) context.initializeThread(threadId)
  }, [threadId, context])

  if (!threadId) return null

  const state = context.getThreadState(threadId)
  const actions = context.getThreadActions(threadId)

  return { ...state, ...actions }
}

// Hook to get all initialized thread states (for kanban view)
export function useAllThreadStates(): Record<string, ThreadState> {
  const context = useThreadContext()
  return context.getAllThreadStates()
}

// Hook to get all stream loading states with reactivity
export function useAllStreamLoadingStates(): Record<string, boolean> {
  const context = useThreadContext()
  return useSyncExternalStore(
    context.subscribeToAllStreams,
    context.getAllStreamLoadingStates,
    context.getAllStreamLoadingStates
  )
}
