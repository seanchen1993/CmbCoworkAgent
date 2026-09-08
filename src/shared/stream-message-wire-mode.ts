export type StreamMessageWireMode = "delta" | "snapshot"

/**
 * Internal metadata attached after the provider chunk has been projected for
 * IPC. Consumers must use these modes instead of inferring cumulative-vs-delta
 * semantics from the LangChain message class.
 */
export const STREAM_MESSAGE_CONTENT_MODE_KEY = "cmb_stream_message_content_mode"
export const STREAM_MESSAGE_REASONING_MODE_KEY = "cmb_stream_message_reasoning_mode"

/** Tool-call chunks carry their mode beside `args` so each interleaved call can differ. */
export const STREAM_TOOL_CALL_ARGS_MODE_KEY = "cmb_stream_tool_call_args_mode"

export function readStreamMessageWireMode(value: unknown): StreamMessageWireMode | undefined {
  return value === "delta" || value === "snapshot" ? value : undefined
}
