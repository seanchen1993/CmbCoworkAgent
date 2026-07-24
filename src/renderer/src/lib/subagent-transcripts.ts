import type { Message } from "../types"

export const SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY = "subagentTranscripts"

const MAX_SUBAGENT_TRANSCRIPT_MESSAGES = 1_000
// Per-message content hard cap. Tool results (e.g. a large file read or a
// directory listing) can be huge; the transcript keeps a head+tail slice so the
// most useful parts (start + the end/error) survive while bounding stored size.
const MAX_TRANSCRIPT_MESSAGE_CHARS = 24_000
// Per-subagent total content budget. Independent of the message-count cap so a
// burst of large results can't bloat persisted thread values; oldest messages
// are dropped first once the budget is exceeded.
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 512_000

/**
 * Clamp a single message's string content to MAX_TRANSCRIPT_MESSAGE_CHARS,
 * keeping a head and a tail with a marker for the omitted middle. Non-string
 * (block) content is left untouched — it is bounded elsewhere and rarely large.
 */
function clampTranscriptContent(content: Message["content"]): Message["content"] {
  if (typeof content !== "string" || content.length <= MAX_TRANSCRIPT_MESSAGE_CHARS) {
    return content
  }
  const head = Math.floor(MAX_TRANSCRIPT_MESSAGE_CHARS * 0.7)
  const tail = MAX_TRANSCRIPT_MESSAGE_CHARS - head
  const omitted = content.length - head - tail
  return `${content.slice(0, head)}\n…[省略 ${omitted} 字]…\n${content.slice(-tail)}`
}

/**
 * Drop oldest messages until the total content is within the per-subagent byte
 * budget. Always keeps at least the most recent message.
 */
function enforceTranscriptByteBudget(messages: Message[]): Message[] {
  let total = 0
  for (const message of messages) total += messageContentLength(message.content)
  if (total <= MAX_SUBAGENT_TRANSCRIPT_BYTES) return messages

  let start = 0
  while (start < messages.length - 1 && total > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
    total -= messageContentLength(messages[start].content)
    start += 1
  }
  return start > 0 ? messages.slice(start) : messages
}

function messageContentLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasNonEmptyArgs(args: unknown): args is Record<string, unknown> {
  return isRecord(args) && Object.keys(args).length > 0
}

function mergeToolCallArgs(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (hasNonEmptyArgs(incoming)) return incoming
  if (hasNonEmptyArgs(existing)) return existing
  return incoming ?? existing ?? {}
}

function mergeTranscriptToolCalls(
  existing: Message["tool_calls"] | undefined,
  incoming: Message["tool_calls"] | undefined
): Message["tool_calls"] | undefined {
  if (!incoming || incoming.length === 0) return existing
  if (!existing || existing.length === 0) return incoming

  const next = [...existing]
  const indexById = new Map<string, number>()
  next.forEach((toolCall, index) => {
    if (toolCall.id) indexById.set(toolCall.id, index)
  })

  for (const toolCall of incoming) {
    const existingIndex = toolCall.id ? indexById.get(toolCall.id) : undefined
    if (existingIndex !== undefined) {
      next[existingIndex] = {
        ...next[existingIndex],
        ...toolCall,
        args: mergeToolCallArgs(next[existingIndex].args, toolCall.args)
      }
      continue
    }
    if (toolCall.id) indexById.set(toolCall.id, next.length)
    next.push(toolCall)
  }

  return next
}

function followingToolMessages(messages: Message[], assistantIndex: number): Message[] {
  const result: Message[] = []
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "tool") break
    if (message.tool_call_id) result.push(message)
  }
  return result
}

function findMatchingToolMessageIndex(
  toolCall: NonNullable<Message["tool_calls"]>[number],
  toolMessages: Message[],
  usedIndexes: Set<number>,
  toolCallIndex: number,
  toolCallCount: number
): number | undefined {
  const namedMatchIndex = toolMessages.findIndex(
    (message, index) =>
      !usedIndexes.has(index) &&
      Boolean(message.tool_call_id) &&
      Boolean(toolCall.name) &&
      message.name === toolCall.name
  )
  if (namedMatchIndex >= 0) return namedMatchIndex

  if (
    toolMessages.length === toolCallCount &&
    toolMessages[toolCallIndex]?.tool_call_id &&
    !usedIndexes.has(toolCallIndex)
  ) {
    return toolCallIndex
  }

  if (toolCallCount === 1 && toolMessages.length === 1 && !usedIndexes.has(0)) {
    return 0
  }

  return undefined
}

function dedupeToolCallsById(
  toolCalls: NonNullable<Message["tool_calls"]>
): NonNullable<Message["tool_calls"]> {
  const result: NonNullable<Message["tool_calls"]> = []
  const indexById = new Map<string, number>()

  for (const toolCall of toolCalls) {
    if (!toolCall.id) {
      result.push(toolCall)
      continue
    }

    const existingIndex = indexById.get(toolCall.id)
    if (existingIndex === undefined) {
      indexById.set(toolCall.id, result.length)
      result.push(toolCall)
      continue
    }

    const existing = result[existingIndex]
    result[existingIndex] = {
      ...existing,
      ...toolCall,
      name: toolCall.name || existing.name,
      args: mergeToolCallArgs(existing.args, toolCall.args)
    }
  }

  return result
}

export function getSubagentTranscriptDisplayStats(messages: Message[]): {
  visibleMessageCount: number
  toolCallCount: number
  toolResultCount: number
} {
  let visibleMessageCount = 0
  let toolCallCount = 0
  let toolResultCount = 0

  for (const message of messages) {
    if (message.role === "tool") {
      toolResultCount += 1
      continue
    }
    visibleMessageCount += 1
    toolCallCount += message.tool_calls?.length ?? 0
  }

  return { visibleMessageCount, toolCallCount, toolResultCount }
}

export function reconcileTranscriptToolCallsWithResults(messages: Message[]): Message[] {
  let changed = false
  const reconciled = messages.map((message, index) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message

    const toolMessages = followingToolMessages(messages, index)
    if (toolMessages.length === 0) return message

    const usedToolMessageIndexes = new Set<number>()
    const exactResultIds = new Set(toolMessages.map((toolMessage) => toolMessage.tool_call_id))
    const nextToolCalls = message.tool_calls.map((toolCall, toolCallIndex) => {
      if (toolCall.id && exactResultIds.has(toolCall.id)) {
        const exactIndex = toolMessages.findIndex(
          (toolMessage) => toolMessage.tool_call_id === toolCall.id
        )
        if (exactIndex >= 0) usedToolMessageIndexes.add(exactIndex)
        return toolCall
      }

      const matchIndex = findMatchingToolMessageIndex(
        toolCall,
        toolMessages,
        usedToolMessageIndexes,
        toolCallIndex,
        message.tool_calls!.length
      )
      if (matchIndex === undefined) return toolCall

      const toolMessage = toolMessages[matchIndex]
      if (!toolMessage.tool_call_id) return toolCall

      usedToolMessageIndexes.add(matchIndex)
      changed = true
      return {
        ...toolCall,
        id: toolMessage.tool_call_id,
        name: toolCall.name || toolMessage.name || "tool"
      }
    })

    const dedupedToolCalls = dedupeToolCallsById(nextToolCalls)
    if (dedupedToolCalls.length !== nextToolCalls.length) changed = true
    return changed ? { ...message, tool_calls: dedupedToolCalls } : message
  })

  return changed ? reconciled : messages
}

export function mergeTranscriptMessage(existing: Message, incoming: Message): Message {
  const existingContentLength = messageContentLength(existing.content)
  const incomingContentLength = messageContentLength(incoming.content)
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    content:
      incomingContentLength >= existingContentLength
        ? (incoming.content ?? existing.content)
        : (existing.content ?? incoming.content),
    tool_calls: mergeTranscriptToolCalls(existing.tool_calls, incoming.tool_calls),
    status: incoming.status ?? existing.status,
    is_error: incoming.is_error ?? existing.is_error
  }
}

export function upsertTranscriptMessages(messages: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return messages
  const next = [...messages]
  const indexById = new Map(next.map((message, index) => [message.id, index]))
  for (const rawMessage of incoming) {
    // Clamp oversized content (e.g. large tool results) before storing so a
    // single message can't bloat memory or the persisted thread values.
    const message =
      typeof rawMessage.content === "string"
        ? { ...rawMessage, content: clampTranscriptContent(rawMessage.content) }
        : rawMessage
    const existingIndex = indexById.get(message.id)
    if (existingIndex === undefined) {
      indexById.set(message.id, next.length)
      next.push(message)
      continue
    }
    next[existingIndex] = mergeTranscriptMessage(next[existingIndex], message)
  }
  const countCapped =
    next.length > MAX_SUBAGENT_TRANSCRIPT_MESSAGES
      ? next.slice(-MAX_SUBAGENT_TRANSCRIPT_MESSAGES)
      : next
  return enforceTranscriptByteBudget(countCapped)
}

export function mergeSubagentTranscripts(
  current: Record<string, Message[]>,
  subagentId: string,
  messages: Message[]
): Record<string, Message[]> {
  return {
    ...current,
    [subagentId]: upsertTranscriptMessages(current[subagentId] ?? [], messages)
  }
}

function revivePersistedDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  return new Date()
}

function revivePersistedSubagentMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === "string" ? value.id : ""
  const role = typeof value.role === "string" ? value.role : ""
  if (!id || !["user", "assistant", "system", "tool"].includes(role)) return null
  const rawContent = value.content
  const content: Message["content"] =
    typeof rawContent === "string" || Array.isArray(rawContent) ? rawContent : ""
  return {
    id,
    role: role as Message["role"],
    content,
    ...(Array.isArray(value.tool_calls) && {
      tool_calls: value.tool_calls as Message["tool_calls"]
    }),
    ...(typeof value.tool_call_id === "string" && { tool_call_id: value.tool_call_id }),
    ...(typeof value.name === "string" && { name: value.name }),
    ...(typeof value.status === "string" && { status: value.status }),
    ...(typeof value.is_error === "boolean" && { is_error: value.is_error }),
    created_at: revivePersistedDate(value.created_at),
    ...(value.start_at !== undefined && { start_at: revivePersistedDate(value.start_at) }),
    ...(value.end_at !== undefined && { end_at: revivePersistedDate(value.end_at) })
  }
}

export function getSubagentTranscriptsFromThreadValues(
  threadValues?: Record<string, unknown>
): Record<string, Message[]> {
  const value = threadValues?.[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([subagentId, messages]) => [
        subagentId,
        // Route restored messages through the same pipeline as live writes so
        // legacy data written before per-message clamping / byte budgeting gets
        // clamped and trimmed on load instead of bloating memory.
        Array.isArray(messages)
          ? upsertTranscriptMessages(
              [],
              messages
                .map(revivePersistedSubagentMessage)
                .filter((message): message is Message => message !== null)
            )
          : []
      ])
      .filter(([, messages]) => messages.length > 0)
  )
}

function serializeSubagentMessage(message: Message): Record<string, unknown> {
  return {
    ...message,
    created_at: message.created_at.toISOString(),
    ...(message.start_at && { start_at: message.start_at.toISOString() }),
    ...(message.end_at && { end_at: message.end_at.toISOString() })
  }
}

export function serializeSubagentTranscripts(
  transcripts: Record<string, Message[]>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(transcripts).map(([subagentId, messages]) => [
      subagentId,
      messages.slice(-MAX_SUBAGENT_TRANSCRIPT_MESSAGES).map(serializeSubagentMessage)
    ])
  )
}
