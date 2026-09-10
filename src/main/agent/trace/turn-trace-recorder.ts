import {
  extractVisibleReasoning,
  isTraceReasoningTruncated,
  mergeStreamingReasoning,
  truncateReasoningForTrace
} from "../../../shared/model-reasoning"
import { nowIsoLocal } from "../../util/local-time"
import { normalizeTraceTokenUsage } from "./token-usage"
import type { TraceChatMessage, TraceNodeStatus, TraceToolCall, TraceTokenUsage } from "./types"

/**
 * Turns a LangGraph stream into trace records.
 *
 * Every path that runs the standard agent graph needs the same trace: the
 * operations dashboard reads model-call counts, token totals and the
 * reconstructed conversation off the same fields regardless of who started the
 * turn. The rules therefore live here rather than inside any one caller's
 * stream loop, and `TurnTraceRecorder` drives them for callers that have no
 * loop of their own.
 *
 * Records come from the `values` snapshots, not the converted renderer events:
 * only the raw snapshot carries `usage_metadata` / `response_metadata` and
 * fully-assembled tool-call args.
 */

/** How many preceding messages are kept as one model call's input context. */
export const MODEL_INPUT_WINDOW = 12
/** Per-field content cap applied before the collector's own byte budget. */
export const MAX_TRACE_CONTENT = 2000

export interface SerializedTraceMessage {
  id?: unknown
  kwargs?: Record<string, unknown>
}

export interface TraceToolCallLike {
  id?: unknown
  name?: unknown
  args?: unknown
}

/** The slice of TraceCollector this module records through. */
export interface TurnTraceCollector {
  setModelName(name: string): void
  beginStep(): void
  recordToolCall(call: TraceToolCall): void
  endStep(assistantText: string): void
  beginLlmNode(params: {
    messageId?: string
    startedAt?: string
    input?: unknown
    name?: string
    metadata?: Record<string, unknown>
  }): string
  recordModelCall(call: {
    messageId?: string
    startedAt: string
    inputMessages: TraceChatMessage[]
    outputMessage: TraceChatMessage
    toolCalls: TraceToolCall[]
    tokenUsage?: TraceTokenUsage
  }): void
  endLlmNode(params: {
    nodeId?: string
    messageId?: string
    status?: TraceNodeStatus
    endedAt?: string
    output?: unknown
    metadata?: Record<string, unknown>
  }): void
  addToolNode(params: {
    name: string
    input?: unknown
    parentId?: string
    llmMessageId?: string
    toolCallId?: string
    startedAt?: string
    metadata?: Record<string, unknown>
  }): string
  addToolResultNode(params: {
    output?: unknown
    parentId?: string
    toolCallId?: string
    startedAt?: string
    status?: TraceNodeStatus
    metadata?: Record<string, unknown>
  }): string
}

// -- content helpers ---------------------------------------------------------

export function clampTraceContent(text: string): string {
  return text.length > MAX_TRACE_CONTENT
    ? `${text.slice(0, MAX_TRACE_CONTENT)}\n…(truncated)`
    : text
}

/** Flatten a message content field — string, block array, or nested blocks. */
export function extractTraceRawText(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (!Array.isArray(raw)) return ""
  return raw
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const record = block as { text?: unknown; content?: unknown }
      if (typeof record.text === "string") return record.text
      if (typeof record.content === "string") return record.content
      if (Array.isArray(record.content)) return extractTraceRawText(record.content)
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export function extractTraceText(raw: unknown): string {
  return clampTraceContent(extractTraceRawText(raw))
}

/** Text blocks only — used where non-text blocks must not leak into the answer. */
export function extractTraceTextBlocks(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (!Array.isArray(raw)) return ""
  return (raw as Array<{ type?: string; text?: string }>)
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("")
}

export function traceMessageClassName(message: SerializedTraceMessage | undefined): string {
  const classId = Array.isArray(message?.id) ? (message.id as unknown[]) : []
  const last = classId[classId.length - 1]
  return typeof last === "string" ? last : ""
}

export function traceMessageRole(
  className: string,
  kwargs: Record<string, unknown> | undefined
): TraceChatMessage["role"] {
  if (className.includes("Human")) return "user"
  if (className.includes("AI")) return "assistant"
  if (className.includes("System")) return "system"
  if (className.includes("Tool")) return "tool"
  if (kwargs?.type === "human") return "user"
  if (kwargs?.type === "ai") return "assistant"
  if (kwargs?.type === "system") return "system"
  if (kwargs?.type === "tool") return "tool"
  return "unknown"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Providers surface usage as top-level `usage_metadata` or under
 * `response_metadata.token_usage` / `.usage`. Normalize all variants so trace
 * capture and the dashboard stay aligned.
 */
export function getTraceUsageMetadata(
  kwargs: Record<string, unknown>
): Record<string, unknown> | undefined {
  const responseMetadata = asRecord(kwargs.response_metadata)
  return (
    asRecord(kwargs.usage_metadata) ??
    asRecord(responseMetadata?.token_usage) ??
    asRecord(responseMetadata?.usage)
  )
}

/** Key-sorted JSON, so a message with no id still gets a stable identity. */
export function stableTraceJson(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableTraceJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableTraceJson(record[key])}`)
    .join(",")}}`
}

const TOOL_ERROR_PREFIX = /^(error:|mcp tool error:|tool error:|failed:)/i

/** Explicit status field, an is_error flag, or an error prefix in the output. */
export function isTraceToolError(kwargs: Record<string, unknown>, output: string): boolean {
  const additionalKwargs = asRecord(kwargs.additional_kwargs)
  return (
    kwargs.status === "error" ||
    kwargs.is_error === true ||
    additionalKwargs?.is_error === true ||
    TOOL_ERROR_PREFIX.test(output.trim())
  )
}

export function traceToolCallId(toolCall: TraceToolCallLike | undefined): string {
  return typeof toolCall?.id === "string" ? toolCall.id : ""
}

export function traceToolCallName(toolCall: TraceToolCallLike | undefined): string {
  return typeof toolCall?.name === "string" && toolCall.name ? toolCall.name : "unknown"
}

function traceToolCallArgs(toolCall: TraceToolCallLike | undefined): Record<string, unknown> {
  return asRecord(toolCall?.args) ?? {}
}

// -- recording units ---------------------------------------------------------

/** Model-facing context for one call: the window of messages that preceded it. */
export function buildModelInputWindow(
  messages: SerializedTraceMessage[],
  index: number
): TraceChatMessage[] {
  return messages
    .slice(Math.max(0, index - MODEL_INPUT_WINDOW), index)
    .map((message) => {
      const kwargs = message?.kwargs ?? {}
      return {
        role: traceMessageRole(traceMessageClassName(message), kwargs),
        content: extractTraceText(kwargs.content),
        ...(typeof kwargs.name === "string" ? { name: kwargs.name } : {}),
        ...(typeof kwargs.tool_call_id === "string" ? { toolCallId: kwargs.tool_call_id } : {})
      }
    })
    .filter((message) => message.content || message.role === "tool")
}

export function toTraceToolCalls(toolCalls: unknown): TraceToolCall[] {
  if (!Array.isArray(toolCalls)) return []
  return (toolCalls as TraceToolCallLike[]).map((toolCall) => ({
    name: traceToolCallName(toolCall),
    args: traceToolCallArgs(toolCall)
  }))
}

export interface RecordedAssistantMessage {
  llmNodeId: string
  tokenUsage?: TraceTokenUsage
}

/**
 * Record one assistant message from a values snapshot as an LLM node plus a
 * model call. This is what produces the dashboard's model-call count, token
 * totals and the assistant side of the reconstructed conversation, so a path
 * that skips it reports a turn that used no model at all.
 */
export function recordAssistantMessageTrace(input: {
  tracer: TurnTraceCollector
  messages: SerializedTraceMessage[]
  index: number
  /** Dedupe key for this message; falls back to a content hash when it has no id. */
  messageKey: string
  /** The provider's own message id, when the message carries one. */
  providerMessageId?: string
  /** Reasoning accumulated from the streaming deltas of the same message. */
  streamedReasoning?: string
}): RecordedAssistantMessage {
  const { tracer, messages, index, messageKey } = input
  const kwargs = messages[index]?.kwargs ?? {}
  const providerMessageId = input.providerMessageId ?? ""

  // The API's own model name (e.g. "MiniMax-M2.7") beats the configured id.
  const responseMetadata = asRecord(kwargs.response_metadata)
  const apiModelName = responseMetadata?.model_name ?? responseMetadata?.model
  if (typeof apiModelName === "string" && apiModelName) tracer.setModelName(apiModelName)

  const inputMessages = buildModelInputWindow(messages, index)
  const toolCalls = toTraceToolCalls(kwargs.tool_calls)
  const tokenUsage = normalizeTraceTokenUsage(getTraceUsageMetadata(kwargs))

  const llmNodeId = tracer.beginLlmNode({
    messageId: messageKey,
    startedAt: nowIsoLocal(),
    input: inputMessages,
    metadata: {
      ...(providerMessageId ? { providerMessageId } : {}),
      toolCallCount: toolCalls.length
    }
  })

  const reasoning = truncateReasoningForTrace(
    extractVisibleReasoning(kwargs, MAX_TRACE_CONTENT + 1) || input.streamedReasoning || "",
    MAX_TRACE_CONTENT
  )
  const content = extractTraceText(kwargs.content)

  tracer.recordModelCall({
    messageId: providerMessageId || messageKey,
    startedAt: nowIsoLocal(),
    inputMessages,
    outputMessage: {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {})
    },
    toolCalls,
    ...(tokenUsage ? { tokenUsage } : {})
  })

  tracer.endLlmNode({
    nodeId: llmNodeId,
    output: content,
    status: "success",
    metadata: {
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(reasoning ? { reasoning } : {})
    }
  })

  return { llmNodeId, ...(tokenUsage ? { tokenUsage } : {}) }
}

/** Record one tool call as a node under its LLM node. */
export function recordToolCallTraceNode(input: {
  tracer: TurnTraceCollector
  toolCall: TraceToolCallLike | undefined
  index: number
  llmMessageId: string
  parentId?: string
}): string {
  return input.tracer.addToolNode({
    name: traceToolCallName(input.toolCall),
    input: traceToolCallArgs(input.toolCall),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    llmMessageId: input.llmMessageId,
    ...(traceToolCallId(input.toolCall) ? { toolCallId: traceToolCallId(input.toolCall) } : {}),
    metadata: { index: input.index }
  })
}

/** Record a tool result message as a node under the call it answers. */
export function recordToolResultTraceNode(input: {
  tracer: TurnTraceCollector
  kwargs: Record<string, unknown>
  messageId: string
  toolCallId?: string
  parentId?: string
  /** Pre-extracted output, when the caller already computed it. */
  output?: string
}): void {
  const output = input.output ?? extractTraceText(input.kwargs.content)
  input.tracer.addToolResultNode({
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    output,
    status: isTraceToolError(input.kwargs, output) ? "error" : "success",
    metadata: { messageId: input.messageId }
  })
}

// -- self-driving recorder ---------------------------------------------------

/**
 * Records a whole turn's trace off the raw stream, for callers that have no
 * stream loop of their own. Both modes are consumed: `messages` carries the
 * streaming reasoning deltas and marks step boundaries as they happen, while
 * `values` carries the complete tool args and the token usage every model call
 * has to be counted from.
 */
export class TurnTraceRecorder {
  private readonly tracer: TurnTraceCollector
  private readonly userMessageId: string
  private readonly steppedMessageIds = new Set<string>()
  private readonly recordedModelMessageKeys = new Set<string>()
  private readonly recordedToolResultIds = new Set<string>()
  private readonly llmNodeByMessageKey = new Map<string, string>()
  private readonly toolNodeByRef = new Map<string, string>()
  private readonly reasoningByMessageId = new Map<string, string>()

  constructor(input: { tracer: TurnTraceCollector; userMessageId?: string }) {
    this.tracer = input.tracer
    this.userMessageId = input.userMessageId ?? ""
  }

  onStreamChunk(mode: string, data: unknown): void {
    try {
      if (mode === "messages") this.onMessagesPayload(data)
      else if (mode === "values") this.onValuesPayload(data)
    } catch (error) {
      // Tracing is observational; a malformed payload must not fail the turn.
      console.error("[TurnTrace] stream observation failed:", error)
    }
  }

  /**
   * Streaming deltas give the step boundary and the reasoning text. Tool args
   * here can still be mid-assembly, so the args recorded now are corrected by
   * the values snapshot, which the collector accepts over an empty input.
   */
  private onMessagesPayload(payload: unknown): void {
    const [message] = (Array.isArray(payload) ? payload : []) as [SerializedTraceMessage?]
    const kwargs = message?.kwargs
    if (!kwargs) return
    const className = traceMessageClassName(message)
    if (traceMessageRole(className, kwargs) !== "assistant") return

    const messageId = typeof kwargs.id === "string" ? kwargs.id : ""
    const streamedReasoning = extractVisibleReasoning(kwargs, MAX_TRACE_CONTENT + 1)
    if (messageId && streamedReasoning) {
      const existing = this.reasoningByMessageId.get(messageId) ?? ""
      const merged = className.includes("AIMessageChunk")
        ? isTraceReasoningTruncated(existing)
          ? existing
          : mergeStreamingReasoning(existing, streamedReasoning)
        : streamedReasoning
      this.reasoningByMessageId.set(messageId, truncateReasoningForTrace(merged, MAX_TRACE_CONTENT))
    }

    const toolCalls = Array.isArray(kwargs.tool_calls)
      ? (kwargs.tool_calls as TraceToolCallLike[])
      : []
    if (toolCalls.length === 0) return
    if (messageId && this.steppedMessageIds.has(messageId)) return
    if (messageId) this.steppedMessageIds.add(messageId)

    this.tracer.beginStep()
    for (const toolCall of toolCalls) {
      this.tracer.recordToolCall({
        name: traceToolCallName(toolCall),
        args: traceToolCallArgs(toolCall)
      })
    }
    this.tracer.endStep(extractTraceTextBlocks(kwargs.content))
  }

  private onValuesPayload(payload: unknown): void {
    const state = payload as { messages?: SerializedTraceMessage[] }
    const messages = Array.isArray(state?.messages) ? state.messages : []
    for (let i = this.turnStartIndex(messages); i < messages.length; i += 1) {
      const message = messages[i]
      const kwargs = message?.kwargs ?? {}
      const className = traceMessageClassName(message)
      const role = traceMessageRole(className, kwargs)
      if (role === "assistant") this.recordAssistantMessage(messages, i)
      else if (role === "tool") this.recordToolResult(kwargs, i)
    }
  }

  private recordAssistantMessage(messages: SerializedTraceMessage[], index: number): void {
    const kwargs = messages[index]?.kwargs ?? {}
    const providerMessageId = typeof kwargs.id === "string" ? kwargs.id : ""
    const messageKey =
      providerMessageId || `values:${index}:${stableTraceJson(kwargs.tool_calls ?? [])}`
    if (!this.recordedModelMessageKeys.has(messageKey)) {
      this.recordedModelMessageKeys.add(messageKey)
      const recorded = recordAssistantMessageTrace({
        tracer: this.tracer,
        messages,
        index,
        messageKey,
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(providerMessageId && this.reasoningByMessageId.has(providerMessageId)
          ? { streamedReasoning: this.reasoningByMessageId.get(providerMessageId) }
          : {})
      })
      this.llmNodeByMessageKey.set(messageKey, recorded.llmNodeId)
    }

    const toolCalls = Array.isArray(kwargs.tool_calls)
      ? (kwargs.tool_calls as TraceToolCallLike[])
      : []
    for (let index2 = 0; index2 < toolCalls.length; index2 += 1) {
      const toolCall = toolCalls[index2]
      const toolCallId = traceToolCallId(toolCall)
      const ref = toolCallId || `${messageKey}:${index2}`
      if (this.toolNodeByRef.has(ref)) continue
      const nodeId = recordToolCallTraceNode({
        tracer: this.tracer,
        toolCall,
        index: index2,
        llmMessageId: messageKey,
        ...(this.llmNodeByMessageKey.has(messageKey)
          ? { parentId: this.llmNodeByMessageKey.get(messageKey) }
          : {})
      })
      this.toolNodeByRef.set(ref, nodeId)
    }
  }

  private recordToolResult(kwargs: Record<string, unknown>, index: number): void {
    const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : ""
    const output = extractTraceText(kwargs.content)
    const messageId =
      typeof kwargs.id === "string"
        ? kwargs.id
        : `values-tool:${index}:${toolCallId}:${output.length}`
    if (this.recordedToolResultIds.has(messageId)) return
    this.recordedToolResultIds.add(messageId)
    recordToolResultTraceNode({
      tracer: this.tracer,
      kwargs,
      messageId,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolCallId && this.toolNodeByRef.has(toolCallId)
        ? { parentId: this.toolNodeByRef.get(toolCallId) }
        : {})
    })
  }

  /**
   * A values snapshot holds the whole thread, so recording starts at this
   * turn's user message — earlier turns already have traces of their own and
   * re-recording them would inflate this turn's model-call and token totals.
   */
  private turnStartIndex(messages: SerializedTraceMessage[]): number {
    if (this.userMessageId) {
      const anchored = messages.findIndex((message) => message?.kwargs?.id === this.userMessageId)
      if (anchored >= 0) return anchored + 1
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (traceMessageRole(traceMessageClassName(messages[i]), messages[i]?.kwargs) === "user") {
        return i + 1
      }
    }
    return 0
  }
}
