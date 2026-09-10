import {
  extractVisibleReasoning,
  isTraceReasoningTruncated,
  mergeStreamingReasoning,
  truncateReasoningForTrace
} from "../../shared/model-reasoning"
import {
  readStreamMessageWireMode,
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY,
  type StreamMessageWireMode
} from "../../shared/stream-message-wire-mode"

interface PlainRecord {
  [key: string]: unknown
}

interface MergeableAiChunk {
  key: string
  id: string
  payload: unknown[]
  visibleText: string
}

interface AiReasoningObservation {
  id: string
  reasoning: string
  mode: StreamMessageWireMode
}

interface BufferedAggregate {
  kind: "aggregate"
  key: string
  id: string
  latestPayload: unknown[]
  textBlocks: string[]
  pendingBlockParts: string[]
  pendingBlockChars: number
  pendingTextParts: string[]
  pendingTextChars: number
  finalReasoning?: string
}

interface BufferedPayload {
  kind: "payload"
  payload: unknown
}

type BufferedEntry = BufferedAggregate | BufferedPayload

export interface StreamMessageSideEffectBuffer {
  push: (payload: unknown) => void
  drain: () => unknown[]
  clear: () => void
  readonly pendingItemCount: number
  readonly retainedFragmentCount: number
}

export interface StreamMessageSideEffectBufferOptions {
  getReasoningSeed?: (messageId: string) => string | undefined
  reasoningLimit?: number
}

const REASONING_KEYS = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_text",
  "reasoning_details",
  "summary",
  "details",
  "delta"
])

const FORBIDDEN_ADDITIONAL_KWARGS = new Set([
  "tool_calls",
  "tool_call_chunks",
  "tool_call_id",
  "name",
  "status",
  "is_error",
  "cmb_internal_coordinator_notification",
  "cmb_coordinator_augmented_user_message",
  "cmb_visible_user_message"
])

const premergedReasoningByPayload = new WeakMap<object, string>()
const MAX_PENDING_TEXT_PARTS = 256
const MAX_PENDING_TEXT_CHARS = 32 * 1024

function asRecord(value: unknown): PlainRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PlainRecord)
    : undefined
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function withoutReasoningFields(record: PlainRecord | undefined): PlainRecord | undefined {
  if (!record) return undefined
  const result: PlainRecord = {}
  for (const [key, value] of Object.entries(record)) {
    if (!REASONING_KEYS.has(key)) result[key] = value
  }
  return result
}

function hasForbiddenAdditionalKwargs(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return value !== undefined && value !== null
  return Object.keys(record).some((key) => FORBIDDEN_ADDITIONAL_KWARGS.has(key))
}

function mergeableVisibleText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const textParts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (!record || record.type !== "text" || typeof record.text !== "string") {
      return undefined
    }
    textParts.push(record.text)
  }
  return textParts.join("")
}

function analyzeMergeableAiChunk(payload: unknown): MergeableAiChunk | undefined {
  if (!Array.isArray(payload) || payload.length === 0) return undefined
  const message = asRecord(payload[0])
  const kwargs = asRecord(message?.kwargs)
  const classId = Array.isArray(message?.id) ? message.id : []
  if (classId.at(-1) !== "AIMessageChunk" || !kwargs) return undefined
  const metadata = asRecord(payload[1])
  if (metadata?.[STREAM_MESSAGE_CONTENT_MODE_KEY] === "snapshot") return undefined

  const id = typeof kwargs.id === "string" ? kwargs.id.trim() : ""
  const visibleText = mergeableVisibleText(kwargs.content)
  if (!id || visibleText === undefined) return undefined
  if (
    kwargs.tool_call_id !== undefined ||
    kwargs.name !== undefined ||
    kwargs.status !== undefined ||
    kwargs.is_error !== undefined ||
    (Array.isArray(kwargs.tool_calls) && kwargs.tool_calls.length > 0) ||
    hasForbiddenAdditionalKwargs(kwargs.additional_kwargs)
  ) {
    return undefined
  }

  const staticMessage = { ...message }
  delete staticMessage.kwargs
  delete staticMessage.content
  const staticKwargs = { ...kwargs }
  delete staticKwargs.content
  delete staticKwargs.response_metadata
  delete staticKwargs.usage_metadata
  // Delayed side effects consume only finalized `tool_calls`; streamed arg
  // fragments are persisted/forwarded before this attempt-local buffer.
  delete staticKwargs.tool_call_chunks
  for (const key of REASONING_KEYS) delete staticKwargs[key]
  if (staticKwargs.additional_kwargs !== undefined) {
    staticKwargs.additional_kwargs = withoutReasoningFields(
      asRecord(staticKwargs.additional_kwargs)
    )
  }

  const signature = stableJson({
    message: staticMessage,
    kwargs: staticKwargs,
    metadata: payload.slice(1)
  })
  if (signature === undefined) return undefined

  return {
    key: `${id}\u0000${signature}`,
    id,
    payload,
    visibleText
  }
}

function analyzeAiReasoningObservation(
  payload: unknown,
  reasoningLimit: number
): AiReasoningObservation | undefined {
  if (!Array.isArray(payload) || payload.length === 0) return undefined
  const message = asRecord(payload[0])
  const kwargs = asRecord(message?.kwargs)
  const classId = Array.isArray(message?.id) ? message.id : []
  const className = typeof classId.at(-1) === "string" ? classId.at(-1)! : ""
  const id = typeof kwargs?.id === "string" ? kwargs.id.trim() : ""
  if (!id || (!className.includes("AI") && kwargs?.type !== "ai")) return undefined
  const reasoning = extractVisibleReasoning(kwargs, reasoningLimit + 1)
  const metadata = asRecord(payload[1])
  const mode =
    readStreamMessageWireMode(metadata?.[STREAM_MESSAGE_REASONING_MODE_KEY]) ??
    (className.includes("AIMessageChunk") ? "delta" : "snapshot")
  return reasoning ? { id, reasoning, mode } : undefined
}

function materializeAggregate(entry: BufferedAggregate): unknown[] {
  const [rawMessage, ...metadata] = entry.latestPayload
  const message = asRecord(rawMessage) ?? {}
  const kwargs = asRecord(message.kwargs) ?? {}
  const payload = [
    {
      ...message,
      kwargs: {
        ...kwargs,
        content: entry.textBlocks
          .concat(entry.pendingBlockParts, entry.pendingTextParts)
          .join("")
      }
    },
    ...metadata
  ]
  if (entry.finalReasoning !== undefined) {
    premergedReasoningByPayload.set(payload, entry.finalReasoning)
  }
  return payload
}

function flushPendingTextBlock(entry: BufferedAggregate): void {
  if (entry.pendingTextParts.length === 0) return
  const block = entry.pendingTextParts.join("")
  entry.pendingBlockParts.push(block)
  entry.pendingBlockChars += block.length
  entry.pendingTextParts = []
  entry.pendingTextChars = 0
  if (
    entry.pendingBlockParts.length >= 128 ||
    entry.pendingBlockChars >= MAX_PENDING_TEXT_CHARS
  ) {
    entry.textBlocks.push(entry.pendingBlockParts.join(""))
    entry.pendingBlockParts = []
    entry.pendingBlockChars = 0
  }
}

function appendVisibleText(entry: BufferedAggregate, text: string): void {
  if (!text) return
  if (text.length >= MAX_PENDING_TEXT_CHARS) {
    flushPendingTextBlock(entry)
    if (entry.pendingBlockParts.length > 0) {
      entry.textBlocks.push(entry.pendingBlockParts.join(""))
      entry.pendingBlockParts = []
      entry.pendingBlockChars = 0
    }
    entry.textBlocks.push(text)
    return
  }
  entry.pendingTextParts.push(text)
  entry.pendingTextChars += text.length
  if (
    entry.pendingTextParts.length >= MAX_PENDING_TEXT_PARTS ||
    entry.pendingTextChars >= MAX_PENDING_TEXT_CHARS
  ) {
    flushPendingTextBlock(entry)
  }
}

export function getPremergedStreamSideEffectReasoning(payload: unknown): string | undefined {
  return payload && typeof payload === "object"
    ? premergedReasoningByPayload.get(payload)
    : undefined
}

/**
 * Keep attempt-local side effects rollback-safe without retaining one complete
 * serialized object per token. Only adjacent, structurally identical plain
 * AI text/reasoning chunks are folded; lifecycle/tool payloads stay FIFO.
 */
export function createStreamMessageSideEffectBuffer(
  options: StreamMessageSideEffectBufferOptions = {}
): StreamMessageSideEffectBuffer {
  const entries: BufferedEntry[] = []
  const predictedReasoningById = new Map<string, string>()
  const reasoningLimit = Math.max(1, Math.floor(options.reasoningLimit ?? 2_000))

  const observeReasoning = (observation: AiReasoningObservation): string => {
    const existing =
      predictedReasoningById.get(observation.id) ??
      options.getReasoningSeed?.(observation.id) ??
      ""
    const next = observation.mode === "delta"
      ? isTraceReasoningTruncated(existing)
        ? existing
        : truncateReasoningForTrace(
            mergeStreamingReasoning(existing, observation.reasoning),
            reasoningLimit
          )
      : truncateReasoningForTrace(observation.reasoning, reasoningLimit)
    predictedReasoningById.set(observation.id, next)
    return next
  }

  return {
    push(payload) {
      const observation = analyzeAiReasoningObservation(payload, reasoningLimit)
      if (observation) observeReasoning(observation)
      const candidate = analyzeMergeableAiChunk(payload)
      if (!candidate) {
        entries.push({ kind: "payload", payload })
        return
      }

      const finalReasoning = predictedReasoningById.get(candidate.id)
      const previous = entries.at(-1)
      if (previous?.kind === "aggregate" && previous.key === candidate.key) {
        previous.latestPayload = candidate.payload
        appendVisibleText(previous, candidate.visibleText)
        previous.finalReasoning = finalReasoning
        return
      }

      const entry: BufferedAggregate = {
        kind: "aggregate",
        key: candidate.key,
        id: candidate.id,
        latestPayload: candidate.payload,
        textBlocks: [],
        pendingBlockParts: [],
        pendingBlockChars: 0,
        pendingTextParts: [],
        pendingTextChars: 0,
        finalReasoning
      }
      appendVisibleText(entry, candidate.visibleText)
      entries.push(entry)
    },
    drain() {
      const payloads = entries.map((entry) =>
        entry.kind === "aggregate" ? materializeAggregate(entry) : entry.payload
      )
      entries.length = 0
      predictedReasoningById.clear()
      return payloads
    },
    clear() {
      entries.length = 0
      predictedReasoningById.clear()
    },
    get pendingItemCount() {
      return entries.length
    },
    get retainedFragmentCount() {
      return entries.reduce(
        (count, entry) =>
          count +
          (entry.kind === "aggregate"
            ? entry.textBlocks.length +
              entry.pendingBlockParts.length +
              entry.pendingTextParts.length
            : 1),
        0
      )
    }
  }
}
