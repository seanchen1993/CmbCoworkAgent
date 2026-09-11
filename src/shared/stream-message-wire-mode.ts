export type StreamMessageWireMode = "delta" | "snapshot"

/**
 * Explicit field semantics at the stream boundary. Standard LangChain chunks
 * are deltas; a nonstandard cumulative producer must annotate snapshots (or
 * configure the serializer). The serializer updates these tags to describe
 * the projected IPC payload. Consumers must honor them instead of guessing
 * semantics from text prefixes or the LangChain message class.
 */
export const STREAM_MESSAGE_CONTENT_MODE_KEY = "cmb_stream_message_content_mode"
export const STREAM_MESSAGE_REASONING_MODE_KEY = "cmb_stream_message_reasoning_mode"
/** Complete values snapshots replace the tool list, including an explicit empty list. */
export const STREAM_MESSAGE_TOOL_CALLS_MODE_KEY = "cmb_stream_message_tool_calls_mode"

/** Tool-call chunks carry their mode beside `args` so each interleaved call can differ. */
export const STREAM_TOOL_CALL_ARGS_MODE_KEY = "cmb_stream_tool_call_args_mode"

export function readStreamMessageWireMode(value: unknown): StreamMessageWireMode | undefined {
  return value === "delta" || value === "snapshot" ? value : undefined
}
