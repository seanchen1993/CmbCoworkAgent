import type { CheckpointAuthorityTranscriptMessage } from "./checkpoint-transcript"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  MESSAGE_SAME_ROLE_DUPLICATE_MARKER
} from "./message-role-collision"

type TranscriptMessage = CheckpointAuthorityTranscriptMessage & {
  botHistoryDeliveryScope?: unknown
  content_preview_notice?: string
  content_is_projection?: boolean
}

interface ToolExchange<T> {
  assistant: T
  results: ReadonlyMap<string, T>
  replayResults?: ReadonlyMap<string, string>
  end: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Even incomplete legacy calls participate in result ownership. */
const noCalls: readonly string[] = []

function ownedCallIds(assistant: TranscriptMessage): readonly string[] {
  if (assistant.role !== "assistant" || !Array.isArray(assistant.tool_calls)) return noCalls
  const ids: string[] = []
  for (const value of assistant.tool_calls) {
    const id = record(value)?.id
    if (typeof id === "string" && id) ids.push(id)
  }
  return ids
}

function readCallIds(assistant: TranscriptMessage): ReadonlySet<string> | undefined {
  if (
    assistant.role !== "assistant" ||
    !Array.isArray(assistant.tool_calls) ||
    !assistant.tool_calls.length
  )
    return

  const calls = new Set<string>()
  for (const value of assistant.tool_calls) {
    const call = record(value)
    if (typeof call?.id !== "string" || !call.id || !call.name || calls.has(call.id)) return
    calls.add(call.id)
  }
  return calls
}

function readExchange<T extends TranscriptMessage>(
  messages: readonly T[],
  start: number
): ToolExchange<T> | undefined {
  const assistant = messages[start]
  const calls = readCallIds(assistant)
  if (!calls) return
  const results = new Map<string, T>()
  let replayResults: Map<string, string> | undefined
  let precedingCalls: ReadonlySet<string> | null | undefined
  let end = start + 1
  while (end < messages.length && messages[end].role === "tool") {
    const result = messages[end++]
    const id = result.tool_call_id
    if (!id || !calls.has(id)) return
    const original = results.get(id)
    if (!original) {
      results.set(id, result)
      continue
    }
    if (precedingCalls === undefined) {
      precedingCalls = start > 0 ? new Set(ownedCallIds(messages[start - 1])) : null
    }
    if (
      precedingCalls?.has(id) ||
      !hasToolResultExecutionId(original) ||
      !sameRow(original, result) ||
      original.id === result.id
    )
      return
    replayResults ??= new Map()
    replayResults.set(result.id, original.id)
  }
  return results.size === calls.size ? { assistant, results, replayResults, end } : undefined
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
  const status = (row: TranscriptMessage) => row.status || (row.role === "tool" ? "success" : "")
  const failed = (row: TranscriptMessage) => row.is_error ?? row.status === "error"
  return (
    hasSameReplayId(left, right) &&
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
  if (!sameRow(left.assistant, right.assistant) || left.results.size !== right.results.size)
    return false
  const leftCalls = left.assistant.tool_calls!
  const rightCalls = right.assistant.tool_calls!
  if (leftCalls.length !== rightCalls.length) return false
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

function indexAnchoredExchanges<T extends TranscriptMessage>(
  messages: readonly T[],
  unsafeAnchors?: ReadonlySet<string>
) {
  const exchanges = new Map<
    string,
    { exchange: ToolExchange<T>; position: number; anchor: T } | null
  >()
  let anchor: T | undefined
  const unmatchedCallIds = new Set<string>()
  let position = 0
  for (let index = 0; index < messages.length; ) {
    const message = messages[index]
    if (message.role === "user" || message.role === "system") {
      anchor = message.role === "user" && !unsafeAnchors?.has(message.id) ? message : undefined
      position = 0
      if (message.role === "user") unmatchedCallIds.clear()
    }
    const exchange =
      anchor && message.role === "assistant" ? readExchange(messages, index) : undefined
    if (anchor && exchange) {
      const key = JSON.stringify([anchor.id, exchangeKey(exchange)])
      const ambiguous = [...exchange.results.keys()].some((id) => unmatchedCallIds.has(id))
      exchanges.set(key, ambiguous || exchanges.has(key) ? null : { exchange, position, anchor })
      index = exchange.end
    } else {
      for (const id of ownedCallIds(message)) unmatchedCallIds.add(id)
      index++
    }
    if (message.role === "assistant") position++
  }
  return exchanges
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

function hasToolResultExecutionId(result: TranscriptMessage): boolean {
  const source = getMessageProviderSourceId(result)
  return source !== result.tool_call_id && toolResultUuid.test(source)
}

function resultReplayKey(result: TranscriptMessage): string {
  return JSON.stringify([getMessageProviderSourceId(result), result.tool_call_id])
}

function hasExecutionIdentity(exchange: ToolExchange<TranscriptMessage>): boolean {
  return (
    generatedAssistantId.test(exchange.assistant.id) ||
    [...exchange.results.values()].every(hasToolResultExecutionId)
  )
}

/** Fast structural gate. Rendering hints can prove these candidates even when
 * their order in a persisted page by itself is ambiguous. */
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

/** A complete snapshot may group repeated assistants before their results. */
function readInterleavedReplays<T extends TranscriptMessage>(
  messages: readonly T[],
  start: number
): ToolExchange<T>[] | undefined {
  const first = messages[start]
  const next = messages[start + 1]
  const predecessor = messages[start - 1]
  if (
    next?.role !== "assistant" ||
    !hasSameReplayId(first, next) ||
    (predecessor?.role === "assistant" &&
      predecessor.tool_calls?.length &&
      hasSameReplayId(predecessor, first))
  )
    return
  const calls = readCallIds(first)
  if (!calls) return

  const assistants = [first]
  let end = start + 1
  while (
    messages[end]?.role === "assistant" &&
    hasSameReplayId(first, messages[end]) &&
    Array.isArray(messages[end].tool_calls) &&
    messages[end].tool_calls?.length
  ) {
    assistants.push(messages[end++])
  }
  if (assistants.length < 2) return
  // A final text-only message can be committed before the tool result arrives.
  while (
    messages[end]?.role === "assistant" &&
    (!messages[end].tool_calls ||
      (Array.isArray(messages[end].tool_calls) && messages[end].tool_calls?.length === 0))
  )
    end++
  const results = new Map<string, T[]>()
  while (messages[end]?.role === "tool") {
    const result = messages[end++]
    const id = result.tool_call_id
    if (!id || !calls.has(id)) return
    const rows = results.get(id) ?? []
    rows.push(result)
    results.set(id, rows)
  }
  if (
    results.size !== calls.size ||
    [...results.values()].some((rows) => rows.length !== assistants.length)
  )
    return
  const exchanges = assistants.map((assistant, index) => ({
    assistant,
    results: new Map([...results].map(([id, rows]) => [id, rows[index]])),
    end
  }))
  if (
    !hasExecutionIdentity(exchanges[0]) ||
    exchanges.some(
      (exchange) => !readCallIds(exchange.assistant) || !isSameExchange(exchanges[0], exchange)
    )
  )
    return
  return exchanges
}

/** Fold complete copies with independent execution proof within a visible turn. */
export function findReplayedToolExchangeAliases<T extends TranscriptMessage>(
  messages: readonly T[]
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>()
  const seen = new Map<string, ToolExchange<T>>()
  const completedResults = new Map<string, T>()
  const deferredCalls = new Map<
    string,
    {
      assistant: T
      expected: ReadonlySet<string> | undefined
      results: Map<string, T>
    }
  >()
  const ambiguousCalls = new Set<string>()
  const carriedUnfinishedCalls = new Map<string, number | null>()
  const observedResultIds = new Set<string>()
  const callCouldBelongElsewhere = (id: string): boolean =>
    ambiguousCalls.has(id) || carriedUnfinishedCalls.has(id)
  const foldCompleted = (current: ToolExchange<T>): void => {
    if ([...current.results.keys()].some(callCouldBelongElsewhere)) return
    for (const [alias, canonical] of current.replayResults ?? []) aliases.set(alias, canonical)
    for (const result of current.results.values()) {
      if (hasToolResultExecutionId(result)) completedResults.set(resultReplayKey(result), result)
    }
    if (!hasExecutionIdentity(current)) return
    const key = JSON.stringify([
      exchangeKey(current),
      [...current.results.keys()]
        .sort()
        .map((id) => getMessageProviderSourceId(current.results.get(id)!))
    ])
    const previous = seen.get(key)
    if (!previous || !isSameExchange(previous, current)) {
      seen.set(key, current)
      return
    }
    if (
      previous.assistant.id === current.assistant.id ||
      (previous.assistant.reasoning || "") !== (current.assistant.reasoning || "")
    )
      return
    aliases.set(current.assistant.id, previous.assistant.id)
    for (const [id, result] of current.results) {
      const canonical = previous.results.get(id)!
      if (canonical.id !== result.id) aliases.set(result.id, canonical.id)
    }
  }
  for (let index = 0; index < messages.length; ) {
    const message = messages[index]
    if (message.role === "user" || message.role === "system") {
      seen.clear()
      completedResults.clear()
    }
    if (message.role === "user") {
      for (const id of ambiguousCalls) carriedUnfinishedCalls.set(id, null)
      for (const id of deferredCalls.keys()) {
        const carried = carriedUnfinishedCalls.get(id)
        if (carried !== null) carriedUnfinishedCalls.set(id, (carried ?? 0) + 1)
      }
      deferredCalls.clear()
      ambiguousCalls.clear()
    }
    const exchange = readExchange(messages, index)
    const exchanges = exchange ? [exchange] : readInterleavedReplays(messages, index)
    if (!exchanges) {
      if (message.role === "tool" && message.tool_call_id) {
        const callId = message.tool_call_id
        const resultKey = resultReplayKey(message)
        const isNewResult = !observedResultIds.has(resultKey)
        observedResultIds.add(resultKey)
        const owner = deferredCalls.get(callId)
        const carried = carriedUnfinishedCalls.get(callId)
        if (owner && !ambiguousCalls.has(callId)) {
          deferredCalls.delete(callId)
          owner.results.set(callId, message)
          if (hasToolResultExecutionId(message)) completedResults.set(resultKey, message)
          if (owner.expected?.size === owner.results.size) {
            foldCompleted({ assistant: owner.assistant, results: owner.results, end: index + 1 })
          }
        } else if (!owner && !ambiguousCalls.has(callId) && carried && isNewResult) {
          if (carried === 1) carriedUnfinishedCalls.delete(callId)
          else carriedUnfinishedCalls.set(callId, carried - 1)
          if (hasToolResultExecutionId(message)) completedResults.set(resultKey, message)
        } else if (!callCouldBelongElsewhere(callId) && hasToolResultExecutionId(message)) {
          const resolved = completedResults.get(resultKey)
          if (resolved && resolved.id !== message.id && sameRow(resolved, message)) {
            aliases.set(message.id, resolved.id)
          }
        }
      }
      const callIds = ownedCallIds(message)
      if (callIds.length) {
        const owner = {
          assistant: message,
          expected: readCallIds(message),
          results: new Map<string, T>()
        }
        for (const id of callIds) {
          if (deferredCalls.has(id)) ambiguousCalls.add(id)
          deferredCalls.set(id, owner)
        }
      }
      index++
      continue
    }
    for (const current of exchanges) {
      // Removing a result could otherwise change FIFO ownership for a separate
      // earlier call, including a legacy call whose display name is missing.
      for (const id of current.results.keys()) {
        if (deferredCalls.has(id)) ambiguousCalls.add(id)
      }
      for (const result of current.results.values()) observedResultIds.add(resultReplayKey(result))
      foldCompleted(current)
    }
    index = exchanges[0].end
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
  for (const [alias, canonical] of aliases) {
    const original = aliases.get(canonical)
    if (original) aliases.set(alias, original)
  }
  return aliases
}
