import type { ModJson } from "../../../shared/mods/types"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import { ModError } from "../errors"

/** No runtime/model construction, transcript migration, or display-log fallback. */
export async function readColdFunctionSession(
  threadId: string,
  method: Exclude<FunctionSessionReadMethod, "session.repo">,
  signal: AbortSignal
): Promise<{ value: ModJson; assertLive(): void }> {
  const { getThreadCore } = await import("../../db")
  signal.throwIfAborted()
  const initial = getThreadCore(threadId)?.metadata
  if (!initial) throw new ModError("MODS_THREAD_MISSING")
  const assertLive = () => {
    signal.throwIfAborted()
    if (getThreadCore(threadId)?.metadata !== initial) throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }
  if (method === "session.model") {
    const metadata = typeof initial === "string" ? JSON.parse(initial) : initial
    const registry = await import("../../models/registry")
    assertLive()
    const config =
      typeof metadata.modelId === "string" && metadata.modelId
        ? registry.getModelConfigByRef(metadata.modelId)
        : registry.getAvailableModelConfigOrDefault()
    if (!config) throw new ModError("MODS_MODEL_UNAVAILABLE")
    return { value: config.model, assertLive }
  }
  const { peekThreadCheckpointPath } = await import("../../storage")
  const { readFunctionSessionTranscriptInWorker } =
    await import("../../checkpointer/runtime-projection-client")
  assertLive()
  const result = await readFunctionSessionTranscriptInWorker(
    peekThreadCheckpointPath(threadId),
    threadId,
    signal,
    method === "session.turns" ? "turns" : "messages"
  )
  assertLive()
  if (method === "session.messages" && result && !Array.isArray(result.messages))
    throw new ModError("MODS_SESSION_MESSAGES_INVALID")
  const value = method === "session.turns" ? (result?.turns ?? 0) : (result?.messages ?? [])
  // Projection types contain only JSON fields; validate/clone at the common publication boundary.
  return { value: value as ModJson, assertLive }
}
