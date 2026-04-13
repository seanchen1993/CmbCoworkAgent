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
import { ElectronIPCTransport } from "./electron-transport"
import type { Message, Todo, FileInfo, Subagent, HITLRequest } from "@/types"
import { useAppStore } from "@/lib/store"
import type { DeepAgent } from "../../../main/agent/types"

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

// Per-thread state (persisted/restored from checkpoints)
export interface ThreadState {
  messages: Message[]
  todos: Todo[]
  workspaceFiles: FileInfo[]
  workspacePath: string | null
  subagents: Subagent[]
  pendingApproval: HITLRequest | null
  error: string | null
  currentModel: string
  openFiles: OpenFile[]
  activeTab: "agent" | string
  fileContents: Record<string, string>
  tokenUsage: TokenUsage | null
  draftInput: string
  scheduledTaskLoading: boolean
  scheduledTaskId: string | null
  routingResult: RoutingResultState | null
  modelRetry: ModelRetryState | null
}

// Stream instance type
type StreamInstance = ReturnType<typeof useStream<DeepAgent>>

// Stream data that we want to be reactive
interface StreamData {
  messages: StreamInstance["messages"]
  isLoading: boolean
  stream: StreamInstance | null
}

// Actions available on a thread
export interface ThreadActions {
  appendMessage: (message: Message) => void
  setMessages: (messages: Message[]) => void
  setTodos: (todos: Todo[]) => void
  setWorkspaceFiles: (files: FileInfo[] | ((prev: FileInfo[]) => FileInfo[])) => void
  setWorkspacePath: (path: string | null) => void
  setSubagents: (subagents: Subagent[]) => void
  setPendingApproval: (request: HITLRequest | null) => void
  setError: (error: string | null) => void
  clearError: () => void
  setCurrentModel: (modelId: string) => void
  openFile: (path: string, name: string) => void
  closeFile: (path: string) => void
  setActiveTab: (tab: "agent" | string) => void
  setFileContents: (path: string, content: string) => void
  setDraftInput: (input: string) => void
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
  todos: [],
  workspaceFiles: [],
  workspacePath: null,
  subagents: [],
  pendingApproval: null,
  error: null,
  currentModel: "",
  openFiles: [],
  activeTab: "agent",
  fileContents: {},
  tokenUsage: null,
  draftInput: "",
  scheduledTaskLoading: false,
  scheduledTaskId: null,
  routingResult: null,
  modelRetry: null
})

const defaultStreamData: StreamData = {
  messages: [],
  isLoading: false,
  stream: null
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
  delayMs?: number
}

// Component that holds a stream and notifies subscribers
function ThreadStreamHolder({
  threadId,
  onStreamUpdate,
  onCustomEvent,
  onError
}: {
  threadId: string
  onStreamUpdate: (data: StreamData) => void
  onCustomEvent: (data: CustomEventData) => void
  onError: (error: Error) => void
}): null {
  const transport = useMemo(() => new ElectronIPCTransport(), [])

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
        isLoading: stream.isLoading,
        stream
      })
    }
  })

  // Also sync immediately when stream instance changes
  useEffect(() => {
    onStreamUpdateRef.current({
      messages: stream.messages,
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

  // Stream data store (not React state - we use subscriptions)
  const streamDataRef = useRef<Record<string, StreamData>>({})
  const streamSubscribersRef = useRef<Record<string, Set<() => void>>>({})

  // Notify subscribers for a thread
  const notifyStreamSubscribers = useCallback((threadId: string) => {
    const subscribers = streamSubscribersRef.current[threadId]
    if (subscribers) {
      subscribers.forEach((callback) => callback())
    }
  }, [])

  // Handle stream updates from ThreadStreamHolder
  const handleStreamUpdate = useCallback(
    (threadId: string, data: StreamData) => {
      streamDataRef.current[threadId] = data
      notifyStreamSubscribers(threadId)
      // Update loading states for kanban view
      setLoadingStates((prev) => {
        if (prev[threadId] === data.isLoading) return prev
        return { ...prev, [threadId]: data.isLoading }
      })
      // Defensive clear: drop the retry indicator when the stream stops for
      // ANY reason (success / error / user cancel) — last-line-of-defense.
      // Also clear when the stream is still active (isLoading=true) — this
      // means the retry succeeded and data is flowing again.
      setThreadStates((prev) => {
        const cur = prev[threadId]
        if (!cur || !cur.modelRetry) return prev
        return { ...prev, [threadId]: { ...cur, modelRetry: null } }
      })
    },
    [notifyStreamSubscribers]
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
      const state = threadStates[threadId] || createDefaultThreadState()
      if (state.pendingApproval) {
        console.log(
          "[ThreadContext] getThreadState returning pendingApproval for:",
          threadId,
          state.pendingApproval
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

  const subscribeToAllStreams = useCallback(() => {
    return () => {}
  }, [])

  const updateThreadState = useCallback(
    (threadId: string, updater: (prev: ThreadState) => Partial<ThreadState>) => {
      setThreadStates((prev) => {
        const currentState = prev[threadId] || createDefaultThreadState()
        const updates = updater(currentState)
        return {
          ...prev,
          [threadId]: { ...currentState, ...updates }
        }
      })
    },
    []
  )

  // Parse error messages into user-friendly format
  const parseErrorMessage = useCallback((error: Error | string): string => {
    const raw = typeof error === "string" ? error : error.message

    // Strip LangChain troubleshooting URL suffix (appended by @langchain/openai on 4xx errors)
    const errorMessage = raw.replace(/\n\nTroubleshooting URL: https:\/\/docs\.langchain\.com\S*/g, "").trim()

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
    if (lcCode === "MODEL_NOT_FOUND" || (/\b404\b/.test(errorMessage) && /model|not.found|does.not.exist/i.test(errorMessage))) {
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
            updateThreadState(threadId, () => ({ pendingApproval: data.request }))
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
        // No `model_retry_clear` case: clearing is handled uniformly by
        // (1) message-delta defensive clear (mid-stream resumption),
        // (2) handleStreamUpdate isLoading=false (any stream end),
        // (3) handleError (explicit error path).
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
    [updateThreadState]
  )

  const getThreadActions = useCallback(
    (threadId: string): ThreadActions => {
      if (actionsCache.current[threadId]) {
        return actionsCache.current[threadId]
      }

      const actions: ThreadActions = {
        appendMessage: (message: Message) => {
          updateThreadState(threadId, (state) => {
            const exists = state.messages.some((m) => m.id === message.id)
            if (exists) {
              return { messages: state.messages.map((m) => (m.id === message.id ? message : m)) }
            }
            return { messages: [...state.messages, message] }
          })
        },
        setMessages: (messages: Message[]) => {
          updateThreadState(threadId, () => ({ messages }))
        },
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
        }
      }

      actionsCache.current[threadId] = actions
      return actions
    },
    [updateThreadState]
  )

  const loadThreadHistory = useCallback(
    async (threadId: string) => {
      const actions = getThreadActions(threadId)

      // Load workspace path and thread metadata
      try {
        const thread = await window.api.threads.get(threadId)
        if (thread) {
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
          const effectiveModel = routingState?.lastResolvedModelId || (metadata.model as string) || ""
          if (effectiveModel) {
            updateThreadState(threadId, () => ({
              currentModel: effectiveModel,
              ...(routingState?.lastResolvedModelId
                ? {
                    routingResult: {
                      resolvedModelId: routingState.lastResolvedModelId!,
                      resolvedTier: (routingState.lastResolvedTier as "premium" | "economy") ?? "premium",
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

      // Load thread history from checkpoints
      try {
        const history = await window.api.threads.getHistory(threadId)
        if (history.length > 0) {
          const latestCheckpoint = history[0] as {
            checkpoint?: {
              channel_values?: {
                messages?: Array<{
                  id?: string
                  _getType?: () => string
                  type?: string
                  content?: string | unknown[]
                  tool_calls?: unknown[]
                  tool_call_id?: string
                  name?: string
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
            const messages: Message[] = channelValues.messages.map((msg, index) => {
              let role: "user" | "assistant" | "system" | "tool" = "assistant"
              if (typeof msg._getType === "function") {
                const type = msg._getType()
                if (type === "human") role = "user"
                else if (type === "ai") role = "assistant"
                else if (type === "system") role = "system"
                else if (type === "tool") role = "tool"
              } else if (msg.type) {
                if (msg.type === "human") role = "user"
                else if (msg.type === "ai") role = "assistant"
                else if (msg.type === "system") role = "system"
                else if (msg.type === "tool") role = "tool"
              }

              let content: Message["content"] = ""
              if (typeof msg.content === "string") content = msg.content
              else if (Array.isArray(msg.content)) content = msg.content as Message["content"]

              return {
                id: msg.id || `msg-${index}`,
                role,
                content,
                tool_calls: msg.tool_calls as Message["tool_calls"],
                ...(role === "tool" && msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
                ...(role === "tool" && msg.name && { name: msg.name }),
                created_at: new Date()
              }
            })
            actions.setMessages(messages)
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
          const interruptData = channelValues?.__interrupt__
          if (interruptData && Array.isArray(interruptData) && interruptData.length > 0) {
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
                allowed_decisions: ["approve", "reject", "edit"]
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
                allowed_decisions: ["approve", "reject", "edit"]
              }
              actions.setPendingApproval(hitlRequest)
            }
          }
        }
      } catch (error) {
        console.error("[ThreadContext] Failed to load thread history:", error)
      }
    },
    [getThreadActions, updateThreadState]
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
            messages: msgs.map((m) => ({ ...m, created_at: new Date() }) as Message)
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
                ...(toolCalls?.length && { tool_calls: toolCalls })
              }
              return { ...clearRetry, messages: updated }
            }
            return {
              ...clearRetry,
              messages: [
                ...prev.messages,
                {
                  id,
                  role: "assistant" as const,
                  content: finalContent,
                  ...(toolCalls?.length && { tool_calls: toolCalls }),
                  created_at: new Date()
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
                  created_at: new Date()
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
        return { ...prev, [threadId]: createDefaultThreadState() }
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
            tool_call: (req.tool_call as { id: string; name: string; args: Record<string, unknown> }) || { id: "", name: "execute", args: {} },
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
          } as any
        }))
        // Auto-switch to this thread so the approval UI is visible
        const currentId = useAppStore.getState().currentThreadId
        if (currentId !== threadId) {
          console.log(`[ThreadProvider] Auto-switching to thread ${threadId} for pending approval`)
          useAppStore.getState().selectThread(threadId)
        }
      })
      const cleanupTimeout = window.api.sandbox.onApprovalTimeout(threadId, (data) => {
        console.warn(`[ThreadProvider] Approval timed out for thread ${threadId}: requestId=${data.requestId}`)
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
    setActiveThreadIds((prev) => {
      const next = new Set(prev)
      next.delete(threadId)
      return next
    })
    setThreadStates((prev) => {
      const { [threadId]: _removed, ...rest } = prev
      void _removed // Explicitly mark as intentionally unused
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
