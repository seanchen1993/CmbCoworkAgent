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
import type {
  Message,
  Todo,
  FileInfo,
  Subagent,
  HITLRequest,
  SkillMetadata,
  AgentAutoCommitResult,
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
import { buildStableValuesMessageId } from "./stream-message-ids"
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

// 历史消息耗时不单独存 duration，而是存每条消息的 start_at/end_at。
//
// ChatContainer 展示时会根据消息分组实时计算：
// 当前 user.start_at -> 下一个 user 之前最后一条消息.end_at。
// 因此这里恢复历史消息时，只要把每条消息的 start_at/end_at 补回 Message，
// 展示层就能用同一套逻辑显示历史耗时。
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
  // 兼容旧数据：如果没有顺序数组，就尽量按 messageTimes map 的插入顺序恢复。
  //
  // 旧数据无法做到百分百保证 id 与 checkpoint 消息一致，但按插入顺序恢复可以覆盖大多数
  // “当时按会话顺序写入 messageTimes”的历史会话。
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
  event: string
  hookType: string
  label: string
  toolSuffix: string
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
  timestamp: Date
}

export interface HookInterruptionState {
  event: string
  action: "block" | "halt"
  reason: string
  systemMessage?: string
  timestamp: Date
}

// Per-thread state (persisted/restored from checkpoints)
export interface ThreadState {
  messages: Message[]
  goalUi: GoalUiState
  todos: Todo[]
  workspaceFiles: FileInfo[]
  workspacePath: string | null
  subagents: Subagent[]
  pendingApproval: HITLRequest | null
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
  setGoalUi: (goalUi: GoalUiState) => void
  refreshGoalUi: (options?: { includeEvents?: boolean }) => Promise<void>
  setTodos: (todos: Todo[]) => void
  setWorkspaceFiles: (files: FileInfo[] | ((prev: FileInfo[]) => FileInfo[])) => void
  setWorkspacePath: (path: string | null) => void
  setSubagents: (subagents: Subagent[]) => void
  setPendingApproval: (request: HITLRequest | null) => void
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
  // Hook log subscription (external store — no re-renders on ThreadProvider)
  subscribeToHookLogs: (threadId: string, callback: () => void) => () => void
  getHookLogs: (threadId: string) => HookLogEntry[]
  // Get all initialized thread states (for kanban view)
  getAllThreadStates: () => Record<string, ThreadState>
  // Get all stream loading states (for kanban view)
  getAllStreamLoadingStates: () => Record<string, boolean>
  // Subscribe to all stream updates
  subscribeToAllStreams: (callback: () => void) => () => void
}

// Default thread state
const createDefaultThreadState = (): ThreadState => ({
  messages: [],
  goalUi: { goal: null, events: [], lastUpdated: null },
  todos: [],
  workspaceFiles: [],
  workspacePath: null,
  subagents: [],
  pendingApproval: null,
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

const defaultStreamData: StreamData = {
  messages: [],
  liveMessages: [],
  isLoading: false,
  stream: null
}
const EMPTY_HOOK_LOGS: HookLogEntry[] = []

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
  event?: string
  hookType?: string
  hookEvent?: string
  action?: string
  label?: string
  toolSuffix?: string
  exitCode?: number | null
  blocked?: boolean
  continue?: boolean
  stopReason?: string
  decision?: string
  stdout?: string
  stderr?: string
  additionalContext?: string
  systemMessage?: string
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
  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({})
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(new Set())
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({})
  const initializedThreadsRef = useRef<Set<string>>(new Set())
  const actionsCache = useRef<Record<string, ThreadActions>>({})
  const threadStatesRef = useRef<Record<string, ThreadState>>({})

  // Stream data store (not React state - we use subscriptions)
  const streamDataRef = useRef<Record<string, StreamData>>({})
  const streamSubscribersRef = useRef<Record<string, Set<() => void>>>({})
  const liveStreamAccumulatorsRef = useRef<Record<string, LiveStreamAccumulator>>({})
  const checkpointFallbackIndexBaselinesRef = useRef<Record<string, StreamFallbackIndexBaselines>>(
    {}
  )

  // Hook logs store (not React state — avoids re-rendering chat on every hook fire)
  const hookLogsRef = useRef<Record<string, HookLogEntry[]>>({})
  const hookLogsSubscribersRef = useRef<Record<string, Set<() => void>>>({})

  useEffect(() => {
    threadStatesRef.current = threadStates
  }, [threadStates])

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

  const getHookLogs = useCallback((threadId: string): HookLogEntry[] => {
    return hookLogsRef.current[threadId] ?? EMPTY_HOOK_LOGS
  }, [])

  // Notify subscribers for a thread
  const notifyStreamSubscribers = useCallback((threadId: string) => {
    const subscribers = streamSubscribersRef.current[threadId]
    if (subscribers) {
      subscribers.forEach((callback) => callback())
    }
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

        accumulator.baselineIds.add(
          buildStableValuesMessageId({
            index: fallbackIndex,
            type: fallbackType,
            className: stableClassNameForFallbackType(fallbackType),
            content:
              typeof checkpointMessage.content === "string" ? checkpointMessage.content : undefined,
            toolCallId: checkpointMessage.tool_call_id,
            name: checkpointMessage.name,
            toolCalls: checkpointMessage.tool_calls
          })
        )
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

  const getThreadState = useCallback((threadId: string): ThreadState => {
    const state = threadStatesRef.current[threadId] || createDefaultThreadState()
    if (state.pendingApproval) {
      console.log(
        "[ThreadContext] getThreadState returning pendingApproval for:",
        threadId,
        state.pendingApproval
      )
    }
    return state
  }, [])

  const getAllThreadStates = useCallback((): Record<string, ThreadState> => {
    return threadStates
  }, [threadStates])

  const getAllStreamLoadingStates = useCallback((): Record<string, boolean> => {
    return loadingStates
  }, [loadingStates])

  const subscribeToAllStreams = useCallback(() => {
    return () => {}
  }, [])

  const updateThreadState = useCallback(
    (threadId: string, updater: (prev: ThreadState) => Partial<ThreadState>) => {
      setThreadStates((prev) => {
        const currentState = prev[threadId] || createDefaultThreadState()
        const updates = updater(currentState)
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
      console.log("[ThreadContext] Custom event received:", { threadId, type: data.type, data })
      switch (data.type) {
        case "interrupt":
          if (data.request) {
            console.log(
              "[ThreadContext] Setting pendingApproval for thread:",
              threadId,
              data.request
            )
            updateThreadState(threadId, () => ({
              pendingApproval: {
                ...data.request!,
                allowRuntimeRestoredCheckpointResume:
                  data.request!.allowRuntimeRestoredCheckpointResume ?? true
              }
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
            updateThreadState(threadId, () => ({ workspacePath: data.path }))
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
            event: data.event ?? "",
            hookType: data.hookType ?? "command",
            label: data.label ?? "",
            toolSuffix: data.toolSuffix ?? "",
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
            timestamp: new Date()
          }
          hookLogsRef.current[threadId] = [...(hookLogsRef.current[threadId] ?? []), entry]
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
            updateThreadState(threadId, (prev) => {
              // Keep the higher of previous or new input tokens
              // This ensures we don't lose accumulated context during tool calls
              const newInputTokens = data.usage!.inputTokens || 0
              const prevInputTokens = prev.tokenUsage?.inputTokens || 0

              // Always update if new value is higher, or if this is first update
              if (newInputTokens >= prevInputTokens || !prev.tokenUsage) {
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
              }
              // Keep existing token usage if new value is lower
              return {}
            })
          }
          break
      }
    },
    [flushGoalSubturnComplete, getOrCreateLiveStreamAccumulator, refreshGoalUi, updateThreadState]
  )

  const getThreadActions = useCallback(
    (threadId: string): ThreadActions => {
      if (actionsCache.current[threadId]) {
        return actionsCache.current[threadId]
      }

      const actions: ThreadActions = {
        appendMessage: (message: Message) => {
          // Clear hook logs (external store) at the start of each new user turn
          if (message.role === "user") {
            hookLogsRef.current[threadId] = []
            notifyHookLogSubscribers(threadId)
          }
          updateThreadState(threadId, (state) => {
            const exists = state.messages.some((m) => m.id === message.id)
            if (exists) {
              return {
                messages: state.messages.map((m) => (m.id === message.id ? message : m)),
                hookInterruption: message.role === "user" ? null : state.hookInterruption
              }
            }
            return {
              messages: [...state.messages, message],
              hookInterruption: message.role === "user" ? null : state.hookInterruption
            }
          })
        },
        setMessages: (messages: Message[]) => {
          updateThreadState(threadId, () => ({ messages }))
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
          updateThreadState(threadId, () => ({ workspacePath: path }))
        },
        setSubagents: (subagents: Subagent[]) => {
          updateThreadState(threadId, () => ({ subagents }))
        },
        setPendingApproval: (request: HITLRequest | null) => {
          updateThreadState(threadId, () => ({ pendingApproval: request }))
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
    [notifyHookLogSubscribers, refreshGoalUi, updateThreadState]
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
          if (metadata.workspacePath) {
            actions.setWorkspacePath(metadata.workspacePath as string)
            const diskResult = await window.api.workspace.loadFromDisk(threadId)
            if (diskResult.success) {
              actions.setWorkspaceFiles(diskResult.files)
            }
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
                  kwargs?: {
                    id?: string
                    content?: string | unknown[]
                    tool_calls?: unknown[]
                    tool_call_id?: string
                    name?: string
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
            rawRestoredMessages = channelValues.messages.map((msg, index) => {
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
              if (typeof msg.content === "string") content = msg.content
              else if (Array.isArray(msg.content)) content = msg.content as Message["content"]
              else if (typeof msg.kwargs?.content === "string") content = msg.kwargs.content
              else if (Array.isArray(msg.kwargs?.content))
                content = msg.kwargs.content as Message["content"]

              const messageId =
                typeof msg.id === "string" ? msg.id : msg.kwargs?.id || `msg-${index}`
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
                tool_calls: (msg.tool_calls ?? msg.kwargs?.tool_calls) as Message["tool_calls"],
                ...(role === "tool" &&
                  (msg.tool_call_id || msg.kwargs?.tool_call_id) && {
                    tool_call_id: msg.tool_call_id || msg.kwargs?.tool_call_id
                  }),
                ...(role === "tool" &&
                  (msg.name || msg.kwargs?.name) && { name: msg.name || msg.kwargs?.name }),
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
      seedLiveStreamBaselineFromCheckpoint,
      updateThreadState
    ]
  )

  // Track passive scheduler/heartbeat stream listeners per thread
  const schedulerListenerCleanups = useRef<Record<string, () => void>>({})
  const heartbeatListenerCleanups = useRef<Record<string, () => void>>({})
  // Track approval listeners per thread (registered globally, not per-component)
  const approvalListenerCleanups = useRef<Record<string, Array<() => void>>>({})

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

      // "started" fires before agent runtime creation — show loading immediately
      if (event.type === "started") {
        hookLogsRef.current[threadId] = []
        notifyHookLogSubscribers(threadId)
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
          }>
          updateThreadState(threadId, () => ({
            messages: msgs.map((m) => {
              const now = new Date()
              return { ...m, created_at: now, start_at: now, end_at: now } as Message
            })
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
            const idx = prev.messages.findIndex((m) => m.id === id)
            // Defensive clear: any real assistant token means data is flowing
            // again, so a stale retry indicator must disappear.
            const clearRetry = prev.modelRetry ? { modelRetry: null } : {}
            if (idx >= 0) {
              const updated = [...prev.messages]
              updated[idx] = {
                ...updated[idx],
                content: finalContent,
                ...(toolCalls?.length && { tool_calls: toolCalls }),
                end_at: new Date()
              }
              return { ...clearRetry, messages: updated }
            }
            const now = new Date()
            return {
              ...clearRetry,
              messages: [
                ...prev.messages,
                {
                  id,
                  role: "assistant" as const,
                  content: finalContent,
                  ...(toolCalls?.length && { tool_calls: toolCalls }),
                  created_at: now,
                  start_at: now,
                  end_at: now
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
          const now = new Date()
          updateThreadState(threadId, (prev) => {
            if (prev.messages.some((m) => m.id === id)) return {}
            return {
              messages: [
                ...prev.messages,
                {
                  id,
                  role: "tool" as const,
                  content,
                  tool_call_id: toolCallId,
                  name,
                  created_at: now,
                  start_at: now,
                  end_at: now
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

      // Register global approval listeners for this thread (not tied to ChatContainer mount)
      const cleanupApproval = window.api.sandbox.onApprovalRequest(threadId, (request: unknown) => {
        console.log(`[ThreadProvider] Approval request for thread ${threadId}:`, request)
        const req = request as Record<string, unknown>
        updateThreadState(threadId, () => ({
          pendingApproval: {
            id: (req.id as string) || "",
            tool_call: (req.tool_call as {
              id: string
              name: string
              args: Record<string, unknown>
            }) || { id: "", name: "execute", args: {} },
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
          } as unknown as HITLRequest
        }))
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
        updateThreadState(threadId, () => ({ pendingApproval: null }))
      })
      approvalListenerCleanups.current[threadId] = [cleanupApproval, cleanupTimeout]
    },
    [loadThreadHistory, processSchedulerEvent, updateThreadState]
  )

  const cleanupThread = useCallback((threadId: string) => {
    schedulerListenerCleanups.current[threadId]?.()
    delete schedulerListenerCleanups.current[threadId]
    heartbeatListenerCleanups.current[threadId]?.()
    delete heartbeatListenerCleanups.current[threadId]
    approvalListenerCleanups.current[threadId]?.forEach((c) => c())
    delete approvalListenerCleanups.current[threadId]
    delete schedulerStreamingRef.current[threadId]

    initializedThreadsRef.current.delete(threadId)
    delete actionsCache.current[threadId]
    delete streamDataRef.current[threadId]
    delete streamSubscribersRef.current[threadId]
    delete liveStreamAccumulatorsRef.current[threadId]
    delete checkpointFallbackIndexBaselinesRef.current[threadId]
    disableChatReportUploadForThread(threadId)
    delete hookLogsRef.current[threadId]
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
      getHookLogs,
      getAllThreadStates,
      getAllStreamLoadingStates,
      subscribeToAllStreams
    }),
    [
      getThreadState,
      getThreadActions,
      initializeThread,
      cleanupThread,
      subscribeToStream,
      getStreamData,
      subscribeToHookLogs,
      getHookLogs,
      getAllThreadStates,
      getAllStreamLoadingStates,
      subscribeToAllStreams
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
  return context.getAllStreamLoadingStates()
}
