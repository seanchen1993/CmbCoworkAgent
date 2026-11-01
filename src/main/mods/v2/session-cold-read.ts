import type { ModJson } from "../../../shared/mods/types"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import type { FunctionSessionMessagePage, FunctionSessionPageInput } from "../../../shared/mods/v2/session"
import { ModError } from "../errors"
import { projectContextUsage } from "../../agent/context-usage"

/** A bounded, exact checkpoint window without constructing any runtime or model. */
export async function readColdFunctionSessionPage(
  threadId: string, signal: AbortSignal, page: FunctionSessionPageInput
): Promise<{ value: FunctionSessionMessagePage | null; assertLive(): void }> {
  const { getDb, getThreadCore } = await import("../../db")
  const { captureThreadIncarnation, matchesThreadIncarnation } =
    await import("../../services/thread-incarnation")
  signal.throwIfAborted()
  const database = getDb()
  const row = getThreadCore(threadId)
  if (!row) throw new ModError("MODS_THREAD_MISSING")
  const incarnation = captureThreadIncarnation(row)
  const assertLive = () => {
    signal.throwIfAborted()
    const current = getThreadCore(threadId)
    if (getDb() !== database || !current || !matchesThreadIncarnation(current, incarnation))
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }
  const { peekThreadCheckpointPath } = await import("../../storage")
  const { readFunctionSessionPageInWorker } = await import("../../checkpointer/runtime-projection-client")
  assertLive()
  const value = await readFunctionSessionPageInWorker(
    peekThreadCheckpointPath(threadId), threadId, signal, page)
  assertLive()
  return { value, assertLive }
}

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
  if (method === "session.model" || method === "session.usage") {
    const metadata = typeof initial === "string" ? JSON.parse(initial) : initial
    const registry = await import("../../models/registry")
    assertLive()
    const config =
      typeof metadata.modelId === "string" && metadata.modelId
        ? registry.getModelConfigByRef(metadata.modelId)
        : registry.getAvailableModelConfigOrDefault()
    if (!config) throw new ModError("MODS_MODEL_UNAVAILABLE")
    const initialConfig = JSON.stringify({
      id: config.id,
      model: config.model,
      maxTokens: config.maxTokens
    })
    const assertModelLive = () => {
      assertLive()
      const current =
        typeof metadata.modelId === "string" && metadata.modelId
          ? registry.getModelConfigByRef(metadata.modelId)
          : registry.getAvailableModelConfigOrDefault()
      if (
        !current ||
        JSON.stringify({ id: current.id, model: current.model, maxTokens: current.maxTokens }) !==
          initialConfig
      )
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
    if (method === "session.model") return { value: config.model, assertLive: assertModelLive }
    const { peekThreadCheckpointPath, DEFAULT_MAX_TOKENS } = await import("../../storage")
    const { readFunctionSessionTranscriptInWorker } =
      await import("../../checkpointer/runtime-projection-client")
    const checkpoint = await readFunctionSessionTranscriptInWorker(
      peekThreadCheckpointPath(threadId),
      threadId,
      signal,
      "usage"
    )
    assertModelLive()
    return {
      value: {
        context: projectContextUsage(config.maxTokens ?? DEFAULT_MAX_TOKENS, checkpoint?.usage),
        rateLimits: []
      },
      assertLive: assertModelLive
    }
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
