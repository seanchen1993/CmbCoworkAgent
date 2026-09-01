import {
  createContext,
  memo,
  useContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode
} from "react"

/* eslint-disable react-refresh/only-export-components */
import { useStream } from "@langchain/langgraph-sdk/react"
import { ElectronIPCTransport, type StreamFallbackIndexBaselines } from "./electron-transport"
import {
  fallbackIndexBaselinesFromMessages,
  updateFallbackIndexBaselineCache,
  type FallbackIndexBaselineCache
} from "./stream-fallback-baselines"
import { isSerializedSummarizationMessage } from "../../../shared/context-compaction-messages"
import {
  CONTEXT_COMPACTION_EVENT_TYPE,
  parseContextCompactionLifecycleEvent,
  type ContextCompactionLifecycleEvent
} from "../../../shared/context-compaction-events"
import { resolveHydratedThreadModel } from "../../../shared/thread-model-selection"
import { LatestRequestGate } from "../../../shared/latest-request-gate"
import {
  isCoordinatorModeMetadata,
  isExplicitNormalModeMetadata,
  isWorkflowModeMetadata
} from "./coordinator-mode-helpers"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "./message-display-helpers"
import {
  applyWorkflowProgressEvent,
  type WorkflowProgressEventView,
  type WorkflowRunView
} from "./workflow-run-view"
import {
  reconcileHydratedWorkflowRun,
  workflowRunViewFromPersisted,
  type PersistedWorkflowRunDTO
} from "./workflow-run-view"
import {
  coordinatorWorkersEqual,
  mergeCoordinatorWorkers,
  upsertSubagentLogEntry,
  type CoordinatorWorkerView,
  type SubagentInternalLogEntry
} from "./thread-state-helpers"

export type { CoordinatorWorkerView, SubagentInternalLogEntry } from "./thread-state-helpers"
export type { HarnessAgentmdLoadStatusItem } from "../../../shared/harness-board-types"
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
  GoalEvent,
  QueuedMessage
} from "@/types"
import { isThreadDeletionPending, isThreadRetired, useAppStore } from "@/lib/store"
import type { DeepAgent } from "../../../main/agent/types"
import { toast } from "sonner"
import { formatAutoCommitText } from "../../../shared/auto-commit-format"
import {
  normalizeHarnessAgentmdLoadStatus,
  type HarnessAgentmdLoadStatusItem,
  type ManagedAutoSendStreamStartEvent
} from "../../../shared/harness-board-types"
import {
  findMessagesAfterCheckpointVisibleIds,
  isCheckpointEmptyAssistantToolCallMessage,
  mergeCheckpointAuthorityTranscriptMessages
} from "../../../shared/checkpoint-transcript"
import {
  isInternalGoalPromptMessage,
  shouldSuppressCheckpointApprovalRestore,
  type GoalNoticeEvent
} from "./goal-notice-messages"
import {
  buildRestoredCheckpointTranscript,
  formatGoalEventMessage,
  getInternalGoalPromptIdentity,
  goalNoticeEventsToGoalUiEvents,
  hasGoalResumeUserEvent,
  isGoalResumeCommandContent,
  isVisibleCheckpointTranscriptMessage,
  sameGoalCommandMessage
} from "./goal-transcript"
import { mergeGoalUiEvents } from "./goal-ui-events"
import {
  latestPersistedCheckpointMessageAt,
  restoreRawCheckpointMessageTime,
  restoreVisibleCheckpointMessageTimes
} from "./checkpoint-message-times"
import {
  applyLiveStreamMessageIdAliases,
  createLiveStreamCumulativeFrameProjector,
  createLiveStreamMessageIdNormalizer,
  createLiveStreamMessageMerger,
  createLiveStreamTranscriptIndexCache,
  createTimedLiveStreamMessageProjector,
  liveStreamMessageRole,
  mergeLiveStreamCommitMessages,
  mergeLiveStreamCommitMessagesDetailed,
  mergeLiveStreamMessages,
  normalizeLiveStreamMessageEntries,
  replaceLiveStreamMessageId,
  resolveCommittedLiveStreamMessages,
  type LiveStreamMessageIdNormalizer,
  type LiveStreamMessageMerger,
  type LiveStreamCumulativeFrameProjector,
  type LiveStreamMessageIdAlias,
  type LiveStreamMessage,
  type LiveStreamMessageTimeMap,
  type TimedLiveStreamMessageProjector
} from "./live-stream-messages"
import {
  getMessageProviderTupleFromMetadata,
  getMessageProviderOccurrenceIdentity,
  getMessageProviderSourceId,
  normalizeAppendedMessageIds,
  normalizeMessageRoleCollisionIds,
  preserveAssistantReasoningByRoleCollisionIdentity
} from "../../../shared/message-role-collision"
import { buildSyntheticCheckpointBaselineIds } from "./stream-message-ids"
import { normalizeHookLogTurnId, resolveHookLogUserMessage } from "./hook-log-turn-id"
import { appendBoundedHookLogEntry } from "./hook-log-retention"
import { projectKanbanSubagents, type KanbanSubagentSummary } from "./thread-state-summary"
import {
  mergeSchedulerTurnMessageSnapshot,
  normalizeSchedulerMessageSnapshot
} from "./scheduler-message-snapshot"
import {
  getWorkspaceFilePathIndex,
  markWorkspaceFilesStale,
  normalizeWorkspaceFileKey,
  registerWorkspaceFilePathIndex,
  retainWorkspaceFilesForPathChange,
  refreshWorkspaceFilesFromChangeBatch,
  subscribeWorkspaceFileResults
} from "./workspace-file-load"
import {
  applyThreadStateRegistryChanges,
  type ThreadStateRegistryChange
} from "./thread-state-registry"
import {
  replaceTrustedMessageTailInPlace,
  type TrustedMessageTailLocation
} from "./trusted-message-tail"
import {
  createDehydratedThreadStatePatch,
  hasBlockingSpecialThreadActivity
} from "./thread-dehydration"
import {
  CoordinatorWorkerRequestCache,
  ForegroundHydrationGeneration,
  getSubagentTranscriptHydrationRetrySchedule,
  getSubagentTranscriptPersistRetrySchedule,
  getThreadHistoryHydrationRetryDisposition,
  getThreadHistoryHydrationRetrySchedule,
  isSubagentTranscriptHydrationRetryExhausted,
  isSubagentTranscriptPersistRetryExhausted,
  isThreadHistoryHydrationAttemptActive,
  resolveConversationPresenceFromPage,
  shouldAwaitCheckpointConversationPresence,
  shouldBootstrapLegacyCheckpointTranscript,
  shouldKeepMainTranscriptLoadingAfterPage,
  type ForegroundHydrationToken,
  type ThreadHistoryHydrationAttempt
} from "./thread-hydration"
import type { ThreadConversationPresence } from "./agent-mode-switch-availability"
import {
  advanceThreadMessageWindowAcrossGap,
  attachThreadMessageGapReload,
  createForwardThreadMessagePageWindow,
  createThreadMessagePageWindow,
  createTargetedThreadMessageWindow,
  mergeLatestThreadMessagePage,
  prependBoundedThreadMessagePage,
  prependThreadMessagePageWindow,
  restoreLatestThreadMessageWindow,
  isForwardThreadMessagePageCursor,
  isThreadMessageForwardPageProgress,
  isThreadMessagePageContinuousWithBoundary,
  threadMessagePageIdentity,
  threadMessagePageIdentitySet,
  upsertLatestThreadMessagePageWindow,
  type ThreadMessagePageWindow,
  type ThreadMessagePageCursor,
  type ThreadMessageWindowGap
} from "./thread-message-pages"
import {
  canCancelThreadMessageWindowIntent,
  createThreadMessageWindowIntentCoordinator
} from "./thread-message-window-intent"
import {
  indexDurableTranscriptRequirements,
  liveStreamMessageToStoreMessage,
  resolveLiveStreamMessageEndAt,
  shouldSkipLiveStreamAccumulatorMessage
} from "./live-stream-transcript"
import {
  applyPersistedSubagentTranscriptRefs,
  appendSubagentLiveTextProjection,
  getSubagentTranscriptsFromThreadValues,
  mergeSubagentTranscripts,
  rebasePendingSubagentTranscriptRows,
  restoreSubagentsFromTranscripts,
  selectSubagentTranscriptPersistFollowUp,
  selectMergedTranscriptRowsForPersistence,
  serializeSubagentTranscripts,
  SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY,
  upsertTranscriptMessages,
  type SubagentLiveTextProjection
} from "./subagent-transcripts"
import { mergeSubagentSnapshotWithHistory } from "./subagent-state"
import { disableChatReportUploadForThread } from "./chat-report-upload-cache"
import { queueStorageKey } from "./queued-message-content"

const MESSAGE_TIMES_THREAD_VALUE_KEY = "messageTimes"
const MESSAGE_TIME_ORDER_THREAD_VALUE_KEY = "messageTimeOrder"
const INTERNAL_GOAL_MESSAGE_TIMES_THREAD_VALUE_KEY = "internalGoalMessageTimes"
const INTERNAL_GOAL_MESSAGE_TIME_ORDER_THREAD_VALUE_KEY = "internalGoalMessageTimeOrder"
const CONTEXT_COMPACTION_COMPLETE_DISMISS_MS = 2400
const CONTEXT_COMPACTION_FAILED_DISMISS_MS = 5000

type MessageTimeMap = Record<string, { start_at?: string; end_at?: string }>
type MessageTimeEntry = MessageTimeMap[string] & { id: string }
type LiveMessageTimeMap = LiveStreamMessageTimeMap
type PendingVisibleMessageCommit = {
  message: Message
}

type LiveStreamAccumulator = {
  active: boolean
  baselineIds: Set<string>
  messages: LiveStreamMessage[]
  normalizeMessageIds: LiveStreamMessageIdNormalizer
  mergeMessages: LiveStreamMessageMerger
  projectCumulativeFrame: LiveStreamCumulativeFrameProjector
  projectTimedMessages: TimedLiveStreamMessageProjector
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

function hasMessageId<T extends { id?: string | null }>(message: T): message is T & { id: string } {
  return typeof message.id === "string" && message.id.length > 0
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

const toDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

const toMessageDate = (value: unknown, fallback?: Date): Date | undefined => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  return fallback
}

const normalizePersistedThreadMessages = (messages: Message[]): Message[] => {
  return messages.flatMap((message): Message | [] => {
    if (!hasMessageId(message)) return []
    const createdAt = toMessageDate(message.created_at, new Date()) ?? new Date()
    const startAt = toMessageDate(message.start_at)
    const endAt = toMessageDate(message.end_at)
    return {
      ...message,
      content:
        typeof message.content === "string" || Array.isArray(message.content)
          ? message.content
          : "",
      created_at: createdAt,
      ...(startAt ? { start_at: startAt } : {}),
      ...(endAt ? { end_at: endAt } : {})
    }
  })
}

const mergePersistedMessagesIntoTranscript = (
  baseMessages: Message[],
  persistedMessages: Message[]
): Message[] => {
  return mergeCheckpointAuthorityTranscriptMessages(baseMessages, persistedMessages, {
    isSameMessage: sameGoalCommandMessage
  })
}

const latestDate = (dates: Array<Date | undefined>): Date | undefined => {
  return dates.reduce<Date | undefined>((latest, date) => {
    if (!date) return latest
    if (!latest || date > latest) return date
    return latest
  }, undefined)
}

const latestPersistedVisibleMessageAt = (messages: Message[]): Date | undefined => {
  return latestDate(
    messages.map(
      (message) =>
        toMessageDate(message.start_at) ??
        toMessageDate(message.created_at) ??
        toMessageDate(message.end_at)
    )
  )
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

/** One failover attempt shown in the error detail card. */
export interface ApiErrorFailoverAttempt {
  modelId: string
  modelDisplayName?: string
  modelName?: string
  reason: string
}

/**
 * Structured diagnostics for a failed turn, mirrored from the main process
 * `error_detail` custom event. Everything is optional so the card degrades
 * gracefully when a field is unavailable.
 */
export interface ApiErrorDetailState {
  code?: string
  status?: number
  statusLabel?: string
  hint?: string
  requestId?: string
  reason?: string
  providerMessage?: string
  rawBody?: string
  modelId?: string
  modelDisplayName?: string
  modelName?: string
  model?: string
  failover?: ApiErrorFailoverAttempt[]
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
  workerId?: string
  workerThreadId?: string
  workerTurn?: number
  parentThreadId?: string
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

export interface ContextReminderState {
  pending: boolean
  shownCount: number
  completedTurnCount: number
  lastPromptCompletedTurnCount: number
}

function createDefaultContextReminderState(): ContextReminderState {
  return {
    pending: false,
    shownCount: 0,
    completedTurnCount: 0,
    lastPromptCompletedTurnCount: 0
  }
}

// Per-thread state (persisted/restored from checkpoints)
export interface ThreadState {
  /** Heavy fields were evicted; lightweight summaries stay valid until rehydration finishes. */
  dehydrated: boolean
  messages: Message[]
  /** Bumped when a trusted scheduler frame replaces the owned message tail in place. */
  messagesContentVersion: number
  /**
   * Draft messages parked while a run is active or an approval is pending. They
   * auto-drain (send in order) once the thread is idle again, or can be steered
   * into the running turn. Persisted per-thread to localStorage so a reload or
   * view switch doesn't lose queued input.
   */
  queuedMessages: QueuedMessage[]
  /**
   * Set when the user hits Stop; makes the queue auto-drain effect skip firing
   * the next queued draft so Stop actually stops. Not persisted to localStorage
   * (a fresh app launch should never start suppressed) — but it DOES need to
   * live here rather than as a ChatContainer-local ref: TabbedPanel unmounts
   * ChatContainer entirely when switching to a file tab (`isAgentTab ? <ChatContainer>
   * : <FileViewer>`), which would silently reset a local ref back to false and
   * undo the suppression the moment the user glances at an open file and back.
   */
  queueAutoDrainSuppressed: boolean
  goalUi: GoalUiState
  activeTurnStartTime: number | null
  todos: Todo[]
  workspaceFiles: FileInfo[]
  workspacePath: string | null
  gitContext: ThreadGitContext | null
  subagents: Subagent[]
  /**
   * Per-subagentId live transcript buffer (Phase 2, A1'). Subagent-interior
   * message-delta / tool-message scheduler events tagged with `subagentId` are
   * appended here instead of into `messages`, so the `task` card can render the
   * subagent's nested interior on demand without polluting the main thread.
   */
  subagentTranscripts: Record<string, Message[]>
  /** Per-bucket revision for trusted in-place subagent transcript tail updates. */
  subagentTranscriptContentVersions: Record<string, number>
  /** Scalar publication fence for the mutable per-bucket version registry. */
  subagentTranscriptsRevision: number
  /** True only after the dedicated transcript API has hydrated successfully. */
  subagentTranscriptBaselineReady: boolean
  coordinatorWorkers: CoordinatorWorkerView[]
  subagentToolCallCount: number
  subagentInternalLogs: SubagentInternalLogEntry[]
  toolCallStates: Record<string, ToolCallState>
  pendingApprovals: HITLRequest[]
  pendingApproval: HITLRequest | null
  approvalQueue: HITLRequest[]
  pendingUserInput: UserInputRequest | null
  error: string | null
  errorDetail: ApiErrorDetailState | null
  hookInterruption: HookInterruptionState | null
  currentModel: string
  openFiles: OpenFile[]
  activeTab: "agent" | string
  fileContents: Record<string, string>
  tokenUsage: TokenUsage | null
  contextReminder: ContextReminderState
  harnessAgentmdLoadStatus: HarnessAgentmdLoadStatusState | null
  draftInput: string
  harnessNextActionDialogTips: string | null
  /**
   * Skill chip the user has selected for the next send. Kept alongside
   * draftInput so the chip survives view switches (chat → customize → back),
   * matching how draftInput already behaves.
   */
  draftSkill: SkillMetadata | null
  /** Whether the built-in browser mode is selected for the next send. */
  draftBuiltinBrowser: boolean
  scheduledTaskLoading: boolean
  historyLoading: boolean
  historyPageLoading: boolean
  historyHasMore: boolean
  historyPageCursor: ThreadMessagePageCursor | null
  /** Lightweight page descriptors make a released middle reloadable without retaining bodies. */
  historyPageWindows: ThreadMessagePageWindow[]
  /** Explicit discontinuity between a paged historical window and the protected live tail. */
  historyWindowGap: ThreadMessageWindowGap | null
  historyMessageTotal: number
  /** Authoritative visible-conversation presence; unknown always fails closed. */
  historyConversationPresence: ThreadConversationPresence
  historyLoadedMessageCount: number
  scheduledTaskId: string | null
  routingResult: RoutingResultState | null
  modelRetry: ModelRetryState | null
  /** Ephemeral foreground context-compaction status shown in the chat transcript. */
  contextCompaction: ContextCompactionLifecycleEvent | null
  /** Live dynamic workflow run (workflow mode), built from workflow_progress events. */
  workflowRun: WorkflowRunView | null
}

export interface ThreadStateSummary {
  workspacePath: string | null
  hasRunningCoordinatorWorker: boolean
  scheduledTaskLoading: boolean
  workflowRunning: boolean
  hasDraft: boolean
  hasPendingApproval: boolean
  hasPendingUserInput: boolean
  hasContextReminder: boolean
  kanbanSubagents: readonly KanbanSubagentSummary[]
}

function summarizeThreadState(
  state: ThreadState,
  previous: ThreadState | undefined,
  previousSummary: ThreadStateSummary | undefined
): ThreadStateSummary {
  return {
    workspacePath: state.workspacePath,
    hasRunningCoordinatorWorker:
      previousSummary && previous?.coordinatorWorkers === state.coordinatorWorkers
        ? previousSummary.hasRunningCoordinatorWorker
        : state.coordinatorWorkers.some((worker) => worker.status === "running"),
    scheduledTaskLoading: state.scheduledTaskLoading,
    workflowRunning: state.workflowRun?.status === "running",
    hasDraft:
      previousSummary && previous?.draftInput === state.draftInput
        ? previousSummary.hasDraft
        : Boolean(state.draftInput.trim()),
    hasPendingApproval: state.pendingApproval !== null,
    hasPendingUserInput: state.pendingUserInput !== null,
    hasContextReminder: state.contextReminder.pending,
    kanbanSubagents:
      state.dehydrated && previousSummary
        ? previousSummary.kanbanSubagents
        : projectKanbanSubagents(
            state.subagents,
            previous?.subagents,
            previousSummary?.kanbanSubagents
          )
  }
}

function threadStateSummariesEqual(
  left: ThreadStateSummary | undefined,
  right: ThreadStateSummary | undefined
): boolean {
  if (!left || !right) return left === right
  return (
    left.workspacePath === right.workspacePath &&
    left.hasRunningCoordinatorWorker === right.hasRunningCoordinatorWorker &&
    left.scheduledTaskLoading === right.scheduledTaskLoading &&
    left.workflowRunning === right.workflowRunning &&
    left.hasDraft === right.hasDraft &&
    left.hasPendingApproval === right.hasPendingApproval &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasContextReminder === right.hasContextReminder &&
    left.kanbanSubagents === right.kanbanSubagents
  )
}

function threadDehydrationEligibilityMayHaveChanged(
  previous: ThreadState | undefined,
  next: ThreadState | undefined
): boolean {
  if (!previous || !next) return previous !== next
  const hasBlockingCoordinator = (state: ThreadState): boolean =>
    state.coordinatorWorkers.some(
      (worker) =>
        worker.status === "running" ||
        (worker.notification_acknowledged !== true &&
          worker.suppress_notification_auto_run !== true)
    )
  const hasNonterminalSubagent = (state: ThreadState): boolean =>
    state.subagents.some(
      (subagent) =>
        subagent.status !== "completed" &&
        subagent.status !== "failed" &&
        subagent.status !== "cancelled"
    )
  return (
    previous.historyLoading !== next.historyLoading ||
    previous.historyPageLoading !== next.historyPageLoading ||
    previous.subagentTranscriptBaselineReady !== next.subagentTranscriptBaselineReady ||
    previous.scheduledTaskLoading !== next.scheduledTaskLoading ||
    previous.goalUi.goal?.status !== next.goalUi.goal?.status ||
    previous.activeTurnStartTime !== next.activeTurnStartTime ||
    previous.pendingApprovals.length > 0 !== next.pendingApprovals.length > 0 ||
    Boolean(previous.pendingUserInput) !== Boolean(next.pendingUserInput) ||
    previous.queuedMessages.length > 0 !== next.queuedMessages.length > 0 ||
    Boolean(previous.hookInterruption) !== Boolean(next.hookInterruption) ||
    Boolean(previous.modelRetry) !== Boolean(next.modelRetry) ||
    previous.contextCompaction?.phase !== next.contextCompaction?.phase ||
    (previous.workflowRun?.status === "running") !== (next.workflowRun?.status === "running") ||
    (previous.coordinatorWorkers !== next.coordinatorWorkers &&
      hasBlockingCoordinator(previous) !== hasBlockingCoordinator(next)) ||
    (previous.subagents !== next.subagents &&
      hasNonterminalSubagent(previous) !== hasNonterminalSubagent(next))
  )
}

export interface HarnessAgentmdLoadStatusState {
  items: HarnessAgentmdLoadStatusItem[]
  createdAt: number
  loader: "plugin" | "cmbdevclaw"
  promptPreview?: string
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
  syncDurableTranscript: (requiredMessageIds?: string[]) => Promise<boolean>
  removeLocalMessage: (messageId: string) => void
  setMessages: (messages: Message[]) => void
  loadEarlierMessages: () => Promise<number>
  loadMessageWindowAround: (target: { messageId: string; ordinal: number }) => Promise<boolean>
  loadReleasedMessageWindow: () => Promise<boolean>
  restoreLatestMessageWindow: () => Promise<boolean>
  cancelMessageWindowLoad: () => void
  addQueuedMessage: (message: QueuedMessage) => void
  prependQueuedMessage: (message: QueuedMessage) => void
  getQueuedMessage: (messageId: string) => QueuedMessage | undefined
  updateQueuedMessage: (messageId: string, updates: Partial<QueuedMessage>) => void
  deleteQueuedMessage: (messageId: string) => void
  reorderQueuedMessages: (orderedIds: string[]) => void
  promoteQueuedMessage: (messageId: string) => void
  setQueueAutoDrainSuppressed: (suppressed: boolean) => void
  setGoalUi: (goalUi: GoalUiState) => void
  refreshGoalUi: (options?: { includeEvents?: boolean }) => Promise<void>
  setActiveTurnStartTime: (startTime: number | null) => void
  setTodos: (todos: Todo[]) => void
  setWorkspaceFiles: (files: FileInfo[] | ((prev: FileInfo[]) => FileInfo[])) => void
  setWorkspacePath: (path: string | null) => void
  setGitContext: (context: ThreadGitContext | null) => void
  /** Drops a finished/aborted workflow panel; a still-running run is kept. */
  clearFinishedWorkflowRun: () => void
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
  /** Restore the effective model for display/runtime use without touching persisted metadata. */
  restoreCurrentModel: (modelId: string) => void
  setCurrentModel: (modelId: string) => void
  openFile: (path: string, name: string) => void
  closeFile: (path: string) => void
  setActiveTab: (tab: "agent" | string) => void
  setFileContents: (path: string, content: string) => void
  setContextReminder: (
    update: ContextReminderState | ((prev: ContextReminderState) => ContextReminderState)
  ) => void
  setDraftInput: (input: string) => void
  setHarnessNextActionDialogTips: (tips: string | null) => void
  setDraftSkill: (skill: SkillMetadata | null) => void
  setDraftBuiltinBrowser: (selected: boolean) => void
}

// Context value
interface ThreadContextValue {
  getThreadState: (threadId: string) => ThreadState
  subscribeToThreadState: (threadId: string, callback: () => void) => () => void
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
  subscribeToAllThreadStates: (callback: () => void) => () => void
  getThreadStateSummaries: () => Record<string, ThreadStateSummary>
  subscribeToThreadStateSummaries: (callback: () => void) => () => void
  // Get all stream loading states (for kanban view)
  getAllStreamLoadingStates: () => Record<string, boolean>
  // Subscribe to all stream updates
  subscribeToAllStreams: (callback: () => void) => () => void
  suppressCoordinatorNotificationAutoRun: (threadId: string) => void
  // 以主进程 isRunning 为权威,校正心跳/定时任务线程的运行锁(丢 done 自愈)
  reconcileScheduledRunStates: () => void
}

// Default thread state
// ── Draft-queue persistence (per-thread, localStorage) ────────────────────────
// Best-effort: the in-memory ThreadState.queuedMessages is authoritative; this
// only survives reloads/view-switches. Keyed by threadId.

function normalizeQueuedMessage(raw: unknown): QueuedMessage | null {
  if (!raw || typeof raw !== "object") return null
  const item = raw as Partial<QueuedMessage>
  if (typeof item.id !== "string" || !item.id) return null
  if (typeof item.text !== "string") return null
  const createdAt = item.created_at ? new Date(item.created_at) : new Date()
  const updatedAt = item.updated_at ? new Date(item.updated_at) : createdAt
  const handoffRequestedAt = item.handoffRequestedAt ? new Date(item.handoffRequestedAt) : null
  return {
    id: item.id,
    text: item.text,
    attachmentModelBlocks:
      typeof item.attachmentModelBlocks === "string" ? item.attachmentModelBlocks : undefined,
    attachmentDisplayPrefix:
      typeof item.attachmentDisplayPrefix === "string" ? item.attachmentDisplayPrefix : undefined,
    skillBlock: typeof item.skillBlock === "string" ? item.skillBlock : undefined,
    builtinBrowser: item.builtinBrowser === true,
    modelId: typeof item.modelId === "string" ? item.modelId : undefined,
    handoffRequestedAt:
      handoffRequestedAt && !Number.isNaN(handoffRequestedAt.getTime())
        ? handoffRequestedAt
        : undefined,
    created_at: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    updated_at: Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt
  }
}

function loadQueuedMessages(threadId: string): QueuedMessage[] {
  try {
    const raw = window.localStorage.getItem(queueStorageKey(threadId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeQueuedMessage).filter((item): item is QueuedMessage => Boolean(item))
  } catch {
    return []
  }
}

function persistQueuedMessages(threadId: string, messages: QueuedMessage[]): void {
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(queueStorageKey(threadId))
      return
    }
    window.localStorage.setItem(queueStorageKey(threadId), JSON.stringify(messages))
  } catch {
    // Queue persistence is best-effort; the in-memory queue remains authoritative.
  }
}

function removeQueuedMessagesById(
  queuedMessages: QueuedMessage[],
  messageIds: ReadonlySet<string>
): QueuedMessage[] {
  if (messageIds.size === 0) return queuedMessages
  const next = queuedMessages.filter((message) => !messageIds.has(message.id))
  return next.length === queuedMessages.length ? queuedMessages : next
}

const createDefaultThreadState = (): ThreadState => ({
  dehydrated: false,
  messages: [],
  messagesContentVersion: 0,
  queuedMessages: [],
  queueAutoDrainSuppressed: false,
  goalUi: { goal: null, events: [], lastUpdated: null },
  activeTurnStartTime: null,
  todos: [],
  workspaceFiles: [],
  workspacePath: null,
  gitContext: null,
  subagents: [],
  subagentTranscripts: {},
  subagentTranscriptContentVersions: {},
  subagentTranscriptsRevision: 0,
  subagentTranscriptBaselineReady: false,
  coordinatorWorkers: [],
  subagentToolCallCount: 0,
  subagentInternalLogs: [],
  toolCallStates: {},
  pendingApprovals: [],
  pendingApproval: null,
  approvalQueue: [],
  pendingUserInput: null,
  error: null,
  errorDetail: null,
  hookInterruption: null,
  currentModel: "",
  openFiles: [],
  activeTab: "agent",
  fileContents: {},
  tokenUsage: null,
  contextReminder: createDefaultContextReminderState(),
  harnessAgentmdLoadStatus: null,
  draftInput: "",
  harnessNextActionDialogTips: null,
  draftSkill: null,
  draftBuiltinBrowser: false,
  scheduledTaskLoading: false,
  // An absent ThreadState is observed for one render before initializeThread's
  // passive effect runs. Treat that shell as loading so first-open/dehydrated
  // tasks can never flash the empty conversation UI.
  historyLoading: true,
  historyPageLoading: false,
  historyHasMore: false,
  historyPageCursor: null,
  historyPageWindows: [],
  historyWindowGap: null,
  historyMessageTotal: 0,
  historyConversationPresence: "unknown",
  historyLoadedMessageCount: 0,
  scheduledTaskId: null,
  routingResult: null,
  modelRetry: null,
  contextCompaction: null,
  workflowRun: null
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
const INITIAL_THREAD_MESSAGES_PAGE_LIMIT = 128
const INITIAL_THREAD_MESSAGES_PAGE_BYTE_BUDGET = 1024 * 1024
/** Hard cap for the active main transcript's resident JS message objects. */
export const THREAD_MESSAGE_RESIDENT_LIMIT = 1_500
/** Recent rows are never evicted so streaming/retry/approval reconciliation keeps a stable tail. */
export const THREAD_MESSAGE_PROTECTED_TAIL = 320
const TARGETED_THREAD_MESSAGE_PAGE_LIMIT = 500

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
    suggestedCommitMessage: req.suggestedCommitMessage,
    suggestedCommitFilePaths: req.suggestedCommitFilePaths,
    suggestedCommitFileBasePath: req.suggestedCommitFileBasePath,
    suggestedGitWorktreePath: req.suggestedGitWorktreePath,
    suggestedGitRepositories: req.suggestedGitRepositories,
    suggestedCommitFileSelectionSource: req.suggestedCommitFileSelectionSource,
    filePath: req.filePath,
    code: req.code,
    params: req.params,
    timeoutMs: req.timeoutMs,
    savedToolName: req.savedToolName,
    savedToolId: req.savedToolId,
    savedToolDescription: req.savedToolDescription,
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
    messagesContentVersion: state.messagesContentVersion ?? 0,
    subagentTranscriptContentVersions: state.subagentTranscriptContentVersions ?? {},
    subagentTranscriptsRevision: state.subagentTranscriptsRevision ?? 0,
    historyPageLoading: state.historyPageLoading ?? false,
    historyHasMore: state.historyHasMore ?? false,
    historyPageCursor: state.historyPageCursor ?? null,
    historyPageWindows: state.historyPageWindows ?? [],
    historyWindowGap: state.historyWindowGap ?? null,
    historyMessageTotal: state.historyMessageTotal ?? state.messages.length,
    historyConversationPresence:
      state.historyConversationPresence ??
      (state.messages.some(isVisibleCheckpointTranscriptMessage) ? "nonempty" : "unknown"),
    historyLoadedMessageCount: state.historyLoadedMessageCount ?? state.messages.length,
    draftBuiltinBrowser: state.draftBuiltinBrowser ?? false,
    toolCallStates: state.toolCallStates || {},
    contextCompaction: state.contextCompaction ?? null,
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

function toolResultStatusFromMessage(message: Message): ToolCallState["status"] {
  switch (message.status) {
    case "completed":
    case "failed":
    case "interrupted":
    case "rejected":
      return message.status
    case "error":
      return "failed"
    default:
      return message.is_error ? "failed" : "completed"
  }
}

function upsertToolCallStatesFromMessages(
  states: Record<string, ToolCallState>,
  messages: Message[]
): Record<string, ToolCallState> {
  let nextStates: Record<string, ToolCallState> | undefined
  const upsert = (toolCallId: string | undefined, updates: Partial<ToolCallState>): void => {
    if (!toolCallId?.trim()) return
    const source = nextStates ?? states
    const existing = source[toolCallId]
    const nextState: ToolCallState = {
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
    nextStates ??= { ...states }
    nextStates[toolCallId] = nextState
  }

  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        upsert(toolCall.id, {
          name: toolCall.name,
          args: toolCall.args,
          status: (nextStates ?? states)[toolCall.id]?.status ?? "queued"
        })
      }
    }
    if (message.role === "tool" && message.tool_call_id) {
      upsert(message.tool_call_id, {
        name: message.name,
        status: toolResultStatusFromMessage(message)
      })
    }
  }
  return nextStates ?? states
}

const collectKnownDurableMessageIds = (
  pageWindows: readonly ThreadMessagePageWindow[],
  rememberedDurableMessageIds?: ReadonlySet<string>,
  additionalDurableMessages: readonly Message[] = []
): ReadonlySet<string> => {
  const durableIds = new Set<string>()
  for (const window of pageWindows) {
    if (window.firstMessageId) durableIds.add(window.firstMessageId)
    if (window.lastMessageId) durableIds.add(window.lastMessageId)
  }
  if (rememberedDurableMessageIds) {
    for (const messageId of rememberedDurableMessageIds) durableIds.add(messageId)
  }
  for (const message of additionalDurableMessages) durableIds.add(message.id)
  return durableIds
}

function retainResidentToolCallStates(
  states: Record<string, ToolCallState>,
  messages: readonly Message[]
): Record<string, ToolCallState> {
  const maximumNonresidentActiveStates = 128
  const residentIds = new Set<string>()
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.id) residentIds.add(toolCall.id)
    }
    if (message.tool_call_id) residentIds.add(message.tool_call_id)
  }

  const protectedNonresidentIds = new Set(
    Object.entries(states)
      .filter(
        ([toolCallId, state]) =>
          !residentIds.has(toolCallId) &&
          state.status !== "completed" &&
          state.status !== "failed" &&
          state.status !== "interrupted" &&
          state.status !== "rejected"
      )
      .sort((left, right) => right[1].updatedAt.getTime() - left[1].updatedAt.getTime())
      .slice(0, maximumNonresidentActiveStates)
      .map(([toolCallId]) => toolCallId)
  )

  let changed = false
  const retained: Record<string, ToolCallState> = {}
  for (const [toolCallId, state] of Object.entries(states)) {
    if (residentIds.has(toolCallId) || protectedNonresidentIds.has(toolCallId)) {
      retained[toolCallId] = state
    } else {
      changed = true
    }
  }
  return changed ? retained : states
}

const ThreadContext = createContext<ThreadContextValue | null>(null)

// Custom event types from the stream
interface CustomEventData {
  type?: string
  compaction?: unknown
  request?: HITLRequest
  toolName?: string
  fingerprint?: string
  threshold?: number
  lastError?: string
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
    currentTool?: string
    lastActivityAt?: string
  }>
  workers?: CoordinatorWorkerView[]
  worker?: CoordinatorWorkerView
  workerThreadId?: string
  workerMessage?: Message
  subagentId?: string
  subagentPatch?: Partial<Pick<Subagent, "currentTool" | "lastActivityAt">>
  subagentMessage?: Message
  subagentMessages?: Message[]
  notification?: string
  suppressNotificationAutoRun?: boolean
  mode?: "normal" | "coordinator" | "workflow"
  /** workflow_progress payload (dynamic workflows mode). */
  workflowEvent?: WorkflowProgressEventView
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
  // error_detail field
  detail?: ApiErrorDetailState
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
  workerId?: string
  workerTurn?: number
  parentThreadId?: string
  messages?: LiveStreamMessage[]
  discardedMessageIds?: string[]
  assistantMessage?: LiveStreamMessage
  fromId?: string
  toId?: string
  role?: Message["role"]
  currentRunCompleted?: boolean
  rendererOnlyAlias?: boolean
  completedAssistantId?: string
  providerSourceId?: string
  providerOccurrence?: number
  result?: AgentAutoCommitResult
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
  agentmdLoader?: "plugin" | "cmbdevclaw"
  agentmdPromptPreview?: string
}

interface ThreadStreamHolderProps {
  threadId: string
  managedAutoSendRun?: ManagedAutoSendStreamStartEvent
  messages: readonly Message[]
  checkpointFallbackIndexBaselines?: StreamFallbackIndexBaselines
  subagentTranscriptBaseline: Record<string, Message[]>
  onStreamUpdate: (threadId: string, data: StreamData) => void
  onCustomEvent: (threadId: string, data: CustomEventData) => void
  onError: (threadId: string, error: Error) => void
  onDispose: (threadId: string) => void
}

const DEFAULT_THREAD_STATE = normalizeThreadState(createDefaultThreadState())
const MAX_RETAINED_IDLE_STREAM_HOLDERS = 6

// Component that holds a stream and notifies subscribers. memo keeps an update
// to thread A from re-running useStream for every previously opened thread.
const ThreadStreamHolder = memo(function ThreadStreamHolder({
  threadId,
  managedAutoSendRun,
  messages,
  checkpointFallbackIndexBaselines,
  subagentTranscriptBaseline,
  onStreamUpdate,
  onCustomEvent,
  onError,
  onDispose
}: ThreadStreamHolderProps): null {
  const [getMessageFallbackIndexBaselines] = useState(() => {
    let cache: FallbackIndexBaselineCache | undefined
    return (nextMessages: readonly Message[]): StreamFallbackIndexBaselines => {
      cache = updateFallbackIndexBaselineCache(cache, nextMessages)
      return cache.baselines
    }
  })
  const fallbackIndexBaselines = useMemo(() => {
    return mergeFallbackIndexBaselines(
      checkpointFallbackIndexBaselines,
      getMessageFallbackIndexBaselines(messages)
    )
  }, [checkpointFallbackIndexBaselines, getMessageFallbackIndexBaselines, messages])
  // The holder is mounted only after transcript hydration succeeds. Seed the
  // transport synchronously, before useStream can subscribe or convert any
  // live values snapshot, so reused raw task IDs cannot claim a legacy bucket.
  const [transport] = useState(() => {
    const seededTransport = new ElectronIPCTransport(
      managedAutoSendRun ? { managedAutoSendRunId: managedAutoSendRun.runId } : undefined
    )
    seededTransport.seedSubagentTranscriptBaseline(threadId, subagentTranscriptBaseline)
    seededTransport.setFallbackIndexBaselines(fallbackIndexBaselines)
    return seededTransport
  })

  useEffect(() => {
    transport.setFallbackIndexBaselines(fallbackIndexBaselines)
  }, [fallbackIndexBaselines, transport])

  // Use refs to avoid stale closures
  const onCustomEventRef = useRef(onCustomEvent)
  useEffect(() => {
    onCustomEventRef.current = onCustomEvent
  }, [onCustomEvent])

  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const stream = useStream<DeepAgent>({
    transport,
    threadId,
    messagesKey: "messages",
    onCustomEvent: (data) => {
      onCustomEventRef.current(threadId, data as CustomEventData)
    },
    onError: (error: unknown) => {
      onErrorRef.current(threadId, error instanceof Error ? error : new Error(String(error)))
    }
  })
  const submittedManagedRunIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!managedAutoSendRun || submittedManagedRunIdRef.current === managedAutoSendRun.runId) {
      return
    }
    submittedManagedRunIdRef.current = managedAutoSendRun.runId
    void stream
      .submit(null, {
        config: {
          configurable: {
            thread_id: threadId,
            ...(managedAutoSendRun.agentMode ? { agent_mode: managedAutoSendRun.agentMode } : {})
          }
        }
      })
      .catch((error: unknown) => {
        onErrorRef.current(
          threadId,
          error instanceof Error ? error : new Error(String(error))
        )
      })
  }, [managedAutoSendRun, stream, threadId])

  const latestStreamRef = useRef(stream)
  useEffect(() => {
    latestStreamRef.current = stream
  }, [stream])

  // Notify parent whenever stream data changes
  // Use refs to avoid stale closures and ensure we always have latest callback
  const onStreamUpdateRef = useRef(onStreamUpdate)
  useEffect(() => {
    onStreamUpdateRef.current = onStreamUpdate
  }, [onStreamUpdate])

  useEffect(() => () => onDispose(threadId), [onDispose, threadId])

  // Emit exactly once per observable snapshot. useStream returns a fresh wrapper
  // object on render, so depending on the wrapper itself doubles work and lets an
  // unrelated parent render replay an unchanged, potentially huge transcript.
  useEffect(() => {
    const latestStream = latestStreamRef.current
    onStreamUpdateRef.current(threadId, {
      messages: latestStream.messages,
      liveMessages: [],
      isLoading: latestStream.isLoading,
      stream: latestStream
    })
  }, [stream.messages, stream.isLoading, threadId])

  return null
})

export function ThreadProvider({ children }: { children: ReactNode }) {
  const currentThreadId = useAppStore((state) => state.currentThreadId)
  const [foregroundHydrationGeneration] = useState(
    () => new ForegroundHydrationGeneration(currentThreadId)
  )
  const [coordinatorWorkerRequestCache] = useState(
    () => new CoordinatorWorkerRequestCache<CoordinatorWorkerView[]>()
  )
  // ThreadState publishes on every token, but the provider only needs to
  // re-render holders when a structural baseline prop changes. Pending commit
  // resolution likewise wakes only while it has work and the message array
  // identity changes.
  const [, setHolderRegistryRevision] = useState(0)
  const [pendingResolutionRevision, setPendingResolutionRevision] = useState(0)
  const [dehydrationEligibilityRevision, setDehydrationEligibilityRevision] = useState(0)
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(new Set())
  const [managedAutoSendRuns, setManagedAutoSendRuns] = useState<
    Record<string, ManagedAutoSendStreamStartEvent>
  >({})
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({})
  const initializedThreadsRef = useRef<Set<string>>(new Set())
  const previousCurrentThreadIdRef = useRef<string | null>(null)
  const actionsCache = useRef<Record<string, ThreadActions>>({})
  const threadStatesRef = useRef<Record<string, ThreadState>>({})
  const modelSelectionGateRef = useRef(new LatestRequestGate())
  const threadRegistryRevisionRef = useRef(0)
  const allThreadStatesSnapshotRef = useRef<{
    revision: number
    snapshot: Record<string, ThreadState>
  }>({ revision: 0, snapshot: {} })
  const threadStateSubscribersRef = useRef<Record<string, Set<() => void>>>({})
  const allThreadStateSubscribersRef = useRef<Set<() => void>>(new Set())
  const threadStateSummariesRef = useRef<Record<string, ThreadStateSummary>>({})
  const threadStateSummaryRevisionRef = useRef(0)
  const threadStateSummarySnapshotRef = useRef<{
    revision: number
    snapshot: Record<string, ThreadStateSummary>
  }>({ revision: 0, snapshot: {} })
  const threadStateSummarySubscribersRef = useRef<Set<() => void>>(new Set())
  const workspaceThreadIdsByPathRef = useRef<Map<string, Set<string>>>(new Map())
  const unresolvedCoordinatorThreadIdsRef = useRef<Set<string>>(new Set())
  const [unresolvedCoordinatorThreadIdsKey, setUnresolvedCoordinatorThreadIdsKey] = useState("")
  const loadingStatesRef = useRef<Record<string, boolean>>({})
  // Throttle workflow_progress (P3 perf): a run emits an event per
  // agent_start/end/phase/log, and workflowRun lives in ThreadState (which has no
  // field-level selector — useThreadState returns the whole per-thread state), so
  // applying each event immediately re-renders that thread's whole chat view. Buffer
  // events per thread and apply them once per animation frame; a
  // terminal ("finished") event flushes immediately so completion isn't delayed.
  const workflowProgressBufferRef = useRef<
    Map<string, { events: WorkflowProgressEventView[]; rafId: number | null }>
  >(new Map())
  const subagentTranscriptsRef = useRef<Record<string, Record<string, Message[]>>>({})

  // Stream data store (not React state - we use subscriptions)
  const streamDataRef = useRef<Record<string, StreamData>>({})
  const streamSubscribersRef = useRef<Record<string, Set<() => void>>>({})
  const previousLoadingStatesRef = useRef<Record<string, boolean>>({})
  const coordinatorNotificationTimersRef = useRef<Record<string, number>>({})
  const coordinatorNotificationAttemptsRef = useRef<Record<string, number>>({})
  const coordinatorNotificationRetryOnIdleRef = useRef<Record<string, boolean>>({})
  const coordinatorNotificationAutoRunSuppressedRef = useRef<Set<string>>(new Set())
  const coordinatorNotificationSuppressTimersRef = useRef<Record<string, number>>({})
  const contextCompactionDismissTimersRef = useRef<Record<string, number>>({})
  const subagentTranscriptPersistTimersRef = useRef<Record<string, number>>({})
  const subagentTranscriptPersistRetryTimersRef = useRef<Record<string, number>>({})
  // subagentIds whose transcript changed since the last persist, per thread.
  // Lets the debounced persist serialize only the subagents that actually
  // changed instead of every subagent's full transcript each time.
  const subagentTranscriptDirtyIdsRef = useRef<Record<string, Set<string>>>({})
  // Message-level deltas for each dirty bucket. Sending only these rows avoids
  // serializing an ever-growing transcript on every heartbeat/tool result.
  const subagentTranscriptPendingMessagesRef = useRef<Record<string, Record<string, Message[]>>>({})
  const subagentTranscriptUrgentIdsRef = useRef<Record<string, Set<string>>>({})
  const subagentTranscriptPersistChainsRef = useRef<Partial<Record<string, Promise<void>>>>({})
  const subagentTranscriptPersistRetryCountRef = useRef<Record<string, number>>({})
  const subagentTranscriptPersistRecoveryRequestsRef = useRef<Set<string>>(new Set())
  const subagentTranscriptHydrationRetryTimersRef = useRef<Record<string, number>>({})
  const subagentTranscriptHydrationRetryCountsRef = useRef<Record<string, number>>({})
  const threadHistoryHydrationRetryTimersRef = useRef<Record<string, number>>({})
  const threadHistoryHydrationRetryCountsRef = useRef<Record<string, number>>({})
  const loadThreadHistoryRef = useRef<(threadId: string) => void>(() => {})
  const threadHistoryLoadGenerationRef = useRef<Record<string, number>>({})
  const [messageWindowIntentCoordinator] = useState(createThreadMessageWindowIntentCoordinator)
  const firstTranscriptPublishedThreadIdsRef = useRef<Set<string>>(new Set())
  const threadHistoryHydrationAttemptsRef = useRef<Record<string, ThreadHistoryHydrationAttempt>>(
    {}
  )
  const cancelThreadHistoryHydrationRetry = useCallback((threadId: string): void => {
    const timer = threadHistoryHydrationRetryTimersRef.current[threadId]
    if (timer === undefined) return
    window.clearTimeout(timer)
    delete threadHistoryHydrationRetryTimersRef.current[threadId]
  }, [])
  const saveSubagentTranscriptsRef = useRef<
    (
      threadId: string,
      transcripts: Record<string, Message[]>,
      changedIds?: Set<string>,
      urgent?: boolean
    ) => void
  >(() => {})
  const scheduleSubagentTranscriptsPersistRef = useRef<(threadId: string) => void>(() => {})
  const threadProviderMountedRef = useRef(true)
  const environmentCoordinatorThreadIdsRef = useRef<Set<string>>(new Set())
  const allStreamSubscribersRef = useRef<Set<() => void>>(new Set())
  const liveStreamAccumulatorsRef = useRef<Record<string, LiveStreamAccumulator>>({})
  // Visible rows that were flushed into ThreadState but are waiting for React's
  // commit. Keep this bridge separate from the active accumulator; deriving it
  // from streamData.liveMessages made every ordinary token re-filter/reconcile
  // the complete current-turn snapshot.
  const transitionalLiveMessagesRef = useRef<Record<string, LiveStreamMessage[]>>({})
  const [getLiveStreamTranscriptIndex] = useState(() => createLiveStreamTranscriptIndexCache())
  const rendererOnlyMessageIdAliasesRef = useRef<
    Record<string, Map<string, LiveStreamMessageIdAlias>>
  >({})
  // A process-wide monotonic gate avoids per-thread ABA when an id is deleted,
  // recreated, and begins another durable sync before the old read resolves.
  const durableTranscriptSyncGateRef = useRef(new LatestRequestGate())
  const latestDurableMessagePageIdentitiesRef = useRef<Record<string, ReadonlySet<string>>>({})
  const knownDurableMessageIdsRef = useRef<Record<string, Set<string>>>({})
  const checkpointFallbackIndexBaselinesRef = useRef<Record<string, StreamFallbackIndexBaselines>>(
    {}
  )
  const rememberDurableMessageIds = useCallback(
    (threadId: string, messages: readonly Message[]): void => {
      const known = knownDurableMessageIdsRef.current[threadId] ?? new Set<string>()
      for (const message of messages) known.add(message.id)
      if (known.size <= 8_192) {
        knownDurableMessageIdsRef.current[threadId] = known
        return
      }

      // Bound cursor metadata as strictly as the transcript itself. Resident durable rows and
      // page endpoints are sufficient to select the next verifiable cap boundary.
      const retained = new Set<string>()
      const state = threadStatesRef.current[threadId]
      for (const message of state?.messages ?? []) {
        if (known.has(message.id)) retained.add(message.id)
      }
      for (const window of state?.historyPageWindows ?? []) {
        if (window.firstMessageId) retained.add(window.firstMessageId)
        if (window.lastMessageId) retained.add(window.lastMessageId)
      }
      for (const message of messages) retained.add(message.id)
      knownDurableMessageIdsRef.current[threadId] = retained
    },
    []
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
  const pendingHookLogBucketOpensRef = useRef<Record<string, Set<string>>>({})
  const pendingVisibleMessageCommitsRef = useRef<Record<string, PendingVisibleMessageCommit[]>>({})
  const [pendingVisibleMessageCommitVersion, setPendingVisibleMessageCommitVersion] = useState(0)

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.currentThreadId === previous.currentThreadId) return
      foregroundHydrationGeneration.transition(state.currentThreadId)
      const previousThreadId = previous.currentThreadId
      if (previousThreadId) {
        const attempt = threadHistoryHydrationAttemptsRef.current[previousThreadId]
        if (attempt?.foregroundToken) {
          const retryTimer = subagentTranscriptHydrationRetryTimersRef.current[previousThreadId]
          if (retryTimer !== undefined) {
            window.clearTimeout(retryTimer)
            delete subagentTranscriptHydrationRetryTimersRef.current[previousThreadId]
          }
          const historyRetryTimer = threadHistoryHydrationRetryTimersRef.current[previousThreadId]
          if (historyRetryTimer !== undefined) {
            window.clearTimeout(historyRetryTimer)
            delete threadHistoryHydrationRetryTimersRef.current[previousThreadId]
          }
        }
        coordinatorWorkerRequestCache.invalidate(previousThreadId)
      }
      // A foreground-only attempt may now be safely evicted if it stops before
      // producing a complete baseline.
      setDehydrationEligibilityRevision((revision) => revision + 1)
    })
    return () => {
      foregroundHydrationGeneration.transition(null)
      coordinatorWorkerRequestCache.clear()
      unsubscribe()
    }
  }, [coordinatorWorkerRequestCache, foregroundHydrationGeneration])

  const commitThreadStateChanges = useCallback(
    (changes: Iterable<ThreadStateRegistryChange<ThreadState>>): void => {
      const applied = applyThreadStateRegistryChanges(threadStatesRef.current, changes)
      if (applied.length === 0) return

      let summaryChanged = false
      let unresolvedMembershipChanged = false
      let dehydrationEligibilityChanged = false
      let holderRegistryChanged = false
      let pendingResolutionNeeded = false
      for (const { threadId, previous, state } of applied) {
        const messageStructureChanged = previous?.messages !== state?.messages
        if (
          !previous ||
          !state ||
          messageStructureChanged ||
          previous.subagentTranscripts !== state.subagentTranscripts ||
          previous.subagentTranscriptBaselineReady !== state.subagentTranscriptBaselineReady
        ) {
          holderRegistryChanged = true
        }
        if (
          messageStructureChanged &&
          (pendingHookLogBucketOpensRef.current[threadId]?.size ||
            pendingVisibleMessageCommitsRef.current[threadId]?.length)
        ) {
          pendingResolutionNeeded = true
        }
        if (threadDehydrationEligibilityMayHaveChanged(previous, state)) {
          dehydrationEligibilityChanged = true
        }
        const previousWorkspaceKey = previous?.workspacePath
          ? normalizeWorkspaceFileKey(previous.workspacePath)
          : undefined
        const nextWorkspaceKey = state?.workspacePath
          ? normalizeWorkspaceFileKey(state.workspacePath)
          : undefined
        if (previousWorkspaceKey !== nextWorkspaceKey) {
          if (previousWorkspaceKey) {
            const previousIds = workspaceThreadIdsByPathRef.current.get(previousWorkspaceKey)
            previousIds?.delete(threadId)
            if (previousIds?.size === 0) {
              workspaceThreadIdsByPathRef.current.delete(previousWorkspaceKey)
            }
          }
          if (nextWorkspaceKey) {
            const nextIds = workspaceThreadIdsByPathRef.current.get(nextWorkspaceKey) ?? new Set()
            nextIds.add(threadId)
            workspaceThreadIdsByPathRef.current.set(nextWorkspaceKey, nextIds)
          }
        }

        const previousSummary = threadStateSummariesRef.current[threadId]
        const nextSummary = state
          ? summarizeThreadState(state, previous, previousSummary)
          : undefined
        if (!threadStateSummariesEqual(previousSummary, nextSummary)) {
          summaryChanged = true
          if (nextSummary) threadStateSummariesRef.current[threadId] = nextSummary
          else delete threadStateSummariesRef.current[threadId]
        }

        if (previous?.coordinatorWorkers !== state?.coordinatorWorkers) {
          const workers = state?.coordinatorWorkers ?? []
          const hasRunningWorker = workers.some((worker) => worker.status === "running")
          const hasUnacknowledgedTerminalWorker = workers.some(
            (worker) =>
              worker.status !== "running" &&
              worker.notification_acknowledged === false &&
              worker.suppress_notification_auto_run !== true
          )
          const shouldTrack =
            hasRunningWorker ||
            (hasUnacknowledgedTerminalWorker &&
              initializedThreadsRef.current.has(threadId) &&
              (!isThreadMetadataExplicitNormalMode(threadId) ||
                environmentCoordinatorThreadIdsRef.current.has(threadId)))
          const wasTracked = unresolvedCoordinatorThreadIdsRef.current.has(threadId)
          if (shouldTrack !== wasTracked) {
            unresolvedMembershipChanged = true
            if (shouldTrack) unresolvedCoordinatorThreadIdsRef.current.add(threadId)
            else unresolvedCoordinatorThreadIdsRef.current.delete(threadId)
          }
        }
      }

      threadRegistryRevisionRef.current += 1
      if (holderRegistryChanged) {
        setHolderRegistryRevision((revision) => revision + 1)
      }
      if (pendingResolutionNeeded) {
        setPendingResolutionRevision((revision) => revision + 1)
      }
      for (const { threadId } of applied) {
        threadStateSubscribersRef.current[threadId]?.forEach((callback) => callback())
      }
      allThreadStateSubscribersRef.current.forEach((callback) => callback())
      if (summaryChanged) {
        threadStateSummaryRevisionRef.current += 1
        threadStateSummarySubscribersRef.current.forEach((callback) => callback())
      }
      if (unresolvedMembershipChanged) {
        setUnresolvedCoordinatorThreadIdsKey(
          [...unresolvedCoordinatorThreadIdsRef.current].sort().join("\n")
        )
      }
      if (dehydrationEligibilityChanged) {
        setDehydrationEligibilityRevision((revision) => revision + 1)
      }
    },
    []
  )

  const updateThreadState = useCallback(
    (threadId: string, updater: (previous: ThreadState) => Partial<ThreadState>): void => {
      if (isThreadRetired(threadId)) return
      const current = normalizeThreadState(
        threadStatesRef.current[threadId] ?? createDefaultThreadState()
      )
      const updates = updater(current)
      const updateKeys = Object.keys(updates) as Array<keyof ThreadState>
      if (
        updateKeys.length === 0 ||
        !updateKeys.some((key) => !Object.is(current[key], updates[key]))
      ) {
        return
      }
      let nextState = { ...current, ...updates }
      if (nextState.messages.length > THREAD_MESSAGE_RESIDENT_LIMIT) {
        const pageBoundaryIds = new Set(
          nextState.historyPageWindows.map((window) => window.lastMessageId)
        )
        const durableBoundaryIds = collectKnownDurableMessageIds(
          nextState.historyPageWindows,
          knownDurableMessageIdsRef.current[threadId]
        )
        const boundedWindow = prependBoundedThreadMessagePage(nextState.messages, [], {
          maximumResidentMessages: THREAD_MESSAGE_RESIDENT_LIMIT,
          protectedTailMessages: THREAD_MESSAGE_PROTECTED_TAIL,
          existingGap: nextState.historyWindowGap,
          preferredPrefixBoundaryMessageIds: pageBoundaryIds,
          fallbackReloadBoundaryMessageIds: durableBoundaryIds,
          requireReloadableGap: true
        })
        nextState = {
          ...nextState,
          messages: boundedWindow.messages,
          historyWindowGap: attachThreadMessageGapReload(
            boundedWindow.gap,
            nextState.historyPageWindows,
            durableBoundaryIds
          ),
          toolCallStates: retainResidentToolCallStates(
            nextState.toolCallStates,
            boundedWindow.messages
          )
        }
      }
      commitThreadStateChanges([{ threadId, state: nextState }])
    },
    [commitThreadStateChanges]
  )

  const deleteThreadState = useCallback(
    (threadId: string): void => {
      if (!threadStatesRef.current[threadId]) return
      commitThreadStateChanges([{ threadId, state: undefined }])
    },
    [commitThreadStateChanges]
  )

  useEffect(() => {
    const cleanupResults = subscribeWorkspaceFileResults((workspaceKey, files) => {
      // One shared scan publishes one files-array reference. Update every
      // hydrated task on that physical path in one state transaction.
      const changes: ThreadStateRegistryChange<ThreadState>[] = []
      for (const threadId of workspaceThreadIdsByPathRef.current.get(workspaceKey) ?? []) {
        const state = threadStatesRef.current[threadId]
        if (
          state &&
          initializedThreadsRef.current.has(threadId) &&
          state.workspaceFiles !== files
        ) {
          changes.push({ threadId, state: { ...state, workspaceFiles: files } })
        }
      }
      commitThreadStateChanges(changes)
    })
    const cleanupChanges = window.api.workspace.onFilesChanged((event) => {
      const candidates = event.threadIds.flatMap((threadId) => {
        if (!initializedThreadsRef.current.has(threadId)) return []
        const workspacePath = threadStatesRef.current[threadId]?.workspacePath
        return workspacePath ? [{ threadId, workspacePath }] : []
      })
      void refreshWorkspaceFilesFromChangeBatch(event, candidates).catch((error) => {
        console.error("[ThreadContext] Failed to refresh changed workspace files:", error)
      })
    })

    return () => {
      cleanupChanges()
      cleanupResults()
    }
  }, [commitThreadStateChanges])

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
    (threadId: string, userMessage: Message, sourceTurnId = userMessage.id): void => {
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
      const sourceIdx =
        sourceTurnId !== bucket.turnId
          ? existing.findIndex((candidate) => candidate.turnId === sourceTurnId)
          : -1
      if (existingIdx >= 0) {
        const current = existing[existingIdx]
        const source = sourceIdx >= 0 ? existing[sourceIdx] : null
        if ((current.isPlaceholder && bucket.turnPreview) || source) {
          const nextBucket: HookLogBucket = {
            ...current,
            ...(current.isPlaceholder && bucket.turnPreview
              ? {
                  turnPreview: bucket.turnPreview,
                  startedAt: bucket.startedAt,
                  isPlaceholder: false
                }
              : {}),
            ...(source ? { entries: [...source.entries, ...current.entries] } : {})
          }
          hookLogBucketsRef.current[threadId] = existing.flatMap((candidate, index) => {
            if (index === sourceIdx) return []
            return index === existingIdx ? [nextBucket] : [candidate]
          })
          notifyHookLogSubscribers(threadId)
        }
        return
      }
      if (sourceIdx >= 0) {
        const source = existing[sourceIdx]
        hookLogBucketsRef.current[threadId] = existing.map((candidate, index) =>
          index === sourceIdx
            ? {
                ...source,
                turnId: bucket.turnId,
                ...(bucket.turnPreview
                  ? {
                      turnPreview: bucket.turnPreview,
                      startedAt: bucket.startedAt,
                      isPlaceholder: false
                    }
                  : {})
              }
            : candidate
        )
        notifyHookLogSubscribers(threadId)
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

  // A message id can be normalized again when React applies a queued state
  // update against a newer baseline. Wait until that final state is available
  // before opening the bucket so both objects always use the same render id.
  useLayoutEffect(() => {
    for (const [threadId, sourceTurnIds] of Object.entries(pendingHookLogBucketOpensRef.current)) {
      const messages = threadStatesRef.current[threadId]?.messages ?? []
      const unresolvedSourceTurnIds = new Set<string>()

      for (const sourceTurnId of sourceTurnIds) {
        const userMessage = resolveHookLogUserMessage(messages, sourceTurnId)
        if (!userMessage) {
          unresolvedSourceTurnIds.add(sourceTurnId)
          continue
        }
        openHookLogBucket(threadId, userMessage, sourceTurnId)
      }

      if (unresolvedSourceTurnIds.size > 0) {
        pendingHookLogBucketOpensRef.current[threadId] = unresolvedSourceTurnIds
      } else {
        delete pendingHookLogBucketOpensRef.current[threadId]
      }
    }
  }, [openHookLogBucket, pendingResolutionRevision])

  // Notify subscribers for a thread.
  const notifyStreamSubscribers = useCallback((threadId: string) => {
    const subscribers = streamSubscribersRef.current[threadId]
    if (subscribers) {
      subscribers.forEach((callback) => callback())
    }
    allStreamSubscribersRef.current.forEach((callback) => callback())
  }, [])

  const releaseDurableTransitionalLiveMessages = useCallback(
    (threadId: string, durableIdentities: ReadonlySet<string>): void => {
      if (durableIdentities.size === 0) return
      let released = false
      const previousTransitional = transitionalLiveMessagesRef.current[threadId] ?? []
      const nextTransitional = previousTransitional.filter(
        (message) =>
          !message.id ||
          !durableIdentities.has(
            getMessageProviderOccurrenceIdentity({
              ...message,
              id: message.id,
              role: liveStreamMessageRole(message.type)
            })
          )
      )
      if (nextTransitional.length !== previousTransitional.length) {
        released = true
        if (nextTransitional.length > 0) {
          transitionalLiveMessagesRef.current[threadId] = nextTransitional
        } else {
          delete transitionalLiveMessagesRef.current[threadId]
        }
      }

      const currentStreamData = streamDataRef.current[threadId]
      if (currentStreamData?.liveMessages.length) {
        const nextLiveMessages = currentStreamData.liveMessages.filter(
          (message) =>
            !message.id ||
            !durableIdentities.has(
              getMessageProviderOccurrenceIdentity({
                ...message,
                id: message.id,
                role: liveStreamMessageRole(message.type)
              })
            )
        )
        if (nextLiveMessages.length !== currentStreamData.liveMessages.length) {
          released = true
          streamDataRef.current[threadId] = {
            ...currentStreamData,
            liveMessages: nextLiveMessages
          }
          notifyStreamSubscribers(threadId)
        }
      }

      // The holder LRU does not run on ordinary content revisions. Publish the
      // ref-only bridge transition explicitly so an inactive task can dehydrate
      // as soon as its append succeeds.
      if (released) setDehydrationEligibilityRevision((revision) => revision + 1)
    },
    [notifyStreamSubscribers]
  )

  // Persist visible stream messages only after React has assigned their final
  // role-scoped ids. This keeps DB rows and message-time keys aligned even when
  // another queued state update changes which role keeps the provider id.
  useLayoutEffect(() => {
    for (const [threadId, pendingCommits] of Object.entries(
      pendingVisibleMessageCommitsRef.current
    )) {
      const messages = threadStatesRef.current[threadId]?.messages ?? []
      const resolution = resolveCommittedLiveStreamMessages(
        messages,
        pendingCommits.map((pendingCommit) => pendingCommit.message)
      )
      const messagesToPersist = resolution.resolved
      const unresolvedCommits = resolution.unresolved.map((message) => ({ message }))

      if (unresolvedCommits.length > 0) {
        pendingVisibleMessageCommitsRef.current[threadId] = unresolvedCommits
      } else {
        delete pendingVisibleMessageCommitsRef.current[threadId]
      }
      if (messagesToPersist.length === 0) continue

      window.api.threads
        .appendMessages(threadId, messagesToPersist)
        .then(() => {
          if (!initializedThreadsRef.current.has(threadId)) return
          releaseDurableTransitionalLiveMessages(
            threadId,
            new Set(messagesToPersist.map(getMessageProviderOccurrenceIdentity))
          )
        })
        .catch((error) => console.warn("[ThreadContext] Failed to save transcript:", error))
    }
  }, [
    pendingVisibleMessageCommitVersion,
    pendingResolutionRevision,
    releaseDurableTransitionalLiveMessages
  ])

  const getCurrentThreadMessageIds = useCallback(
    (threadId: string): Set<string> => {
      const messages = threadStatesRef.current[threadId]?.messages ?? []
      return new Set(getLiveStreamTranscriptIndex(messages).messageIds)
    },
    [getLiveStreamTranscriptIndex]
  )

  const getOrCreateLiveStreamAccumulator = useCallback(
    (threadId: string): LiveStreamAccumulator => {
      const existing = liveStreamAccumulatorsRef.current[threadId]
      if (existing) return existing

      const created: LiveStreamAccumulator = {
        active: false,
        baselineIds: getCurrentThreadMessageIds(threadId),
        messages: [],
        normalizeMessageIds: createLiveStreamMessageIdNormalizer(),
        mergeMessages: createLiveStreamMessageMerger(),
        projectCumulativeFrame: createLiveStreamCumulativeFrameProjector(),
        projectTimedMessages: createTimedLiveStreamMessageProjector(),
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
      accumulator.projectTimedMessages(accumulator.messages, accumulator.messageTimes),
    []
  )

  const accumulateLiveStreamMessages = useCallback(
    (
      threadId: string,
      rawMessages: StreamData["messages"] | LiveStreamMessage[]
    ): LiveStreamMessage[] => {
      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      const committedMessages = threadStatesRef.current[threadId]?.messages ?? []
      const transcriptIndex = getLiveStreamTranscriptIndex(committedMessages)
      const existingMessageIds = transcriptIndex.messageIds
      const incomingFrame = (rawMessages || []) as LiveStreamMessage[]
      const projectedFrame = accumulator.projectCumulativeFrame(
        incomingFrame,
        () => {
          const aliasedRawMessages = applyLiveStreamMessageIdAliases(
            incomingFrame,
            rendererOnlyMessageIdAliasesRef.current[threadId]?.values() ?? []
          )
          return accumulator.normalizeMessageIds(
            () => [...transcriptIndex.messageIdentities, ...accumulator.messages],
            aliasedRawMessages,
            transcriptIndex
          )
        },
        transcriptIndex
      )
      const normalizedRawMessages = projectedFrame.completeReconcile
        ? projectedFrame.messages
        : projectedFrame.changedMessages
      const incoming: Array<LiveStreamMessage & { id: string }> = []
      for (const message of normalizedRawMessages) {
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
        accumulator.messages = accumulator.mergeMessages(accumulator.messages, incoming)
      }

      return liveMessagesWithTimes(accumulator)
    },
    [getLiveStreamTranscriptIndex, getOrCreateLiveStreamAccumulator, liveMessagesWithTimes]
  )

  const flushLiveStreamAccumulator = useCallback(
    (threadId: string, options: { keepActive?: boolean } = {}): LiveStreamMessage[] => {
      const accumulator = liveStreamAccumulatorsRef.current[threadId]
      if (!accumulator) return []

      const completedAt = new Date()
      const committedMessages = threadStatesRef.current[threadId]?.messages ?? []
      const transcriptIndex = getLiveStreamTranscriptIndex(committedMessages)
      const currentTurnEntries = normalizeLiveStreamMessageEntries(
        transcriptIndex.messageIdentities,
        accumulator.messages
      ).filter(({ sourceId, message }) => {
        const role = liveStreamMessageRole(message.type)
        return (
          !!accumulator.messageTimes[sourceId] &&
          !transcriptIndex.messageRoleIds.has(`${role}\u0000${message.id}`)
        )
      })
      const messagesToAppend: Message[] = []
      const retainedVisibleLiveMessages: LiveStreamMessage[] = []

      currentTurnEntries.forEach(({ sourceId, message: streamMessage }, index) => {
        const trackedTime = accumulator.messageTimes[sourceId]
        const nextEntry = currentTurnEntries[index + 1]
        trackedTime.end_at = resolveLiveStreamMessageEndAt(
          trackedTime.start_at,
          nextEntry ? accumulator.messageTimes[nextEntry.sourceId]?.start_at : undefined,
          completedAt
        )

        const storeMessage = liveStreamMessageToStoreMessage(streamMessage, trackedTime)

        accumulator.baselineIds.add(sourceId)
        accumulator.baselineIds.add(streamMessage.id)

        if (isInternalGoalPromptMessage(storeMessage)) return
        if (!isVisibleCheckpointTranscriptMessage(storeMessage)) return

        messagesToAppend.push(storeMessage)
        retainedVisibleLiveMessages.push({
          ...streamMessage,
          start_at: trackedTime.start_at,
          end_at: trackedTime.end_at
        })
      })

      if (messagesToAppend.length > 0) {
        let canonicalMessagesToPersist: Message[] = []
        updateThreadState(threadId, (currentState) => {
          const normalizedMessages = normalizeMessageRoleCollisionIds(
            currentState.messages,
            messagesToAppend
          )
          const mergeResult = mergeLiveStreamCommitMessagesDetailed(
            currentState.messages,
            normalizedMessages
          )
          canonicalMessagesToPersist =
            mergeResult.resolvedIncoming.length === normalizedMessages.length
              ? mergeResult.resolvedIncoming
              : normalizedMessages
          return {
            messages: mergeResult.messages,
            toolCallStates: upsertToolCallStatesFromMessages(
              currentState.toolCallStates,
              normalizedMessages
            )
          }
        })
        const pendingCommits = pendingVisibleMessageCommitsRef.current[threadId] ?? []
        pendingCommits.push(
          ...canonicalMessagesToPersist.map((message) => ({
            message
          }))
        )
        pendingVisibleMessageCommitsRef.current[threadId] = pendingCommits
        setPendingVisibleMessageCommitVersion((version) => version + 1)
      }

      if (options.keepActive) {
        accumulator.active = true
        accumulator.messages = []
        accumulator.normalizeMessageIds = createLiveStreamMessageIdNormalizer()
        accumulator.mergeMessages = createLiveStreamMessageMerger()
        accumulator.projectCumulativeFrame = createLiveStreamCumulativeFrameProjector()
        accumulator.projectTimedMessages = createTimedLiveStreamMessageProjector()
        accumulator.messageTimes = {}
      } else {
        delete liveStreamAccumulatorsRef.current[threadId]
      }

      const currentStreamData = streamDataRef.current[threadId]
      if (currentStreamData) {
        const retainedLiveMessages = mergeLiveStreamMessages(
          transitionalLiveMessagesRef.current[threadId] ?? [],
          retainedVisibleLiveMessages
        )
        if (retainedLiveMessages.length > 0) {
          transitionalLiveMessagesRef.current[threadId] = retainedLiveMessages
        } else {
          delete transitionalLiveMessagesRef.current[threadId]
        }
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
    [getLiveStreamTranscriptIndex, notifyStreamSubscribers, updateThreadState]
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

  const applyDurableTranscriptSnapshot = useCallback(
    async (
      threadId: string,
      seq: number,
      requiredMessageIds: readonly string[] = [],
      orderHintMessages?: ReadonlyArray<{ id?: string }>,
      requiredMessageIdentities: readonly string[] = []
    ): Promise<boolean> => {
      const isCurrentIdleSync = (): boolean =>
        durableTranscriptSyncGateRef.current.isCurrent(threadId, seq) &&
        initializedThreadsRef.current.has(threadId) &&
        !threadStatesRef.current[threadId]?.historyLoading &&
        !streamDataRef.current[threadId]?.isLoading &&
        messageWindowIntentCoordinator.activeKind(threadId) === null
      if (!isCurrentIdleSync()) return false

      let persistedMessages: Message[]
      let persistedPageTotal = 0
      let nextLatestPageIdentities: ReadonlySet<string> = new Set()
      let newlyLoadedDurableRowCount: number | undefined
      try {
        const page = await window.api.threads.getMessagesPage(threadId, { limit: 500 })
        persistedPageTotal = page.total
        nextLatestPageIdentities = threadMessagePageIdentitySet(page.messages)
        const previousLatestPageIdentities = latestDurableMessagePageIdentitiesRef.current[threadId]
        if (previousLatestPageIdentities) {
          newlyLoadedDurableRowCount = 0
          for (const identity of nextLatestPageIdentities) {
            if (!previousLatestPageIdentities.has(identity)) {
              newlyLoadedDurableRowCount += 1
            }
          }
        }
        persistedMessages = normalizePersistedThreadMessages(page.messages).filter(
          isVisibleCheckpointTranscriptMessage
        )
      } catch (error) {
        console.warn("[ThreadContext] Failed to sync durable transcript:", error)
        return false
      }
      if (!isCurrentIdleSync()) return false
      rememberDurableMessageIds(threadId, persistedMessages)
      const durableRequirements = indexDurableTranscriptRequirements(
        persistedMessages,
        requiredMessageIds,
        requiredMessageIdentities
      )
      if (!durableRequirements.satisfied) return false
      if (persistedMessages.length === 0) {
        return requiredMessageIds.length === 0 && requiredMessageIdentities.length === 0
      }

      const syncedMessageIdentities = durableRequirements.messageIdentities
      const requiredMessageIdSet = new Set(requiredMessageIds)
      const liveOrderHint =
        orderHintMessages && orderHintMessages.length > 0 ? orderHintMessages : persistedMessages
      const mergeState = (state: ThreadState): ThreadState => {
        const latestPageMerge = mergeLatestThreadMessagePage(
          state.messages,
          persistedMessages,
          liveOrderHint
        )
        const pageWindows = upsertLatestThreadMessagePageWindow(
          state.historyPageWindows,
          createThreadMessagePageWindow(persistedMessages, null)
        )
        const pageBoundaryIds = new Set(pageWindows.map((window) => window.lastMessageId))
        const durableBoundaryIds = collectKnownDurableMessageIds(
          pageWindows,
          knownDurableMessageIdsRef.current[threadId],
          persistedMessages
        )
        const boundedWindow = prependBoundedThreadMessagePage(latestPageMerge.messages, [], {
          maximumResidentMessages: THREAD_MESSAGE_RESIDENT_LIMIT,
          protectedTailMessages: THREAD_MESSAGE_PROTECTED_TAIL,
          existingGap: state.historyWindowGap,
          accumulateEvictedMessageCount: false,
          preferredPrefixBoundaryMessageIds: pageBoundaryIds,
          fallbackReloadBoundaryMessageIds: durableBoundaryIds,
          requireReloadableGap: true
        })
        const ordered = boundedWindow.messages
        const queuedMessages = removeQueuedMessagesById(state.queuedMessages, requiredMessageIdSet)
        if (queuedMessages !== state.queuedMessages) {
          persistQueuedMessages(threadId, queuedMessages)
        }
        return {
          ...state,
          messages: ordered,
          queuedMessages,
          toolCallStates: retainResidentToolCallStates(
            upsertToolCallStatesFromMessages(state.toolCallStates, persistedMessages),
            ordered
          ),
          historyPageWindows: pageWindows,
          historyWindowGap: attachThreadMessageGapReload(
            boundedWindow.gap,
            pageWindows,
            durableBoundaryIds
          ),
          historyMessageTotal: persistedPageTotal,
          historyLoadedMessageCount: Math.min(
            persistedPageTotal,
            state.historyLoadedMessageCount +
              (newlyLoadedDurableRowCount ?? latestPageMerge.addedDurableMessageCount)
          )
        }
      }
      // Recheck at the synchronous registry mutation edge so an old async
      // snapshot cannot overwrite a replacement run or recreate a cleaned task.
      let snapshotApplied = false
      updateThreadState(threadId, (state) => {
        if (!durableTranscriptSyncGateRef.current.isCurrent(threadId, seq)) return {}
        if (!initializedThreadsRef.current.has(threadId)) return {}
        if (state.historyLoading || streamDataRef.current[threadId]?.isLoading) return {}
        snapshotApplied = true
        return mergeState(state)
      })
      if (!snapshotApplied) return false
      latestDurableMessagePageIdentitiesRef.current[threadId] = nextLatestPageIdentities
      releaseDurableTransitionalLiveMessages(threadId, syncedMessageIdentities)
      return true
    },
    [
      messageWindowIntentCoordinator,
      releaseDurableTransitionalLiveMessages,
      rememberDurableMessageIds,
      updateThreadState
    ]
  )

  const syncPersistedThreadMessagesAfterStreamStop = useCallback(
    (threadId: string, orderHintMessages: ReadonlyArray<{ id?: string }> | undefined): void => {
      const seq = durableTranscriptSyncGateRef.current.begin(threadId)
      const requiredMessageIdentities = Array.from(
        new Set(
          (transitionalLiveMessagesRef.current[threadId] ?? []).flatMap((message) =>
            message.id
              ? [
                  getMessageProviderOccurrenceIdentity({
                    ...message,
                    id: message.id,
                    role: liveStreamMessageRole(message.type)
                  })
                ]
              : []
          )
        )
      )

      void (async () => {
        for (const delayMs of [50, 350, 1_000, 2_500]) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
          if (!durableTranscriptSyncGateRef.current.isCurrent(threadId, seq)) return
          if (!initializedThreadsRef.current.has(threadId)) return
          if (threadStatesRef.current[threadId]?.historyLoading) return
          if (streamDataRef.current[threadId]?.isLoading) return
          if (
            await applyDurableTranscriptSnapshot(
              threadId,
              seq,
              [],
              orderHintMessages,
              requiredMessageIdentities
            )
          ) {
            return
          }
        }
      })()
    },
    [applyDurableTranscriptSnapshot]
  )

  const finalizeRunningSubagentsForStoppedStream = useCallback(
    (threadId: string) => {
      if (!threadStatesRef.current[threadId]) return
      updateThreadState(threadId, (current) => {
        if (!current.subagents.some((subagent) => subagent.status === "running")) return {}
        const completedAt = new Date()
        return {
          subagents: current.subagents.map((subagent) =>
            subagent.status === "running"
              ? { ...subagent, status: "cancelled" as const, completedAt }
              : subagent
          )
        }
      })
    },
    [updateThreadState]
  )

  const clearRunningContextCompactionForStoppedStream = useCallback(
    (threadId: string) => {
      if (threadStatesRef.current[threadId]?.contextCompaction?.phase !== "started") return
      updateThreadState(threadId, () => ({ contextCompaction: null }))
    },
    [updateThreadState]
  )

  const setThreadLoadingState = useCallback((threadId: string, isLoading: boolean): void => {
    const previous = loadingStatesRef.current
    if (previous[threadId] === isLoading) return
    const next = { ...previous, [threadId]: isLoading }
    loadingStatesRef.current = next
    setLoadingStates(next)
  }, [])

  // Handle stream updates from ThreadStreamHolder
  const handleStreamUpdate = useCallback(
    (threadId: string, data: StreamData, options: StreamUpdateOptions = {}) => {
      if (isThreadRetired(threadId)) return
      const previousStreamData = streamDataRef.current[threadId]
      const wasLoading = previousStreamData?.isLoading === true
      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      if (data.isLoading && !wasLoading) {
        delete rendererOnlyMessageIdAliasesRef.current[threadId]
        const invalidation = durableTranscriptSyncGateRef.current.begin(threadId)
        durableTranscriptSyncGateRef.current.finish(threadId, invalidation)
      }
      if (!options.ignoreHistoryLoading && threadStatesRef.current[threadId]?.historyLoading) {
        streamDataRef.current[threadId] = { ...data, liveMessages: [] }
        setThreadLoadingState(threadId, data.isLoading)
        notifyStreamSubscribers(threadId)
        if (!data.isLoading) {
          finalizeRunningSubagentsForStoppedStream(threadId)
          clearRunningContextCompactionForStoppedStream(threadId)
        }
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
        accumulator.normalizeMessageIds = createLiveStreamMessageIdNormalizer()
        accumulator.mergeMessages = createLiveStreamMessageMerger()
        accumulator.projectCumulativeFrame = createLiveStreamCumulativeFrameProjector()
        accumulator.projectTimedMessages = createTimedLiveStreamMessageProjector()
        accumulator.messageTimes = {}
      }

      let liveMessages = accumulator.active
        ? accumulateLiveStreamMessages(threadId, data.messages)
        : []

      const currentMessageIdentities = getLiveStreamTranscriptIndex(
        threadStatesRef.current[threadId]?.messages ?? []
      ).providerOccurrenceIdentities
      const previousTransitionalLiveMessages = transitionalLiveMessagesRef.current[threadId] ?? []
      const retainedLiveMessages = previousTransitionalLiveMessages.filter(
        (message) =>
          hasMessageId(message) &&
          !currentMessageIdentities.has(
            getMessageProviderOccurrenceIdentity({
              ...message,
              id: message.id,
              role: liveStreamMessageRole(message.type)
            })
          )
      )
      if (retainedLiveMessages.length !== previousTransitionalLiveMessages.length) {
        if (retainedLiveMessages.length > 0) {
          transitionalLiveMessagesRef.current[threadId] = retainedLiveMessages
        } else {
          delete transitionalLiveMessagesRef.current[threadId]
        }
      }
      if (retainedLiveMessages.length > 0) {
        liveMessages = mergeLiveStreamMessages(retainedLiveMessages, liveMessages)
      }

      if (accumulator.active && (!data.isLoading || options.finalizeCachedSnapshot)) {
        liveMessages = flushLiveStreamAccumulator(threadId)
      }

      streamDataRef.current[threadId] = { ...data, liveMessages }
      if (!data.isLoading) delete rendererOnlyMessageIdAliasesRef.current[threadId]
      setThreadLoadingState(threadId, data.isLoading)
      notifyStreamSubscribers(threadId)
      // Fallback clear: drop the retry indicator when the stream stops (isLoading=false).
      // The primary clear path is the explicit model_retry_clear custom event sent by
      // the main process when a retry succeeds. This fallback covers error paths and
      // any edge case where model_retry_clear was not sent.
      if (!data.isLoading) {
        finalizeRunningSubagentsForStoppedStream(threadId)
        clearRunningContextCompactionForStoppedStream(threadId)
        if (threadStatesRef.current[threadId]?.modelRetry) {
          updateThreadState(threadId, () => ({ modelRetry: null }))
        }
        if (wasLoading || options.finalizeCachedSnapshot) {
          syncPersistedThreadMessagesAfterStreamStop(threadId, data.messages)
        }
      }
    },
    [
      accumulateLiveStreamMessages,
      clearRunningContextCompactionForStoppedStream,
      finalizeRunningSubagentsForStoppedStream,
      flushLiveStreamAccumulator,
      getCurrentThreadMessageIds,
      getLiveStreamTranscriptIndex,
      getOrCreateLiveStreamAccumulator,
      notifyStreamSubscribers,
      seedLiveStreamBaselineFromMessages,
      setThreadLoadingState,
      syncPersistedThreadMessagesAfterStreamStop,
      updateThreadState
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
    (threadId: string): ThreadState => threadStatesRef.current[threadId] ?? DEFAULT_THREAD_STATE,
    []
  )

  const requestCoordinatorWorkers = useCallback(
    (threadId: string, subscribeUpdates: boolean): Promise<CoordinatorWorkerView[]> =>
      coordinatorWorkerRequestCache.request(threadId, subscribeUpdates, (subscribe) =>
        window.api.agent.getCoordinatorWorkers(threadId, { subscribeUpdates: subscribe })
      ),
    [coordinatorWorkerRequestCache]
  )

  const subscribeToThreadState = useCallback((threadId: string, callback: () => void) => {
    const subscribers = threadStateSubscribersRef.current[threadId] ?? new Set<() => void>()
    subscribers.add(callback)
    threadStateSubscribersRef.current[threadId] = subscribers
    return () => {
      subscribers.delete(callback)
      if (subscribers.size === 0) delete threadStateSubscribersRef.current[threadId]
    }
  }, [])

  const getAllThreadStates = useCallback((): Record<string, ThreadState> => {
    const revision = threadRegistryRevisionRef.current
    const cached = allThreadStatesSnapshotRef.current
    if (cached.revision !== revision) {
      allThreadStatesSnapshotRef.current = {
        revision,
        snapshot: { ...threadStatesRef.current }
      }
    }
    return allThreadStatesSnapshotRef.current.snapshot
  }, [])

  const subscribeToAllThreadStates = useCallback((callback: () => void) => {
    allThreadStateSubscribersRef.current.add(callback)
    return () => {
      allThreadStateSubscribersRef.current.delete(callback)
    }
  }, [])

  const getThreadStateSummaries = useCallback((): Record<string, ThreadStateSummary> => {
    const revision = threadStateSummaryRevisionRef.current
    const cached = threadStateSummarySnapshotRef.current
    if (cached.revision !== revision) {
      threadStateSummarySnapshotRef.current = {
        revision,
        snapshot: { ...threadStateSummariesRef.current }
      }
    }
    return threadStateSummarySnapshotRef.current.snapshot
  }, [])

  const subscribeToThreadStateSummaries = useCallback((callback: () => void) => {
    threadStateSummarySubscribersRef.current.add(callback)
    return () => {
      threadStateSummarySubscribersRef.current.delete(callback)
    }
  }, [])

  const getAllStreamLoadingStates = useCallback((): Record<string, boolean> => {
    return loadingStatesRef.current
  }, [])

  const subscribeToAllStreams = useCallback((callback: () => void) => {
    allStreamSubscribersRef.current.add(callback)
    return () => {
      allStreamSubscribersRef.current.delete(callback)
    }
  }, [])

  const saveSubagentTranscripts = useCallback(
    (
      threadId: string,
      transcripts: Record<string, Message[]>,
      changedIds?: Set<string>,
      urgent = false
    ) => {
      if (isThreadRetired(threadId)) return
      const persistGeneration = threadHistoryLoadGenerationRef.current[threadId] ?? 0
      const isCurrentPersistGeneration = (): boolean =>
        threadProviderMountedRef.current &&
        initializedThreadsRef.current.has(threadId) &&
        threadHistoryLoadGenerationRef.current[threadId] === persistGeneration
      if (!isCurrentPersistGeneration()) return

      const ids = new Set(changedIds?.size ? changedIds : Object.keys(transcripts))
      if (ids.size === 0) return
      const markDirty = (pendingIds: Iterable<string>): void => {
        const dirtyIds = subagentTranscriptDirtyIdsRef.current[threadId] ?? new Set<string>()
        for (const id of pendingIds) dirtyIds.add(id)
        subagentTranscriptDirtyIdsRef.current[threadId] = dirtyIds
      }
      markDirty(ids)
      if (urgent) {
        const urgentIds = subagentTranscriptUrgentIdsRef.current[threadId] ?? new Set<string>()
        for (const id of ids) urgentIds.add(id)
        subagentTranscriptUrgentIdsRef.current[threadId] = urgentIds
      }

      // A failed read leaves the persisted baseline unknown. Keep the dirty ids
      // queued until hydration succeeds; consuming them here would silently lose
      // the last debounced assistant delta when a scheduler run ends.
      if (!threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady) return
      if (subagentTranscriptPersistRetryTimersRef.current[threadId] !== undefined) return
      // One write may be in flight per thread. Further calls only union their
      // message deltas into the next bounded batch.
      if (subagentTranscriptPersistChainsRef.current[threadId]) return
      const pendingIds = subagentTranscriptDirtyIdsRef.current[threadId]
      if (!pendingIds?.size) return
      delete subagentTranscriptDirtyIdsRef.current[threadId]
      const batchIds = new Set(pendingIds)
      const urgentIds = subagentTranscriptUrgentIdsRef.current[threadId]
      const batchWasUrgent = Array.from(batchIds).some((id) => urgentIds?.has(id))
      if (urgentIds) {
        for (const id of batchIds) urgentIds.delete(id)
        if (urgentIds.size === 0) delete subagentTranscriptUrgentIdsRef.current[threadId]
      }

      const current = subagentTranscriptsRef.current[threadId] ?? transcripts
      const pendingBySubagent = subagentTranscriptPendingMessagesRef.current[threadId] ?? {}
      const subset: Record<string, Message[]> = {}
      for (const id of batchIds) {
        const pendingMessages = pendingBySubagent[id]
        const fallbackMessages = current[id]
        if (pendingMessages?.length) subset[id] = pendingMessages
        else if (fallbackMessages) subset[id] = fallbackMessages
        delete pendingBySubagent[id]
      }
      if (Object.keys(pendingBySubagent).length === 0) {
        delete subagentTranscriptPendingMessagesRef.current[threadId]
      } else {
        subagentTranscriptPendingMessagesRef.current[threadId] = pendingBySubagent
      }

      let attemptFailed = false
      const persist = (async () => {
        if (!isCurrentPersistGeneration()) return
        if (Object.keys(subset).length === 0) return
        let manifests: Record<string, unknown>
        try {
          manifests = await window.api.threads.persistSubagentTranscripts(
            threadId,
            serializeSubagentTranscripts(subset)
          )
        } catch (error) {
          // The row may have been deleted and recreated while the IPC was queued.
          // Never requeue the old row's transcript into the replacement generation.
          if (!isCurrentPersistGeneration()) return
          const requeued = subagentTranscriptPendingMessagesRef.current[threadId] ?? {}
          for (const [id, failedMessages] of Object.entries(subset)) {
            requeued[id] = upsertTranscriptMessages(failedMessages, requeued[id] ?? [], {
              completeSnapshot: true
            })
          }
          subagentTranscriptPendingMessagesRef.current[threadId] = requeued
          markDirty(batchIds)
          if (batchWasUrgent) {
            const retryUrgent =
              subagentTranscriptUrgentIdsRef.current[threadId] ?? new Set<string>()
            for (const id of batchIds) retryUrgent.add(id)
            subagentTranscriptUrgentIdsRef.current[threadId] = retryUrgent
          }
          throw error
        }
        if (!isCurrentPersistGeneration()) return
        delete subagentTranscriptPersistRetryCountRef.current[threadId]
        const pendingAfterDispatch = subagentTranscriptPendingMessagesRef.current[threadId]
        if (pendingAfterDispatch) {
          subagentTranscriptPendingMessagesRef.current[threadId] =
            applyPersistedSubagentTranscriptRefs(pendingAfterDispatch, subset, manifests)
        }
        const latest = subagentTranscriptsRef.current[threadId]
        if (!latest) return
        const withRefs = applyPersistedSubagentTranscriptRefs(latest, subset, manifests)
        if (withRefs === latest) return
        subagentTranscriptsRef.current[threadId] = withRefs
        updateThreadState(threadId, () => ({ subagentTranscripts: withRefs }))
      })().catch((error) => {
        if (!isCurrentPersistGeneration()) return
        attemptFailed = true
        console.warn("[ThreadContext] Failed to save subagent transcripts:", error)
        const retryCount = subagentTranscriptPersistRetryCountRef.current[threadId] ?? 0
        const retrySchedule = getSubagentTranscriptPersistRetrySchedule(retryCount)
        subagentTranscriptPersistRetryCountRef.current[threadId] = retrySchedule.nextRetryCount
        const debounceTimer = subagentTranscriptPersistTimersRef.current[threadId]
        if (debounceTimer !== undefined) {
          window.clearTimeout(debounceTimer)
          delete subagentTranscriptPersistTimersRef.current[threadId]
        }
        if (subagentTranscriptPersistRetryTimersRef.current[threadId] !== undefined) {
          return
        }
        if (retrySchedule.exhausted || retrySchedule.delayMs === null) {
          // Dirty/pending rows stay resident so an inactive task cannot discard
          // unsaved output. Removing the timer still eliminates the permanent
          // IPC/CPU loop; a new foreground event or reopen resets the budget.
          setDehydrationEligibilityRevision((revision) => revision + 1)
          return
        }
        subagentTranscriptPersistRetryTimersRef.current[threadId] = window.setTimeout(() => {
          delete subagentTranscriptPersistRetryTimersRef.current[threadId]
          if (
            !isCurrentPersistGeneration() ||
            !threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady
          ) {
            return
          }
          const retryTranscripts = subagentTranscriptsRef.current[threadId]
          const retryIds = subagentTranscriptDirtyIdsRef.current[threadId]
          if (!retryTranscripts || !retryIds?.size) return
          saveSubagentTranscriptsRef.current(threadId, retryTranscripts, retryIds)
        }, retrySchedule.delayMs)
      })
      subagentTranscriptPersistChainsRef.current[threadId] = persist
      void persist.finally(() => {
        if (subagentTranscriptPersistChainsRef.current[threadId] === persist) {
          delete subagentTranscriptPersistChainsRef.current[threadId]
        }
        if (!isCurrentPersistGeneration()) return
        const pendingIds = subagentTranscriptDirtyIdsRef.current[threadId]
        const latest = subagentTranscriptsRef.current[threadId]
        const recoveryRequested =
          subagentTranscriptPersistRecoveryRequestsRef.current.delete(threadId)
        if (
          recoveryRequested &&
          isSubagentTranscriptPersistRetryExhausted(
            subagentTranscriptPersistRetryCountRef.current[threadId] ?? 0
          ) &&
          subagentTranscriptPersistRetryTimersRef.current[threadId] === undefined &&
          pendingIds?.size &&
          latest &&
          threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady === true
        ) {
          // The foreground delta arrived while the final failed write still
          // owned this chain. Restart once after release so that delta is not
          // stranded behind the exhausted attempt.
          delete subagentTranscriptPersistRetryCountRef.current[threadId]
          scheduleSubagentTranscriptsPersistRef.current(threadId)
        }
        const hasUrgent = Array.from(pendingIds ?? []).some((id) =>
          subagentTranscriptUrgentIdsRef.current[threadId]?.has(id)
        )
        const followUp = selectSubagentTranscriptPersistFollowUp({
          attemptFailed,
          hasPending: !!pendingIds?.size && !!latest,
          canPersist:
            isCurrentPersistGeneration() &&
            threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady === true,
          timerScheduled:
            subagentTranscriptPersistTimersRef.current[threadId] !== undefined ||
            subagentTranscriptPersistRetryTimersRef.current[threadId] !== undefined,
          hasUrgent
        })
        if (followUp === "immediate" && latest && pendingIds) {
          saveSubagentTranscriptsRef.current(threadId, latest, pendingIds, true)
        } else if (followUp === "debounced") {
          scheduleSubagentTranscriptsPersistRef.current(threadId)
        }
      })
    },
    [setDehydrationEligibilityRevision, updateThreadState]
  )
  saveSubagentTranscriptsRef.current = saveSubagentTranscripts

  const scheduleSubagentTranscriptsPersist = useCallback(
    (threadId: string) => {
      const existingTimer = subagentTranscriptPersistTimersRef.current[threadId]
      if (existingTimer !== undefined) return
      if (subagentTranscriptPersistRetryTimersRef.current[threadId] !== undefined) return
      if (
        isSubagentTranscriptPersistRetryExhausted(
          subagentTranscriptPersistRetryCountRef.current[threadId] ?? 0
        )
      ) {
        return
      }
      const dirtyIds = subagentTranscriptDirtyIdsRef.current[threadId]
      const transcripts = subagentTranscriptsRef.current[threadId] ?? {}
      const largestDirtyBucket = Array.from(dirtyIds ?? []).reduce(
        (largest, id) => Math.max(largest, transcripts[id]?.length ?? 0),
        0
      )
      const delayMs = Math.min(5_000, 600 + Math.floor(largestDirtyBucket / 500) * 400)
      subagentTranscriptPersistTimersRef.current[threadId] = window.setTimeout(() => {
        delete subagentTranscriptPersistTimersRef.current[threadId]
        if (!threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady) return
        const transcripts = subagentTranscriptsRef.current[threadId] ?? {}
        const changedIds = subagentTranscriptDirtyIdsRef.current[threadId]
        saveSubagentTranscripts(threadId, transcripts, changedIds)
      }, delayMs)
    },
    [saveSubagentTranscripts]
  )
  scheduleSubagentTranscriptsPersistRef.current = scheduleSubagentTranscriptsPersist

  const mergeHydratedSubagentTranscripts = useCallback(
    (
      threadId: string,
      persistedTranscripts: Record<string, Message[]>,
      loadGeneration: number
    ): boolean => {
      if (
        !threadProviderMountedRef.current ||
        !initializedThreadsRef.current.has(threadId) ||
        threadHistoryLoadGenerationRef.current[threadId] !== loadGeneration
      ) {
        return false
      }
      const liveTranscripts =
        subagentTranscriptsRef.current[threadId] ??
        threadStatesRef.current[threadId]?.subagentTranscripts ??
        {}
      const mergedTranscripts = { ...persistedTranscripts }
      for (const [subagentId, messages] of Object.entries(liveTranscripts)) {
        mergedTranscripts[subagentId] = upsertTranscriptMessages(
          mergedTranscripts[subagentId] ?? [],
          messages,
          { completeSnapshot: true }
        )
      }
      subagentTranscriptsRef.current[threadId] = mergedTranscripts
      const pendingBySubagent = subagentTranscriptPendingMessagesRef.current[threadId]
      if (pendingBySubagent) {
        const rebasedPending = rebasePendingSubagentTranscriptRows(
          mergedTranscripts,
          pendingBySubagent
        )
        if (Object.keys(rebasedPending).length > 0) {
          subagentTranscriptPendingMessagesRef.current[threadId] = rebasedPending
        } else {
          delete subagentTranscriptPendingMessagesRef.current[threadId]
        }
      }
      const restoredSubagents = restoreSubagentsFromTranscripts(
        mergedTranscripts,
        threadStatesRef.current[threadId]?.subagents ?? []
      )
      updateThreadState(threadId, () => ({
        subagentTranscripts: mergedTranscripts,
        subagents: restoredSubagents,
        subagentTranscriptBaselineReady: true
      }))
      return true
    },
    [updateThreadState]
  )

  const scheduleSubagentTranscriptHydrationRetry = useCallback(
    (
      threadId: string,
      loadGeneration: number,
      foregroundToken: ForegroundHydrationToken | null
    ) => {
      const isCurrentLoad = (): boolean =>
        threadProviderMountedRef.current &&
        initializedThreadsRef.current.has(threadId) &&
        threadHistoryLoadGenerationRef.current[threadId] === loadGeneration &&
        (foregroundToken === null ||
          (useAppStore.getState().currentThreadId === threadId &&
            foregroundHydrationGeneration.isCurrent(foregroundToken)))
      if (!isCurrentLoad()) return
      if (subagentTranscriptHydrationRetryTimersRef.current[threadId] !== undefined) return

      const scheduleAttempt = (): void => {
        if (!isCurrentLoad()) return
        if (threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady) return
        const retryCount = subagentTranscriptHydrationRetryCountsRef.current[threadId] ?? 0
        const retrySchedule = getSubagentTranscriptHydrationRetrySchedule(retryCount)
        subagentTranscriptHydrationRetryCountsRef.current[threadId] = retrySchedule.nextRetryCount
        if (retrySchedule.exhausted || retrySchedule.delayMs === null) {
          // A permanently unavailable worker must not poll for the rest of the
          // process lifetime or pin every affected inactive task in memory.
          // Reopening the task explicitly grants a fresh, independent budget.
          setDehydrationEligibilityRevision((revision) => revision + 1)
          return
        }
        subagentTranscriptHydrationRetryTimersRef.current[threadId] = window.setTimeout(() => {
          delete subagentTranscriptHydrationRetryTimersRef.current[threadId]
          if (!isCurrentLoad()) return
          void window.api.threads
            .getSubagentTranscripts(
              threadId,
              foregroundToken ? { requestScope: "foreground-hydration" } : undefined
            )
            .then((rawTranscripts) => {
              if (!isCurrentLoad()) return
              const persistedTranscripts = getSubagentTranscriptsFromThreadValues({
                [SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]: rawTranscripts
              })
              if (
                !mergeHydratedSubagentTranscripts(threadId, persistedTranscripts, loadGeneration)
              ) {
                return
              }
              // Main transcript readiness is independent. The holder remains
              // unavailable through subagentTranscriptBaselineReady until this
              // retry succeeds, without blocking first paint or initial scroll.
              if (!isCurrentLoad()) return
              delete subagentTranscriptHydrationRetryCountsRef.current[threadId]
              if (subagentTranscriptDirtyIdsRef.current[threadId]?.size) {
                scheduleSubagentTranscriptsPersist(threadId)
              }
            })
            .catch((error) => {
              if (!isCurrentLoad()) return
              console.warn("[ThreadContext] Failed to retry subagent transcript hydration:", error)
              scheduleAttempt()
            })
        }, retrySchedule.delayMs)
      }

      scheduleAttempt()
    },
    [
      foregroundHydrationGeneration,
      mergeHydratedSubagentTranscripts,
      scheduleSubagentTranscriptsPersist,
      setDehydrationEligibilityRevision
    ]
  )

  const appendSubagentTranscriptMessages = useCallback(
    (
      threadId: string,
      subagentId: string,
      messages: Message[],
      options: { completeSnapshot?: boolean } = {}
    ) => {
      if (!subagentId || messages.length === 0) return
      const currentState = normalizeThreadState(
        threadStatesRef.current[threadId] || createDefaultThreadState()
      )
      const currentTranscripts =
        subagentTranscriptsRef.current[threadId] ?? currentState.subagentTranscripts
      const nextTranscripts = mergeSubagentTranscripts(
        currentTranscripts,
        subagentId,
        messages,
        options
      )
      subagentTranscriptsRef.current[threadId] = nextTranscripts
      const pendingBySubagent = subagentTranscriptPendingMessagesRef.current[threadId] ?? {}
      const mergedRows = selectMergedTranscriptRowsForPersistence(
        nextTranscripts[subagentId] ?? [],
        messages
      )
      pendingBySubagent[subagentId] = upsertTranscriptMessages(
        pendingBySubagent[subagentId] ?? [],
        mergedRows,
        options
      )
      subagentTranscriptPendingMessagesRef.current[threadId] = pendingBySubagent
      const dirtyIds = subagentTranscriptDirtyIdsRef.current[threadId] ?? new Set<string>()
      dirtyIds.add(subagentId)
      subagentTranscriptDirtyIdsRef.current[threadId] = dirtyIds
      if (
        isSubagentTranscriptPersistRetryExhausted(
          subagentTranscriptPersistRetryCountRef.current[threadId] ?? 0
        )
      ) {
        if (
          subagentTranscriptPersistChainsRef.current[threadId] ||
          subagentTranscriptPersistRetryTimersRef.current[threadId] !== undefined
        ) {
          subagentTranscriptPersistRecoveryRequestsRef.current.add(threadId)
        } else {
          // This is a real foreground delta, not an automatic retry callback.
          // It grants one fresh bounded cycle while retaining old dirty rows.
          delete subagentTranscriptPersistRetryCountRef.current[threadId]
        }
      }
      updateThreadState(threadId, () => ({
        subagentTranscripts: nextTranscripts,
        subagentTranscriptContentVersions: Object.assign(
          currentState.subagentTranscriptContentVersions,
          {
            [subagentId]: (currentState.subagentTranscriptContentVersions[subagentId] ?? 0) + 1
          }
        ),
        subagentTranscriptsRevision: currentState.subagentTranscriptsRevision + 1
      }))
      // Stream listeners are registered before history hydration completes so
      // no live event is missed. Do not persist a partial live-only bucket in
      // that window: the main process would replace the same persisted bucket
      // before its historical messages have been merged in the renderer.
      if (!currentState.subagentTranscriptBaselineReady) return
      const shouldPersistImmediately = messages.some(
        (message) => (message.content_priority ?? 0) > 0 || message.is_error === true
      )
      if (shouldPersistImmediately) {
        const existingTimer = subagentTranscriptPersistTimersRef.current[threadId]
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer)
          delete subagentTranscriptPersistTimersRef.current[threadId]
        }
        saveSubagentTranscripts(threadId, nextTranscripts, dirtyIds, true)
      } else {
        scheduleSubagentTranscriptsPersist(threadId)
      }
    },
    [saveSubagentTranscripts, scheduleSubagentTranscriptsPersist, updateThreadState]
  )

  useEffect(() => {
    threadProviderMountedRef.current = true
    return () => {
      threadProviderMountedRef.current = false
      for (const timer of Object.values(subagentTranscriptHydrationRetryTimersRef.current)) {
        window.clearTimeout(timer)
      }
      subagentTranscriptHydrationRetryTimersRef.current = {}
      subagentTranscriptHydrationRetryCountsRef.current = {}
      for (const timer of Object.values(threadHistoryHydrationRetryTimersRef.current)) {
        window.clearTimeout(timer)
      }
      threadHistoryHydrationRetryTimersRef.current = {}
      threadHistoryHydrationRetryCountsRef.current = {}
      for (const [threadId, timer] of Object.entries(subagentTranscriptPersistTimersRef.current)) {
        window.clearTimeout(timer)
        const transcripts = subagentTranscriptsRef.current[threadId] ?? {}
        const dirtyIds = subagentTranscriptDirtyIdsRef.current[threadId]
        if (dirtyIds?.size) saveSubagentTranscripts(threadId, transcripts, dirtyIds)
      }
      for (const timer of Object.values(subagentTranscriptPersistRetryTimersRef.current)) {
        window.clearTimeout(timer)
      }
      subagentTranscriptPersistRetryTimersRef.current = {}
      subagentTranscriptPersistRecoveryRequestsRef.current.clear()
    }
  }, [saveSubagentTranscripts])

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
            isEnvironmentCoordinatorMode = await window.api.agent.isCoordinatorModeForced(threadId)
            if (isEnvironmentCoordinatorMode) {
              environmentCoordinatorThreadIdsRef.current.add(threadId)
              updateThreadState(threadId, (state) =>
                state.coordinatorWorkers.length > 0
                  ? { coordinatorWorkers: [...state.coordinatorWorkers] }
                  : {}
              )
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

  /**
   * Folds a finished background workflow into the conversation: submits an
   * internal trigger turn; the main process expands it into the persisted
   * <task-notification> and the model reports the outcome. Mirrors the
   * coordinator notification scheduler (retry while the thread is busy).
   */
  const scheduleWorkflowNotificationTurn = useCallback((threadId: string) => {
    if (workflowNotificationTimersRef.current[threadId] !== undefined) return
    workflowNotificationTimersRef.current[threadId] = window.setTimeout(async () => {
      delete workflowNotificationTimersRef.current[threadId]
      try {
        const thread = useAppStore.getState().threads.find((t) => t.thread_id === threadId)
        if (!isWorkflowModeMetadata(thread?.metadata)) {
          delete workflowNotificationAttemptsRef.current[threadId]
          delete workflowNotificationRetryOnIdleRef.current[threadId]
          return
        }
        const retryLater = (): void => {
          const attempts = (workflowNotificationAttemptsRef.current[threadId] ?? 0) + 1
          workflowNotificationAttemptsRef.current[threadId] = attempts
          if (attempts <= COORDINATOR_NOTIFICATION_MAX_RETRIES) {
            scheduleWorkflowNotificationTurn(threadId)
          } else {
            delete workflowNotificationAttemptsRef.current[threadId]
          }
        }
        const streamData = streamDataRef.current[threadId]
        if (!streamData?.stream || streamData.isLoading) {
          // Busy/foreground turn in progress — defer. Flag retry-on-idle so the
          // turn-completion effect reschedules us even if the bounded retry budget
          // runs out first (a turn longer than the budget would otherwise strand
          // the notification until the next hydrate). Mirrors the coordinator path.
          workflowNotificationRetryOnIdleRef.current[threadId] = true
          retryLater()
          return
        }
        const threadState = threadStatesRef.current[threadId] ?? createDefaultThreadState()
        await streamData.stream.submit(
          { messages: [{ type: "human", content: WORKFLOW_NOTIFICATION_TURN_PROMPT }] },
          {
            config: {
              configurable: {
                thread_id: threadId,
                model_id: threadState.currentModel || undefined,
                agent_mode: "workflow"
              }
            }
          }
        )
        delete workflowNotificationAttemptsRef.current[threadId]
        delete workflowNotificationRetryOnIdleRef.current[threadId]
      } catch (error) {
        console.warn("[ThreadContext] Failed to auto-run workflow notification turn:", error)
        const attempts = (workflowNotificationAttemptsRef.current[threadId] ?? 0) + 1
        workflowNotificationAttemptsRef.current[threadId] = attempts
        if (attempts <= COORDINATOR_NOTIFICATION_MAX_RETRIES) {
          scheduleWorkflowNotificationTurn(threadId)
        } else {
          // Reset at the limit (mirrors retryLater) so a stale count can't
          // pre-suppress a future notification turn for this thread — a later
          // renotify/hydrate then gets a fresh retry budget.
          delete workflowNotificationAttemptsRef.current[threadId]
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
        // Coordinator: reschedule the worker-completion notification if any worker
        // is still awaiting it (or a busy-deferred attempt is pending).
        const workers = threadStatesRef.current[threadId]?.coordinatorWorkers ?? []
        if (
          workers.length > 0 &&
          ((coordinatorNotificationAttemptsRef.current[threadId] ?? 0) > 0 ||
            coordinatorNotificationRetryOnIdleRef.current[threadId])
        ) {
          scheduleCoordinatorNotificationTurn(threadId)
        }
        // Workflow: a completion notification deferred while this turn was busy
        // retries now that the thread is idle — so a turn longer than the retry
        // budget can't strand it until the next hydrate.
        if (workflowNotificationRetryOnIdleRef.current[threadId]) {
          scheduleWorkflowNotificationTurn(threadId)
        }
      }
    }
    previousLoadingStatesRef.current = loadingStates
  }, [loadingStates, scheduleCoordinatorNotificationTurn, scheduleWorkflowNotificationTurn])

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
            const workers = await requestCoordinatorWorkers(threadId, false)
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
  }, [
    requestCoordinatorWorkers,
    unresolvedCoordinatorThreadIdsKey,
    scheduleCoordinatorNotificationTurn,
    updateThreadState
  ])

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
      // NOTE: do NOT clear errorDetail here. The `error_detail` custom event is
      // emitted just BEFORE this error event (the error event terminates the
      // stream in useStream, so a later custom event would be dropped). Clearing
      // here would wipe the detail that was just set. Any stale detail from a
      // previous turn is reset at the next turn start (ChatContainer submit) and
      // is gated by `threadError`, so it never shows on its own.
      updateThreadState(threadId, () => ({ error: userFriendlyMessage, modelRetry: null }))
    },
    [parseErrorMessage, updateThreadState]
  )

  const applyCoordinatorAssistantSnapshotMessage = useCallback(
    (threadId: string, message: LiveStreamMessage | undefined) => {
      if (!message || !hasMessageId(message)) return

      const committedMessages = threadStatesRef.current[threadId]?.messages ?? []
      const transcriptIndex = getLiveStreamTranscriptIndex(committedMessages)
      const accumulator = getOrCreateLiveStreamAccumulator(threadId)
      const snapshotMessage = accumulator.normalizeMessageIds(
        () => transcriptIndex.messageIdentities,
        [message as LiveStreamMessage & { id: string }],
        transcriptIndex
      )[0]
      if (!snapshotMessage?.id) return
      const messageId = snapshotMessage.id
      const snapshotRole = liveStreamMessageRole(snapshotMessage.type)
      if (transcriptIndex.messageRoleIds.has(`${snapshotRole}\u0000${messageId}`)) {
        updateThreadState(threadId, (state) => {
          const updatedMessages = state.messages.map((committed) =>
            committed.id === messageId && committed.role === snapshotRole
              ? {
                  ...committed,
                  ...(typeof snapshotMessage.content === "string" && {
                    content: snapshotMessage.content
                  }),
                  ...(typeof snapshotMessage.reasoning === "string" && {
                    reasoning: snapshotMessage.reasoning
                  }),
                  ...(snapshotMessage.tool_calls && { tool_calls: snapshotMessage.tool_calls })
                }
              : committed
          )
          const updatedMessage = updatedMessages.find(
            (committed) => committed.id === messageId && committed.role === snapshotRole
          )
          return {
            messages: updatedMessages,
            toolCallStates: updatedMessage
              ? upsertToolCallStatesFromMessages(state.toolCallStates, [updatedMessage])
              : state.toolCallStates
          }
        })
        return
      }

      if (!accumulator.active) {
        accumulator.active = true
        accumulator.baselineIds = getCurrentThreadMessageIds(threadId)
        seedLiveStreamBaselineFromMessages(threadId, streamDataRef.current[threadId]?.messages)
      }

      const now = new Date()
      accumulator.messageTimes[messageId] = {
        start_at: accumulator.messageTimes[messageId]?.start_at ?? now,
        end_at: now
      }
      const hasSnapshotContent =
        (typeof snapshotMessage.content === "string" && snapshotMessage.content.length > 0) ||
        (Array.isArray(snapshotMessage.content) && snapshotMessage.content.length > 0)
      accumulator.messages = accumulator.mergeMessages(accumulator.messages, [
        {
          ...snapshotMessage,
          id: messageId,
          type: snapshotMessage.type ?? "ai",
          ...(hasSnapshotContent ? { content_priority: 1 } : {})
        }
      ])

      const currentStreamData = streamDataRef.current[threadId]
      if (currentStreamData) {
        streamDataRef.current[threadId] = {
          ...currentStreamData,
          liveMessages: liveMessagesWithTimes(accumulator)
        }
        notifyStreamSubscribers(threadId)
      }
    },
    [
      getCurrentThreadMessageIds,
      getLiveStreamTranscriptIndex,
      getOrCreateLiveStreamAccumulator,
      liveMessagesWithTimes,
      notifyStreamSubscribers,
      seedLiveStreamBaselineFromMessages,
      updateThreadState
    ]
  )

  const applyMessageIdAlias = useCallback(
    (
      threadId: string,
      fromId?: string,
      toId?: string,
      role?: Message["role"],
      completedProviderSourceId?: string,
      completedProviderOccurrence?: number,
      rendererOnlyAlias = false
    ) => {
      if (!fromId || !toId || fromId === toId) return
      const committedMessages = threadStatesRef.current[threadId]?.messages ?? []
      const liveMessages = streamDataRef.current[threadId]?.liveMessages ?? []
      const accumulatorMessages = liveStreamAccumulatorsRef.current[threadId]?.messages ?? []
      const findRole = (id: string): Message["role"] | undefined => {
        const committedRole = committedMessages.find((message) => message.id === id)?.role
        if (committedRole) return committedRole
        const liveMessage =
          liveMessages.find((message) => message.id === id) ??
          accumulatorMessages.find((message) => message.id === id)
        return liveMessage ? liveStreamMessageRole(liveMessage.type) : undefined
      }
      const aliasRole = role ?? findRole(fromId) ?? findRole(toId)
      const roleCollisionBaseline = [
        ...committedMessages,
        ...liveMessages.filter(hasMessageId),
        ...accumulatorMessages.filter(hasMessageId)
      ]
      const resolveAliasSourceId = (id: string): string => {
        if (!aliasRole) return id
        return normalizeAppendedMessageIds(roleCollisionBaseline, [{ id, role: aliasRole }])[0].id
      }
      const resolveAliasTargetId = (id: string): string => {
        if (!aliasRole) return id
        return normalizeAppendedMessageIds(roleCollisionBaseline, [{ id, role: aliasRole }])[0].id
      }
      const resolvedFromId = rendererOnlyAlias ? fromId : resolveAliasSourceId(fromId)
      const resolvedToId = rendererOnlyAlias ? toId : resolveAliasTargetId(toId)
      if (resolvedFromId === resolvedToId) return

      const sourceMessage = committedMessages.find(
        (message) => message.id === resolvedFromId && (!aliasRole || message.role === aliasRole)
      )
      const targetMessage = committedMessages.find(
        (message) => message.id === resolvedToId && (!aliasRole || message.role === aliasRole)
      )
      if (sourceMessage && targetMessage && sourceMessage.role !== targetMessage.role) {
        console.error("[ThreadContext] Refusing cross-role message id alias:", {
          threadId,
          fromId: resolvedFromId,
          fromRole: sourceMessage.role,
          toId: resolvedToId,
          toRole: targetMessage.role
        })
        return
      }

      const commitLocalAlias = (): void => {
        const accumulator = liveStreamAccumulatorsRef.current[threadId]
        if (accumulator) {
          accumulator.messages = replaceLiveStreamMessageId(
            accumulator.messages,
            resolvedFromId,
            resolvedToId,
            completedProviderSourceId,
            completedProviderOccurrence
          )
          accumulator.normalizeMessageIds = createLiveStreamMessageIdNormalizer()
          accumulator.mergeMessages = createLiveStreamMessageMerger()
          accumulator.projectCumulativeFrame = createLiveStreamCumulativeFrameProjector()
          accumulator.projectTimedMessages = createTimedLiveStreamMessageProjector()
          const fromTime = accumulator.messageTimes[resolvedFromId]
          if (fromTime) {
            const targetTime = accumulator.messageTimes[resolvedToId]
            accumulator.messageTimes[resolvedToId] = targetTime
              ? {
                  start_at:
                    fromTime.start_at.getTime() <= targetTime.start_at.getTime()
                      ? fromTime.start_at
                      : targetTime.start_at,
                  ...(fromTime.end_at || targetTime.end_at
                    ? {
                        end_at:
                          !targetTime.end_at ||
                          (fromTime.end_at &&
                            fromTime.end_at.getTime() > targetTime.end_at.getTime())
                            ? fromTime.end_at
                            : targetTime.end_at
                      }
                    : {})
                }
              : fromTime
            delete accumulator.messageTimes[resolvedFromId]
          }
          accumulator.baselineIds.delete(resolvedFromId)
        }

        updateThreadState(threadId, (state) => {
          const sourceIndex = state.messages.findIndex(
            (message) => message.id === resolvedFromId && (!aliasRole || message.role === aliasRole)
          )
          if (sourceIndex < 0) return {}

          const sourceMessage = state.messages[sourceIndex]
          const providerSourceId = getMessageProviderSourceId(sourceMessage)
          const canonicalSource = {
            ...sourceMessage,
            id: resolvedToId,
            provider_source_id:
              completedProviderSourceId ?? sourceMessage.provider_source_id ?? providerSourceId,
            ...(completedProviderOccurrence &&
            Number.isInteger(completedProviderOccurrence) &&
            completedProviderOccurrence >= 1
              ? {
                  provider_occurrence:
                    completedProviderOccurrence ?? sourceMessage.provider_occurrence
                }
              : {})
          }
          const targetIndex = state.messages.findIndex(
            (message) => message.id === resolvedToId && (!aliasRole || message.role === aliasRole)
          )
          const canonicalMessage =
            targetIndex >= 0
              ? mergeLiveStreamCommitMessages([canonicalSource], [state.messages[targetIndex]])[0]
              : canonicalSource
          const insertionIndex = targetIndex >= 0 ? Math.min(sourceIndex, targetIndex) : sourceIndex

          return {
            messages: state.messages.flatMap((message, index) => {
              if (index === insertionIndex) return [canonicalMessage]
              if (
                (message.id === resolvedFromId || message.id === resolvedToId) &&
                (!aliasRole || message.role === aliasRole)
              ) {
                return []
              }
              return [message]
            })
          }
        })

        const transitionalLiveMessages = transitionalLiveMessagesRef.current[threadId]
        if (transitionalLiveMessages) {
          transitionalLiveMessagesRef.current[threadId] = replaceLiveStreamMessageId(
            transitionalLiveMessages,
            resolvedFromId,
            resolvedToId,
            completedProviderSourceId,
            completedProviderOccurrence
          )
        }
        const currentStreamData = streamDataRef.current[threadId]
        if (currentStreamData) {
          streamDataRef.current[threadId] = {
            ...currentStreamData,
            liveMessages: replaceLiveStreamMessageId(
              currentStreamData.liveMessages ?? [],
              resolvedFromId,
              resolvedToId,
              completedProviderSourceId,
              completedProviderOccurrence
            )
          }
          notifyStreamSubscribers(threadId)
        }
      }

      // This source id was generated only by the renderer for an id-less chunk.
      // It cannot exist in durable storage, while the stable afterModel row is
      // already persisted. Apply the alias synchronously so the immediately
      // following stable event cannot render as a second message.
      if (rendererOnlyAlias) {
        const aliases =
          rendererOnlyMessageIdAliasesRef.current[threadId] ??
          new Map<string, LiveStreamMessageIdAlias>()
        aliases.set(resolvedFromId, {
          fromId: resolvedFromId,
          toId: resolvedToId,
          ...(completedProviderSourceId ? { providerSourceId: completedProviderSourceId } : {}),
          ...(completedProviderOccurrence
            ? { providerOccurrence: completedProviderOccurrence }
            : {})
        })
        rendererOnlyMessageIdAliasesRef.current[threadId] = aliases
        commitLocalAlias()
        return
      }

      void (async () => {
        let lastError: unknown
        for (const delay of [0, 100, 300]) {
          if (delay > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, delay))
          }
          try {
            const result = await window.api.threads.replaceMessageId(
              threadId,
              resolvedFromId,
              resolvedToId,
              aliasRole
            )
            if (!result.replaced) {
              console.warn("[ThreadContext] Message id migration was rejected:", {
                threadId,
                fromId: resolvedFromId,
                toId: resolvedToId
              })
              return
            }
            commitLocalAlias()
            return
          } catch (error) {
            lastError = error
          }
        }
        console.error("[ThreadContext] Failed to persist message id migration:", lastError)
      })()
    },
    [notifyStreamSubscribers, updateThreadState]
  )

  // Handle custom events from ThreadStreamHolder (interrupts, workspace updates, etc.)
  const handleCustomEvent = useCallback(
    (threadId: string, data: CustomEventData) => {
      if (import.meta.env.DEV && data.type !== "coordinator_ai_snapshot_message") {
        console.debug("[ThreadContext] Custom event received:", {
          threadId,
          type: data.type,
          fileCount: Array.isArray(data.files) ? data.files.length : undefined,
          workerCount: Array.isArray(data.workers) ? data.workers.length : undefined,
          subagentCount: Array.isArray(data.subagents) ? data.subagents.length : undefined
        })
      }
      switch (data.type) {
        case "message_id_alias":
          applyMessageIdAlias(
            threadId,
            data.fromId,
            data.toId,
            data.role === "user" ||
              data.role === "assistant" ||
              data.role === "system" ||
              data.role === "tool"
              ? data.role
              : undefined,
            data.currentRunCompleted === true ? data.providerSourceId : undefined,
            data.currentRunCompleted === true ? data.providerOccurrence : undefined,
            data.rendererOnlyAlias === true
          )
          break
        case "stream_retry_reset": {
          const discardedMessageIds = new Set(
            Array.isArray(data.discardedMessageIds) ? data.discardedMessageIds : []
          )
          const stableMessages = Array.isArray(data.messages) ? data.messages : []
          const accumulator = getOrCreateLiveStreamAccumulator(threadId)
          accumulator.messages = []
          accumulator.normalizeMessageIds = createLiveStreamMessageIdNormalizer()
          accumulator.mergeMessages = createLiveStreamMessageMerger()
          accumulator.projectCumulativeFrame = createLiveStreamCumulativeFrameProjector()
          accumulator.projectTimedMessages = createTimedLiveStreamMessageProjector()
          accumulator.messageTimes = {}
          accumulator.lastStartedAtMs = undefined
          for (const messageId of discardedMessageIds) {
            accumulator.baselineIds.delete(messageId)
          }

          const current = streamDataRef.current[threadId] ?? defaultStreamData
          streamDataRef.current[threadId] = {
            ...current,
            messages: stableMessages as StreamData["messages"],
            liveMessages: []
          }
          notifyStreamSubscribers(threadId)
          break
        }
        case "coordinator_ai_snapshot_message":
          applyCoordinatorAssistantSnapshotMessage(threadId, data.assistantMessage)
          break
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
              const cachedIndex = getWorkspaceFilePathIndex(state.workspaceFiles)
              // Large disk snapshots are registered with an O(1) path index.
              // A missing index only belongs to an early/small legacy state;
              // never synchronously rebuild an unbounded map on a stream event.
              if (!cachedIndex && state.workspaceFiles.length > 1_024) {
                if (state.workspacePath) {
                  markWorkspaceFilesStale(threadId, state.workspacePath)
                }
                return {}
              }
              const fileMap =
                cachedIndex ?? new Map(state.workspaceFiles.map((file) => [file.path, file]))
              let nextFiles: typeof state.workspaceFiles | null = null
              for (const f of data.files!) {
                const existing = fileMap.get(f.path)
                if (existing) {
                  existing.is_dir = f.is_dir
                  existing.size = f.size
                  continue
                }
                const next = { path: f.path, is_dir: f.is_dir, size: f.size }
                fileMap.set(f.path, next)
                nextFiles ??= state.workspaceFiles.slice()
                nextFiles.push(next)
              }
              if (!nextFiles) return {}
              registerWorkspaceFilePathIndex(nextFiles, fileMap)
              return { workspaceFiles: nextFiles }
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
            const parentStreamData = streamDataRef.current[threadId]
            const parentStreamIsActive =
              parentStreamData?.isLoading === true ||
              threadStatesRef.current[threadId]?.scheduledTaskLoading === true
            const parentStreamHasStopped =
              parentStreamData?.isLoading === false &&
              threadStatesRef.current[threadId]?.scheduledTaskLoading !== true
            const fallbackCompletedAt = parentStreamHasStopped ? new Date() : undefined
            const incomingSubagents = data.subagents.map((subagent) => ({
              ...subagent,
              id: subagent.id || crypto.randomUUID(),
              name: subagent.name || "Subagent",
              description: subagent.description ?? "",
              status: (subagent.status || "running") as Subagent["status"]
            }))
            updateThreadState(threadId, (prev) => ({
              subagents: mergeSubagentSnapshotWithHistory(prev.subagents, incomingSubagents, {
                parentStreamHasStopped,
                parentStreamIsActive,
                fallbackCompletedAt
              })
            }))
          }
          break
        case "subagent_delta":
          if (data.subagentId && data.subagentPatch) {
            updateThreadState(threadId, (previous) => {
              const index = previous.subagents.findIndex(
                (subagent) => subagent.id === data.subagentId
              )
              if (index < 0) return {}
              const current = previous.subagents[index]
              const next = { ...current, ...data.subagentPatch }
              if (
                next.currentTool === current.currentTool &&
                next.lastActivityAt === current.lastActivityAt
              ) {
                return {}
              }
              const subagents = previous.subagents.slice()
              subagents[index] = next
              return { subagents }
            })
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
        case "subagent_transcript_message": {
          const subagentId = data.subagentId
          if (subagentId && data.subagentMessages?.length) {
            appendSubagentTranscriptMessages(threadId, subagentId, data.subagentMessages, {
              completeSnapshot: true
            })
          }
          if (subagentId && data.subagentMessage) {
            appendSubagentTranscriptMessages(threadId, subagentId, [data.subagentMessage])
          }
          break
        }
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
        case "workflow_progress":
          if (data.workflowEvent && typeof data.workflowEvent === "object") {
            const workflowEvent = data.workflowEvent
            const buffer = workflowProgressBufferRef.current
            let bufEntry = buffer.get(threadId)
            if (!bufEntry) {
              bufEntry = { events: [], rafId: null }
              buffer.set(threadId, bufEntry)
            }
            bufEntry.events.push(workflowEvent)
            // Apply all buffered events in one updateThreadState (one re-render).
            const flush = (): void => {
              const e = buffer.get(threadId)
              if (!e) return
              if (e.rafId !== null) {
                cancelAnimationFrame(e.rafId)
                e.rafId = null
              }
              if (e.events.length === 0) return
              const batch = e.events
              e.events = []
              updateThreadState(threadId, (prev) => {
                let view = prev.workflowRun
                for (const ev of batch) view = applyWorkflowProgressEvent(view, ev)
                return view === prev.workflowRun ? {} : { workflowRun: view }
              })
              // Drained with no frame pending → drop the entry so finished/idle
              // workflow threads don't retain an empty buffer forever. A later
              // event re-creates it (buffer.get → falls through to set above). (#2)
              if (e.rafId === null && e.events.length === 0) buffer.delete(threadId)
            }
            // Terminal event flushes now (no frame delay on completion); otherwise
            // coalesce a burst into a single per-frame apply.
            if (workflowEvent.kind === "finished") {
              flush()
            } else if (bufEntry.rafId === null) {
              bufEntry.rafId = requestAnimationFrame(flush)
            }
          }
          break
        case "agent_mode":
          if (data.mode === "normal" || data.mode === "coordinator" || data.mode === "workflow") {
            if (
              data.mode === "coordinator" &&
              data.persisted === false &&
              data.source === "environment"
            ) {
              environmentCoordinatorThreadIdsRef.current.add(threadId)
            } else if (data.mode !== "coordinator") {
              environmentCoordinatorThreadIdsRef.current.delete(threadId)
            }
            if (data.persisted === false) {
              updateThreadState(threadId, (state) =>
                state.coordinatorWorkers.length > 0
                  ? { coordinatorWorkers: [...state.coordinatorWorkers] }
                  : {}
              )
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
            updateThreadState(threadId, (state) =>
              state.coordinatorWorkers.length > 0
                ? { coordinatorWorkers: [...state.coordinatorWorkers] }
                : {}
            )
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
        case CONTEXT_COMPACTION_EVENT_TYPE: {
          const compaction = parseContextCompactionLifecycleEvent(data.compaction)
          if (!compaction) break

          const existingTimer = contextCompactionDismissTimersRef.current[threadId]
          if (existingTimer !== undefined) {
            window.clearTimeout(existingTimer)
            delete contextCompactionDismissTimersRef.current[threadId]
          }

          updateThreadState(threadId, (prev) => {
            const current = prev.contextCompaction
            if (
              compaction.phase !== "started" &&
              current?.phase === "started" &&
              current.id !== compaction.id
            ) {
              return {}
            }
            return { contextCompaction: compaction }
          })

          if (compaction.phase !== "started") {
            const dismissMs =
              compaction.phase === "completed"
                ? CONTEXT_COMPACTION_COMPLETE_DISMISS_MS
                : CONTEXT_COMPACTION_FAILED_DISMISS_MS
            contextCompactionDismissTimersRef.current[threadId] = window.setTimeout(() => {
              delete contextCompactionDismissTimersRef.current[threadId]
              updateThreadState(threadId, (prev) =>
                prev.contextCompaction?.id === compaction.id ? { contextCompaction: null } : {}
              )
            }, dismissMs)
          }
          break
        }
        case "error_detail":
          // Structured diagnostics for the failed turn. Arrives just before the
          // plain `error` event (which sets `error`); stored separately so the
          // error card can render status / request-id / real reason.
          if (data.detail && typeof data.detail === "object") {
            const detail = data.detail as ApiErrorDetailState
            updateThreadState(threadId, () => ({ errorDetail: detail }))
          }
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
        case "harness_session_context_inject_warning":
          if (typeof data.message === "string" && data.message.trim()) {
            toast.warning(data.message)
          }
          updateThreadState(threadId, () => ({ harnessAgentmdLoadStatus: null }))
          break
        case "harness_agentmd_load_status": {
          const items = normalizeHarnessAgentmdLoadStatus(data.agentmdLoadStatus)
          const loader = data.agentmdLoader === "cmbdevclaw" ? "cmbdevclaw" : "plugin"
          const promptPreview =
            typeof data.agentmdPromptPreview === "string" && data.agentmdPromptPreview.trim()
              ? data.agentmdPromptPreview
              : undefined
          const createdAt =
            typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
              ? data.createdAt
              : Date.now()
          updateThreadState(threadId, () => ({
            harnessAgentmdLoadStatus:
              items.length > 0 || promptPreview ? { items, createdAt, loader, promptPreview } : null
          }))
          break
        }
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
            errorDetail: null,
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
        case "failure_fuse_warning": {
          const toolName =
            typeof data.toolName === "string" && data.toolName.trim() ? data.toolName : undefined
          const countText =
            typeof data.count === "number" && typeof data.threshold === "number"
              ? `（${data.count}/${data.threshold}）`
              : ""
          const prefix = data.action === "strong_warn" ? "工具重复失败强提醒" : "工具重复失败提醒"
          const message =
            typeof data.count === "number"
              ? `同类错误已重复出现 ${data.count} 次，本轮不会停止。`
              : "同类工具错误重复出现，本轮不会停止。"
          toast.warning(`${prefix}${toolName ? `：${toolName}` : ""}${countText}：${message}`)
          break
        }
        case "failure_fuse_tripped": {
          const reason =
            (typeof data.reason === "string" && data.reason.trim()) ||
            (typeof data.message === "string" && data.message.trim()) ||
            "同类工具错误重复出现，已停止本轮以避免继续重试"
          const toolName =
            typeof data.toolName === "string" && data.toolName.trim() ? data.toolName : undefined
          const details = [
            toolName ? `tool=${toolName}` : undefined,
            typeof data.count === "number" && typeof data.threshold === "number"
              ? `count=${data.count}/${data.threshold}`
              : undefined,
            typeof data.fingerprint === "string" && data.fingerprint.trim()
              ? `fingerprint=${data.fingerprint}`
              : undefined,
            typeof data.lastError === "string" && data.lastError.trim()
              ? `lastError=${data.lastError}`
              : undefined
          ].filter((item): item is string => Boolean(item))
          updateThreadState(threadId, () => ({
            error: null,
            errorDetail: null,
            hookInterruption: {
              event: toolName ? `Failure fuse: ${toolName}` : "Failure fuse",
              action: "halt",
              reason,
              systemMessage: details.length > 0 ? details.join("\n") : undefined,
              timestamp: new Date()
            }
          }))
          toast.warning(`工具失败熔断已停止本轮：${reason}`)
          break
        }
        case "action_stationarity_tripped": {
          const reason =
            (typeof data.reason === "string" && data.reason.trim()) ||
            "完全相同的工具调用连续出现，已停止本轮以避免继续空转"
          const toolName =
            typeof data.toolName === "string" && data.toolName.trim() ? data.toolName : undefined
          const details = [
            toolName ? `tool=${toolName}` : undefined,
            typeof data.count === "number" && typeof data.threshold === "number"
              ? `count=${data.count}/${data.threshold}`
              : undefined,
            typeof data.fingerprint === "string" && data.fingerprint.trim()
              ? `fingerprint=${data.fingerprint}`
              : undefined
          ].filter((item): item is string => Boolean(item))
          updateThreadState(threadId, () => ({
            error: null,
            errorDetail: null,
            hookInterruption: {
              event: toolName ? `Tool-call loop: ${toolName}` : "Tool-call loop",
              action: "halt",
              reason,
              systemMessage: details.length > 0 ? details.join("\n") : undefined,
              timestamp: new Date()
            }
          }))
          toast.warning(`重复工具调用熔断已停止本轮：${reason}`)
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
            turnId: normalizeHookLogTurnId(
              threadStatesRef.current[threadId]?.messages ?? [],
              data.turnId
            ),
            workerId: data.workerId,
            workerThreadId: data.workerThreadId,
            workerTurn: data.workerTurn,
            parentThreadId: data.parentThreadId
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
          //   3. worker hook without entry.turnId → create / append to a
          //      worker-scoped placeholder bucket.
          //   4. entry.turnId missing → create / append to a dedicated
          //      background-events bucket. Older code routed these to
          //      `buckets[last]` which polluted whichever user turn happened
          //      to be most recent (e.g. SessionStart firing after a new
          //      conversation began would inflate the previous chip).
          const buckets = hookLogBucketsRef.current[threadId] ?? []
          const BACKGROUND_BUCKET_ID = "__background__"
          const workerBucketId = entry.workerThreadId
            ? `__worker__:${entry.workerThreadId}:${entry.workerTurn ?? "unknown"}`
            : ""
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
                { ...target, entries: appendBoundedHookLogEntry(target.entries, entry) },
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
          } else if (workerBucketId) {
            const workerIdx = buckets.findIndex((bucket) => bucket.turnId === workerBucketId)
            if (workerIdx >= 0) {
              const target = buckets[workerIdx]
              nextBuckets = [
                ...buckets.slice(0, workerIdx),
                { ...target, entries: appendBoundedHookLogEntry(target.entries, entry) },
                ...buckets.slice(workerIdx + 1)
              ]
            } else {
              const workerThreadId = entry.workerThreadId ?? ""
              const workerLabel =
                entry.workerId ??
                (workerThreadId.includes("__worker__")
                  ? workerThreadId.split("__worker__").pop()
                  : workerThreadId)
              nextBuckets = trim([
                ...buckets,
                {
                  turnId: workerBucketId,
                  turnPreview:
                    typeof entry.workerTurn === "number"
                      ? `(Worker ${workerLabel} 第 ${entry.workerTurn} 轮 Hook)`
                      : `(Worker ${workerLabel} Hook)`,
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
                { ...target, entries: appendBoundedHookLogEntry(target.entries, entry) },
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
      applyCoordinatorAssistantSnapshotMessage,
      applyMessageIdAlias,
      flushGoalSubturnComplete,
      getOrCreateLiveStreamAccumulator,
      notifyHookLogSubscribers,
      notifyStreamSubscribers,
      appendSubagentTranscriptMessages,
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
        syncDurableTranscript: async (requiredMessageIds: string[] = []) => {
          const seq = durableTranscriptSyncGateRef.current.begin(threadId)
          return applyDurableTranscriptSnapshot(threadId, seq, requiredMessageIds)
        },
        appendMessage: (message: Message) => {
          const normalizedMessage =
            normalizeMessageRoleCollisionIds(threadStatesRef.current[threadId]?.messages ?? [], [
              message
            ])[0] ?? message
          // Open a new hook-log bucket for each user turn instead of clearing.
          // Old buckets stay around (up to HOOK_LOG_BUCKET_RING_SIZE) so a
          // user can scroll back and inspect what hooks ran in earlier turns.
          if (normalizedMessage.role === "user") {
            coordinatorNotificationAutoRunSuppressedRef.current.delete(threadId)
            const suppressTimer = coordinatorNotificationSuppressTimersRef.current[threadId]
            if (suppressTimer !== undefined) {
              window.clearTimeout(suppressTimer)
            }
            delete coordinatorNotificationSuppressTimersRef.current[threadId]
            const pendingSourceTurnIds =
              pendingHookLogBucketOpensRef.current[threadId] ?? new Set<string>()
            pendingSourceTurnIds.add(message.id)
            pendingHookLogBucketOpensRef.current[threadId] = pendingSourceTurnIds
          }
          updateThreadState(threadId, (state) => {
            const currentMessage =
              normalizeMessageRoleCollisionIds(state.messages, [normalizedMessage])[0] ??
              normalizedMessage
            const exists = state.messages.some(
              (current) => current.id === currentMessage.id && current.role === currentMessage.role
            )
            let nextToolCallStates = state.toolCallStates
            if (Array.isArray(currentMessage.tool_calls)) {
              for (const toolCall of currentMessage.tool_calls) {
                nextToolCallStates = upsertToolCallState(nextToolCallStates, toolCall.id, {
                  name: toolCall.name,
                  args: toolCall.args,
                  status: "queued"
                })
              }
            }
            if (currentMessage.role === "tool" && currentMessage.tool_call_id) {
              nextToolCallStates = upsertToolCallState(
                nextToolCallStates,
                currentMessage.tool_call_id,
                {
                  name: currentMessage.name,
                  status: toolResultStatusFromMessage(currentMessage)
                }
              )
            }
            if (exists) {
              return {
                messages: state.messages.map((current) =>
                  current.id === currentMessage.id && current.role === currentMessage.role
                    ? {
                        ...currentMessage,
                        ...(currentMessage.role === "assistant" &&
                        !currentMessage.reasoning &&
                        current.role === "assistant" &&
                        current.reasoning
                          ? { reasoning: current.reasoning }
                          : {})
                      }
                    : current
                ),
                toolCallStates: nextToolCallStates,
                ...(isVisibleCheckpointTranscriptMessage(currentMessage)
                  ? { historyConversationPresence: "nonempty" as const }
                  : {}),
                hookInterruption: currentMessage.role === "user" ? null : state.hookInterruption
              }
            }
            return {
              messages: [...state.messages, currentMessage],
              toolCallStates: nextToolCallStates,
              ...(isVisibleCheckpointTranscriptMessage(currentMessage)
                ? { historyConversationPresence: "nonempty" as const }
                : {}),
              hookInterruption: currentMessage.role === "user" ? null : state.hookInterruption
            }
          })
        },
        removeLocalMessage: (messageId: string) => {
          updateThreadState(threadId, (state) => {
            if (!state.messages.some((message) => message.id === messageId)) return {}
            return { messages: state.messages.filter((message) => message.id !== messageId) }
          })
        },
        setMessages: (messages: Message[]) => {
          updateThreadState(threadId, (state) => {
            // A complete transcript snapshot can legitimately contain multiple
            // records that reuse a provider id. Preserve every record while
            // assigning stable render ids instead of collapsing same-role rows.
            const normalizedMessages = mergeCheckpointAuthorityTranscriptMessages(messages, [])
            const messagesWithPreservedReasoning =
              preserveAssistantReasoningByRoleCollisionIdentity(state.messages, normalizedMessages)
            const nextToolCallStates = upsertToolCallStatesFromMessages(
              state.toolCallStates,
              normalizedMessages
            )

            return {
              messages: messagesWithPreservedReasoning,
              toolCallStates: nextToolCallStates,
              ...(messagesWithPreservedReasoning.some(isVisibleCheckpointTranscriptMessage)
                ? { historyConversationPresence: "nonempty" as const }
                : {})
            }
          })
        },
        loadEarlierMessages: async () => {
          const state = threadStatesRef.current[threadId]
          const cursor = state?.historyPageCursor
          if (!state?.historyHasMore || state.historyPageLoading || !cursor) return 0
          const loadGeneration = threadHistoryLoadGenerationRef.current[threadId] ?? 0
          cancelThreadHistoryHydrationRetry(threadId)
          const intent = messageWindowIntentCoordinator.begin(threadId, "older")
          const isCurrentLoad = (): boolean =>
            initializedThreadsRef.current.has(threadId) &&
            threadHistoryLoadGenerationRef.current[threadId] === loadGeneration &&
            messageWindowIntentCoordinator.isCurrent(intent)
          updateThreadState(threadId, () => ({ historyPageLoading: true }))
          try {
            const page = await window.api.threads.getMessagesPage(threadId, {
              beforeOrdinal: cursor.beforeOrdinal,
              beforeMessageId: cursor.beforeMessageId,
              limit: 500
            })
            if (!isCurrentLoad()) return 0
            const olderMessages = normalizePersistedThreadMessages(page.messages).filter(
              isVisibleCheckpointTranscriptMessage
            )
            rememberDurableMessageIds(threadId, olderMessages)
            const pageWindow = createThreadMessagePageWindow(olderMessages, cursor)
            let prependedMessageCount = 0
            updateThreadState(threadId, (latest) => {
              if (
                latest.historyPageCursor?.beforeOrdinal !== cursor.beforeOrdinal ||
                latest.historyPageCursor.beforeMessageId !== cursor.beforeMessageId
              ) {
                return { historyPageLoading: false }
              }
              const pageWindows = prependThreadMessagePageWindow(
                latest.historyPageWindows,
                pageWindow
              )
              const pageBoundaryIds = new Set(pageWindows.map((window) => window.lastMessageId))
              const durableBoundaryIds = collectKnownDurableMessageIds(
                pageWindows,
                knownDurableMessageIdsRef.current[threadId],
                olderMessages
              )
              const windowResult = prependBoundedThreadMessagePage(latest.messages, olderMessages, {
                maximumResidentMessages: THREAD_MESSAGE_RESIDENT_LIMIT,
                protectedTailMessages: THREAD_MESSAGE_PROTECTED_TAIL,
                existingGap: latest.historyWindowGap,
                preferredPrefixBoundaryMessageIds: pageBoundaryIds,
                fallbackReloadBoundaryMessageIds: durableBoundaryIds,
                requireReloadableGap: true
              })
              const residentIdentities = new Set(latest.messages.map(threadMessagePageIdentity))
              prependedMessageCount = olderMessages.reduce(
                (count, message) =>
                  count + (residentIdentities.has(threadMessagePageIdentity(message)) ? 0 : 1),
                0
              )
              const nextToolCallStates = retainResidentToolCallStates(
                upsertToolCallStatesFromMessages(latest.toolCallStates, olderMessages),
                windowResult.messages
              )
              return {
                messages: windowResult.messages,
                toolCallStates: nextToolCallStates,
                historyPageLoading: false,
                historyHasMore: page.hasMore,
                historyPageCursor:
                  page.hasMore && page.beforeOrdinal !== null && page.beforeMessageId !== null
                    ? {
                        beforeOrdinal: page.beforeOrdinal,
                        beforeMessageId: page.beforeMessageId
                      }
                    : null,
                historyPageWindows: pageWindows,
                historyWindowGap: attachThreadMessageGapReload(
                  windowResult.gap,
                  pageWindows,
                  durableBoundaryIds
                ),
                historyMessageTotal: page.total,
                historyLoadedMessageCount: Math.min(
                  page.total,
                  latest.historyLoadedMessageCount + page.messages.length
                )
              }
            })
            messageWindowIntentCoordinator.finish(intent)
            return prependedMessageCount
          } catch (error) {
            if (!isCurrentLoad()) return 0
            console.warn("[ThreadContext] Failed to load earlier messages:", error)
            updateThreadState(threadId, () => ({ historyPageLoading: false }))
            messageWindowIntentCoordinator.finish(intent)
            return 0
          }
        },
        loadMessageWindowAround: async (target) => {
          const state = threadStatesRef.current[threadId]
          if (!state) return false
          if (!target.messageId || !Number.isSafeInteger(target.ordinal) || target.ordinal < 0) {
            return false
          }
          const loadGeneration = threadHistoryLoadGenerationRef.current[threadId] ?? 0
          cancelThreadHistoryHydrationRetry(threadId)
          const intent = messageWindowIntentCoordinator.begin(threadId, "target")
          const isCurrentLoad = (): boolean =>
            initializedThreadsRef.current.has(threadId) &&
            threadHistoryLoadGenerationRef.current[threadId] === loadGeneration &&
            messageWindowIntentCoordinator.isCurrent(intent)
          updateThreadState(threadId, () => ({ historyPageLoading: true }))
          try {
            const page = await window.api.threads.getMessagesPage(threadId, {
              targetMessageId: target.messageId,
              limit: TARGETED_THREAD_MESSAGE_PAGE_LIMIT
            })
            if (!isCurrentLoad()) return false
            const targetMessages = normalizePersistedThreadMessages(page.messages).filter(
              isVisibleCheckpointTranscriptMessage
            )
            rememberDurableMessageIds(threadId, targetMessages)
            if (!targetMessages.some((message) => message.id === target.messageId)) {
              updateThreadState(threadId, () => ({ historyPageLoading: false }))
              messageWindowIntentCoordinator.finish(intent)
              return false
            }

            let loaded = false
            updateThreadState(threadId, (latest) => {
              const windowResult = createTargetedThreadMessageWindow(
                latest.messages,
                targetMessages,
                {
                  targetMessageId: target.messageId,
                  maximumResidentMessages: THREAD_MESSAGE_RESIDENT_LIMIT,
                  protectedTailMessages: THREAD_MESSAGE_PROTECTED_TAIL,
                  existingGap: latest.historyWindowGap
                }
              )
              loaded = windowResult.messages.some((message) => message.id === target.messageId)
              const nextToolCallStates = retainResidentToolCallStates(
                upsertToolCallStatesFromMessages(latest.toolCallStates, targetMessages),
                windowResult.messages
              )
              const targetPageWindow = createThreadMessagePageWindow(targetMessages, {
                targetMessageId: target.messageId
              })
              const forwardPageWindow = createForwardThreadMessagePageWindow(target.messageId)
              const pageWindows = [
                targetPageWindow,
                ...(forwardPageWindow ? [forwardPageWindow] : []),
                ...latest.historyPageWindows.filter((window) => window.reloadCursor === null)
              ]
              return {
                messages: windowResult.messages,
                toolCallStates: nextToolCallStates,
                historyPageLoading: false,
                historyHasMore: page.hasMore,
                historyPageCursor:
                  page.hasMore && page.beforeOrdinal !== null && page.beforeMessageId !== null
                    ? {
                        beforeOrdinal: page.beforeOrdinal,
                        beforeMessageId: page.beforeMessageId
                      }
                    : null,
                historyPageWindows: pageWindows,
                historyWindowGap: attachThreadMessageGapReload(windowResult.gap, pageWindows),
                historyMessageTotal: page.total,
                historyLoadedMessageCount: Math.min(
                  page.total,
                  latest.historyLoadedMessageCount + page.messages.length
                )
              }
            })
            messageWindowIntentCoordinator.finish(intent)
            return loaded
          } catch (error) {
            if (!isCurrentLoad()) return false
            console.warn("[ThreadContext] Failed to load targeted message window:", error)
            updateThreadState(threadId, () => ({ historyPageLoading: false }))
            messageWindowIntentCoordinator.finish(intent)
            return false
          }
        },
        loadReleasedMessageWindow: async () => {
          const state = threadStatesRef.current[threadId]
          const gap = state?.historyWindowGap
          if (!state || !gap || !gap.reloadTargetMessageId) {
            return false
          }
          const reloadCursor = gap.reloadAnchorMessageId
            ? { anchorMessageId: gap.reloadAnchorMessageId }
            : gap.reloadExactMessageId
              ? { targetMessageId: gap.reloadExactMessageId }
              : gap.reloadBeforeOrdinal !== null && gap.reloadBeforeMessageId !== null
                ? {
                    beforeOrdinal: gap.reloadBeforeOrdinal,
                    beforeMessageId: gap.reloadBeforeMessageId
                  }
                : null
          const isForwardReload = isForwardThreadMessagePageCursor(reloadCursor)
          const loadGeneration = threadHistoryLoadGenerationRef.current[threadId] ?? 0
          cancelThreadHistoryHydrationRetry(threadId)
          const intent = messageWindowIntentCoordinator.begin(threadId, "gap")
          const isCurrentLoad = (): boolean =>
            initializedThreadsRef.current.has(threadId) &&
            threadHistoryLoadGenerationRef.current[threadId] === loadGeneration &&
            messageWindowIntentCoordinator.isCurrent(intent)
          updateThreadState(threadId, () => ({ historyPageLoading: true }))
          try {
            const page = await window.api.threads.getMessagesPage(threadId, {
              ...(reloadCursor ?? {}),
              limit: TARGETED_THREAD_MESSAGE_PAGE_LIMIT
            })
            if (!isCurrentLoad()) return false
            const reloadedMessages = normalizePersistedThreadMessages(page.messages).filter(
              isVisibleCheckpointTranscriptMessage
            )
            rememberDurableMessageIds(threadId, reloadedMessages)
            if (
              isForwardReload
                ? page.verifiedAnchorMessageId !== gap.reloadTargetMessageId
                : !isThreadMessagePageContinuousWithBoundary(
                    reloadedMessages,
                    gap.reloadTargetMessageId
                  )
            ) {
              updateThreadState(threadId, () => ({ historyPageLoading: false }))
              messageWindowIntentCoordinator.finish(intent)
              return false
            }
            // A verified anchor with no newer durable row is not progress. Keep the gap intact so
            // a later durable sync/retry can continue instead of repeatedly closing on the anchor.
            if (
              isForwardReload &&
              !isThreadMessageForwardPageProgress(
                reloadedMessages,
                page.verifiedAnchorMessageId,
                gap.reloadTargetMessageId
              )
            ) {
              updateThreadState(threadId, () => ({ historyPageLoading: false }))
              messageWindowIntentCoordinator.finish(intent)
              return false
            }

            let loaded = false
            updateThreadState(threadId, (latest) => {
              const currentGap = latest.historyWindowGap
              if (
                !currentGap ||
                currentGap.afterMessageId !== gap.afterMessageId ||
                currentGap.reloadBeforeOrdinal !==
                  (reloadCursor && "beforeOrdinal" in reloadCursor
                    ? reloadCursor.beforeOrdinal
                    : null) ||
                currentGap.reloadBeforeMessageId !==
                  (reloadCursor && "beforeMessageId" in reloadCursor
                    ? reloadCursor.beforeMessageId
                    : null) ||
                currentGap.reloadExactMessageId !==
                  (reloadCursor && "targetMessageId" in reloadCursor
                    ? reloadCursor.targetMessageId
                    : null) ||
                currentGap.reloadAnchorMessageId !==
                  (reloadCursor && "anchorMessageId" in reloadCursor
                    ? reloadCursor.anchorMessageId
                    : null)
              ) {
                return { historyPageLoading: false }
              }
              const windowResult = advanceThreadMessageWindowAcrossGap(
                latest.messages,
                reloadedMessages,
                {
                  gap: currentGap,
                  maximumResidentMessages: THREAD_MESSAGE_RESIDENT_LIMIT,
                  protectedTailMessages: THREAD_MESSAGE_PROTECTED_TAIL
                }
              )
              let pageWindows = latest.historyPageWindows
              if (isForwardReload && reloadCursor) {
                const currentPageWindow = createThreadMessagePageWindow(
                  reloadedMessages,
                  reloadCursor
                )
                const pageTail = reloadedMessages.at(-1)
                const forwardPageWindow = pageTail
                  ? createForwardThreadMessagePageWindow(pageTail.id)
                  : null
                pageWindows = [
                  currentPageWindow,
                  ...(windowResult.gap && forwardPageWindow ? [forwardPageWindow] : []),
                  ...latest.historyPageWindows.filter((window) => window.reloadCursor === null)
                ]
              }
              loaded = isForwardReload
                ? reloadedMessages.length > 0
                : windowResult.messages.some((message) => message.id === gap.reloadTargetMessageId)
              return {
                messages: windowResult.messages,
                toolCallStates: retainResidentToolCallStates(
                  upsertToolCallStatesFromMessages(latest.toolCallStates, reloadedMessages),
                  windowResult.messages
                ),
                historyPageLoading: false,
                historyHasMore: isForwardReload ? latest.historyHasMore : page.hasMore,
                historyPageCursor: isForwardReload
                  ? latest.historyPageCursor
                  : page.hasMore && page.beforeOrdinal !== null && page.beforeMessageId !== null
                    ? {
                        beforeOrdinal: page.beforeOrdinal,
                        beforeMessageId: page.beforeMessageId
                      }
                    : null,
                historyPageWindows: pageWindows,
                historyWindowGap: attachThreadMessageGapReload(windowResult.gap, pageWindows),
                historyMessageTotal: page.total
              }
            })
            messageWindowIntentCoordinator.finish(intent)
            return loaded
          } catch (error) {
            if (!isCurrentLoad()) return false
            console.warn("[ThreadContext] Failed to reload released message window:", error)
            updateThreadState(threadId, () => ({ historyPageLoading: false }))
            messageWindowIntentCoordinator.finish(intent)
            return false
          }
        },
        restoreLatestMessageWindow: async () => {
          const state = threadStatesRef.current[threadId]
          if (!state) return false
          const loadGeneration = threadHistoryLoadGenerationRef.current[threadId] ?? 0
          cancelThreadHistoryHydrationRetry(threadId)
          const intent = messageWindowIntentCoordinator.begin(threadId, "latest")
          const isCurrentLoad = (): boolean =>
            initializedThreadsRef.current.has(threadId) &&
            threadHistoryLoadGenerationRef.current[threadId] === loadGeneration &&
            messageWindowIntentCoordinator.isCurrent(intent)
          updateThreadState(threadId, () => ({ historyPageLoading: true }))
          try {
            const page = await window.api.threads.getMessagesPage(threadId, {
              limit: TARGETED_THREAD_MESSAGE_PAGE_LIMIT
            })
            if (!isCurrentLoad()) return false
            const latestMessages = normalizePersistedThreadMessages(page.messages).filter(
              isVisibleCheckpointTranscriptMessage
            )
            rememberDurableMessageIds(threadId, latestMessages)
            latestDurableMessagePageIdentitiesRef.current[threadId] = threadMessagePageIdentitySet(
              page.messages
            )
            updateThreadState(threadId, (latest) => {
              const windowResult = restoreLatestThreadMessageWindow(
                latest.messages,
                latestMessages,
                {
                  maximumResidentMessages: THREAD_MESSAGE_RESIDENT_LIMIT,
                  protectedLocalTailMessages: THREAD_MESSAGE_PROTECTED_TAIL,
                  existingGap: latest.historyWindowGap
                }
              )
              const pageWindows = [createThreadMessagePageWindow(latestMessages, null)]
              return {
                messages: windowResult.messages,
                toolCallStates: retainResidentToolCallStates(
                  upsertToolCallStatesFromMessages(latest.toolCallStates, latestMessages),
                  windowResult.messages
                ),
                historyPageLoading: false,
                historyHasMore: page.hasMore,
                historyPageCursor:
                  page.hasMore && page.beforeOrdinal !== null && page.beforeMessageId !== null
                    ? {
                        beforeOrdinal: page.beforeOrdinal,
                        beforeMessageId: page.beforeMessageId
                      }
                    : null,
                historyPageWindows: pageWindows,
                historyWindowGap: null,
                historyMessageTotal: page.total,
                historyLoadedMessageCount: page.messages.length
              }
            })
            messageWindowIntentCoordinator.finish(intent)
            return true
          } catch (error) {
            if (!isCurrentLoad()) return false
            console.warn("[ThreadContext] Failed to restore latest message window:", error)
            updateThreadState(threadId, () => ({ historyPageLoading: false }))
            messageWindowIntentCoordinator.finish(intent)
            return false
          }
        },
        cancelMessageWindowLoad: () => {
          const activeKind = messageWindowIntentCoordinator.activeKind(threadId)
          if (
            !canCancelThreadMessageWindowIntent(
              activeKind,
              firstTranscriptPublishedThreadIdsRef.current.has(threadId)
            )
          )
            return
          if (!messageWindowIntentCoordinator.cancel(threadId)) return
          updateThreadState(threadId, () => ({ historyPageLoading: false }))
        },
        addQueuedMessage: (message: QueuedMessage) => {
          updateThreadState(threadId, (state) => {
            const next = [...state.queuedMessages, message]
            persistQueuedMessages(threadId, next)
            return { queuedMessages: next }
          })
        },
        prependQueuedMessage: (message: QueuedMessage) => {
          updateThreadState(threadId, (state) => {
            const next = [
              message,
              ...state.queuedMessages.filter((queued) => queued.id !== message.id)
            ]
            persistQueuedMessages(threadId, next)
            return { queuedMessages: next }
          })
        },
        getQueuedMessage: (messageId: string) => {
          return threadStatesRef.current[threadId]?.queuedMessages.find(
            (message) => message.id === messageId
          )
        },
        updateQueuedMessage: (messageId: string, updates: Partial<QueuedMessage>) => {
          updateThreadState(threadId, (state) => {
            const next = state.queuedMessages.map((message) =>
              message.id === messageId
                ? { ...message, ...updates, id: message.id, updated_at: new Date() }
                : message
            )
            persistQueuedMessages(threadId, next)
            return { queuedMessages: next }
          })
        },
        deleteQueuedMessage: (messageId: string) => {
          updateThreadState(threadId, (state) => {
            const next = state.queuedMessages.filter((message) => message.id !== messageId)
            persistQueuedMessages(threadId, next)
            return { queuedMessages: next }
          })
        },
        reorderQueuedMessages: (orderedIds: string[]) => {
          updateThreadState(threadId, (state) => {
            const byId = new Map(state.queuedMessages.map((message) => [message.id, message]))
            const ordered = orderedIds
              .map((id) => byId.get(id))
              .filter((message): message is QueuedMessage => Boolean(message))
            const missing = state.queuedMessages.filter(
              (message) => !orderedIds.includes(message.id)
            )
            const next = [...ordered, ...missing]
            persistQueuedMessages(threadId, next)
            return { queuedMessages: next }
          })
        },
        promoteQueuedMessage: (messageId: string) => {
          updateThreadState(threadId, (state) => {
            const target = state.queuedMessages.find((message) => message.id === messageId)
            if (!target) return {}
            const next = [
              target,
              ...state.queuedMessages.filter((message) => message.id !== messageId)
            ]
            persistQueuedMessages(threadId, next)
            return { queuedMessages: next }
          })
        },
        setQueueAutoDrainSuppressed: (suppressed: boolean) => {
          updateThreadState(threadId, () => ({ queueAutoDrainSuppressed: suppressed }))
        },
        setGoalUi: (goalUi: GoalUiState) => {
          updateThreadState(threadId, () => ({ goalUi }))
        },
        refreshGoalUi: (options = {}) => refreshGoalUi(threadId, options),
        setActiveTurnStartTime: (startTime: number | null) => {
          updateThreadState(threadId, () => ({ activeTurnStartTime: startTime }))
        },
        setTodos: (todos: Todo[]) => {
          updateThreadState(threadId, () => ({ todos }))
        },
        setWorkspaceFiles: (files: FileInfo[] | ((prev: FileInfo[]) => FileInfo[])) => {
          updateThreadState(threadId, (state) => {
            const nextFiles = typeof files === "function" ? files(state.workspaceFiles) : files
            return state.workspaceFiles === nextFiles ? {} : { workspaceFiles: nextFiles }
          })
        },
        setWorkspacePath: (path: string | null) => {
          updateThreadState(threadId, (state) => {
            if (state.workspacePath === path) return { workspacePath: path }
            return {
              workspacePath: path,
              workspaceFiles: retainWorkspaceFilesForPathChange(
                state.workspaceFiles,
                state.workspacePath,
                path
              ),
              coordinatorWorkers: []
            }
          })
        },
        setGitContext: (context: ThreadGitContext | null) => {
          updateThreadState(threadId, () => ({ gitContext: context }))
        },
        clearFinishedWorkflowRun: () => {
          updateThreadState(threadId, (prev) =>
            prev.workflowRun && prev.workflowRun.status !== "running" ? { workflowRun: null } : {}
          )
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
          updateThreadState(threadId, () => ({ error: null, errorDetail: null }))
        },
        clearHookInterruption: () => {
          updateThreadState(threadId, () => ({ hookInterruption: null }))
        },
        restoreCurrentModel: (modelId: string) => {
          updateThreadState(threadId, () => ({ currentModel: modelId }))
        },
        setCurrentModel: (modelId: string) => {
          updateThreadState(threadId, () => ({ currentModel: modelId }))
          if (isThreadDeletionPending(threadId)) return
          // Only intentional model selection changes should touch metadata.model.
          // Hydration and no-op writes must not refresh updated_at or overwrite routing fallback state.
          const gate = modelSelectionGateRef.current
          const generation = gate.begin(threadId)
          void window.api.threads
            .get(threadId)
            .then(async (thread) => {
              if (
                !gate.isCurrent(threadId, generation) ||
                isThreadDeletionPending(threadId) ||
                !thread
              ) {
                return
              }
              const metadata = thread.metadata || {}
              if (metadata.model === modelId) return
              await useAppStore
                .getState()
                .patchThreadMetadata(threadId, { set: { model: modelId } })
            })
            .catch((error) => {
              if (!gate.isCurrent(threadId, generation)) return
              console.warn("[ThreadContext] Failed to persist selected model:", error)
            })
            .finally(() => {
              gate.finish(threadId, generation)
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
        setContextReminder: (
          update: ContextReminderState | ((prev: ContextReminderState) => ContextReminderState)
        ) => {
          updateThreadState(threadId, (state) => ({
            contextReminder:
              typeof update === "function"
                ? update(state.contextReminder ?? createDefaultContextReminderState())
                : update
          }))
        },
        setDraftInput: (input: string) => {
          updateThreadState(threadId, () => ({ draftInput: input }))
        },
        setHarnessNextActionDialogTips: (tips: string | null) => {
          const normalizedTips = tips?.trim() || null
          updateThreadState(threadId, () => ({ harnessNextActionDialogTips: normalizedTips }))
        },
        setDraftSkill: (skill: SkillMetadata | null) => {
          updateThreadState(threadId, () => ({ draftSkill: skill }))
        },
        setDraftBuiltinBrowser: (selected: boolean) => {
          updateThreadState(threadId, () => ({ draftBuiltinBrowser: selected }))
        }
      }

      actionsCache.current[threadId] = actions
      return actions
    },
    [
      applyDurableTranscriptSnapshot,
      cancelThreadHistoryHydrationRetry,
      messageWindowIntentCoordinator,
      openHookLogBucket,
      rememberDurableMessageIds,
      refreshGoalUi,
      updateThreadState
    ]
  )

  const scheduleThreadHistoryHydrationRetry = useCallback(
    (
      threadId: string,
      loadGeneration: number,
      foregroundToken: ForegroundHydrationToken | null
    ): void => {
      if (threadHistoryHydrationRetryTimersRef.current[threadId] !== undefined) return
      const retryCount = threadHistoryHydrationRetryCountsRef.current[threadId] ?? 0
      const retrySchedule = getThreadHistoryHydrationRetrySchedule(retryCount)
      if (retrySchedule.exhausted || retrySchedule.delayMs === null) {
        // Preserve the terminal count so another automatic caller cannot restart
        // the loop. Presence remains unknown/fail-closed; with no timer, an
        // inactive task is once again eligible for dehydration.
        threadHistoryHydrationRetryCountsRef.current[threadId] = retrySchedule.nextRetryCount
        setDehydrationEligibilityRevision((revision) => revision + 1)
        return
      }
      threadHistoryHydrationRetryCountsRef.current[threadId] = retrySchedule.nextRetryCount
      const runWhenWindowIsSafe = (): void => {
        if (
          !threadProviderMountedRef.current ||
          !initializedThreadsRef.current.has(threadId) ||
          threadHistoryLoadGenerationRef.current[threadId] !== loadGeneration ||
          (foregroundToken !== null &&
            (useAppStore.getState().currentThreadId !== threadId ||
              !foregroundHydrationGeneration.isCurrent(foregroundToken)))
        ) {
          delete threadHistoryHydrationRetryTimersRef.current[threadId]
          return
        }
        const state = threadStatesRef.current[threadId]
        const pageWindows = state?.historyPageWindows ?? []
        const hasHistoricalWindow =
          state?.historyWindowGap != null ||
          pageWindows.length > 1 ||
          pageWindows.some((window) => window.reloadCursor !== null)
        const disposition = getThreadHistoryHydrationRetryDisposition(
          messageWindowIntentCoordinator.activeKind(threadId),
          hasHistoricalWindow
        )
        if (disposition === "wait") {
          threadHistoryHydrationRetryTimersRef.current[threadId] = window.setTimeout(
            runWhenWindowIsSafe,
            250
          )
          return
        }
        delete threadHistoryHydrationRetryTimersRef.current[threadId]
        if (disposition === "cancel") return
        loadThreadHistoryRef.current(threadId)
      }
      threadHistoryHydrationRetryTimersRef.current[threadId] = window.setTimeout(
        runWhenWindowIsSafe,
        retrySchedule.delayMs
      )
    },
    [
      foregroundHydrationGeneration,
      messageWindowIntentCoordinator,
      setDehydrationEligibilityRevision
    ]
  )

  const loadThreadHistory = useCallback(
    async (threadId: string) => {
      if (isThreadDeletionPending(threadId)) return
      const hadPublishedTranscript = firstTranscriptPublishedThreadIdsRef.current.has(threadId)
      const transcriptHydrationIntent = messageWindowIntentCoordinator.begin(threadId, "hydrate")
      if (!hadPublishedTranscript) {
        firstTranscriptPublishedThreadIdsRef.current.delete(threadId)
      }
      const loadGeneration = (threadHistoryLoadGenerationRef.current[threadId] ?? 0) + 1
      threadHistoryLoadGenerationRef.current[threadId] = loadGeneration
      foregroundHydrationGeneration.transition(useAppStore.getState().currentThreadId)
      const foregroundToken = foregroundHydrationGeneration.capture(threadId)
      threadHistoryHydrationAttemptsRef.current[threadId] = {
        loadGeneration,
        foregroundToken
      }
      const isCurrentLoad = (): boolean =>
        threadProviderMountedRef.current &&
        !isThreadRetired(threadId) &&
        initializedThreadsRef.current.has(threadId) &&
        threadHistoryLoadGenerationRef.current[threadId] === loadGeneration &&
        (foregroundToken === null ||
          (useAppStore.getState().currentThreadId === threadId &&
            foregroundHydrationGeneration.isCurrent(foregroundToken)))
      const isCurrentTranscriptHydration = (): boolean =>
        isCurrentLoad() && messageWindowIntentCoordinator.isCurrent(transcriptHydrationIntent)
      const actions = getThreadActions(threadId)
      let persistedMessageTimes: MessageTimeMap = {}
      let persistedInternalGoalMessageTimes: MessageTimeMap = {}
      let persistedInternalGoalMessageTimeOrder: MessageTimeEntry[] = []
      let persistedMessageTimeOrder: MessageTimeEntry[] = []
      let persistedSubagentTranscripts: Record<string, Message[]> = {}
      let subagentTranscriptHydrationSucceeded = false
      let rawRestoredMessages: Message[] = []
      let restoredMessages: Message[] = []
      let restoredGoalEvents: GoalNoticeEvent[] = []
      let skipCheckpointPendingApproval = false
      let latestTrustedCheckpointMessageAt: Date | undefined
      let persistedThreadMessages: Message[] = []
      let visiblePersistedThreadMessages: Message[] = []
      let durableMessageTotal = 0
      let durableMessageHasMore = false
      let durableMessagePageCursor: ThreadMessagePageCursor | null = null
      let durableConversationPresence: ThreadConversationPresence = "unknown"
      let hasPersistedVisibleTailAfterCheckpoint = false
      let checkpointMessagesLoaded = false
      let checkpointPresenceFallbackResolved = false
      let mainTranscriptPublished = false
      let criticalHistoryHydrationFailed = false
      const existingTranscriptRetryTimer =
        subagentTranscriptHydrationRetryTimersRef.current[threadId]
      if (existingTranscriptRetryTimer !== undefined) {
        window.clearTimeout(existingTranscriptRetryTimer)
        delete subagentTranscriptHydrationRetryTimersRef.current[threadId]
      }
      const existingHistoryRetryTimer = threadHistoryHydrationRetryTimersRef.current[threadId]
      if (existingHistoryRetryTimer !== undefined) {
        window.clearTimeout(existingHistoryRetryTimer)
        delete threadHistoryHydrationRetryTimersRef.current[threadId]
      }
      updateThreadState(threadId, () => ({
        historyLoading: !hadPublishedTranscript,
        historyPageLoading: true,
        historyConversationPresence: "unknown",
        subagentTranscriptBaselineReady: false
      }))

      // Start the latency-critical durable page immediately. Thread metadata,
      // goal events and potentially large subagent hydration are independent
      // and should not delay the bounded main transcript window.
      const initialPageOptions = {
        limit: INITIAL_THREAD_MESSAGES_PAGE_LIMIT,
        byteBudget: INITIAL_THREAD_MESSAGES_PAGE_BYTE_BUDGET,
        includeVisibleMessagePresence: true,
        ...(foregroundToken ? { requestScope: "foreground-hydration" as const } : {})
      }
      const durableMessagePageLoad = window.api.threads
        .getMessagesPage(threadId, initialPageOptions)
        .then((page) => ({ succeeded: true as const, page }))
        .catch((error) => ({ succeeded: false as const, error }))

      // The bounded durable page is the only dependency of the first chat
      // paint. Consume and publish it before metadata, goals, checkpoint
      // runtime state or subagent restoration can enter the apply/parse path.
      const messagePageResult = await durableMessagePageLoad
      if (!isCurrentLoad()) return
      const shouldBootstrapLegacyTranscript =
        messagePageResult.succeeded &&
        shouldBootstrapLegacyCheckpointTranscript(messagePageResult.page)
      const shouldAwaitCheckpointPresence =
        messagePageResult.succeeded &&
        shouldAwaitCheckpointConversationPresence(messagePageResult.page)
      const keepMainTranscriptLoading = shouldKeepMainTranscriptLoadingAfterPage(
        messagePageResult.succeeded
          ? { succeeded: true, page: messagePageResult.page }
          : { succeeded: false }
      )
      if (messagePageResult.succeeded) {
        const messagePage = messagePageResult.page
        rememberDurableMessageIds(threadId, messagePage.messages)
        latestDurableMessagePageIdentitiesRef.current[threadId] = threadMessagePageIdentitySet(
          messagePage.messages
        )
        durableMessageTotal = messagePage.total
        durableConversationPresence = resolveConversationPresenceFromPage(messagePage, {
          legacyFallbackPending: shouldAwaitCheckpointPresence
        })
        durableMessageHasMore = messagePage.hasMore
        durableMessagePageCursor =
          messagePage.hasMore &&
          messagePage.beforeOrdinal !== null &&
          messagePage.beforeMessageId !== null
            ? {
                beforeOrdinal: messagePage.beforeOrdinal,
                beforeMessageId: messagePage.beforeMessageId
              }
            : null
        persistedThreadMessages = normalizePersistedThreadMessages(messagePage.messages)
        visiblePersistedThreadMessages = persistedThreadMessages.filter(
          isVisibleCheckpointTranscriptMessage
        )
        mainTranscriptPublished = !keepMainTranscriptLoading
        if (isCurrentTranscriptHydration()) {
          if (mainTranscriptPublished) {
            actions.setMessages(visiblePersistedThreadMessages)
            firstTranscriptPublishedThreadIdsRef.current.add(threadId)
          }
          updateThreadState(threadId, () => ({
            historyLoading: keepMainTranscriptLoading,
            historyPageLoading: false,
            historyHasMore: durableMessageHasMore,
            historyPageCursor: durableMessagePageCursor,
            historyPageWindows:
              visiblePersistedThreadMessages.length > 0
                ? [createThreadMessagePageWindow(visiblePersistedThreadMessages, null)]
                : [],
            historyWindowGap: null,
            historyMessageTotal: durableMessageTotal,
            historyConversationPresence: durableConversationPresence,
            historyLoadedMessageCount: messagePage.messages.length
          }))
        }
      } else {
        criticalHistoryHydrationFailed = true
        console.error(
          "[ThreadContext] Failed to load persisted thread messages:",
          messagePageResult.error
        )
        mainTranscriptPublished = false
        if (isCurrentTranscriptHydration()) {
          updateThreadState(threadId, () => ({
            historyLoading: keepMainTranscriptLoading,
            historyPageLoading: false,
            historyConversationPresence: "unknown"
          }))
        }
      }
      if (!isCurrentLoad()) return

      // Dispatch all ancillary restoration only after the first-page mutation
      // edge. Besides prioritizing the page IPC, this keeps a stale A/B load
      // from even starting expensive follow-up work after an A -> B -> C switch.
      const goalEventsLoad = window.api.threads
        .getGoalEvents(threadId, { restore: true })
        .then((events) => ({ succeeded: true as const, events }))
        .catch((error) => ({ succeeded: false as const, error }))
      const subagentTranscriptLoad = window.api.threads
        .getSubagentTranscripts(
          threadId,
          foregroundToken ? { requestScope: "foreground-hydration" } : undefined
        )
        .then((rawTranscripts) => ({ succeeded: true as const, rawTranscripts }))
        .catch((error) => ({ succeeded: false as const, error, rawTranscripts: {} }))
      const checkpointRuntimeLoad = (async () => {
        try {
          if (shouldBootstrapLegacyTranscript) {
            const bootstrap = await window.api.threads.bootstrapLegacyCheckpointTranscript(threadId)
            if (!bootstrap) {
              throw new Error("Legacy checkpoint transcript bootstrap was cancelled")
            }
            return {
              succeeded: true as const,
              checkpoint: bootstrap.checkpoint ?? null,
              legacyMessagePage: bootstrap.page
            }
          }
          const checkpoint = await window.api.threads.getLatestCheckpointRuntimeState(threadId)
          return { succeeded: true as const, checkpoint, legacyMessagePage: null }
        } catch (error) {
          return { succeeded: false as const, error, legacyMessagePage: null }
        }
      })()
      const routingModeLoad = window.api.routing.getMode().catch((error) => {
        console.warn(
          `[ThreadContext] Failed to load routing mode for thread ${threadId}; using pinned:`,
          error
        )
        return "pinned" as const
      })
      const threadDetailsLoad = Promise.all([
        window.api.threads.get(
          threadId,
          foregroundToken ? { requestScope: "foreground-hydration" } : undefined
        ),
        routingModeLoad
      ])
        .then(([thread, routingMode]) => ({ succeeded: true as const, thread, routingMode }))
        .catch((error) => ({ succeeded: false as const, error }))

      // Load workspace path and thread metadata
      try {
        const threadDetailsResult = await threadDetailsLoad
        if (!threadDetailsResult.succeeded) throw threadDetailsResult.error
        const { thread, routingMode } = threadDetailsResult
        if (!isCurrentLoad()) return
        if (thread) {
          persistedMessageTimes = getMessageTimeMap(thread.thread_values)
          persistedInternalGoalMessageTimes = getInternalGoalMessageTimeMap(thread.thread_values)
          persistedInternalGoalMessageTimeOrder = getInternalGoalMessageTimeOrder(
            thread.thread_values
          )
          persistedMessageTimeOrder = getMessageTimeOrder(thread.thread_values)
          const metadata = thread.metadata || {}
          actions.setGitContext(getGitContextFromMetadata(metadata))
          if (metadata.workspacePath) {
            const workspacePath = metadata.workspacePath as string
            actions.setWorkspacePath(workspacePath)
          }
          // Pinned mode restores the user's explicit selection; auto mode restores the
          // model that routing actually used for the previous turn.
          const hydratedModel = resolveHydratedThreadModel(metadata, routingMode)
          if (hydratedModel.modelId) {
            updateThreadState(threadId, () => ({
              currentModel: hydratedModel.modelId,
              routingResult: hydratedModel.routingResult
                ? {
                    resolvedModelId: hydratedModel.routingResult.resolvedModelId,
                    resolvedTier: hydratedModel.routingResult.resolvedTier,
                    routeReason: "restored from thread state"
                  }
                : null
            }))
          }
          // 双向水合:isRunning 是权威电平,false 也要落地——否则上次视图残留的
          // 冻结 loading(丢 done)在重新打开时永远无人清除。刚起跑的竞争由
          // started 边沿事件补齐,两者收敛。
          if (metadata.scheduledTaskId) {
            const taskId = metadata.scheduledTaskId as string
            updateThreadState(threadId, () => ({ scheduledTaskId: taskId }))
            window.api.scheduledTasks
              .isRunning(taskId)
              .then((running) => {
                if (!isCurrentLoad()) return
                updateThreadState(threadId, (prev) =>
                  prev.scheduledTaskLoading === running ? {} : { scheduledTaskLoading: running }
                )
              })
              .catch(() => {})
          }
          if (metadata.isHeartbeat) {
            window.api.heartbeat
              .isRunning()
              .then((running) => {
                if (!isCurrentLoad()) return
                updateThreadState(threadId, (prev) =>
                  prev.scheduledTaskLoading === running ? {} : { scheduledTaskLoading: running }
                )
              })
              .catch(() => {})
          }

          // Restore (or share the foreground restore) before probing the
          // in-memory notification queue. The probe itself intentionally never
          // scans the persisted worker directory, which keeps obsolete task
          // hydration cancellable.
          const subscribeCoordinatorUpdates = useAppStore.getState().currentThreadId === threadId
          requestCoordinatorWorkers(threadId, subscribeCoordinatorUpdates)
            .then((workers) => {
              if (!isCurrentLoad()) return false
              updateThreadState(threadId, (prev) => {
                const merged = mergeCoordinatorWorkers(prev.coordinatorWorkers, workers, {
                  authoritative: true
                })
                return coordinatorWorkersEqual(prev.coordinatorWorkers, merged)
                  ? {}
                  : { coordinatorWorkers: merged }
              })
              return window.api.agent.hasCoordinatorWorkerNotifications(threadId)
            })
            .then((hasPending) => {
              if (!hasPending || !isCurrentLoad()) return
              scheduleCoordinatorNotificationTurn(threadId)
            })
            .catch((error) => {
              console.warn("[ThreadContext] Failed to restore coordinator workers:", error)
            })
        }
      } catch (error) {
        if (!isCurrentLoad()) return
        console.error("[ThreadContext] Failed to load thread details:", error)
      }
      if (!isCurrentLoad()) return

      const goalEventsResult = await goalEventsLoad
      if (!isCurrentLoad()) return
      if (goalEventsResult.succeeded) {
        restoredGoalEvents = goalEventsResult.events
      } else {
        criticalHistoryHydrationFailed = true
        console.error("[ThreadContext] Failed to load goal events:", goalEventsResult.error)
      }

      // Load runtime state from checkpoints. Transcript restore falls back here
      // whenever durable rows cannot yet prove that the visible conversation
      // was migrated, including interrupted and internal-only legacy histories.
      try {
        const checkpointRuntimeResult = await checkpointRuntimeLoad
        if (!checkpointRuntimeResult.succeeded) throw checkpointRuntimeResult.error
        if (!isCurrentLoad()) return
        checkpointPresenceFallbackResolved = shouldAwaitCheckpointPresence
        const legacyMessagePage = checkpointRuntimeResult.legacyMessagePage
        if (legacyMessagePage && messagePageResult.succeeded && shouldBootstrapLegacyTranscript) {
          rememberDurableMessageIds(threadId, legacyMessagePage.messages)
          latestDurableMessagePageIdentitiesRef.current[threadId] = threadMessagePageIdentitySet(
            legacyMessagePage.messages
          )
          durableMessageTotal = legacyMessagePage.total
          durableConversationPresence = resolveConversationPresenceFromPage(legacyMessagePage, {
            legacyFallbackPending: false
          })
          durableMessageHasMore = legacyMessagePage.hasMore
          durableMessagePageCursor =
            legacyMessagePage.hasMore &&
            legacyMessagePage.beforeOrdinal !== null &&
            legacyMessagePage.beforeMessageId !== null
              ? {
                  beforeOrdinal: legacyMessagePage.beforeOrdinal,
                  beforeMessageId: legacyMessagePage.beforeMessageId
                }
              : null
          persistedThreadMessages = normalizePersistedThreadMessages(legacyMessagePage.messages)
          visiblePersistedThreadMessages = persistedThreadMessages.filter(
            isVisibleCheckpointTranscriptMessage
          )
          if (isCurrentTranscriptHydration()) {
            actions.setMessages(visiblePersistedThreadMessages)
            firstTranscriptPublishedThreadIdsRef.current.add(threadId)
            mainTranscriptPublished = true
            updateThreadState(threadId, () => ({
              historyLoading: false,
              historyPageLoading: false,
              historyHasMore: durableMessageHasMore,
              historyPageCursor: durableMessagePageCursor,
              historyPageWindows:
                visiblePersistedThreadMessages.length > 0
                  ? [createThreadMessagePageWindow(visiblePersistedThreadMessages, null)]
                  : [],
              historyWindowGap: null,
              historyMessageTotal: durableMessageTotal,
              historyConversationPresence: durableConversationPresence,
              historyLoadedMessageCount: legacyMessagePage.messages.length
            }))
          }
        }
        const latestCheckpoint = checkpointRuntimeResult.checkpoint as {
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
        } | null
        if (!isCurrentLoad()) return
        if (latestCheckpoint) {
          const channelValues = latestCheckpoint.checkpoint?.channel_values

          if (
            isCurrentTranscriptHydration() &&
            channelValues?.messages &&
            Array.isArray(channelValues.messages)
          ) {
            checkpointMessagesLoaded = true
            let internalGoalPromptIndex = 0
            const checkpointRawRestoredMessages = channelValues.messages.flatMap(
              (msg, index): Message | [] => {
                if (isSerializedSummarizationMessage(msg)) {
                  return []
                }
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

                const visibleUserMessage = additionalKwargs?.cmb_visible_user_message
                const checkpointContent = msg.content ?? msg.kwargs?.content
                const isRawInternalGoalPrompt =
                  role === "user" &&
                  typeof checkpointContent === "string" &&
                  isInternalGoalPromptMessage({ role, content: checkpointContent })
                const isVisibleGoalCommand =
                  typeof visibleUserMessage === "string" &&
                  /^\/goal(?:\s|$)/i.test(visibleUserMessage.trimStart())
                const shouldUseVisibleGoalResumeAlias =
                  isRawInternalGoalPrompt &&
                  typeof visibleUserMessage === "string" &&
                  isGoalResumeCommandContent(visibleUserMessage) &&
                  !hasGoalResumeUserEvent(
                    restoredGoalEvents,
                    getInternalGoalPromptIdentity(checkpointContent)
                  )
                const shouldKeepRawInternalGoalPrompt =
                  isRawInternalGoalPrompt &&
                  (visibleUserMessage === undefined ||
                    visibleUserMessage === "" ||
                    (isVisibleGoalCommand && !shouldUseVisibleGoalResumeAlias))
                const rawContent =
                  role === "user" &&
                  !shouldKeepRawInternalGoalPrompt &&
                  typeof visibleUserMessage === "string" &&
                  visibleUserMessage.length > 0
                    ? visibleUserMessage
                    : checkpointContent
                let content: Message["content"] = ""
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
                const usesInternalGoalPromptTiming = isRawInternalGoalPrompt
                const currentInternalGoalPromptIndex = usesInternalGoalPromptTiming
                  ? internalGoalPromptIndex++
                  : -1
                const { startAt, endAt } = restoreRawCheckpointMessageTime({
                  messageId,
                  fallbackTime,
                  isInternalGoalPrompt: usesInternalGoalPromptTiming,
                  internalGoalPromptIndex: currentInternalGoalPromptIndex,
                  persistedMessageTimes,
                  persistedInternalGoalMessageTimes,
                  persistedInternalGoalMessageTimeOrder
                })

                let reasoning = ""
                if (role === "assistant") {
                  const rawReasoning =
                    additionalKwargs?.reasoning ??
                    additionalKwargs?.reasoning_content ??
                    additionalKwargs?.reasoning_text
                  if (typeof rawReasoning === "string" && rawReasoning.trim()) {
                    reasoning = rawReasoning
                  }
                }
                const providerTuple =
                  role === "assistant"
                    ? getMessageProviderTupleFromMetadata(additionalKwargs)
                    : undefined

                return {
                  id: messageId,
                  role,
                  content,
                  ...providerTuple,
                  ...(reasoning && { reasoning }),
                  tool_calls: toolCalls as Message["tool_calls"],
                  ...(role === "tool" && toolCallId && { tool_call_id: toolCallId }),
                  ...(role === "tool" && toolName && { name: toolName }),
                  created_at: startAt,
                  start_at: startAt,
                  end_at: endAt
                }
              }
            )

            const normalizedCheckpointRestoredMessages = mergeCheckpointAuthorityTranscriptMessages(
              checkpointRawRestoredMessages,
              []
            )
            const visibleRestoredMessages = normalizedCheckpointRestoredMessages.filter(
              isVisibleCheckpointTranscriptMessage
            )
            const checkpointLatestTrustedMessageAt = getLatestTrustedCheckpointMessageAt(
              visibleRestoredMessages,
              persistedMessageTimes,
              persistedMessageTimeOrder,
              persistedInternalGoalMessageTimes,
              persistedInternalGoalMessageTimeOrder,
              normalizedCheckpointRestoredMessages
            )
            const persistedCheckpointLatestMessageAt = latestPersistedCheckpointMessageAt(
              visibleRestoredMessages,
              persistedThreadMessages
            )
            const persistedVisibleLatestMessageAt = latestPersistedVisibleMessageAt(
              visiblePersistedThreadMessages
            )
            hasPersistedVisibleTailAfterCheckpoint =
              findMessagesAfterCheckpointVisibleIds(
                visiblePersistedThreadMessages,
                visibleRestoredMessages
              ).length > 0
            rawRestoredMessages = normalizedCheckpointRestoredMessages
            latestTrustedCheckpointMessageAt = latestDate([
              checkpointLatestTrustedMessageAt,
              persistedCheckpointLatestMessageAt,
              persistedVisibleLatestMessageAt
            ])
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
          skipCheckpointPendingApproval =
            hasPersistedVisibleTailAfterCheckpoint ||
            shouldSuppressCheckpointApprovalRestore(
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
        if (!isCurrentLoad()) return
        criticalHistoryHydrationFailed = true
        console.error("[ThreadContext] Failed to load thread history:", error)
      }
      if (!isCurrentLoad()) return
      if (criticalHistoryHydrationFailed) {
        // Keep one bounded retry chain for the main page, goal sidecar and
        // checkpoint fallback. Resetting the counter after only the DB page
        // succeeds would otherwise turn a persistent checkpoint/sidecar error
        // into an unbounded 500 ms reload loop.
        scheduleThreadHistoryHydrationRetry(threadId, loadGeneration, foregroundToken)
      } else {
        delete threadHistoryHydrationRetryCountsRef.current[threadId]
      }

      const restoredGoalUiEvents = goalNoticeEventsToGoalUiEvents(threadId, restoredGoalEvents)
      if (checkpointMessagesLoaded) {
        const persistedMessagesByIdentity = new Map(
          persistedThreadMessages.map((message) => [
            getMessageProviderOccurrenceIdentity(message),
            message
          ])
        )
        const transcriptRepairs = rawRestoredMessages.flatMap((message): Message | [] => {
          const persistedMessage = persistedMessagesByIdentity.get(
            getMessageProviderOccurrenceIdentity(message)
          )
          const hasPersistedContent =
            typeof persistedMessage?.content === "string"
              ? persistedMessage.content.length > 0
              : Array.isArray(persistedMessage?.content) && persistedMessage.content.length > 0
          const checkpointClearsToolCalls =
            message.role === "assistant" &&
            Array.isArray(message.tool_calls) &&
            message.tool_calls.length === 0 &&
            Array.isArray(persistedMessage?.tool_calls) &&
            persistedMessage.tool_calls.length > 0
          if (
            !(isCheckpointEmptyAssistantToolCallMessage(message) && hasPersistedContent) &&
            !checkpointClearsToolCalls
          ) {
            return []
          }
          return { ...message, content_priority: 1 }
        })
        if (transcriptRepairs.length > 0) {
          try {
            await window.api.threads.appendMessages(threadId, transcriptRepairs)
          } catch (error) {
            if (!isCurrentLoad()) return
            console.warn("[ThreadContext] Failed to repair checkpoint transcript:", error)
          }
          if (!isCurrentLoad()) return
        }
      }
      const checkpointTranscript = buildRestoredCheckpointTranscript(
        checkpointMessagesLoaded ? rawRestoredMessages : persistedThreadMessages,
        checkpointMessagesLoaded ? restoredMessages : visiblePersistedThreadMessages,
        restoredGoalUiEvents
      )
      const restoredTranscript = mergePersistedMessagesIntoTranscript(
        checkpointTranscript,
        visiblePersistedThreadMessages
      )
      const restoredTranscriptMessages = restoreVisibleCheckpointMessageTimes(
        restoredTranscript,
        persistedMessageTimes,
        persistedMessageTimeOrder,
        visiblePersistedThreadMessages
      )
      if (!isCurrentLoad()) return
      // The durable page may already be visible. Preserve any live/scheduler
      // rows committed after that early paint while enriching it with goal and
      // legacy-checkpoint restoration.
      const hydratedTranscriptMessages = mergePersistedMessagesIntoTranscript(
        restoredTranscriptMessages,
        threadStatesRef.current[threadId]?.messages ?? []
      )
      if (isCurrentTranscriptHydration()) {
        actions.setMessages(hydratedTranscriptMessages)
        firstTranscriptPublishedThreadIdsRef.current.add(threadId)
        const hydratedConversationPresence: ThreadConversationPresence =
          hydratedTranscriptMessages.length > 0
            ? "nonempty"
            : checkpointPresenceFallbackResolved
              ? "empty"
              : durableConversationPresence
        if (!mainTranscriptPublished) {
          mainTranscriptPublished = true
          updateThreadState(threadId, () => ({
            historyLoading: false,
            historyPageLoading: false,
            historyConversationPresence: hydratedConversationPresence
          }))
        } else {
          updateThreadState(threadId, (state) =>
            state.historyConversationPresence === hydratedConversationPresence
              ? {}
              : { historyConversationPresence: hydratedConversationPresence }
          )
        }
      }
      messageWindowIntentCoordinator.finish(transcriptHydrationIntent)
      // A renderer can reload after main has injected a steered draft but before
      // it receives the IPC acknowledgement. The checkpoint is then the durable
      // source of truth: remove any matching local draft so auto-drain cannot
      // submit the same user turn a second time.
      const restoredMessageIds = new Set(restoredTranscriptMessages.map((message) => message.id))
      updateThreadState(threadId, (state) => {
        const nextQueuedMessages = removeQueuedMessagesById(
          state.queuedMessages,
          restoredMessageIds
        )
        if (nextQueuedMessages === state.queuedMessages) return {}
        persistQueuedMessages(threadId, nextQueuedMessages)
        return { queuedMessages: nextQueuedMessages }
      })
      const subagentTranscriptResult = await subagentTranscriptLoad
      if (!isCurrentLoad()) return
      if (subagentTranscriptResult.succeeded) {
        persistedSubagentTranscripts = getSubagentTranscriptsFromThreadValues({
          [SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]: subagentTranscriptResult.rawTranscripts
        })
        subagentTranscriptHydrationSucceeded = true
      } else {
        console.warn(
          "[ThreadContext] Failed to hydrate subagent transcripts:",
          subagentTranscriptResult.error
        )
      }
      if (subagentTranscriptHydrationSucceeded) {
        delete subagentTranscriptHydrationRetryCountsRef.current[threadId]
        if (
          !mergeHydratedSubagentTranscripts(threadId, persistedSubagentTranscripts, loadGeneration)
        ) {
          return
        }
        updateThreadState(threadId, (state) => (state.dehydrated ? { dehydrated: false } : {}))
      }
      try {
        const goalUi = await window.api.threads.getGoalState(threadId, { includeEvents: false })
        if (!isCurrentLoad()) return
        updateThreadState(threadId, (state) => ({
          goalUi: {
            goal: goalUi.goal,
            events: mergeGoalUiEvents(restoredGoalUiEvents, state.goalUi.events),
            lastUpdated: new Date()
          }
        }))
      } catch (error) {
        if (!isCurrentLoad()) return
        console.warn("[ThreadContext] Failed to load goal UI state:", error)
        updateThreadState(threadId, (state) => ({
          goalUi: {
            goal: state.goalUi.goal,
            events: mergeGoalUiEvents(restoredGoalUiEvents, state.goalUi.events),
            lastUpdated: new Date()
          }
        }))
      }
      if (!isCurrentLoad()) return

      seedLiveStreamBaselineFromCheckpoint(
        threadId,
        checkpointMessagesLoaded
          ? mergePersistedMessagesIntoTranscript(
              rawRestoredMessages,
              visiblePersistedThreadMessages
            )
          : restoredTranscript
      )
      if (
        subagentTranscriptHydrationSucceeded &&
        subagentTranscriptDirtyIdsRef.current[threadId]?.size
      ) {
        scheduleSubagentTranscriptsPersist(threadId)
      } else if (!subagentTranscriptHydrationSucceeded) {
        scheduleSubagentTranscriptHydrationRetry(threadId, loadGeneration, foregroundToken)
      }
      if (!isCurrentLoad()) return
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
      foregroundHydrationGeneration,
      getThreadActions,
      handleStreamUpdate,
      messageWindowIntentCoordinator,
      mergeHydratedSubagentTranscripts,
      rememberDurableMessageIds,
      requestCoordinatorWorkers,
      scheduleCoordinatorNotificationTurn,
      scheduleSubagentTranscriptHydrationRetry,
      scheduleSubagentTranscriptsPersist,
      scheduleThreadHistoryHydrationRetry,
      seedLiveStreamBaselineFromCheckpoint,
      updateThreadState
    ]
  )

  loadThreadHistoryRef.current = (threadId: string) => {
    void loadThreadHistory(threadId)
  }

  // Track passive scheduler/heartbeat stream listeners per thread
  const schedulerListenerCleanups = useRef<Record<string, () => void>>({})
  const heartbeatListenerCleanups = useRef<Record<string, () => void>>({})
  // Track durable coordinator-worker hook listeners per thread. These survive
  // past a run so async worker hook records (which fire after the run stream
  // closes) still reach the hook-log buckets.
  const coordinatorWorkerHookListenerCleanups = useRef<Record<string, () => void>>({})
  const workflowEventsListenerCleanups = useRef<Record<string, () => void>>({})
  const workflowNotificationTimersRef = useRef<Record<string, number>>({})
  const workflowNotificationAttemptsRef = useRef<Record<string, number>>({})
  // Set when a workflow notification is deferred because the thread is busy, so
  // the turn-completion effect reschedules it even after the 1s×N retry budget is
  // spent (a long foreground turn would otherwise strand it until the next hydrate).
  const workflowNotificationRetryOnIdleRef = useRef<Record<string, boolean>>({})
  // Track approval listeners per thread (registered globally, not per-component)
  const approvalListenerCleanups = useRef<Record<string, Array<() => void>>>({})
  // Track queued-message-injection listeners per thread.
  const queueListenerCleanups = useRef<Record<string, () => void>>({})
  // Track request_user_input listeners per thread.
  const userInputListenerCleanups = useRef<Record<string, Array<() => void>>>({})
  // Cleanup can race with an already queued callback and an immediate reopen.
  // Object identity keeps that stale callback separate from the new listener
  // generation; `initialized` alone cannot distinguish the two.
  const threadListenerEpochRef = useRef<Record<string, object>>({})

  // Track streaming AI message state per thread (for token-by-token accumulation)
  const schedulerStreamingRef = useRef<
    Record<
      string,
      {
        currentMsgId: string | null
        accumulatedContent: string
        accumulatedReasoning: string
        subagentContentProjection?: SubagentLiveTextProjection
        subagentReasoningProjection?: SubagentLiveTextProjection
        assistantLocation?: TrustedMessageTailLocation
        toolLocation?: TrustedMessageTailLocation
      }
    >
  >({})
  const schedulerTurnMessageLocationRef = useRef<Record<string, TrustedMessageTailLocation>>({})
  const schedulerSubagentStreamKeysRef = useRef<Record<string, Set<string>>>({})
  const clearSchedulerMainStreamingForThread = useCallback((threadId: string) => {
    delete schedulerStreamingRef.current[threadId]
    delete schedulerTurnMessageLocationRef.current[threadId]
  }, [])
  const clearSchedulerStreamingForThread = useCallback(
    (threadId: string) => {
      clearSchedulerMainStreamingForThread(threadId)
      const subagentKeys = schedulerSubagentStreamKeysRef.current[threadId]
      if (subagentKeys) {
        for (const key of subagentKeys) delete schedulerStreamingRef.current[key]
        delete schedulerSubagentStreamKeysRef.current[threadId]
      }
    },
    [clearSchedulerMainStreamingForThread]
  )

  // Process standardised events from scheduler (produced by StreamConverter)
  const processSchedulerEvent = useCallback(
    (threadId: string, event: { type: string; [key: string]: unknown }) => {
      // Lifecycle events
      if (event.type === "done") {
        clearSchedulerStreamingForThread(threadId)
        finalizeRunningSubagentsForStoppedStream(threadId)
        updateThreadState(threadId, () => ({ scheduledTaskLoading: false }))
        loadThreadHistory(threadId)
        return
      }
      if (event.type === "error") {
        clearSchedulerStreamingForThread(threadId)
        finalizeRunningSubagentsForStoppedStream(threadId)
        updateThreadState(threadId, () => ({
          scheduledTaskLoading: false,
          error: (event.error as string) || "Scheduled task failed"
        }))
        // Match the done path: remount from the durable transcript baseline so
        // a later foreground values replay can adopt the scheduler execution
        // identities instead of manufacturing duplicate buckets.
        loadThreadHistory(threadId)
        return
      }

      // "started" fires before agent runtime creation — show loading immediately.
      // Hook-log buckets are now per-turn and not cleared here; the new bucket
      // is opened when the scheduled task's user message lands via appendMessage.
      if (event.type === "started") {
        clearSchedulerStreamingForThread(threadId)
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

        // Projected values snapshot for the current turn only. Unlike the
        // legacy full-messages event, this must never replace durable history.
        case "turn-messages": {
          const previousTurnLocation = schedulerTurnMessageLocationRef.current[threadId]
          clearSchedulerMainStreamingForThread(threadId)
          updateThreadState(threadId, (state) => {
            const normalizedTurnMessages = normalizeSchedulerMessageSnapshot(
              event.messages as Parameters<typeof normalizeSchedulerMessageSnapshot>[0]
            )
            if (
              normalizedTurnMessages.length === 1 &&
              replaceTrustedMessageTailInPlace(
                previousTurnLocation,
                state.messages,
                normalizedTurnMessages[0]
              )
            ) {
              schedulerTurnMessageLocationRef.current[threadId] = previousTurnLocation
              return {
                messagesContentVersion: state.messagesContentVersion + 1,
                toolCallStates: upsertToolCallStatesFromMessages(
                  state.toolCallStates,
                  normalizedTurnMessages
                )
              }
            }
            const snapshot = mergeSchedulerTurnMessageSnapshot(
              state.messages,
              event.messages as Parameters<typeof normalizeSchedulerMessageSnapshot>[0]
            )
            const incomingTail = snapshot.turnMessages.at(-1)
            const mergedTail = snapshot.messages.at(-1)
            if (
              incomingTail &&
              mergedTail &&
              incomingTail.id === mergedTail.id &&
              incomingTail.role === mergedTail.role
            ) {
              schedulerTurnMessageLocationRef.current[threadId] = {
                messages: snapshot.messages,
                index: snapshot.messages.length - 1,
                tail: mergedTail
              }
            }
            return {
              messages: snapshot.messages,
              toolCallStates: upsertToolCallStatesFromMessages(
                state.toolCallStates,
                snapshot.turnMessages
              )
            }
          })
          break
        }

        // Full message list from a values snapshot
        case "full-messages": {
          clearSchedulerStreamingForThread(threadId)
          const messages = normalizeSchedulerMessageSnapshot(
            event.messages as Parameters<typeof normalizeSchedulerMessageSnapshot>[0]
          )
          const nextToolCallStates = upsertToolCallStatesFromMessages({}, messages)
          updateThreadState(threadId, () => ({
            messages,
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
          const reasoning = typeof event.reasoning === "string" ? event.reasoning : ""
          const toolCalls = event.toolCalls as Message["tool_calls"] | undefined
          const subagentId =
            typeof event.subagentId === "string" ? (event.subagentId as string) : undefined
          const streamKey = subagentId ? `${threadId}:subagent:${subagentId}` : threadId
          if (subagentId) {
            const keys = schedulerSubagentStreamKeysRef.current[threadId] ?? new Set<string>()
            keys.add(streamKey)
            schedulerSubagentStreamKeysRef.current[threadId] = keys
          }
          const tracker = (schedulerStreamingRef.current[streamKey] ||= {
            currentMsgId: null,
            accumulatedContent: "",
            accumulatedReasoning: ""
          })
          if (subagentId) {
            const startsSubagentMessage = id !== tracker.currentMsgId
            if (startsSubagentMessage) {
              tracker.currentMsgId = id
              tracker.subagentContentProjection = undefined
              tracker.subagentReasoningProjection = undefined
            }
            const contentProjection = appendSubagentLiveTextProjection(
              tracker.subagentContentProjection,
              content
            )
            tracker.subagentContentProjection = contentProjection
            const reasoningProjection = reasoning
              ? appendSubagentLiveTextProjection(tracker.subagentReasoningProjection, reasoning)
              : tracker.subagentReasoningProjection
            tracker.subagentReasoningProjection = reasoningProjection
            const now = new Date()
            appendSubagentTranscriptMessages(threadId, subagentId, [
              {
                id,
                role: "assistant" as const,
                content: contentProjection.content,
                content_is_projection: true,
                content_full_length: contentProjection.totalLength,
                content_stream_delta: content,
                ...(startsSubagentMessage && { content_pending_delta: content }),
                ...(reasoningProjection && {
                  reasoning: reasoningProjection.content,
                  reasoning_is_projection: true,
                  reasoning_full_length: reasoningProjection.totalLength,
                  ...(reasoning && {
                    reasoning_stream_delta: reasoning,
                    ...(startsSubagentMessage && { reasoning_pending_delta: reasoning })
                  })
                }),
                ...(toolCalls?.length && { tool_calls: toolCalls }),
                created_at: now
              }
            ])
            break
          }
          if (id !== tracker.currentMsgId) {
            tracker.currentMsgId = id
            tracker.accumulatedContent = content
            tracker.accumulatedReasoning = reasoning
          } else {
            tracker.accumulatedContent += content
            if (reasoning) {
              tracker.accumulatedReasoning = reasoning.startsWith(tracker.accumulatedReasoning)
                ? reasoning
                : `${tracker.accumulatedReasoning}${reasoning}`
            }
          }
          const finalContent = tracker.accumulatedContent
          const finalReasoning = tracker.accumulatedReasoning
          updateThreadState(threadId, (prev) => {
            const now = new Date()
            const incomingMessage: Message = {
              id,
              role: "assistant",
              content: finalContent,
              ...(finalReasoning && { reasoning: finalReasoning }),
              ...(toolCalls?.length && { tool_calls: toolCalls }),
              created_at: now
            }
            const nextToolCallStates = upsertToolCallStatesFromMessages(prev.toolCallStates, [
              incomingMessage
            ])
            // Defensive clear: any real assistant token means data is flowing
            // again, so a stale retry indicator must disappear.
            const clearRetry = prev.modelRetry ? { modelRetry: null } : {}
            if (
              replaceTrustedMessageTailInPlace(
                tracker.assistantLocation,
                prev.messages,
                incomingMessage
              )
            ) {
              return {
                ...clearRetry,
                messagesContentVersion: prev.messagesContentVersion + 1,
                toolCallStates: nextToolCallStates
              }
            }
            const normalizedMessage = normalizeAppendedMessageIds(prev.messages, [
              incomingMessage
            ])[0]
            const idx = prev.messages.findIndex(
              (message) =>
                message.id === normalizedMessage.id && message.role === normalizedMessage.role
            )
            if (idx >= 0) {
              const updated = [...prev.messages]
              updated[idx] = {
                ...updated[idx],
                ...normalizedMessage,
                created_at: updated[idx].created_at
              }
              tracker.assistantLocation =
                idx === updated.length - 1
                  ? { messages: updated, index: idx, tail: updated[idx] }
                  : undefined
              return { ...clearRetry, messages: updated, toolCallStates: nextToolCallStates }
            }
            const updated = [...prev.messages, normalizedMessage]
            tracker.assistantLocation = {
              messages: updated,
              index: updated.length - 1,
              tail: normalizedMessage
            }
            return {
              ...clearRetry,
              toolCallStates: nextToolCallStates,
              messages: updated
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
          const subagentId =
            typeof event.subagentId === "string" ? (event.subagentId as string) : undefined
          const now = new Date()
          if (subagentId) {
            appendSubagentTranscriptMessages(threadId, subagentId, [
              {
                id,
                role: "tool" as const,
                content,
                tool_call_id: toolCallId,
                name,
                is_error: isError,
                created_at: now
              }
            ])
            break
          }
          const tracker = (schedulerStreamingRef.current[threadId] ||= {
            currentMsgId: null,
            accumulatedContent: "",
            accumulatedReasoning: ""
          })
          updateThreadState(threadId, (prev) => {
            const incomingMessage: Message = {
              id,
              role: "tool",
              content,
              tool_call_id: toolCallId,
              name,
              is_error: isError,
              created_at: now
            }
            if (
              replaceTrustedMessageTailInPlace(tracker.toolLocation, prev.messages, incomingMessage)
            ) {
              const expectedStatus = isError ? "failed" : "completed"
              const existingToolState = prev.toolCallStates[toolCallId]
              return {
                messagesContentVersion: prev.messagesContentVersion + 1,
                ...(existingToolState?.status !== expectedStatus || existingToolState.name !== name
                  ? {
                      toolCallStates: upsertToolCallState(prev.toolCallStates, toolCallId, {
                        name,
                        status: expectedStatus
                      })
                    }
                  : {})
              }
            }
            const normalizedMessage = normalizeAppendedMessageIds(prev.messages, [
              incomingMessage
            ])[0]
            const existingIndex = prev.messages.findIndex(
              (message) =>
                message.id === normalizedMessage.id && message.role === normalizedMessage.role
            )
            if (existingIndex >= 0) {
              tracker.toolLocation =
                existingIndex === prev.messages.length - 1
                  ? {
                      messages: prev.messages,
                      index: existingIndex,
                      tail: prev.messages[existingIndex]
                    }
                  : undefined
              return {}
            }
            const updated = [...prev.messages, normalizedMessage]
            tracker.toolLocation = {
              messages: updated,
              index: updated.length - 1,
              tail: normalizedMessage
            }
            return {
              toolCallStates: upsertToolCallState(prev.toolCallStates, toolCallId, {
                name,
                status: isError ? "failed" : "completed"
              }),
              messages: updated
            }
          })
          break
        }
      }
    },
    [
      updateThreadState,
      loadThreadHistory,
      handleCustomEvent,
      clearSchedulerStreamingForThread,
      finalizeRunningSubagentsForStoppedStream,
      appendSubagentTranscriptMessages
    ]
  )

  const initializeThread = useCallback(
    (threadId: string) => {
      if (isThreadDeletionPending(threadId)) return
      // activeThreadIds is also the stream-holder LRU. Touch an already
      // initialized thread when a consumer revisits it so an evicted idle
      // holder is mounted again with a fresh transport.
      setActiveThreadIds((previous) => {
        const ids = Array.from(previous)
        if (ids[ids.length - 1] === threadId) return previous
        const next = new Set(previous)
        next.delete(threadId)
        next.add(threadId)
        return next
      })
      foregroundHydrationGeneration.transition(useAppStore.getState().currentThreadId)
      const foregroundToken = foregroundHydrationGeneration.capture(threadId)
      if (initializedThreadsRef.current.has(threadId)) {
        const state = threadStatesRef.current[threadId]
        const attempt = threadHistoryHydrationAttemptsRef.current[threadId]
        const attemptMatchesForeground = foregroundToken
          ? attempt?.foregroundToken?.threadId === foregroundToken.threadId &&
            attempt.foregroundToken.generation === foregroundToken.generation
          : attempt?.foregroundToken === null
        if (foregroundToken && attempt && !attemptMatchesForeground) {
          // A fresh foreground generation means the user explicitly reopened
          // this task. Grant it a new bounded recovery budget; background and
          // scheduler reloads do not silently restart an exhausted loop.
          delete threadHistoryHydrationRetryCountsRef.current[threadId]
          delete subagentTranscriptHydrationRetryCountsRef.current[threadId]
          const shouldRestartSubagentPersist =
            isSubagentTranscriptPersistRetryExhausted(
              subagentTranscriptPersistRetryCountRef.current[threadId] ?? 0
            ) &&
            !!subagentTranscriptDirtyIdsRef.current[threadId]?.size &&
            state?.subagentTranscriptBaselineReady === true
          delete subagentTranscriptPersistRetryCountRef.current[threadId]
          if (
            shouldRestartSubagentPersist &&
            !subagentTranscriptPersistChainsRef.current[threadId] &&
            subagentTranscriptPersistRetryTimersRef.current[threadId] === undefined
          ) {
            scheduleSubagentTranscriptsPersist(threadId)
          }
        }
        const subagentTranscriptRetryExhausted = isSubagentTranscriptHydrationRetryExhausted(
          subagentTranscriptHydrationRetryCountsRef.current[threadId] ?? 0
        )
        const attemptIsCurrent =
          attempt?.loadGeneration === threadHistoryLoadGenerationRef.current[threadId] &&
          attemptMatchesForeground
        if (
          (!state ||
            state.historyLoading ||
            state.historyConversationPresence === "unknown" ||
            (!state.subagentTranscriptBaselineReady && !subagentTranscriptRetryExhausted)) &&
          !attemptIsCurrent
        ) {
          void loadThreadHistory(threadId)
        }
        return
      }
      if (foregroundToken) {
        // A dehydrated task is no longer initialized, so it bypasses the
        // branch above. Reopening it is still an explicit foreground recovery
        // and must receive a fresh bounded retry budget.
        delete threadHistoryHydrationRetryCountsRef.current[threadId]
        delete subagentTranscriptHydrationRetryCountsRef.current[threadId]
        delete subagentTranscriptPersistRetryCountRef.current[threadId]
      }
      initializedThreadsRef.current.add(threadId)
      const threadActions = getThreadActions(threadId)
      const listenerEpoch = {}
      threadListenerEpochRef.current[threadId] = listenerEpoch
      const isCurrentListenerEpoch = (): boolean =>
        initializedThreadsRef.current.has(threadId) &&
        threadListenerEpochRef.current[threadId] === listenerEpoch

      if (!threadStatesRef.current[threadId]) {
        commitThreadStateChanges([
          {
            threadId,
            state: {
              ...createDefaultThreadState(),
              queuedMessages: loadQueuedMessages(threadId),
              historyLoading: true
            }
          }
        ])
      }

      void loadThreadHistory(threadId)

      // Register listeners synchronously so no stream events are missed
      if (threadId === "heartbeat") {
        const heartbeatCleanup = window.api.heartbeat.listenToStream(threadId, (event) => {
          if (!isCurrentListenerEpoch()) return
          processSchedulerEvent(threadId, event)
        })
        heartbeatListenerCleanups.current[threadId] = heartbeatCleanup
      } else {
        const schedulerCleanup = window.api.scheduledTasks.listenToStream(threadId, (event) => {
          if (!isCurrentListenerEpoch()) return
          processSchedulerEvent(threadId, event)
        })
        schedulerListenerCleanups.current[threadId] = schedulerCleanup
      }

      // Durable listener for coordinator-worker hook records. Worker hooks are
      // delivered on a thread-scoped channel (not the run stream) so they
      // survive async worker execution; route them through handleCustomEvent,
      // which buckets `hook_executed` envelopes into the per-turn hook log.
      const coordinatorWorkerHookCleanup = window.api.agent.onCoordinatorWorkerHook(
        threadId,
        (envelope) => {
          if (!isCurrentListenerEpoch()) return
          handleCustomEvent(threadId, envelope as CustomEventData)
        }
      )
      coordinatorWorkerHookListenerCleanups.current[threadId] = coordinatorWorkerHookCleanup

      // Durable workflow channel: background runs outlive the launching turn,
      // so their progress and the completion notification arrive here rather
      // than on the per-turn run stream.
      const workflowEventsCleanup = window.api.workflows.onWorkflowEvents(threadId, (payload) => {
        if (!isCurrentListenerEpoch()) return
        const envelope = payload as {
          type?: string
          workflowEvent?: Record<string, unknown>
          runId?: string
        }
        if (envelope?.type === "workflow_progress" && envelope.workflowEvent) {
          handleCustomEvent(threadId, {
            type: "workflow_progress",
            workflowEvent: envelope.workflowEvent
          } as CustomEventData)
        } else if (envelope?.type === "workflow_notification") {
          scheduleWorkflowNotificationTurn(threadId)
        }
      })
      workflowEventsListenerCleanups.current[threadId] = workflowEventsCleanup

      // Hydrate the panel from disk (renderer reload / app restart) and pick up
      // a completion that finished while no renderer was listening — ONLY for
      // workflow-mode threads, so normal/coordinator/goal threads pay no IPC.
      // (The durable listener above is cheap to keep registered for all
      // threads, matching the coordinator-hook subscription pattern, so a
      // thread switched INTO workflow mode still receives live events.)
      const hydrateThread = useAppStore
        .getState()
        .threads.find((thread) => thread.thread_id === threadId)
      if (isWorkflowModeMetadata(hydrateThread?.metadata)) {
        void window.api.workflows
          .hydrate(threadId)
          .then((raw) => {
            const hydrate = raw as {
              latestRun?: PersistedWorkflowRunDTO | null
              hasPendingNotification?: boolean
            } | null
            if (!isCurrentListenerEpoch()) return
            if (hydrate?.latestRun) {
              const restored = workflowRunViewFromPersisted(hydrate.latestRun)
              updateThreadState(threadId, (prev) =>
                // Live events may already have produced fresher state; only restore
                // when the panel is empty or showing the same run. reconcile keeps
                // fresh LIVE state but still adopts a TERMINAL hydrate over a stale
                // local "running" (dropped terminal event → dead cancel button).
                !prev.workflowRun || prev.workflowRun.runId === restored.runId
                  ? { workflowRun: reconcileHydratedWorkflowRun(prev.workflowRun, restored) }
                  : {}
              )
            }
            if (hydrate?.hasPendingNotification) {
              scheduleWorkflowNotificationTurn(threadId)
            }
          })
          .catch((error) => {
            console.warn("[ThreadContext] Workflow hydrate failed:", error)
          })
      }

      const cancelledApprovalRequestIds = new Set<string>()

      // Register global approval listeners for this thread (not tied to ChatContainer mount)
      const cleanupApproval = window.api.sandbox.onApprovalRequest(threadId, (request: unknown) => {
        console.log(`[ThreadProvider] Approval request for thread ${threadId}:`, request)
        if (!isCurrentListenerEpoch()) return
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
      const cleanupResolved = window.api.sandbox.onApprovalResolved(threadId, (data) => {
        console.log(
          `[ThreadProvider] Approval resolved outside desktop for thread ${threadId}: requestId=${data.requestId}, decision=${data.decision}`
        )
        if (!isCurrentListenerEpoch()) return
        cancelledApprovalRequestIds.add(data.requestId)
        updateThreadState(threadId, (state) => ({
          ...removePendingApprovalByRequestId(state, data.requestId)
        }))
      })
      const cleanupTimeout = window.api.sandbox.onApprovalTimeout(threadId, (data) => {
        console.warn(
          `[ThreadProvider] Approval timed out for thread ${threadId}: requestId=${data.requestId}`
        )
        if (!isCurrentListenerEpoch()) return
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
        if (!isCurrentListenerEpoch()) return
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
      approvalListenerCleanups.current[threadId] = [
        cleanupApproval,
        cleanupResolved,
        cleanupTimeout,
        cleanupCancel
      ]

      // When the main process injects steered messages into the running turn,
      // drop them from the draft queue and surface them as committed user turns
      // (the model already received them; the transcript should match).
      queueListenerCleanups.current[threadId] = window.api.agent.onQueuedMessagesInjected(
        threadId,
        ({ messages, assistantIdAlias }) => {
          if (!isCurrentListenerEpoch()) return
          if (!Array.isArray(messages) || messages.length === 0) return
          const injectedIds = new Set(messages.map((message) => message.id))
          const existingMessageIds = new Set(
            threadStatesRef.current[threadId]?.messages.map((message) => message.id) ?? []
          )
          updateThreadState(threadId, (state) => {
            const next = removeQueuedMessagesById(state.queuedMessages, injectedIds)
            const sourceId = assistantIdAlias?.sourceId
            const canonicalId = assistantIdAlias?.id
            const sourceIndex =
              sourceId && canonicalId
                ? state.messages.findIndex((message) => message.id === sourceId)
                : -1
            const canonicalAlreadyPresent =
              !!canonicalId && state.messages.some((message) => message.id === canonicalId)
            const nextMessages =
              sourceIndex < 0 || !canonicalId
                ? state.messages
                : canonicalAlreadyPresent
                  ? state.messages.filter((message) => message.id !== sourceId)
                  : state.messages.map((message, index) =>
                      index === sourceIndex ? { ...message, id: canonicalId } : message
                    )
            if (next === state.queuedMessages && nextMessages === state.messages) return {}
            if (next !== state.queuedMessages) persistQueuedMessages(threadId, next)
            return {
              ...(next !== state.queuedMessages ? { queuedMessages: next } : {}),
              ...(nextMessages !== state.messages ? { messages: nextMessages } : {})
            }
          })
          for (const message of messages) {
            if (!message.id || existingMessageIds.has(message.id)) continue
            // Reuse appendMessage so an injected turn has the same hook-log,
            // coordinator-notification, and interruption-reset effects as a
            // normal user submission.
            threadActions.appendMessage({
              id: message.id,
              role: "user",
              content: message.content,
              created_at: new Date()
            })
          }
        }
      )

      window.api.sandbox
        .getPendingApprovals(threadId)
        .then((requests) => {
          if (!isCurrentListenerEpoch()) return
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
          if (currentId !== threadId && isCurrentListenerEpoch()) {
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
        if (!isCurrentListenerEpoch()) return
        updateThreadState(threadId, () => ({ pendingUserInput: request }))
      })
      const cleanupUserInputCancel = window.api.userInput.onCancel(threadId, (data) => {
        console.log(
          `[ThreadProvider] User input cancelled for thread ${threadId}: requestId=${data.requestId}`
        )
        if (!isCurrentListenerEpoch()) return
        updateThreadState(threadId, (state) => {
          if (state.pendingUserInput?.requestId !== data.requestId) return {}
          return { pendingUserInput: null }
        })
      })
      userInputListenerCleanups.current[threadId] = [cleanupUserInput, cleanupUserInputCancel]
      void window.api.userInput
        .getPending(threadId)
        .then((request) => {
          if (!request || !isCurrentListenerEpoch()) return
          updateThreadState(threadId, () => ({ pendingUserInput: request }))
        })
        .catch((error) => {
          console.warn(
            `[ThreadProvider] Failed to restore pending user input for thread ${threadId}:`,
            error
          )
        })
    },
    [
      loadThreadHistory,
      processSchedulerEvent,
      updateThreadState,
      handleCustomEvent,
      scheduleWorkflowNotificationTurn,
      getThreadActions,
      commitThreadStateChanges,
      foregroundHydrationGeneration,
      scheduleSubagentTranscriptsPersist
    ]
  )

  useEffect(() => {
    return window.api.agent.onManagedAutoSendStreamStart((event) => {
      setManagedAutoSendRuns((prev) => ({
        ...prev,
        [event.threadId]: event
      }))
      initializeThread(event.threadId)
    })
  }, [initializeThread])

  useEffect(() => {
    return window.api.harnessBoard.onManagedRunThreadCreated((event) => {
      useAppStore.getState().addThreadSummary(event.thread)
      if (initializedThreadsRef.current.has(event.threadId)) {
        loadThreadHistory(event.threadId)
      } else {
        initializeThread(event.threadId)
      }
    })
  }, [initializeThread, loadThreadHistory])

  useEffect(() => {
    foregroundHydrationGeneration.transition(currentThreadId)
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

    // Tell the main process which thread is in the foreground so the workspace
    // watcher LRU never evicts it (and re-arm it if it was previously evicted).
    void window.api.workspace
      .setActiveThread(currentThreadId)
      .then((watcherResult) => {
        if (!currentThreadId || !watcherResult.success || !watcherResult.restarted) return
        const workspacePath =
          watcherResult.workspacePath ?? threadStatesRef.current[currentThreadId]?.workspacePath
        if (!workspacePath) return

        // The watcher was absent while this task was inactive, so its cached
        // tree may be stale. Invalidate it now, but defer the potentially huge
        // recursive scan and IPC payload until the user opens the Files panel.
        // A task switch must never deserialize tens of thousands of file rows.
        markWorkspaceFilesStale(currentThreadId, workspacePath)
      })
      .catch(() => {})

    if (!currentThreadId) return

    let cancelled = false
    void requestCoordinatorWorkers(currentThreadId, true)
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
  }, [currentThreadId, foregroundHydrationGeneration, requestCoordinatorWorkers, updateThreadState])

  const releaseThreadListeners = useCallback(
    (threadId: string): void => {
      delete threadListenerEpochRef.current[threadId]
      schedulerListenerCleanups.current[threadId]?.()
      delete schedulerListenerCleanups.current[threadId]
      heartbeatListenerCleanups.current[threadId]?.()
      delete heartbeatListenerCleanups.current[threadId]
      coordinatorWorkerHookListenerCleanups.current[threadId]?.()
      delete coordinatorWorkerHookListenerCleanups.current[threadId]
      workflowEventsListenerCleanups.current[threadId]?.()
      delete workflowEventsListenerCleanups.current[threadId]
      approvalListenerCleanups.current[threadId]?.forEach((cleanup) => cleanup())
      delete approvalListenerCleanups.current[threadId]
      queueListenerCleanups.current[threadId]?.()
      delete queueListenerCleanups.current[threadId]
      userInputListenerCleanups.current[threadId]?.forEach((cleanup) => cleanup())
      delete userInputListenerCleanups.current[threadId]
    },
    [updateThreadState]
  )

  const cleanupThread = useCallback(
    (threadId: string) => {
      // Invalidate a model read started by the deleted row. Reusing the same id
      // later must not let that old continuation patch the replacement row.
      const modelGateGeneration = modelSelectionGateRef.current.begin(threadId)
      modelSelectionGateRef.current.finish(threadId, modelGateGeneration)
      // Invalidate every in-flight history/transcript hydration request before
      // any cleanup can yield back to the event loop. Keep the counter instead
      // of deleting it so a later reinitialization cannot reuse a stale token.
      threadHistoryLoadGenerationRef.current[threadId] =
        (threadHistoryLoadGenerationRef.current[threadId] ?? 0) + 1
      messageWindowIntentCoordinator.cancel(threadId)
      firstTranscriptPublishedThreadIdsRef.current.delete(threadId)
      delete knownDurableMessageIdsRef.current[threadId]
      delete threadHistoryHydrationAttemptsRef.current[threadId]
      const historyHydrationRetryTimer = threadHistoryHydrationRetryTimersRef.current[threadId]
      if (historyHydrationRetryTimer !== undefined) {
        window.clearTimeout(historyHydrationRetryTimer)
        delete threadHistoryHydrationRetryTimersRef.current[threadId]
      }
      delete threadHistoryHydrationRetryCountsRef.current[threadId]
      delete subagentTranscriptHydrationRetryCountsRef.current[threadId]
      coordinatorWorkerRequestCache.invalidate(threadId)
      void window.api.agent.unbindCoordinatorWorkers(threadId).catch((error: unknown) => {
        console.warn("[ThreadProvider] Failed to unbind coordinator worker updates:", error)
      })
      releaseThreadListeners(threadId)
      const workflowNotificationTimer = workflowNotificationTimersRef.current[threadId]
      if (workflowNotificationTimer !== undefined) {
        window.clearTimeout(workflowNotificationTimer)
        delete workflowNotificationTimersRef.current[threadId]
      }
      delete workflowNotificationAttemptsRef.current[threadId]
      delete workflowNotificationRetryOnIdleRef.current[threadId]
      // Cancel any queued workflow_progress RAF and drop the buffer entry. Without
      // this, a frame still queued when the thread is deleted fires flush →
      // updateThreadState(threadId, ...), which resurrects the deleted thread
      // (prev[threadId] || createDefaultThreadState()) as a ghost entry. (#2)
      const workflowProgressBuf = workflowProgressBufferRef.current.get(threadId)
      if (workflowProgressBuf?.rafId != null) cancelAnimationFrame(workflowProgressBuf.rafId)
      workflowProgressBufferRef.current.delete(threadId)
      clearSchedulerStreamingForThread(threadId)
      const subagentTranscriptPersistTimer = subagentTranscriptPersistTimersRef.current[threadId]
      if (subagentTranscriptPersistTimer !== undefined) {
        window.clearTimeout(subagentTranscriptPersistTimer)
        delete subagentTranscriptPersistTimersRef.current[threadId]
      }
      delete subagentTranscriptDirtyIdsRef.current[threadId]
      delete subagentTranscriptPendingMessagesRef.current[threadId]
      delete subagentTranscriptUrgentIdsRef.current[threadId]
      delete subagentTranscriptPersistChainsRef.current[threadId]
      delete subagentTranscriptPersistRetryCountRef.current[threadId]
      subagentTranscriptPersistRecoveryRequestsRef.current.delete(threadId)
      const subagentTranscriptHydrationRetryTimer =
        subagentTranscriptHydrationRetryTimersRef.current[threadId]
      if (subagentTranscriptHydrationRetryTimer !== undefined) {
        window.clearTimeout(subagentTranscriptHydrationRetryTimer)
        delete subagentTranscriptHydrationRetryTimersRef.current[threadId]
      }
      const subagentTranscriptPersistRetryTimer =
        subagentTranscriptPersistRetryTimersRef.current[threadId]
      if (subagentTranscriptPersistRetryTimer !== undefined) {
        window.clearTimeout(subagentTranscriptPersistRetryTimer)
        delete subagentTranscriptPersistRetryTimersRef.current[threadId]
      }
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
      const contextCompactionDismissTimer = contextCompactionDismissTimersRef.current[threadId]
      if (contextCompactionDismissTimer !== undefined) {
        window.clearTimeout(contextCompactionDismissTimer)
      }
      delete contextCompactionDismissTimersRef.current[threadId]

      initializedThreadsRef.current.delete(threadId)
      delete actionsCache.current[threadId]
      delete streamDataRef.current[threadId]
      delete streamSubscribersRef.current[threadId]
      delete hookLogBucketsRef.current[threadId]
      delete pendingHookLogBucketOpensRef.current[threadId]
      delete pendingVisibleMessageCommitsRef.current[threadId]
      delete liveStreamAccumulatorsRef.current[threadId]
      delete transitionalLiveMessagesRef.current[threadId]
      delete rendererOnlyMessageIdAliasesRef.current[threadId]
      const durableSyncInvalidation = durableTranscriptSyncGateRef.current.begin(threadId)
      durableTranscriptSyncGateRef.current.finish(threadId, durableSyncInvalidation)
      delete latestDurableMessagePageIdentitiesRef.current[threadId]
      delete checkpointFallbackIndexBaselinesRef.current[threadId]
      delete subagentTranscriptsRef.current[threadId]
      disableChatReportUploadForThread(threadId)
      delete hookLogsSubscribersRef.current[threadId]
      setActiveThreadIds((prev) => {
        if (!prev.has(threadId)) return prev
        const next = new Set(prev)
        next.delete(threadId)
        return next
      })
      setManagedAutoSendRuns((prev) => {
        if (!prev[threadId]) return prev
        const { [threadId]: _removed, ...rest } = prev
        void _removed
        return rest
      })
      deleteThreadState(threadId)
    },
    [
      clearSchedulerStreamingForThread,
      clearSchedulerMainStreamingForThread,
      coordinatorWorkerRequestCache,
      deleteThreadState,
      messageWindowIntentCoordinator,
      releaseThreadListeners
    ]
  )

  const handleStreamHolderDispose = useCallback((threadId: string): void => {
    const streamData = streamDataRef.current[threadId]
    // An idle-holder eviction never reaches this branch. Retain an unexpected
    // live snapshot defensively if a run edge raced with reconciliation.
    if (streamData?.isLoading) return
    delete streamDataRef.current[threadId]
    const accumulator = liveStreamAccumulatorsRef.current[threadId]
    if (!accumulator?.active) delete liveStreamAccumulatorsRef.current[threadId]
    delete transitionalLiveMessagesRef.current[threadId]
  }, [])

  const canDehydrateThread = useCallback(
    (threadId: string): boolean => {
      if (!initializedThreadsRef.current.has(threadId)) return false
      if (useAppStore.getState().currentThreadId === threadId) return false
      if ((threadStateSubscribersRef.current[threadId]?.size ?? 0) > 0) return false
      if ((streamSubscribersRef.current[threadId]?.size ?? 0) > 0) return false
      if ((hookLogsSubscribersRef.current[threadId]?.size ?? 0) > 0) return false

      const state = threadStatesRef.current[threadId]
      if (!state) return false
      const hydrationAttempt = threadHistoryHydrationAttemptsRef.current[threadId]
      const hydrationAttemptIsActive = isThreadHistoryHydrationAttemptActive(
        hydrationAttempt,
        threadHistoryLoadGenerationRef.current[threadId],
        foregroundHydrationGeneration
      )
      const subagentTranscriptRetryExhausted = isSubagentTranscriptHydrationRetryExhausted(
        subagentTranscriptHydrationRetryCountsRef.current[threadId] ?? 0
      )
      if (
        hydrationAttemptIsActive &&
        (state.historyLoading ||
          state.historyPageLoading ||
          (!state.subagentTranscriptBaselineReady && !subagentTranscriptRetryExhausted))
      ) {
        return false
      }
      if (streamDataRef.current[threadId]?.isLoading || loadingStatesRef.current[threadId]) {
        return false
      }
      if (streamDataRef.current[threadId]?.liveMessages.length) return false
      if (
        hasBlockingSpecialThreadActivity({
          scheduledTaskLoading: state.scheduledTaskLoading,
          goalStatus: state.goalUi.goal?.status,
          workflowStatus: state.workflowRun?.status,
          coordinatorWorkers: state.coordinatorWorkers
        })
      ) {
        return false
      }
      if (state.activeTurnStartTime != null) return false
      if (state.pendingApprovals.length || state.pendingUserInput) return false
      if (state.queuedMessages.length) return false
      if (state.hookInterruption || state.modelRetry) return false
      if (state.contextCompaction?.phase === "started") return false
      if (
        state.subagents.some(
          (subagent) =>
            subagent.status !== "completed" &&
            subagent.status !== "failed" &&
            subagent.status !== "cancelled"
        )
      ) {
        return false
      }

      if (pendingHookLogBucketOpensRef.current[threadId]?.size) return false
      if (pendingVisibleMessageCommitsRef.current[threadId]?.length) return false
      if (workflowProgressBufferRef.current.has(threadId)) return false
      if (subagentTranscriptDirtyIdsRef.current[threadId]?.size) return false
      if (subagentTranscriptPendingMessagesRef.current[threadId]) return false
      if (subagentTranscriptUrgentIdsRef.current[threadId]?.size) return false
      if (subagentTranscriptPersistTimersRef.current[threadId] !== undefined) return false
      if (subagentTranscriptPersistRetryTimersRef.current[threadId] !== undefined) return false
      if (subagentTranscriptHydrationRetryTimersRef.current[threadId] !== undefined) return false
      if (threadHistoryHydrationRetryTimersRef.current[threadId] !== undefined) return false
      if (subagentTranscriptPersistChainsRef.current[threadId]) return false
      if (workflowNotificationTimersRef.current[threadId] !== undefined) return false
      if (workflowNotificationRetryOnIdleRef.current[threadId]) return false
      if (coordinatorNotificationTimersRef.current[threadId] !== undefined) return false
      if (coordinatorNotificationRetryOnIdleRef.current[threadId]) return false
      if (coordinatorNotificationAutoRunSuppressedRef.current.has(threadId)) return false
      if (coordinatorNotificationSuppressTimersRef.current[threadId] !== undefined) return false
      if (contextCompactionDismissTimersRef.current[threadId] !== undefined) return false
      return true
    },
    [foregroundHydrationGeneration]
  )

  const dehydrateThread = useCallback(
    (threadId: string): void => {
      // The LRU predicate is deliberately checked again at the mutation edge.
      // A background event may have made a thread non-idle since the effect
      // selected it; in that case retaining the hydrated state is the only safe
      // choice.
      if (!canDehydrateThread(threadId)) return

      // Fence every async path before releasing listeners or scheduling React
      // state. Reopening the thread allocates a fresh generation/actions object
      // and rehydrates the durable transcript through initializeThread.
      initializedThreadsRef.current.delete(threadId)
      threadHistoryLoadGenerationRef.current[threadId] =
        (threadHistoryLoadGenerationRef.current[threadId] ?? 0) + 1
      messageWindowIntentCoordinator.cancel(threadId)
      firstTranscriptPublishedThreadIdsRef.current.delete(threadId)
      delete knownDurableMessageIdsRef.current[threadId]
      delete threadHistoryHydrationAttemptsRef.current[threadId]
      delete subagentTranscriptHydrationRetryCountsRef.current[threadId]
      coordinatorWorkerRequestCache.invalidate(threadId)
      const durableSyncInvalidation = durableTranscriptSyncGateRef.current.begin(threadId)
      durableTranscriptSyncGateRef.current.finish(threadId, durableSyncInvalidation)
      void window.api.agent.unbindCoordinatorWorkers(threadId).catch((error: unknown) => {
        console.warn("[ThreadProvider] Failed to unbind dehydrated coordinator updates:", error)
      })
      releaseThreadListeners(threadId)
      clearSchedulerStreamingForThread(threadId)

      delete actionsCache.current[threadId]
      delete streamDataRef.current[threadId]
      delete streamSubscribersRef.current[threadId]
      delete threadStateSubscribersRef.current[threadId]
      delete hookLogsSubscribersRef.current[threadId]
      delete hookLogBucketsRef.current[threadId]
      delete liveStreamAccumulatorsRef.current[threadId]
      delete transitionalLiveMessagesRef.current[threadId]
      delete rendererOnlyMessageIdAliasesRef.current[threadId]
      delete latestDurableMessagePageIdentitiesRef.current[threadId]
      delete checkpointFallbackIndexBaselinesRef.current[threadId]
      delete subagentTranscriptsRef.current[threadId]
      delete pendingHookLogBucketOpensRef.current[threadId]
      delete pendingVisibleMessageCommitsRef.current[threadId]
      delete subagentTranscriptDirtyIdsRef.current[threadId]
      delete subagentTranscriptPendingMessagesRef.current[threadId]
      delete subagentTranscriptUrgentIdsRef.current[threadId]
      delete subagentTranscriptPersistRetryCountRef.current[threadId]
      subagentTranscriptPersistRecoveryRequestsRef.current.delete(threadId)
      delete workflowNotificationAttemptsRef.current[threadId]
      delete workflowNotificationRetryOnIdleRef.current[threadId]
      delete coordinatorNotificationAttemptsRef.current[threadId]
      delete coordinatorNotificationRetryOnIdleRef.current[threadId]
      delete previousLoadingStatesRef.current[threadId]

      const previousLoadingStates = loadingStatesRef.current
      if (Object.prototype.hasOwnProperty.call(previousLoadingStates, threadId)) {
        const nextLoadingStates = { ...previousLoadingStates }
        delete nextLoadingStates[threadId]
        loadingStatesRef.current = nextLoadingStates
        setLoadingStates(nextLoadingStates)
        allStreamSubscribersRef.current.forEach((callback) => callback())
      }

      setActiveThreadIds((previous) => {
        if (!previous.has(threadId)) return previous
        const next = new Set(previous)
        next.delete(threadId)
        return next
      })
      updateThreadState(threadId, (state) =>
        createDehydratedThreadStatePatch({
          openFiles: state.openFiles,
          activeTab: state.activeTab
        })
      )
    },
    [
      canDehydrateThread,
      clearSchedulerStreamingForThread,
      coordinatorWorkerRequestCache,
      messageWindowIntentCoordinator,
      releaseThreadListeners,
      updateThreadState
    ]
  )

  useEffect(() => {
    const holderIds = Array.from(activeThreadIds)
    const evictableIdleHolderIds = holderIds.filter(canDehydrateThread)
    const excess = evictableIdleHolderIds.length - MAX_RETAINED_IDLE_STREAM_HOLDERS
    if (excess <= 0) return

    for (const threadId of evictableIdleHolderIds.slice(0, excess)) {
      dehydrateThread(threadId)
    }
  }, [
    activeThreadIds,
    canDehydrateThread,
    dehydrationEligibilityRevision,
    dehydrateThread,
    loadingStates
  ])

  // 运行态电平校正(心跳 + 定时任务线程)安全网:输入锁 scheduledTaskLoading 平时
  // 由流事件边沿驱动(started/数据置 true,done/error 清 false),一旦 done 丢失
  // (监听器被清、窗口错过广播)就永久冻结——此时主进程已空闲,取消按钮打过去是
  // 无任务可停的空操作,界面表现为"卡死且点不动"。这里以主进程 isRunning 为权威,
  // 在 changed 广播与手动取消后校正。
  //
  // 只清不设:isRunning 按 taskId 判定,而多个线程可共用同一 taskId(同一定时任务被
  // 反复触发,每次新建线程)。若在此把 running=true 回写,任务再次跑进新线程时会把
  // 旧的已完成线程一并错标成 loading——反而制造旋转。设 true 是流 "started" 事件和
  // 打开线程时水合(读该线程自身 metadata)的职责,各自按线程精确;这个 changed 安全
  // 网只负责清除任务已停后仍残留的 loading。写入前重读当前 store,过期快照不落地;
  // 清除时同步清残留流气泡并重载历史,恢复干净视图。
  // (ChatX 线程同轨但缺按线程的 isRunning 查询,暂不覆盖,见 roadmap。)
  const reconcileScheduledRunStates = useCallback(() => {
    const reconcileThread = (threadId: string, runningPromise: Promise<boolean>): void => {
      runningPromise
        .then((running) => {
          if (running) return // 只清不设:运行中交给 started 边沿/水合,避免 taskId 别名误标
          if (!initializedThreadsRef.current.has(threadId)) return
          if (threadStatesRef.current[threadId]?.scheduledTaskLoading !== true) return
          clearSchedulerStreamingForThread(threadId)
          finalizeRunningSubagentsForStoppedStream(threadId)
          loadThreadHistory(threadId)
          updateThreadState(threadId, () => ({ scheduledTaskLoading: false }))
        })
        .catch(() => {})
    }
    if (initializedThreadsRef.current.has("heartbeat")) {
      reconcileThread("heartbeat", window.api.heartbeat.isRunning())
    }
    for (const [threadId, state] of Object.entries(threadStatesRef.current)) {
      if (threadId === "heartbeat") continue
      const taskId = state?.scheduledTaskId
      if (!taskId || !initializedThreadsRef.current.has(threadId)) continue
      reconcileThread(threadId, window.api.scheduledTasks.isRunning(taskId))
    }
  }, [
    clearSchedulerStreamingForThread,
    finalizeRunningSubagentsForStoppedStream,
    loadThreadHistory,
    updateThreadState
  ])

  useEffect(() => {
    const offHeartbeat = window.api.heartbeat.onChanged(reconcileScheduledRunStates)
    const offTasks = window.api.scheduledTasks.onChanged(reconcileScheduledRunStates)
    reconcileScheduledRunStates()
    return () => {
      offHeartbeat()
      offTasks()
    }
  }, [reconcileScheduledRunStates])

  // Lightweight turn lifecycle for lazy (unopened) threads: the sidebar renders
  // its loading indicator from thread-state summary flags, but per-thread
  // streams and history hydration only start once the thread is opened. This
  // global listener flips only the flag, so IM-driven turns surface the spinner
  // immediately without paying for the full stream or early hydration.
  useEffect(() => {
    const offActivity = window.api.scheduledTasks.listenToThreadActivity(({ threadId, type }) => {
      if (initializedThreadsRef.current.has(threadId)) return
      if (type === "started") {
        updateThreadState(threadId, () => ({ scheduledTaskLoading: true }))
        return
      }
      if (type === "done" || type === "error") {
        if (threadStatesRef.current[threadId]?.scheduledTaskLoading !== true) return
        updateThreadState(threadId, () => ({ scheduledTaskLoading: false }))
      }
    })
    return offActivity
  }, [updateThreadState])
  const contextValue = useMemo<ThreadContextValue>(
    () => ({
      getThreadState,
      subscribeToThreadState,
      getThreadActions,
      initializeThread,
      cleanupThread,
      subscribeToStream,
      getStreamData,
      subscribeToHookLogs,
      getHookLogBuckets,
      getAllThreadStates,
      subscribeToAllThreadStates,
      getThreadStateSummaries,
      subscribeToThreadStateSummaries,
      getAllStreamLoadingStates,
      subscribeToAllStreams,
      suppressCoordinatorNotificationAutoRun,
      reconcileScheduledRunStates
    }),
    [
      getThreadState,
      subscribeToThreadState,
      getThreadActions,
      initializeThread,
      cleanupThread,
      subscribeToStream,
      getStreamData,
      subscribeToHookLogs,
      getHookLogBuckets,
      getAllThreadStates,
      subscribeToAllThreadStates,
      getThreadStateSummaries,
      subscribeToThreadStateSummaries,
      getAllStreamLoadingStates,
      subscribeToAllStreams,
      suppressCoordinatorNotificationAutoRun,
      reconcileScheduledRunStates
    ]
  )

  return (
    <ThreadContext.Provider value={contextValue}>
      {/* Render stream holders for all active threads */}
      {Array.from(activeThreadIds).map((threadId) => {
        const state = threadStatesRef.current[threadId]
        if (!state?.subagentTranscriptBaselineReady) return null
        const managedAutoSendRun = managedAutoSendRuns[threadId]
        return (
          <ThreadStreamHolder
            key={`${threadId}:${managedAutoSendRun?.runId ?? "standard"}`}
            threadId={threadId}
            managedAutoSendRun={managedAutoSendRun}
            messages={state.messages}
            checkpointFallbackIndexBaselines={checkpointFallbackIndexBaselinesRef.current[threadId]}
            subagentTranscriptBaseline={state.subagentTranscripts}
            onStreamUpdate={handleStreamUpdate}
            onCustomEvent={handleCustomEvent}
            onError={handleError}
            onDispose={handleStreamHolderDispose}
          />
        )
      })}
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

  const subscribe = useCallback(
    (callback: () => void) => context.subscribeToThreadState(threadId, callback),
    [context, threadId]
  )
  const getSnapshot = useCallback(() => context.getThreadState(threadId), [context, threadId])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const actions = context.getThreadActions(threadId)

  return { ...state, ...actions }
}

// Hook for nullable threadId
export function useThreadState(threadId: string | null): (ThreadState & ThreadActions) | null {
  const context = useThreadContext()

  useEffect(() => {
    if (threadId) context.initializeThread(threadId)
  }, [threadId, context])

  const subscribe = useCallback(
    (callback: () => void) =>
      threadId ? context.subscribeToThreadState(threadId, callback) : () => {},
    [context, threadId]
  )
  const getSnapshot = useCallback(
    () => (threadId ? context.getThreadState(threadId) : null),
    [context, threadId]
  )
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (!threadId || !state) return null

  const actions = context.getThreadActions(threadId)

  return { ...state, ...actions }
}

/**
 * Subscribe to one ThreadState projection. The per-thread store may publish on
 * every token, but useSyncExternalStore sees the same selected snapshot when an
 * unrelated field changes and therefore skips the consumer render.
 */
export function useThreadStateSelector<T>(
  threadId: string | null,
  selector: (state: ThreadState) => T
): T | null {
  const context = useThreadContext()

  useEffect(() => {
    if (threadId) context.initializeThread(threadId)
  }, [threadId, context])

  const subscribe = useCallback(
    (callback: () => void) =>
      threadId ? context.subscribeToThreadState(threadId, callback) : () => {},
    [context, threadId]
  )
  const getSnapshot = useCallback(
    (): T | null => (threadId ? selector(context.getThreadState(threadId)) : null),
    [context, selector, threadId]
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Access stable actions without subscribing to unrelated ThreadState fields. */
export function useThreadActions(threadId: string | null): ThreadActions | null {
  const context = useThreadContext()
  useEffect(() => {
    if (threadId) context.initializeThread(threadId)
  }, [threadId, context])
  return useMemo(() => (threadId ? context.getThreadActions(threadId) : null), [context, threadId])
}

// Hook to get all initialized thread states (for kanban view)
export function useAllThreadStates(): Record<string, ThreadState> {
  const context = useThreadContext()
  return useSyncExternalStore(
    context.subscribeToAllThreadStates,
    context.getAllThreadStates,
    context.getAllThreadStates
  )
}

// Lightweight sidebar registry. Content-only frames do not change these
// summaries, so a permanently mounted sidebar stays off the token hot path.
export function useThreadStateSummaries(): Record<string, ThreadStateSummary> {
  const context = useThreadContext()
  return useSyncExternalStore(
    context.subscribeToThreadStateSummaries,
    context.getThreadStateSummaries,
    context.getThreadStateSummaries
  )
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
