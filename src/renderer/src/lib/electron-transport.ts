import type { UseStreamTransport } from "@langchain/langgraph-sdk/react"
import type { ToolCall, ToolCallChunk } from "@langchain/core/messages"
import type { StreamPayload, StreamEvent, IPCEvent, IPCStreamEvent } from "../../../types"
import type { Message, Subagent } from "../types"
import { COORDINATOR_NOTIFICATION_PROMPT } from "./message-display-helpers"
import { useAppStore } from "./store"
import {
  isCoordinatorWorkerToolName,
  normalizeCoordinatorWorkerToolArgsForDisplay
} from "./coordinator-worker-tool-args"
import {
  buildCurrentTurnMessageFallbackId,
  buildStableValuesMessageId,
  buildToolMessageFallbackId
} from "./stream-message-ids"
import { isInternalGoalPromptMessage } from "./goal-notice-messages"

export type StreamFallbackIndexBaselines = {
  ai: number
  tool: number
  system: number
  human: number
}

/**
 * Usage metadata from LangChain model responses.
 * Contains token counts for tracking context window usage.
 */
interface UsageMetadata {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_token_details?: {
    cache_read?: number
    cache_creation?: number
    audio?: number
  }
  output_token_details?: {
    audio?: number
    reasoning?: number
  }
}

function getUsageMetadata(kwargs?: SerializedMessageChunk["kwargs"]): UsageMetadata | undefined {
  if (!kwargs) return undefined
  return (
    kwargs.usage_metadata ||
    kwargs.response_metadata?.token_usage ||
    kwargs.response_metadata?.usage
  )
}

function createTokenUsageEvent(usageMetadata: UsageMetadata): StreamEvent | null {
  if (usageMetadata.input_tokens === undefined || usageMetadata.input_tokens <= 0) {
    return null
  }

  return {
    event: "custom",
    data: {
      type: "token_usage",
      usage: {
        inputTokens: usageMetadata.input_tokens,
        outputTokens: usageMetadata.output_tokens,
        totalTokens: usageMetadata.total_tokens,
        cacheReadTokens: usageMetadata.input_token_details?.cache_read,
        cacheCreationTokens: usageMetadata.input_token_details?.cache_creation
      }
    }
  }
}

/**
 * Serialized LangGraph message chunk.
 * LangChain uses a special serialization format:
 * { lc: 1, type: "constructor", id: ["langchain_core", "messages", "AIMessageChunk"], kwargs: { ... } }
 */
export interface SerializedMessageChunk {
  /** LangChain serialization marker */
  lc?: number
  type?: string
  /** Class identifier array like ['langchain_core', 'messages', 'AIMessageChunk'] */
  id?: string[]
  /** Actual message data is in kwargs */
  kwargs?: {
    id?: string
    type?: string
    content?: string | Array<{ type: string; text?: string }>
    tool_calls?: ToolCall[]
    tool_call_chunks?: ToolCallChunk[]
    tool_call_id?: string
    name?: string
    status?: string
    is_error?: boolean
    additional_kwargs?: {
      is_error?: boolean
      [key: string]: unknown
    }
    usage_metadata?: UsageMetadata
    response_metadata?: {
      token_usage?: UsageMetadata
      usage?: UsageMetadata
      [key: string]: unknown
    }
  }
}

export type TransformedValuesMessage = {
  id: string
  type: "ai" | "tool" | "system" | "human"
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

type MainAssistantSnapshotUpdate =
  | { kind: "skip" }
  | { kind: "delta"; content: string }
  | { kind: "replace"; content: string }

/**
 * Metadata accompanying streamed messages from LangGraph.
 * These fields are not exported from the SDK as they are internal runtime metadata.
 */
interface MessageMetadata {
  langgraph_node?: string
  langgraph_checkpoint_ns?: string
  checkpoint_ns?: string
  name?: string
}

function getSerializedMessageClassName(msg: SerializedMessageChunk): string {
  const classId = Array.isArray(msg.id) ? msg.id : []
  return classId[classId.length - 1] || ""
}

function extractSerializedContent(
  content: string | Array<{ type: string; text?: string }> | undefined
): string {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
  }
  return ""
}

export function transformSerializedValuesMessages(
  messages: SerializedMessageChunk[] | undefined
): TransformedValuesMessage[] {
  const transformed: TransformedValuesMessage[] = []
  const fallbackIndexes: Record<"ai" | "tool" | "system" | "human", number> = {
    ai: 0,
    tool: 0,
    system: 0,
    human: 0
  }

  for (const msg of messages ?? []) {
    const className = getSerializedMessageClassName(msg)
    if (className.includes("Human")) {
      // Local user bubbles are appended before stream submit. Internal goal
      // prompts are hidden, but still need timing for transcript restore anchors.
      if (
        !isInternalGoalPromptMessage({
          role: "user",
          content: extractSerializedContent(msg.kwargs?.content)
        })
      ) {
        continue
      }
    }

    const kwargs = msg.kwargs || {}
    const type: "ai" | "tool" | "system" | "human" = className.includes("Tool")
      ? "tool"
      : className.includes("System")
        ? "system"
        : className.includes("Human")
          ? "human"
          : "ai"
    const content = extractSerializedContent(kwargs.content)
    const fallbackIndex = fallbackIndexes[type]++
    const id =
      kwargs.id ||
      (type === "tool" && kwargs.tool_call_id
        ? buildToolMessageFallbackId(kwargs.tool_call_id, kwargs.name)
        : buildStableValuesMessageId({
            index: fallbackIndex,
            type,
            className,
            content,
            toolCallId: kwargs.tool_call_id,
            name: kwargs.name,
            toolCalls: kwargs.tool_calls
          }))

    transformed.push({
      id,
      type,
      content,
      ...(type === "ai" && kwargs.tool_calls && { tool_calls: kwargs.tool_calls }),
      ...(type === "tool" && kwargs.tool_call_id && { tool_call_id: kwargs.tool_call_id }),
      ...(type === "tool" && kwargs.name && { name: kwargs.name })
    })
  }

  return transformed
}

// Accumulated tool call data (for streaming tool calls)
interface AccumulatedToolCall {
  id: string
  name: string
  args: string // Accumulated JSON string
}

// Completed tool call with parsed args
interface CompletedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

const QUIET_COORDINATOR_TOOL_NAMES = new Set(["read_worker_state"])
const WORKER_SNAPSHOT_INDEX_MESSAGE_KEY = "cmb_worker_snapshot_index"
const MAX_TRACKED_EMITTED_MESSAGES = 2_000
const MAX_TRACKED_TOOL_CALLS = 2_000
const MAX_TRACKED_TOOL_CALL_NAMES = 300
const MAX_TRACKED_TOOL_CALLS_PER_NAME = 50
const MAX_TRACKED_MESSAGE_TOOL_CALLS = 1_000

function pruneMapToLimit<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

function pruneSetToLimit<T>(set: Set<T>, limit: number): void {
  while (set.size > limit) {
    const oldest = set.values().next()
    if (oldest.done) return
    set.delete(oldest.value)
  }
}

function keepRecentItems<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(-limit) : items
}

function createWorkerSnapshotFallbackMessageId(index: number): string {
  return `worker-snapshot-${index}`
}

function getWorkerSnapshotFallbackIndex(
  message: SerializedMessageChunk,
  fallbackIndex: number
): number {
  const value = message.kwargs?.additional_kwargs?.[WORKER_SNAPSHOT_INDEX_MESSAGE_KEY]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallbackIndex
}

/**
 * Custom transport for useStream that uses Electron IPC instead of HTTP.
 * This allows useStream to work seamlessly in an Electron app where the
 * LangGraph agent runs in the main process.
 */
export class ElectronIPCTransport implements UseStreamTransport {
  // Track current message ID for grouping tokens across chunks
  private currentMessageId: string | null = null
  private currentMessageIndex: number | null = null
  private nextAssistantMessageIndex = 0
  private nextToolMessageIndex = 0
  private nextSystemMessageIndex = 0
  private fallbackIndexBaselines: StreamFallbackIndexBaselines = {
    ai: 0,
    tool: 0,
    system: 0,
    human: 0
  }

  private workerCurrentMessageIds: Map<string, string> = new Map()

  private workerAssistantTextByMessageId: Map<string, string> = new Map()

  private workerLiveMessageSequenceByThread: Map<string, number> = new Map()

  private workerCurrentTurnByThread: Map<string, number> = new Map()

  // Track active subagents by their tool_call_id
  private activeSubagents: Map<string, Subagent> = new Map()

  // Track subagent-internal tool calls as a single aggregate activity count.
  private subagentToolCallIds: Set<string> = new Set()

  private subagentToolLogEntryIds: Map<string, string> = new Map()

  private subagentToolCallCount = 0

  private subagentLogSequence = 0

  // Accumulates a subagent's streamed assistant (thinking) text per message id so
  // successive AIMessageChunk deltas coalesce into one growing log entry instead
  // of flooding the subagent log with per-token fragments.
  private subagentAssistantAccum: Map<string, string> = new Map()

  // Coordinator worker status checks are analogous to Claude Code TaskOutput:
  // useful as a fallback, but too noisy for the main chat transcript.
  private quietCoordinatorToolCallIds: Set<string> = new Set()

  // Values-mode snapshots contain full conversation history. Track message IDs
  // we have already surfaced so fallback extraction can stay incremental.
  private emittedMessageIds: Set<string> = new Set()

  // `useStream` treats repeated messages with the same ID as incremental text.
  // Values snapshots are full-state, so only forward the newly appended suffix.
  private mainAssistantTextByMessageId: Map<string, string> = new Map()

  // Track accumulated tool call chunks (for streaming tool calls)
  private accumulatedToolCalls: Map<string, AccumulatedToolCall> = new Map()

  private lastToolCallChunkArgsById: Map<string, string> = new Map()

  // Track completed tool calls by name for HITL matching
  private completedToolCallsByName: Map<string, CompletedToolCall[]> = new Map()

  // Streaming tool-call chunks can contain the real JSON args before the
  // message-level tool_calls array is fully hydrated. Keep the parsed result so
  // the chat card does not get stuck showing an early `{}` placeholder.
  private completedToolCallsByMessageId: Map<string, Map<string, CompletedToolCall>> = new Map()

  setFallbackIndexBaselines(baselines: StreamFallbackIndexBaselines): void {
    this.fallbackIndexBaselines = baselines
    this.applyFallbackIndexBaselines()
  }

  async stream(payload: StreamPayload): Promise<AsyncGenerator<StreamEvent>> {
    // Reset state for new stream
    this.currentMessageId = null
    this.currentMessageIndex = null
    this.applyFallbackIndexBaselines()
    this.workerCurrentMessageIds.clear()
    this.workerAssistantTextByMessageId.clear()
    this.workerLiveMessageSequenceByThread.clear()
    this.workerCurrentTurnByThread.clear()
    this.activeSubagents.clear()
    this.subagentToolCallIds.clear()
    this.subagentToolLogEntryIds.clear()
    this.subagentToolCallCount = 0
    this.subagentLogSequence = 0
    this.subagentAssistantAccum.clear()
    this.quietCoordinatorToolCallIds.clear()
    this.emittedMessageIds.clear()
    this.mainAssistantTextByMessageId.clear()
    this.accumulatedToolCalls.clear()
    this.lastToolCallChunkArgsById.clear()
    this.completedToolCallsByName.clear()
    this.completedToolCallsByMessageId.clear()
    const threadId = payload.config?.configurable?.thread_id
    const modelId = payload.config?.configurable?.model_id as string | undefined
    const agentMode = payload.config?.configurable?.agent_mode as
      | "normal"
      | "coordinator"
      | undefined
    const coordinatorInternalNotification =
      payload.config?.configurable?.coordinator_internal_notification === true
    const userMessageId = payload.config?.configurable?.hook_turn_id as string | undefined
    if (!threadId) {
      return this.createErrorGenerator("MISSING_THREAD_ID", "Thread ID is required")
    }

    // Check if this is a resume command (no message needed)
    const hasResumeCommand = payload.command?.resume !== undefined

    // Extract the message content from input
    const input = payload.input as
      | { messages?: Array<{ content: string; type: string }> }
      | null
      | undefined
    const messages = input?.messages ?? []
    const lastHumanMessage = messages.find((m) => m.type === "human")
    const messageContent = coordinatorInternalNotification
      ? COORDINATOR_NOTIFICATION_PROMPT
      : (lastHumanMessage?.content ?? "")

    // Only require message content if not resuming
    if (!messageContent && !hasResumeCommand) {
      return this.createErrorGenerator("MISSING_MESSAGE", "Message content is required")
    }

    // Create an async generator that bridges IPC events
    return this.createStreamGenerator(
      threadId,
      messageContent,
      payload.command,
      payload.signal,
      modelId,
      agentMode,
      coordinatorInternalNotification,
      userMessageId
    )
  }

  convertFocusedCoordinatorWorkerIPCEvent(
    event: IPCStreamEvent,
    parentThreadId: string
  ): Message[] {
    const focused = useAppStore.getState().workerFocusView
    if (!focused || focused.threadId !== parentThreadId) return []
    this.syncWorkerTurnBoundary(focused.workerThreadId, event.workerTurn)

    if (event.mode === "messages") {
      const [msgChunk, metadata] = event.data as [SerializedMessageChunk, MessageMetadata]
      const kwargs = msgChunk?.kwargs || {}
      const classId = Array.isArray(msgChunk?.id) ? msgChunk.id : []
      const className = classId[classId.length - 1] || ""

      return this.createFocusedCoordinatorWorkerEvents({
        parentThreadId,
        // The worker side-channel is already filtered by worker_thread_id in the
        // main process. Some providers do not include a worker checkpoint
        // namespace in this direct stream, so pass the focused worker id as the
        // routing namespace instead of dropping the event.
        checkpointNs: focused.workerThreadId,
        className,
        kwargs,
        metadata
      })
        .filter((sdkEvent) => sdkEvent.event === "custom")
        .map((sdkEvent) => sdkEvent.data as { type?: unknown; workerMessage?: unknown })
        .filter((data) => data.type === "coordinator_worker_stream_message")
        .map((data) => data.workerMessage)
        .filter((message): message is Message => Boolean(message && typeof message === "object"))
    }

    if (event.mode === "values") {
      const state = event.data as { messages?: SerializedMessageChunk[] }
      if (!Array.isArray(state.messages)) return []
      return this.createFocusedCoordinatorWorkerEventsFromValues(
        state.messages,
        focused.workerThreadId
      )
    }

    return this.processStreamEvent(event, "coordinator")
      .filter((sdkEvent) => sdkEvent.event === "custom")
      .map((sdkEvent) => sdkEvent.data as { type?: unknown; workerMessage?: unknown })
      .filter((data) => data.type === "coordinator_worker_stream_message")
      .map((data) => data.workerMessage)
      .filter((message): message is Message => Boolean(message && typeof message === "object"))
  }

  private async *createErrorGenerator(code: string, message: string): AsyncGenerator<StreamEvent> {
    yield {
      event: "error",
      data: { error: code, message }
    }
  }

  private async *createStreamGenerator(
    threadId: string,
    message: string,
    command: unknown,
    signal: AbortSignal,
    modelId?: string,
    agentMode?: "normal" | "coordinator",
    coordinatorInternalNotification = false,
    userMessageId?: string
  ): AsyncGenerator<StreamEvent> {
    // Create a queue to buffer events from IPC
    const eventQueue: StreamEvent[] = []
    let resolveNext: ((value: StreamEvent | null) => void) | null = null
    let isDone = false
    let hasError = false

    // Generate a run ID for this stream
    const runId = crypto.randomUUID()

    // Emit metadata event first to establish run context
    yield {
      event: "metadata",
      data: {
        run_id: runId,
        thread_id: threadId
      }
    }
    yield this.createSubagentLogResetEvent()
    yield this.createSubagentToolCountEvent()
    let currentAgentMode: "normal" | "coordinator" = agentMode ?? "normal"

    const cleanup = window.api.agent.streamAgent(
      threadId,
      message,
      command,
      (ipcEvent) => {
        if (
          ipcEvent.type === "custom" &&
          (ipcEvent.data as { type?: unknown; mode?: unknown } | undefined)?.type === "agent_mode"
        ) {
          const nextMode = (ipcEvent.data as { mode?: unknown }).mode
          if (nextMode === "normal" || nextMode === "coordinator") {
            currentAgentMode = nextMode
          }
        }
        // Convert IPC events to SDK format
        const sdkEvents = this.convertToSDKEvents(ipcEvent as IPCEvent, threadId, currentAgentMode)

        for (const sdkEvent of sdkEvents) {
          if (sdkEvent.event === "done" || sdkEvent.event === "error") {
            isDone = true
            hasError = sdkEvent.event === "error"
          }

          // If someone is waiting for the next event, resolve immediately
          if (resolveNext) {
            const resolve = resolveNext
            resolveNext = null
            resolve(sdkEvent)
          } else {
            // Otherwise queue the event
            eventQueue.push(sdkEvent)
          }
        }
      },
      modelId,
      agentMode,
      coordinatorInternalNotification,
      userMessageId
    )

    let cleanedUp = false
    const abortListener = (): void => {
      cleanupOnce()
      isDone = true
      if (resolveNext) {
        const resolve = resolveNext
        resolveNext = null
        resolve(null)
      }
    }
    const cleanupOnce = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      cleanup()
      signal.removeEventListener("abort", abortListener)
    }

    // Handle abort signal
    signal.addEventListener("abort", abortListener)

    try {
      // Yield events as they come in
      while (!isDone || eventQueue.length > 0) {
        // Check for queued events first
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          if (event.event === "done") {
            break
          }
          if (event.event !== "error" || hasError) {
            yield event
          }
          if (hasError) {
            break
          }
          continue
        }

        // Wait for the next event
        const event = await new Promise<StreamEvent | null>((resolve) => {
          resolveNext = resolve
        })

        if (event === null) {
          break
        }

        if (event.event === "done") {
          break
        }

        yield event

        if (event.event === "error") {
          break
        }
      }
    } finally {
      cleanupOnce()
    }
  }

  /**
   * Convert IPC events to LangGraph SDK format
   * Returns an array since a single IPC event may produce multiple SDK events
   */
  private convertToSDKEvents(
    event: IPCEvent,
    threadId: string,
    agentMode: "normal" | "coordinator" = "normal"
  ): StreamEvent[] {
    const events: StreamEvent[] = []

    switch (event.type) {
      // Raw stream events from LangGraph - parse and convert
      case "stream": {
        const streamEvents = this.processStreamEvent(event, agentMode)
        events.push(...streamEvents)
        break
      }

      // Legacy: Token streaming for real-time typing effect
      case "token":
        events.push({
          event: "messages",
          data: [
            { id: event.messageId, type: "ai", content: event.token },
            { langgraph_node: "agent" }
          ]
        })
        break

      // Legacy: Tool call chunks
      case "tool_call":
        events.push({
          event: "custom",
          data: {
            type: "tool_call",
            messageId: event.messageId,
            tool_calls: event.tool_calls
          }
        })
        break

      // Legacy: Full state values
      case "values": {
        const { todos, files, workspacePath, subagents, interrupt } = event.data

        // Only emit values event if todos is defined
        // Avoid emitting { todos: [] } when undefined, which would wipe out existing todos
        if (todos !== undefined) {
          events.push({
            event: "values",
            data: { todos }
          })
        }

        // Emit files/workspace
        if (files) {
          const filesList = Array.isArray(files)
            ? files
            : Object.entries(files).map(([path, data]) => ({
                path,
                is_dir: false,
                size:
                  typeof (data as { content?: string })?.content === "string"
                    ? (data as { content: string }).content.length
                    : undefined
              }))

          if (filesList.length) {
            events.push({
              event: "custom",
              data: { type: "workspace", files: filesList, path: workspacePath || "/" }
            })
          }
        }

        // Emit subagents
        if (subagents?.length) {
          events.push({
            event: "custom",
            data: { type: "subagents", subagents }
          })
        }

        // Emit interrupt - handle both legacy format and new langchain HITL format
        if (interrupt) {
          // Check if this is the new array format from langchain HITL
          if (Array.isArray(interrupt) && interrupt.length > 0) {
            const interruptValue = interrupt[0]?.value
            const actionRequests = interruptValue?.actionRequests
            const reviewConfigs = interruptValue?.reviewConfigs

            if (actionRequests?.length) {
              const firstAction = actionRequests[0]
              const reviewConfig = reviewConfigs?.find(
                (rc: { actionName: string }) => rc.actionName === firstAction.name
              )

              events.push({
                event: "custom",
                data: {
                  type: "interrupt",
                  request: {
                    id: firstAction.id || crypto.randomUUID(),
                    tool_call: {
                      id: firstAction.id,
                      name: firstAction.name,
                      args: firstAction.args || {}
                    },
                    allowed_decisions: reviewConfig?.allowedDecisions || [
                      "approve",
                      "reject",
                      "edit"
                    ],
                    allowRuntimeRestoredCheckpointResume: true
                  }
                }
              })
            }
          } else if (interrupt.tool_call) {
            // Legacy format with direct tool_call property
            events.push({
              event: "custom",
              data: {
                type: "interrupt",
                request: {
                  id: interrupt.id || crypto.randomUUID(),
                  tool_call: interrupt.tool_call,
                  allowed_decisions: ["approve", "reject", "edit"],
                  allowRuntimeRestoredCheckpointResume: true
                }
              }
            })
          }
        }
        break
      }

      // Custom events (e.g. routing_result) sent directly from main process
      case "custom": {
        const data = event.data
        if (data?.type === "goal_subturn_complete" && Array.isArray(data.messages)) {
          this.resetCurrentAssistantMessage()
          const messages = transformSerializedValuesMessages(
            data.messages as SerializedMessageChunk[]
          )
          this.advanceFallbackIndexesFromValuesMessages(messages)
          events.push({
            event: "custom",
            data: {
              ...data,
              messages
            }
          })
          break
        }
        events.push({
          event: "custom",
          data
        })
        break
      }

      case "error":
        events.push({
          event: "error",
          data: { error: event.error || "STREAM_ERROR", message: event.message ?? event.error }
        })
        break

      case "done":
        events.push({
          event: "done",
          data: { thread_id: threadId }
        })
        break
    }

    return events
  }

  private createFocusedCoordinatorWorkerEventsFromValues(
    messages: SerializedMessageChunk[],
    workerThreadId: string
  ): Message[] {
    const converted: Message[] = []
    let latestAiIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (this.isSerializedAIMessage(messages[index])) {
        latestAiIndex = index
        break
      }
    }
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const kwargs = message.kwargs || {}
      const className = this.getSerializedMessageClassName(message)
      const additionalKwargs = kwargs.additional_kwargs
      if (additionalKwargs?.cmb_internal_coordinator_notification === true) continue
      if (className.includes("System") || kwargs.type === "system") continue

      const content = this.extractContent(kwargs.content)
      const toolCalls = this.isSerializedAIMessage(message)
        ? this.hydrateToolCallsWithAccumulatedArgs(kwargs.tool_calls ?? [])
        : []
      const snapshotIndex = getWorkerSnapshotFallbackIndex(message, index)
      const snapshotFallbackId = createWorkerSnapshotFallbackMessageId(snapshotIndex)
      const providerMessageId =
        typeof kwargs.id === "string"
          ? this.createFocusedWorkerTurnScopedMessageId(workerThreadId, kwargs.id)
          : undefined
      const liveAssistantId =
        this.isSerializedAIMessage(message) && index === latestAiIndex
          ? this.workerCurrentMessageIds.get(workerThreadId)
          : undefined
      const rawId = providerMessageId || liveAssistantId || snapshotFallbackId
      if (this.isSerializedHumanMessage(message)) {
        converted.push({
          id: rawId,
          role: "user",
          content,
          created_at: new Date()
        })
        continue
      }

      if (this.isSerializedAIMessage(message)) {
        converted.push({
          id: rawId,
          role: "assistant",
          content,
          ...(toolCalls.length && { tool_calls: toolCalls as Message["tool_calls"] }),
          created_at: new Date()
        })
        continue
      }

      if (this.isSerializedToolMessage(message) && kwargs.tool_call_id) {
        const isError = this.isToolMessageError(kwargs)
        converted.push({
          id: rawId,
          role: "tool",
          content: this.extractContent(kwargs.content),
          tool_call_id: kwargs.tool_call_id,
          ...(kwargs.name && { name: kwargs.name }),
          ...(kwargs.status && { status: kwargs.status }),
          ...(isError && { is_error: true }),
          created_at: new Date()
        })
      }
    }
    return converted
  }

  private nextMessageFallbackIndex(type: "ai" | "tool" | "system"): number {
    if (type === "tool") {
      const index = this.nextToolMessageIndex
      this.nextToolMessageIndex += 1
      return index
    }
    if (type === "system") {
      const index = this.nextSystemMessageIndex
      this.nextSystemMessageIndex += 1
      return index
    }
    const index = this.nextAssistantMessageIndex
    this.nextAssistantMessageIndex += 1
    return index
  }

  private applyFallbackIndexBaselines(): void {
    this.nextAssistantMessageIndex = Math.max(
      this.nextAssistantMessageIndex,
      this.fallbackIndexBaselines.ai
    )
    this.nextToolMessageIndex = Math.max(
      this.nextToolMessageIndex,
      this.fallbackIndexBaselines.tool
    )
    this.nextSystemMessageIndex = Math.max(
      this.nextSystemMessageIndex,
      this.fallbackIndexBaselines.system
    )
  }

  private advanceFallbackIndexesFromValuesMessages(messages: TransformedValuesMessage[]): void {
    let aiCount = 0
    let toolCount = 0
    let systemCount = 0

    for (const message of messages) {
      if (message.type === "ai") aiCount += 1
      else if (message.type === "tool") toolCount += 1
      else if (message.type === "system") systemCount += 1
    }

    this.nextAssistantMessageIndex = Math.max(this.nextAssistantMessageIndex, aiCount)
    this.nextToolMessageIndex = Math.max(this.nextToolMessageIndex, toolCount)
    this.nextSystemMessageIndex = Math.max(this.nextSystemMessageIndex, systemCount)
  }

  private resetCurrentAssistantMessage(): void {
    this.currentMessageId = null
    this.currentMessageIndex = null
  }

  /**
   * Process raw LangGraph stream events (mode + data tuples)
   */
  private processStreamEvent(
    event: IPCStreamEvent,
    agentMode: "normal" | "coordinator"
  ): StreamEvent[] {
    const events: StreamEvent[] = []
    const { mode, data } = event
    const isCoordinatorMode = agentMode === "coordinator"

    if (mode === "messages") {
      // Messages mode returns [message, metadata] tuples
      const [msgChunk, metadata] = data as [SerializedMessageChunk, MessageMetadata]

      // LangChain serialization: actual data is in kwargs
      const kwargs = msgChunk?.kwargs || {}
      const classId = Array.isArray(msgChunk?.id) ? msgChunk.id : []
      const className = classId[classId.length - 1] || ""

      // Detect if this message comes from a subagent via checkpoint namespace
      const checkpointNs = metadata?.langgraph_checkpoint_ns || metadata?.checkpoint_ns
      if (isCoordinatorMode && this.isCoordinatorWorkerNamespace(checkpointNs)) {
        // Async coordinator workers must not become main coordinator messages.
        // The focused worker panel receives these through the dedicated
        // coordinator-worker side channel, so the main stream transport should
        // not parse or cache worker content.
        return events
      }
      // Check if this is a ToolMessage (class name contains 'ToolMessage')
      const isToolMessage = className.includes("ToolMessage") && !!kwargs.tool_call_id
      const isSystemMessage = className.includes("SystemMessage")

      // Check if this is an AI message (class name contains 'AI')
      const isAIMessage = className.includes("AI") || className.includes("AIMessageChunk")

      const isTaskResultMessage =
        isToolMessage &&
        kwargs.name === "task" &&
        !!kwargs.tool_call_id &&
        this.activeSubagents.has(kwargs.tool_call_id)
      const isKnownSubagentToolCall =
        isToolMessage &&
        !!kwargs.tool_call_id &&
        this.subagentToolLogEntryIds.has(kwargs.tool_call_id)
      const isFromSubagent =
        !isTaskResultMessage &&
        this.isSubagentNamespace(checkpointNs) &&
        (this.hasRunningSubagent() || isKnownSubagentToolCall)

      if (isAIMessage) {
        if (isFromSubagent) {
          // Subagent internals stay out of the main conversation, but we surface
          // them in the subagent activity log: aggregate tool count, tool-call
          // titles, and (Phase 2, A1') the subagent's streamed thinking text.
          events.push(...this.processSubagentToolCalls(kwargs.tool_calls, kwargs.tool_call_chunks))
          events.push(
            ...this.createSubagentAssistantLogEvents(
              checkpointNs,
              kwargs.tool_calls,
              kwargs.tool_call_chunks
            )
          )

          // Surface the subagent's streamed assistant (thinking) text. Accumulate
          // the RAW content (do not trim per chunk, or inter-chunk spaces/newlines
          // would be lost and words/paragraphs would run together); coalesce
          // delta/cumulative chunks per message id into one growing log entry.
          const thinkingChunk = this.extractContent(kwargs.content)
          const thinkingAccumKey = (kwargs.id as string) || checkpointNs || "subagent-thinking"
          const prevThinking = this.subagentAssistantAccum.get(thinkingAccumKey) ?? ""
          // Skip only LEADING whitespace-only chunks (before any content exists).
          // Once content exists, whitespace deltas separate words/paragraphs and
          // must be accumulated, otherwise "hello"+" "+"world" → "helloworld".
          if (thinkingChunk.length > 0 && (prevThinking !== "" || thinkingChunk.trim())) {
            let full =
              thinkingChunk.startsWith(prevThinking) && thinkingChunk.length >= prevThinking.length
                ? thinkingChunk
                : prevThinking + thinkingChunk
            // Bound stored thinking to keep memory in check; the displayed content
            // is truncated to the log limit anyway, so the head is what matters.
            if (full.length > 16000) full = full.slice(0, 16000)
            this.subagentAssistantAccum.set(thinkingAccumKey, full)
            // Only emit a UI event when there is visible (non-whitespace) content,
            // so pure-whitespace deltas accumulate without flooding the stream.
            if (full.trim()) {
              events.push(
                this.createSubagentLogEntryEvent({
                  kind: "assistant",
                  entryId: `subagent-assistant-${thinkingAccumKey}`,
                  title: "子代理思考",
                  content: this.truncateSubagentLogContent(full),
                  status: "completed",
                  checkpointNs,
                  subagentToolCallId: this.resolveSubagentToolCallId(checkpointNs)
                })
              )
            }
          }
        } else {
          // Main agent message
          const content = this.extractContent(kwargs.content)
          const messageIndex = this.currentMessageIndex ?? this.nextMessageFallbackIndex("ai")
          const msgId =
            kwargs.id ||
            this.currentMessageId ||
            buildStableValuesMessageId({
              index: messageIndex,
              type: "ai",
              className,
              content,
              toolCalls: kwargs.tool_calls
            })
          this.currentMessageId = msgId
          this.currentMessageIndex = messageIndex
          const visibleToolCalls = this.hydrateToolCallsWithAccumulatedArgs(
            this.filterVisibleMainToolCalls(kwargs.tool_calls, isCoordinatorMode)
          )
          const visibleToolCallChunks = this.filterVisibleMainToolCallChunks(
            kwargs.tool_call_chunks,
            isCoordinatorMode
          )
          const contentDelta = this.prepareMainAssistantChunkContent(msgId, content)

          if (contentDelta !== undefined || visibleToolCalls.length) {
            if (visibleToolCalls.length) {
              this.rememberCompletedToolCallsForMessage(msgId, visibleToolCalls)
            }
            this.rememberEmittedMessage(msgId)
            events.push({
              event: "messages",
              data: [
                {
                  id: msgId,
                  type: "ai",
                  content: contentDelta ?? "",
                  ...(visibleToolCalls.length && { tool_calls: visibleToolCalls })
                },
                {
                  langgraph_node: metadata?.langgraph_node || "agent",
                  langgraph_checkpoint_ns: metadata?.langgraph_checkpoint_ns,
                  checkpoint_ns: metadata?.checkpoint_ns
                }
              ]
            })
          }

          // Handle tool call chunks (streaming) - these have args as strings
          if (visibleToolCallChunks.length) {
            const subagentDetectEvents = this.processToolCallChunks(visibleToolCallChunks)
            events.push(...subagentDetectEvents)

            const completedChunkToolCalls =
              this.completedToolCallsFromAccumulatedChunks(visibleToolCallChunks)
            if (completedChunkToolCalls.length && this.currentMessageId) {
              this.rememberCompletedToolCallsForMessage(
                this.currentMessageId,
                completedChunkToolCalls
              )
              const completedToolCalls = this.getCompletedToolCallsForMessage(this.currentMessageId)
              events.push({
                event: "messages",
                data: [
                  {
                    id: this.currentMessageId,
                    type: "ai",
                    content: "",
                    tool_calls: completedToolCalls
                  },
                  {
                    langgraph_node: metadata?.langgraph_node || "agent",
                    langgraph_checkpoint_ns: metadata?.langgraph_checkpoint_ns,
                    checkpoint_ns: metadata?.checkpoint_ns
                  }
                ]
              })
            }

            events.push({
              event: "custom",
              data: {
                type: "tool_call",
                messageId: this.currentMessageId,
                tool_calls: visibleToolCallChunks
              }
            })
          }

          // Handle complete tool calls (non-streaming) - these have args as objects
          if (visibleToolCalls.length) {
            const subagentDetectEvents = this.processCompletedToolCalls(visibleToolCalls)
            events.push(...subagentDetectEvents)

            // Track tool calls for HITL matching
            for (const tc of visibleToolCalls) {
              if (tc.id && tc.name) {
                const existing = this.completedToolCallsByName.get(tc.name) || []
                existing.push({ id: tc.id, name: tc.name, args: tc.args || {} })
                this.completedToolCallsByName.set(
                  tc.name,
                  keepRecentItems(existing, MAX_TRACKED_TOOL_CALLS_PER_NAME)
                )
                pruneMapToLimit(this.completedToolCallsByName, MAX_TRACKED_TOOL_CALL_NAMES)
              }
            }
          }

          // Different providers serialize usage under either `usage_metadata`,
          // `response_metadata.token_usage`, or `response_metadata.usage`.
          const usageMetadata = getUsageMetadata(kwargs)
          if (usageMetadata) {
            console.log("[ElectronTransport] Found usage_metadata:", {
              input_tokens: usageMetadata.input_tokens,
              output_tokens: usageMetadata.output_tokens,
              total_tokens: usageMetadata.total_tokens,
              has_cache_details: !!usageMetadata.input_token_details
            })

            const tokenUsageEvent = createTokenUsageEvent(usageMetadata)
            if (tokenUsageEvent) events.push(tokenUsageEvent)
          }
        }
      }

      if (isSystemMessage && !isFromSubagent) {
        this.resetCurrentAssistantMessage()
        const content = this.extractContent(kwargs.content)
        const messageIndex = this.nextMessageFallbackIndex("system")
        const msgId =
          kwargs.id ||
          buildStableValuesMessageId({
            index: messageIndex,
            type: "system",
            className,
            content
          })

        events.push({
          event: "messages",
          data: [
            {
              id: msgId,
              type: "system",
              content
            },
            {
              langgraph_node: metadata?.langgraph_node || "agent",
              langgraph_checkpoint_ns: metadata?.langgraph_checkpoint_ns,
              checkpoint_ns: metadata?.checkpoint_ns
            }
          ]
        })
      }

      // Handle ToolMessage
      if (isToolMessage && kwargs.tool_call_id) {
        if (isCoordinatorMode && this.quietCoordinatorToolCallIds.has(kwargs.tool_call_id)) {
          return events
        }
        if (isFromSubagent) {
          const resultContent = this.truncateSubagentLogContent(this.extractContent(kwargs.content))
          events.push(
            this.createSubagentLogEntryEvent({
              kind: "tool_result",
              title: `工具返回：${kwargs.name || kwargs.tool_call_id}`,
              content: "",
              result: resultContent,
              status: "completed",
              checkpointNs,
              toolCallId: kwargs.tool_call_id,
              toolName: kwargs.name
            })
          )
        } else {
          // Main agent tool message
          this.resetCurrentAssistantMessage()
          const content = this.extractContent(kwargs.content)
          const msgId =
            kwargs.id ||
            this.createStableFallbackMessageId({
              type: "tool",
              content,
              toolCallId: kwargs.tool_call_id,
              toolName: kwargs.name
            })

          this.rememberEmittedMessage(msgId)
          events.push({
            event: "messages",
            data: [
              {
                id: msgId,
                type: "tool",
                content,
                tool_call_id: kwargs.tool_call_id,
                name: kwargs.name
              },
              {
                langgraph_node: metadata?.langgraph_node || "tools",
                langgraph_checkpoint_ns: metadata?.langgraph_checkpoint_ns,
                checkpoint_ns: metadata?.checkpoint_ns
              }
            ]
          })

          // Handle subagent task completion (task ToolMessage from main agent)
          if (kwargs.name === "task") {
            const completionEvents = this.processToolMessage(
              kwargs.tool_call_id,
              this.isToolMessageError(kwargs)
            )
            events.push(...completionEvents)
          }
        }
      }
    } else if (mode === "values") {
      // Values mode returns full state with serialized LangChain messages
      const state = data as {
        messages?: SerializedMessageChunk[]
        todos?: { id?: string; content?: string; status?: string }[]
        files?: Record<string, unknown> | Array<{ path: string; is_dir?: boolean; size?: number }>
        workspacePath?: string
        // __interrupt__ is an array of interrupt objects from langchain HITL middleware
        __interrupt__?: Array<{
          value?: {
            actionRequests?: Array<{ name: string; id: string; args: Record<string, unknown> }>
            reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>
          }
        }>
      }

      // Process messages in values mode to extract subagents
      if (state.messages) {
        for (const msg of state.messages) {
          const kwargs = msg.kwargs || {}
          const classId = Array.isArray(msg.id) ? msg.id : []
          const className = classId[classId.length - 1] || ""

          // Check for task tool calls in AI messages
          if (kwargs.tool_calls?.length) {
            const visibleToolCalls = this.filterVisibleMainToolCalls(
              kwargs.tool_calls,
              isCoordinatorMode
            )
            for (const toolCall of visibleToolCalls) {
              if (
                toolCall.name === "task" &&
                toolCall.id &&
                !this.activeSubagents.has(toolCall.id)
              ) {
                const args = toolCall.args || {}
                if (args.subagent_type || args.description) {
                  this.registerSubagent(toolCall.id, args)
                }
              }
            }
          }

          // Check for ToolMessage (subagent completion)
          if (className.includes("ToolMessage") && kwargs.tool_call_id && kwargs.name === "task") {
            const subagent = this.activeSubagents.get(kwargs.tool_call_id)
            if (subagent && subagent.status === "running") {
              subagent.status = this.isToolMessageError(kwargs) ? "failed" : "completed"
              subagent.completedAt = new Date()
            }
          }

          // Some providers only attach token usage on the final AIMessage
          // included in values snapshots, not on streaming message chunks.
          const usageMetadata = getUsageMetadata(kwargs)
          if (usageMetadata) {
            console.log("[ElectronTransport] Found usage_metadata in values:", {
              input_tokens: usageMetadata.input_tokens,
              output_tokens: usageMetadata.output_tokens,
              total_tokens: usageMetadata.total_tokens,
              has_cache_details: !!usageMetadata.input_token_details
            })
            const tokenUsageEvent = createTokenUsageEvent(usageMetadata)
            if (tokenUsageEvent) events.push(tokenUsageEvent)
          }
        }

        // Emit subagent update if we have any
        if (this.activeSubagents.size > 0) {
          events.push(this.createSubagentEvent())
        }

        if (isCoordinatorMode) {
          events.push(...this.createCurrentTurnMessageEventsFromValues(state.messages))
        }
      }

      const transformedMessages = transformSerializedValuesMessages(state.messages)

      // Only emit values event if we have actual data to update
      // Don't emit messages: undefined as it would clear the UI
      const valuesData: Record<string, unknown> = {}
      if (!isCoordinatorMode) {
        if (transformedMessages.length > 0) {
          valuesData.messages = transformedMessages
          this.advanceFallbackIndexesFromValuesMessages(transformedMessages)
        }
      }
      if (state.todos !== undefined) {
        valuesData.todos = state.todos
      }
      if (state.workspacePath) {
        valuesData.workspacePath = state.workspacePath
      }

      // Only emit if we have something to update
      if (Object.keys(valuesData).length > 0) {
        events.push({
          event: "values",
          data: valuesData
        })
      }

      // Emit files/workspace
      if (state.files) {
        const filesList = Array.isArray(state.files)
          ? state.files
          : Object.entries(state.files).map(([path, fileData]) => ({
              path,
              is_dir: false,
              size:
                typeof (fileData as { content?: string })?.content === "string"
                  ? (fileData as { content: string }).content.length
                  : undefined
            }))

        if (filesList.length) {
          events.push({
            event: "custom",
            data: { type: "workspace", files: filesList, path: state.workspacePath || "/" }
          })
        }
      }

      // Emit interrupt - langchain HITL returns __interrupt__ as array of { value: HITLRequest }
      if (state.__interrupt__?.length) {
        const interruptValue = state.__interrupt__[0]?.value
        const actionRequests = interruptValue?.actionRequests || []
        const reviewConfigs = interruptValue?.reviewConfigs || []

        if (actionRequests.length) {
          const firstAction = actionRequests[0]
          const reviewConfig = reviewConfigs?.find(
            (rc: { actionName: string }) => rc.actionName === firstAction.name
          )

          // Collect pending tool call IDs
          const nameCount = new Map<string, number>()
          for (const action of actionRequests) {
            nameCount.set(action.name, (nameCount.get(action.name) || 0) + 1)
          }
          const pendingToolCallIds: string[] = []
          for (const [name, count] of nameCount) {
            const tracked = this.completedToolCallsByName.get(name)
            if (tracked && tracked.length > 0) {
              const relevant = tracked.slice(-count)
              for (const tc of relevant) {
                if (tc.id) pendingToolCallIds.push(tc.id)
              }
            }
          }

          const toolCallId = pendingToolCallIds[0]

          events.push({
            event: "custom",
            data: {
              type: "interrupt",
              request: {
                id: toolCallId || crypto.randomUUID(),
                tool_call: {
                  id: toolCallId,
                  name: firstAction.name,
                  args: firstAction.args || {}
                },
                allowed_decisions: reviewConfig?.allowedDecisions || ["approve", "reject", "edit"],
                pendingCount: actionRequests.length,
                pendingToolCallIds,
                allowRuntimeRestoredCheckpointResume: true
              }
            }
          })
        }
      }
    }

    return events
  }

  private createFocusedCoordinatorWorkerEvents(input: {
    parentThreadId: string
    checkpointNs?: string
    className: string
    kwargs: SerializedMessageChunk["kwargs"]
    metadata?: MessageMetadata
  }): StreamEvent[] {
    const focused = useAppStore.getState().workerFocusView
    if (
      !focused ||
      focused.threadId !== input.parentThreadId ||
      !input.checkpointNs?.includes(focused.workerThreadId)
    ) {
      return []
    }

    const events: StreamEvent[] = []
    const kwargs = input.kwargs || {}
    const isHumanMessage =
      input.className.includes("HumanMessage") || kwargs.type === "human" || kwargs.type === "user"
    const isToolMessage = input.className.includes("ToolMessage") && !!kwargs.tool_call_id
    const isAIMessage = input.className.includes("AI") || input.className.includes("AIMessageChunk")

    if (isHumanMessage) {
      this.resetWorkerCurrentAssistant(focused.workerThreadId)
      const content = this.extractContent(kwargs.content)
      if (content) {
        const msgId =
          (typeof kwargs.id === "string"
            ? this.createFocusedWorkerTurnScopedMessageId(focused.workerThreadId, kwargs.id)
            : undefined) || this.createWorkerLiveFallbackMessageId(focused.workerThreadId)
        events.push(
          this.createCoordinatorWorkerStreamMessageEvent(focused.workerThreadId, {
            id: msgId,
            role: "user",
            content,
            created_at: new Date()
          })
        )
      }
      return events
    }

    if (isAIMessage) {
      const isChunk = input.className.includes("Chunk")
      const extractedContent = this.extractContent(kwargs.content)
      const providerMessageId =
        typeof kwargs.id === "string"
          ? this.createFocusedWorkerTurnScopedMessageId(focused.workerThreadId, kwargs.id)
          : undefined
      const msgId =
        providerMessageId ||
        this.workerCurrentMessageIds.get(focused.workerThreadId) ||
        this.createWorkerLiveFallbackMessageId(focused.workerThreadId)
      this.workerCurrentMessageIds.set(focused.workerThreadId, msgId)

      let content = extractedContent
      if (isChunk && extractedContent) {
        content = this.mergeWorkerAssistantTextChunk(
          this.workerAssistantTextByMessageId.get(msgId) ?? "",
          extractedContent
        )
        this.workerAssistantTextByMessageId.set(msgId, content)
      } else if (extractedContent) {
        this.workerAssistantTextByMessageId.set(msgId, extractedContent)
      } else {
        content = this.workerAssistantTextByMessageId.get(msgId) ?? ""
      }

      const toolCalls = this.hydrateToolCallsWithAccumulatedArgs(kwargs.tool_calls ?? [])
      if (toolCalls.length) {
        this.rememberCompletedToolCallsForMessage(msgId, toolCalls)
      }

      if (content || toolCalls.length) {
        events.push(
          this.createCoordinatorWorkerStreamMessageEvent(focused.workerThreadId, {
            id: msgId,
            role: "assistant",
            content,
            ...(toolCalls.length && { tool_calls: toolCalls as Message["tool_calls"] }),
            created_at: new Date()
          })
        )
      }

      if (kwargs.tool_call_chunks?.length) {
        this.accumulateToolCallChunks(kwargs.tool_call_chunks)
        const completedToolCalls = this.completedToolCallsFromAccumulatedChunks(
          kwargs.tool_call_chunks
        )
        if (completedToolCalls.length) {
          this.rememberCompletedToolCallsForMessage(msgId, completedToolCalls)
          events.push(
            this.createCoordinatorWorkerStreamMessageEvent(focused.workerThreadId, {
              id: msgId,
              role: "assistant",
              content: this.workerAssistantTextByMessageId.get(msgId) ?? "",
              tool_calls: this.getCompletedToolCallsForMessage(msgId) as Message["tool_calls"],
              created_at: new Date()
            })
          )
        }
      }

      return events
    }

    if (isToolMessage && kwargs.tool_call_id) {
      const content = this.extractContent(kwargs.content)
      const isError = this.isToolMessageError(kwargs)
      const msgId =
        (typeof kwargs.id === "string"
          ? this.createFocusedWorkerTurnScopedMessageId(focused.workerThreadId, kwargs.id)
          : undefined) ||
        this.createFocusedWorkerTurnScopedMessageId(
          focused.workerThreadId,
          this.createStableFallbackMessageId({
            type: "tool",
            content,
            toolCallId: kwargs.tool_call_id,
            toolName: kwargs.name
          })
        )

      events.push(
        this.createCoordinatorWorkerStreamMessageEvent(focused.workerThreadId, {
          id: msgId,
          role: "tool",
          content,
          tool_call_id: kwargs.tool_call_id,
          ...(kwargs.name && { name: kwargs.name }),
          ...(kwargs.status && { status: kwargs.status }),
          ...(isError && { is_error: true }),
          created_at: new Date()
        })
      )
      this.workerCurrentMessageIds.delete(focused.workerThreadId)
    }

    return events
  }

  private createCoordinatorWorkerStreamMessageEvent(
    workerThreadId: string,
    message: Message
  ): StreamEvent {
    return {
      event: "custom",
      data: {
        type: "coordinator_worker_stream_message",
        workerThreadId,
        workerMessage: message
      }
    }
  }

  private createCoordinatorAssistantSnapshotEvent(input: {
    id: string
    content: string
    toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
  }): StreamEvent {
    return {
      event: "custom",
      data: {
        type: "coordinator_ai_snapshot_message",
        assistantMessage: {
          id: input.id,
          type: "ai",
          content: input.content,
          ...(input.toolCalls !== undefined && { tool_calls: input.toolCalls })
        }
      }
    }
  }

  private createWorkerLiveFallbackMessageId(workerThreadId: string): string {
    const next = (this.workerLiveMessageSequenceByThread.get(workerThreadId) ?? 0) + 1
    this.workerLiveMessageSequenceByThread.set(workerThreadId, next)
    return this.createFocusedWorkerTurnScopedMessageId(
      workerThreadId,
      `worker-live-${workerThreadId}-${next}`
    )
  }

  private createFocusedWorkerTurnScopedMessageId(workerThreadId: string, rawId: string): string {
    const workerTurn = this.workerCurrentTurnByThread.get(workerThreadId)
    if (typeof workerTurn !== "number" || !Number.isFinite(workerTurn)) {
      return rawId
    }

    const prefix = `worker-turn-${workerThreadId}-${workerTurn}::`
    return rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`
  }

  private syncWorkerTurnBoundary(workerThreadId: string, workerTurn?: number): void {
    if (typeof workerTurn !== "number" || !Number.isFinite(workerTurn)) return
    const previousTurn = this.workerCurrentTurnByThread.get(workerThreadId)
    if (previousTurn === workerTurn) return
    this.workerCurrentTurnByThread.set(workerThreadId, workerTurn)
    this.resetWorkerCurrentAssistant(workerThreadId)
    this.resetFocusedWorkerTurnToolState()
  }

  private resetWorkerCurrentAssistant(workerThreadId: string): void {
    const messageId = this.workerCurrentMessageIds.get(workerThreadId)
    this.workerCurrentMessageIds.delete(workerThreadId)
    if (messageId) {
      this.workerAssistantTextByMessageId.delete(messageId)
    }
  }

  private resetFocusedWorkerTurnToolState(): void {
    this.accumulatedToolCalls.clear()
    this.lastToolCallChunkArgsById.clear()
    this.completedToolCallsByMessageId.clear()
  }

  private mergeWorkerAssistantTextChunk(existing: string, nextChunk: string): string {
    if (!existing) return nextChunk
    if (!nextChunk) return existing
    if (nextChunk === existing || nextChunk.startsWith(existing)) {
      // Some providers stream cumulative assistant snapshots instead of deltas.
      return nextChunk
    }
    if (existing.endsWith(nextChunk)) {
      // Guard against exact duplicate chunk replays.
      return existing
    }

    const maxOverlap = Math.min(existing.length, nextChunk.length) - 1
    for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
      if (existing.slice(-overlap) === nextChunk.slice(0, overlap)) {
        return `${existing}${nextChunk.slice(overlap)}`
      }
    }

    return `${existing}${nextChunk}`
  }

  private prepareMainAssistantChunkContent(
    messageId: string,
    incoming: string
  ): string | undefined {
    if (!incoming) return undefined
    const existing = this.mainAssistantTextByMessageId.get(messageId) ?? ""
    const merged = this.mergeWorkerAssistantTextChunk(existing, incoming)
    if (merged === existing) return undefined
    this.mainAssistantTextByMessageId.set(messageId, merged)
    pruneMapToLimit(this.mainAssistantTextByMessageId, MAX_TRACKED_EMITTED_MESSAGES)
    return merged.slice(existing.length)
  }

  private prepareMainAssistantSnapshotUpdate(
    messageId: string,
    snapshot: string
  ): MainAssistantSnapshotUpdate {
    if (!snapshot) return { kind: "skip" }
    const existing = this.mainAssistantTextByMessageId.get(messageId) ?? ""
    if (!existing) {
      this.mainAssistantTextByMessageId.set(messageId, snapshot)
      pruneMapToLimit(this.mainAssistantTextByMessageId, MAX_TRACKED_EMITTED_MESSAGES)
      return { kind: "delta", content: snapshot }
    }
    if (snapshot === existing) return { kind: "skip" }
    if (snapshot.startsWith(existing)) {
      const suffix = snapshot.slice(existing.length)
      const replayTail = this.extractMainAssistantReplayTail(existing, suffix)
      if (replayTail !== undefined) {
        if (replayTail.length === 0) return { kind: "skip" }
        const nextText = `${existing}${replayTail}`
        this.mainAssistantTextByMessageId.set(messageId, nextText)
        pruneMapToLimit(this.mainAssistantTextByMessageId, MAX_TRACKED_EMITTED_MESSAGES)
        return { kind: "delta", content: replayTail }
      }
      this.mainAssistantTextByMessageId.set(messageId, snapshot)
      pruneMapToLimit(this.mainAssistantTextByMessageId, MAX_TRACKED_EMITTED_MESSAGES)
      return { kind: "delta", content: suffix }
    }

    // Values-mode AI messages are complete snapshots, not deltas. If the final
    // provider state rewrites, wraps, or shortens already-streamed text, replace
    // the live message rather than dropping the snapshot or appending it twice.
    this.mainAssistantTextByMessageId.set(messageId, snapshot)
    pruneMapToLimit(this.mainAssistantTextByMessageId, MAX_TRACKED_EMITTED_MESSAGES)
    return { kind: "replace", content: snapshot }
  }

  private canSafelyApplyMainAssistantSnapshot(
    messageId: string | undefined,
    snapshot: string
  ): boolean {
    if (!messageId || !snapshot) return false
    const existing = this.mainAssistantTextByMessageId.get(messageId)
    if (!existing) return false
    if (snapshot === existing) return true
    // Very short assistant prefixes such as "好的" are common across distinct
    // messages in the same turn. Only treat a growing values snapshot as the
    // same live message when the existing text is specific enough to anchor it.
    return existing.length >= 16 && snapshot.startsWith(existing)
  }

  private snapshotReplaysMainAssistantText(
    messageId: string | undefined,
    snapshot: string
  ): boolean {
    if (!messageId || !snapshot) return false
    const existing = this.mainAssistantTextByMessageId.get(messageId)
    return !!existing && (snapshot.includes(existing) || existing.includes(snapshot))
  }

  private extractMainAssistantReplayTail(existing: string, suffix: string): string | undefined {
    const trimmedStartLength = suffix.length - suffix.trimStart().length
    const replayStart = trimmedStartLength
    if (!suffix.startsWith(existing, replayStart)) return undefined
    return suffix.slice(replayStart + existing.length)
  }

  private createStableFallbackMessageId(input: {
    type: "ai" | "tool"
    content?: string
    toolCallId?: string
    toolName?: string
    toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
  }): string {
    return buildCurrentTurnMessageFallbackId(input)
  }

  private rememberEmittedMessage(id?: string): void {
    if (!id) return
    this.emittedMessageIds.add(id)
    pruneSetToLimit(this.emittedMessageIds, MAX_TRACKED_EMITTED_MESSAGES)
  }

  private hasEmittedMessage(id?: string): boolean {
    return !!id && this.emittedMessageIds.has(id)
  }

  private getSerializedMessageClassName(message: SerializedMessageChunk): string {
    const classId = Array.isArray(message.id) ? message.id : []
    return classId[classId.length - 1] || ""
  }

  private isSerializedHumanMessage(message: SerializedMessageChunk): boolean {
    const className = this.getSerializedMessageClassName(message)
    const type = message.kwargs?.type
    return className.includes("HumanMessage") || type === "human" || type === "user"
  }

  private isSerializedAIMessage(message: SerializedMessageChunk): boolean {
    const className = this.getSerializedMessageClassName(message)
    const type = message.kwargs?.type
    return (
      className.includes("AI") ||
      className.includes("AIMessageChunk") ||
      type === "ai" ||
      type === "assistant"
    )
  }

  private isSerializedToolMessage(message: SerializedMessageChunk): boolean {
    const className = this.getSerializedMessageClassName(message)
    const type = message.kwargs?.type
    return (className.includes("ToolMessage") || type === "tool") && !!message.kwargs?.tool_call_id
  }

  private createCurrentTurnMessageEventsFromValues(
    messages: SerializedMessageChunk[]
  ): StreamEvent[] {
    const events: StreamEvent[] = []
    let currentTurnStart = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (this.isSerializedHumanMessage(messages[index])) {
        currentTurnStart = index + 1
        break
      }
    }

    let latestCurrentTurnAiIndex = -1
    for (let index = currentTurnStart; index < messages.length; index += 1) {
      if (this.isSerializedAIMessage(messages[index])) latestCurrentTurnAiIndex = index
    }
    const reusableCurrentMessageId =
      this.currentMessageId && this.hasEmittedMessage(this.currentMessageId)
        ? this.currentMessageId
        : undefined
    const reusableCurrentMessageText = reusableCurrentMessageId
      ? (this.mainAssistantTextByMessageId.get(reusableCurrentMessageId) ?? "")
      : ""
    let currentMessageValuesIndex = -1
    if (reusableCurrentMessageId) {
      let candidateIndex = -1
      let sawToolAfterCandidate = false
      for (let index = currentTurnStart; index < messages.length; index += 1) {
        const message = messages[index]
        if (candidateIndex >= 0 && this.isSerializedToolMessage(message)) {
          sawToolAfterCandidate = true
        }
        if (!this.isSerializedAIMessage(message)) continue
        const content = this.extractContent(message.kwargs?.content)
        if (content === reusableCurrentMessageText) {
          if (candidateIndex < 0) candidateIndex = index
          continue
        }
        if (reusableCurrentMessageText && content.startsWith(reusableCurrentMessageText)) {
          if (sawToolAfterCandidate) continue
          candidateIndex = index
          continue
        }
        if (this.canSafelyApplyMainAssistantSnapshot(reusableCurrentMessageId, content)) {
          if (sawToolAfterCandidate) continue
          candidateIndex = index
        }
      }
      currentMessageValuesIndex = candidateIndex
      if (currentMessageValuesIndex < 0 && latestCurrentTurnAiIndex >= 0) {
        const latestContent = this.extractContent(messages[latestCurrentTurnAiIndex]?.kwargs?.content)
        if (this.snapshotReplaysMainAssistantText(reusableCurrentMessageId, latestContent)) {
          currentMessageValuesIndex = latestCurrentTurnAiIndex
        }
      }
    }

    const fallbackIndexes: Record<"ai" | "tool" | "system" | "human", number> = {
      ai: 0,
      tool: 0,
      system: 0,
      human: 0
    }

    let sawToolAfterCurrentMessageCandidate = false
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const kwargs = message.kwargs || {}
      const className = this.getSerializedMessageClassName(message)
      const fallbackType = this.isSerializedToolMessage(message)
        ? "tool"
        : this.isSerializedHumanMessage(message)
          ? "human"
          : className.includes("System") || kwargs.type === "system"
            ? "system"
            : "ai"
      const fallbackIndex = fallbackIndexes[fallbackType]++
      if (index < currentTurnStart) continue
      if (
        currentMessageValuesIndex >= 0 &&
        index > currentMessageValuesIndex &&
        this.isSerializedToolMessage(message)
      ) {
        sawToolAfterCurrentMessageCandidate = true
      }

      if (this.isSerializedAIMessage(message)) {
        const content = this.extractContent(kwargs.content)
        const visibleToolCalls = this.hydrateToolCallsWithAccumulatedArgs(
          this.filterVisibleMainToolCalls(kwargs.tool_calls, true)
        )
        if (!content && visibleToolCalls.length === 0) continue
        if (
          reusableCurrentMessageText &&
          index !== currentMessageValuesIndex &&
          content === reusableCurrentMessageText &&
          !sawToolAfterCurrentMessageCandidate &&
          visibleToolCalls.length === 0
        ) {
          continue
        }

        const reusableCurrentMessageIdForIndex =
          index === currentMessageValuesIndex ? reusableCurrentMessageId : undefined
        const providerMessageId = typeof kwargs.id === "string" ? kwargs.id : undefined
        const shouldReuseCurrentMessageId =
          this.canSafelyApplyMainAssistantSnapshot(reusableCurrentMessageIdForIndex, content)
        let msgId =
          shouldReuseCurrentMessageId && reusableCurrentMessageIdForIndex
            ? reusableCurrentMessageIdForIndex
            : providerMessageId ||
              reusableCurrentMessageIdForIndex ||
              buildStableValuesMessageId({
                index: fallbackIndex,
                type: "ai",
                className,
                content,
                toolCalls: visibleToolCalls
              })
        if (
          providerMessageId &&
          reusableCurrentMessageIdForIndex &&
          msgId === providerMessageId &&
          content &&
          !this.canSafelyApplyMainAssistantSnapshot(providerMessageId, content) &&
          this.snapshotReplaysMainAssistantText(reusableCurrentMessageIdForIndex, content)
        ) {
          msgId = reusableCurrentMessageIdForIndex
        }
        const snapshotUpdate = this.prepareMainAssistantSnapshotUpdate(msgId, content)
        if (snapshotUpdate.kind === "skip" && visibleToolCalls.length === 0) continue
        this.rememberEmittedMessage(msgId)
        if (snapshotUpdate.kind === "replace") {
          events.push(
            this.createCoordinatorAssistantSnapshotEvent({
              id: msgId,
              content: snapshotUpdate.content,
              toolCalls: visibleToolCalls
            })
          )
        } else {
          events.push({
            event: "messages",
            data: [
              {
                id: msgId,
                type: "ai",
                content: snapshotUpdate.kind === "delta" ? snapshotUpdate.content : "",
                ...(visibleToolCalls.length && { tool_calls: visibleToolCalls })
              },
              { langgraph_node: "agent" }
            ]
          })
        }

        if (visibleToolCalls.length) {
          events.push(...this.processCompletedToolCalls(visibleToolCalls))
          for (const toolCall of visibleToolCalls) {
            if (!toolCall.id || !toolCall.name) continue
            const existing = this.completedToolCallsByName.get(toolCall.name) || []
            if (!existing.some((item) => item.id === toolCall.id)) {
              existing.push({ id: toolCall.id, name: toolCall.name, args: toolCall.args || {} })
              this.completedToolCallsByName.set(
                toolCall.name,
                keepRecentItems(existing, MAX_TRACKED_TOOL_CALLS_PER_NAME)
              )
              pruneMapToLimit(this.completedToolCallsByName, MAX_TRACKED_TOOL_CALL_NAMES)
            }
          }
        }
      }

      if (this.isSerializedToolMessage(message) && kwargs.tool_call_id) {
        if (this.quietCoordinatorToolCallIds.has(kwargs.tool_call_id)) continue
        if (this.isQuietCoordinatorToolName(kwargs.name)) {
          this.quietCoordinatorToolCallIds.add(kwargs.tool_call_id)
          continue
        }

        const content = this.extractContent(kwargs.content)
        const msgId =
          kwargs.id ||
          this.createStableFallbackMessageId({
            type: "tool",
            content,
            toolCallId: kwargs.tool_call_id,
            toolName: kwargs.name
          })
        if (this.hasEmittedMessage(msgId)) continue

        this.rememberEmittedMessage(msgId)
        events.push({
          event: "messages",
          data: [
            {
              id: msgId,
              type: "tool",
              content,
              tool_call_id: kwargs.tool_call_id,
              name: kwargs.name
            },
            { langgraph_node: "tools" }
          ]
        })
      }
    }

    return events
  }

  /**
   * Check if a checkpoint namespace indicates a nested subagent message.
   * Main-agent tool nodes can also contain "tools:", so callers must also
   * require an active task subagent before treating the event as internal.
   */
  private isSubagentNamespace(ns?: string): boolean {
    return !!ns && ns.includes("tools:")
  }

  private isCoordinatorWorkerNamespace(ns?: string): boolean {
    return !!ns && ns.includes("__worker__")
  }

  private hasRunningSubagent(): boolean {
    return Array.from(this.activeSubagents.values()).some(
      (subagent) => subagent.status === "running"
    )
  }

  /**
   * Resolve the parent task tool_call_id of the subagent that owns a given
   * checkpoint namespace, so subagent log entries can be attributed explicitly
   * (the UI no longer guesses). Matches a running subagent whose toolCallId
   * appears in the namespace; falls back to the sole running subagent.
   */
  private resolveSubagentToolCallId(ns?: string): string | undefined {
    const running = Array.from(this.activeSubagents.values()).filter(
      (subagent) => subagent.status === "running"
    )
    if (ns) {
      const matched = running.find(
        (subagent) => subagent.toolCallId && ns.includes(subagent.toolCallId)
      )
      if (matched?.toolCallId) return matched.toolCallId
    }
    return running.length === 1 ? running[0].toolCallId : undefined
  }

  private isQuietCoordinatorToolName(toolName?: string): boolean {
    return !!toolName && QUIET_COORDINATOR_TOOL_NAMES.has(toolName)
  }

  private filterVisibleMainToolCalls(
    toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>,
    quietCoordinatorTools = false
  ): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> {
    if (!toolCalls?.length) return []
    if (!quietCoordinatorTools) return toolCalls
    return toolCalls.filter((toolCall) => {
      if (this.isQuietCoordinatorToolName(toolCall.name)) {
        if (toolCall.id) this.quietCoordinatorToolCallIds.add(toolCall.id)
        return false
      }
      if (toolCall.id && this.quietCoordinatorToolCallIds.has(toolCall.id)) {
        return false
      }
      return true
    })
  }

  private filterVisibleMainToolCallChunks(
    chunks?: Array<{ id?: string; name?: string; args?: string }>,
    quietCoordinatorTools = false
  ): Array<{ id?: string; name?: string; args?: string }> {
    if (!chunks?.length) return []
    if (!quietCoordinatorTools) return chunks
    return chunks.filter((chunk) => {
      if (this.isQuietCoordinatorToolName(chunk.name)) {
        if (chunk.id) this.quietCoordinatorToolCallIds.add(chunk.id)
        return false
      }
      if (chunk.id && this.quietCoordinatorToolCallIds.has(chunk.id)) {
        return false
      }
      return true
    })
  }

  private processSubagentToolCalls(
    ...toolCallGroups: Array<Array<{ id?: string; name?: string }> | undefined>
  ): StreamEvent[] {
    let changed = false

    for (const toolCalls of toolCallGroups) {
      if (!toolCalls?.length) continue

      for (const toolCall of toolCalls) {
        if (!toolCall.id) continue
        if (this.subagentToolCallIds.has(toolCall.id)) continue

        this.subagentToolCallIds.add(toolCall.id)
        changed = true
      }
    }

    if (!changed) return []

    this.subagentToolCallCount = this.subagentToolCallIds.size
    return [this.createSubagentToolCountEvent()]
  }

  private createSubagentAssistantLogEvents(
    checkpointNs?: string,
    ...toolCallGroups: Array<Array<{ id?: string; name?: string; args?: unknown }> | undefined>
  ): StreamEvent[] {
    const events: StreamEvent[] = []

    for (const toolCalls of toolCallGroups) {
      if (!toolCalls?.length) continue

      for (const toolCall of toolCalls) {
        if (!toolCall.id) continue

        events.push(
          this.createSubagentLogEntryEvent({
            kind: "tool_call",
            title: `调用工具：${toolCall.name || "未知工具"}`,
            content: this.formatSubagentToolArgs(toolCall.args),
            status: "waiting",
            checkpointNs,
            toolCallId: toolCall.id,
            toolName: toolCall.name
          })
        )
      }
    }

    return events
  }

  private formatSubagentToolArgs(args: unknown): string {
    if (args === undefined || args === null || args === "") return ""
    if (typeof args === "string") {
      return this.truncateSubagentLogContent(args)
    }

    try {
      return this.truncateSubagentLogContent(JSON.stringify(args, null, 2))
    } catch {
      return this.truncateSubagentLogContent(String(args))
    }
  }

  private truncateSubagentLogContent(content: string): string {
    const trimmed = content.trim()
    if (!trimmed) return ""

    const maxChars = 1200
    if (trimmed.length <= maxChars) return trimmed
    return `${trimmed.slice(0, maxChars)}\n...`
  }

  /**
   * Register a subagent from a task tool call.
   */
  private registerSubagent(toolCallId: string, args: Record<string, unknown>): void {
    const subagent = this.createSubagentFromTask(toolCallId, args)
    this.activeSubagents.set(toolCallId, subagent)
  }

  private isToolMessageError(kwargs: SerializedMessageChunk["kwargs"]): boolean {
    if (!kwargs) return false
    return (
      kwargs.status === "error" ||
      kwargs.is_error === true ||
      kwargs.additional_kwargs?.is_error === true
    )
  }

  /**
   * Extract text content from message content (string or content blocks)
   */
  private extractContent(
    content: string | Array<{ type: string; text?: string }> | undefined
  ): string {
    return extractSerializedContent(content)
  }

  private hasToolArgs(args: unknown): boolean {
    return Boolean(args && typeof args === "object" && Object.keys(args).length > 0)
  }

  private parseAccumulatedToolCall(id?: string): CompletedToolCall | null {
    if (!id) return null
    const accumulated = this.accumulatedToolCalls.get(id)
    if (!accumulated?.name || !accumulated.args) return null

    try {
      const args = JSON.parse(accumulated.args)
      if (!args || typeof args !== "object" || Array.isArray(args)) return null
      return {
        id: accumulated.id,
        name: accumulated.name,
        args: this.normalizeToolCallArgsForDisplay(
          accumulated.name,
          args as Record<string, unknown>
        )
      }
    } catch {
      return null
    }
  }

  private hydrateToolCallsWithAccumulatedArgs(
    toolCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
  ): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> {
    return toolCalls.map((toolCall) => {
      if (this.hasToolArgs(toolCall.args)) {
        return {
          ...toolCall,
          args: this.normalizeToolCallArgsForDisplay(toolCall.name, toolCall.args!)
        }
      }

      const completed = this.parseAccumulatedToolCall(toolCall.id)
      if (!completed) return toolCall

      return {
        ...toolCall,
        name: toolCall.name || completed.name,
        args: this.normalizeToolCallArgsForDisplay(toolCall.name || completed.name, completed.args)
      }
    })
  }

  private normalizeToolCallArgsForDisplay(
    toolName: string | undefined,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    if (!isCoordinatorWorkerToolName(toolName)) return args
    return normalizeCoordinatorWorkerToolArgsForDisplay(toolName, args)
  }

  private completedToolCallsFromAccumulatedChunks(
    chunks: Array<{ id?: string }>
  ): CompletedToolCall[] {
    const completed: CompletedToolCall[] = []
    const seen = new Set<string>()

    for (const chunk of chunks) {
      if (!chunk.id || seen.has(chunk.id)) continue
      seen.add(chunk.id)

      const parsed = this.parseAccumulatedToolCall(chunk.id)
      if (parsed) completed.push(parsed)
    }

    return completed
  }

  private rememberCompletedToolCallsForMessage(
    messageId: string,
    toolCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
  ): void {
    let byToolId = this.completedToolCallsByMessageId.get(messageId)
    if (!byToolId) {
      byToolId = new Map()
      this.completedToolCallsByMessageId.set(messageId, byToolId)
    }

    for (const toolCall of toolCalls) {
      if (!toolCall.id || !toolCall.name || !this.hasToolArgs(toolCall.args)) continue
      byToolId.set(toolCall.id, {
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args!
      })
    }
    pruneMapToLimit(this.completedToolCallsByMessageId, MAX_TRACKED_MESSAGE_TOOL_CALLS)
  }

  private getCompletedToolCallsForMessage(messageId: string): CompletedToolCall[] {
    return Array.from(this.completedToolCallsByMessageId.get(messageId)?.values() ?? [])
  }

  private accumulateToolCallChunks(
    chunks: Array<{ id?: string; name?: string; args?: string }>
  ): void {
    for (const chunk of chunks) {
      if (!chunk.id) continue

      let accumulated = this.accumulatedToolCalls.get(chunk.id)
      if (!accumulated) {
        accumulated = { id: chunk.id, name: chunk.name || "", args: "" }
        this.accumulatedToolCalls.set(chunk.id, accumulated)
      }

      if (chunk.name) {
        accumulated.name = chunk.name
      }
      if (chunk.args) {
        const previousChunkArgs = this.lastToolCallChunkArgsById.get(chunk.id)
        if (chunk.args !== previousChunkArgs) {
          if (accumulated.args && chunk.args.startsWith(accumulated.args)) {
            // Some providers stream cumulative args snapshots instead of deltas.
            accumulated.args = chunk.args
          } else {
            accumulated.args = this.appendToolCallChunkArgs(accumulated.args, chunk.args)
          }
        }
        this.lastToolCallChunkArgsById.set(chunk.id, chunk.args)
      }
      pruneMapToLimit(this.accumulatedToolCalls, MAX_TRACKED_TOOL_CALLS)
      pruneMapToLimit(this.lastToolCallChunkArgsById, MAX_TRACKED_TOOL_CALLS)
    }
  }

  private appendToolCallChunkArgs(existing: string, nextChunk: string): string {
    if (!existing) return nextChunk
    if (!nextChunk) return existing

    const maxOverlap = Math.min(existing.length, nextChunk.length) - 1
    for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
      if (existing.slice(-overlap) === nextChunk.slice(0, overlap)) {
        const remainder = nextChunk.slice(overlap)
        if (/^["},\]:]/.test(remainder)) {
          // If the duplicate-looking prefix is immediately followed by JSON
          // structure, it is likely real repeated string content, not a replayed
          // overlap. Example: existing ends with "foo" and next is
          // `foo","prompt":...`; collapsing would turn "foofoo" into "foo".
          continue
        }
        return `${existing}${nextChunk.slice(overlap)}`
      }
    }

    return `${existing}${nextChunk}`
  }

  /**
   * Process streaming tool call chunks and detect task subagent invocations
   * Tool calls are streamed incrementally, so we accumulate args until we have enough
   */
  private processToolCallChunks(
    chunks: Array<{ id?: string; name?: string; args?: string }>
  ): StreamEvent[] {
    const events: StreamEvent[] = []
    this.accumulateToolCallChunks(chunks)

    for (const chunk of chunks) {
      if (!chunk.id) continue
      const accumulated = this.accumulatedToolCalls.get(chunk.id)
      if (!accumulated) continue

      // Check if this is a "task" tool call and try to parse args
      if (accumulated.name === "task") {
        try {
          const args = JSON.parse(accumulated.args)
          // Only process if we haven't already created a subagent for this tool call
          if (!this.activeSubagents.has(chunk.id) && args.subagent_type) {
            this.registerSubagent(chunk.id, args)
            events.push(this.createSubagentEvent())
          }
        } catch {
          // Args not complete yet, continue accumulating
        }
      }
    }

    return events
  }

  /**
   * Process completed tool calls (non-streaming) and detect task subagent invocations
   */
  private processCompletedToolCalls(
    toolCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
  ): StreamEvent[] {
    const events: StreamEvent[] = []

    for (const toolCall of toolCalls) {
      if (!toolCall.id || !toolCall.name) continue

      // Check if this is a "task" tool call
      if (toolCall.name === "task" && !this.activeSubagents.has(toolCall.id)) {
        const args = toolCall.args || {}
        if (args.subagent_type || args.description) {
          this.registerSubagent(toolCall.id, args)
          events.push(this.createSubagentEvent())
        }
      }
    }

    return events
  }

  /**
   * Process a ToolMessage which signals subagent completion
   */
  private processToolMessage(toolCallId: string, isError = false): StreamEvent[] {
    const events: StreamEvent[] = []

    // Check if this tool_call_id corresponds to an active subagent
    const subagent = this.activeSubagents.get(toolCallId)
    if (subagent) {
      subagent.status = isError ? "failed" : "completed"
      subagent.completedAt = new Date()
      events.push(this.createSubagentEvent())
    }

    return events
  }

  /**
   * Create a Subagent object from task tool call args
   */
  private createSubagentFromTask(toolCallId: string, args: Record<string, unknown>): Subagent {
    const subagentType = (args.subagent_type as string) || "general-purpose"
    const description = (args.description as string) || "Executing task..."

    // Generate a friendly name from the subagent type
    const nameMap: Record<string, string> = {
      "general-purpose": "General Purpose Agent",
      "correctness-checker": "Correctness Checker",
      "final-reviewer": "Final Reviewer",
      "code-reviewer": "Code Reviewer",
      research: "Research Agent"
    }

    return {
      id: toolCallId,
      toolCallId,
      name: nameMap[subagentType] || this.formatSubagentName(subagentType),
      description,
      status: "running",
      startedAt: new Date(),
      subagentType
    }
  }

  /**
   * Format a subagent type string into a display name
   */
  private formatSubagentName(subagentType: string): string {
    return subagentType
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  }

  /**
   * Create a custom event with current subagent state.
   */
  private createSubagentEvent(): StreamEvent {
    return {
      event: "custom",
      data: {
        type: "subagents",
        subagents: Array.from(this.activeSubagents.values())
      }
    }
  }

  private createSubagentToolCountEvent(): StreamEvent {
    return {
      event: "custom",
      data: {
        type: "subagent_tool_count",
        count: this.subagentToolCallCount
      }
    }
  }

  private createSubagentLogResetEvent(): StreamEvent {
    return {
      event: "custom",
      data: {
        type: "subagent_log_reset"
      }
    }
  }

  private createSubagentLogEntryEvent(input: {
    kind: "tool_call" | "tool_result" | "assistant"
    title: string
    entryId?: string
    content?: string
    result?: string
    status?: "waiting" | "completed"
    checkpointNs?: string
    toolCallId?: string
    toolName?: string
    subagentToolCallId?: string
  }): StreamEvent {
    this.subagentLogSequence += 1
    const entryId =
      input.entryId ??
      (input.toolCallId && this.subagentToolLogEntryIds.has(input.toolCallId)
        ? this.subagentToolLogEntryIds.get(input.toolCallId)!
        : `subagent-log-${Date.now()}-${this.subagentLogSequence}`)

    if (input.toolCallId) {
      this.subagentToolLogEntryIds.set(input.toolCallId, entryId)
    }

    return {
      event: "custom",
      data: {
        type: "subagent_log_entry",
        entry: {
          id: entryId,
          kind: input.kind,
          title: input.title,
          content: input.content ?? "",
          result: input.result,
          status: input.status,
          checkpointNs: input.checkpointNs,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          subagentToolCallId: input.subagentToolCallId,
          createdAt: new Date().toISOString()
        }
      }
    }
  }
}
