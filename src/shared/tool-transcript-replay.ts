import type { CheckpointAuthorityTranscriptMessage } from "./checkpoint-transcript"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  MESSAGE_SAME_ROLE_DUPLICATE_MARKER
} from "./message-role-collision"
import {
  getWorkerToolUiKey,
  readToolOwnershipId,
  resolveToolResultOwnership
} from "./tool-result-ownership"

type TranscriptMessage = CheckpointAuthorityTranscriptMessage & {
  botHistoryDeliveryScope?: unknown
  content_preview_notice?: string
  content_is_projection?: boolean
}

interface Call {
  id: string
  name: string
  args?: unknown
}

interface ToolExchange<T> {
  assistant: T
  calls: Call[]
  results: T[]
}

const noAliases: ReadonlyMap<string, string> = new Map()
const toolResultUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const generatedAssistantId = /^current-run-assistant:[0-9a-f-]{36}$/i

function readExchange<T extends TranscriptMessage>(
  assistant: T,
  ownership: ReadonlyMap<string, T>
): ToolExchange<T> | undefined {
  if (
    assistant.role !== "assistant" ||
    !Array.isArray(assistant.tool_calls) ||
    !assistant.tool_calls.length
  )
    return
  const calls: Call[] = []
  const results: T[] = []
  const seenIds = new Set<string>()
  for (const value of assistant.tool_calls) {
    const id = readToolOwnershipId(value)
    const call = value as { name?: unknown; args?: unknown }
    if (!id || typeof call.name !== "string" || !call.name || seenIds.has(id)) return
    const result = ownership.get(getWorkerToolUiKey(assistant.id, id, calls.length))
    if (result?.role !== "tool") return
    seenIds.add(id)
    calls.push({ id, name: call.name, args: call.args })
    results.push(result)
  }
  return { assistant, calls, results }
}

function hasSameReplayId(left: TranscriptMessage, right: TranscriptMessage): boolean {
  const source = getMessageProviderSourceId(left)
  if (source !== getMessageProviderSourceId(right)) return false
  return (
    left.id === right.id ||
    [left, right].every(
      (message) =>
        message.id === source ||
        (message.role &&
          message.id ===
            buildMessageSameRoleDuplicateId(
              source,
              message.role,
              getMessageProviderOccurrence(message)
            ))
    )
  )
}

function sameValue(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true
  if (depth > 32 || !left || !right || typeof left !== "object" || typeof right !== "object")
    return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  return keys.every(
    (key) => Object.hasOwn(right, key) && sameValue(leftRecord[key], rightRecord[key], depth + 1)
  )
}

function sameRow(left: TranscriptMessage, right: TranscriptMessage): boolean {
  const status = (row: TranscriptMessage) => row.status || (row.role === "tool" ? "success" : "")
  const failed = (row: TranscriptMessage) => row.is_error ?? row.status === "error"
  return (
    hasSameReplayId(left, right) &&
    left.tool_call_id === right.tool_call_id &&
    left.goal_id === right.goal_id &&
    left.active_window_id === right.active_window_id &&
    sameValue(left.botHistoryDeliveryScope, right.botHistoryDeliveryScope) &&
    !left.content_preview_notice &&
    !right.content_preview_notice &&
    !left.content_is_projection &&
    !right.content_is_projection &&
    (left.name || "") === (right.name || "") &&
    status(left) === status(right) &&
    failed(left) === failed(right) &&
    sameValue(left.content, right.content) &&
    (!left.reasoning || !right.reasoning || left.reasoning === right.reasoning)
  )
}

function isSameExchange(
  left: ToolExchange<TranscriptMessage>,
  right: ToolExchange<TranscriptMessage>
): boolean {
  return (
    sameRow(left.assistant, right.assistant) &&
    left.calls.length === right.calls.length &&
    left.calls.every(
      (call, index) =>
        call.id === right.calls[index].id &&
        call.name === right.calls[index].name &&
        sameValue(call.args, right.calls[index].args) &&
        sameRow(left.results[index], right.results[index])
    )
  )
}

function exchangeKey(exchange: ToolExchange<TranscriptMessage>): string {
  return JSON.stringify([
    getMessageProviderSourceId(exchange.assistant),
    exchange.calls.map(({ id }) => id)
  ])
}

function hasToolResultExecutionId(result: TranscriptMessage): boolean {
  const source = getMessageProviderSourceId(result)
  return source !== result.tool_call_id && toolResultUuid.test(source)
}

function hasExecutionIdentity(exchange: ToolExchange<TranscriptMessage>): boolean {
  return (
    generatedAssistantId.test(exchange.assistant.id) ||
    generatedAssistantId.test(getMessageProviderSourceId(exchange.assistant)) ||
    exchange.results.every(hasToolResultExecutionId)
  )
}

function resultReplayKey(result: TranscriptMessage): string {
  return JSON.stringify([getMessageProviderSourceId(result), result.tool_call_id])
}

/** Stable shape gate, independent of the order in which sources supplied the rows. */
export function hasToolReplayCandidates(messages: readonly TranscriptMessage[]): boolean {
  const seen = new Set<string>()
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.id.startsWith("current-run-assistant:") &&
      message.id.includes(MESSAGE_SAME_ROLE_DUPLICATE_MARKER)
    )
      return true
    if (message.role !== "tool" || !message.tool_call_id || !hasToolResultExecutionId(message))
      continue
    const key = resultReplayKey(message)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function indexAnchoredExchanges<T extends TranscriptMessage>(
  messages: readonly T[],
  unsafeAnchors?: ReadonlySet<string>
) {
  const ownership = resolveToolResultOwnership(messages)
  const byAnchor = new Map<
    string,
    { exchange: ToolExchange<T>; position: number; anchor: T } | null
  >()
  let anchor: T | undefined
  let position = 0
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      anchor = message.role === "user" && !unsafeAnchors?.has(message.id) ? message : undefined
      position = 0
      continue
    }
    if (!anchor || message.role !== "assistant") continue
    const exchange = readExchange(message, ownership)
    if (exchange) {
      const key = JSON.stringify([anchor.id, exchangeKey(exchange)])
      byAnchor.set(key, byAnchor.has(key) ? null : { exchange, position, anchor })
    }
    position++
  }
  return byAnchor
}

/** A checkpoint and durable page may number the same complete exchange differently. */
export function alignReplayedToolExchanges<T extends TranscriptMessage>(
  canonical: readonly T[],
  replay: T[],
  unsafeAnchors?: ReadonlySet<string>
): T[] {
  if (canonical.length < 3 || replay.length < 3) return replay
  const candidates = indexAnchoredExchanges(canonical, unsafeAnchors)
  if (candidates.size === 0) return replay
  const replayIds = new Set(replay.map((message) => message.id))
  const aligned = new Map<T, T>()
  for (const [key, candidate] of indexAnchoredExchanges(replay, unsafeAnchors)) {
    const target = candidates.get(key)
    if (
      !target ||
      !candidate ||
      (target.position !== candidate.position && !hasExecutionIdentity(target.exchange)) ||
      !sameRow(target.anchor, candidate.anchor) ||
      (getMessageProviderOccurrence(target.anchor) ?? 1) !==
        (getMessageProviderOccurrence(candidate.anchor) ?? 1) ||
      !isSameExchange(target.exchange, candidate.exchange)
    )
      continue
    const rows = [[candidate.exchange.assistant, target.exchange.assistant]]
    for (const [index, result] of candidate.exchange.results.entries()) {
      rows.push([result, target.exchange.results[index]])
    }
    if (rows.some(([copy, row]) => copy.id !== row.id && replayIds.has(row.id))) continue
    for (const [copy, row] of rows) {
      if (
        copy.id === row.id &&
        getMessageProviderOccurrence(copy) === getMessageProviderOccurrence(row)
      )
        continue
      aligned.set(copy, {
        ...copy,
        id: row.id,
        provider_source_id: row.provider_source_id,
        provider_occurrence: row.provider_occurrence
      })
    }
  }
  return aligned.size ? replay.map((message) => aligned.get(message) ?? message) : replay
}

/** Existing tool cards and archives must keep the same results for every surviving call. */
export function preserveReplayToolBindings<T extends TranscriptMessage>(
  messages: readonly T[],
  aliases: ReadonlyMap<string, string>,
  original = resolveToolResultOwnership(messages)
): ReadonlyMap<string, string> {
  if (aliases.size === 0) return aliases
  const occurrences = new Set<string>()
  for (const message of messages) {
    if (!aliases.has(message.id)) continue
    if (occurrences.has(message.id)) return noAliases
    occurrences.add(message.id)
  }
  const retained = messages.filter((message) => !aliases.has(message.id))
  const after = resolveToolResultOwnership(retained)
  for (const message of retained) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const [index, call] of message.tool_calls.entries()) {
      const key = getWorkerToolUiKey(message.id, readToolOwnershipId(call), index)
      const previous = original.get(key)
      const next = after.get(key)
      if (previous === next) continue
      if (!previous || !next || !hasToolResultExecutionId(previous) || !sameRow(previous, next))
        return noAliases
    }
  }
  return aliases
}

/** Identify copies using the same result bindings that are used in chat. */
export function findReplayedToolExchangeAliases<T extends TranscriptMessage>(
  messages: readonly T[]
): ReadonlyMap<string, string> {
  if (!hasToolReplayCandidates(messages)) return noAliases
  const ownership = resolveToolResultOwnership(messages)
  const aliases = new Map<string, string>()
  const sameTurn = new Map<string, ToolExchange<T>>()
  const physical = new Map<string, ToolExchange<T>>()
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") sameTurn.clear()
    const exchange = readExchange(message, ownership)
    if (!exchange || !hasExecutionIdentity(exchange)) continue

    // Transport replay can append records after the next visible user turn.
    // Only separately generated result UUIDs support matching across that boundary.
    const index = exchange.results.every(hasToolResultExecutionId) ? physical : sameTurn
    const key = JSON.stringify([exchangeKey(exchange), exchange.results.map(resultReplayKey)])
    const previous = index.get(key)
    if (!previous || !isSameExchange(previous, exchange)) {
      index.set(key, exchange)
      continue
    }
    if (
      previous.assistant.id === exchange.assistant.id ||
      (previous.assistant.reasoning || "") !== (exchange.assistant.reasoning || "")
    )
      continue
    aliases.set(exchange.assistant.id, previous.assistant.id)
    for (const [index, result] of exchange.results.entries()) {
      const canonical = previous.results[index]
      if (canonical.id !== result.id) aliases.set(result.id, canonical.id)
    }
  }

  // An extra result with no receiving call can be a late copy of a known result.
  // Results that actually serve a retained call never enter this orphan check.
  const owned = new Set(ownership.values())
  const knownResults = new Map<string, T>()
  for (const row of owned) {
    if (!aliases.has(row.id) && hasToolResultExecutionId(row))
      knownResults.set(resultReplayKey(row), row)
  }
  for (const row of messages) {
    if (
      row.role !== "tool" ||
      owned.has(row) ||
      aliases.has(row.id) ||
      !hasToolResultExecutionId(row)
    )
      continue
    const original = knownResults.get(resultReplayKey(row))
    if (original && original.id !== row.id && sameRow(original, row))
      aliases.set(row.id, original.id)
  }
  return preserveReplayToolBindings(messages, aliases, ownership)
}
