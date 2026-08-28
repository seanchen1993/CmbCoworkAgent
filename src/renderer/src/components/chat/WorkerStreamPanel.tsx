import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ArrowLeft, Loader2, Workflow } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { HookLogChip, HookLogModal } from "./HookLogViews"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadContext, useThreadState, type HookLogBucket } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import {
  buildVisibleMessageLayout,
  messageRendersNothing,
  messageVisibleReasoningLength
} from "@/lib/message-display-visibility"
import { buildToolResultAssociations } from "@/lib/worker-tool-result-key"
import {
  buildWorkerCheckpointHistory,
  checkpointHistoryMessageMatchesSparseLive,
  isExplicitWorkerOccurrenceAfter,
  isCompleteWorkerSnapshotCoveringHistory,
  mergeWorkerCheckpointSparseContent,
  normalizeWorkerMessagesAfterHistory,
  MAX_WORKER_HISTORY_MESSAGES
} from "@/lib/worker-checkpoint-history"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"
import {
  getMessageProviderSourceId,
  MESSAGE_SAME_ROLE_DUPLICATE_MARKER,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds,
  normalizeMessageRoleCollisionIds
} from "../../../../shared/message-role-collision"

const MAX_WORKER_SIGNATURE_CHARS = 512
const EMPTY_WORKER_HOOK_LOG_BUCKETS: HookLogBucket[] = []

type ThreadHistoryEntry = {
  checkpoint?: {
    channel_values?: {
      messages?: unknown[]
    }
  }
}

function isWorkerSnapshotMessageId(id: string): boolean {
  const scopeIndex = id.lastIndexOf("::")
  const unscopedId = scopeIndex >= 0 ? id.slice(scopeIndex + 2) : id
  return unscopedId.startsWith("worker-snapshot-")
}

function parseWorkerTurnScopedId(id: string): { rawId: string; turn: number } | undefined {
  const match = /^worker-turn-.*-(\d+)::(.+)$/.exec(id)
  if (!match) return undefined
  return { rawId: match[2], turn: Number(match[1]) }
}

function workerTransportSourceId(message: Message): string {
  const scoped = parseWorkerTurnScopedId(message.id)
  return getMessageProviderSourceId({
    ...message,
    id: scoped?.rawId ?? message.id,
    provider_source_id: message.provider_source_id
      ? (parseWorkerTurnScopedId(message.provider_source_id)?.rawId ?? message.provider_source_id)
      : undefined
  })
}

function workerTransportRenderId(message: Message): string {
  return parseWorkerTurnScopedId(message.id)?.rawId ?? message.id
}

function workerTransportIdentityKey(message: Message, turnKey: string): string {
  return [turnKey, message.role, workerTransportSourceId(message)].join("\u001f")
}

function repeatedWorkerTransportIdentityKeys(
  messages: readonly Message[],
  turnKeys: readonly string[]
): Set<string> {
  const renderIdsByKey = new Map<string, Set<string>>()
  messages.forEach((message, index) => {
    if (message.role !== "assistant" && message.role !== "tool") return
    const key = workerTransportIdentityKey(message, turnKeys[index])
    const renderIds = renderIdsByKey.get(key) ?? new Set<string>()
    renderIds.add(workerTransportRenderId(message))
    renderIdsByKey.set(key, renderIds)
  })
  return new Set(
    [...renderIdsByKey].filter(([, renderIds]) => renderIds.size > 1).map(([key]) => key)
  )
}

function findSameWorkerTransportIdentityIndex(
  messages: readonly Message[],
  message: Message,
  turnKeys: readonly string[],
  turnKey: string
): number | undefined {
  const renderId = workerTransportRenderId(message)
  const exactIndex = messages.findIndex(
    (candidate, candidateIndex) =>
      turnKeys[candidateIndex] === turnKey &&
      candidate.role === message.role &&
      workerTransportRenderId(candidate) === renderId
  )
  if (exactIndex >= 0) return exactIndex

  if (renderId.includes(MESSAGE_SAME_ROLE_DUPLICATE_MARKER)) return undefined

  const sourceId = workerTransportSourceId(message)
  const providerMatches = messages.flatMap((candidate, candidateIndex) =>
    turnKeys[candidateIndex] === turnKey &&
    candidate.role === message.role &&
    workerTransportSourceId(candidate) === sourceId &&
    (parseWorkerTurnScopedId(candidate.id) !== undefined ||
      parseWorkerTurnScopedId(message.id) !== undefined)
      ? [candidateIndex]
      : []
  )
  if (providerMatches.length === 1) return providerMatches[0]
  return undefined
}

function isWorkerNonSnapshotMessageId(id: string): boolean {
  return !isWorkerSnapshotMessageId(id)
}

function isWorkerSnapshotPair(a: Message, b: Message): boolean {
  return (
    (isWorkerSnapshotMessageId(a.id) && isWorkerNonSnapshotMessageId(b.id)) ||
    (isWorkerNonSnapshotMessageId(a.id) && isWorkerSnapshotMessageId(b.id))
  )
}

function isSameWorkerAssistantText(a: Message, b: Message): boolean {
  if (a.role !== "assistant" || b.role !== "assistant") return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (a.tool_calls?.length || b.tool_calls?.length) return false
  if (typeof a.content !== "string" || typeof b.content !== "string") return false
  const first = a.content.trim()
  const second = b.content.trim()
  if (!first || !second) return false
  return first.includes(second) || second.includes(first)
}

function areWorkerContentsCompatible(
  a: Message["content"] | undefined,
  b: Message["content"] | undefined
): boolean {
  const first = contentSignatureKey(a).trim()
  const second = contentSignatureKey(b).trim()
  if (!first || !second) return true
  return first === second || first.includes(second) || second.includes(first)
}

type WorkerToolCall = NonNullable<Message["tool_calls"]>[number]

function hasWorkerToolArgs(args: WorkerToolCall["args"] | undefined): boolean {
  return !!args && Object.keys(args).length > 0
}

function isSameWorkerToolCallIdentity(
  left: WorkerToolCall,
  right: WorkerToolCall,
  index: number
): boolean {
  if (left.id || right.id) return !!left.id && left.id === right.id
  return left.name === right.name && index >= 0
}

function findWorkerToolCallMatch(
  toolCalls: WorkerToolCall[],
  target: WorkerToolCall,
  fallbackIndex: number,
  usedIndexes?: Set<number>
): { call: WorkerToolCall; index: number } | undefined {
  if (target.id) {
    const index = toolCalls.findIndex(
      (toolCall, candidateIndex) =>
        !usedIndexes?.has(candidateIndex) && toolCall.id === target.id
    )
    return index >= 0 ? { call: toolCalls[index], index } : undefined
  }

  if (
    fallbackIndex >= 0 &&
    fallbackIndex < toolCalls.length &&
    !usedIndexes?.has(fallbackIndex) &&
    isSameWorkerToolCallIdentity(toolCalls[fallbackIndex], target, fallbackIndex)
  ) {
    return { call: toolCalls[fallbackIndex], index: fallbackIndex }
  }

  const index = toolCalls.findIndex(
    (toolCall, candidateIndex) =>
      !usedIndexes?.has(candidateIndex) &&
      !toolCall.id &&
      toolCall.name === target.name
  )
  return index >= 0 ? { call: toolCalls[index], index } : undefined
}

function areWorkerToolCallsCompatible(
  left: Message["tool_calls"] | undefined,
  right: Message["tool_calls"] | undefined
): boolean {
  if (!left?.length || !right?.length || left.length !== right.length) return false
  const usedIndexes = new Set<number>()
  for (let index = 0; index < right.length; index += 1) {
    const match = findWorkerToolCallMatch(left, right[index], index, usedIndexes)
    if (!match) return false
    usedIndexes.add(match.index)
  }
  return true
}

function isCompatibleWorkerAssistantToolReplay(a: Message, b: Message): boolean {
  if (a.role !== "assistant" || b.role !== "assistant") return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (!areWorkerToolCallsCompatible(a.tool_calls, b.tool_calls)) return false
  return areWorkerContentsCompatible(a.content, b.content)
}

function isCompatibleWorkerToolResultReplay(a: Message, b: Message): boolean {
  if (a.role !== "tool" || b.role !== "tool") return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (!a.tool_call_id || a.tool_call_id !== b.tool_call_id) return false
  if (a.name && b.name && a.name !== b.name) return false
  return areWorkerContentsCompatible(a.content, b.content)
}

function findCompatibleWorkerReplayIndex(
  messages: Message[],
  message: Message,
  turnKeys?: readonly string[],
  turnKey?: string
): number | undefined {
  const index = messages.findIndex(
    (item, candidateIndex) =>
      (turnKey === undefined || turnKeys?.[candidateIndex] === turnKey) &&
      (isCompatibleWorkerAssistantToolReplay(item, message) ||
        isCompatibleWorkerToolResultReplay(item, message))
  )
  return index >= 0 ? index : undefined
}

function findSameWorkerAssistantTextIndex(
  messages: Message[],
  message: Message,
  turnKeys?: readonly string[],
  turnKey?: string
): number | undefined {
  const index = messages.findIndex(
    (item, candidateIndex) =>
      (turnKey === undefined || turnKeys?.[candidateIndex] === turnKey) &&
      isSameWorkerAssistantText(item, message)
  )
  return index >= 0 ? index : undefined
}

const WORKER_PRE_USER_TURN_KEY = "__cmb-worker-before-user__"

function latestWorkerTurnKey(messages: readonly Message[]): string {
  return workerTurnKeys(messages).at(-1) ?? WORKER_PRE_USER_TURN_KEY
}

function workerTurnKeys(
  messages: readonly Message[],
  initialTurnKey: string = WORKER_PRE_USER_TURN_KEY
): string[] {
  let currentTurnKey = initialTurnKey
  const initialTurnMatch = /^__cmb-worker-turn-(\d+)__$/.exec(initialTurnKey)
  let lastUserTurn = initialTurnMatch ? Number(initialTurnMatch[1]) : 0
  return messages.map((message) => {
    const scopedTurn = parseWorkerTurnScopedId(message.id)?.turn
    if (message.role === "user") {
      lastUserTurn = scopedTurn ?? lastUserTurn + 1
      currentTurnKey = `__cmb-worker-turn-${lastUserTurn}__`
    } else if (scopedTurn !== undefined) {
      lastUserTurn = Math.max(lastUserTurn, scopedTurn)
      currentTurnKey = `__cmb-worker-turn-${scopedTurn}__`
    }
    return currentTurnKey
  })
}

function relativeWorkerTurnKeys(messages: readonly Message[], turnOffset: number): string[] {
  let currentTurn = turnOffset
  return messages.map((message) => {
    if (message.role === "user") currentTurn += 1
    return currentTurn > 0
      ? `__cmb-worker-turn-${currentTurn}__`
      : WORKER_PRE_USER_TURN_KEY
  })
}

function workerTurnSignatureKey(turnKey: string, signature: string | undefined): string | undefined {
  return signature ? `${turnKey}\u0000${signature}` : undefined
}

function incrementSignatureCount(map: Map<string, number>, signature: string | undefined): void {
  if (!signature) return
  map.set(signature, (map.get(signature) ?? 0) + 1)
}

function takeWindowedSignatureMatch(
  indexes: number[] | undefined,
  remainingBySignature: Map<string, number>,
  signature: string | undefined
): number | undefined {
  if (!indexes?.length || !signature) return undefined
  const remaining = remainingBySignature.get(signature) ?? 0
  if (remaining <= 0) return indexes.shift()

  // If the same text appears in multiple worker turns, live messages usually
  // belong to the most recent slice. Match the last N compatible snapshots
  // instead of blindly consuming the oldest one.
  const matchPosition = Math.max(0, indexes.length - remaining)
  const [index] = indexes.splice(matchPosition, 1)
  remainingBySignature.set(signature, remaining - 1)
  return index
}

const WORKER_THINKING_MESSAGES = [
  "我先想想...",
  "让我捋一捋...",
  "我去翻翻代码...",
  "我来找线索...",
  "先做个判断...",
  "我再核对一下...",
  "先把思路摊开...",
  "我来拼一下答案...",
  "我再压一遍细节...",
  "先看下上下文...",
  "我再过一遍日志...",
  "我来换个角度...",
  "先把重点抓出来...",
  "让我算一轮...",
  "我再确认一下...",
  "我先试条路...",
  "我去查个依据...",
  "我先把话说准...",
  "我再补一刀...",
  "我来收个尾...",
  "先别急，快到了...",
  "差最后一段了...",
  "我再润一润...",
  "再给我两秒...",
  "我来给你个稳妥版...",
  "我先把坑绕开...",
  "我再压压风险...",
  "先把答案打磨下...",
  "马上给你结果...",
  "就快好了..."
]

function mergeCheckpointAlignedWorkerMessage(
  historyMessage: Message,
  liveMessage: Message,
  id: string
): Message {
  return {
    ...historyMessage,
    ...liveMessage,
    id,
    content: mergeWorkerCheckpointSparseContent(historyMessage, liveMessage),
    reasoning: liveMessage.reasoning ?? historyMessage.reasoning,
    tool_calls: mergeSparseWorkerToolCalls(
      historyMessage.tool_calls,
      liveMessage.tool_calls
    ),
    tool_call_id: liveMessage.tool_call_id ?? historyMessage.tool_call_id,
    name: liveMessage.name ?? historyMessage.name,
    status: liveMessage.status ?? historyMessage.status,
    is_error: liveMessage.is_error ?? historyMessage.is_error
  }
}

function mergeMessages(baseMessages: Message[], liveMessages: Message[]): Message[] {
  if (isCompleteWorkerSnapshotCoveringHistory(baseMessages, liveMessages)) {
    const normalizedLiveMessages = normalizeCompleteMessageIds(liveMessages)
    const historyOffset = normalizedLiveMessages.length - baseMessages.length
    return normalizedLiveMessages.map((liveMessage, index) => {
      if (index < historyOffset) return liveMessage
      const historyMessage = baseMessages[index - historyOffset]
      return mergeCheckpointAlignedWorkerMessage(
        historyMessage,
        liveMessage,
        liveMessage.id
      )
    })
  }
  const replayPrefixLength = findWorkerHistorySuffixReplayPrefixLength(
    baseMessages,
    liveMessages
  )
  if (replayPrefixLength > 0) {
    const historyOffset = baseMessages.length - replayPrefixLength
    const normalizedBaseMessages = normalizeCompleteMessageIds(baseMessages)
    const alignedMessages = normalizedBaseMessages.map((historyMessage, index) => {
      if (index < historyOffset) return historyMessage
      return mergeCheckpointAlignedWorkerMessage(
        historyMessage,
        liveMessages[index - historyOffset],
        historyMessage.id
      )
    })
    const appendedTail = normalizeWorkerMessagesAfterHistory(
      alignedMessages,
      liveMessages.slice(replayPrefixLength)
    )
    return appendedTail.length > 0
      ? mergeMessages(alignedMessages, appendedTail)
      : alignedMessages
  }
  const normalizedBaseMessages = normalizeCompleteMessageIds(baseMessages)
  const normalizedLiveMessages = normalizeAppendedMessageIds(
    normalizedBaseMessages,
    normalizeCompleteMessageIds(
      normalizeMessageRoleCollisionIds(normalizedBaseMessages, liveMessages)
    ),
    { splitAssistantAfterTool: true }
  )
  if (normalizedBaseMessages.length === 0) return normalizedLiveMessages
  if (normalizedLiveMessages.length === 0) return normalizedBaseMessages

  const merged: Message[] = [...normalizedBaseMessages]
  const baseUserCount = normalizedBaseMessages.filter(
    (message) => message.role === "user"
  ).length
  const liveUserCount = normalizedLiveMessages.filter(
    (message) => message.role === "user"
  ).length
  const alignUserWindows = baseUserCount > 0 && liveUserCount > 0
  const alignedTurnCount = Math.max(baseUserCount, liveUserCount)
  const mergedTurnKeys = alignUserWindows
    ? relativeWorkerTurnKeys(merged, alignedTurnCount - baseUserCount)
    : workerTurnKeys(merged)
  const liveTurnKeys = alignUserWindows
    ? relativeWorkerTurnKeys(normalizedLiveMessages, alignedTurnCount - liveUserCount)
    : workerTurnKeys(
        normalizedLiveMessages,
        latestWorkerTurnKey(normalizedBaseMessages)
      )
  const indexById = new Map(merged.map((message, index) => [message.id, index]))
  const snapshotIndexesBySignature = new Map<string, number[]>()
  const liveIndexesBySignature = new Map<string, number[]>()
  const incomingLiveCountsBySignature = new Map<string, number>()
  const incomingSnapshotCountsBySignature = new Map<string, number>()
  const repeatedLiveTransportIdentities = repeatedWorkerTransportIdentityKeys(
    normalizedLiveMessages,
    liveTurnKeys
  )
  normalizedLiveMessages.forEach((message, index) => {
    const signature = workerTurnSignatureKey(
      liveTurnKeys[index],
      workerFocusMessageSignature(message)
    )
    if (isWorkerNonSnapshotMessageId(message.id)) {
      incrementSignatureCount(incomingLiveCountsBySignature, signature)
    }
    if (isWorkerSnapshotMessageId(message.id)) {
      incrementSignatureCount(incomingSnapshotCountsBySignature, signature)
    }
  })
  merged.forEach((message, index) => {
    const signature = workerTurnSignatureKey(
      mergedTurnKeys[index],
      workerFocusMessageSignature(message)
    )
    if (signature && isWorkerSnapshotMessageId(message.id)) {
      const indexes = snapshotIndexesBySignature.get(signature) ?? []
      indexes.push(index)
      snapshotIndexesBySignature.set(signature, indexes)
    }
    if (signature && isWorkerNonSnapshotMessageId(message.id)) {
      const indexes = liveIndexesBySignature.get(signature) ?? []
      indexes.push(index)
      liveIndexesBySignature.set(signature, indexes)
    }
  })

  normalizedLiveMessages.forEach((live, liveIndex) => {
    const turnKey = liveTurnKeys[liveIndex]
    const signature = workerTurnSignatureKey(
      turnKey,
      workerFocusMessageSignature(live)
    )
    const index =
      indexById.get(live.id) ??
      findSameWorkerTransportIdentityIndex(merged, live, mergedTurnKeys, turnKey) ??
      (signature && isWorkerNonSnapshotMessageId(live.id)
        ? takeWindowedSignatureMatch(
            snapshotIndexesBySignature.get(signature),
            incomingLiveCountsBySignature,
            signature
          )
        : undefined) ??
      (signature && isWorkerSnapshotMessageId(live.id)
        ? takeWindowedSignatureMatch(
            liveIndexesBySignature.get(signature),
            incomingSnapshotCountsBySignature,
            signature
          )
        : undefined) ??
      findCompatibleWorkerReplayIndex(merged, live, mergedTurnKeys, turnKey) ??
      findSameWorkerAssistantTextIndex(merged, live, mergedTurnKeys, turnKey)
    if (index === undefined) {
      indexById.set(live.id, merged.length)
      if (signature && isWorkerSnapshotMessageId(live.id)) {
        const indexes = snapshotIndexesBySignature.get(signature) ?? []
        indexes.push(merged.length)
        snapshotIndexesBySignature.set(signature, indexes)
      }
      if (signature && isWorkerNonSnapshotMessageId(live.id)) {
        const indexes = liveIndexesBySignature.get(signature) ?? []
        indexes.push(merged.length)
        liveIndexesBySignature.set(signature, indexes)
      }
      merged.push(live)
      mergedTurnKeys.push(turnKey)
      return
    }

    const existing = merged[index]
    const id = existing.id
    const incomingDefinesRepeatedOccurrence = repeatedLiveTransportIdentities.has(
      workerTransportIdentityKey(live, turnKey)
    )
    merged[index] = {
      ...existing,
      ...live,
      id,
      content: resolveWorkerPanelContent(
        existing,
        live,
        incomingDefinesRepeatedOccurrence
      ),
      reasoning: incomingDefinesRepeatedOccurrence
        ? live.reasoning
        : (live.reasoning ?? existing.reasoning),
      tool_calls: incomingDefinesRepeatedOccurrence
        ? live.tool_calls
          ? mergeWorkerToolCalls(existing.tool_calls, live.tool_calls)
          : undefined
        : mergeWorkerToolCalls(existing.tool_calls, live.tool_calls),
      tool_call_id: incomingDefinesRepeatedOccurrence
        ? live.tool_call_id
        : (live.tool_call_id ?? existing.tool_call_id),
      name: incomingDefinesRepeatedOccurrence ? live.name : (live.name ?? existing.name),
      status: incomingDefinesRepeatedOccurrence
        ? live.status
        : (live.status ?? existing.status),
      is_error: incomingDefinesRepeatedOccurrence
        ? live.is_error
        : (live.is_error ?? existing.is_error)
    }
    indexById.set(id, index)
    indexById.set(live.id, index)
  })

  return merged
}

function findWorkerHistorySuffixReplayPrefixLength(
  historyMessages: readonly Message[],
  liveMessages: readonly Message[]
): number {
  const normalizedHistoryMessages = normalizeCompleteMessageIds(historyMessages)
  const maxLength = Math.min(historyMessages.length, liveMessages.length)
  for (let length = maxLength; length > 0; length -= 1) {
    const historyOffset = historyMessages.length - length
    const matches = liveMessages
      .slice(0, length)
      .every((liveMessage, index) => {
        const historyIndex = historyOffset + index
        const historyMessage = historyMessages[historyIndex]
        const normalizedHistoryMessage = normalizedHistoryMessages[historyIndex]
        if (isExplicitWorkerOccurrenceAfter(normalizedHistoryMessage, liveMessage)) {
          return false
        }
        return checkpointHistoryMessageMatchesSparseLive(
          historyMessage,
          liveMessage
        )
      })
    if (matches) return length
  }
  return 0
}

function mergeSparseWorkerToolCalls(
  history: Message["tool_calls"] | undefined,
  live: Message["tool_calls"] | undefined
): Message["tool_calls"] | undefined {
  if (!live?.length) return history
  if (!history?.length) return live

  if (history.length === live.length) {
    const usedIndexes = new Set<number>()
    return live.map((liveToolCall, index) => {
      const match = findWorkerToolCallMatch(history, liveToolCall, index, usedIndexes)
      if (match) usedIndexes.add(match.index)
      return {
        ...(match?.call ?? liveToolCall),
        ...liveToolCall,
        args: hasWorkerToolArgs(liveToolCall.args)
          ? liveToolCall.args
          : (match?.call.args ?? liveToolCall.args)
      }
    })
  }

  const merged = history.map((toolCall) => ({ ...toolCall }))
  const usedIndexes = new Set<number>()
  for (let index = 0; index < live.length; index += 1) {
    const liveToolCall = live[index]
    const match = findWorkerToolCallMatch(merged, liveToolCall, index, usedIndexes)
    if (!match) {
      merged.push(liveToolCall)
      continue
    }
    usedIndexes.add(match.index)
    merged[match.index] = {
      ...match.call,
      ...liveToolCall,
      args: hasWorkerToolArgs(liveToolCall.args)
        ? liveToolCall.args
        : (match.call.args ?? liveToolCall.args)
    }
  }
  return merged
}

function mergeWorkerToolCalls(
  existing: Message["tool_calls"] | undefined,
  incoming: Message["tool_calls"] | undefined
): Message["tool_calls"] | undefined {
  if (!incoming?.length) return existing
  if (!existing?.length) return incoming
  if (!areWorkerToolCallsCompatible(existing, incoming)) return incoming

  const usedIndexes = new Set<number>()
  return incoming.map((incomingToolCall, index) => {
    const match = findWorkerToolCallMatch(existing, incomingToolCall, index, usedIndexes)
    if (match) usedIndexes.add(match.index)
    const existingToolCall = match?.call
    return {
      ...(existingToolCall ?? incomingToolCall),
      ...incomingToolCall,
      args: hasWorkerToolArgs(incomingToolCall.args)
        ? incomingToolCall.args
        : (existingToolCall?.args ?? incomingToolCall.args)
    }
  })
}

function workerMessagePreview(message: Message): string {
  const content = message.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              if (typeof block.text === "string") return block.text
              if (typeof block.content === "string") return block.content
              return ""
            })
            .join(" ")
        : ""
  return text.trim().slice(0, 120)
}

function buildWorkerHookLogBuckets(
  messages: Message[],
  hookLogBuckets: HookLogBucket[],
  workerThreadId: string | undefined
): {
  bucketById: Map<string, HookLogBucket>
  bucketByMessageId: Map<string, HookLogBucket>
  detachedBuckets: HookLogBucket[]
  totalEntryCount: number
} {
  const bucketById = new Map<string, HookLogBucket>()
  const bucketByMessageId = new Map<string, HookLogBucket>()
  const detachedBuckets: HookLogBucket[] = []
  if (!workerThreadId) {
    return { bucketById, bucketByMessageId, detachedBuckets, totalEntryCount: 0 }
  }

  const userMessages = messages.filter((message) => message.role === "user")
  const userMessageByTurn = new Map<number, Message>()
  userMessages.forEach((message, index) => userMessageByTurn.set(index + 1, message))

  const upsertBucket = (bucket: HookLogBucket): HookLogBucket => {
    const existing = bucketById.get(bucket.turnId)
    if (!existing) {
      bucketById.set(bucket.turnId, bucket)
      if (bucketByMessageId.has(bucket.turnId)) {
        bucketByMessageId.set(bucket.turnId, bucket)
      } else if (bucket.isPlaceholder) {
        detachedBuckets.push(bucket)
      }
      return bucket
    }
    const next = { ...existing, entries: [...existing.entries, ...bucket.entries] }
    bucketById.set(next.turnId, next)
    if (bucketByMessageId.has(next.turnId)) {
      bucketByMessageId.set(next.turnId, next)
    } else {
      const index = detachedBuckets.findIndex((item) => item.turnId === next.turnId)
      if (index >= 0) detachedBuckets[index] = next
    }
    return next
  }

  let totalEntryCount = 0
  for (const sourceBucket of hookLogBuckets) {
    for (const entry of sourceBucket.entries) {
      if (entry.workerThreadId !== workerThreadId) continue
      totalEntryCount += 1
      const workerTurn =
        typeof entry.workerTurn === "number" && Number.isFinite(entry.workerTurn)
          ? entry.workerTurn
          : undefined
      const targetMessage = workerTurn ? userMessageByTurn.get(workerTurn) : undefined
      if (targetMessage) {
        const existing = bucketByMessageId.get(targetMessage.id)
        const bucket: HookLogBucket = {
          turnId: targetMessage.id,
          turnPreview: workerMessagePreview(targetMessage),
          startedAt: existing?.startedAt ?? entry.timestamp,
          entries: [entry]
        }
        if (!existing) bucketByMessageId.set(targetMessage.id, bucket)
        upsertBucket(bucket)
        continue
      }

      const turnLabel = workerTurn ? `第 ${workerTurn} 轮` : "未匹配轮次"
      upsertBucket({
        turnId: `worker-hook:${workerThreadId}:${workerTurn ?? "unknown"}`,
        turnPreview: `(Worker ${turnLabel} Hook)`,
        isPlaceholder: true,
        startedAt: entry.timestamp,
        entries: [entry]
      })
    }
  }

  return { bucketById, bucketByMessageId, detachedBuckets, totalEntryCount }
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function boundedTextSignature(value: string): string {
  if (value.length <= MAX_WORKER_SIGNATURE_CHARS * 2) return value
  return [
    value.length,
    value.slice(0, MAX_WORKER_SIGNATURE_CHARS),
    value.slice(-MAX_WORKER_SIGNATURE_CHARS)
  ].join("\u001e")
}

function contentSignatureKey(content: Message["content"] | undefined): string {
  if (typeof content === "string") return boundedTextSignature(content)
  if (!Array.isArray(content)) return ""

  const text = content
    .map((block) => {
      if (typeof block.text === "string") return block.text
      if (typeof block.content === "string") return block.content
      return block.type ?? ""
    })
    .join("\n")
  return boundedTextSignature(text)
}

function toolCallsSignatureKey(toolCalls: Message["tool_calls"] | undefined): string {
  if (!toolCalls?.length) return ""
  return boundedTextSignature(
    toolCalls
      .map((toolCall, index) =>
        [
          toolCall.id ?? index,
          toolCall.name ?? "",
          toolCall.args ? boundedTextSignature(stableStringify(toolCall.args)) : ""
        ].join(":")
      )
      .join("|")
  )
}

function workerFocusMessageSignature(message: Message): string | undefined {
  const contentKey = contentSignatureKey(message.content)
  if (message.role === "assistant") {
    const toolCallKey = toolCallsSignatureKey(message.tool_calls)
    if (!contentKey && !toolCallKey) return undefined
    return ["assistant", contentKey, toolCallKey].join("\u001f")
  }
  if (message.role === "tool" && message.tool_call_id) {
    return ["tool", message.tool_call_id, message.name ?? "", contentKey].join("\u001f")
  }
  return undefined
}

function preferIncomingContent(
  existing: Message["content"] | undefined,
  incoming: Message["content"] | undefined
): Message["content"] {
  const existingLength = messageContentLength(existing)
  const incomingLength = messageContentLength(incoming)
  if (incomingLength === 0) return existing ?? ""
  if (existingLength > incomingLength) return existing ?? ""

  return incoming ?? ""
}

function resolveWorkerPanelContent(
  existingMessage: Message,
  incomingMessage: Message,
  incomingDefinesRepeatedOccurrence: boolean = false
): Message["content"] {
  if (incomingDefinesRepeatedOccurrence) return incomingMessage.content ?? ""

  if (isWorkerNonSnapshotMessageId(existingMessage.id) && existingMessage.id === incomingMessage.id) {
    return preferIncomingContent(existingMessage.content, incomingMessage.content)
  }

  if (isWorkerSnapshotMessageId(incomingMessage.id)) {
    return preferIncomingContent(existingMessage.content, incomingMessage.content)
  }

  if (isWorkerSnapshotMessageId(existingMessage.id)) {
    return preferIncomingContent(incomingMessage.content, existingMessage.content)
  }

  return preferIncomingContent(existingMessage.content, incomingMessage.content)
}

export function WorkerStreamPanel(): React.JSX.Element {
  const workerFocusView = useAppStore((state) => state.workerFocusView)
  const workerFocusMessages = useAppStore((state) => state.workerFocusMessages)
  const closeWorkerFocusView = useAppStore((state) => state.closeWorkerFocusView)
  const threadContext = useThreadContext()
  const [historyMessages, setHistoryMessages] = useState<Message[]>([])
  const [truncatedHistoryCount, setTruncatedHistoryCount] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0)
  const [openHookLogBucketId, setOpenHookLogBucketId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const thinkingCycleRef = useRef(-1)
  const wasRunningRef = useRef(false)
  const runningMessageCountRef = useRef(0)
  const isAtBottomRef = useRef(true)
  const previousHistoryLoadRef = useRef<{
    workerThreadId: string
    turns?: number
  } | null>(null)
  const threadState = useThreadState(workerFocusView?.threadId ?? null)
  const currentWorker = threadState?.coordinatorWorkers.find(
    (worker) => worker.worker_id === workerFocusView?.workerId
  )
  const isRunning = currentWorker?.status === "running"
  const focusedParentThreadId = workerFocusView?.threadId ?? null
  const parentHookLogBuckets = useSyncExternalStore(
    useCallback(
      (callback) =>
        focusedParentThreadId
          ? threadContext.subscribeToHookLogs(focusedParentThreadId, callback)
          : () => undefined,
      [focusedParentThreadId, threadContext]
    ),
    useCallback(
      () =>
        focusedParentThreadId
          ? threadContext.getHookLogBuckets(focusedParentThreadId)
          : EMPTY_WORKER_HOOK_LOG_BUCKETS,
      [focusedParentThreadId, threadContext]
    )
  )

  useEffect(() => {
    const workerThreadId = workerFocusView?.workerThreadId
    if (!workerThreadId) return

    let cancelled = false
    const turns = currentWorker?.turns
    const previousLoad = previousHistoryLoadRef.current
    const shouldResetHistory =
      previousLoad?.workerThreadId !== workerThreadId || previousLoad?.turns !== turns
    previousHistoryLoadRef.current = { workerThreadId, turns }
    if (shouldResetHistory) {
      setHistoryMessages([])
      setTruncatedHistoryCount(0)
    }
    setLoadingHistory(true)
    void (async () => {
      try {
        const latestCheckpoint =
          (await window.api.threads.getLatestCheckpoint(workerThreadId)) as ThreadHistoryEntry | null
        if (cancelled) return
        const rawMessages = latestCheckpoint?.checkpoint?.channel_values?.messages
        if (!Array.isArray(rawMessages)) {
          setHistoryMessages([])
          setTruncatedHistoryCount(0)
          return
        }

        const history = buildWorkerCheckpointHistory(rawMessages, workerThreadId)
        setTruncatedHistoryCount(history.truncatedCount)
        setHistoryMessages(history.messages)
      } catch (error) {
        console.error("[WorkerStreamPanel] Failed to load worker checkpoint:", error)
        if (!cancelled) {
          setHistoryMessages([])
          setTruncatedHistoryCount(0)
        }
      } finally {
        if (!cancelled) setLoadingHistory(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [currentWorker?.status, currentWorker?.turns, workerFocusView?.workerThreadId])

  const messages = useMemo(
    () => mergeMessages(historyMessages, workerFocusMessages),
    [historyMessages, workerFocusMessages]
  )
  const workerHookLogs = useMemo(
    () =>
      buildWorkerHookLogBuckets(
        messages,
        parentHookLogBuckets,
        workerFocusView?.workerThreadId
      ),
    [messages, parentHookLogBuckets, workerFocusView?.workerThreadId]
  )
  const openHookLogBucket = openHookLogBucketId
    ? (workerHookLogs.bucketById.get(openHookLogBucketId) ?? null)
    : null
  const visibleMessageLayout = useMemo(
    () =>
      buildVisibleMessageLayout(messages, (message) => {
        if (!messageRendersNothing(message)) return true
        if (message.role !== "user") return false
        return Boolean(workerHookLogs.bucketByMessageId.get(message.id)?.entries.length)
      }),
    [messages, workerHookLogs.bucketByMessageId]
  )
  const showAssistantMetaByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let nextVisibleMessage: Message | null = null
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      const hasHookLogChip =
        message.role === "user" &&
        Boolean(workerHookLogs.bucketByMessageId.get(message.id)?.entries.length)
      if (messageRendersNothing(message) && !hasHookLogChip) {
        result[index] = false
        continue
      }
      result[index] =
        message.role !== "assistant" ||
        !nextVisibleMessage ||
        nextVisibleMessage.role !== "assistant"
      nextVisibleMessage = message
    }
    return result
  }, [messages, workerHookLogs.bucketByMessageId])
  const hasUserAfterHeadByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let hasUserAfterHead = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      result[index] = hasUserAfterHead
      const hasHookLogChip =
        message.role === "user" &&
        Boolean(workerHookLogs.bucketByMessageId.get(message.id)?.entries.length)
      if (message.role === "user" && (!messageRendersNothing(message) || hasHookLogChip)) {
        hasUserAfterHead = true
      }
    }
    return result
  }, [messages, workerHookLogs.bucketByMessageId])

  const { assistantDurationMsById, userSendTimeLabelById } = useMemo(
    () => buildMessageBubbleTimingMeta(messages),
    [messages]
  )
  const toolResults = useMemo(() => buildToolResultAssociations(messages), [messages])
  const getScrollViewport = useCallback((): HTMLDivElement | null => {
    const root = scrollRef.current
    if (!root) return null
    if (root.matches("[data-radix-scroll-area-viewport]")) return root
    return root.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null
  }, [])
  const scrollToBottom = useCallback(() => {
    const scroll = () => {
      const viewport = getScrollViewport()
      if (!viewport) return
      viewport.scrollTop = viewport.scrollHeight
      isAtBottomRef.current = true
    }

    let innerFrame: number | undefined
    let timeout: number | undefined
    const frame = window.requestAnimationFrame(() => {
      scroll()
      innerFrame = window.requestAnimationFrame(scroll)
      timeout = window.setTimeout(scroll, 80)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (innerFrame !== undefined) window.cancelAnimationFrame(innerFrame)
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [getScrollViewport])
  const updateIsAtBottom = useCallback(() => {
    const viewport = getScrollViewport()
    if (!viewport) return

    const bottomDistance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    isAtBottomRef.current = bottomDistance < 50
  }, [getScrollViewport])
  const scrollSignature = useMemo(() => {
    const lastMessage = messages[visibleMessageLayout.lastVisibleMessageIndex]
    return [
      messages.length,
      lastMessage?.id ?? "",
      lastMessage?.role ?? "",
      messageContentLength(lastMessage?.content),
      messageVisibleReasoningLength(lastMessage),
      lastMessage?.tool_calls?.length ?? 0,
      toolResults.size,
      workerFocusMessages.length,
      workerHookLogs.totalEntryCount,
      isRunning ? "running" : "idle"
    ].join(":")
  }, [
    messages,
    toolResults.size,
    workerFocusMessages.length,
    workerHookLogs.totalEntryCount,
    isRunning,
    visibleMessageLayout.lastVisibleMessageIndex
  ])

  useEffect(() => {
    isAtBottomRef.current = true
    return scrollToBottom()
  }, [scrollToBottom, workerFocusView?.workerThreadId])

  useEffect(() => {
    setOpenHookLogBucketId(null)
  }, [workerFocusView?.workerThreadId])

  useEffect(() => {
    if (loadingHistory) return
    return scrollToBottom()
  }, [loadingHistory, scrollToBottom, workerFocusView?.workerThreadId])

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport) return

    viewport.addEventListener("scroll", updateIsAtBottom, { passive: true })
    updateIsAtBottom()

    return () => {
      viewport.removeEventListener("scroll", updateIsAtBottom)
    }
  }, [getScrollViewport, updateIsAtBottom, workerFocusView?.workerThreadId])

  useEffect(() => {
    if (!isRunning) {
      wasRunningRef.current = false
      runningMessageCountRef.current = 0
      return
    }

    if (!wasRunningRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % WORKER_THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      runningMessageCountRef.current = messages.length
      wasRunningRef.current = true
      return
    }

    if (messages.length > runningMessageCountRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % WORKER_THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      runningMessageCountRef.current = messages.length
    }
  }, [isRunning, messages.length])

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport || !isAtBottomRef.current) return

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
      updateIsAtBottom()
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [getScrollViewport, scrollSignature, updateIsAtBottom])

  if (!workerFocusView) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        未选择 worker
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-grid-subtle">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background/85 px-2.5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => closeWorkerFocusView()}
            className="h-7 w-9 p-0"
            title="返回"
            aria-label="返回"
          >
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 truncate text-sm font-semibold text-foreground">
            Worker 工具流
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {workerFocusView.description || workerFocusView.workerId}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none",
            isRunning
              ? "border-blue-300/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
              : "border-border bg-background-interactive/70 text-muted-foreground"
          )}
        >
          {isRunning ? "实时运行中" : "历史快照"}
        </span>
      </div>

      <ScrollArea ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="mx-auto w-full min-w-0 max-w-3xl overflow-hidden px-4 py-6 pb-32">
          <div className="min-w-0 space-y-4 overflow-hidden">
            {loadingHistory && messages.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在恢复 worker checkpoint...
              </div>
            )}
            {!loadingHistory && messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                暂无可展示的 worker 消息。运行中的后续工具流会实时显示在这里。
              </div>
            )}
            {truncatedHistoryCount > 0 && (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                为控制性能，这里仅恢复最近 {MAX_WORKER_HISTORY_MESSAGES} 条 worker
                checkpoint 消息；更早的 {truncatedHistoryCount} 条历史未在面板加载。
              </div>
            )}
            {workerHookLogs.detachedBuckets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {workerHookLogs.detachedBuckets.map((bucket) => (
                  <HookLogChip
                    key={bucket.turnId}
                    bucket={bucket}
                    onClick={() => setOpenHookLogBucketId(bucket.turnId)}
                  />
                ))}
              </div>
            )}
            {messages.map((message, index) => {
              const hookLogBucketForTurn =
                message.role === "user" ? workerHookLogs.bucketByMessageId.get(message.id) : null
              if (messageRendersNothing(message) && !hookLogBucketForTurn?.entries.length) {
                return null
              }
              const previousMessage = visibleMessageLayout.previousVisibleMessageByIndex[index]
              const isLastMessage = index === visibleMessageLayout.lastVisibleMessageIndex

              return (
                <div key={message.id}>
                  <MessageBubble
                    message={message}
                    previousMessage={previousMessage}
                    isStreaming={isRunning && isLastMessage}
                    showAssistantMeta={showAssistantMetaByIndex[index] ?? true}
                    toolResults={toolResults}
                    threadId={workerFocusView.threadId}
                    isLoading={isRunning}
                    hasUserAfterHead={hasUserAfterHeadByIndex[index] ?? false}
                    assistantDurationMs={assistantDurationMsById.get(message.id)}
                    userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
                  />
                  {hookLogBucketForTurn && hookLogBucketForTurn.entries.length > 0 && (
                    <div className="mt-1 flex justify-end pr-2">
                      <HookLogChip
                        bucket={hookLogBucketForTurn}
                        onClick={() => setOpenHookLogBucketId(hookLogBucketForTurn.turnId)}
                      />
                    </div>
                  )}
                </div>
              )
            })}
            {isRunning && (
              <div className="flex items-center gap-2 text-sm">
                <div className="rainbow-spinner" />
                <span
                  className="thinking-shimmer-text"
                  data-text={WORKER_THINKING_MESSAGES[thinkingMessageIndex]}
                >
                  {WORKER_THINKING_MESSAGES[thinkingMessageIndex]}
                </span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
      <HookLogModal
        bucket={openHookLogBucket}
        open={openHookLogBucketId !== null}
        previewLabel="Worker 指令"
        onOpenChange={(open) => {
          if (!open) setOpenHookLogBucketId(null)
        }}
      />
    </div>
  )
}
