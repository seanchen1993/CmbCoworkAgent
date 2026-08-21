import {
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY,
  STREAM_TOOL_CALL_ARGS_MODE_KEY,
  type StreamMessageWireMode
} from "../../shared/stream-message-wire-mode"

const WORKER_SNAPSHOT_INDEX_MESSAGE_KEY = "cmb_worker_snapshot_index"

export interface SerializedStreamData {
  data: unknown
  valuesMessageIndexOffset: number
  valuesSnapshotKind: "full" | "append" | "tail"
}

export type StreamDataSerializer = (mode: string, data: unknown) => SerializedStreamData

export interface StreamMessageProjectionObservation {
  field: "content" | "reasoning" | "tool_args"
  inputCharacters: number
  outputCharacters: number
  comparedCharacters: number
  outputMode: StreamMessageWireMode
}

export interface StreamDataSerializerOptions {
  projectMessageChunks?: boolean
  onMessageProjection?: (observation: StreamMessageProjectionObservation) => void
}

export interface SerializedValuesMessageSnapshot {
  messages: unknown[]
  valuesMessageIndexOffset: number
}

export interface SerializedValuesMessageAccumulator {
  update(serialized: SerializedStreamData): SerializedValuesMessageSnapshot
  clear(): void
}

interface StreamSerializationSnapshot {
  messageCount: number
  currentTurnBoundary: number
  sentinels: Array<{ index: number; message: unknown }>
  tailMessage: unknown
  tail: StreamMessageShape | null
}

interface StreamMessageShape {
  id: string
  role: string
  content: string
  reasoning: string
  hasToolCalls: boolean
}

interface StreamTextProjectionState {
  mode: "empty" | "unknown" | "delta" | "snapshot"
  fragments: string[]
  fragmentLength: number
  snapshot: string
}

interface ActiveStreamMessageProjection {
  providerMessageId?: string
  content: StreamTextProjectionState
  reasoning: StreamTextProjectionState
  toolArgsById: Map<string, StreamTextProjectionState>
  toolCallIdByIndex: Map<number, string>
}

interface StreamMessageProjectionScope {
  active?: ActiveStreamMessageProjection
}

interface ProjectedStreamText {
  value: string
  mode: StreamMessageWireMode
  comparedCharacters: number
}

const REASONING_TEXT_KEYS = [
  "reasoning",
  "reasoning_content",
  "reasoning_text",
  "reasoning_details",
  "summary",
  "details",
  "delta"
] as const
const MAX_MESSAGE_PROJECTION_SCOPES = 128
const PREFIX_SAMPLE_WIDTH = 16
const PREFIX_SAMPLE_COUNT = 5

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function createStreamTextProjectionState(): StreamTextProjectionState {
  return {
    mode: "empty",
    fragments: [],
    fragmentLength: 0,
    snapshot: ""
  }
}

function createActiveStreamMessageProjection(
  providerMessageId?: string
): ActiveStreamMessageProjection {
  return {
    providerMessageId,
    content: createStreamTextProjectionState(),
    reasoning: createStreamTextProjectionState(),
    toolArgsById: new Map(),
    toolCallIdByIndex: new Map()
  }
}

function materializeProjectedText(state: StreamTextProjectionState): string {
  if (state.mode === "snapshot") return state.snapshot
  if (state.fragments.length <= 1) return state.fragments[0] ?? ""
  return state.fragments.join("")
}

function sampledPrefixMatches(previous: string, incoming: string): {
  matches: boolean
  comparedCharacters: number
} {
  if (incoming.length < previous.length) return { matches: false, comparedCharacters: 0 }
  if (previous.length === 0) return { matches: true, comparedCharacters: 0 }

  const maxStart = Math.max(0, previous.length - PREFIX_SAMPLE_WIDTH)
  const starts = new Set<number>([0, maxStart])
  for (let sample = 1; sample < PREFIX_SAMPLE_COUNT - 1; sample += 1) {
    starts.add(Math.min(maxStart, Math.floor((maxStart * sample) / (PREFIX_SAMPLE_COUNT - 1))))
  }

  let comparedCharacters = 0
  for (const start of starts) {
    const end = Math.min(previous.length, start + PREFIX_SAMPLE_WIDTH)
    comparedCharacters += end - start
    if (previous.slice(start, end) !== incoming.slice(start, end)) {
      return { matches: false, comparedCharacters }
    }
  }
  return { matches: true, comparedCharacters }
}

function projectCompleteTextSnapshot(
  state: StreamTextProjectionState,
  incoming: string
): ProjectedStreamText {
  const previous = materializeProjectedText(state)
  const comparedCharacters = Math.min(previous.length, incoming.length)
  let projected: ProjectedStreamText
  if (incoming.length >= previous.length && incoming.startsWith(previous)) {
    projected = {
      value: incoming.slice(previous.length),
      mode: "delta",
      comparedCharacters
    }
  } else {
    projected = { value: incoming, mode: "snapshot", comparedCharacters }
  }
  state.mode = "snapshot"
  state.snapshot = incoming
  state.fragments = []
  state.fragmentLength = 0
  return projected
}

/**
 * Detect cumulative provider frames once, then validate only bounded prefix
 * sentinels. Every newly appended character is serialized exactly once; a
 * rollback or detected rewrite remains an explicit replacement snapshot.
 */
function projectStreamText(
  state: StreamTextProjectionState,
  incoming: string,
  completeSnapshot: boolean
): ProjectedStreamText {
  if (completeSnapshot) return projectCompleteTextSnapshot(state, incoming)

  if (state.mode === "empty") {
    state.mode = "unknown"
    state.fragments.push(incoming)
    state.fragmentLength = incoming.length
    return { value: incoming, mode: "delta", comparedCharacters: 0 }
  }

  if (state.mode === "unknown") {
    const first = state.fragments[0] ?? ""
    const comparedCharacters = Math.min(first.length, incoming.length)
    if (incoming.length >= first.length && incoming.startsWith(first)) {
      state.mode = "snapshot"
      state.snapshot = incoming
      state.fragments = []
      state.fragmentLength = 0
      return {
        value: incoming.slice(first.length),
        mode: "delta",
        comparedCharacters
      }
    }
    state.mode = "delta"
    state.fragments.push(incoming)
    state.fragmentLength += incoming.length
    return { value: incoming, mode: "delta", comparedCharacters }
  }

  if (state.mode === "delta") {
    state.fragments.push(incoming)
    state.fragmentLength += incoming.length
    return { value: incoming, mode: "delta", comparedCharacters: 0 }
  }

  const prefix = sampledPrefixMatches(state.snapshot, incoming)
  if (prefix.matches) {
    const value = incoming.slice(state.snapshot.length)
    state.snapshot = incoming
    return { value, mode: "delta", comparedCharacters: prefix.comparedCharacters }
  }

  state.snapshot = incoming
  return {
    value: incoming,
    mode: "snapshot",
    comparedCharacters: prefix.comparedCharacters
  }
}

function streamMessageProjectionScopeKey(metadata: unknown): string {
  const record = asRecord(metadata)
  const checkpointNamespace =
    typeof record?.langgraph_checkpoint_ns === "string"
      ? record.langgraph_checkpoint_ns
      : typeof record?.checkpoint_ns === "string"
        ? record.checkpoint_ns
        : ""
  const owner =
    typeof record?.cmb_subagent_owner_tool_call_id === "string"
      ? record.cmb_subagent_owner_tool_call_id
      : ""
  return `${checkpointNamespace}\u0000${owner}`
}

function reasoningStringField(kwargs: Record<string, unknown>):
  | { owner: Record<string, unknown>; key: string; value: string }
  | undefined {
  for (const key of REASONING_TEXT_KEYS) {
    if (typeof kwargs[key] === "string") return { owner: kwargs, key, value: kwargs[key] }
  }
  const additionalKwargs = asRecord(kwargs.additional_kwargs)
  if (!additionalKwargs) return undefined
  for (const key of REASONING_TEXT_KEYS) {
    if (typeof additionalKwargs[key] === "string") {
      return { owner: additionalKwargs, key, value: additionalKwargs[key] }
    }
  }
  return undefined
}

function pruneOldestMapEntry<TKey, TValue>(map: Map<TKey, TValue>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as TKey | undefined
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

export function serializedMessageClassName(message: unknown): string {
  const record = asRecord(message)
  if (!record || !Array.isArray(record.id)) return ""
  const last = record.id[record.id.length - 1]
  return typeof last === "string" ? last : ""
}

function isHumanMessage(message: unknown): boolean {
  const record = asRecord(message)
  if (!record) return false
  const kwargs = asRecord(record.kwargs)
  const type = kwargs?.type ?? record.type
  return (
    serializedMessageClassName(message).includes("HumanMessage") ||
    type === "human" ||
    type === "user"
  )
}

function messageRecord(message: unknown): Record<string, unknown> | undefined {
  const record = asRecord(message)
  if (!record) return undefined
  return asRecord(record.kwargs) ?? record
}

function messageRole(message: unknown): string {
  if (isHumanMessage(message)) return "user"
  const record = asRecord(message)
  const values = messageRecord(message)
  const type = values?.type ?? record?.type
  const className =
    serializedMessageClassName(message) ||
    (typeof record?._getType === "function" ? String(record._getType.call(message)) : "") ||
    (message && typeof message === "object"
      ? (message as { constructor?: { name?: string } }).constructor?.name ?? ""
      : "")
  if (type === "tool" || className.toLowerCase().includes("tool")) return "tool"
  if (type === "system" || className.toLowerCase().includes("system")) return "system"
  return "assistant"
}

function messageStringContent(message: unknown): string | null {
  const record = asRecord(message)
  const values = messageRecord(message)
  const content = values?.content ?? record?.content
  return typeof content === "string" ? content : null
}

function messageReasoning(message: unknown): string | null {
  const values = messageRecord(message)
  const additionalKwargs = asRecord(values?.additional_kwargs)
  const reasoning =
    additionalKwargs?.reasoning ??
    additionalKwargs?.reasoning_content ??
    additionalKwargs?.reasoning_text
  if (reasoning === undefined) return ""
  return typeof reasoning === "string" ? reasoning : null
}

function streamMessageShape(message: unknown): StreamMessageShape | null {
  const record = asRecord(message)
  const values = messageRecord(message)
  if (!record || !values) return null
  const rawId = values.id ?? record.id
  const id =
    typeof rawId === "string"
      ? rawId
      : Array.isArray(rawId)
        ? rawId.map(String).join("/")
        : ""
  const content = messageStringContent(message)
  const reasoning = messageReasoning(message)
  if (!id || content === null || reasoning === null) return null
  const toolCalls = values.tool_calls ?? record.tool_calls
  return {
    id,
    role: messageRole(message),
    content,
    reasoning,
    hasToolCalls: Array.isArray(toolCalls) && toolCalls.length > 0
  }
}

function hasUnsafeIncrementalBoundary(message: unknown): boolean {
  const record = asRecord(message)
  const values = messageRecord(message)
  if (!record || !values) return true
  const className =
    serializedMessageClassName(message) ||
    (message && typeof message === "object"
      ? (message as { constructor?: { name?: string } }).constructor?.name ?? ""
      : "")
  return className.toLowerCase().includes("remove") || values.id === "__remove_all__"
}

function createStreamSerializationSnapshot(
  messages: unknown[],
  currentTurnBoundary: number
): StreamSerializationSnapshot {
  const lastIndex = messages.length - 1
  const prefixLastIndex = lastIndex - 1
  const candidateIndexes = new Set<number>()
  if (prefixLastIndex >= currentTurnBoundary) {
    // Validate a bounded but broad set of structural-sharing sentinels. The
    // LangGraph message reducer returns a new array while retaining unchanged
    // message objects, so ordinary append/tail updates stay O(1). Boundaries,
    // evenly-spaced samples, and the recent suffix make reorder/replay/removal
    // snapshots conservatively fall back to a complete current-turn snapshot.
    candidateIndexes.add(currentTurnBoundary)
    for (let sample = 1; sample <= 8; sample += 1) {
      candidateIndexes.add(
        currentTurnBoundary +
          Math.floor(((prefixLastIndex - currentTurnBoundary) * sample) / 8)
      )
    }
    for (let index = Math.max(currentTurnBoundary, prefixLastIndex - 15); index <= prefixLastIndex; index += 1) {
      candidateIndexes.add(index)
    }
  }
  const sentinels = Array.from(candidateIndexes)
    .filter((index) => index >= currentTurnBoundary && index < lastIndex)
    .map((index) => ({ index, message: messages[index] }))
  return {
    messageCount: messages.length,
    currentTurnBoundary,
    sentinels,
    tailMessage: lastIndex >= currentTurnBoundary ? messages[lastIndex] : undefined,
    tail: lastIndex >= currentTurnBoundary ? streamMessageShape(messages[lastIndex]) : null
  }
}

function hasStableStreamPrefix(
  previous: StreamSerializationSnapshot,
  messages: unknown[],
  prefixLength: number
): boolean {
  if (prefixLength < previous.currentTurnBoundary || messages.length < prefixLength) return false
  return previous.sentinels.every(
    ({ index, message }) => index >= prefixLength || messages[index] === message
  )
}

function canSerializeTailOnly(
  previous: StreamSerializationSnapshot,
  messages: unknown[]
): boolean {
  if (
    messages.length !== previous.messageCount ||
    messages.length <= previous.currentTurnBoundary ||
    !hasStableStreamPrefix(previous, messages, messages.length - 1)
  ) {
    return false
  }
  const tail = streamMessageShape(messages.at(-1))
  return Boolean(
    tail &&
      previous.tail &&
      tail.role === "assistant" &&
      !tail.hasToolCalls &&
      tail.id === previous.tail.id &&
      tail.role === previous.tail.role &&
      tail.content.startsWith(previous.tail.content) &&
      tail.reasoning.startsWith(previous.tail.reasoning)
  )
}

function canSerializeAppendedSuffix(
  previous: StreamSerializationSnapshot,
  messages: unknown[]
): boolean {
  if (
    messages.length <= previous.messageCount ||
    !hasStableStreamPrefix(previous, messages, previous.messageCount) ||
    messages[previous.messageCount - 1] !== previous.tailMessage
  ) {
    return false
  }
  for (let index = previous.messageCount; index < messages.length; index += 1) {
    if (isHumanMessage(messages[index]) || hasUnsafeIncrementalBoundary(messages[index])) return false
  }
  return true
}

/**
 * Keep the latest HumanMessage boundary and the messages after it before JSON
 * serialization. Internal stream consumers still see the current user boundary,
 * while an arbitrarily large history prefix is never visited by JSON.stringify.
 */
function projectStreamDataForSerialization(
  mode: string,
  data: unknown
): {
  data: unknown
  valuesMessageIndexOffset: number
  rawMessages?: unknown[]
  currentTurnBoundary?: number
} {
  if (mode !== "values") return { data, valuesMessageIndexOffset: 0 }

  const state = asRecord(data)
  const messages = state?.messages
  if (!state || !Array.isArray(messages)) return { data, valuesMessageIndexOffset: 0 }

  let currentTurnBoundary = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(messages[index])) {
      currentTurnBoundary = index
      break
    }
  }

  if (currentTurnBoundary === 0) return { data, valuesMessageIndexOffset: 0 }
  const projectedState = { ...state }
  projectedState.messages = messages.slice(currentTurnBoundary)
  return {
    data: projectedState,
    valuesMessageIndexOffset: currentTurnBoundary,
    rawMessages: messages,
    currentTurnBoundary
  }
}

function projectMessageChunkForSerialization(
  data: unknown,
  scopes: Map<string, StreamMessageProjectionScope>,
  options: StreamDataSerializerOptions
): unknown {
  if (!Array.isArray(data) || data.length === 0) return data
  const sourceMessage = asRecord(data[0])
  if (!sourceMessage) return data

  // `agent.stream(..., { streamMode: "messages" })` yields live LangChain
  // message instances. Their serializable fields live directly on the
  // instance; the `{ id, kwargs }` envelope only appears after `toJSON()`.
  // Normalize before projection so JSON.stringify never sees the original
  // cumulative instance and invokes its toJSON() after our projection pass.
  const serializedMessage =
    typeof sourceMessage.toJSON === "function" ? sourceMessage.toJSON.call(data[0]) : sourceMessage
  const message = asRecord(serializedMessage)
  const kwargs = asRecord(message?.kwargs)
  if (!message || !kwargs) return data

  const className = serializedMessageClassName(message)
  const messageType = kwargs.type ?? message.type
  const isAssistant =
    className.includes("AIMessage") || messageType === "ai" || messageType === "assistant"
  const scopeKey = streamMessageProjectionScopeKey(data[1])
  let scope = scopes.get(scopeKey)
  if (!scope) {
    scope = {}
    scopes.set(scopeKey, scope)
    pruneOldestMapEntry(scopes, MAX_MESSAGE_PROJECTION_SCOPES)
  }
  if (!isAssistant) {
    scope.active = undefined
    return data
  }

  const providerMessageId = typeof kwargs.id === "string" && kwargs.id ? kwargs.id : undefined
  if (
    !scope.active ||
    (providerMessageId &&
      scope.active.providerMessageId &&
      providerMessageId !== scope.active.providerMessageId)
  ) {
    scope.active = createActiveStreamMessageProjection(providerMessageId)
  } else if (providerMessageId && !scope.active.providerMessageId) {
    scope.active.providerMessageId = providerMessageId
  }

  const active = scope.active
  const completeSnapshot = !className.endsWith("Chunk")
  const projectedMessage = { ...message }
  const projectedKwargs = { ...kwargs }
  projectedMessage.kwargs = projectedKwargs
  const tuple = [projectedMessage, ...data.slice(1)]
  const rawMetadata = asRecord(data[1])
  let projectedMetadata: Record<string, unknown> | undefined
  const setMetadataMode = (key: string, mode: StreamMessageWireMode): void => {
    if (!projectedMetadata) {
      projectedMetadata = { ...rawMetadata }
      if (tuple.length === 1) tuple.push(projectedMetadata)
      else tuple[1] = projectedMetadata
    }
    projectedMetadata[key] = mode
  }
  const observe = (
    field: StreamMessageProjectionObservation["field"],
    input: string,
    projected: ProjectedStreamText
  ): void => {
    options.onMessageProjection?.({
      field,
      inputCharacters: input.length,
      outputCharacters: projected.value.length,
      comparedCharacters: projected.comparedCharacters,
      outputMode: projected.mode
    })
  }

  if (typeof kwargs.content === "string" && (kwargs.content.length > 0 || completeSnapshot)) {
    const projected = projectStreamText(active.content, kwargs.content, completeSnapshot)
    projectedKwargs.content = projected.value
    setMetadataMode(STREAM_MESSAGE_CONTENT_MODE_KEY, projected.mode)
    observe("content", kwargs.content, projected)
  }

  const reasoningField = reasoningStringField(kwargs)
  if (reasoningField && (reasoningField.value.length > 0 || completeSnapshot)) {
    const projected = projectStreamText(active.reasoning, reasoningField.value, completeSnapshot)
    if (reasoningField.owner === kwargs) {
      projectedKwargs[reasoningField.key] = projected.value
    } else {
      projectedKwargs.additional_kwargs = {
        ...asRecord(kwargs.additional_kwargs),
        [reasoningField.key]: projected.value
      }
    }
    setMetadataMode(STREAM_MESSAGE_REASONING_MODE_KEY, projected.mode)
    observe("reasoning", reasoningField.value, projected)
  }

  if (Array.isArray(kwargs.tool_call_chunks)) {
    let projectedToolCallArgs = false
    projectedKwargs.tool_call_chunks = kwargs.tool_call_chunks.map((rawChunk, chunkPosition) => {
      const chunk = asRecord(rawChunk)
      if (!chunk || typeof chunk.args !== "string") return rawChunk
      projectedToolCallArgs = true
      const index = typeof chunk.index === "number" ? chunk.index : undefined
      const explicitId = typeof chunk.id === "string" && chunk.id ? chunk.id : undefined
      if (explicitId && index !== undefined) active.toolCallIdByIndex.set(index, explicitId)
      const resolvedId =
        explicitId ??
        (index !== undefined ? active.toolCallIdByIndex.get(index) : undefined) ??
        `position:${chunkPosition}`
      let state = active.toolArgsById.get(resolvedId)
      if (!state) {
        state = createStreamTextProjectionState()
        active.toolArgsById.set(resolvedId, state)
      }
      const projected = projectStreamText(state, chunk.args, completeSnapshot)
      observe("tool_args", chunk.args, projected)
      return {
        ...chunk,
        args: projected.value,
        [STREAM_TOOL_CALL_ARGS_MODE_KEY]: projected.mode
      }
    })

    // AIMessageChunk.toJSON() derives parsed tool_calls / invalid_tool_calls
    // from tool_call_chunks. Both contain another copy of the same growing
    // argument string, so retaining them would restore quadratic IPC bytes
    // even though tool_call_chunks itself is projected to explicit deltas.
    // Chunk consumers already hydrate completed tool calls from the chunks.
    if (!completeSnapshot && projectedToolCallArgs) {
      delete projectedKwargs.tool_calls
      delete projectedKwargs.invalid_tool_calls
    }
  }

  if (completeSnapshot) scope.active = undefined
  return tuple
}

function serializeProjectedStreamData(
  data: unknown,
  valuesMessageIndexOffset: number,
  valuesSnapshotKind: SerializedStreamData["valuesSnapshotKind"]
): SerializedStreamData {
  return {
    data: JSON.parse(JSON.stringify(data)),
    valuesMessageIndexOffset,
    valuesSnapshotKind
  }
}

/**
 * Convert LangChain message instances into IPC-safe plain data. Values-mode
 * history is projected first so serialization cost follows the live turn, not
 * the lifetime of the thread.
 */
export function serializeStreamData(mode: string, data: unknown): SerializedStreamData {
  const projected = projectStreamDataForSerialization(mode, data)
  return serializeProjectedStreamData(projected.data, projected.valuesMessageIndexOffset, "full")
}

/**
 * Build a serializer scoped to one graph run. After the first values snapshot,
 * ordinary immutable append and assistant-tail growth serialize only the new
 * suffix. Ambiguous structure, task boundaries, identity changes, and content
 * rollback return to the complete current-turn projection.
 */
export function createStreamDataSerializer(
  options: StreamDataSerializerOptions = {}
): StreamDataSerializer {
  let previous: StreamSerializationSnapshot | undefined
  const messageProjectionScopes = new Map<string, StreamMessageProjectionScope>()

  return (mode, data) => {
    if (mode === "messages" && options.projectMessageChunks !== false) {
      return serializeProjectedStreamData(
        projectMessageChunkForSerialization(data, messageProjectionScopes, options),
        0,
        "full"
      )
    }
    if (mode !== "values") {
      return serializeProjectedStreamData(data, 0, "full")
    }

    const state = asRecord(data)
    const messages = state?.messages
    if (!state || !Array.isArray(messages)) {
      previous = undefined
      return serializeProjectedStreamData(data, 0, "full")
    }

    let kind: SerializedStreamData["valuesSnapshotKind"] = "full"
    let messageIndexOffset = 0
    let currentTurnBoundary = 0
    let projectedMessages: unknown[] = messages

    if (previous && canSerializeTailOnly(previous, messages)) {
      kind = "tail"
      currentTurnBoundary = previous.currentTurnBoundary
      messageIndexOffset = messages.length - 1
      projectedMessages = [messages[messages.length - 1]]
    } else if (previous && canSerializeAppendedSuffix(previous, messages)) {
      kind = "append"
      currentTurnBoundary = previous.currentTurnBoundary
      messageIndexOffset = previous.messageCount
      projectedMessages = messages.slice(previous.messageCount)
    } else {
      const projected = projectStreamDataForSerialization(mode, data)
      currentTurnBoundary = projected.currentTurnBoundary ?? 0
      messageIndexOffset = projected.valuesMessageIndexOffset
      projectedMessages =
        asRecord(projected.data)?.messages && Array.isArray(asRecord(projected.data)?.messages)
          ? (asRecord(projected.data)?.messages as unknown[])
          : messages
    }

    const projectedState = { ...state, messages: projectedMessages }
    const serialized = serializeProjectedStreamData(projectedState, messageIndexOffset, kind)
    // Advance only after successful serialization. A throwing getter/toJSON
    // must not poison provenance for the following frame.
    previous = createStreamSerializationSnapshot(messages, currentTurnBoundary)
    return serialized
  }
}

/**
 * Retain one complete, plain current-turn snapshot while its wire payloads are
 * append/tail deltas. The array is mutated in place so bookkeeping stays O(K)
 * over the run rather than copying the accumulated turn on every graph step.
 */
export function createSerializedValuesMessageAccumulator(): SerializedValuesMessageAccumulator {
  let messages: unknown[] = []
  let valuesMessageIndexOffset = 0

  return {
    update(serialized) {
      const incoming = asRecord(serialized.data)?.messages
      if (!Array.isArray(incoming)) {
        if (serialized.valuesSnapshotKind === "full") {
          messages = []
          valuesMessageIndexOffset = serialized.valuesMessageIndexOffset
        }
        return { messages, valuesMessageIndexOffset }
      }

      if (serialized.valuesSnapshotKind === "full") {
        messages = incoming
        valuesMessageIndexOffset = serialized.valuesMessageIndexOffset
      } else if (
        serialized.valuesSnapshotKind === "append" &&
        serialized.valuesMessageIndexOffset === valuesMessageIndexOffset + messages.length
      ) {
        messages.push(...incoming)
      } else if (
        serialized.valuesSnapshotKind === "tail" &&
        incoming.length === 1 &&
        serialized.valuesMessageIndexOffset >= valuesMessageIndexOffset &&
        serialized.valuesMessageIndexOffset < valuesMessageIndexOffset + messages.length
      ) {
        messages[serialized.valuesMessageIndexOffset - valuesMessageIndexOffset] = incoming[0]
      } else {
        // A provenance mismatch should only be possible when a caller mixes
        // serializers. Keep the available snapshot bounded and deterministic;
        // the next conservative full frame restores completeness.
        messages = incoming
        valuesMessageIndexOffset = serialized.valuesMessageIndexOffset
      }
      return { messages, valuesMessageIndexOffset }
    },
    clear() {
      messages = []
      valuesMessageIndexOffset = 0
    }
  }
}

function annotateWorkerSnapshotIndexForRenderer(message: unknown, index: number): unknown {
  const record = asRecord(message)
  if (!record) return message
  const kwargs = asRecord(record.kwargs) ?? {}
  const additionalKwargs = asRecord(kwargs.additional_kwargs) ?? {}
  return {
    ...record,
    kwargs: {
      ...kwargs,
      additional_kwargs: {
        ...additionalKwargs,
        [WORKER_SNAPSHOT_INDEX_MESSAGE_KEY]: index
      }
    }
  }
}

function sanitizeValuesMessagesForRenderer(
  messages: unknown,
  valuesMessageIndexOffset: number
): unknown[] | undefined {
  if (!Array.isArray(messages)) return undefined

  let currentTurnStart = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(messages[index])) {
      currentTurnStart = index + 1
      break
    }
  }

  const currentTurnMessages = messages
    .slice(currentTurnStart)
    .map((message, offset) =>
      annotateWorkerSnapshotIndexForRenderer(
        message,
        valuesMessageIndexOffset + currentTurnStart + offset
      )
    )
  return currentTurnMessages.length > 0 ? currentTurnMessages : undefined
}

export function sanitizeStreamDataForRenderer(
  mode: string,
  payload: unknown,
  valuesMessageIndexOffset = 0
): unknown {
  if (mode !== "values" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload
  }

  const { messages, ...rest } = payload as Record<string, unknown>
  const currentTurnMessages = sanitizeValuesMessagesForRenderer(messages, valuesMessageIndexOffset)
  if (currentTurnMessages) {
    return { ...rest, messages: currentTurnMessages }
  }
  return rest
}
