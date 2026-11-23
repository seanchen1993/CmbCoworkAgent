import { parseBotToolReceiptId } from "./bots/turn-feedback"
import {
  mergeCheckpointAuthorityTranscriptMessage,
  type CheckpointAuthorityTranscriptMessage,
  type CheckpointReplayTurns
} from "./checkpoint-transcript"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  MESSAGE_SAME_ROLE_DUPLICATE_MARKER
} from "./message-role-collision"
import {
  getRawWorkerToolCallId,
  getWorkerToolUiKey,
  readToolOwnershipId,
  resolveToolResultOwnership
} from "./tool-result-ownership"
import { extractPersistedMessageContent } from "./stream-transcript-content"
import { getComparablePersistedMessageContent } from "./thread-message-content"

const checkpointToolTurn = Symbol("checkpointToolTurn")
const replayTextBlockMetadata = Symbol("replayTextBlockMetadata")

type TranscriptMessage = CheckpointAuthorityTranscriptMessage & {
  botHistoryDeliveryScope?: unknown
  content_preview_notice?: string
  content_is_projection?: boolean
  [checkpointToolTurn]?: string
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

type PartialToolExchange<T> = Omit<ToolExchange<T>, "results"> & { results: Array<T | undefined> }

interface AnchoredToolExchange<T> {
  exchange: ToolExchange<T>
  position: number
  anchor?: T
  hasPhysicalResults: boolean
  outcomeKey?: string
  physicalKey?: string
}

interface AnchoredToolSlots<T> {
  exchange: PartialToolExchange<T>
  anchor?: T
}

const noAliases: ReadonlyMap<string, string> = new Map()
const toolResultUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const langGraphToolResultPrefix =
  /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-tool-/i
const generatedAssistantId = /^current-run-assistant:[0-9a-f-]{36}$/i
const botFileDeliveryToolName = "bot_deliver_files"

function indexAssistantTurns(rows: readonly { id: string; role?: string }[]): Map<string, string> {
  const turns = new Map<string, string>()
  let turn = 0
  let anchor = ""
  for (const { role, id } of rows) {
    if (role === "user" || role === "system") anchor = `${++turn}\u0000${id}`
    if (role === "assistant") turns.set(id, anchor)
  }
  return turns
}

export function getAssistantReplayContent<T extends TranscriptMessage>(
  aliases: ReadonlyMap<string, string>,
  read: (id: string) => T | undefined
): ReadonlyMap<string, T["content"]> {
  const content = new Map<string, T["content"]>()
  const copiesByCanonical = new Map<string, T[]>()
  for (const [id, canonicalId] of aliases) {
    const copy = read(id)
    if (copy?.role !== "assistant") continue
    const copies = copiesByCanonical.get(canonicalId) ?? []
    copies.push(copy)
    copiesByCanonical.set(canonicalId, copies)
  }
  for (const [canonicalId, copies] of copiesByCanonical) {
    const canonical = read(canonicalId)
    if (canonical?.role !== "assistant") continue
    let current = canonical
    let equivalent = [canonical]
    // An equivalent indexed snapshot can prove later changes that a
    // flattened canonical body alone cannot track.
    const ranked = copies.map((copy) => ({
      copy,
      length: replayProseLength(readReplayProse(copy.content))
    }))
    ranked.sort((left, right) => left.length - right.length)
    for (const { copy } of ranked) {
      if (sameReplayBodies(copy.content, current.content)) {
        if (!sameValue(copy.content, current.content)) equivalent.push(copy)
      } else if (equivalent.some((before) => isReplayContentExtension(copy.content, before.content))) {
        current = copy
        equivalent = [copy]
      }
    }
    if (current !== canonical) content.set(canonicalId, current.content)
  }
  return content
}

function readExchange<T extends TranscriptMessage>(
  assistant: T,
  ownership: ReadonlyMap<string, T>
): ToolExchange<T> | undefined {
  const batch = readToolExchangeSlots(assistant, ownership)
  if (batch?.results.every((result): result is T => result !== undefined)) {
    return { ...batch, results: batch.results }
  }
  return undefined
}

function readToolExchangeSlots<T extends TranscriptMessage>(
  assistant: T,
  ownership: ReadonlyMap<string, T>
): PartialToolExchange<T> | undefined {
  if (
    assistant.role !== "assistant" ||
    !Array.isArray(assistant.tool_calls) ||
    !assistant.tool_calls.length
  )
    return
  const calls: Call[] = []
  const results: Array<T | undefined> = []
  const seenIds = new Set<string>()
  for (const value of assistant.tool_calls) {
    const id = readToolOwnershipId(value)
    const call = value as { name?: unknown; args?: unknown }
    if (!id || typeof call.name !== "string" || !call.name || seenIds.has(id)) return
    // File authorization addresses the exact persisted assistant batch by ID.
    // A reconstructed transcript cannot establish that another batch is usable.
    if (call.name === botFileDeliveryToolName) return
    const result = ownership.get(getWorkerToolUiKey(assistant.id, id, calls.length))
    seenIds.add(id)
    calls.push({ id, name: call.name, args: call.args })
    results.push(result?.role === "tool" ? result : undefined)
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

function sameRow(
  left: TranscriptMessage,
  right: TranscriptMessage,
  checkpointScopeMayBeMissing = false,
  comparePresentation = true
): boolean {
  const status = (row: TranscriptMessage) => row.status || (row.role === "tool" ? "success" : "")
  const failed = (row: TranscriptMessage) => row.is_error ?? row.status === "error"
  return (
    hasSameReplayId(left, right) &&
    left.tool_call_id === right.tool_call_id &&
    (left.goal_id === right.goal_id || (checkpointScopeMayBeMissing && right.goal_id == null)) &&
    (left.active_window_id === right.active_window_id ||
      (checkpointScopeMayBeMissing && right.active_window_id == null)) &&
    sameValue(left.botHistoryDeliveryScope, right.botHistoryDeliveryScope) &&
    !left.content_preview_notice &&
    !right.content_preview_notice &&
    !left.content_is_projection &&
    !right.content_is_projection &&
    (left.name || "") === (right.name || "") &&
    status(left) === status(right) &&
    failed(left) === failed(right) &&
    (!comparePresentation ||
      (sameValue(left.content, right.content) &&
        (!left.reasoning || !right.reasoning || left.reasoning === right.reasoning)))
  )
}

function sameStoredToolResult(durable: TranscriptMessage, checkpoint: TranscriptMessage): boolean {
  return (
    sameRow(durable, checkpoint, true) ||
    (Array.isArray(checkpoint.content) &&
      (durable.reasoning === checkpoint.reasoning || !durable.reasoning || !checkpoint.reasoning) &&
      sameRow(durable, checkpoint, true, false) &&
      sameValue(durable.content, extractPersistedMessageContent(checkpoint.content)))
  )
}

function isSameExchange(
  left: ToolExchange<TranscriptMessage>,
  right: ToolExchange<TranscriptMessage>,
  checkpointScopeMayBeMissing = false,
  compareAssistantPresentation = true
): boolean {
  return (
    sameExchangeCalls(left, right, checkpointScopeMayBeMissing, compareAssistantPresentation) &&
    left.results.every((result, index) =>
      sameRow(result, right.results[index], checkpointScopeMayBeMissing)
    )
  )
}

function sameExchangeCalls(
  left: Pick<ToolExchange<TranscriptMessage>, "assistant" | "calls">,
  right: Pick<ToolExchange<TranscriptMessage>, "assistant" | "calls">,
  checkpointScopeMayBeMissing: boolean,
  compareAssistantPresentation: boolean
): boolean {
  return (
    sameRow(
      left.assistant,
      right.assistant,
      checkpointScopeMayBeMissing,
      compareAssistantPresentation
    ) &&
    left.calls.length === right.calls.length &&
    left.calls.every(
      (call, index) =>
        call.id === right.calls[index].id &&
        call.name === right.calls[index].name &&
        sameValue(call.args, right.calls[index].args)
    )
  )
}

function isSameCompletedExecution(
  durable: ToolExchange<TranscriptMessage>,
  checkpoint: ToolExchange<TranscriptMessage>,
  checkpointScopeMayBeMissing = false
): boolean {
  // A model can revise its prose while the ordered calls and physical results
  // continue to describe the same completed tool execution.
  return isSameExchange(durable, checkpoint, checkpointScopeMayBeMissing, false)
}

function isExactToolExchangeReplay(
  left: ToolExchange<TranscriptMessage>,
  right: ToolExchange<TranscriptMessage>
): boolean {
  return (
    (left.assistant.reasoning || "") === (right.assistant.reasoning || "") &&
    left.results.every(
      (result, index) => (result.reasoning || "") === (right.results[index]?.reasoning || "")
    ) &&
    isSameExchange(left, right)
  )
}

function sameReplayAnchor(
  durable: TranscriptMessage | undefined,
  checkpoint: TranscriptMessage | undefined,
  checkpointScopeMayBeMissing = false
): boolean {
  return (
    durable === checkpoint ||
    Boolean(
      durable &&
      checkpoint &&
      sameRow(durable, checkpoint, checkpointScopeMayBeMissing) &&
      (getMessageProviderOccurrence(durable) ?? 1) ===
        (getMessageProviderOccurrence(checkpoint) ?? 1)
    )
  )
}

function exchangeKey(
  exchange: Pick<ToolExchange<TranscriptMessage>, "assistant" | "calls">
): string {
  return JSON.stringify([
    getMessageProviderSourceId(exchange.assistant),
    exchange.calls.map(({ id }) => id)
  ])
}

function hasToolResultExecutionId(result: TranscriptMessage): boolean {
  const source = getMessageProviderSourceId(result)
  const callId = result.tool_call_id
  if (typeof callId !== "string" || !callId || source === callId) return false
  if (toolResultUuid.test(source)) return true
  if (parseBotToolReceiptId(source, typeof result.name === "string" ? result.name : "")) return true
  const prefix = langGraphToolResultPrefix.exec(source)?.[0]
  return Boolean(prefix && source.slice(prefix.length) === callId)
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

function historicalReplayId(row: TranscriptMessage): string | undefined {
  const earlierId = row.historical_tool_replay_id
  const occurrence = getMessageProviderOccurrence(row) ?? 1
  if (
    !earlierId ||
    occurrence < 2 ||
    row.content_preview_notice ||
    row.content_is_projection ||
    !hasToolResultExecutionId(row)
  )
    return
  const source = getMessageProviderSourceId(row)
  if (row.id !== buildMessageSameRoleDuplicateId(source, "tool", occurrence)) return
  if (earlierId === source) return earlierId
  const earlierOccurrence = getMessageProviderOccurrence({ id: earlierId, role: "tool" })
  if (
    earlierOccurrence &&
    earlierOccurrence < occurrence &&
    earlierId === buildMessageSameRoleDuplicateId(source, "tool", earlierOccurrence)
  )
    return earlierId
  return undefined
}

function createPayloadIds(): (value: unknown) => number {
  // Intern scalar values so keys need not serialize full tool output.
  const ids = new Map<unknown, number>()
  return (value) => {
    if (value !== null && typeof value === "object") return 0
    const existing = ids.get(value)
    if (existing !== undefined) return existing
    const id = ids.size + 1
    ids.set(value, id)
    return id
  }
}

function hasRawCheckpointToolBindings(
  exchange: PartialToolExchange<TranscriptMessage>,
  turns: CheckpointReplayTurns
): boolean {
  return (
    turns.uniqueMessageIds.has(exchange.assistant.id) &&
    exchange.results.every(
      (result, index) =>
        (!result || turns.uniqueMessageIds.has(result.id)) &&
        turns.rawResultByCall.get(
          getWorkerToolUiKey(exchange.assistant.id, exchange.calls[index].id, index)
        ) === result?.id
    )
  )
}

function rememberVersion<T>(
  index: Map<string, T[]>,
  key: string,
  value: T,
  equals: (left: T, right: T) => boolean
): T {
  const versions = index.get(key)
  if (!versions) {
    index.set(key, [value])
    return value
  }
  const previous = versions.find((version) => equals(version, value))
  if (previous !== undefined) return previous
  versions.push(value)
  return value
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
    if (historicalReplayId(message)) return true
    const key = resultReplayKey(message)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function historicalToolResults<T extends TranscriptMessage>(
  messages: readonly T[]
): Map<string, T> {
  const results = new Map<string, T>()
  for (const row of messages) {
    if (row.role === "assistant" || row.role === "user") break
    if (row.role === "tool" && hasToolResultExecutionId(row)) results.set(row.id, row)
  }
  return results
}

function findReplayedResultRebindings<T extends TranscriptMessage>(
  messages: readonly T[],
  ownership: ReadonlyMap<string, T>,
  owned: ReadonlySet<T>,
  ownedExecutionIds: ReadonlySet<string>
): { aliases: ReadonlyMap<string, string>; disputed: ReadonlySet<T> } {
  const disputed = new Set<T>()
  const seen = new Map<string, T[]>()
  const payloadId = createPayloadIds()
  const proposals: AttachedToolReplay[] = []
  const waitingForReplacement = new Map<string, AttachedToolReplay[]>()
  const keyFor = (row: T) => JSON.stringify([resultReplayKey(row), payloadId(row.content)])
  for (const row of historicalToolResults(messages).values()) {
    rememberVersion(seen, keyFor(row), row, sameRow)
  }
  for (const row of messages) {
    if (!row.tool_call_id || !hasToolResultExecutionId(row)) continue
    const call = getRawWorkerToolCallId(row.tool_call_id)
    const key = keyFor(row)
    const attached = owned.has(row)
    const original = attached
      ? rememberVersion(seen, key, row, sameRow)
      : seen.get(key)?.find((earlier) => sameRow(earlier, row))
    const canonical = original && original.id !== row.id ? original.id : historicalReplayId(row)
    const pending = waitingForReplacement.get(call)
    if (canonical && (attached || pending)) {
      const copies = pending ?? []
      copies.push({ alias: row.id, canonical, call })
      waitingForReplacement.set(call, copies)
      continue
    }
    if (pending && !attached && !ownedExecutionIds.has(getMessageProviderSourceId(row))) {
      // Close the sequence at the first independently identified result.
      // Later duplicate rows may belong to a different receiving call.
      for (const copy of pending) proposals.push(copy)
      waitingForReplacement.delete(call)
    }
  }
  const validated = selectAttachedReplayAliases(messages, noAliases, ownership, proposals)
  if (!validated.size) return { aliases: noAliases, disputed }
  const repaired = resolveToolResultOwnership(messages.filter((row) => !validated.has(row.id)))
  for (const [owner, row] of ownership) {
    if (!validated.has(row.id)) continue
    const next = repaired.get(owner)
    if (next && resultReplayKey(next) !== resultReplayKey(row)) disputed.add(row)
  }
  return { aliases: disputed.size ? validated : noAliases, disputed }
}

function sameResultBinding(
  before: TranscriptMessage,
  after: TranscriptMessage | undefined,
  scopeMayBeMissing = false
): boolean {
  return (
    before === after ||
    Boolean(after && hasToolResultExecutionId(before) && sameRow(before, after, scopeMayBeMissing))
  )
}

function stageToolResultReplays<T extends TranscriptMessage>(
  messages: readonly T[],
  removedIds: ReadonlySet<string>,
  checkpointTurns?: CheckpointReplayTurns,
  removedCallKeys?: ReadonlySet<string>
): { messages: T[]; checkpointTurns?: CheckpointReplayTurns } | undefined {
  if (!removedIds.size) return
  const retained = messages.filter(({ id }) => !removedIds.has(id))
  if (messages.length - retained.length !== removedIds.size) return
  if (!checkpointTurns) return { messages: retained }

  // Check the same repair against the actual hidden user boundaries before
  // trusting the visible ownership used by the alignment plans.
  const raw = checkpointTurns.rawToolTranscript
  const rawRetained = raw.filter(({ id }) => !removedIds.has(id))
  if (raw.length - rawRetained.length !== removedIds.size) return
  const byId = new Map(messages.map((message) => [message.id, message]))
  const rawWithPayload = (rows: typeof raw): TranscriptMessage[] =>
    rows.map((row) => ({
      ...byId.get(row.id),
      ...row
    }))
  const rawBefore = resolveToolResultOwnership(rawWithPayload(raw))
  const rawAfter = resolveToolResultOwnership(rawWithPayload(rawRetained))
  const visibleAfter = resolveToolResultOwnership(retained)
  const retainedRawBindings = [...rawBefore].filter(([key]) => !removedCallKeys?.has(key))
  if (
    retainedRawBindings.length !== rawAfter.size ||
    retainedRawBindings.some(([key, row]) => {
      const wanted = removedIds.has(row.id) ? visibleAfter.get(key) : row
      return !wanted || !sameResultBinding(wanted, rawAfter.get(key))
    })
  )
    return
  return {
    messages: retained,
    checkpointTurns: {
      ...checkpointTurns,
      rawToolTranscript: rawRetained,
      rawResultByCall: new Map([...rawAfter].map(([key, result]) => [key, result.id]))
    }
  }
}

function findToolSlotCopyAliases<T extends TranscriptMessage>(
  messages: readonly T[],
  ownership: ReadonlyMap<string, T>,
  checkpointTurns?: CheckpointReplayTurns,
  disputed?: ReadonlySet<T>,
  toolReplayAssistantIds?: Set<string>
) {
  const rawRows = checkpointTurns?.rawToolTranscript ?? messages
  const rawTurnByAssistant = indexAssistantTurns(rawRows)
  const assistantTextKey = (row: T) =>
    `${rawTurnByAssistant.get(row.id)}\u0000${row[checkpointToolTurn] ?? ""}\u0000${getMessageProviderSourceId(row)}`
  const firstContent = new Map<string, unknown>()
  const hasDifferentText = new Set<string>()
  for (const assistant of messages) {
    if (
      assistant.role !== "assistant" ||
      !assistant.tool_calls?.length
    )
      continue
    const key = assistantTextKey(assistant)
    if (!firstContent.has(key)) firstContent.set(key, assistant.content)
    else if (!sameValue(firstContent.get(key), assistant.content)) hasDifferentText.add(key)
  }

  const payloadId = createPayloadIds()
  type SlotVersion = { batch: PartialToolExchange<T>; keys: string[]; complete: boolean }
  const versions = new Map<string, SlotVersion[]>()
  const observed = new Map<string, Map<number, SlotVersion[]>>()
  const textVersionsByResults = new Map<
    string,
    Array<{
      batch: PartialToolExchange<T>
      prose: ReplayProse
      match: ReplayProse
      length: number
    }>
  >()
  const replayOrder = new Map<PartialToolExchange<T>, number>()
  const exactCopies = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const exactSingleToolCopies = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const proseByAssistant = new Map<T, ReplayProse>()
  const indexedProseByAssistant = new Map<T, ReplayProse>()
  const prose = (assistant: T) => {
    const indexed = proseByAssistant.get(assistant)
    if (indexed) return indexed
    const content = readReplayProse(assistant.content)
    proseByAssistant.set(assistant, content)
    return content
  }
  const indexedProse = (assistant: T) => {
    const indexed = indexedProseByAssistant.get(assistant)
    if (indexed) return indexed
    const content = readIndexedReplayProse(assistant.content, prose(assistant))
    indexedProseByAssistant.set(assistant, content)
    return content
  }
  const indexPresentation = (
    keys: readonly string[],
    batch: PartialToolExchange<T>,
    layout: ReplayProse,
    indexed: boolean
  ) => {
    const length = replayProseLength(layout)
    let match = layout
    while (true) {
      const outcome = JSON.stringify([indexed, match.text.length, ...keys])
      const revisions = textVersionsByResults.get(outcome) ?? []
      revisions.push({ batch, prose: layout, match, length })
      textVersionsByResults.set(outcome, revisions)
      if (!isAppendableReplayBlock(match.blocks.at(-1))) break
      // Find snapshots from before a terminal block arrived. Only the
      // complete layouts are used for the final continuation proof.
      match = {
        text: match.text.slice(0, -1),
        blocks: match.blocks.slice(0, -1),
        annotations: match.annotations.filter(({ span }) => span < match.text.length - 1)
      }
    }
  }
  const extendedText = (candidate: T, original: T) =>
    hasReplayProse(candidate.content) &&
    hasReplayProse(original.content) &&
    (isReplayProseExtension(prose(candidate), prose(original)) ||
      isReplayProseExtension(indexedProse(candidate), indexedProse(original)))
  const compatibleText = (left: T, right: T) =>
    equivalentPresentation(left, right) || extendedText(left, right) || extendedText(right, left)
  const equivalentPresentation = (left: T, right: T): boolean => {
    if (sameValue(left.content, right.content)) return true
    if (!hasReplayProse(left.content) || !hasReplayProse(right.content)) return false
    const before = prose(left)
    const after = prose(right)
    return sameReplayProse(before, after)
  }
  const textDistance = (left: T, right: T) =>
    Math.abs(replayProseLength(prose(left)) - replayProseLength(prose(right)))
  const exactSlots = (
    subset: PartialToolExchange<T>,
    superset: PartialToolExchange<T>,
    comparePresentation: boolean
  ) =>
    (subset.assistant.reasoning || "") === (superset.assistant.reasoning || "") &&
    sameExchangeCalls(subset, superset, false, comparePresentation) &&
    subset.results.every((row, index) => {
      const peer = superset.results[index]
      return (
        !row ||
        Boolean(peer && sameRow(row, peer) && (row.reasoning || "") === (peer.reasoning || ""))
      )
    })
  for (const [position, assistant] of messages.entries()) {
    const scope = rawTurnByAssistant.get(assistant.id)
    if (scope === undefined) continue
    const batch = readToolExchangeSlots(assistant, ownership)
    if (
      !batch ||
      !batch.results.some(Boolean) ||
      batch.results.some((row) => row && (!hasToolResultExecutionId(row) || disputed?.has(row))) ||
      (checkpointTurns && !hasRawCheckpointToolBindings(batch, checkpointTurns))
    )
      continue
    const scopeKey = [scope, assistant[checkpointToolTurn], exchangeKey(batch)]
    const keys = batch.results.flatMap((row, index) =>
      row
        ? [JSON.stringify([...scopeKey, index, resultReplayKey(row), payloadId(row.content)])]
        : []
    )
    const full = keys.length === batch.calls.length
    const plainSingleTool =
      full && batch.calls.length === 1 && !Array.isArray(batch.results[0]?.content)
    if (plainSingleTool && !hasDifferentText.has(assistantTextKey(assistant))) continue
    toolReplayAssistantIds?.add(assistant.id)
    const body = prose(assistant)
    const version = { batch, keys, complete: full }
    const original = rememberVersion(
      versions,
      JSON.stringify([...body.text.map(payloadId), ...keys]),
      version,
      (left, right) => equivalentPresentation(left.batch.assistant, right.batch.assistant) &&
        exactSlots(left.batch, right.batch, false)
    )
    if (original !== version) {
      const identical = sameValue(assistant.content, original.batch.assistant.content)
      const copies = plainSingleTool && identical ? exactSingleToolCopies : exactCopies
      copies.set(batch, original.batch)
      if (!identical) {
        const layout = indexedProse(assistant)
        if (layout !== body && !sameReplayProse(layout, indexedProse(original.batch.assistant))) {
          indexPresentation(keys, original.batch, layout, true)
        }
      }
      continue
    }
    if (hasReplayProse(assistant.content)) {
      replayOrder.set(batch, position)
      const layout = indexedProse(assistant)
      indexPresentation(keys, batch, body, false)
      if (layout !== body) indexPresentation(keys, batch, layout, true)
    }
    for (const key of keys) {
      const byResultCount = observed.get(key) ?? new Map<number, SlotVersion[]>()
      const sharingResult = byResultCount.get(keys.length) ?? []
      sharingResult.push(version)
      byResultCount.set(keys.length, sharingResult)
      observed.set(key, byResultCount)
    }
  }

  const presentationAliases = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const continuedText = new Map<PartialToolExchange<T>, T>()
  const parentCandidates = new Map<PartialToolExchange<T>, Set<PartialToolExchange<T>>>()
  for (const variants of textVersionsByResults.values()) {
    if (variants.length < 2) continue
    const span = findReplayProseIndexSpan(variants.map(({ match }) => match))
    const part = (variant: (typeof variants)[number]) => variant.match.text[span]
    const initial = variants[0]
    const mayHaveMultipleParents = variants.some(({ prose, match }) =>
      !sameValue(prose.annotations, initial.prose.annotations) ||
      match.text.some((text, index) => index !== span && text !== initial.match.text[index])
    )
    variants.sort((left, right) => {
      const first = part(left)
      const second = part(right)
      return first < second ? -1 : first > second ? 1 : left.length - right.length
    })
    const prefixes: typeof variants = []
    for (const variant of variants) {
      while (prefixes.length && !part(variant).startsWith(part(prefixes.at(-1)!))) prefixes.pop()
      const matches = ({ batch, prose, match }: (typeof variants)[number]) =>
        prose === match &&
        isReplayProseExtension(variant.prose, prose) &&
        exactSlots(variant.batch, batch, false)
      const parents: typeof variants = []
      if (!mayHaveMultipleParents) {
        const previous = prefixes.findLast(matches)
        if (previous) parents.push(previous)
      } else {
        // A retained block separates text spans, and a provider can extend
        // either span independently. Reject incomparable parent claims.
        for (const prefix of prefixes) {
          if (!matches(prefix)) continue
          if (parents.some((parent) => isReplayProseExtension(parent.prose, prefix.prose)))
            continue
          for (let index = parents.length - 1; index >= 0; index--) {
            if (isReplayProseExtension(prefix.prose, parents[index].prose))
              parents.splice(index, 1)
          }
          parents.push(prefix)
        }
      }
      if (parents.length) {
        const candidates = parentCandidates.get(variant.batch) ?? new Set()
        for (const { batch } of parents) candidates.add(batch)
        parentCandidates.set(variant.batch, candidates)
      }
      prefixes.push(variant)
    }
  }
  if (parentCandidates.size) {
    const parentByVersion = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
    const childrenByVersion = new Map<PartialToolExchange<T>, number>()
    const continuations = new Set<PartialToolExchange<T>>()
    for (const [batch, candidates] of parentCandidates) {
      // Indexing ordinary spans and provider-indexed blocks can admit
      // different predecessors. Choose one only if it follows all others.
      const predecessors = [...candidates]
      const parent = predecessors.find((candidate) => predecessors.every((other) =>
        candidate === other || extendedText(candidate.assistant, other.assistant)
      ))
      if (!parent) continue
      parentByVersion.set(batch, parent)
      childrenByVersion.set(parent, (childrenByVersion.get(parent) ?? 0) + 1)
      continuations.add(batch)
      continuations.add(parent)
    }
    // Keep each line of continuation independent below a shared prefix.
    const rootByVersion = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
    const chains = new Map<PartialToolExchange<T>, PartialToolExchange<T>[]>()
    const length = (batch: PartialToolExchange<T>) => replayProseLength(prose(batch.assistant))
    for (const batch of [...continuations].sort((left, right) => length(left) - length(right))) {
      const parent = parentByVersion.get(batch)
      const root =
        parent && childrenByVersion.get(parent) === 1
          ? (rootByVersion.get(parent) ?? parent)
          : batch
      rootByVersion.set(batch, root)
      const chain = chains.get(root) ?? []
      chain.push(batch)
      chains.set(root, chain)
    }
    for (const chain of chains.values()) {
      if (chain.length < 2) continue
      const retained = chain.reduce((first, batch) =>
        replayOrder.get(batch)! < replayOrder.get(first)! ? batch : first
      )
      continuedText.set(retained, chain.at(-1)!.assistant)
      for (const batch of chain) if (batch !== retained) presentationAliases.set(batch, retained)
    }
  }

  // A partial replay can point to a more complete recording of the same
  // batch. Every occupied slot must agree and the target must be unique.
  const containing = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const samePresentation = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const partials = [...versions.values()]
    .flat()
    .filter((version) => !version.complete && !presentationAliases.has(version.batch))
    .sort((left, right) => right.keys.length - left.keys.length)
  const findContainingBatch = (version: SlotVersion, exactPresentation: boolean) => {
    const candidates = version.keys
      .map((key) => {
        const groups: SlotVersion[][] = []
        let count = 0
        for (const [resultCount, group] of observed.get(key) ?? []) {
          if (resultCount <= version.keys.length) continue
          groups.push(group)
          count += group.length
        }
        return { groups, count }
      })
      .reduce((smallest, group) => (group.count < smallest.count ? group : smallest))
    let target: PartialToolExchange<T> | undefined
    let targetPresentation: T | undefined
    const copyPresentation = continuedText.get(version.batch) ?? version.batch.assistant
    for (const group of candidates.groups) {
      for (const candidate of group) {
        const sameVersion = samePresentation.get(candidate.batch) ?? candidate.batch
        const presentationVersion = presentationAliases.get(sameVersion) ?? sameVersion
        const retained = exactPresentation ? sameVersion : presentationVersion
        const retainedPresentation =
          continuedText.get(presentationVersion) ?? presentationVersion.assistant
        if (
          !compatibleText(retainedPresentation, copyPresentation) ||
          !exactSlots(version.batch, retained, exactPresentation)
        )
          continue
        if (target && targetPresentation && retained !== target) {
          if (
            exactPresentation ||
            !compatibleText(targetPresentation, retainedPresentation) ||
            (!exactSlots(retained, target, false) && !exactSlots(target, retained, false))
          )
            return undefined
          const distance = textDistance(copyPresentation, retainedPresentation)
          const targetDistance = textDistance(copyPresentation, targetPresentation)
          if (distance >= targetDistance) continue
        }
        target = retained
        targetPresentation = retainedPresentation
      }
    }
    return target
  }
  for (const version of partials) {
    const target = findContainingBatch(version, true)
    if (target) samePresentation.set(version.batch, target)
  }
  for (const version of partials) {
    if (samePresentation.has(version.batch)) continue
    const target = findContainingBatch(version, false)
    if (target) containing.set(version.batch, target)
  }

  const candidates = new Map([...containing, ...samePresentation, ...presentationAliases])
  const children = new Map<PartialToolExchange<T>, PartialToolExchange<T>[]>()
  for (const [copy, target] of candidates) {
    const copies = children.get(target) ?? []
    copies.push(copy)
    children.set(target, copies)
  }
  const pending = new Map([...children].map(([target, copies]) => [target, copies.length]))
  const ready = [...candidates.keys()].filter((batch) => !pending.has(batch))
  const textByGroup = new Map<PartialToolExchange<T>, T>()
  const direct = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  for (const batch of ready) {
    const own = continuedText.get(batch) ?? batch.assistant
    let longest = own
    let divergent = false
    const compatible: Array<{ copy: PartialToolExchange<T>; content: T }> = []
    // A short common prefix can match either branch. Check the full text
    // already accepted below each child before attaching it to this batch.
    for (const copy of children.get(batch) ?? []) {
      const content = textByGroup.get(copy) ?? copy.assistant
      if (!compatibleText(own, content)) continue
      compatible.push({ copy, content })
      if (!compatibleText(longest, content)) divergent = true
      else if (extendedText(content, longest)) longest = content
    }
    for (const { copy, content } of compatible) {
      if (!divergent || !extendedText(content, own)) direct.set(copy, batch)
    }
    textByGroup.set(batch, divergent ? own : longest)
    const parent = candidates.get(batch)
    if (parent) {
      const remaining = pending.get(parent)! - 1
      pending.set(parent, remaining)
      if (!remaining) ready.push(parent)
    }
  }

  // Equal-coverage edges target a canonical row, and other edges add results.
  const continuations = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  for (const copy of direct.keys()) {
    if (continuations.has(copy)) continue
    const path = [copy]
    let target = direct.get(copy)!
    while (direct.has(target) && !continuations.has(target)) {
      path.push(target)
      target = direct.get(target)!
    }
    const retained = continuations.get(target) ?? target
    for (const alias of path) continuations.set(alias, retained)
  }
  const withVerifiedText = new Set([...continuations].flat())
  for (const [copy, original] of exactSingleToolCopies) {
    if (withVerifiedText.has(original)) exactCopies.set(copy, original)
  }

  const proposed = new Map<string, string>()
  const removedCallKeys = new Map<string, string[]>()
  for (const [copy, original] of [...continuations, ...exactCopies]) {
    const retained = continuations.get(original) ?? original
    const id = copy.assistant.id
    proposed.set(id, retained.assistant.id)
    removedCallKeys.set(
      id,
      copy.calls.map((call, index) => getWorkerToolUiKey(id, call.id, index))
    )
    copy.results.forEach((row, index) => {
      const peer = retained.results[index]
      if (row && peer && row.id !== peer.id) proposed.set(row.id, peer.id)
    })
  }
  const verified = preserveReplayToolBindings(messages, proposed, ownership)
  return { verified, removedCallKeys }
}

function foldInterruptedAndProjectedToolCopies<T extends TranscriptMessage>(
  messages: readonly T[],
  checkpointTurns?: CheckpointReplayTurns
) {
  if (!hasToolReplayCandidates(messages)) return
  const ownership = resolveToolResultOwnership(messages)
  const { verified, removedCallKeys } = findToolSlotCopyAliases(
    messages,
    ownership,
    checkpointTurns
  )
  const folded = stageToolResultReplays(
    messages,
    new Set(verified.keys()),
    checkpointTurns,
    new Set([...verified.keys()].flatMap((id) => removedCallKeys.get(id) ?? []))
  )
  if (!folded) return
  const byId = new Map(messages.map((row) => [row.id, row]))
  const content = getAssistantReplayContent(verified, (id) => byId.get(id))
  if (content.size)
    folded.messages = folded.messages.map((row) => {
      const text = content.get(row.id)
      return text === undefined ? row : { ...row, content: text }
    })
  return folded
}

function repairLocalResultReplays<T extends TranscriptMessage>(
  messages: readonly T[],
  checkpointTurns?: CheckpointReplayTurns
) {
  if (!hasToolReplayCandidates(messages)) return
  const ownership = resolveToolResultOwnership(messages)
  const owned = new Set(ownership.values())
  const executionIds = new Set(
    [...owned].filter(hasToolResultExecutionId).map(getMessageProviderSourceId)
  )
  const { aliases } = findReplayedResultRebindings(messages, ownership, owned, executionIds)
  return stageToolResultReplays(messages, new Set(aliases.keys()), checkpointTurns)
}

function indexAnchoredExchanges<T extends TranscriptMessage>(
  messages: readonly T[],
  payloadId: (value: unknown) => number,
  {
    includeLeadingHidden,
    checkpointTurns,
    foldEquivalentTargets
  }: {
    includeLeadingHidden: boolean
    checkpointTurns?: CheckpointReplayTurns
    foldEquivalentTargets?: boolean
  }
) {
  const ownership = resolveToolResultOwnership(messages)
  const byAnchor = new Map<string, AnchoredToolExchange<T>[]>()
  const byPhysicalGroup = new Map<string, AnchoredToolExchange<T>[]>()
  const byOutcome = new Map<string, AnchoredToolExchange<T>[]>()
  const incomplete: AnchoredToolSlots<T>[] = []
  const assistantAnchors = new Map<string, T | undefined>()
  const visibleUsers = new Map<string, { message: T; index: number } | null>()
  const addCandidate = (
    index: Map<string, AnchoredToolExchange<T>[]>,
    key: string,
    candidate: AnchoredToolExchange<T>
  ) => {
    const group = index.get(key) ?? []
    group.push(candidate)
    index.set(key, group)
  }
  let anchor: T | undefined
  let position = 0
  const addAnchoredCandidate = (
    scope: string | null,
    evidence: unknown[],
    outcome: unknown[] | undefined,
    candidate: AnchoredToolExchange<T>
  ) => {
    const key = JSON.stringify([scope, ...evidence])
    if (foldEquivalentTargets && outcome) {
      const outcomeKey = JSON.stringify([scope, ...outcome])
      const group = byOutcome.get(outcomeKey) ?? []
      const previous = group.findIndex(
        (entry) =>
          (scope === null || sameReplayAnchor(entry.anchor, candidate.anchor)) &&
          isSameCompletedExecution(entry.exchange, candidate.exchange)
      )
      if (previous < 0) group.push(candidate)
      else group[previous] = candidate
      byOutcome.set(outcomeKey, group)
    }
    if (
      foldEquivalentTargets &&
      candidate.hasPhysicalResults &&
      byAnchor
        .get(key)
        ?.some(
          (previous) =>
            isExactToolExchangeReplay(previous.exchange, candidate.exchange) &&
            (scope === null || sameReplayAnchor(previous.anchor, candidate.anchor))
        )
    )
      return
    addCandidate(byAnchor, key, candidate)
  }
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" || message.role === "system") {
      anchor = message.role === "user" ? message : undefined
      if (anchor)
        visibleUsers.set(anchor.id, visibleUsers.has(anchor.id) ? null : { message: anchor, index })
      position = 0
      continue
    }
    if (message.role !== "assistant") continue
    assistantAnchors.set(message.id, assistantAnchors.has(message.id) ? undefined : anchor)
    if (!anchor && !includeLeadingHidden) continue
    const slots = readToolExchangeSlots(message, ownership)
    const exchange = slots?.results.every((result): result is T => result !== undefined)
      ? { ...slots, results: slots.results }
      : undefined
    if (exchange) {
      const hasPhysicalResults = exchange.results.every(hasToolResultExecutionId)
      const identity = exchangeKey(exchange)
      const outcome = hasPhysicalResults
        ? [
            identity,
            exchange.results.map((result) => [resultReplayKey(result), payloadId(result.content)])
          ]
        : undefined
      const evidenceKey = [
        identity,
        outcome ? [payloadId(exchange.assistant.content), outcome[1]] : null
      ]
      const outcomeKey = outcome ? JSON.stringify([anchor?.id ?? null, ...outcome]) : undefined
      const physicalKey = outcome ? JSON.stringify(outcome) : undefined
      const candidate = { exchange, position, anchor, hasPhysicalResults, outcomeKey, physicalKey }
      const requiresRawProof =
        checkpointTurns && (!anchor || checkpointTurns.hiddenAnchors.has(anchor.id))
      const unsafe =
        requiresRawProof &&
        (!hasPhysicalResults || !hasRawCheckpointToolBindings(exchange, checkpointTurns))
      if (!unsafe) {
        if (anchor) addAnchoredCandidate(anchor.id, evidenceKey, outcome, candidate)
        if (
          includeLeadingHidden &&
          hasPhysicalResults &&
          (!checkpointTurns || (!anchor && checkpointTurns.leadingHiddenAssistants.has(message.id)))
        ) {
          addAnchoredCandidate(null, evidenceKey, outcome, candidate)
        }
        if (physicalKey) addCandidate(byPhysicalGroup, physicalKey, candidate)
      }
    } else if (
      slots &&
      slots.results.some((result) => result && hasToolResultExecutionId(result)) &&
      slots.results.every((result) => !result || hasToolResultExecutionId(result)) &&
      (!checkpointTurns || hasRawCheckpointToolBindings(slots, checkpointTurns))
    ) {
      incomplete.push({ exchange: slots, anchor })
    }
    position++
  }
  return {
    byAnchor,
    byPhysicalGroup,
    byOutcome,
    incomplete,
    ownership,
    assistantAnchors,
    visibleUsers
  }
}

function dropEarlierCheckpointCopies<T extends TranscriptMessage>(
  messages: readonly T[],
  checkpoint: ReturnType<typeof indexAnchoredExchanges<T>>,
  durable: ReturnType<typeof indexAnchoredExchanges<T>>,
  checkpointTurns?: CheckpointReplayTurns
) {
  const aliases = new Map<string, string>()
  const removedCallKeys = new Set<string>()
  const agreesWithCurrentTurn = (copy: AnchoredToolExchange<T>) =>
    Boolean(
      copy.outcomeKey &&
      durable.byOutcome
        .get(copy.outcomeKey)
        ?.some(
          (target) =>
            sameReplayAnchor(target.anchor, copy.anchor, true) &&
            isSameCompletedExecution(target.exchange, copy.exchange, true)
        )
    )
  let currentBatchWitnesses: Set<string> | undefined
  const hasCurrentBatch = (anchor: T, exchange: ToolExchange<T>) => {
    if (!currentBatchWitnesses) {
      currentBatchWitnesses = new Set()
      for (const group of checkpoint.byPhysicalGroup.values()) {
        for (const copy of group) {
          if (copy.anchor && agreesWithCurrentTurn(copy)) {
            currentBatchWitnesses.add(JSON.stringify([copy.anchor.id, exchangeKey(copy.exchange)]))
          }
        }
      }
    }
    return currentBatchWitnesses.has(JSON.stringify([anchor.id, exchangeKey(exchange)]))
  }
  for (const [key, incoming] of checkpoint.byPhysicalGroup) {
    const earlier = durable.byPhysicalGroup.get(key)
    if (!earlier) continue
    for (const copy of incoming) {
      const { exchange, anchor } = copy
      const current = anchor && durable.visibleUsers.get(anchor.id)
      if (
        !anchor ||
        !current ||
        !sameReplayAnchor(current.message, anchor, true) ||
        agreesWithCurrentTurn(copy)
      )
        continue
      const original = earlier.find((candidate) => {
        const previous = candidate.anchor && durable.visibleUsers.get(candidate.anchor.id)
        return (
          previous &&
          previous.index < current.index &&
          (isExactToolExchangeReplay(candidate.exchange, exchange) ||
            (isSameCompletedExecution(candidate.exchange, exchange, true) &&
              hasCurrentBatch(anchor, exchange)))
        )
      })
      if (!original) continue
      aliases.set(exchange.assistant.id, original.exchange.assistant.id)
      exchange.results.forEach((result, index) => {
        aliases.set(result.id, original.exchange.results[index].id)
        removedCallKeys.add(
          getWorkerToolUiKey(exchange.assistant.id, exchange.calls[index].id, index)
        )
      })
    }
  }
  const verified = preserveReplayToolBindings(messages, aliases, checkpoint.ownership)
  return stageToolResultReplays(
    messages,
    new Set(verified.keys()),
    checkpointTurns,
    removedCallKeys
  )
}

function repairCheckpointFromDurableResults<T extends TranscriptMessage>(
  messages: readonly T[],
  checkpoint: ReturnType<typeof indexAnchoredExchanges<T>>,
  durable: ReturnType<typeof indexAnchoredExchanges<T>>,
  checkpointTurns?: CheckpointReplayTurns
) {
  const owned = new Set(checkpoint.ownership.values())
  const ownedExecutions = new Set([...owned].filter(hasToolResultExecutionId).map(resultReplayKey))
  const unowned = new Map<string, Array<{ row: T; index: number }>>()
  const positions = new Map<T, number>()
  for (const [index, row] of messages.entries()) {
    if (row.role !== "tool" || !hasToolResultExecutionId(row)) continue
    positions.set(row, index)
    const key = resultReplayKey(row)
    if (ownedExecutions.has(key)) continue
    const results = unowned.get(key) ?? []
    results.push({ row, index })
    unowned.set(key, results)
  }
  if (!unowned.size) return
  const durableResults = new Map<string, T[]>()
  for (const row of durable.ownership.values()) {
    if (!hasToolResultExecutionId(row)) continue
    const key = resultReplayKey(row)
    const results = durableResults.get(key) ?? []
    results.push(row)
    durableResults.set(key, results)
  }
  const durableCalls = new Map<string, Set<AnchoredToolExchange<T>>>()
  const includeUnanchored = Boolean(checkpointTurns?.leadingHiddenAssistants.size)
  for (const outcomes of durable.byOutcome.values()) {
    for (const item of outcomes) {
      if (!item.exchange.results.some((row) => unowned.has(resultReplayKey(row)))) continue
      const scopes = item.anchor ? [item.anchor.id] : []
      if (includeUnanchored) scopes.push("")
      for (const scope of scopes) {
        const key = JSON.stringify([scope, exchangeKey(item.exchange)])
        const calls = durableCalls.get(key) ?? new Set()
        calls.add(item)
        durableCalls.set(key, calls)
      }
    }
  }
  const removed = new Set<string>()
  const expected = new Map<string, T>()
  for (const group of checkpoint.byPhysicalGroup.values()) {
    for (const candidate of group) {
      const { exchange, anchor } = candidate
      if (!anchor && !checkpointTurns?.leadingHiddenAssistants.has(exchange.assistant.id)) continue
      const possibilities: Array<Array<{ slot: string; stale: T; result: T }>> = []
      const key = JSON.stringify([anchor?.id ?? "", exchangeKey(exchange)])
      for (const target of durableCalls.get(key) ?? []) {
        if (
          (anchor && !sameReplayAnchor(target.anchor, anchor, true)) ||
          !sameExchangeCalls(target.exchange, exchange, true, false)
        )
          continue
        const replacements: Array<{ slot: string; stale: T; result: T }> = []
        const valid = exchange.results.every((stale, index) => {
          const exact = target.exchange.results[index]
          if (sameRow(exact, stale, true)) return true
          const position = positions.get(stale)
          const key = resultReplayKey(stale)
          if (
            position === undefined ||
            key === resultReplayKey(exact) ||
            !durableResults.get(key)?.some((row) => sameRow(row, stale, true)) ||
            !unowned
              .get(resultReplayKey(exact))
              ?.some(({ row, index }) => index > position && sameRow(exact, row, true))
          )
            return false
          replacements.push({
            slot: getWorkerToolUiKey(exchange.assistant.id, exchange.calls[index].id, index),
            stale,
            result: exact
          })
          return true
        })
        if (valid && replacements.length) possibilities.push(replacements)
      }
      if (possibilities.length !== 1) continue
      for (const { slot, stale, result } of possibilities[0]) {
        removed.add(stale.id)
        expected.set(slot, result)
      }
    }
  }
  const staged = stageToolResultReplays(messages, removed, checkpointTurns)
  if (!staged) return
  const repaired = resolveToolResultOwnership(staged.messages)
  if (
    repaired.size !== checkpoint.ownership.size ||
    [...checkpoint.ownership].some(
      ([slot, row]) =>
        !sameResultBinding(expected.get(slot) ?? row, repaired.get(slot), expected.has(slot))
    )
  )
    return
  return staged
}

function reconcileCheckpointToolBatches<T extends TranscriptMessage>(
  messages: readonly T[],
  checkpoint: ReturnType<typeof indexAnchoredExchanges<T>>,
  durable: ReturnType<typeof indexAnchoredExchanges<T>>,
  checkpointTurns?: CheckpointReplayTurns
) {
  const structuredCalls = new Set(
    messages
      .filter((row) => row.role === "tool" && Array.isArray(row.content))
      .map((row) => row.tool_call_id)
  )
  const partial = messages.flatMap((assistant) => {
    if (assistant.role !== "assistant") return []
    const batch = readToolExchangeSlots(assistant, checkpoint.ownership)
    return batch &&
      (batch.calls.length > 1 || batch.calls.some(({ id }) => structuredCalls.has(id)))
      ? [batch]
      : []
  })
  if (!partial.length || (!durable.incomplete.length && !durable.byOutcome.size)) return
  const durableResults = new Map<string, T[]>()
  for (const row of durable.ownership.values()) {
    if (!hasToolResultExecutionId(row)) continue
    const key = resultReplayKey(row)
    const variants = durableResults.get(key) ?? []
    variants.push(row)
    durableResults.set(key, variants)
  }
  const durableBatches = new Map<string, Set<AnchoredToolSlots<T>>>()
  const previousResults = new Map<string, Array<{ row: T; userIndex: number }>>()
  const includeUnanchored = Boolean(checkpointTurns?.leadingHiddenAssistants.size)
  for (const choices of [...durable.byOutcome.values(), durable.incomplete]) {
    for (const choice of choices) {
      const user = choice.anchor && durable.visibleUsers.get(choice.anchor.id)
      if (user) {
        for (const row of choice.exchange.results) {
          if (!row || !hasToolResultExecutionId(row)) continue
          const key = resultReplayKey(row)
          const results = previousResults.get(key) ?? []
          results.push({ row, userIndex: user.index })
          previousResults.set(key, results)
        }
      }
      const scopes = choice.anchor ? [choice.anchor.id] : []
      if (includeUnanchored) scopes.push("")
      for (const scope of scopes) {
        const key = JSON.stringify([scope, exchangeKey(choice.exchange)])
        const batches = durableBatches.get(key) ?? new Set<AnchoredToolSlots<T>>()
        batches.add(choice)
        durableBatches.set(key, batches)
      }
    }
  }
  const positions = new Map(messages.map((row, index) => [row.id, index]))
  const unbound = new Map<string, T[]>()
  const owned = new Set(checkpoint.ownership.values())
  for (const row of messages) {
    if (row.role !== "tool" || owned.has(row) || !hasToolResultExecutionId(row)) continue
    const key = resultReplayKey(row)
    const results = unbound.get(key) ?? []
    results.push(row)
    unbound.set(key, results)
  }
  const removed = new Set<string>()
  const replaced = new Map<string, T>()
  const insertions = new Map<string, T[]>()
  const insertedIds = new Set<string>()
  const expected = new Map(checkpoint.ownership)
  const changedSlots = new Set<string>()
  const alignments: CheckpointAlignment<T>[] = []
  for (const batch of partial) {
    const anchor = checkpoint.assistantAnchors.get(batch.assistant.id)
    if (!anchor && !checkpointTurns?.leadingHiddenAssistants.has(batch.assistant.id)) continue
    const currentUser = anchor && durable.visibleUsers.get(anchor.id)
    type ResultSlot = { prior?: T; selected?: T; target?: T; observed?: boolean; insert?: boolean }
    const possible: Array<{ slots: ResultSlot[]; target: T; needsAlignment: boolean }> = []
    for (const donor of durableBatches.get(
      JSON.stringify([anchor?.id ?? "", exchangeKey(batch)])
    ) ?? []) {
      if (
        (anchor && !sameReplayAnchor(donor.anchor, anchor, true)) ||
        !sameExchangeCalls(donor.exchange, batch, true, false)
      )
        continue
      const slots: ResultSlot[] = []
      let enrichedEmptyResult = false
      const corroborated = donor.exchange.results.every((result, index) => {
        const prior = batch.results[index]
        if (!result) {
          const fromEarlierTurn =
            prior &&
            currentUser &&
            previousResults
              .get(resultReplayKey(prior))
              ?.some(
                ({ row, userIndex }) =>
                  userIndex < currentUser.index && sameStoredToolResult(row, prior)
              )
          slots.push({ prior, selected: fromEarlierTurn ? undefined : prior })
          return true
        }
        if (!hasToolResultExecutionId(result)) return false
        if (prior && sameStoredToolResult(result, prior)) {
          slots.push({ prior, selected: prior, target: result, observed: true })
          return true
        }
        if (
          prior &&
          sameRow(result, prior, true, false) &&
          typeof result.content === "string" &&
          typeof prior.content === "string" &&
          result.content.startsWith(prior.content) &&
          (prior.content || sameExchangeCalls(donor.exchange, batch, true, true))
        ) {
          if (!prior.content) enrichedEmptyResult = true
          slots.push({
            prior,
            selected: { ...prior, content: result.content },
            target: result,
            observed: true,
            insert: false
          })
          return true
        }
        if (
          prior &&
          (resultReplayKey(result) === resultReplayKey(prior) ||
            !durableResults
              .get(resultReplayKey(prior))
              ?.some((stored) => sameStoredToolResult(stored, prior)))
        )
          return false
        const after = positions.get(prior?.id ?? batch.assistant.id) ?? -1
        const observed = unbound
          .get(resultReplayKey(result))
          ?.find(
            (row) => (positions.get(row.id) ?? -1) > after && sameStoredToolResult(result, row)
          )
        if (!observed && (positions.has(result.id) || insertedIds.has(result.id))) return false
        slots.push({
          prior,
          selected: observed ?? result,
          target: result,
          observed: Boolean(observed),
          insert: !observed
        })
        return true
      })
      const hasIndependentWitness =
        !enrichedEmptyResult ||
        slots.some(
          ({ prior, selected, target, observed }) =>
            observed &&
            (prior || selected)?.content !== "" &&
            target &&
            selected &&
            sameStoredToolResult(target, prior ?? selected)
        )
      if (corroborated && hasIndependentWitness && slots.some(({ observed }) => observed)) {
        const needsAlignment = slots.some(
          ({ selected, target }) => !selected || !target || !sameRow(target, selected, true)
        )
        possible.push({ slots, target: donor.exchange.assistant, needsAlignment })
      }
    }
    if (possible.length !== 1) continue
    const [{ slots, target, needsAlignment }] = possible
    const lastObserved = slots.reduce(
      (latest, { observed, selected }) =>
        observed && selected && (positions.get(selected.id) ?? -1) > (positions.get(latest) ?? -1)
          ? selected.id
          : latest,
      batch.assistant.id
    )
    slots.forEach(({ prior, selected, insert }, index) => {
      if (prior === selected) return
      const slot = getWorkerToolUiKey(batch.assistant.id, batch.calls[index].id, index)
      changedSlots.add(slot)
      if (selected) expected.set(slot, selected)
      else expected.delete(slot)
      if (prior && selected && prior.id === selected.id) replaced.set(prior.id, selected)
      else if (prior) removed.add(prior.id)
      if (insert && selected) {
        const inserted = insertions.get(lastObserved) ?? []
        inserted.push(selected)
        insertions.set(lastObserved, inserted)
        insertedIds.add(selected.id)
      }
    })
    if (needsAlignment) {
      const rows: CheckpointAlignment<T> = [[batch.assistant, target]]
      for (const slot of slots) {
        if (slot.selected && slot.target) rows.push([slot.selected, slot.target])
      }
      alignments.push(rows)
    }
  }
  if (!changedSlots.size && !alignments.length) return
  const apply = <R extends TranscriptMessage>(rows: readonly R[]): Array<R | T> =>
    rows.flatMap((row) =>
      removed.has(row.id) ? [] : [replaced.get(row.id) ?? row, ...(insertions.get(row.id) ?? [])]
    )
  const completed = changedSlots.size ? apply(messages) : messages.slice()
  const ownership = resolveToolResultOwnership(completed)
  if (
    ownership.size !== expected.size ||
    [...expected].some(([key, result]) => !sameResultBinding(result, ownership.get(key)))
  )
    return
  if (!checkpointTurns) return { messages: completed, alignments }

  const byId = new Map(messages.map((row) => [row.id, row]))
  const raw: TranscriptMessage[] = checkpointTurns.rawToolTranscript.map((row) => ({
    ...byId.get(row.id),
    ...row
  }))
  const rawExpected = resolveToolResultOwnership(raw)
  const rawIds = new Set(raw.map(({ id }) => id))
  if (
    [...removed, ...replaced.keys(), ...insertions.keys()].some((id) => !rawIds.has(id)) ||
    [...insertedIds].some((id) => rawIds.has(id))
  )
    return
  for (const key of changedSlots) {
    const visibleBefore = checkpoint.ownership.get(key)
    const rawBefore = rawExpected.get(key)
    if (visibleBefore?.id !== rawBefore?.id) return
    const wanted = expected.get(key)
    if (wanted) rawExpected.set(key, wanted)
    else rawExpected.delete(key)
  }
  const completedRaw = apply(raw)
  const rawOwnership = resolveToolResultOwnership(completedRaw)
  if (
    rawOwnership.size !== rawExpected.size ||
    [...rawExpected].some(([key, result]) => !sameResultBinding(result, rawOwnership.get(key)))
  )
    return
  const verifiedAlignments = alignments.filter(([assistant]) => {
    const slots = readToolExchangeSlots(assistant[0], ownership)
    return slots?.results.every((result, index) => {
      const key = getWorkerToolUiKey(slots.assistant.id, slots.calls[index].id, index)
      return rawOwnership.get(key)?.id === result?.id
    })
  })
  if (verifiedAlignments.length !== alignments.length) return
  return {
    messages: completed,
    alignments,
    checkpointTurns: {
      ...checkpointTurns,
      rawToolTranscript: completedRaw,
      uniqueMessageIds: new Set([...checkpointTurns.uniqueMessageIds, ...insertedIds]),
      rawResultByCall: new Map([...rawOwnership].map(([key, row]) => [key, row.id]))
    }
  }
}

function selectCheckpointReplayAliases<T extends TranscriptMessage>(
  replay: readonly T[],
  checkpoint: ReturnType<typeof indexAnchoredExchanges<T>>,
  targets: ReadonlyMap<AnchoredToolExchange<T>, AnchoredToolExchange<T>>
): ReadonlyMap<string, string> {
  const groups: Array<{ ids: string[]; aliases: Array<[string, string]> }> = []
  for (const copies of checkpoint.byPhysicalGroup.values()) {
    const handled = new Set<AnchoredToolExchange<T>>()
    for (const candidate of copies) {
      const target = targets.get(candidate)
      if (!target || handled.has(candidate)) continue
      const matchesTarget = (copy: AnchoredToolExchange<T>) =>
        targets.get(copy)?.exchange.assistant.id === target.exchange.assistant.id &&
        isSameCompletedExecution(candidate.exchange, copy.exchange)
      // Keep the checkpoint's latest presentation of a matched execution.
      const retained =
        copies.findLast(
          (copy) =>
            !handled.has(copy) &&
            matchesTarget(copy) &&
            !isExactToolExchangeReplay(candidate.exchange, copy.exchange)
        ) ?? candidate
      const equivalent = copies.filter(
        (copy) =>
          copy !== retained &&
          !handled.has(copy) &&
          (matchesTarget(copy) || isExactToolExchangeReplay(retained.exchange, copy.exchange))
      )
      if (!equivalent.length) continue
      const aliases: Array<[string, string]> = []
      handled.add(retained)
      for (const { exchange } of equivalent) {
        if (exchange.assistant.id === retained.exchange.assistant.id) continue
        aliases.push([exchange.assistant.id, retained.exchange.assistant.id])
        exchange.results.forEach(({ id }, index) => {
          const retainedId = retained.exchange.results[index].id
          if (id !== retainedId) aliases.push([id, retainedId])
        })
      }
      for (const copy of equivalent) handled.add(copy)
      if (aliases.length)
        groups.push({
          ids: retained.exchange.calls.map(({ id }) => getRawWorkerToolCallId(id)),
          aliases
        })
    }
  }
  if (!groups.length) return noAliases
  const proposed = new Map(groups.flatMap(({ aliases }) => aliases))
  const unsafe: UnsafeBindings = { callIds: new Set(), invalidResultIds: new Set() }
  const verified = preserveReplayToolBindings(replay, proposed, checkpoint.ownership, unsafe)
  if (verified.size) return verified
  if (!unsafe.callIds.size) return noAliases

  // Tool bindings for unrelated call IDs cannot change each other. Retain
  // independently verified groups without relaxing proof for a shared ID.
  const groupsById = new Map<string, number[]>()
  groups.forEach(({ ids }, index) => {
    for (const id of ids) {
      const sharingId = groupsById.get(id) ?? []
      sharingId.push(index)
      groupsById.set(id, sharingId)
    }
  })
  const rejected = new Set<number>()
  for (const id of unsafe.callIds) {
    for (const index of groupsById.get(id) ?? []) {
      if (rejected.has(index)) continue
      rejected.add(index)
      for (const adjacentId of groups[index].ids) unsafe.callIds.add(adjacentId)
    }
  }
  const independent = new Map(
    groups.flatMap(({ aliases }, index) => (rejected.has(index) ? [] : aliases))
  )
  return preserveReplayToolBindings(replay, independent, checkpoint.ownership)
}

function keepDistinctCheckpointTurns<T extends TranscriptMessage>(
  targets: Map<AnchoredToolExchange<T>, AnchoredToolExchange<T>>,
  rawTurns: ReadonlyMap<string, string>
): void {
  const byTarget = new Map<AnchoredToolExchange<T>, AnchoredToolExchange<T>[]>()
  for (const [copy, target] of targets) {
    const group = byTarget.get(target) ?? []
    group.push(copy)
    byTarget.set(target, group)
  }
  for (const [target, copies] of byTarget) {
    if (copies.length < 2) continue
    const preferred =
      copies.find((copy) => isExactToolExchangeReplay(target.exchange, copy.exchange)) ?? copies[0]
    const retainedTurn = rawTurns.get(preferred.exchange.assistant.id)
    for (const copy of copies) {
      const copyTurn = rawTurns.get(copy.exchange.assistant.id)
      if (
        copyTurn !== undefined &&
        retainedTurn !== undefined &&
        copyTurn !== retainedTurn &&
        !isExactToolExchangeReplay(preferred.exchange, copy.exchange)
      ) {
        // Keep the other notification's presentation. Occurrence reservation
        // below can give it space without consuming this durable row.
        targets.delete(copy)
      }
    }
  }
}

interface ReplayProse {
  text: string[]
  blocks: unknown[]
  annotations: Array<{ span: number; block: number; value: unknown }>
}

function sameReplayProse(left: ReplayProse, right: ReplayProse): boolean {
  return (
    sameValue(left.text, right.text) &&
    sameValue(left.blocks, right.blocks) &&
    sameValue(left.annotations, right.annotations)
  )
}

function sameReplayBodies(left: unknown, right: unknown): boolean {
  if (sameValue(left, right)) return true
  if (typeof left === "string" && typeof right === "string") return false
  return (
    hasReplayProse(left) &&
    hasReplayProse(right) &&
    sameReplayProse(readReplayProse(left), readReplayProse(right))
  )
}

function readIndexedReplayProse(content: unknown, fallback: ReplayProse): ReplayProse {
  if (!Array.isArray(content)) return fallback
  const indexedBlocks = content.filter((block) =>
    block?.type === "text" && typeof block.text === "string" && typeof block.index === "number"
  )
  return indexedBlocks.length > 1 ? readReplayProse(content, true) : fallback
}

function readReplayProse(content: unknown, preserveTextIndices = false): ReplayProse {
  if (typeof content === "string") return { text: [content], blocks: [], annotations: [] }
  if (!Array.isArray(content)) return { text: [""], blocks: [], annotations: [] }
  const text: string[] = []
  const blocks: unknown[] = []
  const annotations: ReplayProse["annotations"] = []
  let parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push(block)
    } else if (block?.type === "text" && typeof block.text === "string") {
      const { text: content, index, ...metadata } = block
      delete metadata.type
      const citations = Array.isArray(metadata.annotations) &&
        metadata.annotations.every((annotation) => annotation?.type === "citation")
        ? metadata.annotations
        : undefined
      if (citations) delete metadata.annotations
      const indexed = preserveTextIndices && typeof index === "number"
      if (indexed || Object.keys(metadata).length > 0) {
        text.push(parts.join("\n"))
        blocks.push({
          type: replayTextBlockMetadata,
          ...(indexed ? { index } : {}),
          metadata
        })
        parts = []
      }
      for (const value of citations ?? []) {
        annotations.push({ span: text.length, block: parts.length, value })
      }
      if (content) parts.push(content)
    } else {
      text.push(parts.join("\n"))
      blocks.push(block)
      parts = []
    }
  }
  text.push(parts.join("\n"))
  return { text, blocks, annotations }
}

function findReplayProseIndexSpan(prose: readonly ReplayProse[]): number {
  const spans = prose[0].text.length
  if (spans === 1) return 0
  let best = 0
  let diversity = 0
  for (let index = 0; index < spans; index++) {
    const size = new Set(prose.map(({ text }) => text[index])).size
    if (size <= diversity) continue
    best = index
    diversity = size
  }
  return best
}

function replayProseLength(prose: ReplayProse): number {
  return prose.text.reduce(
    (length, text) => length + text.length,
    prose.blocks.length + prose.annotations.length
  )
}

function sameAnnotationPrefix(complete: ReplayProse, prefix: ReplayProse): boolean {
  let index = 0
  for (const annotation of prefix.annotations) {
    // A later chunk can add citations to an earlier indexed text block.
    // Preserve ordered prefixes within each block independently.
    while (index < complete.annotations.length) {
      const current = complete.annotations[index]
      if (current.span < annotation.span ||
        (current.span === annotation.span && current.block < annotation.block)) {
        index++
      } else {
        break
      }
    }
    if (!sameValue(annotation, complete.annotations[index])) return false
    index++
  }
  return true
}

function hasReplayProse(content: unknown): content is string | unknown[] {
  return typeof content === "string" || Array.isArray(content)
}

function isReplayContentExtension(candidate: unknown, original: unknown): boolean {
  if (typeof candidate === "string" && typeof original === "string")
    return candidate.length > original.length && candidate.startsWith(original)
  if (!hasReplayProse(candidate) || !hasReplayProse(original)) return false
  const before = readReplayProse(original)
  const after = readReplayProse(candidate)
  return (
    isReplayProseExtension(after, before) ||
    isReplayProseExtension(
      readIndexedReplayProse(candidate, after),
      readIndexedReplayProse(original, before)
    )
  )
}

function isAppendableReplayBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false
  const { type } = block as { type?: unknown }
  return type === "image" || type === "tool_use" || type === "tool_result"
}

function sameReplayBlockPrefix(complete: ReplayProse, prefix: ReplayProse): boolean {
  return (
    prefix.blocks.length <= complete.blocks.length &&
    prefix.blocks.every((block, index) => sameValue(block, complete.blocks[index])) &&
    complete.blocks.slice(prefix.blocks.length).every(isAppendableReplayBlock)
  )
}

function isReplayProseExtension(after: ReplayProse, before: ReplayProse): boolean {
  return (
    replayProseLength(after) > replayProseLength(before) &&
    before.text.length <= after.text.length &&
    before.text.every((part, index) => after.text[index].startsWith(part)) &&
    sameReplayBlockPrefix(after, before) &&
    sameAnnotationPrefix(after, before)
  )
}

function getReplayProseMatch(stored: ReplayProse, source: ReplayProse): number {
  const sourceHasFewerBlocks = source.blocks.length < stored.blocks.length
  if (
    sourceHasFewerBlocks
      ? !sameReplayBlockPrefix(stored, source)
      : !sameReplayBlockPrefix(source, stored)
  ) return 0
  const sourceHasFewerAnnotations = source.annotations.length < stored.annotations.length
  if (
    sourceHasFewerAnnotations
      ? !sameAnnotationPrefix(stored, source)
      : !sameAnnotationPrefix(source, stored)
  ) return 0
  let shorter = sourceHasFewerBlocks || sourceHasFewerAnnotations
  let longer = source.blocks.length > stored.blocks.length ||
    source.annotations.length > stored.annotations.length
  let length = source.annotations.length + source.blocks.length
  let hasStoredText = false
  const spans = Math.min(source.text.length, stored.text.length)
  for (let index = 0; index < spans; index++) {
    const known = stored.text[index].trimEnd()
    const candidate = source.text[index].trimEnd()
    hasStoredText ||= known.length > 0
    if (known.startsWith(candidate)) shorter ||= known.length > candidate.length
    else if (candidate.startsWith(known)) longer = true
    else return 0
    if (shorter && longer) return 0
    length += candidate.length
  }
  if (!length || !hasStoredText) return 0
  // An exact match outranks a continuation. Among prefixes of the stored
  // snapshot, prefer the one that accounts for more of the persisted text.
  return shorter ? length : longer ? Number.MAX_SAFE_INTEGER : Number.POSITIVE_INFINITY
}

function findContestedToolPresentations<T extends TranscriptMessage>(
  replay: readonly T[],
  checkpoint: ReturnType<typeof indexAnchoredExchanges<T>>,
  targets: ReadonlyMap<AnchoredToolExchange<T>, AnchoredToolExchange<T>>,
  rawTurns: ReadonlyMap<string, string>
): ReadonlySet<AnchoredToolExchange<T>> {
  const byPresentation = new Map<string, Array<AnchoredToolSlots<T>>>()
  const key = (exchange: PartialToolExchange<T>, anchor?: T) =>
    JSON.stringify([anchor?.id ?? null, exchangeKey(exchange)])
  const checkpointProse = new Map<T, readonly [ReplayProse, ReplayProse]>()
  const readPersistedProse = (content: unknown) => {
    const normalized = getComparablePersistedMessageContent(content)
    const prose = readReplayProse(normalized)
    return [prose, readIndexedReplayProse(normalized, prose)] as const
  }
  const matchPersistedProse = (
    stored: readonly [ReplayProse, ReplayProse],
    source: readonly [ReplayProse, ReplayProse]
  ) => Math.max(
    getReplayProseMatch(stored[0], source[0]),
    getReplayProseMatch(stored[1], source[1])
  )
  const readCheckpointProse = (assistant: T) => {
    const existing = checkpointProse.get(assistant)
    if (existing) return existing
    // Apply the Values writer's projection only to the evidence. It omits
    // provider-only blocks such as inline reasoning from the durable body.
    const prose = readPersistedProse(extractPersistedMessageContent(assistant.content))
    checkpointProse.set(assistant, prose)
    return prose
  }
  for (const assistant of replay) {
    const exchange = readToolExchangeSlots(assistant, checkpoint.ownership)
    if (!exchange) continue
    const anchor = checkpoint.assistantAnchors.get(assistant.id)
    const indexKey = key(exchange, anchor)
    const claims = byPresentation.get(indexKey) ?? []
    claims.push({ exchange, anchor })
    byPresentation.set(indexKey, claims)
  }
  const contested = new Set<AnchoredToolExchange<T>>()
  for (const [copy, target] of targets) {
    const owner = rawTurns.get(copy.exchange.assistant.id)
    if (
      owner === undefined ||
      !target.hasPhysicalResults ||
      sameExchangeCalls(target.exchange, copy.exchange, true, true)
    )
      continue
    const stored = target.exchange.assistant.content
    const storedProse = readPersistedProse(stored)
    const ownerMatch = matchPersistedProse(storedProse, readCheckpointProse(copy.exchange.assistant))
    const otherClaim = byPresentation.get(key(target.exchange, copy.anchor))?.some((other) => {
      const turn = rawTurns.get(other.exchange.assistant.id)
      return (
        turn !== undefined &&
        turn !== owner &&
        sameReplayAnchor(copy.anchor, other.anchor, true) &&
        sameExchangeCalls(target.exchange, other.exchange, true, false) &&
        (sameValue(stored, other.exchange.assistant.content) ||
          matchPersistedProse(storedProse, readCheckpointProse(other.exchange.assistant)) >
            ownerMatch)
      )
    })
    if (otherClaim) contested.add(copy)
  }
  return contested
}

type CheckpointAlignment<T> = Array<[copy: T, durable: T]>

function reserveCheckpointVersionIds<T extends TranscriptMessage>(
  canonical: readonly T[],
  replay: readonly T[],
  groups: CheckpointAlignment<T>[],
  durable: ReturnType<typeof indexAnchoredExchanges<T>>,
  checkpoint: ReturnType<typeof indexAnchoredExchanges<T>>,
  targets: ReadonlyMap<AnchoredToolExchange<T>, AnchoredToolExchange<T>>,
  checkpointTurns?: CheckpointReplayTurns
): boolean {
  const byId = new Map(replay.map((message) => [message.id, message]))
  const moving = new Set(
    groups.flatMap((group) =>
      group.flatMap(([copy, durable]) => (copy.id !== durable.id ? [copy.id] : []))
    )
  )
  const matchedRows = new Set<T>()
  for (const group of groups) {
    for (const [row] of group) matchedRows.add(row)
  }
  const executionKey = ({ exchange }: AnchoredToolSlots<T>) =>
    JSON.stringify([
      exchangeKey(exchange),
      exchange.results.map((row) => row && resultReplayKey(row))
    ])
  const matchedExecutions = new Set<string>()
  for (const candidate of targets.keys()) {
    if (!candidate.hasPhysicalResults) continue
    matchedExecutions.add(executionKey(candidate))
    matchedRows.add(candidate.exchange.assistant)
    for (const result of candidate.exchange.results) matchedRows.add(result)
  }
  const unmatched = [
    ...[...checkpoint.byPhysicalGroup.values()].flat(),
    ...checkpoint.incomplete
  ].filter(
    ({ exchange }) =>
      !matchedRows.has(exchange.assistant) && byId.get(exchange.assistant.id) === exchange.assistant
  )
  if (!unmatched.length) return false
  const versions = new Set(
    unmatched.flatMap(({ exchange }) => [
      exchange.assistant,
      ...exchange.results.filter((row): row is T => row !== undefined)
    ])
  )
  const canMove = (row: T) =>
    versions.has(row) && !matchedRows.has(row) && !moving.has(row.id) && byId.get(row.id) === row
  if (![...versions].some(canMove)) return false
  const usedIds = new Set<string>()
  const providerOccurrences = new Map<string, number>()
  const reserveId = (message: T) => {
    usedIds.add(message.id)
    const source = getMessageProviderSourceId(message)
    const key = `${message.role}\u0000${source}`
    const occurrence = getMessageProviderOccurrence(message) ?? 1
    providerOccurrences.set(key, Math.max(providerOccurrences.get(key) ?? 1, occurrence))
  }
  canonical.forEach(reserveId)
  const durableOccurrences = new Map(providerOccurrences)
  replay.forEach(reserveId)
  const nextOccurrence = (row: T, role: string, source: string): T => {
    const key = `${role}\u0000${source}`
    let occurrence = (providerOccurrences.get(key) ?? 1) + 1
    let id = buildMessageSameRoleDuplicateId(source, role, occurrence)
    while (usedIds.has(id)) {
      occurrence++
      id = buildMessageSameRoleDuplicateId(source, role, occurrence)
    }
    usedIds.add(id)
    moving.add(row.id)
    providerOccurrences.set(key, occurrence)
    return { ...row, id, provider_source_id: source, provider_occurrence: occurrence }
  }
  for (const rows of groups) {
    const displaced: CheckpointAlignment<T> = []
    for (const [copy, durable] of rows) {
      const blocker = byId.get(durable.id)
      if (!blocker || copy.id === blocker.id || !canMove(blocker)) continue
      const role = blocker.role
      const source = getMessageProviderSourceId(blocker)
      if (!role || role !== durable.role || source !== getMessageProviderSourceId(durable)) continue
      displaced.push([blocker, nextOccurrence(blocker, role, source)])
    }
    rows.push(...displaced)
  }
  const durableById = new Map(canonical.map((message) => [message.id, message]))
  const durableExecutions = new Map<T, AnchoredToolExchange<T>>()
  for (const executions of durable.byPhysicalGroup.values()) {
    for (const execution of executions)
      durableExecutions.set(execution.exchange.assistant, execution)
  }
  // An incoming complete group can be newer than this durable page. Keep it
  // separate from an older bare ID only when the turn or execution proves it.
  let needsDurableTailAnchor = false
  for (const candidate of unmatched) {
    const { assistant, results } = candidate.exchange
    const source = getMessageProviderSourceId(assistant)
    const current = durableById.get(assistant.id)
    const currentExecution = current && durableExecutions.get(current)
    const currentAnchor = current && durable.assistantAnchors.get(current.id)
    const differentTurn =
      currentAnchor &&
      candidate.anchor &&
      (!sameRow(currentAnchor, candidate.anchor, true) ||
        (getMessageProviderOccurrence(currentAnchor) ?? 1) !==
          (getMessageProviderOccurrence(candidate.anchor) ?? 1))
    const earlierHiddenOccurrence =
      checkpointTurns?.hiddenAssistants.has(assistant.id) &&
      assistant.id === source &&
      (durableOccurrences.get(`assistant\u0000${source}`) ?? 1) > 1
    const currentExchange = currentExecution?.exchange
    const differentExecution =
      currentExchange &&
      !(
        sameExchangeCalls(currentExchange, candidate.exchange, true, false) &&
        currentExchange.results.every((row, index) => {
          const peer = results[index]
          return peer && sameRow(row, peer, true)
        })
      )
    const matchedVersionExists = matchedExecutions.has(executionKey(candidate))
    if (!differentTurn && !earlierHiddenOccurrence && !differentExecution && !matchedVersionExists)
      continue
    const changes: CheckpointAlignment<T> = []
    if (
      current &&
      current.role === "assistant" &&
      source === getMessageProviderSourceId(current) &&
      canMove(assistant)
    ) {
      changes.push([assistant, nextOccurrence(assistant, "assistant", source)])
    }
    for (const result of results) {
      if (!result) continue
      const stored = durableById.get(result.id)
      const resultSource = getMessageProviderSourceId(result)
      if (
        stored?.role === "tool" &&
        resultSource === getMessageProviderSourceId(stored) &&
        canMove(result) &&
        !sameRow(stored, result, true)
      ) {
        changes.push([result, nextOccurrence(result, "tool", resultSource)])
      }
    }
    if (changes.length) {
      groups.push(changes)
      if (!candidate.anchor) needsDurableTailAnchor = true
    }
  }
  return needsDurableTailAnchor
}

function applyCheckpointAlignments<T extends TranscriptMessage>(
  replay: T[],
  groups: CheckpointAlignment<T>[]
): T[] {
  if (!groups.length) return replay
  const replayIdCounts = new Map<string, number>()
  for (const { id } of replay) replayIdCounts.set(id, (replayIdCounts.get(id) ?? 0) + 1)
  const movingGroups = new Map<string, number>()
  const destinationGroups = new Map<string, number>()
  const rejected = new Set<number>()
  const dependents = new Map<number, number[]>()
  const reserve = (index: Map<string, number>, id: string, group: number) => {
    const existing = index.get(id)
    if (existing === undefined) index.set(id, group)
    else {
      rejected.add(existing)
      rejected.add(group)
    }
  }
  groups.forEach((rows, group) => {
    for (const [copy, durable] of rows) {
      if (replayIdCounts.get(copy.id) !== 1) rejected.add(group)
      if (copy.id === durable.id) continue
      reserve(movingGroups, copy.id, group)
      reserve(destinationGroups, durable.id, group)
    }
  })
  // A target already in the checkpoint is usable only if another accepted
  // group vacates it. Dropping any group must also drop its dependent moves.
  for (const [id, group] of destinationGroups) {
    if (!replayIdCounts.has(id)) continue
    const vacating = movingGroups.get(id)
    if (vacating === undefined) {
      rejected.add(group)
      continue
    }
    const consumers = dependents.get(vacating) ?? []
    consumers.push(group)
    dependents.set(vacating, consumers)
  }
  for (const group of rejected) {
    for (const dependent of dependents.get(group) ?? []) rejected.add(dependent)
  }
  const aligned = new Map<T, T>()
  groups.forEach((rows, group) => {
    if (rejected.has(group)) return
    for (const [copy, durable] of rows) {
      aligned.set(copy, {
        ...copy,
        id: durable.id,
        provider_source_id: durable.provider_source_id,
        provider_occurrence: durable.provider_occurrence
      })
    }
  })
  return aligned.size ? replay.map((message) => aligned.get(message) ?? message) : replay
}

function projectDurableToolPresentations<T extends TranscriptMessage>(
  durableMessages: readonly T[],
  checkpointMessages: readonly T[],
  durable: ReturnType<typeof indexAnchoredExchanges<T>>,
  targets: ReadonlyMap<AnchoredToolExchange<T>, AnchoredToolExchange<T>>,
  checkpointAliases: ReadonlyMap<string, string>,
  contestedPresentations?: ReadonlySet<AnchoredToolExchange<T>>
): readonly T[] {
  const revisions = [...targets].filter(([candidate, target]) => {
    const key = target.physicalKey
    return (
      key &&
      (contestedPresentations?.has(candidate) ||
        (durable.byPhysicalGroup.get(key)?.length ?? 0) > 1) &&
      !checkpointAliases.has(candidate.exchange.assistant.id) &&
      !isExactToolExchangeReplay(target.exchange, candidate.exchange)
    )
  })
  if (!revisions.length) return durableMessages
  const checkpointById = new Map(checkpointMessages.map((row) => [row.id, row]))
  const ownership = resolveToolResultOwnership(checkpointMessages)
  const projected = new Map<T, T>()
  for (const [candidate, target] of revisions) {
    const assistant = checkpointById.get(target.exchange.assistant.id)
    const updated = assistant && readExchange(assistant, ownership)
    if (!updated || !isSameExchange(candidate.exchange, updated)) continue
    const contested = contestedPresentations?.has(candidate)
    // The persisted outcome belongs to this row. Its prose can belong to a
    // different raw notification when the provider reused the assistant ID.
    const presentation = contested
      ? updated.assistant
      : mergeCheckpointAuthorityTranscriptMessage(updated.assistant, target.exchange.assistant)
    for (const copy of durable.byPhysicalGroup.get(target.physicalKey!) ?? []) {
      if (!isExactToolExchangeReplay(target.exchange, copy.exchange)) continue
      if (contested && !sameReplayAnchor(copy.anchor, target.anchor, true)) continue
      const row = copy.exchange.assistant
      projected.set(row, {
        ...row,
        content: presentation.content,
        reasoning: presentation.reasoning
      })
    }
  }
  return projected.size ? durableMessages.map((row) => projected.get(row) ?? row) : durableMessages
}

/** Both sources can number and render the same completed execution differently. */
export function prepareToolTranscriptReplayMerge<T extends TranscriptMessage>(
  durableRows: readonly T[],
  checkpointRows: T[],
  rawCheckpointTurns?: CheckpointReplayTurns
): { checkpoint: T[]; durable: readonly T[] } {
  const rawAssistantTurns =
    rawCheckpointTurns && indexAssistantTurns(rawCheckpointTurns.rawToolTranscript)
  const keepHiddenToolScope = (rows: T[], sources: readonly T[]): T[] => {
    if (!rawAssistantTurns || !rawCheckpointTurns?.hiddenAssistants.size) return rows
    const visibleTurns = indexAssistantTurns(sources)
    type Declaration = { id: string; rawTurn: string; hidden: boolean }
    const groups = new Map<string, Declaration[]>()
    for (const [index, row] of rows.entries()) {
      if (row.role !== "assistant" || !Array.isArray(row.tool_calls) || !row.tool_calls.length)
        continue
      const sourceId = sources[index].id
      const rawTurn = rawAssistantTurns.get(sourceId)
      if (rawTurn === undefined) continue
      const key = JSON.stringify([
        visibleTurns.get(sourceId),
        getMessageProviderSourceId(row),
        row.tool_calls.map(readToolOwnershipId)
      ])
      const group = groups.get(key) ?? []
      group.push({
        id: row.id,
        rawTurn,
        hidden: rawCheckpointTurns.hiddenAssistants.has(sourceId)
      })
      groups.set(key, group)
    }
    const protectedTurns = new Map<string, string>()
    for (const group of groups.values()) {
      if (
        group.length < 2 ||
        !group.some(({ hidden }) => hidden) ||
        new Set(group.map(({ rawTurn }) => rawTurn)).size < 2
      )
        continue
      // Local partial-result and prose continuations need their original raw
      // turn. Full exact physical replays can still be matched across turns.
      for (const { id, rawTurn } of group) protectedTurns.set(id, rawTurn)
    }
    if (!protectedTurns.size) return rows
    // Keep the raw boundary in memory through ID alignment and final replay
    // proof. A symbol is copied with the row but stays out of saved/exported data.
    return rows.map((row) => {
      const turn = protectedTurns.get(row.id)
      return turn === undefined ? row : { ...row, [checkpointToolTurn]: turn }
    })
  }
  if (!durableRows.length || checkpointRows.length < 2)
    return { checkpoint: keepHiddenToolScope(checkpointRows, checkpointRows), durable: durableRows }
  const repairedDurable = repairLocalResultReplays(durableRows)?.messages ?? durableRows
  const canonical =
    foldInterruptedAndProjectedToolCopies(repairedDurable)?.messages ?? repairedDurable
  const stagedCheckpoint = repairLocalResultReplays(checkpointRows, rawCheckpointTurns)
  let replay = stagedCheckpoint?.messages ?? checkpointRows
  let checkpointTurns = stagedCheckpoint?.checkpointTurns ?? rawCheckpointTurns
  const foldedCheckpoint = foldInterruptedAndProjectedToolCopies(replay, checkpointTurns)
  if (foldedCheckpoint) {
    replay = foldedCheckpoint.messages
    checkpointTurns = foldedCheckpoint.checkpointTurns
  }
  const includeLeadingHidden = Boolean(checkpointTurns?.leadingHiddenAssistants.size)
  const payloadId = createPayloadIds()
  const durable = indexAnchoredExchanges(canonical, payloadId, {
    includeLeadingHidden,
    foldEquivalentTargets: true
  })
  let checkpoint = indexAnchoredExchanges(replay, payloadId, {
    includeLeadingHidden,
    checkpointTurns
  })
  const withoutEarlierCopies = dropEarlierCheckpointCopies(
    replay,
    checkpoint,
    durable,
    checkpointTurns
  )
  if (withoutEarlierCopies) {
    replay = withoutEarlierCopies.messages
    checkpointTurns = withoutEarlierCopies.checkpointTurns
    checkpoint = indexAnchoredExchanges(replay, payloadId, {
      includeLeadingHidden,
      checkpointTurns
    })
  }
  const crossSourceRepair = repairCheckpointFromDurableResults(
    replay,
    checkpoint,
    durable,
    checkpointTurns
  )
  if (crossSourceRepair) {
    replay = crossSourceRepair.messages
    checkpointTurns = crossSourceRepair.checkpointTurns
    checkpoint = indexAnchoredExchanges(replay, payloadId, {
      includeLeadingHidden,
      checkpointTurns
    })
  }
  const reconciledBatches = reconcileCheckpointToolBatches(
    replay,
    checkpoint,
    durable,
    checkpointTurns
  )
  if (reconciledBatches) {
    replay = reconciledBatches.messages
    checkpointTurns = reconciledBatches.checkpointTurns
    const folded = foldInterruptedAndProjectedToolCopies(replay, checkpointTurns)
    if (folded) {
      replay = folded.messages
      checkpointTurns = folded.checkpointTurns
    }
    checkpoint = indexAnchoredExchanges(replay, payloadId, {
      includeLeadingHidden,
      checkpointTurns
    })
  }
  const targets = new Map<AnchoredToolExchange<T>, AnchoredToolExchange<T>>()
  for (const [key, copies] of checkpoint.byAnchor) {
    const possible = durable.byAnchor.get(key) ?? []
    if (!copies[0].hasPhysicalResults && (copies.length !== 1 || possible.length !== 1)) continue
    for (const candidate of copies) {
      const matches = possible.filter(
        (target) =>
          (target.position === candidate.position || hasExecutionIdentity(target.exchange)) &&
          (!candidate.anchor ||
            sameReplayAnchor(target.anchor, candidate.anchor, target.hasPhysicalResults)) &&
          isSameExchange(target.exchange, candidate.exchange, target.hasPhysicalResults)
      )
      const [target] = matches
      if (
        target &&
        (matches.length === 1 ||
          matches.every((match) => isExactToolExchangeReplay(target.exchange, match.exchange)))
      ) {
        targets.set(candidate, target)
        continue
      }
      if (!matches.length && candidate.outcomeKey) {
        const equivalent = durable.byOutcome
          .get(candidate.outcomeKey)
          ?.filter(
            (sameOutcome) =>
              (!candidate.anchor || sameReplayAnchor(sameOutcome.anchor, candidate.anchor, true)) &&
              isSameCompletedExecution(sameOutcome.exchange, candidate.exchange, true)
          )
        if (equivalent?.length === 1) targets.set(candidate, equivalent[0])
      }
    }
  }
  if (rawAssistantTurns) keepDistinctCheckpointTurns(targets, rawAssistantTurns)
  const contestedPresentations =
    rawAssistantTurns && targets.size
      ? findContestedToolPresentations(replay, checkpoint, targets, rawAssistantTurns)
      : undefined
  const checkpointAliases = selectCheckpointReplayAliases(replay, checkpoint, targets)
  const replayWithoutCopies = checkpointAliases.size
    ? replay.filter(({ id }) => !checkpointAliases.has(id))
    : replay
  const supplementalByTarget = new Map<string, CheckpointAlignment<T>>()
  const exactTargets = new Set([...targets.values()].map(({ exchange }) => exchange.assistant.id))
  const retained = new Set(replayWithoutCopies)
  for (const group of reconciledBatches?.alignments ?? []) {
    const [[copy, target]] = group
    if (!retained.has(copy) || exactTargets.has(target.id)) continue
    // The durable row can anchor only one presentation. Other real checkpoint
    // variants still need occurrence reservations of their own.
    supplementalByTarget.set(target.id, group)
  }
  const groups = [...supplementalByTarget.values()]
  const supplementallyAligned = new Set(groups.map(([assistant]) => assistant[0]))
  for (const [candidate, target] of targets) {
    if (
      checkpointAliases.has(candidate.exchange.assistant.id) ||
      supplementallyAligned.has(candidate.exchange.assistant)
    )
      continue
    const rows: CheckpointAlignment<T> = [[candidate.exchange.assistant, target.exchange.assistant]]
    for (const [index, result] of candidate.exchange.results.entries()) {
      rows.push([result, target.exchange.results[index]])
    }
    const changes = rows.filter(
      ([copy, durable]) =>
        copy.id !== durable.id ||
        getMessageProviderOccurrence(copy) !== getMessageProviderOccurrence(durable)
    )
    if (changes.length) groups.push(changes)
  }
  const needsDurableTailAnchor = reserveCheckpointVersionIds(
    canonical,
    replayWithoutCopies,
    groups,
    durable,
    checkpoint,
    targets,
    checkpointTurns
  )
  // Checkpoint copies were validated independently of whether an ID needed a move.
  const alignedRows = applyCheckpointAlignments(replayWithoutCopies, groups)
  let aligned = keepHiddenToolScope(alignedRows, replayWithoutCopies)
  if (needsDurableTailAnchor && alignedRows !== replayWithoutCopies) {
    const durableIds = new Set(canonical.map(({ id }) => id))
    // A newly identified hidden suffix may have no shared row. Give the merge
    // a durable anchor so the suffix cannot jump ahead of earlier messages.
    if (!aligned.some(({ id }) => durableIds.has(id)))
      aligned = [canonical[canonical.length - 1], ...aligned]
  }
  return {
    checkpoint: aligned,
    durable: projectDurableToolPresentations(
      canonical,
      aligned,
      durable,
      targets,
      checkpointAliases,
      contestedPresentations
    )
  }
}

export function alignReplayedToolExchanges<T extends TranscriptMessage>(
  canonical: readonly T[],
  replay: T[],
  checkpointTurns?: CheckpointReplayTurns
): T[] {
  return prepareToolTranscriptReplayMerge(canonical, replay, checkpointTurns).checkpoint
}

interface UnsafeBindings {
  callIds: Set<string>
  invalidResultIds: Set<string>
}

/** Existing tool cards and archives must keep the same results for every surviving call. */
export function preserveReplayToolBindings<T extends TranscriptMessage>(
  messages: readonly T[],
  aliases: ReadonlyMap<string, string>,
  original: ReadonlyMap<string, T> = resolveToolResultOwnership(messages),
  unsafe?: UnsafeBindings
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
  const previouslyOwnedExecutionIds = new Set(
    [...original.values()].filter(hasToolResultExecutionId).map(getMessageProviderSourceId)
  )
  const ownerByResultId = new Map([...original].map(([owner, result]) => [result.id, owner]))
  const earlierResults = historicalToolResults(messages)
  let bindingsPreserved = true
  for (const message of retained) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const [index, call] of message.tool_calls.entries()) {
      const id = readToolOwnershipId(call)
      if (!id) continue
      const key = getWorkerToolUiKey(message.id, id, index)
      const previous = original.get(key)
      const next = after.get(key)
      if (previous === next) continue
      if (previous && next && hasToolResultExecutionId(previous) && sameRow(previous, next))
        continue
      const duplicateOf = previous && aliases.get(previous.id)
      const originalOwner = duplicateOf && ownerByResultId.get(duplicateOf)
      const earlier = duplicateOf ? earlierResults.get(duplicateOf) : undefined
      const matchesHistoricalResult =
        (previous && duplicateOf && historicalReplayId(previous) === duplicateOf) ||
        (earlier &&
          previous &&
          sameRow(earlier, previous) &&
          (getMessageProviderOccurrence(earlier) ?? 1) <
            (getMessageProviderOccurrence(previous) ?? 1))
      const callName = (call as { name?: unknown }).name
      // Bot delivery authorizes a receipt from the persisted batch. Its card
      // must keep displaying that receipt until the batch itself changes.
      const canRebind = Boolean(
        (originalOwner || matchesHistoricalResult) &&
        next &&
        previous &&
        callName !== botFileDeliveryToolName &&
        (!next.name || !callName || next.name === callName) &&
        hasToolResultExecutionId(previous) &&
        hasToolResultExecutionId(next) &&
        !historicalReplayId(next) &&
        !previouslyOwnedExecutionIds.has(getMessageProviderSourceId(next)) &&
        resultReplayKey(previous) !== resultReplayKey(next)
      )
      if (
        canRebind &&
        (matchesHistoricalResult || (originalOwner && after.get(originalOwner)?.id === duplicateOf))
      )
        continue
      if (!unsafe) return noAliases
      bindingsPreserved = false
      unsafe.callIds.add(getRawWorkerToolCallId(id))
      // A displaced canonical owner can recover once a different, invalid
      // proposal is removed. Avoid rejecting that dependent repair first.
      if (!canRebind && previous) unsafe.invalidResultIds.add(previous.id)
    }
  }
  return bindingsPreserved ? aliases : noAliases
}

/** Identify copies using the same result bindings that are used in chat. */
export function findReplayedToolExchangeAliases<T extends TranscriptMessage>(
  messages: readonly T[],
  toolReplayAssistantIds?: Set<string>
): ReadonlyMap<string, string> {
  if (!hasToolReplayCandidates(messages)) return noAliases
  const ownership = resolveToolResultOwnership(messages)
  const owned = new Set(ownership.values())
  const ownedExecutionIds = new Set(
    [...owned].filter(hasToolResultExecutionId).map(getMessageProviderSourceId)
  )
  const { aliases: repairs, disputed } = findReplayedResultRebindings(
    messages,
    ownership,
    owned,
    ownedExecutionIds
  )
  const slotCopies = findToolSlotCopyAliases(
    messages,
    ownership,
    undefined,
    disputed,
    toolReplayAssistantIds
  )
  const aliases = new Map(slotCopies.verified)
  const assistantsById = new Map<string, T>()
  if (aliases.size) {
    for (const row of messages) if (row.role === "assistant") assistantsById.set(row.id, row)
  }
  const assistantContent = getAssistantReplayContent(aliases, (id) => assistantsById.get(id))
  const payloadId = createPayloadIds()
  const assistantProse = new Map<T, ReplayProse>()
  const readAssistantProse = (assistant: T) => {
    const known = assistantProse.get(assistant)
    if (known) return known
    const prose = readReplayProse(assistant.content)
    assistantProse.set(assistant, prose)
    return prose
  }
  const samePhysicalPresentation = (left: T, right: T) =>
    sameValue(left.content, right.content) ||
    (hasReplayProse(left.content) &&
      hasReplayProse(right.content) &&
      sameReplayProse(readAssistantProse(left), readAssistantProse(right)))
  const resultVersionKey = (result: T) => [resultReplayKey(result), payloadId(result.content)]
  const sameTurn = new Map<string, ToolExchange<T>[]>()
  type ObservedPresentation = { exchange: ToolExchange<T>; canonical: ToolExchange<T> }
  const physical = new Map<string, ObservedPresentation[]>()
  const canonicalByPresentation = new Map<string, ToolExchange<T>>()
  const sameAssistantReasoning = (left: ToolExchange<T>, right: ToolExchange<T>) =>
    (left.assistant.reasoning || "") === (right.assistant.reasoning || "")
  const rememberPhysical = (exchange: ToolExchange<T>, canonical: ToolExchange<T>) => {
    const presentation = exchange.assistant
    const presentationKey = typeof presentation.content === "string"
      ? [payloadId(presentation.content)]
      : readAssistantProse(presentation).text.map(payloadId)
    const key = JSON.stringify([
      exchangeKey(exchange),
      presentationKey,
      exchange.results.map(resultVersionKey)
    ])
    return rememberVersion(
      physical,
      key,
      { exchange, canonical },
      (left, right) =>
        sameAssistantReasoning(left.exchange, right.exchange) &&
        samePhysicalPresentation(left.exchange.assistant, right.exchange.assistant) &&
        isSameExchange(left.exchange, right.exchange, false, false)
    ).canonical
  }
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") sameTurn.clear()
    if (aliases.has(message.id)) {
      const presentationId = slotCopies.verified.get(message.id)
      const canonical = presentationId && canonicalByPresentation.get(presentationId)
      if (canonical) {
        const observed = readExchange(message, ownership)
        if (
          observed &&
          !observed.results.some((result) => disputed.has(result)) &&
          sameAssistantReasoning(canonical, observed) &&
          isSameExchange(canonical, observed, false, false)
        ) rememberPhysical(observed, canonical)
      }
      continue
    }
    const batch = readExchange(message, ownership)
    if (!batch || !hasExecutionIdentity(batch)) continue
    // The local copy plan may have already established a distinct continuation.
    // Whole-batch matching must compare that text when it crosses turns.
    const content = assistantContent.get(message.id)
    const exchange =
      content === undefined ? batch : { ...batch, assistant: { ...message, content } }
    const hasPhysicalResults = exchange.results.every(hasToolResultExecutionId)
    toolReplayAssistantIds?.add(message.id)

    // Transport replay can append records after the next visible user turn.
    // Only separately generated result UUIDs support matching across that boundary.
    const previous = hasPhysicalResults
      ? rememberPhysical(exchange, exchange)
      : rememberVersion(
          sameTurn,
          JSON.stringify([
            exchangeKey(exchange),
            payloadId(exchange.assistant.content),
            exchange.results.map(resultVersionKey)
          ]),
          exchange,
          (left, right) => sameAssistantReasoning(left, right) && isSameExchange(left, right)
        )
    const disputedResult = exchange.results.some((result) => disputed.has(result))
    if (hasPhysicalResults && !disputedResult) {
      // Keep the exact presentations already seen for this completed batch.
      // A delayed replay can still carry a draft earlier than its continuation.
      if (content !== undefined) rememberPhysical(batch, previous)
      canonicalByPresentation.set(message.id, previous)
    }
    if (previous.assistant.id === exchange.assistant.id) continue
    // A replay occupying a new call can make the entire assistant look old.
    // Keep that call until the separate physical result can claim its slot.
    if (disputedResult) continue
    aliases.set(exchange.assistant.id, previous.assistant.id)
    for (const [index, result] of exchange.results.entries()) {
      const canonical = previous.results[index]
      if (canonical.id !== result.id) aliases.set(result.id, canonical.id)
    }
  }

  // Compare result identity independently of FIFO: a replay could have already
  // occupied a newer call that happened to reuse the original ID.
  const knownResults = new Map<string, T[]>()
  const duplicateResults = new Map<T, T>()
  const rememberResult = (row: T) => {
    const previous = rememberVersion(
      knownResults,
      JSON.stringify(resultVersionKey(row)),
      row,
      sameRow
    )
    if (previous.id !== row.id) duplicateResults.set(row, previous)
  }
  const repairedTargets = new Set(repairs.values())
  for (const row of historicalToolResults(messages).values()) {
    if (repairedTargets.has(row.id)) rememberResult(row)
  }
  for (const row of owned) {
    if (!hasToolResultExecutionId(row)) continue
    if (!aliases.has(row.id)) rememberResult(row)
  }
  // Prefer a bound result as the canonical row. A delayed genuine result may
  // still be unbound while a replay occupies its receiving call.
  for (const row of messages) {
    if (
      row.role === "tool" &&
      !owned.has(row) &&
      !aliases.has(row.id) &&
      hasToolResultExecutionId(row)
    ) {
      rememberResult(row)
    }
  }
  const callsWithUnownedResults = new Set<string>()
  const attachedDuplicates: AttachedToolReplay[] = []
  // A replacement must arrive after the replay that occupied its call's slot.
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (row.role !== "tool" || aliases.has(row.id) || !hasToolResultExecutionId(row)) continue
    if (row.tool_call_id && !ownedExecutionIds.has(getMessageProviderSourceId(row))) {
      callsWithUnownedResults.add(row.tool_call_id)
    }
    const canonical =
      (historicalReplayId(row) && repairs.get(row.id)) ??
      duplicateResults.get(row)?.id ??
      repairs.get(row.id)
    if (!canonical) continue
    if (!owned.has(row)) {
      aliases.set(row.id, canonical)
      continue
    }
    if (row.tool_call_id && callsWithUnownedResults.has(row.tool_call_id)) {
      attachedDuplicates.push({
        alias: row.id,
        canonical,
        call: getRawWorkerToolCallId(row.tool_call_id)
      })
    }
  }
  const verified = preserveReplayToolBindings(messages, aliases, ownership)
  const selected = selectAttachedReplayAliases(messages, verified, ownership, attachedDuplicates)
  if (![...selected.values()].some((id) => selected.has(id))) return selected
  const canonical = new Map(selected)
  for (const [id, target] of canonical) {
    if (!canonical.has(target)) continue
    const path = new Set([id])
    let end = target
    while (canonical.has(end) && !path.has(end)) {
      path.add(end)
      end = canonical.get(end)!
    }
    if (!path.has(end)) for (const copy of path) canonical.set(copy, end)
  }
  return canonical
}

interface AttachedToolReplay {
  alias: string
  canonical: string
  call: string
}

function selectAttachedReplayAliases<T extends TranscriptMessage>(
  messages: readonly T[],
  verified: ReadonlyMap<string, string>,
  ownership: ReadonlyMap<string, T>,
  proposals: AttachedToolReplay[]
): ReadonlyMap<string, string> {
  // First exclude directly rejected slots, then fall back to independent call
  // IDs for ambiguous shifts. Every retained subset is checked end to end.
  for (let attempt = 0; attempt < 3 && proposals.length; attempt++) {
    const unsafe: UnsafeBindings = { callIds: new Set(), invalidResultIds: new Set() }
    const repaired = preserveReplayToolBindings(
      messages,
      new Map([
        ...verified,
        ...proposals.map(({ alias, canonical }) => [alias, canonical] as const)
      ]),
      ownership,
      unsafe
    )
    if (repaired.size) return repaired
    const precise = proposals.filter(({ alias }) => !unsafe.invalidResultIds.has(alias))
    const remaining =
      precise.length < proposals.length
        ? precise
        : proposals.filter(({ call }) => !unsafe.callIds.has(call))
    if (remaining.length === proposals.length) break
    proposals = remaining
  }
  return verified
}
