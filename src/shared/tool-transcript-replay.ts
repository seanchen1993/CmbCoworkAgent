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

export function getAssistantReplayContent(
  aliases: ReadonlyMap<string, string>,
  read: (id: string) => TranscriptMessage | undefined
): ReadonlyMap<string, string> {
  const content = new Map<string, string>()
  for (const [id, canonicalId] of aliases) {
    const copy = read(id)
    if (copy?.role !== "assistant" || typeof copy.content !== "string") continue
    const canonical = read(canonicalId)
    const current = content.get(canonicalId) ?? canonical?.content
    if (
      canonical?.role === "assistant" &&
      typeof current === "string" &&
      copy.content.length > current.length &&
      copy.content.startsWith(current)
    ) {
      content.set(canonicalId, copy.content)
    }
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
  const rawTurnByAssistant = new Map<string, number>()
  let turn = 0
  for (const row of rawRows) {
    if (row.role === "user" || row.role === "system") turn++
    if (row.role === "assistant") rawTurnByAssistant.set(row.id, turn)
  }
  const assistantTextKey = (row: T) =>
    `${rawTurnByAssistant.get(row.id)}\u0000${getMessageProviderSourceId(row)}`
  const firstText = new Map<string, string>()
  const hasDifferentText = new Set<string>()
  for (const assistant of messages) {
    if (
      assistant.role !== "assistant" ||
      typeof assistant.content !== "string" ||
      !assistant.tool_calls?.length
    )
      continue
    const key = assistantTextKey(assistant)
    const existing = firstText.get(key)
    if (existing === undefined) firstText.set(key, assistant.content)
    else if (existing !== assistant.content) hasDifferentText.add(key)
  }

  const payloadId = createPayloadIds()
  type SlotVersion = { batch: PartialToolExchange<T>; keys: string[]; complete: boolean }
  const versions = new Map<string, SlotVersion[]>()
  const observed = new Map<string, Map<number, SlotVersion[]>>()
  const completeTextVersions = new Map<
    string,
    Array<{ batch: PartialToolExchange<T>; text: string }>
  >()
  const completeOrder = new Map<PartialToolExchange<T>, number>()
  const exactCopies = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const exactSingleToolCopies = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const extendedText = (candidate: T, original: T) =>
    typeof candidate.content === "string" &&
    typeof original.content === "string" &&
    candidate.content.length > original.content.length &&
    candidate.content.startsWith(original.content)
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
    const scopeKey = [scope, exchangeKey(batch)]
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
    const version = { batch, keys, complete: full }
    const original = rememberVersion(
      versions,
      JSON.stringify([payloadId(assistant.content), ...keys]),
      version,
      (left, right) => exactSlots(left.batch, right.batch, true)
    )
    if (original !== version) {
      ;(plainSingleTool ? exactSingleToolCopies : exactCopies).set(batch, original.batch)
      continue
    }
    if (full && typeof assistant.content === "string") {
      completeOrder.set(batch, position)
      const outcome = JSON.stringify(keys)
      const complete = completeTextVersions.get(outcome) ?? []
      complete.push({ batch, text: assistant.content })
      completeTextVersions.set(outcome, complete)
    }
    for (const key of keys) {
      const byResultCount = observed.get(key) ?? new Map<number, SlotVersion[]>()
      const sharingResult = byResultCount.get(keys.length) ?? []
      sharingResult.push(version)
      byResultCount.set(keys.length, sharingResult)
      observed.set(key, byResultCount)
    }
  }

  // A partial replay can point to a more complete recording of the same
  // batch. Every occupied slot must agree and the target must be unique.
  const containing = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  for (const variants of completeTextVersions.values()) {
    if (variants.length < 2) continue
    variants.sort((left, right) => (left.text < right.text ? -1 : Number(left.text > right.text)))
    const prefixes: typeof variants = []
    for (const variant of variants) {
      while (prefixes.length && !variant.text.startsWith(prefixes.at(-1)!.text)) prefixes.pop()
      const previous = prefixes.findLast(
        ({ batch, text }) => text !== variant.text && exactSlots(variant.batch, batch, false)
      )
      if (previous) containing.set(variant.batch, containing.get(previous.batch) ?? previous.batch)
      prefixes.push(variant)
    }
  }
  const samePresentation = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  const partials = [...versions.values()]
    .flat()
    .filter((version) => !version.complete)
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
    for (const group of candidates.groups) {
      for (const candidate of group) {
        const sameVersion = samePresentation.get(candidate.batch) ?? candidate.batch
        const retained = exactPresentation
          ? sameVersion
          : (containing.get(sameVersion) ?? sameVersion)
        const revised =
          !exactPresentation && extendedText(version.batch.assistant, retained.assistant)
        if (
          (!exactPresentation &&
            !revised &&
            !sameValue(retained.assistant.content, version.batch.assistant.content) &&
            !extendedText(retained.assistant, version.batch.assistant)) ||
          !exactSlots(version.batch, retained, exactPresentation)
        )
          continue
        if (target && retained !== target) return undefined
        target = retained
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

  // Independent revisions can extend the same prefix without extending one
  // another. Keep those presentations and the original result owner.
  const longestPresentation = new Map<PartialToolExchange<T>, T>()
  const divergentPresentations = new Set<PartialToolExchange<T>>()
  for (const [copy, original] of containing) {
    const longest = longestPresentation.get(original) ?? original.assistant
    if (extendedText(copy.assistant, longest)) longestPresentation.set(original, copy.assistant)
    else if (
      !sameValue(copy.assistant.content, longest.content) &&
      !extendedText(longest, copy.assistant)
    ) {
      divergentPresentations.add(original)
    }
  }
  for (const [copy, original] of containing) {
    if (
      divergentPresentations.has(original) &&
      !sameValue(copy.assistant.content, original.assistant.content)
    ) {
      containing.delete(copy)
    }
  }
  // Prefixes establish which presentations agree. The first complete row
  // keeps its chronology and bindings even if a shorter copy arrived later.
  const firstCompleteByGroup = new Map<PartialToolExchange<T>, PartialToolExchange<T>>()
  for (const [copy, original] of containing) {
    const position = completeOrder.get(copy)
    if (position === undefined) continue
    const first = firstCompleteByGroup.get(original) ?? original
    if (position < (completeOrder.get(first) ?? Infinity)) firstCompleteByGroup.set(original, copy)
  }
  for (const [copy, original] of containing) {
    const first = firstCompleteByGroup.get(original)
    if (!first) continue
    if (first === copy) containing.delete(copy)
    else containing.set(copy, first)
  }
  for (const [original, first] of firstCompleteByGroup) containing.set(original, first)

  // Rejected cross-presentation transitions leave the proved continuity
  // inside each unchanged presentation intact.
  for (const [copy, original] of samePresentation) {
    containing.set(copy, containing.get(original) ?? original)
  }
  const withVerifiedText = new Set([...containing].flat())
  for (const [copy, original] of exactSingleToolCopies) {
    if (withVerifiedText.has(original)) exactCopies.set(copy, original)
  }

  const proposed = new Map<string, string>()
  const removedCallKeys = new Map<string, string[]>()
  for (const [copy, original] of [...containing, ...exactCopies]) {
    const retained = containing.get(original) ?? original
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
          prior.content &&
          result.content.startsWith(prior.content)
        ) {
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
      if (corroborated && slots.some(({ observed }) => observed)) {
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
  checkpointAliases: ReadonlyMap<string, string>
): readonly T[] {
  const revisions = [...targets].filter(([candidate, target]) => {
    const key = target.physicalKey
    return (
      key &&
      (durable.byPhysicalGroup.get(key)?.length ?? 0) > 1 &&
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
    const presentation = mergeCheckpointAuthorityTranscriptMessage(
      updated.assistant,
      target.exchange.assistant
    )
    for (const copy of durable.byPhysicalGroup.get(target.physicalKey!) ?? []) {
      if (!isExactToolExchangeReplay(target.exchange, copy.exchange)) continue
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
  if (!durableRows.length || checkpointRows.length < 2)
    return { checkpoint: checkpointRows, durable: durableRows }
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
  let aligned = applyCheckpointAlignments(replayWithoutCopies, groups)
  if (needsDurableTailAnchor && aligned !== replayWithoutCopies) {
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
      checkpointAliases
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
  const payloadId = createPayloadIds()
  const resultVersionKey = (result: T) => [resultReplayKey(result), payloadId(result.content)]
  const sameTurn = new Map<string, ToolExchange<T>[]>()
  const physical = new Map<string, ToolExchange<T>[]>()
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") sameTurn.clear()
    if (aliases.has(message.id)) continue
    const exchange = readExchange(message, ownership)
    if (!exchange || !hasExecutionIdentity(exchange)) continue
    const hasPhysicalResults = exchange.results.every(hasToolResultExecutionId)
    toolReplayAssistantIds?.add(message.id)

    // Transport replay can append records after the next visible user turn.
    // Only separately generated result UUIDs support matching across that boundary.
    const index = hasPhysicalResults ? physical : sameTurn
    const key = JSON.stringify([
      exchangeKey(exchange),
      payloadId(exchange.assistant.content),
      exchange.results.map(resultVersionKey)
    ])
    const previous = rememberVersion(
      index,
      key,
      exchange,
      (left, right) =>
        (left.assistant.reasoning || "") === (right.assistant.reasoning || "") &&
        isSameExchange(left, right)
    )
    if (previous.assistant.id === exchange.assistant.id) continue
    // A replay occupying a new call can make the entire assistant look old.
    // Keep that call until the separate physical result can claim its slot.
    if (exchange.results.some((result) => disputed.has(result))) continue
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
