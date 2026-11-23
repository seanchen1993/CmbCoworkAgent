import { parseBotToolReceiptId } from "./bots/turn-feedback"
import type {
  CheckpointAuthorityTranscriptMessage,
  CheckpointReplayTurns
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

interface AnchoredToolExchange<T> {
  exchange: ToolExchange<T>
  position: number
  anchor?: T
  hasPhysicalResults: boolean
}

const noAliases: ReadonlyMap<string, string> = new Map()
const toolResultUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const langGraphToolResultPrefix =
  /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-tool-/i
const generatedAssistantId = /^current-run-assistant:[0-9a-f-]{36}$/i
const botFileDeliveryToolName = "bot_deliver_files"

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
    // File authorization addresses the exact persisted assistant batch by ID.
    // A reconstructed transcript cannot establish that another batch is usable.
    if (call.name === botFileDeliveryToolName) return
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

function sameRow(
  left: TranscriptMessage,
  right: TranscriptMessage,
  checkpointScopeMayBeMissing = false
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
    sameValue(left.content, right.content) &&
    (!left.reasoning || !right.reasoning || left.reasoning === right.reasoning)
  )
}

function isSameExchange(
  left: ToolExchange<TranscriptMessage>,
  right: ToolExchange<TranscriptMessage>,
  checkpointScopeMayBeMissing = false
): boolean {
  return (
    sameRow(left.assistant, right.assistant, checkpointScopeMayBeMissing) &&
    left.calls.length === right.calls.length &&
    left.calls.every(
      (call, index) =>
        call.id === right.calls[index].id &&
        call.name === right.calls[index].name &&
        sameValue(call.args, right.calls[index].args) &&
        sameRow(left.results[index], right.results[index], checkpointScopeMayBeMissing)
    )
  )
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

function exchangeKey(exchange: ToolExchange<TranscriptMessage>): string {
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
  exchange: ToolExchange<TranscriptMessage>,
  turns: CheckpointReplayTurns
): boolean {
  return (
    turns.uniqueMessageIds.has(exchange.assistant.id) &&
    exchange.results.every(
      (result, index) =>
        turns.uniqueMessageIds.has(result.id) &&
        turns.rawResultByCall.get(
          getWorkerToolUiKey(exchange.assistant.id, exchange.calls[index].id, index)
        ) === result.id
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
    const key = resultReplayKey(message)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
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
  const assistantAnchors = new Map<string, T | undefined>()
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
    candidate: AnchoredToolExchange<T>
  ) => {
    const key = JSON.stringify([scope, ...evidence])
    if (
      foldEquivalentTargets &&
      candidate.hasPhysicalResults &&
      byAnchor
        .get(key)
        ?.some(
          (previous) =>
            isExactToolExchangeReplay(previous.exchange, candidate.exchange) &&
            (scope === null ||
              previous.anchor === candidate.anchor ||
              (previous.anchor &&
                candidate.anchor &&
                sameRow(previous.anchor, candidate.anchor) &&
                (getMessageProviderOccurrence(previous.anchor) ?? 1) ===
                  (getMessageProviderOccurrence(candidate.anchor) ?? 1)))
        )
    )
      return
    addCandidate(byAnchor, key, candidate)
  }
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      anchor = message.role === "user" ? message : undefined
      position = 0
      continue
    }
    if (message.role !== "assistant") continue
    assistantAnchors.set(message.id, assistantAnchors.has(message.id) ? undefined : anchor)
    if (!anchor && !includeLeadingHidden) continue
    const exchange = readExchange(message, ownership)
    if (exchange) {
      const hasPhysicalResults = exchange.results.every(hasToolResultExecutionId)
      const evidenceKey = [
        exchangeKey(exchange),
        hasPhysicalResults
          ? [
              payloadId(exchange.assistant.content),
              exchange.results.map((result) => [resultReplayKey(result), payloadId(result.content)])
            ]
          : null
      ]
      const candidate = { exchange, position, anchor, hasPhysicalResults }
      const requiresRawProof =
        checkpointTurns && (!anchor || checkpointTurns.hiddenAnchors.has(anchor.id))
      const unsafe =
        requiresRawProof &&
        (!hasPhysicalResults || !hasRawCheckpointToolBindings(exchange, checkpointTurns))
      if (!unsafe) {
        if (anchor) addAnchoredCandidate(anchor.id, evidenceKey, candidate)
        if (
          includeLeadingHidden &&
          hasPhysicalResults &&
          (!checkpointTurns || (!anchor && checkpointTurns.leadingHiddenAssistants.has(message.id)))
        ) {
          addAnchoredCandidate(null, evidenceKey, candidate)
        }
        if (hasPhysicalResults)
          addCandidate(byPhysicalGroup, JSON.stringify(evidenceKey), candidate)
      }
    }
    position++
  }
  return { byAnchor, byPhysicalGroup, ownership, assistantAnchors }
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
      if (!targets.has(candidate) || handled.has(candidate)) continue
      const equivalent = copies.filter(
        (copy) =>
          copy !== candidate &&
          !handled.has(copy) &&
          isExactToolExchangeReplay(candidate.exchange, copy.exchange)
      )
      if (!equivalent.length) continue
      const aliases: Array<[string, string]> = []
      handled.add(candidate)
      for (const { exchange } of equivalent) {
        if (exchange.assistant.id === candidate.exchange.assistant.id) continue
        aliases.push([exchange.assistant.id, candidate.exchange.assistant.id])
        exchange.results.forEach(({ id }, index) => {
          const retained = candidate.exchange.results[index].id
          if (id !== retained) aliases.push([id, retained])
        })
      }
      for (const copy of equivalent) handled.add(copy)
      if (aliases.length)
        groups.push({
          ids: candidate.exchange.calls.map(({ id }) => getRawWorkerToolCallId(id)),
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
  const executionKey = ({ exchange }: AnchoredToolExchange<T>) =>
    JSON.stringify([exchangeKey(exchange), exchange.results.map(resultReplayKey)])
  const matchedExecutions = new Set<string>()
  for (const candidate of targets.keys()) {
    if (!candidate.hasPhysicalResults) continue
    matchedExecutions.add(executionKey(candidate))
    matchedRows.add(candidate.exchange.assistant)
    for (const result of candidate.exchange.results) matchedRows.add(result)
  }
  const unmatched = [...checkpoint.byPhysicalGroup.values()]
    .flat()
    .filter(
      ({ exchange }) =>
        !matchedRows.has(exchange.assistant) &&
        byId.get(exchange.assistant.id) === exchange.assistant
    )
  if (!unmatched.length) return false
  const versions = new Set(
    unmatched.flatMap(({ exchange }) => [exchange.assistant, ...exchange.results])
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
    const differentExecution =
      currentExecution && !isSameExchange(currentExecution.exchange, candidate.exchange, true)
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

/** A checkpoint and durable page may number the same complete exchange differently. */
export function alignReplayedToolExchanges<T extends TranscriptMessage>(
  canonical: readonly T[],
  replay: T[],
  checkpointTurns?: CheckpointReplayTurns
): T[] {
  const includeLeadingHidden = Boolean(checkpointTurns?.leadingHiddenAssistants.size)
  if (!canonical.length || replay.length < 2) return replay
  const payloadId = createPayloadIds()
  const durable = indexAnchoredExchanges(canonical, payloadId, {
    includeLeadingHidden,
    foldEquivalentTargets: true
  })
  const checkpoint = indexAnchoredExchanges(replay, payloadId, {
    includeLeadingHidden,
    checkpointTurns
  })
  const targets = new Map<AnchoredToolExchange<T>, AnchoredToolExchange<T>>()
  for (const [key, copies] of checkpoint.byAnchor) {
    const possible = durable.byAnchor.get(key)
    if (
      !possible ||
      (!copies[0].hasPhysicalResults && (copies.length !== 1 || possible.length !== 1))
    )
      continue
    for (const candidate of copies) {
      const matches = possible.filter(
        (target) =>
          (target.position === candidate.position || hasExecutionIdentity(target.exchange)) &&
          (!candidate.anchor ||
            (target.anchor &&
              sameRow(target.anchor, candidate.anchor, target.hasPhysicalResults) &&
              (getMessageProviderOccurrence(target.anchor) ?? 1) ===
                (getMessageProviderOccurrence(candidate.anchor) ?? 1))) &&
          isSameExchange(target.exchange, candidate.exchange, target.hasPhysicalResults)
      )
      const [target] = matches
      if (
        target &&
        (matches.length === 1 ||
          matches.every((match) => isExactToolExchangeReplay(target.exchange, match.exchange)))
      )
        targets.set(candidate, target)
    }
  }
  const checkpointAliases = selectCheckpointReplayAliases(replay, checkpoint, targets)
  const replayWithoutCopies = checkpointAliases.size
    ? replay.filter(({ id }) => !checkpointAliases.has(id))
    : replay
  const groups: CheckpointAlignment<T>[] = []
  for (const [candidate, target] of targets) {
    if (checkpointAliases.has(candidate.exchange.assistant.id)) continue
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
  const aligned = applyCheckpointAlignments(replayWithoutCopies, groups)
  if (needsDurableTailAnchor && aligned !== replayWithoutCopies) {
    const durableIds = new Set(canonical.map(({ id }) => id))
    // A newly identified hidden suffix may have no shared row. Give the merge
    // a durable anchor so the suffix cannot jump ahead of earlier messages.
    if (!aligned.some(({ id }) => durableIds.has(id)))
      return [canonical[canonical.length - 1], ...aligned]
  }
  return aligned
}

interface UnsafeBindings {
  callIds: Set<string>
  invalidResultIds: Set<string>
}

/** Existing tool cards and archives must keep the same results for every surviving call. */
export function preserveReplayToolBindings<T extends TranscriptMessage>(
  messages: readonly T[],
  aliases: ReadonlyMap<string, string>,
  original = resolveToolResultOwnership(messages),
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
      const callName = (call as { name?: unknown }).name
      // Bot delivery authorizes a receipt from the persisted batch. Its card
      // must keep displaying that receipt until the batch itself changes.
      const canRebind = Boolean(
        originalOwner &&
        next &&
        previous &&
        callName !== botFileDeliveryToolName &&
        (!next.name || !callName || next.name === callName) &&
        hasToolResultExecutionId(previous) &&
        hasToolResultExecutionId(next) &&
        !previouslyOwnedExecutionIds.has(getMessageProviderSourceId(next)) &&
        resultReplayKey(previous) !== resultReplayKey(next)
      )
      if (canRebind && originalOwner && after.get(originalOwner)?.id === duplicateOf) continue
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
  completedAssistantIds?: Set<string>
): ReadonlyMap<string, string> {
  if (!hasToolReplayCandidates(messages)) return noAliases
  const ownership = resolveToolResultOwnership(messages)
  const aliases = new Map<string, string>()
  const payloadId = createPayloadIds()
  const resultVersionKey = (result: T) => [resultReplayKey(result), payloadId(result.content)]
  const sameTurn = new Map<string, ToolExchange<T>[]>()
  const physical = new Map<string, ToolExchange<T>[]>()
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") sameTurn.clear()
    const exchange = readExchange(message, ownership)
    if (!exchange || !hasExecutionIdentity(exchange)) continue
    const hasPhysicalResults = exchange.results.every(hasToolResultExecutionId)
    completedAssistantIds?.add(message.id)

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
    aliases.set(exchange.assistant.id, previous.assistant.id)
    for (const [index, result] of exchange.results.entries()) {
      const canonical = previous.results[index]
      if (canonical.id !== result.id) aliases.set(result.id, canonical.id)
    }
  }

  // Compare result identity independently of FIFO: a replay could have already
  // occupied a newer call that happened to reuse the original ID.
  const owned = new Set(ownership.values())
  const ownedExecutionIds = new Set<string>()
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
  for (const row of owned) {
    if (!hasToolResultExecutionId(row)) continue
    ownedExecutionIds.add(getMessageProviderSourceId(row))
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
  const attachedDuplicates: Array<{ alias: string; canonical: string; call: string }> = []
  // A replacement must arrive after the replay that occupied its call's slot.
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (row.role !== "tool" || aliases.has(row.id) || !hasToolResultExecutionId(row)) continue
    if (row.tool_call_id && !ownedExecutionIds.has(getMessageProviderSourceId(row))) {
      callsWithUnownedResults.add(row.tool_call_id)
    }
    const original = duplicateResults.get(row)
    if (!original) continue
    if (!owned.has(row)) {
      aliases.set(row.id, original.id)
      continue
    }
    if (row.tool_call_id && callsWithUnownedResults.has(row.tool_call_id)) {
      attachedDuplicates.push({
        alias: row.id,
        canonical: original.id,
        call: getRawWorkerToolCallId(row.tool_call_id)
      })
    }
  }
  const verified = preserveReplayToolBindings(messages, aliases, ownership)
  let proposals = attachedDuplicates
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
