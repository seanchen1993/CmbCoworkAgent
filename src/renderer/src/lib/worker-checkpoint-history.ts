import type { Message } from "@/types"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds
} from "../../../shared/message-role-collision"

export const MAX_WORKER_HISTORY_MESSAGES = 500

export function hasVisibleWorkerMessageContent(message: Message): boolean {
  if (typeof message.content === "string") return message.content.length > 0
  return Array.isArray(message.content) && message.content.length > 0
}

function checkpointContentText(content: Message["content"]): string {
  if (typeof content === "string") return content
  return content
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : ""
    )
    .join("")
}

export function mergeWorkerCheckpointSparseContent(
  historyMessage: Message,
  liveMessage: Message
): Message["content"] {
  if (!hasVisibleWorkerMessageContent(liveMessage)) return historyMessage.content
  if (
    Array.isArray(historyMessage.content) &&
    typeof liveMessage.content === "string" &&
    checkpointContentText(historyMessage.content) === liveMessage.content
  ) {
    return historyMessage.content
  }
  return liveMessage.content
}

export function checkpointHistoryMessageMatchesSparseLive(
  historyMessage: Message,
  liveMessage: Message
): boolean {
  if (historyMessage.role !== liveMessage.role) return false
  if (getMessageProviderSourceId(historyMessage) !== getMessageProviderSourceId(liveMessage)) {
    return false
  }
  if (hasVisibleWorkerMessageContent(liveMessage)) {
    if (typeof liveMessage.content === "string") {
      if (checkpointContentText(historyMessage.content) !== liveMessage.content) return false
    } else if (JSON.stringify(historyMessage.content) !== JSON.stringify(liveMessage.content)) {
      return false
    }
  }
  if (historyMessage.role === "assistant") {
    const liveToolCalls = liveMessage.tool_calls
    if (!liveToolCalls?.length) return true
    const historyToolCalls = historyMessage.tool_calls
    if (!historyToolCalls?.length || historyToolCalls.length < liveToolCalls.length) return false
    const usedHistoryIndexes = new Set<number>()
    return liveToolCalls.every((toolCall, index) => {
      const historyIndex = toolCall.id
        ? historyToolCalls.findIndex(
            (historyToolCall, candidateIndex) =>
              !usedHistoryIndexes.has(candidateIndex) && historyToolCall.id === toolCall.id
          )
        : historyToolCalls.findIndex(
            (historyToolCall, candidateIndex) =>
              !usedHistoryIndexes.has(candidateIndex) &&
              !historyToolCall.id &&
              historyToolCall.name === toolCall.name &&
              (candidateIndex === index || toolCall.name !== undefined)
          )
      if (historyIndex < 0) return false
      const historyToolCall = historyToolCalls[historyIndex]
      if (historyToolCall.name && toolCall.name && historyToolCall.name !== toolCall.name) {
        return false
      }
      usedHistoryIndexes.add(historyIndex)
      return true
    })
  }
  if (historyMessage.role === "tool") {
    return (
      historyMessage.tool_call_id === liveMessage.tool_call_id &&
      (!historyMessage.name || !liveMessage.name || historyMessage.name === liveMessage.name)
    )
  }
  return true
}

export function isCompleteWorkerSnapshotCoveringHistory(
  historyMessages: readonly Message[],
  liveMessages: readonly Message[]
): boolean {
  if (historyMessages.length === 0 || liveMessages.length < historyMessages.length) return false

  const normalizedHistoryMessages = normalizeCompleteMessageIds(historyMessages)
  const liveOffset = liveMessages.length - historyMessages.length
  return historyMessages.every(
    (message, index) => {
      const liveMessage = liveMessages[liveOffset + index]
      const normalizedHistoryMessage = normalizedHistoryMessages[index]
      return (
        checkpointHistoryMessageMatchesSparseLive(message, liveMessage) &&
        workerSameRoleOccurrencesAlign(normalizedHistoryMessage, liveMessage)
      )
    }
  )
}

export function getWorkerSameRoleOccurrence(message: Message): number {
  return getMessageProviderOccurrence(message) ?? 1
}

export function isExplicitWorkerOccurrenceAfter(
  historyMessage: Message,
  liveMessage: Message
): boolean {
  return (
    historyMessage.role === liveMessage.role &&
    getMessageProviderSourceId(historyMessage) === getMessageProviderSourceId(liveMessage) &&
    getMessageProviderOccurrence(liveMessage) !== undefined &&
    getWorkerSameRoleOccurrence(liveMessage) > getWorkerSameRoleOccurrence(historyMessage)
  )
}

function workerSameRoleOccurrencesAlign(
  historyMessage: Message,
  liveMessage: Message
): boolean {
  const historyHasOccurrence = getMessageProviderOccurrence(historyMessage) !== undefined
  const liveHasOccurrence = getMessageProviderOccurrence(liveMessage) !== undefined
  if (!historyHasOccurrence && !liveHasOccurrence) return true
  return getWorkerSameRoleOccurrence(historyMessage) === getWorkerSameRoleOccurrence(liveMessage)
}

export function normalizeWorkerMessagesAfterHistory(
  historyMessages: readonly Message[],
  messages: readonly Message[]
): Message[] {
  return normalizeAppendedMessageIds(normalizeCompleteMessageIds(historyMessages), messages, {
    splitAssistantAfterTool: true,
    forceAppend: true
  })
}

type SerializedCheckpointMessage = {
  id?: string | string[]
  _getType?: () => string
  type?: string
  content?: Message["content"]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
  status?: string
  is_error?: boolean
  additional_kwargs?: Record<string, unknown>
  kwargs?: {
    id?: string
    type?: string
    content?: Message["content"]
    tool_calls?: Message["tool_calls"]
    tool_call_id?: string
    name?: string
    status?: string
    is_error?: boolean
    additional_kwargs?: Record<string, unknown>
  }
}

function createWorkerSnapshotFallbackMessageId(index: number): string {
  return `worker-snapshot-${index}`
}

function createWorkerTurnScopedMessageId(
  workerThreadId: string,
  rawId: string,
  workerTurn: number
): string {
  const prefix = `worker-turn-${workerThreadId}-${workerTurn}::`
  return rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`
}

function messageRoleFromCheckpoint(message: SerializedCheckpointMessage): Message["role"] {
  if (typeof message._getType === "function") {
    const type = message._getType()
    if (type === "human") return "user"
    if (type === "tool") return "tool"
    if (type === "system") return "system"
    return "assistant"
  }

  const classId = Array.isArray(message.id) ? message.id : []
  const className = classId[classId.length - 1] || ""
  if (className.includes("HumanMessage")) return "user"
  if (className.includes("ToolMessage")) return "tool"
  if (className.includes("SystemMessage")) return "system"
  if (className.includes("AIMessage")) return "assistant"

  const type = message.type ?? message.kwargs?.type
  if (type === "human" || type === "user") return "user"
  if (type === "tool") return "tool"
  if (type === "system") return "system"
  return "assistant"
}

function messageFromCheckpoint(
  message: SerializedCheckpointMessage,
  index: number,
  workerThreadId?: string,
  workerTurn?: number
): Message | null {
  const additionalKwargs = message.additional_kwargs ?? message.kwargs?.additional_kwargs
  if (additionalKwargs?.cmb_internal_coordinator_notification === true) return null

  const role = messageRoleFromCheckpoint(message)
  if (role === "system") return null

  const rawContent = message.content ?? message.kwargs?.content
  const content: Message["content"] =
    typeof rawContent === "string" || Array.isArray(rawContent) ? rawContent : ""
  const toolCalls = message.tool_calls ?? message.kwargs?.tool_calls
  const toolCallId = message.tool_call_id ?? message.kwargs?.tool_call_id
  const toolName = message.name ?? message.kwargs?.name
  const toolStatus = message.status ?? message.kwargs?.status
  const isToolError =
    message.is_error === true ||
    message.kwargs?.is_error === true ||
    additionalKwargs?.is_error === true ||
    toolStatus === "error"
  const rawMessageId =
    message.kwargs?.id ??
    (typeof message.id === "string" ? message.id : createWorkerSnapshotFallbackMessageId(index))
  const messageId =
    workerThreadId && workerTurn
      ? createWorkerTurnScopedMessageId(workerThreadId, rawMessageId, workerTurn)
      : rawMessageId

  return {
    id: messageId,
    role,
    content,
    tool_calls: toolCalls,
    ...(role === "tool" && toolCallId && { tool_call_id: toolCallId }),
    ...(role === "tool" && toolName && { name: toolName }),
    ...(role === "tool" && toolStatus && { status: toolStatus }),
    ...(role === "tool" && isToolError && { is_error: true }),
    created_at: new Date()
  }
}

export function buildWorkerCheckpointHistory(
  rawMessages: readonly unknown[],
  workerThreadId: string
): { messages: Message[]; truncatedCount: number } {
  let workerTurn = 0
  const workerTurnByIndex = rawMessages.map((rawMessage) => {
    if (
      rawMessage &&
      typeof rawMessage === "object" &&
      !Array.isArray(rawMessage) &&
      messageRoleFromCheckpoint(rawMessage as SerializedCheckpointMessage) === "user" &&
      (rawMessage as SerializedCheckpointMessage).additional_kwargs
        ?.cmb_internal_coordinator_notification !== true &&
      (rawMessage as SerializedCheckpointMessage).kwargs?.additional_kwargs
        ?.cmb_internal_coordinator_notification !== true
    ) {
      workerTurn += 1
    }
    return workerTurn > 0 ? workerTurn : undefined
  })
  const startIndex = Math.max(0, rawMessages.length - MAX_WORKER_HISTORY_MESSAGES)
  const indexedMessages = rawMessages
    .map((rawMessage, absoluteIndex) => {
      if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) return null
      const message = messageFromCheckpoint(
        rawMessage as SerializedCheckpointMessage,
        absoluteIndex,
        workerThreadId,
        workerTurnByIndex[absoluteIndex]
      )
      return message ? { absoluteIndex, message } : null
    })
    .filter((entry): entry is { absoluteIndex: number; message: Message } => entry !== null)
  const normalizedMessages = normalizeCompleteMessageIds(
    indexedMessages.map((entry) => entry.message)
  )
  const messages = normalizedMessages.filter(
    (_, index) => indexedMessages[index].absoluteIndex >= startIndex
  )
  return { messages, truncatedCount: startIndex }
}
