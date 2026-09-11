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
  active: boolean
}

interface PendingToolCallQueue {
  items: PendingToolCall[]
  cursor: number
}

interface PendingToolCallBucket {
  ordered: PendingToolCallQueue
  byIdentity: Map<string, PendingToolCallQueue>
  byTurn: Map<number, PendingToolCallQueue>
  activeCount: number
  activeCountByTurn: Map<number, number>
  maxTurnHeap: number[]
}

function enqueuePendingToolCall(
  queues: Map<string, PendingToolCallQueue>,
  key: string,
  pendingCall: PendingToolCall
): void {
  const queue = queues.get(key) ?? { items: [], cursor: 0 }
  queue.items.push(pendingCall)
  queues.set(key, queue)
}

function enqueuePendingToolCallByTurn(
  queues: Map<number, PendingToolCallQueue>,
  turn: number,
  pendingCall: PendingToolCall
): void {
  const queue = queues.get(turn) ?? { items: [], cursor: 0 }
  queue.items.push(pendingCall)
  queues.set(turn, queue)
}

function firstActivePendingToolCall(
  queue: PendingToolCallQueue | undefined
): PendingToolCall | undefined {
  if (!queue) return undefined
  while (queue.cursor < queue.items.length && !queue.items[queue.cursor].active) {
    queue.cursor += 1
  }
  return queue.items[queue.cursor]
}

function pushMaxTurn(heap: number[], turn: number): void {
  heap.push(turn)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent] >= heap[index]) break
    ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
    index = parent
  }
}

function popMaxTurn(heap: number[]): number | undefined {
  if (heap.length === 0) return undefined
  const maximum = heap[0]
  const tail = heap.pop()
  if (heap.length > 0 && tail !== undefined) {
    heap[0] = tail
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let largest = index
      if (left < heap.length && heap[left] > heap[largest]) largest = left
      if (right < heap.length && heap[right] > heap[largest]) largest = right
      if (largest === index) break
      ;[heap[index], heap[largest]] = [heap[largest], heap[index]]
      index = largest
    }
  }
  return maximum
}

function latestActiveTurn(bucket: PendingToolCallBucket): number | undefined {
  while (bucket.maxTurnHeap.length > 0) {
    const turn = bucket.maxTurnHeap[0]
    if ((bucket.activeCountByTurn.get(turn) ?? 0) > 0) return turn
    popMaxTurn(bucket.maxTurnHeap)
  }
  return undefined
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
  const pendingCallsByRawId = new Map<string, PendingToolCallBucket>()
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
        const rawToolCallId = getRawWorkerToolCallId(toolCall.id)
        const pendingCall: PendingToolCall = {
          identity,
          rawToolCallId,
          key: getWorkerToolUiKey(message.id, toolCall.id, index),
          scoped: messageScope !== undefined,
          turn: currentTurn,
          active: true
        }
        const bucket = pendingCallsByRawId.get(rawToolCallId) ?? {
          ordered: { items: [], cursor: 0 },
          byIdentity: new Map<string, PendingToolCallQueue>(),
          byTurn: new Map<number, PendingToolCallQueue>(),
          activeCount: 0,
          activeCountByTurn: new Map<number, number>(),
          maxTurnHeap: []
        }
        bucket.ordered.items.push(pendingCall)
        enqueuePendingToolCall(bucket.byIdentity, identity, pendingCall)
        enqueuePendingToolCallByTurn(bucket.byTurn, currentTurn, pendingCall)
        bucket.activeCount += 1
        const previousTurnCount = bucket.activeCountByTurn.get(currentTurn) ?? 0
        if (previousTurnCount === 0) pushMaxTurn(bucket.maxTurnHeap, currentTurn)
        bucket.activeCountByTurn.set(currentTurn, previousTurnCount + 1)
        pendingCallsByRawId.set(rawToolCallId, bucket)
      })
      continue
    }

    if (message.role !== "tool" || !message.tool_call_id) continue
    const identity = getWorkerToolResultKey(message.id, message.tool_call_id)
    if (!identity) continue
    const rawToolCallId = getRawWorkerToolCallId(message.tool_call_id)
    const bucket = pendingCallsByRawId.get(rawToolCallId)
    if (!bucket) continue
    let pendingCall: PendingToolCall | undefined
    if (messageScope) {
      pendingCall =
        firstActivePendingToolCall(bucket.byIdentity.get(identity)) ??
        firstActivePendingToolCall(bucket.byTurn.get(messageScope.turn))
      if (!pendingCall && bucket.activeCount === 1) {
        const onlyPendingCall = firstActivePendingToolCall(bucket.ordered)
        if (onlyPendingCall && !onlyPendingCall.scoped) pendingCall = onlyPendingCall
      }
    } else {
      const latestPendingTurn = latestActiveTurn(bucket)
      if (latestPendingTurn !== undefined) {
        pendingCall = firstActivePendingToolCall(bucket.byTurn.get(latestPendingTurn))
      }
    }
    if (!pendingCall) continue
    pendingCall.active = false
    bucket.activeCount -= 1
    const nextTurnCount = (bucket.activeCountByTurn.get(pendingCall.turn) ?? 1) - 1
    if (nextTurnCount > 0) bucket.activeCountByTurn.set(pendingCall.turn, nextTurnCount)
    else bucket.activeCountByTurn.delete(pendingCall.turn)
    if (bucket.activeCount === 0) pendingCallsByRawId.delete(rawToolCallId)
    results.set(pendingCall.key, {
      content: message.content,
      is_error: message.is_error === true || message.status === "error"
    })
  }

  return results
}
