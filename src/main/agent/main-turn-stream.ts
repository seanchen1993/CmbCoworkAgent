import { isContextCompactionStreamPayload } from "../../shared/context-compaction-events"
import { isSerializedSummarizationMessage } from "../../shared/context-compaction-messages"

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function metadata(mode: string, payload: unknown): Record<string, unknown> | undefined {
  return mode === "messages" && Array.isArray(payload) ? object(payload[1]) : undefined
}

export function childTurnStreamOwner(mode: string, payload: unknown): string | undefined {
  if (
    mode !== "messages" ||
    !Array.isArray(payload) ||
    isContextCompactionStreamPayload(mode, payload) ||
    isSerializedSummarizationMessage(payload[0])
  )
    return undefined
  // Host-stamped task invocation metadata, not the provider message's content/kwargs.
  const owner = metadata(mode, payload)?.cmb_subagent_owner_tool_call_id
  return typeof owner === "string" && owner.trim() ? owner.trim() : undefined
}

export function isCoordinatorWorkerStreamChunk(
  mode: string,
  payload: unknown,
  threadId: string
): boolean {
  const value = metadata(mode, payload)
  if (!value || threadId.includes("__worker__")) return false
  const workerPrefix = `${threadId}__worker__`
  return [
    value.langgraph_checkpoint_ns,
    value.checkpoint_ns,
    value.thread_id,
    value.langgraph_thread_id,
    object(value.configurable)?.thread_id
  ].some((entry) => typeof entry === "string" && entry.includes(workerPrefix))
}

/** Desktop and managed transports exclude summarizer and child interiors identically. */
export function isMainTurnMessageStream(mode: string, payload: unknown, threadId: string): boolean {
  if (mode !== "messages" || !Array.isArray(payload)) return false
  if (
    isContextCompactionStreamPayload(mode, payload) ||
    isSerializedSummarizationMessage(payload[0]) ||
    childTurnStreamOwner(mode, payload) !== undefined ||
    isCoordinatorWorkerStreamChunk(mode, payload, threadId)
  )
    return false
  const value = metadata(mode, payload)
  const namespace =
    typeof value?.langgraph_checkpoint_ns === "string"
      ? value.langgraph_checkpoint_ns
      : typeof value?.checkpoint_ns === "string"
        ? value.checkpoint_ns
        : ""
  return !namespace.includes("tools:")
}
