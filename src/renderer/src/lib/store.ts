import { create } from "zustand"
import type { EvolutionCandidate } from "@/api/evolution"
import type {
  Thread,
  ModelConfig,
  Provider,
  Message,
  ForkableCheckpoint,
  ThreadForkParams
} from "@/types"
import type { BrowserCdpConfig } from "../../../shared/browser-types"
import { findFirstChatThread, isHarnessProjectModeThread } from "./thread-classification"
import {
  appendThreadDirectoryPages,
  indexThreadDirectory,
  mergeThreadDirectoryFirstPage
} from "./thread-directory-pagination"
import { queueStorageKey } from "./queued-message-content"
import {
  buildAvailableProviderOccurrenceId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  MESSAGE_SAME_ROLE_DUPLICATE_MARKER,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds,
  normalizeMessageRoleCollisionIds
} from "../../../shared/message-role-collision"
import { normalizeChatScrollSettings, type ChatScrollSettings } from "../../../shared/chat-scroll"
import { revalidateModelCatalog } from "./model-catalog-cache"
import type { ThreadDeleteOptions, ThreadMetadataPatch } from "../../../main/types"
import { chatScrollSessionStore } from "@/components/chat/chat-scroll-session-store"
import { clearChatThreadProjectionRuntime } from "./chat-thread-projection-cache"
import { runBestEffortCommittedDeletionCleanups } from "./thread-group-deletion"

const MAX_WORKER_FOCUS_MESSAGES = 2_000
const MAX_WORKER_SIGNATURE_CHARS = 512
const rendererDeletingThreadIds = new Set<string>()
const rendererRetiredThreadIds = new Set<string>()

/** Prevent delayed renderer work from touching a Thread once deletion starts. */
export function isThreadDeletionPending(threadId: string): boolean {
  return rendererDeletingThreadIds.has(threadId) || rendererRetiredThreadIds.has(threadId)
}

/** A successful backend delete permanently retires this renderer incarnation. */
export function isThreadRetired(threadId: string): boolean {
  return rendererRetiredThreadIds.has(threadId)
}
const THREAD_DIRECTORY_PAGE_LIMIT = 128
const THREAD_DIRECTORY_PAGE_BYTE_BUDGET = 512 * 1024
const THREAD_DIRECTORY_LOAD_MORE_PAGE_BATCH = 4
let threadDirectoryLoadGeneration = 0
let threadDirectoryBootstrapSelectionPending = false
let threadDirectoryLatestLoadPromise: Promise<boolean> | null = null
let threadDirectoryCursor: { beforeUpdatedAt: number; beforeThreadId: string } | null = null
let threadDirectoryLoadMorePromise: Promise<void> | null = null
let threadDirectoryMutationEpoch = 0
const threadDirectoryMutationEpochById = new Map<string, number>()
let indexedThreadDirectorySnapshot: readonly Thread[] | null = null
let threadDirectoryIndexById = new Map<string, number>()

function adoptThreadDirectorySnapshot(threads: readonly Thread[]): Thread[] {
  indexedThreadDirectorySnapshot = threads
  threadDirectoryIndexById = indexThreadDirectory(threads)
  return threads as Thread[]
}

function getThreadDirectoryIndex(threads: readonly Thread[]): ReadonlyMap<string, number> {
  if (indexedThreadDirectorySnapshot !== threads) adoptThreadDirectorySnapshot(threads)
  return threadDirectoryIndexById
}

function markThreadDirectoryMutation(threadId: string): void {
  threadDirectoryMutationEpoch += 1
  threadDirectoryMutationEpochById.set(threadId, threadDirectoryMutationEpoch)
}

function forgetAcknowledgedThreadDirectoryMutations(requestEpoch: number): void {
  for (const [threadId, epoch] of threadDirectoryMutationEpochById) {
    if (epoch <= requestEpoch) threadDirectoryMutationEpochById.delete(threadId)
  }
}

async function waitForAppliedThreadDirectoryLoad(initialLoad: Promise<boolean>): Promise<void> {
  let pendingLoad = initialLoad
  for (;;) {
    try {
      const applied = await pendingLoad
      if (applied) return
    } catch (error) {
      const latestLoad = threadDirectoryLatestLoadPromise
      if (!latestLoad || latestLoad === pendingLoad) throw error
      pendingLoad = latestLoad
      continue
    }

    const latestLoad = threadDirectoryLatestLoadPromise
    if (!latestLoad || latestLoad === pendingLoad) return
    pendingLoad = latestLoad
  }
}

export const DEFAULT_BROWSER_CDP_CONFIG: BrowserCdpConfig = {
  enabled: false,
  profileImportEnabled: false
}

function contentTextLength(content: Message["content"] | undefined): number {
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

function isWorkerProvisionalRenderId(message: Message): boolean {
  const renderId = workerTransportRenderId(message)
  return renderId.startsWith("worker-live-") || renderId.startsWith("worker-snapshot-")
}

function isWorkerProvisionalSourceId(sourceId: string | undefined): boolean {
  if (!sourceId) return false
  const renderId = parseWorkerTurnScopedId(sourceId)?.rawId ?? sourceId
  return renderId.startsWith("worker-live-") || renderId.startsWith("worker-snapshot-")
}

function enrichWorkerProvisionalProviderIdentities(
  existingMessages: readonly Message[],
  incomingMessages: readonly Message[]
): Message[] {
  return existingMessages.map((existing) => {
    const existingProviderSourceId = existing.provider_source_id?.trim()
    if (
      !isWorkerProvisionalRenderId(existing) ||
      (existingProviderSourceId && !isWorkerProvisionalSourceId(existingProviderSourceId))
    ) {
      return existing
    }
    const matches = incomingMessages.filter(
      (incoming) =>
        incoming.id === existing.id &&
        incoming.role === existing.role &&
        Boolean(incoming.provider_source_id?.trim())
    )
    const providerSourceIds = new Set(
      matches.map((message) => message.provider_source_id?.trim()).filter(Boolean)
    )
    if (providerSourceIds.size !== 1) return existing
    const providerSourceId = [...providerSourceIds][0]
    const providerOccurrence = matches
      .map((message) => getMessageProviderOccurrence(message))
      .find((occurrence) => occurrence !== undefined)
    return {
      ...existing,
      provider_source_id: providerSourceId,
      ...(providerOccurrence !== undefined ? { provider_occurrence: providerOccurrence } : {})
    }
  })
}

function workerTransportIdentityKey(message: Message, turnKey: string): string {
  return [turnKey, message.role, workerTransportSourceId(message)].join("\u001f")
}

function workerProviderOccurrencesCompatible(left: Message, right: Message): boolean {
  const leftOccurrence = getMessageProviderOccurrence(left)
  const rightOccurrence = getMessageProviderOccurrence(right)
  return (
    leftOccurrence === undefined ||
    rightOccurrence === undefined ||
    leftOccurrence === rightOccurrence
  )
}

function findSameExplicitWorkerOccurrenceIndex(
  messages: readonly Message[],
  message: Message,
  turnKeys: readonly string[],
  turnKey: string
): number | undefined {
  const occurrence = getMessageProviderOccurrence(message)
  if (occurrence === undefined) return undefined
  const sourceId = workerTransportSourceId(message)
  const matches = messages.flatMap((candidate, candidateIndex) => {
    if (
      turnKeys[candidateIndex] !== turnKey ||
      candidate.role !== message.role ||
      workerTransportSourceId(candidate) !== sourceId
    ) {
      return []
    }
    const candidateOccurrence = getMessageProviderOccurrence(candidate)
    return candidateOccurrence === occurrence ||
      (occurrence === 1 && candidateOccurrence === undefined)
      ? [candidateIndex]
      : []
  })
  return matches.length === 1 ? matches[0] : undefined
}

function findExplicitWorkerUserOccurrenceIndex(
  messages: readonly Message[],
  message: Message
): number | undefined {
  const occurrence = getMessageProviderOccurrence(message)
  if (message.role !== "user" || occurrence === undefined) return undefined
  const sourceId = workerTransportSourceId(message)
  const matches = messages.flatMap((candidate, candidateIndex) =>
    candidate.role === "user" &&
    workerTransportSourceId(candidate) === sourceId &&
    (getMessageProviderOccurrence(candidate) ?? 1) === occurrence
      ? [candidateIndex]
      : []
  )
  return matches.length === 1 ? matches[0] : undefined
}

function ensureUniqueWorkerMessageId(messages: readonly Message[], message: Message): Message {
  const occupiedIds = new Set(messages.map((candidate) => candidate.id))
  if (!occupiedIds.has(message.id)) return message
  const sourceId = workerTransportSourceId(message)
  const occurrence = getMessageProviderOccurrence(message) ?? 1
  return {
    ...message,
    id: buildAvailableProviderOccurrenceId(sourceId, message.role, occurrence, occupiedIds),
    provider_source_id: sourceId,
    provider_occurrence: occurrence
  }
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
      workerProviderOccurrencesCompatible(candidate, message) &&
      workerTransportRenderId(candidate) === renderId
  )
  if (exactIndex >= 0) return exactIndex

  if (renderId.includes(MESSAGE_SAME_ROLE_DUPLICATE_MARKER)) return undefined

  const sourceId = workerTransportSourceId(message)
  const providerMatches = messages.flatMap((candidate, candidateIndex) =>
    turnKeys[candidateIndex] === turnKey &&
    candidate.role === message.role &&
    workerProviderOccurrencesCompatible(candidate, message) &&
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
  if (!workerProviderOccurrencesCompatible(a, b)) return false
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
      (toolCall, candidateIndex) => !usedIndexes?.has(candidateIndex) && toolCall.id === target.id
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
      !usedIndexes?.has(candidateIndex) && !toolCall.id && toolCall.name === target.name
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

function areIncomingWorkerToolCallsSubset(
  existing: Message["tool_calls"] | undefined,
  incoming: Message["tool_calls"] | undefined
): boolean {
  if (!incoming?.length) return true
  if (!existing?.length || existing.length < incoming.length) return false
  const usedIndexes = new Set<number>()
  for (let index = 0; index < incoming.length; index += 1) {
    const match = findWorkerToolCallMatch(existing, incoming[index], index, usedIndexes)
    if (!match) return false
    if (match.call.name && incoming[index].name && match.call.name !== incoming[index].name) {
      return false
    }
    usedIndexes.add(match.index)
  }
  return true
}

function isCompatibleWorkerAssistantToolReplay(a: Message, b: Message): boolean {
  if (a.role !== "assistant" || b.role !== "assistant") return false
  if (!workerProviderOccurrencesCompatible(a, b)) return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (!areWorkerToolCallsCompatible(a.tool_calls, b.tool_calls)) return false
  return areWorkerContentsCompatible(a.content, b.content)
}

function isCompatibleWorkerToolResultReplay(a: Message, b: Message): boolean {
  if (a.role !== "tool" || b.role !== "tool") return false
  if (!workerProviderOccurrencesCompatible(a, b)) return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (!a.tool_call_id || a.tool_call_id !== b.tool_call_id) return false
  if (a.name && b.name && a.name !== b.name) return false
  return areWorkerContentsCompatible(a.content, b.content)
}

function areWorkerMessagesCompatibleForOccurrenceReservation(
  existing: Message,
  incoming: Message
): boolean {
  if (existing.role !== incoming.role) return false
  if (!workerProviderOccurrencesCompatible(existing, incoming)) return false
  if (!areWorkerContentsCompatible(existing.content, incoming.content)) return false
  if (existing.role === "assistant") {
    return areIncomingWorkerToolCallsSubset(existing.tool_calls, incoming.tool_calls)
  }
  if (existing.role === "tool") {
    return (
      existing.tool_call_id === incoming.tool_call_id &&
      (!existing.name || !incoming.name || existing.name === incoming.name)
    )
  }
  return false
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
    return currentTurn > 0 ? `__cmb-worker-turn-${currentTurn}__` : WORKER_PRE_USER_TURN_KEY
  })
}

function workerTurnSignatureKey(
  turnKey: string,
  signature: string | undefined
): string | undefined {
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

  // Focused live events normally describe the newest worker turn. If older
  // turns produced identical text, match against the newest compatible replay
  // window rather than the oldest matching snapshot.
  const matchPosition = Math.max(0, indexes.length - remaining)
  const [index] = indexes.splice(matchPosition, 1)
  remainingBySignature.set(signature, remaining - 1)
  return index
}

function pruneWorkerFocusMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_WORKER_FOCUS_MESSAGES) return messages
  return messages.slice(-MAX_WORKER_FOCUS_MESSAGES)
}

function orderWorkerFocusMessagesByScopedTurn(messages: Message[]): Message[] {
  const scopedMessages = messages
    .map((message, index) => ({
      message,
      index,
      turn: parseWorkerTurnScopedId(message.id)?.turn
    }))
    .filter(
      (entry): entry is { message: Message; index: number; turn: number } =>
        entry.turn !== undefined
    )
  if (scopedMessages.length <= 1) return messages
  const orderedScopedMessages = scopedMessages
    .sort((left, right) => left.turn - right.turn || left.index - right.index)
    .map(({ message }) => message)
  let scopedIndex = 0
  return messages.map((message) =>
    parseWorkerTurnScopedId(message.id) ? orderedScopedMessages[scopedIndex++] : message
  )
}

function reorderWorkerFocusMessagesByIncomingOrder(
  messages: Message[],
  incomingIndexes: number[],
  turnKeys: string[]
): Message[] {
  const incomingIndexSet = new Set<number>()
  const incomingOrderedMessages: Message[] = []
  const incomingOrderedTurnKeys: string[] = []
  for (const index of incomingIndexes) {
    if (index < 0 || index >= messages.length || incomingIndexSet.has(index)) continue
    incomingIndexSet.add(index)
    incomingOrderedMessages.push(messages[index])
    incomingOrderedTurnKeys.push(turnKeys[index] ?? WORKER_PRE_USER_TURN_KEY)
  }
  const turnKeyByMessage = new Map(
    messages.map((message, index) => [message, turnKeys[index] ?? WORKER_PRE_USER_TURN_KEY])
  )
  const reordered = [...messages]
  if (incomingOrderedMessages.length > 1) {
    const incomingSlots = [...incomingIndexSet].sort((left, right) => left - right)
    incomingSlots.forEach((slot, index) => {
      reordered[slot] = incomingOrderedMessages[index]
    })
  }
  for (const [incomingIndex, incomingMessage] of incomingOrderedMessages.entries()) {
    const incomingOccurrence = getMessageProviderOccurrence(incomingMessage)
    if (incomingOccurrence === undefined) continue
    const currentIndex = reordered.findIndex((message) => message.id === incomingMessage.id)
    if (currentIndex < 0) continue
    const incomingTurnKey = incomingOrderedTurnKeys[incomingIndex]
    const incomingSourceId = getMessageProviderSourceId(incomingMessage)
    const insertionIndex = reordered.findIndex(
      (candidate, index) =>
        index < currentIndex &&
        turnKeyByMessage.get(candidate) === incomingTurnKey &&
        candidate.role === incomingMessage.role &&
        getMessageProviderSourceId(candidate) === incomingSourceId &&
        (getMessageProviderOccurrence(candidate) ?? 0) > incomingOccurrence
    )
    if (insertionIndex < 0) continue
    const [moved] = reordered.splice(currentIndex, 1)
    reordered.splice(insertionIndex, 0, moved)
  }
  return reordered
}

function mergeWorkerToolCalls(
  existing: Message["tool_calls"] | undefined,
  incoming: Message["tool_calls"] | undefined
): Message["tool_calls"] | undefined {
  if (!incoming?.length) return existing
  if (!existing?.length) return incoming
  const incomingIsSparseSubset =
    existing.length > incoming.length && areIncomingWorkerToolCallsSubset(existing, incoming)
  if (!areWorkerToolCallsCompatible(existing, incoming) && !incomingIsSparseSubset) {
    return incoming
  }

  const usedIndexes = new Set<number>()
  const merged = incomingIsSparseSubset
    ? existing.map((toolCall) => ({ ...toolCall }))
    : incoming.map((toolCall) => ({ ...toolCall }))
  incoming.forEach((incomingToolCall, index) => {
    const match = findWorkerToolCallMatch(existing, incomingToolCall, index, usedIndexes)
    if (match) usedIndexes.add(match.index)
    const existingToolCall = match?.call
    const mergedToolCall = {
      ...(existingToolCall ?? incomingToolCall),
      ...incomingToolCall,
      args: hasWorkerToolArgs(incomingToolCall.args)
        ? incomingToolCall.args
        : (existingToolCall?.args ?? incomingToolCall.args)
    }
    if (incomingIsSparseSubset && match) merged[match.index] = mergedToolCall
    else merged[index] = mergedToolCall
  })
  return merged
}

function resolveWorkerFocusContent(
  existingMessage: Message,
  incomingMessage: Message,
  incomingIsOrderedSnapshot: boolean = false,
  incomingDefinesRepeatedOccurrence: boolean = false
): Message["content"] {
  if (incomingIsOrderedSnapshot && incomingDefinesRepeatedOccurrence) {
    return incomingMessage.content ?? ""
  }
  if (incomingIsOrderedSnapshot) {
    return preferIncomingContent(existingMessage.content, incomingMessage.content)
  }
  if (
    isWorkerNonSnapshotMessageId(existingMessage.id) &&
    existingMessage.id === incomingMessage.id
  ) {
    return incomingMessage.content ?? existingMessage.content ?? ""
  }

  if (isWorkerSnapshotMessageId(incomingMessage.id)) {
    return preferIncomingContent(existingMessage.content, incomingMessage.content)
  }

  if (isWorkerSnapshotMessageId(existingMessage.id)) {
    return preferIncomingContent(incomingMessage.content, existingMessage.content)
  }

  return preferIncomingContent(existingMessage.content, incomingMessage.content)
}

const normalizedWorkerFocusMessageArrays = new WeakSet<readonly Message[]>()

function workerProviderIdentityExactlyMatches(existing: Message, incoming: Message): boolean {
  const existingSourceId = existing.provider_source_id?.trim() || undefined
  const incomingSourceId = incoming.provider_source_id?.trim() || undefined
  return (
    existingSourceId === incomingSourceId &&
    getMessageProviderOccurrence(existing) === getMessageProviderOccurrence(incoming)
  )
}

/**
 * Common live assistant chunks already arrive as a cumulative snapshot for the
 * same final array entry. Once an array has passed the full reconciliation path,
 * update that tail without rescanning up to 2,000 historical messages.
 */
export function mergeWorkerFocusTailUpdate(
  existingMessages: Message[],
  incomingMessage: Message
): Message[] | undefined {
  const existing = existingMessages.at(-1)
  if (
    !existing ||
    existing.role !== "assistant" ||
    incomingMessage.role !== "assistant" ||
    existing.id !== incomingMessage.id ||
    !workerProviderIdentityExactlyMatches(existing, incomingMessage)
  ) {
    return undefined
  }

  existingMessages[existingMessages.length - 1] = {
    ...existing,
    ...incomingMessage,
    id: existing.id,
    content: resolveWorkerFocusContent(existing, incomingMessage),
    reasoning: incomingMessage.reasoning ?? existing.reasoning,
    tool_calls: mergeWorkerToolCalls(existing.tool_calls, incomingMessage.tool_calls),
    tool_call_id: incomingMessage.tool_call_id ?? existing.tool_call_id,
    name: incomingMessage.name ?? existing.name,
    status: incomingMessage.status ?? existing.status,
    is_error: incomingMessage.is_error ?? existing.is_error
  }
  return existingMessages
}

function rememberNormalizedWorkerFocusMessages(messages: Message[]): Message[] {
  normalizedWorkerFocusMessageArrays.add(messages)
  return messages
}

/**
 * Reuse the panel's already-merged prefix only when its tail was the exact
 * previous live object. A checkpoint-enriched/replay-aligned tail deliberately
 * falls back to the full panel merge so sparse-history semantics stay intact.
 */
export function applyWorkerFocusTailUpdateToMergedMessages(
  previousMergedMessages: Message[],
  previousLiveTail: Message | undefined,
  nextLiveMessages: readonly Message[]
): Message[] | undefined {
  const nextLiveTail = nextLiveMessages.at(-1)
  if (
    !previousLiveTail ||
    !nextLiveTail ||
    previousLiveTail.id !== nextLiveTail.id ||
    previousLiveTail.role !== nextLiveTail.role
  ) {
    return undefined
  }

  // With no separately hydrated history the merged view can be the live array
  // itself. The store has already replaced its tail in place, so no work remains.
  if (previousMergedMessages === nextLiveMessages) return previousMergedMessages

  const previousMergedTail = previousMergedMessages.at(-1)
  if (
    previousMergedTail !== previousLiveTail ||
    previousLiveTail.id !== nextLiveTail.id ||
    previousLiveTail.role !== nextLiveTail.role
  ) {
    return undefined
  }

  previousMergedMessages[previousMergedMessages.length - 1] = nextLiveTail
  return previousMergedMessages
}

function preferIncomingContent(
  existing: Message["content"] | undefined,
  incoming: Message["content"] | undefined
): Message["content"] {
  const existingLength = contentTextLength(existing)
  const incomingLength = contentTextLength(incoming)
  if (incomingLength === 0) return existing ?? ""
  if (existingLength > incomingLength) return existing ?? ""

  return incoming ?? ""
}

type WorkerFocusAppendOptions = {
  orderedSnapshot?: boolean
}

type EvolutionTab = "candidates" | "traces" | "review"
type MainView =
  | "thread"
  | "customize"
  | "evolution"
  | "kanban"
  | "harness"
  | "claudecode"
  | "dashboard"

interface ThreadNavigationOptions {
  preserveView?: boolean
}

interface ThreadDirectoryLoadOptions {
  selectInitialThread?: boolean
}

function resolveChatThreadId(threads: Thread[], preferredThreadId?: string | null): string | null {
  const preferredThread = preferredThreadId
    ? threads.find((thread) => thread.thread_id === preferredThreadId)
    : null
  if (preferredThread && !isHarnessProjectModeThread(preferredThread)) {
    return preferredThread.thread_id
  }
  return findFirstChatThread(threads)?.thread_id ?? null
}

interface EvolutionRunProgress {
  runId: string
  traceId: string
  index: number
  total: number
  status: "pending" | "running" | "completed" | "failed"
  message?: string
  candidateCount?: number
}

export interface WorkerFocusView {
  threadId: string
  workerId: string
  workerThreadId: string
  role: "implementer" | "verifier"
  description: string
  status?: "running" | "completed" | "failed" | "cancelled"
}

export interface SubagentFocusView {
  threadId: string
  subagentId: string
  name: string
  description: string
  status?: "pending" | "running" | "completed" | "failed" | "cancelled"
}

export interface RightPanelWorkRequest {
  id: number
  target: "systemConstraints" | "agents"
  threadId: string
}

export type RightModule = "work" | "preview" | "git" | "browser"

/** Focus on one dynamic-workflow subagent's live tool stream. Keyed by the PARENT
 * threadId (the live panel's thread) + the run's agentIndex. Display-only. */
export interface WorkflowAgentFocusView {
  threadId: string
  runId: string
  agentIndex: number
  label: string
  status?: "running" | "completed" | "error" | "cached"
}

interface AppState {
  // Main content view routing
  mainView: MainView

  // Threads
  threads: Thread[]
  currentThreadId: string | null
  threadDirectoryHasMore: boolean
  threadDirectoryLoadingMore: boolean

  // Models and Providers (global, not per-thread)
  models: ModelConfig[]
  providers: Provider[]

  // Right panel state (UI state, not thread data)
  rightPanelTab: "todos" | "files" | "subagents"
  rightModule: RightModule

  // Settings dialog state
  settingsOpen: boolean
  browserCdpConfig: BrowserCdpConfig
  chatScrollSettings: ChatScrollSettings

  // Sidebar state
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
  rightPanelWorkRequestSequence: number
  rightPanelWorkRequest: RightPanelWorkRequest | null

  // Split view for inspecting a single coordinator worker stream.
  workerFocusView: WorkerFocusView | null
  workerFocusMessagesThreadId: string | null
  workerFocusMessages: Message[]
  workerFocusMessagesContentVersion: number
  openWorkerFocusView: (view: WorkerFocusView) => void
  closeWorkerFocusView: () => void
  appendWorkerFocusMessage: (workerThreadId: string, message: Message) => void
  appendWorkerFocusMessages: (
    workerThreadId: string,
    messages: Message[],
    options?: WorkerFocusAppendOptions
  ) => void

  // Split view for inspecting a short-lived task subagent transcript.
  subagentFocusView: SubagentFocusView | null
  openSubagentFocusView: (view: SubagentFocusView) => void
  closeSubagentFocusView: () => void

  // Split view for inspecting one dynamic-workflow subagent's live tool stream
  // (display-only; fed by the best-effort main-process values tap).
  workflowAgentFocusView: WorkflowAgentFocusView | null
  /** The CURRENTLY-FOCUSED agent's raw `snapshotMessages` (a single agent, on demand).
   * Loaded by the panel — live frames while the agent runs, or its persisted sidecar
   * when finished — and released (null) on switch/close, so only the agent you are
   * actually viewing costs any memory. */
  workflowAgentFocusSnapshot: unknown
  openWorkflowAgentFocusView: (view: WorkflowAgentFocusView) => void
  closeWorkflowAgentFocusView: () => void
  /** Set/replace the focused agent's raw snapshot (latest-wins), or null to release. */
  setWorkflowAgentFocusSnapshot: (snapshot: unknown) => void

  // Kanban view state
  showKanbanView: boolean
  showSubagentsInKanban: boolean

  // Harness board view state
  showHarnessBoardView: boolean

  // Claude Code view state
  showClaudeCodeView: boolean
  previousThreadId: string | null // 切换到 Claude Code 前保存的线程 ID
  setShowClaudeCodeView: (show: boolean) => void

  // Dashboard view state
  showDashboardView: boolean
  setShowDashboardView: (show: boolean) => void
  dashboardAllowed: boolean | null // null = loading
  loadDashboardAllowed: () => Promise<void>

  // Customize view state
  showCustomizeView: boolean
  customizeInitialTab: string | null
  marketInitialSkillCategory: string | null
  marketInitialSkillSearchQuery: string | null
  marketInitialSkillDetailName: string | null
  marketInitialSkillFilters: string[] | null
  marketInitialTab: string | null

  // Thread actions
  loadThreads: (options?: ThreadDirectoryLoadOptions) => Promise<void>
  addThreadSummary: (thread: Thread) => void
  loadMoreThreads: () => Promise<void>
  touchThreadSummaries: (threadIds: Iterable<string>, updatedAt: Date) => void
  createThread: (
    metadata?: Record<string, unknown>,
    options?: ThreadNavigationOptions
  ) => Promise<Thread>
  forkThread: (params: ThreadForkParams, options?: ThreadNavigationOptions) => Promise<Thread>
  listForkableCheckpoints: (threadId: string) => Promise<ForkableCheckpoint[]>
  selectThread: (threadId: string, options?: ThreadNavigationOptions) => Promise<void>
  deleteThread: (
    threadId: string,
    options?: ThreadDeleteOptions & { deferDirectoryUpdate?: boolean }
  ) => Promise<void>
  finalizeThreadDeletions: (threadIds: Iterable<string>) => void
  updateThread: (threadId: string, updates: Partial<Thread>) => Promise<void>
  patchThreadMetadata: (threadId: string, patch: ThreadMetadataPatch) => Promise<void>
  generateTitleForFirstMessage: (threadId: string, content: string) => Promise<void>

  // Model actions
  loadModels: (force?: boolean) => Promise<void>
  loadProviders: (force?: boolean) => Promise<void>

  // Panel actions
  setRightPanelTab: (tab: "todos" | "files" | "subagents") => void
  setRightModule: (module: RightModule) => void
  requestOpenBrowserPanel: () => void

  // Settings actions
  setSettingsOpen: (open: boolean) => void
  setChatScrollSettings: (settings: ChatScrollSettings) => void
  loadChatScrollSettings: () => Promise<void>
  setBrowserCdpConfig: (config: BrowserCdpConfig) => void

  // Sidebar actions
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleRightPanel: () => void
  setRightPanelCollapsed: (collapsed: boolean) => void
  requestOpenRightPanelSystemConstraints: (threadId: string) => void
  requestOpenRightPanelAgents: (threadId: string) => void
  consumeRightPanelWorkRequest: (requestId: number) => void

  // Kanban actions
  setShowKanbanView: (show: boolean) => void
  setShowSubagentsInKanban: (show: boolean) => void

  // Harness board actions
  setShowHarnessBoardView: (show: boolean) => void

  // Customize actions
  setShowCustomizeView: (show: boolean, tab?: string) => void
  setMarketInitialSkillCategory: (category: string | null) => void
  setMarketInitialSkillSearchQuery: (query: string | null) => void
  setMarketInitialSkillDetailName: (name: string | null) => void
  setMainView: (view: MainView) => void
  setMarketInitialSkillFilters: (filters: string[] | null) => void
  setMarketInitialTab: (tab: string | null) => void

  // Plugin state sync — increment to trigger RightPanel refresh
  pluginVersion: number
  bumpPluginVersion: () => void

  // Skill evolution — true when threshold reached, clears when Evolution panel opens
  pendingEvolution: boolean
  setPendingEvolution: (v: boolean) => void
  cloudEvolutionUpdates: EvolutionCandidate[]
  setCloudEvolutionUpdates: (updates: EvolutionCandidate[]) => void

  // Skill generation virtual subagent — shown in the right panel agents section.
  // State is stored per-thread so switching threads preserves each thread's card.
  skillGenerationByThread: Map<
    string,
    {
      phase: "generating" | "done" | "error" | null
      streamedText: string
      errorText: string
    }
  >
  setSkillGenerationPhase: (phase: "generating" | "done" | "error" | null, text?: string) => void
  appendSkillGenerationToken: (token: string) => void

  // Per-thread retry context — cached when the user accepts the intent banner so that
  // the retry button can replay the generation without re-running the full proposal flow.
  skillRetryContextByThread: Map<string, { context: unknown; intentMode: string }>
  setSkillRetryContext: (retryContext: { context: unknown; intentMode: string } | null) => void

  // Evolution UI state — persists while switching customize submenus
  evolutionTab: EvolutionTab
  setEvolutionTab: (tab: EvolutionTab) => void
  evolutionRunning: boolean
  setEvolutionRunning: (running: boolean) => void
  evolutionRunningSummary: string | null
  setEvolutionRunningSummary: (summary: string | null) => void
  evolutionSummary: string | null
  setEvolutionSummary: (summary: string | null) => void
  evolutionSelectedTraceIds: Set<string>
  setEvolutionSelectedTraceIds: (ids: Set<string>) => void
  evolutionRunProgress: Record<string, EvolutionRunProgress>
  setEvolutionRunProgress: (progress: Record<string, EvolutionRunProgress>) => void
  mergeEvolutionRunProgress: (payload: EvolutionRunProgress) => void
  // Streaming text from the current/last optimizer LLM call
  evolutionStreamedText: string
  setEvolutionStreamedText: (text: string) => void
  appendEvolutionStreamedText: (chunk: string) => void
  evolutionStreamError: string | null
  setEvolutionStreamError: (err: string | null) => void
  // Options used for the last optimizer run (for retry)
  evolutionLastRunOpts: {
    mode?: "auto" | "selected"
    traceIds?: string[]
    threadId?: string
    traceLimit?: number
  } | null
  setEvolutionLastRunOpts: (
    opts: {
      mode?: "auto" | "selected"
      traceIds?: string[]
      threadId?: string
      traceLimit?: number
    } | null
  ) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  threads: [],
  currentThreadId: null,
  threadDirectoryHasMore: false,
  threadDirectoryLoadingMore: false,
  models: [],
  providers: [],
  rightPanelTab: "todos",
  rightModule: "work",
  settingsOpen: false,
  chatScrollSettings: normalizeChatScrollSettings({}),
  browserCdpConfig: DEFAULT_BROWSER_CDP_CONFIG,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  rightPanelWorkRequestSequence: 0,
  rightPanelWorkRequest: null,
  workerFocusView: null,
  workerFocusMessagesThreadId: null,
  workerFocusMessages: [],
  workerFocusMessagesContentVersion: 0,
  subagentFocusView: null,
  workflowAgentFocusView: null,
  workflowAgentFocusSnapshot: null,
  mainView: "thread",
  showKanbanView: false,
  showSubagentsInKanban: true,
  showHarnessBoardView: false,
  showClaudeCodeView: false,
  showDashboardView: false,
  dashboardAllowed: null,
  previousThreadId: null,
  showCustomizeView: false,
  customizeInitialTab: null,
  marketInitialSkillCategory: null,
  marketInitialSkillSearchQuery: null,
  marketInitialSkillDetailName: null,
  marketInitialSkillFilters: null,
  marketInitialTab: null,
  pluginVersion: 0,
  evolutionTab: "candidates",
  evolutionRunning: false,
  evolutionRunningSummary: null,
  evolutionSummary: null,
  evolutionSelectedTraceIds: new Set<string>(),
  evolutionRunProgress: {},
  evolutionStreamedText: "",
  evolutionStreamError: null,
  evolutionLastRunOpts: null,

  // Thread actions
  loadThreads: (options) => {
    if (options?.selectInitialThread) threadDirectoryBootstrapSelectionPending = true
    const generation = ++threadDirectoryLoadGeneration
    threadDirectoryLoadMorePromise = null
    const requestMutationEpoch = threadDirectoryMutationEpoch
    const loadPromise = (async (): Promise<boolean> => {
      const page = await window.api.threads.listPage({
        limit: THREAD_DIRECTORY_PAGE_LIMIT,
        byteBudget: THREAD_DIRECTORY_PAGE_BYTE_BUDGET
      })
      if (generation !== threadDirectoryLoadGeneration) return false

      threadDirectoryCursor =
        page.hasMore && page.beforeUpdatedAt !== null && page.beforeThreadId !== null
          ? { beforeUpdatedAt: page.beforeUpdatedAt, beforeThreadId: page.beforeThreadId }
          : null
      set((state) => {
        const threads = mergeThreadDirectoryFirstPage(state.threads, page.threads, {
          requestMutationEpoch,
          mutationEpochById: threadDirectoryMutationEpochById,
          knownIndexById: getThreadDirectoryIndex(state.threads),
          completeSnapshot: !page.hasMore,
          authoritativePageBoundary: page.hasMore ? page.threads.at(-1) : undefined
        })
        return {
          threads:
            threads === state.threads ? state.threads : adoptThreadDirectorySnapshot(threads),
          threadDirectoryHasMore: threadDirectoryCursor !== null,
          threadDirectoryLoadingMore: false
        }
      })
      forgetAcknowledgedThreadDirectoryMutations(requestMutationEpoch)

      // Directory refreshes are data-only. Only the explicit startup bootstrap may
      // choose a task, and a route change while the request was pending wins.
      const shouldSelectInitialThread = threadDirectoryBootstrapSelectionPending
      threadDirectoryBootstrapSelectionPending = false
      const state = get()
      if (shouldSelectInitialThread && state.mainView === "thread" && !state.currentThreadId) {
        const firstChatThread = findFirstChatThread(state.threads)
        if (firstChatThread) await get().selectThread(firstChatThread.thread_id)
      }

      return true
    })()
    threadDirectoryLatestLoadPromise = loadPromise

    return options?.selectInitialThread
      ? waitForAppliedThreadDirectoryLoad(loadPromise)
      : loadPromise.then(() => undefined)
  },

  loadMoreThreads: async () => {
    if (threadDirectoryLoadMorePromise) return threadDirectoryLoadMorePromise
    const initialCursor = threadDirectoryCursor
    if (!initialCursor || !get().threadDirectoryHasMore) return

    const generation = threadDirectoryLoadGeneration
    const requestMutationEpoch = threadDirectoryMutationEpoch
    const loadPromise = (async () => {
      set({ threadDirectoryLoadingMore: true })
      try {
        let cursor = initialCursor
        let hasMore = true
        const incoming: Thread[] = []
        for (let pageIndex = 0; pageIndex < THREAD_DIRECTORY_LOAD_MORE_PAGE_BATCH; pageIndex += 1) {
          const page = await window.api.threads.listPage({
            beforeUpdatedAt: cursor.beforeUpdatedAt,
            beforeThreadId: cursor.beforeThreadId,
            limit: THREAD_DIRECTORY_PAGE_LIMIT,
            byteBudget: THREAD_DIRECTORY_PAGE_BYTE_BUDGET
          })
          if (generation !== threadDirectoryLoadGeneration) return
          incoming.push(...page.threads)
          hasMore = page.hasMore && page.beforeUpdatedAt !== null && page.beforeThreadId !== null
          if (!hasMore) break
          cursor = {
            beforeUpdatedAt: page.beforeUpdatedAt as number,
            beforeThreadId: page.beforeThreadId as string
          }
        }
        if (generation !== threadDirectoryLoadGeneration) return

        threadDirectoryCursor = hasMore ? cursor : null
        set((state) => {
          const threads = appendThreadDirectoryPages(state.threads, incoming, {
            requestMutationEpoch,
            mutationEpochById: threadDirectoryMutationEpochById,
            knownIndexById: getThreadDirectoryIndex(state.threads)
          })
          return {
            threads:
              threads === state.threads ? state.threads : adoptThreadDirectorySnapshot(threads),
            threadDirectoryHasMore: threadDirectoryCursor !== null,
            threadDirectoryLoadingMore: false
          }
        })
        forgetAcknowledgedThreadDirectoryMutations(requestMutationEpoch)
      } catch (error) {
        if (generation === threadDirectoryLoadGeneration) {
          console.error("[Store] Failed to load older tasks:", error)
        }
      } finally {
        if (generation === threadDirectoryLoadGeneration) {
          threadDirectoryLoadMorePromise = null
          set({ threadDirectoryLoadingMore: false })
        }
      }
    })()
    threadDirectoryLoadMorePromise = loadPromise
    return loadPromise
  },

  touchThreadSummaries: (threadIds, updatedAt) => {
    const uniqueIds = new Set(threadIds)
    if (uniqueIds.size === 0) return
    for (const threadId of uniqueIds) markThreadDirectoryMutation(threadId)
    set((state) => {
      const indexById = getThreadDirectoryIndex(state.threads)
      let threads: Thread[] | null = null
      for (const threadId of uniqueIds) {
        const index = indexById.get(threadId)
        if (index === undefined) continue
        threads ??= [...state.threads]
        threads[index] = { ...threads[index], updated_at: updatedAt }
      }
      return threads ? { threads: adoptThreadDirectorySnapshot(threads) } : state
    })
  },

  addThreadSummary: (thread) => {
    markThreadDirectoryMutation(thread.thread_id)
    set((state) => ({
      threads: adoptThreadDirectorySnapshot([
        thread,
        ...state.threads.filter((item) => item.thread_id !== thread.thread_id)
      ])
    }))
  },

  createThread: async (metadata?: Record<string, unknown>, options?: ThreadNavigationOptions) => {
    const thread = await window.api.threads.create(metadata)
    markThreadDirectoryMutation(thread.thread_id)
    set((state) => ({
      threads: adoptThreadDirectorySnapshot([
        thread,
        ...state.threads.filter((item) => item.thread_id !== thread.thread_id)
      ]),
      currentThreadId: thread.thread_id,
      ...(options?.preserveView
        ? {}
        : {
            showKanbanView: false,
            showHarnessBoardView: false,
            showCustomizeView: false,
            showClaudeCodeView: false,
            showDashboardView: false,
            previousThreadId: null,
            mainView: "thread" as const,
            workerFocusView: null,
            workerFocusMessagesThreadId: null,
            workerFocusMessages: [],
            subagentFocusView: null,
            workflowAgentFocusView: null
          })
      // skillGenerationByThread is NOT reset here: new threads start with no entry
      // in the map, so the card is naturally absent without discarding other threads' state.
    }))
    return thread
  },

  forkThread: async (params: ThreadForkParams, options?: ThreadNavigationOptions) => {
    const response = await window.api.threads.fork(params)
    const thread = response.thread
    markThreadDirectoryMutation(thread.thread_id)
    set((state) => ({
      threads: adoptThreadDirectorySnapshot([
        thread,
        ...state.threads.filter((item) => item.thread_id !== thread.thread_id)
      ]),
      currentThreadId: thread.thread_id,
      ...(options?.preserveView
        ? {}
        : {
            showKanbanView: false,
            showHarnessBoardView: false,
            showCustomizeView: false,
            showClaudeCodeView: false,
            showDashboardView: false,
            previousThreadId: null,
            mainView: "thread" as const,
            workerFocusView: null,
            workerFocusMessagesThreadId: null,
            workerFocusMessages: [],
            subagentFocusView: null,
            workflowAgentFocusView: null
          })
    }))
    return thread
  },

  listForkableCheckpoints: async (threadId: string) => {
    return window.api.threads.listForkableCheckpoints(threadId)
  },

  selectThread: async (threadId: string, options?: ThreadNavigationOptions) => {
    set({
      currentThreadId: threadId,
      ...(options?.preserveView
        ? {}
        : {
            showKanbanView: false,
            showHarnessBoardView: false,
            showCustomizeView: false,
            showClaudeCodeView: false,
            showDashboardView: false,
            previousThreadId: null,
            mainView: "thread" as const,
            workerFocusView: null,
            workerFocusMessagesThreadId: null,
            workerFocusMessages: [],
            subagentFocusView: null,
            workflowAgentFocusView: null
          })
      // skillGenerationByThread is NOT cleared here: each thread retains its own card
      // state so switching back to a thread shows the card exactly as it was left.
    })
  },

  deleteThread: async (
    threadId: string,
    options?: ThreadDeleteOptions & { deferDirectoryUpdate?: boolean }
  ) => {
    console.log("[Store] Deleting thread:", threadId)
    rendererDeletingThreadIds.add(threadId)
    markThreadDirectoryMutation(threadId)
    try {
      await window.api.threads.delete(
        threadId,
        options?.requireIdle === undefined && options?.groupGuard === undefined
          ? undefined
          : { requireIdle: options?.requireIdle, groupGuard: options?.groupGuard }
      )
      rendererDeletingThreadIds.delete(threadId)
      rendererRetiredThreadIds.add(threadId)
      // A directory refresh may start after the optimistic fence but still read
      // before the database commit becomes visible. Advance the epoch again at
      // the commit acknowledgement so that stale page cannot resurrect the row.
      markThreadDirectoryMutation(threadId)
      console.log("[Store] Thread deleted from backend")
      // The draft-message queue is persisted to localStorage independent of the
      // DB thread record (thread-context.tsx's persistQueuedMessages) so it
      // survives reloads; nothing else clears that key, so it would otherwise
      // sit there forever once the thread it belonged to is gone.
      // Permanent deletion must evict message-bearing projection/scroll caches immediately.
      // Advancing the scroll lease also ignores a late React unmount save from the old row.
      runBestEffortCommittedDeletionCleanups([
        {
          label: "Failed to remove deleted thread queue",
          run: () => window.localStorage.removeItem(queueStorageKey(threadId))
        },
        {
          label: "Failed to clear deleted thread projection",
          run: () => clearChatThreadProjectionRuntime(threadId)
        },
        {
          label: "Failed to clear deleted thread scroll state",
          run: () => chatScrollSessionStore.delete(threadId)
        },
        ...(options?.deferDirectoryUpdate
          ? []
          : [
              {
                label: "Failed to finalize deleted thread directory state",
                run: () => get().finalizeThreadDeletions([threadId])
              }
            ])
      ])
    } catch (error) {
      rendererDeletingThreadIds.delete(threadId)
      console.error("[Store] Failed to delete thread:", error)
      throw error
    }
  },

  finalizeThreadDeletions: (threadIds: Iterable<string>) => {
    const deletedIds = new Set(threadIds)
    if (deletedIds.size === 0) return
    set((state) => {
      const threads = state.threads.filter((thread) => !deletedIds.has(thread.thread_id))
      const directoryChanged = threads.length !== state.threads.length
      const currentThreadDeleted =
        state.currentThreadId !== null && deletedIds.has(state.currentThreadId)
      const previousThreadDeleted =
        state.previousThreadId !== null && deletedIds.has(state.previousThreadId)
      const workerFocusDeleted = Boolean(
        state.workerFocusView && deletedIds.has(state.workerFocusView.threadId)
      )
      const subagentFocusDeleted = Boolean(
        state.subagentFocusView && deletedIds.has(state.subagentFocusView.threadId)
      )
      const workflowAgentFocusDeleted = Boolean(
        state.workflowAgentFocusView && deletedIds.has(state.workflowAgentFocusView.threadId)
      )
      if (
        !directoryChanged &&
        !currentThreadDeleted &&
        !previousThreadDeleted &&
        !workerFocusDeleted &&
        !subagentFocusDeleted &&
        !workflowAgentFocusDeleted
      ) {
        // Most ids in a large group are intentionally absent from the bounded
        // directory. Returning the same state prevents a no-op full-app render.
        return state
      }

      return {
        ...(directoryChanged ? { threads: adoptThreadDirectorySnapshot(threads) } : {}),
        currentThreadId: currentThreadDeleted
          ? state.mainView === "harness"
            ? null
            : findFirstChatThread(threads)?.thread_id || null
          : state.currentThreadId,
        previousThreadId: previousThreadDeleted ? null : state.previousThreadId,
        ...(workerFocusDeleted
          ? {
              workerFocusView: null,
              workerFocusMessagesThreadId: null,
              workerFocusMessages: []
            }
          : {}),
        ...(subagentFocusDeleted ? { subagentFocusView: null } : {}),
        ...(workflowAgentFocusDeleted ? { workflowAgentFocusView: null } : {})
      }
    })
  },

  updateThread: async (threadId: string, updates: Partial<Thread>) => {
    if (isThreadDeletionPending(threadId)) return
    markThreadDirectoryMutation(threadId)
    const updated = await window.api.threads.update(threadId, updates)
    if (isThreadDeletionPending(threadId)) return
    set((state) => {
      const index = getThreadDirectoryIndex(state.threads).get(threadId)
      if (index === undefined) return state
      const threads = [...state.threads]
      threads[index] = updated
      return { threads: adoptThreadDirectorySnapshot(threads) }
    })
  },

  patchThreadMetadata: async (threadId: string, patch: ThreadMetadataPatch) => {
    markThreadDirectoryMutation(threadId)
    const updated = await window.api.threads.patchMetadata(threadId, patch)
    set((state) => {
      const index = getThreadDirectoryIndex(state.threads).get(threadId)
      if (index === undefined) return state
      const threads = [...state.threads]
      threads[index] = updated
      return { threads: adoptThreadDirectorySnapshot(threads) }
    })
  },

  generateTitleForFirstMessage: async (threadId: string, content: string) => {
    try {
      const generatedTitle = await window.api.threads.generateTitle(content)
      await get().updateThread(threadId, { title: generatedTitle })
    } catch (error) {
      console.error("[Store] Failed to generate title:", error)
    }
  },

  // Model actions
  loadModels: async (force = false) => {
    const snapshot = await revalidateModelCatalog(force)
    set({ models: snapshot.models, providers: snapshot.providers })
  },

  loadProviders: async (force = false) => {
    const snapshot = await revalidateModelCatalog(force)
    set({ models: snapshot.models, providers: snapshot.providers })
  },

  // Panel actions
  setRightPanelTab: (tab: "todos" | "files" | "subagents") => {
    set({ rightPanelTab: tab })
  },

  setRightModule: (rightModule: RightModule) => {
    set({ rightModule })
  },

  requestOpenBrowserPanel: () => {
    set({
      rightModule: "browser",
      rightPanelCollapsed: false
    })
  },

  // Settings actions
  setSettingsOpen: (open: boolean) => {
    set({ settingsOpen: open })
  },

  setChatScrollSettings: (settings: ChatScrollSettings) => {
    set({ chatScrollSettings: normalizeChatScrollSettings(settings) })
  },

  loadChatScrollSettings: async () => {
    try {
      const chatScrollSettings = await window.electron.getChatScrollSettings()
      get().setChatScrollSettings(chatScrollSettings)
    } catch (error) {
      console.warn("[Store] Failed to load chat scroll settings; using defaults:", error)
    }
  },

  setBrowserCdpConfig: (browserCdpConfig: BrowserCdpConfig) => {
    set({ browserCdpConfig })
  },

  // Sidebar actions
  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setSidebarCollapsed: (collapsed: boolean) => {
    set({ sidebarCollapsed: collapsed })
  },

  toggleRightPanel: () => {
    set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed }))
  },

  setRightPanelCollapsed: (collapsed: boolean) => {
    set({ rightPanelCollapsed: collapsed })
  },

  requestOpenRightPanelSystemConstraints: (threadId: string) => {
    set((state) => {
      const requestId = state.rightPanelWorkRequestSequence + 1
      return {
        rightPanelCollapsed: false,
        rightPanelWorkRequestSequence: requestId,
        rightPanelWorkRequest: {
          id: requestId,
          target: "systemConstraints",
          threadId
        }
      }
    })
  },

  requestOpenRightPanelAgents: (threadId: string) => {
    set((state) => {
      const requestId = state.rightPanelWorkRequestSequence + 1
      return {
        rightPanelCollapsed: false,
        rightPanelWorkRequestSequence: requestId,
        rightPanelWorkRequest: {
          id: requestId,
          target: "agents",
          threadId
        }
      }
    })
  },

  consumeRightPanelWorkRequest: (requestId: number) => {
    set((state) =>
      state.rightPanelWorkRequest?.id === requestId ? { rightPanelWorkRequest: null } : {}
    )
  },

  openWorkerFocusView: (view) => {
    set({
      workerFocusView: view,
      workerFocusMessagesThreadId: view.workerThreadId,
      workerFocusMessages: [],
      workerFocusMessagesContentVersion: 0,
      subagentFocusView: null,
      workflowAgentFocusView: null
    })
  },

  closeWorkerFocusView: () => {
    set({
      workerFocusView: null,
      workerFocusMessagesThreadId: null,
      workerFocusMessages: [],
      workerFocusMessagesContentVersion: 0
    })
  },

  openSubagentFocusView: (view) => {
    set({
      subagentFocusView: view,
      workerFocusView: null,
      workerFocusMessagesThreadId: null,
      workerFocusMessages: [],
      workflowAgentFocusView: null
    })
  },

  closeSubagentFocusView: () => {
    set({ subagentFocusView: null })
  },

  openWorkflowAgentFocusView: (view) => {
    // Mutually exclusive with the worker/subagent foci so only one stream panel shows.
    // The panel loads THIS agent on demand (live frames if running, the persisted sidecar
    // if finished) and releases it on switch/close, so only the agent you're viewing holds
    // memory.
    set((state) => {
      const prev = state.workflowAgentFocusView
      const sameAgent =
        !!prev &&
        prev.threadId === view.threadId &&
        prev.runId === view.runId &&
        prev.agentIndex === view.agentIndex
      return {
        workflowAgentFocusView: view,
        // Reset to the loading state (`undefined`) only when switching to a DIFFERENT
        // agent. Re-clicking the SAME open agent keeps its loaded snapshot so it can't get
        // stuck on a stale "loading" note (the effect won't re-run for an unchanged key).
        ...(sameAgent ? {} : { workflowAgentFocusSnapshot: undefined }),
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null
      }
    })
  },

  closeWorkflowAgentFocusView: () => {
    set({ workflowAgentFocusView: null, workflowAgentFocusSnapshot: null })
  },

  setWorkflowAgentFocusSnapshot: (snapshot) => {
    set({ workflowAgentFocusSnapshot: snapshot })
  },

  appendWorkerFocusMessage: (workerThreadId, message) => {
    get().appendWorkerFocusMessages(workerThreadId, [message])
  },

  appendWorkerFocusMessages: (workerThreadId, messages, options) => {
    if (messages.length === 0) return
    set((state) => {
      if (state.workerFocusView?.workerThreadId !== workerThreadId) return {}
      const existingMessages =
        state.workerFocusMessagesThreadId === workerThreadId ? state.workerFocusMessages : []
      const fastTailMessages =
        !options?.orderedSnapshot &&
        messages.length === 1 &&
        normalizedWorkerFocusMessageArrays.has(existingMessages)
          ? mergeWorkerFocusTailUpdate(existingMessages, messages[0])
          : undefined
      if (fastTailMessages) {
        return {
          workerFocusMessagesThreadId: workerThreadId,
          workerFocusMessages: rememberNormalizedWorkerFocusMessages(fastTailMessages),
          workerFocusMessagesContentVersion: state.workerFocusMessagesContentVersion + 1
        }
      }
      const normalizedExistingMessages = normalizeCompleteMessageIds(
        enrichWorkerProvisionalProviderIdentities(existingMessages, messages)
      )
      const normalizedMessages = options?.orderedSnapshot
        ? normalizeCompleteMessageIds(
            normalizeMessageRoleCollisionIds(normalizedExistingMessages, messages)
          )
        : normalizeAppendedMessageIds(normalizedExistingMessages, messages)

      const next = [...normalizedExistingMessages]
      const existingUserCount = normalizedExistingMessages.filter(
        (message) => message.role === "user"
      ).length
      const incomingUserCount = normalizedMessages.filter(
        (message) => message.role === "user"
      ).length
      const alignOrderedUserWindows =
        options?.orderedSnapshot && existingUserCount > 0 && incomingUserCount > 0
      const alignedTurnCount = Math.max(existingUserCount, incomingUserCount)
      const defaultIncomingTurnKeys = alignOrderedUserWindows
        ? relativeWorkerTurnKeys(normalizedMessages, alignedTurnCount - incomingUserCount)
        : workerTurnKeys(
            normalizedMessages,
            options?.orderedSnapshot
              ? WORKER_PRE_USER_TURN_KEY
              : latestWorkerTurnKey(normalizedExistingMessages)
          )
      const existingAlignedTurnKeys = relativeWorkerTurnKeys(
        normalizedExistingMessages,
        alignedTurnCount - existingUserCount
      )
      let alignedExistingUserTurnKey: string | undefined
      const incomingTurnKeys = defaultIncomingTurnKeys.map((turnKey, index) => {
        const message = normalizedMessages[index]
        if (message.role === "user") {
          const scopedTurn = parseWorkerTurnScopedId(message.id)?.turn
          const explicitOccurrenceExistingUserIndex = findExplicitWorkerUserOccurrenceIndex(
            normalizedExistingMessages,
            message
          )
          const incomingOccurrence = getMessageProviderOccurrence(message)
          const exactExistingUserIndex = normalizedExistingMessages.findIndex(
            (existing) =>
              existing.role === "user" &&
              existing.id === message.id &&
              (incomingOccurrence === undefined ||
                (getMessageProviderOccurrence(existing) ?? 1) === incomingOccurrence)
          )
          alignedExistingUserTurnKey =
            scopedTurn !== undefined
              ? `__cmb-worker-turn-${scopedTurn}__`
              : explicitOccurrenceExistingUserIndex !== undefined
                ? existingAlignedTurnKeys[explicitOccurrenceExistingUserIndex]
                : exactExistingUserIndex >= 0
                  ? existingAlignedTurnKeys[exactExistingUserIndex]
                  : undefined
        }
        return alignedExistingUserTurnKey ?? turnKey
      })
      const nextInitialTurnKey =
        options?.orderedSnapshot &&
        !normalizedExistingMessages.some((message) => message.role === "user")
          ? (incomingTurnKeys.at(-1) ?? WORKER_PRE_USER_TURN_KEY)
          : WORKER_PRE_USER_TURN_KEY
      const nextTurnKeys = alignOrderedUserWindows
        ? relativeWorkerTurnKeys(next, alignedTurnCount - existingUserCount)
        : workerTurnKeys(next, nextInitialTurnKey)
      const incomingResolvedIndexes: number[] = []
      const indexById = new Map(next.map((item, index) => [item.id, index]))
      const liveIndexesBySignature = new Map<string, number[]>()
      const snapshotIndexesBySignature = new Map<string, number[]>()
      const incomingLiveCountsBySignature = new Map<string, number>()
      const incomingSnapshotCountsBySignature = new Map<string, number>()
      const repeatedIncomingTransportIdentities = repeatedWorkerTransportIdentityKeys(
        normalizedMessages,
        incomingTurnKeys
      )
      const reservedExistingIndexByIncomingIndex = new Map<number, number>()
      const reservedIncomingIndexByExistingIndex = new Map<number, number>()
      const repeatedIdentitiesWithReservations = new Set<string>()
      for (const identityKey of repeatedIncomingTransportIdentities) {
        const incomingIndexes = normalizedMessages.flatMap((message, index) =>
          workerTransportIdentityKey(message, incomingTurnKeys[index]) === identityKey
            ? [index]
            : []
        )
        const existingIndexes = next.flatMap((message, index) =>
          workerTransportIdentityKey(message, nextTurnKeys[index]) === identityKey ? [index] : []
        )
        const usedIncomingIndexes = new Set<number>()
        const reservedExistingIndexes = new Set<number>()
        for (const existingIndex of existingIndexes) {
          const existingSignature = workerFocusMessageSignature(next[existingIndex])
          if (!existingSignature) continue
          const matchingIncomingIndexes = incomingIndexes.filter(
            (incomingIndex) =>
              !usedIncomingIndexes.has(incomingIndex) &&
              workerProviderOccurrencesCompatible(
                next[existingIndex],
                normalizedMessages[incomingIndex]
              ) &&
              workerFocusMessageSignature(normalizedMessages[incomingIndex]) === existingSignature
          )
          if (matchingIncomingIndexes.length !== 1) continue
          const incomingIndex = matchingIncomingIndexes[0]
          reservedExistingIndexByIncomingIndex.set(incomingIndex, existingIndex)
          reservedIncomingIndexByExistingIndex.set(existingIndex, incomingIndex)
          usedIncomingIndexes.add(incomingIndex)
          reservedExistingIndexes.add(existingIndex)
          repeatedIdentitiesWithReservations.add(identityKey)
        }
        for (const existingIndex of existingIndexes) {
          if (reservedExistingIndexes.has(existingIndex)) continue
          const matchingIncomingIndexes = incomingIndexes.filter(
            (incomingIndex) =>
              !usedIncomingIndexes.has(incomingIndex) &&
              areWorkerMessagesCompatibleForOccurrenceReservation(
                next[existingIndex],
                normalizedMessages[incomingIndex]
              )
          )
          if (matchingIncomingIndexes.length !== 1) continue
          const incomingIndex = matchingIncomingIndexes[0]
          reservedExistingIndexByIncomingIndex.set(incomingIndex, existingIndex)
          reservedIncomingIndexByExistingIndex.set(existingIndex, incomingIndex)
          usedIncomingIndexes.add(incomingIndex)
          reservedExistingIndexes.add(existingIndex)
          repeatedIdentitiesWithReservations.add(identityKey)
        }
      }
      normalizedMessages.forEach((message, index) => {
        const signature = workerTurnSignatureKey(
          incomingTurnKeys[index],
          workerFocusMessageSignature(message)
        )
        if (isWorkerNonSnapshotMessageId(message.id)) {
          incrementSignatureCount(incomingLiveCountsBySignature, signature)
        }
        if (isWorkerSnapshotMessageId(message.id)) {
          incrementSignatureCount(incomingSnapshotCountsBySignature, signature)
        }
      })
      next.forEach((item, index) => {
        const signature = workerTurnSignatureKey(
          nextTurnKeys[index],
          workerFocusMessageSignature(item)
        )
        if (signature && isWorkerNonSnapshotMessageId(item.id)) {
          const indexes = liveIndexesBySignature.get(signature) ?? []
          indexes.push(index)
          liveIndexesBySignature.set(signature, indexes)
        }
        if (signature && isWorkerSnapshotMessageId(item.id)) {
          const indexes = snapshotIndexesBySignature.get(signature) ?? []
          indexes.push(index)
          snapshotIndexesBySignature.set(signature, indexes)
        }
      })

      normalizedMessages.forEach((message, messageIndex) => {
        const turnKey = incomingTurnKeys[messageIndex]
        const transportIdentityKey = workerTransportIdentityKey(message, turnKey)
        const reservedExistingIndex = reservedExistingIndexByIncomingIndex.get(messageIndex)
        const useRepeatedOccurrenceReservation =
          repeatedIdentitiesWithReservations.has(transportIdentityKey)
        const exactExistingIndex = indexById.get(message.id)
        const incomingProviderOccurrence = getMessageProviderOccurrence(message)
        const rawExplicitOccurrenceExistingIndex = findSameExplicitWorkerOccurrenceIndex(
          next,
          message,
          nextTurnKeys,
          turnKey
        )
        const explicitOccurrenceReservationOwner =
          rawExplicitOccurrenceExistingIndex === undefined
            ? undefined
            : reservedIncomingIndexByExistingIndex.get(rawExplicitOccurrenceExistingIndex)
        const explicitOccurrenceExistingIndex =
          explicitOccurrenceReservationOwner === undefined ||
          explicitOccurrenceReservationOwner === messageIndex
            ? rawExplicitOccurrenceExistingIndex
            : undefined
        const exactIndexIsReservedForAnotherIncoming =
          exactExistingIndex !== undefined &&
          reservedIncomingIndexByExistingIndex.get(exactExistingIndex) !== undefined &&
          reservedIncomingIndexByExistingIndex.get(exactExistingIndex) !== messageIndex
        const compatibleExactExistingIndex =
          exactExistingIndex !== undefined &&
          !exactIndexIsReservedForAnotherIncoming &&
          next[exactExistingIndex].role === message.role &&
          (getMessageProviderOccurrence(next[exactExistingIndex]) === undefined ||
            getMessageProviderOccurrence(next[exactExistingIndex]) === incomingProviderOccurrence)
            ? exactExistingIndex
            : undefined
        const signature = workerTurnSignatureKey(turnKey, workerFocusMessageSignature(message))
        const existingIndex =
          incomingProviderOccurrence !== undefined
            ? (explicitOccurrenceExistingIndex ??
              reservedExistingIndex ??
              compatibleExactExistingIndex)
            : useRepeatedOccurrenceReservation
              ? (reservedExistingIndex ??
                (!exactIndexIsReservedForAnotherIncoming ? exactExistingIndex : undefined))
              : (exactExistingIndex ??
                findSameWorkerTransportIdentityIndex(next, message, nextTurnKeys, turnKey) ??
                (signature && isWorkerSnapshotMessageId(message.id)
                  ? takeWindowedSignatureMatch(
                      liveIndexesBySignature.get(signature),
                      incomingSnapshotCountsBySignature,
                      signature
                    )
                  : undefined) ??
                (signature && isWorkerNonSnapshotMessageId(message.id)
                  ? takeWindowedSignatureMatch(
                      snapshotIndexesBySignature.get(signature),
                      incomingLiveCountsBySignature,
                      signature
                    )
                  : undefined) ??
                findCompatibleWorkerReplayIndex(next, message, nextTurnKeys, turnKey) ??
                findSameWorkerAssistantTextIndex(next, message, nextTurnKeys, turnKey))
        if (existingIndex === undefined) {
          const appendedMessage = ensureUniqueWorkerMessageId(next, message)
          indexById.set(appendedMessage.id, next.length)
          if (signature && isWorkerNonSnapshotMessageId(appendedMessage.id)) {
            const indexes = liveIndexesBySignature.get(signature) ?? []
            indexes.push(next.length)
            liveIndexesBySignature.set(signature, indexes)
          }
          if (signature && isWorkerSnapshotMessageId(appendedMessage.id)) {
            const indexes = snapshotIndexesBySignature.get(signature) ?? []
            indexes.push(next.length)
            snapshotIndexesBySignature.set(signature, indexes)
          }
          incomingResolvedIndexes.push(next.length)
          next.push(appendedMessage)
          nextTurnKeys.push(turnKey)
          return
        }

        const existing = next[existingIndex]
        const incomingIdIsOccupied = next.some(
          (candidate, candidateIndex) =>
            candidateIndex !== existingIndex && candidate.id === message.id
        )
        const id =
          useRepeatedOccurrenceReservation && !incomingIdIsOccupied ? message.id : existing.id
        const incomingDefinesRepeatedOccurrence =
          repeatedIncomingTransportIdentities.has(workerTransportIdentityKey(message, turnKey)) &&
          !useRepeatedOccurrenceReservation
        next[existingIndex] = {
          ...existing,
          ...message,
          id,
          content: resolveWorkerFocusContent(
            existing,
            message,
            options?.orderedSnapshot === true,
            incomingDefinesRepeatedOccurrence
          ),
          reasoning: incomingDefinesRepeatedOccurrence
            ? message.reasoning
            : (message.reasoning ?? existing.reasoning),
          tool_calls: incomingDefinesRepeatedOccurrence
            ? message.tool_calls
              ? mergeWorkerToolCalls(existing.tool_calls, message.tool_calls)
              : undefined
            : mergeWorkerToolCalls(existing.tool_calls, message.tool_calls),
          tool_call_id: incomingDefinesRepeatedOccurrence
            ? message.tool_call_id
            : (message.tool_call_id ?? existing.tool_call_id),
          name: incomingDefinesRepeatedOccurrence ? message.name : (message.name ?? existing.name),
          status: incomingDefinesRepeatedOccurrence
            ? message.status
            : (message.status ?? existing.status),
          is_error: incomingDefinesRepeatedOccurrence
            ? message.is_error
            : (message.is_error ?? existing.is_error)
        }
        indexById.set(id, existingIndex)
        if (!incomingIdIsOccupied) indexById.set(message.id, existingIndex)
        incomingResolvedIndexes.push(existingIndex)
      })
      const orderedMessages = options?.orderedSnapshot
        ? reorderWorkerFocusMessagesByIncomingOrder(next, incomingResolvedIndexes, nextTurnKeys)
        : next
      const prunedMessages = pruneWorkerFocusMessages(
        orderWorkerFocusMessagesByScopedTurn(orderedMessages)
      )
      return {
        workerFocusMessagesThreadId: workerThreadId,
        workerFocusMessages: rememberNormalizedWorkerFocusMessages(prunedMessages),
        workerFocusMessagesContentVersion: state.workerFocusMessagesContentVersion + 1
      }
    })
  },

  // Claude Code actions
  setShowClaudeCodeView: (show: boolean) => {
    if (show) {
      // 保存当前线程 ID，切回时恢复；如果已有保存的（如从看板过来），不覆盖
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showClaudeCodeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showCustomizeView: false,
        showDashboardView: false,
        mainView: "claudecode",
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showClaudeCodeView: false,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  // Dashboard actions
  loadDashboardAllowed: async () => {
    const allowed = await window.api.dashboard.isAllowed().catch(() => false)
    const state = get()
    set({
      dashboardAllowed: allowed,
      ...(allowed
        ? {}
        : {
            showDashboardView: false,
            mainView: state.mainView === "dashboard" ? ("thread" as const) : state.mainView
          })
    })
  },

  setShowDashboardView: (show: boolean) => {
    if (show && get().dashboardAllowed !== true) return
    if (show) {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showDashboardView: true,
        showClaudeCodeView: false,
        showKanbanView: false,
        showHarnessBoardView: false,
        showCustomizeView: false,
        mainView: "dashboard",
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showDashboardView: false,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  // Kanban actions
  setShowKanbanView: (show: boolean) => {
    if (show) {
      // 保存当前线程（如果有且没有已保存的）
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showKanbanView: true,
        showHarnessBoardView: false,
        showCustomizeView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        mainView: "kanban",
        currentThreadId: null,
        previousThreadId: prev,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showKanbanView: false,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  setShowSubagentsInKanban: (show: boolean) => {
    set({ showSubagentsInKanban: show })
  },

  // Harness board actions
  setShowHarnessBoardView: (show: boolean) => {
    if (show) {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showHarnessBoardView: true,
        showKanbanView: false,
        showCustomizeView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        mainView: "harness",
        currentThreadId: null,
        previousThreadId: prev,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
    } else {
      const restored = get().previousThreadId
      const chatThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showHarnessBoardView: false,
        mainView: "thread",
        currentThreadId: chatThreadId,
        previousThreadId: null
      })
    }
  },

  setShowCustomizeView: (show: boolean, tab?: string) => {
    if (show) {
      set({
        showCustomizeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        customizeInitialTab: tab ?? null,
        mainView: "customize",
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showCustomizeView: false,
        customizeInitialTab: null,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  setMarketInitialSkillCategory: (category) => {
    set({ marketInitialSkillCategory: category })
  },

  setMarketInitialSkillSearchQuery: (query) => {
    set({ marketInitialSkillSearchQuery: query })
  },

  setMarketInitialSkillDetailName: (name) => {
    set({ marketInitialSkillDetailName: name })
  },

  setMarketInitialSkillFilters: (filters) => {
    set({ marketInitialSkillFilters: filters })
  },

  setMarketInitialTab: (tab) => {
    set({ marketInitialTab: tab })
  },

  setMainView: (view) => {
    if (view === "kanban") {
      set({
        mainView: "kanban",
        showKanbanView: true,
        showHarnessBoardView: false,
        showCustomizeView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
      return
    }

    if (view === "customize") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
      return
    }

    if (view === "evolution") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        customizeInitialTab: "evolution",
        showDashboardView: false,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
      return
    }

    if (view === "dashboard") {
      if (get().dashboardAllowed !== true) return
      const prev = get().previousThreadId || get().currentThreadId
      set({
        mainView: "dashboard",
        showDashboardView: true,
        showCustomizeView: false,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
      return
    }

    if (view === "claudecode") {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        mainView: "claudecode",
        showClaudeCodeView: true,
        showCustomizeView: false,
        showKanbanView: false,
        showHarnessBoardView: false,
        showDashboardView: false,
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
      return
    }

    if (view === "harness") {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        mainView: "harness",
        showHarnessBoardView: true,
        showCustomizeView: false,
        showKanbanView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: [],
        subagentFocusView: null,
        workflowAgentFocusView: null
      })
      return
    }

    const restored = get().previousThreadId
    const chatThreadId = resolveChatThreadId(get().threads, restored)
    set({
      mainView: "thread",
      showCustomizeView: false,
      showKanbanView: false,
      showHarnessBoardView: false,
      showClaudeCodeView: false,
      showDashboardView: false,
      currentThreadId: chatThreadId,
      previousThreadId: null
    })
  },

  bumpPluginVersion: () => {
    set((state) => ({ pluginVersion: state.pluginVersion + 1 }))
  },

  pendingEvolution: false,
  setPendingEvolution: (v) => set({ pendingEvolution: v }),
  cloudEvolutionUpdates: [],
  setCloudEvolutionUpdates: (updates) => set({ cloudEvolutionUpdates: updates }),

  // Per-thread skill generation state — keyed by threadId.
  skillGenerationByThread: new Map(),

  setSkillGenerationPhase: (phase, text = "") =>
    set((state) => {
      const threadId = state.currentThreadId
      if (!threadId) return {}
      const next = new Map(state.skillGenerationByThread)
      if (phase === null) {
        next.delete(threadId)
        // Also clear the retry context when the card is dismissed
        const retryNext = new Map(state.skillRetryContextByThread)
        retryNext.delete(threadId)
        return { skillGenerationByThread: next, skillRetryContextByThread: retryNext }
      } else if (phase === "error") {
        next.set(threadId, { phase: "error", streamedText: "", errorText: text })
      } else {
        next.set(threadId, { phase, streamedText: "", errorText: "" })
      }
      return { skillGenerationByThread: next }
    }),

  // Per-thread retry context — cached on intent accept, cleared on dismiss.
  skillRetryContextByThread: new Map(),

  setSkillRetryContext: (retryContext) =>
    set((state) => {
      const threadId = state.currentThreadId
      if (!threadId) return {}
      const next = new Map(state.skillRetryContextByThread)
      if (retryContext) {
        next.set(threadId, retryContext)
      } else {
        next.delete(threadId)
      }
      return { skillRetryContextByThread: next }
    }),

  appendSkillGenerationToken: (token) =>
    set((state) => {
      const threadId = state.currentThreadId
      if (!threadId) return {}
      const current = state.skillGenerationByThread.get(threadId) ?? {
        phase: "generating" as const,
        streamedText: "",
        errorText: ""
      }
      const next = new Map(state.skillGenerationByThread)
      next.set(threadId, { ...current, streamedText: current.streamedText + token })
      return { skillGenerationByThread: next }
    }),

  setEvolutionTab: (tab) => set({ evolutionTab: tab }),
  setEvolutionRunning: (running) => set({ evolutionRunning: running }),
  setEvolutionRunningSummary: (summary) => set({ evolutionRunningSummary: summary }),
  setEvolutionSummary: (summary) => set({ evolutionSummary: summary }),
  setEvolutionSelectedTraceIds: (ids) => set({ evolutionSelectedTraceIds: new Set(ids) }),
  setEvolutionRunProgress: (progress) => set({ evolutionRunProgress: { ...progress } }),
  mergeEvolutionRunProgress: (payload) =>
    set((state) => ({
      evolutionRunProgress: {
        ...state.evolutionRunProgress,
        [payload.traceId]: payload
      }
    })),
  setEvolutionStreamedText: (text) => set({ evolutionStreamedText: text }),
  appendEvolutionStreamedText: (chunk) =>
    set((state) => ({ evolutionStreamedText: state.evolutionStreamedText + chunk })),
  setEvolutionStreamError: (err) => set({ evolutionStreamError: err }),
  setEvolutionLastRunOpts: (opts) => set({ evolutionLastRunOpts: opts })
}))

// ─────────────────────────────────────────────────────────
// Selector helpers
// ─────────────────────────────────────────────────────────

const EMPTY_SKILL_GEN = { phase: null, streamedText: "", errorText: "" } as const

/**
 * Returns the skill generation card state for the given thread.
 * Use this instead of reading skillGenerationByThread directly so callers
 * always get a stable fallback when no entry exists for the thread.
 */
export function selectSkillGenerationAgent(
  state: AppState,
  threadId: string | null
): { phase: "generating" | "done" | "error" | null; streamedText: string; errorText: string } {
  if (!threadId) return EMPTY_SKILL_GEN
  return state.skillGenerationByThread.get(threadId) ?? EMPTY_SKILL_GEN
}

/**
 * Returns the cached retry context (proposal context + intent mode) for the given thread,
 * or null if the user has not accepted the intent banner for this thread yet.
 */
export function selectSkillRetryContext(
  state: AppState,
  threadId: string | null
): { context: unknown; intentMode: string } | null {
  if (!threadId) return null
  return state.skillRetryContextByThread.get(threadId) ?? null
}
