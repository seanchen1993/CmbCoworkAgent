export interface StreamToolCallSnapshot {
  id: string
  name?: string
  args?: Record<string, unknown>
}

export interface StreamToolCallChunk {
  id?: string
  name?: string
  args?: string
  index?: number
  contentMode: "delta" | "snapshot" | "auto"
}

interface AccumulatedToolCall {
  id: string
  name: string
  argsText: string
  args?: Record<string, unknown>
  jsonState: JsonStructureState
  parsedArgsTextLength?: number
}

export interface StreamToolCallAccumulatorState {
  /**
   * Legacy seed buffers kept for structural compatibility with existing callers.
   * `accumulateStreamToolCallChunks` drains them once and retains only compact
   * per-tool state internally, so these arrays no longer grow with the stream.
   */
  snapshots: StreamToolCallSnapshot[]
  chunks: StreamToolCallChunk[]
}

interface JsonStructureState {
  depth: number
  inString: boolean
  escaped: boolean
  started: boolean
  complete: boolean
  invalid: boolean
}

interface IncrementalToolCallState {
  callsById: Map<string, AccumulatedToolCall>
  callIdByIndex: Map<number, string>
}

const incrementalAccumulatorStates = new WeakMap<
  StreamToolCallAccumulatorState,
  IncrementalToolCallState
>()

export function streamToolCallContentModeFromMessageMode(
  messageMode: "delta" | "snapshot"
): StreamToolCallChunk["contentMode"] {
  // AIMessageChunk identifies message-content semantics, not whether a provider
  // emits tool args as deltas or cumulative chunks. Keep that case ambiguous.
  return messageMode === "snapshot" ? "snapshot" : "auto"
}

function hasUsefulArgs(args: unknown): args is Record<string, unknown> {
  return !!args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length > 0
}

function createJsonStructureState(): JsonStructureState {
  return {
    depth: 0,
    inString: false,
    escaped: false,
    started: false,
    complete: false,
    invalid: false
  }
}

/**
 * Track just enough JSON structure to know when parsing can possibly succeed.
 * Large tool arguments commonly arrive one small fragment at a time. Calling
 * JSON.parse after every fragment scans the whole accumulated string and turns
 * a large write_file/edit_file call into quadratic main-process work.
 */
function scanJsonStructure(state: JsonStructureState, fragment: string): void {
  for (const character of fragment) {
    if (state.invalid) return

    if (state.complete) {
      if (!/\s/.test(character)) state.invalid = true
      continue
    }

    if (!state.started) {
      if (/\s/.test(character)) continue
      if (character !== "{" && character !== "[") {
        state.invalid = true
        continue
      }
      state.started = true
      state.depth = 1
      continue
    }

    if (state.inString) {
      if (state.escaped) {
        state.escaped = false
      } else if (character === "\\") {
        state.escaped = true
      } else if (character === '"') {
        state.inString = false
      }
      continue
    }

    if (character === '"') {
      state.inString = true
    } else if (character === "{" || character === "[") {
      state.depth += 1
    } else if (character === "}" || character === "]") {
      state.depth -= 1
      if (state.depth < 0) {
        state.invalid = true
      } else if (state.depth === 0) {
        state.complete = true
      }
    }
  }
}

function createAccumulatedToolCall(id: string, name: string = ""): AccumulatedToolCall {
  return {
    id,
    name,
    argsText: "",
    jsonState: createJsonStructureState()
  }
}

function replaceArgsText(call: AccumulatedToolCall, argsText: string): void {
  call.argsText = argsText
  call.jsonState = createJsonStructureState()
  call.parsedArgsTextLength = undefined
  scanJsonStructure(call.jsonState, argsText)
}

function appendArgsText(call: AccumulatedToolCall, fragment: string): void {
  call.argsText = appendStreamToolCallArgs(call.argsText, fragment)
  scanJsonStructure(call.jsonState, fragment)
}

function applyArgsChunk(call: AccumulatedToolCall, chunk: StreamToolCallChunk): void {
  if (typeof chunk.args !== "string" || chunk.args.length === 0) return

  const current = call.argsText
  const next = chunk.args

  if (chunk.contentMode === "snapshot") {
    if (next === current) return
    if (current && next.startsWith(current)) {
      appendArgsText(call, next.slice(current.length))
    } else {
      replaceArgsText(call, next)
    }
    return
  }

  if (chunk.contentMode === "delta") {
    appendArgsText(call, next)
    return
  }

  if (current && next.length > current.length && next.startsWith(current)) {
    appendArgsText(call, next.slice(current.length))
    return
  }

  // An identical complete object is an unambiguous cumulative replay. An
  // identical incomplete fragment can still be legitimate delta data, so it
  // must be appended exactly as before.
  if (next === current && call.parsedArgsTextLength === current.length) return
  appendArgsText(call, next)
}

function parseCompletedArgs(call: AccumulatedToolCall): void {
  if (
    !call.argsText ||
    !call.jsonState.complete ||
    call.jsonState.invalid ||
    call.parsedArgsTextLength === call.argsText.length
  ) {
    return
  }

  try {
    const parsed = JSON.parse(call.argsText)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      call.args = parsed as Record<string, unknown>
      call.parsedArgsTextLength = call.argsText.length
    }
  } catch {
    // Balanced braces are only a cheap parse gate, not a full JSON validator.
    // Keep the most recent complete snapshot if the payload is malformed.
  }
}

function applyToolCallUpdates(
  state: IncrementalToolCallState,
  snapshots: readonly StreamToolCallSnapshot[],
  chunks: readonly StreamToolCallChunk[]
): void {
  snapshots.forEach((snapshot, index) => {
    if (!snapshot?.id) return
    state.callIdByIndex.set(index, snapshot.id)
    const call = state.callsById.get(snapshot.id) ?? createAccumulatedToolCall(snapshot.id)
    if (snapshot.name) call.name = snapshot.name
    if (hasUsefulArgs(snapshot.args)) call.args = snapshot.args
    state.callsById.set(snapshot.id, call)
  })

  for (const chunk of chunks) {
    const index = typeof chunk.index === "number" ? chunk.index : undefined
    const toolCallId = chunk.id || (index !== undefined ? state.callIdByIndex.get(index) : undefined)
    if (!toolCallId) continue
    if (index !== undefined) state.callIdByIndex.set(index, toolCallId)

    const call = state.callsById.get(toolCallId) ?? createAccumulatedToolCall(toolCallId)
    if (chunk.name) call.name = chunk.name
    applyArgsChunk(call, chunk)
    parseCompletedArgs(call)
    state.callsById.set(toolCallId, call)
  }
}

function materializeToolCalls(
  state: IncrementalToolCallState
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  return [...state.callsById.values()].map((call) => ({
    id: call.id,
    name: call.name,
    args: call.args ?? {}
  }))
}

export function appendStreamToolCallArgs(existing: string, nextChunk: string): string {
  return `${existing}${nextChunk}`
}

/** Shared live/durable policy for explicit deltas, snapshots, and ambiguous provider chunks. */
export function mergeStreamToolCallArgs(
  accumulated: string,
  chunk: string,
  contentMode: "delta" | "snapshot" | "auto" = "auto"
): string {
  if (contentMode === "snapshot") return chunk || accumulated
  // AIMessageChunk tool_call_chunks are deltas. Append them byte-for-byte: a
  // repeated boundary can be legitimate data ("bana" + "nana"), so overlap
  // inference would silently corrupt the JSON argument value.
  if (contentMode === "delta") return appendStreamToolCallArgs(accumulated, chunk)
  // Provider chunks without an explicit mode keep only unambiguous cumulative
  // cases: prefix growth or a repeated complete JSON object. Everything else
  // fails closed as delta bytes.
  if (accumulated && chunk.length > accumulated.length && chunk.startsWith(accumulated)) {
    return chunk
  }
  if (chunk === accumulated) {
    try {
      const parsed = JSON.parse(chunk)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return accumulated
    } catch {
      // An incomplete identical fragment can be legitimate delta data.
    }
  }
  return appendStreamToolCallArgs(accumulated, chunk)
}

/** Rebuild complete tool calls from ordered message-mode snapshots and chunks. */
export function mergeStreamToolCallChunks(
  snapshots: readonly StreamToolCallSnapshot[],
  chunks: readonly StreamToolCallChunk[]
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const state: IncrementalToolCallState = {
    callsById: new Map(),
    callIdByIndex: new Map()
  }
  applyToolCallUpdates(state, snapshots, chunks)
  return materializeToolCalls(state)
}

/**
 * Incrementally retain one compact state per tool call across debounce flushes.
 * Raw history is deliberately not retained: replaying it on every fragment was
 * quadratic and caused large file edits to block Electron's main process.
 */
export function accumulateStreamToolCallChunks(
  state: StreamToolCallAccumulatorState,
  snapshots: readonly StreamToolCallSnapshot[],
  chunks: readonly StreamToolCallChunk[]
): ReturnType<typeof mergeStreamToolCallChunks> {
  let incrementalState = incrementalAccumulatorStates.get(state)
  if (!incrementalState) {
    incrementalState = {
      callsById: new Map(),
      callIdByIndex: new Map()
    }
    incrementalAccumulatorStates.set(state, incrementalState)
    applyToolCallUpdates(incrementalState, state.snapshots, state.chunks)
    state.snapshots.length = 0
    state.chunks.length = 0
  }

  applyToolCallUpdates(incrementalState, snapshots, chunks)
  return materializeToolCalls(incrementalState)
}
