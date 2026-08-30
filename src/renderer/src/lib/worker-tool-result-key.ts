import type { Message } from "../types"

export interface ToolResultAssociation {
  content: string | unknown
  is_error?: boolean
}

type PendingToolCall = {
  identity: string
  rawToolCallId: string
  key: string
  scoped: boolean
  turn: number
}

function getWorkerTurnScope(messageId: string): { prefix: string; turn: number } | undefined {
  if (!messageId.startsWith("worker-turn-")) return undefined
  const separatorIndex = messageId.indexOf("::")
  if (separatorIndex < 0) return undefined
  const prefix = messageId.slice(0, separatorIndex + 2)
  const turnMatch = /-(\d+)::$/.exec(prefix)
  if (!turnMatch) return undefined
  return { prefix, turn: Number(turnMatch[1]) }
}

function getRawWorkerToolCallId(toolCallId: string): string {
  if (!toolCallId.startsWith("worker-turn-")) return toolCallId
  const separatorIndex = toolCallId.indexOf("::")
  return separatorIndex >= 0 ? toolCallId.slice(separatorIndex + 2) : toolCallId
}

export function getWorkerToolResultKey(
  messageId: string,
  toolCallId: string | undefined
): string | undefined {
  if (!toolCallId) return undefined
  const scope = getWorkerTurnScope(messageId)
  if (!scope) return toolCallId
  return toolCallId.startsWith(scope.prefix) ? toolCallId : `${scope.prefix}${toolCallId}`
}

export function getWorkerToolUiKey(
  messageId: string,
  toolCallId: string | undefined,
  index: number
): string {
  const resultIdentity = getWorkerToolResultKey(messageId, toolCallId)
  return `${messageId}::cmb-tool-call:${index}:${resultIdentity ?? "id-less"}`
}

export function buildToolResultAssociations(
  messages: readonly Message[]
): Map<string, ToolResultAssociation> {
  const pendingCalls: PendingToolCall[] = []
  const results = new Map<string, ToolResultAssociation>()
  let currentTurn = 0

  for (const message of messages) {
    const messageScope = getWorkerTurnScope(message.id)
    if (messageScope) currentTurn = messageScope.turn
    if (message.role === "user") {
      if (!messageScope) currentTurn += 1
      continue
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((toolCall, index) => {
        const identity = getWorkerToolResultKey(message.id, toolCall.id)
        if (!identity) return
        pendingCalls.push({
          identity,
          rawToolCallId: getRawWorkerToolCallId(toolCall.id),
          key: getWorkerToolUiKey(message.id, toolCall.id, index),
          scoped: messageScope !== undefined,
          turn: currentTurn
        })
      })
      continue
    }

    if (message.role !== "tool" || !message.tool_call_id) continue
    const identity = getWorkerToolResultKey(message.id, message.tool_call_id)
    if (!identity) continue
    const rawToolCallId = getRawWorkerToolCallId(message.tool_call_id)
    const rawCandidates = pendingCalls.filter(
      (pendingCall) => pendingCall.rawToolCallId === rawToolCallId
    )
    let candidates: PendingToolCall[]
    if (messageScope) {
      const exactCandidates = rawCandidates.filter(
        (pendingCall) => pendingCall.identity === identity
      )
      const sameTurnCandidates = rawCandidates.filter(
        (pendingCall) => pendingCall.turn === messageScope.turn
      )
      candidates =
        exactCandidates.length > 0
          ? exactCandidates
          : sameTurnCandidates.length > 0
            ? sameTurnCandidates
            : rawCandidates.length === 1 && !rawCandidates[0].scoped
              ? rawCandidates
              : []
    } else {
      const latestPendingTurn = rawCandidates.reduce(
        (latest, pendingCall) => Math.max(latest, pendingCall.turn),
        Number.NEGATIVE_INFINITY
      )
      candidates = rawCandidates.filter(
        (pendingCall) => pendingCall.turn === latestPendingTurn
      )
    }
    const pendingCall = candidates[0]
    if (!pendingCall) continue
    const pendingIndex = pendingCalls.indexOf(pendingCall)
    if (pendingIndex >= 0) pendingCalls.splice(pendingIndex, 1)
    results.set(pendingCall.key, {
      content: message.content,
      is_error: message.is_error === true || message.status === "error"
    })
  }

  return results
}
