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
}

export interface StreamToolCallAccumulatorState {
  snapshots: StreamToolCallSnapshot[]
  chunks: StreamToolCallChunk[]
}

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
  const callsById = new Map<string, AccumulatedToolCall>()
  const callIdByIndex = new Map<number, string>()

  snapshots.forEach((snapshot, index) => {
    if (!snapshot?.id) return
    callIdByIndex.set(index, snapshot.id)
    const existing = callsById.get(snapshot.id)
    callsById.set(snapshot.id, {
      id: snapshot.id,
      name: snapshot.name || existing?.name || "",
      argsText: existing?.argsText ?? "",
      ...(hasUsefulArgs(snapshot.args)
        ? { args: snapshot.args }
        : existing?.args
          ? { args: existing.args }
          : {})
    })
  })

  for (const chunk of chunks) {
    const index = typeof chunk.index === "number" ? chunk.index : undefined
    const toolCallId = chunk.id || (index !== undefined ? callIdByIndex.get(index) : undefined)
    if (!toolCallId) continue
    if (index !== undefined) callIdByIndex.set(index, toolCallId)

    const existing = callsById.get(toolCallId)
    const argsText =
      typeof chunk.args !== "string" || chunk.args.length === 0
        ? (existing?.argsText ?? "")
        : mergeStreamToolCallArgs(existing?.argsText ?? "", chunk.args, chunk.contentMode)
    let args = existing?.args
    if (argsText) {
      try {
        const parsed = JSON.parse(argsText)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        // Keep the most recent complete snapshot until the JSON delta completes.
      }
    }
    callsById.set(toolCallId, {
      id: toolCallId,
      name: chunk.name || existing?.name || "",
      argsText,
      ...(args ? { args } : {})
    })
  }

  return [...callsById.values()].map((call) => ({
    id: call.id,
    name: call.name,
    args: call.args ?? {}
  }))
}

/** Retain raw chunk identity across debounce flushes within one physical run. */
export function accumulateStreamToolCallChunks(
  state: StreamToolCallAccumulatorState,
  snapshots: readonly StreamToolCallSnapshot[],
  chunks: readonly StreamToolCallChunk[]
): ReturnType<typeof mergeStreamToolCallChunks> {
  state.snapshots.push(...snapshots)
  state.chunks.push(...chunks)
  return mergeStreamToolCallChunks(state.snapshots, state.chunks)
}
