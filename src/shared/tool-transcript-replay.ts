import type { CheckpointAuthorityTranscriptMessage } from "./checkpoint-transcript"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId
} from "./message-role-collision"

type TranscriptMessage = CheckpointAuthorityTranscriptMessage

interface ToolExchange<T> {
  assistant: T
  results: ReadonlyMap<string, T>
  end: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readExchange<T extends TranscriptMessage>(
  messages: readonly T[],
  start: number
): ToolExchange<T> | undefined {
  const assistant = messages[start]
  if (assistant.role !== "assistant" || !assistant.tool_calls?.length) return

  const calls = new Set<string>()
  for (const value of assistant.tool_calls) {
    const call = record(value)
    if (typeof call?.id !== "string" || !call.id || !call.name || calls.has(call.id)) return
    calls.add(call.id)
  }

  const results = new Map<string, T>()
  let end = start + 1
  while (end < messages.length && messages[end].role === "tool") {
    const result = messages[end++]
    const id = result.tool_call_id
    if (!id || !calls.has(id) || results.has(id)) return
    results.set(id, result)
  }
  return results.size === calls.size ? { assistant, results, end } : undefined
}

function hasSameReplayId(left: TranscriptMessage, right: TranscriptMessage): boolean {
  if (left.id === right.id)
    return getMessageProviderSourceId(left) === getMessageProviderSourceId(right)
  const source = getMessageProviderSourceId(left)
  return (
    source === getMessageProviderSourceId(right) &&
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
  const rightRecord = right as Record<string, unknown>
  const leftRecord = left as Record<string, unknown>
  return keys.every(
    (key) => Object.hasOwn(right, key) && sameValue(leftRecord[key], rightRecord[key], depth + 1)
  )
}

function sameRow(left: TranscriptMessage, right: TranscriptMessage): boolean {
  return (
    hasSameReplayId(left, right) &&
    left.goal_id === right.goal_id &&
    left.active_window_id === right.active_window_id &&
    (left.name || "") === (right.name || "") &&
    (left.status || "") === (right.status || "") &&
    Boolean(left.is_error) === Boolean(right.is_error) &&
    sameValue(left.content, right.content) &&
    (!left.reasoning || !right.reasoning || left.reasoning === right.reasoning)
  )
}

function isSameExchange(
  left: ToolExchange<TranscriptMessage>,
  right: ToolExchange<TranscriptMessage>
): boolean {
  if (!sameRow(left.assistant, right.assistant) || left.results.size !== right.results.size)
    return false
  const leftCalls = left.assistant.tool_calls!
  const rightCalls = right.assistant.tool_calls!
  return leftCalls.every((value, index) => {
    const call = record(value)!
    const other = record(rightCalls[index])!
    const result = left.results.get(call.id as string)!
    const otherResult = right.results.get(call.id as string)
    return (
      call.id === other.id &&
      call.name === other.name &&
      sameValue(call.args, other.args) &&
      otherResult !== undefined &&
      sameRow(result, otherResult)
    )
  })
}

function exchangeKey(exchange: ToolExchange<TranscriptMessage>): string {
  return JSON.stringify([
    getMessageProviderSourceId(exchange.assistant),
    [...exchange.results.keys()].sort()
  ])
}

function indexAnchoredExchanges<T extends TranscriptMessage>(messages: readonly T[]) {
  const exchanges = new Map<string, { exchange: ToolExchange<T>; position: number } | null>()
  let anchor = ""
  let position = 0
  for (let index = 0; index < messages.length; ) {
    const message = messages[index]
    if (message.role === "user" || message.role === "system") {
      anchor = message.id
      position = 0
    }
    const exchange =
      anchor && message.role === "assistant" ? readExchange(messages, index) : undefined
    if (exchange) {
      const key = JSON.stringify([anchor, exchangeKey(exchange)])
      exchanges.set(key, exchanges.has(key) ? null : { exchange, position })
      index = exchange.end
    } else {
      index++
    }
    if (message.role === "assistant") position++
  }
  return exchanges
}

/** A checkpoint and durable page may number the same complete exchange differently. */
export function alignReplayedToolExchanges<T extends TranscriptMessage>(
  canonical: readonly T[],
  replay: T[]
): T[] {
  if (canonical.length < 3 || replay.length < 3) return replay
  const candidates = indexAnchoredExchanges(canonical)
  if (candidates.size === 0) return replay
  const replayIds = new Set(replay.map((message) => message.id))
  const aligned = new Map<T, T>()
  for (const [key, candidate] of indexAnchoredExchanges(replay)) {
    const target = candidates.get(key)
    if (
      !target ||
      !candidate ||
      target.position !== candidate.position ||
      !isSameExchange(target.exchange, candidate.exchange)
    )
      continue
    const rows = [[candidate.exchange.assistant, target.exchange.assistant]]
    for (const [callId, result] of candidate.exchange.results) {
      rows.push([result, target.exchange.results.get(callId)!])
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

// An ordinary provider response ID and call ID may both recur. UUID-backed
// result IDs, or an app-generated assistant execution ID, identify an actual run.
const toolResultUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const generatedAssistantId = /^current-run-assistant:[0-9a-f-]{36}$/i

function hasExecutionIdentity(exchange: ToolExchange<TranscriptMessage>): boolean {
  return (
    generatedAssistantId.test(exchange.assistant.id) ||
    [...exchange.results.values()].every((result) => {
      const source = getMessageProviderSourceId(result)
      return source !== result.tool_call_id && toolResultUuid.test(source)
    })
  )
}

/** Only adjacent complete copies with independent execution evidence are safe
 * to fold within a single source. The caller can redirect visible aliases. */
export function findReplayedToolExchangeAliases<T extends TranscriptMessage>(
  messages: readonly T[]
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>()
  let previous: ToolExchange<T> | undefined
  for (let index = 0; index < messages.length; ) {
    const current = readExchange(messages, index)
    if (!current) {
      previous = undefined
      index++
      continue
    }
    if (
      previous &&
      previous.assistant.id !== current.assistant.id &&
      (previous.assistant.reasoning || "") === (current.assistant.reasoning || "") &&
      hasExecutionIdentity(previous) &&
      isSameExchange(previous, current)
    ) {
      aliases.set(current.assistant.id, previous.assistant.id)
      for (const [id, result] of current.results) {
        const canonical = previous.results.get(id)!
        if (canonical.id !== result.id) aliases.set(result.id, canonical.id)
      }
    } else {
      previous = current
    }
    index = current.end
  }
  if (aliases.size === 0) return aliases
  // Older input can reuse a raw ID in another turn. An alias is safe to hide
  // only if it uniquely addresses the record that was matched above.
  const encountered = new Set<string>()
  for (const message of messages) {
    if (!aliases.has(message.id)) continue
    if (encountered.has(message.id)) return new Map()
    encountered.add(message.id)
  }
  return aliases
}
