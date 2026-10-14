import { BaseMessage, AIMessage, ToolMessage, mapStoredMessageToChatMessage,
  type StoredMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_MESSAGE_INVALID")
}

/** Native checkpoint payload, independent of the bounded public Hook/API projection. */
export function serializeFunctionConversationNativeMessage(message: BaseMessage): string {
  if (!BaseMessage.isInstance(message) || typeof message.id !== "string" || !message.id ||
    !["human", "ai", "system", "tool"].includes(message.getType())) fail()
  return serializeNativeData(message)
}

/** Full read-only identity for old ID-less native history; this is not a canonical keeper payload. */
export function serializeFunctionConversationNativeHistoryMessage(message: BaseMessage): string {
  if (!BaseMessage.isInstance(message)) fail()
  return serializeNativeData(message)
}

function serializeNativeData(message: BaseMessage): string {
  const stored = message.toDict()
  const additional = { ...message.additional_kwargs }
  // The host adds the row stamp after its sequence has been committed. It is verified separately.
  delete additional.function_row
  if (Object.hasOwn(additional, "function_row_invalid")) fail()
  const data: Record<string, unknown> = { ...stored.data, id: message.id,
    content: message.content, additional_kwargs: additional,
    response_metadata: message.response_metadata }
  if (message.name !== undefined) data.name = message.name
  if (AIMessage.isInstance(message)) {
    data.tool_calls = message.tool_calls
    data.invalid_tool_calls = message.invalid_tool_calls
    data.usage_metadata = message.usage_metadata
  }
  if (ToolMessage.isInstance(message)) {
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id) fail()
    data.tool_call_id = message.tool_call_id
    data.status = message.status
    data.artifact = message.artifact
    data.metadata = message.metadata
  }
  try {
    return JSON.stringify({ version: 1, message: { type: message.getType(), data } })
  } catch { return fail() }
}

function restoreCanonicalAiV1(data: Record<string, unknown>): AIMessage {
  if (Object.hasOwn(data, "contentBlocks") ||
    !Array.isArray(data.content) || !Array.isArray(data.content_blocks) ||
    !Array.isArray(data.tool_calls) ||
    (Object.hasOwn(data, "invalid_tool_calls") && !Array.isArray(data.invalid_tool_calls))) fail()
  const metadata = data.response_metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail()
  const responseMetadata: Record<string, unknown> = { ...metadata }
  const construction = { ...data, response_metadata: responseMetadata }
  // The payload already contains the constructor's normalized v1 content. Suppress only the
  // second normalization; never append tool calls or reinterpret a public summary as native data.
  delete construction.response_metadata.output_version
  const initial: Record<string, unknown> = construction
  delete initial.contentBlocks
  delete initial.content_blocks
  const native = mapStoredMessageToChatMessage({ type: "ai", data: initial } as unknown as StoredMessage)
  if (!AIMessage.isInstance(native)) fail()
  const defaults = Object.getOwnPropertyDescriptor(native, "lc_kwargs")?.value
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) fail()
  for (const key of ["content", "tool_calls", "invalid_tool_calls", "usage_metadata",
    "additional_kwargs", "response_metadata"])
    if (Object.hasOwn(data, key)) Object.defineProperty(native, key, {
      value: data[key], enumerable: true, configurable: true, writable: true })
  const kwargs: Record<string, unknown> = {}
  for (const key of Object.keys(data)) Object.defineProperty(kwargs,
    key === "content_blocks" ? "contentBlocks" : key, {
      value: data[key], enumerable: true, configurable: true, writable: true })
  // Preserve original insertion order, while retaining real constructor defaults. Omitting a
  // native field from a noncanonical payload must still fail the final exact serialization gate.
  // Serializable maps the actual native contentBlocks getter to the wire key content_blocks.
  // Restore that known alias so a conflicting serialized block cannot hide in an inert kwargs key.
  for (const key of Object.keys(defaults))
    if (!Object.hasOwn(kwargs, key)) kwargs[key] = Object.getOwnPropertyDescriptor(defaults, key)?.value
  Object.defineProperty(native, "lc_kwargs", {
    value: kwargs, enumerable: true, configurable: true, writable: true })
  return native
}

/** Only canonical keeper payloads enter this adapter; UI summaries never recreate native messages. */
export function deserializeFunctionConversationNativeMessage(payload: string): BaseMessage {
  let envelope: unknown
  try { envelope = JSON.parse(payload) } catch { return fail() }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail()
  const value = envelope as Record<string, unknown>
  if (value.version !== 1 || Object.keys(value).some(key => !["version", "message"].includes(key)) ||
    !value.message || typeof value.message !== "object" || Array.isArray(value.message)) fail()
  const message = value.message as Record<string, unknown>
  if (typeof message.type !== "string" ||
    !["human", "ai", "system", "tool"].includes(message.type) ||
    Object.keys(message).some(key => !["type", "data"].includes(key)) ||
    !message.data || typeof message.data !== "object" || Array.isArray(message.data)) fail()
  const data = message.data as Record<string, unknown>
  if (typeof data.id !== "string" || !data.id ||
    !(typeof data.content === "string" || Array.isArray(data.content)) ||
    (message.type === "tool" &&
      (typeof data.tool_call_id !== "string" || !data.tool_call_id))) fail()
  let native: BaseMessage
  try {
    const metadata = data.response_metadata
    native = message.type === "ai" && metadata && typeof metadata === "object" &&
      !Array.isArray(metadata) && Object.hasOwn(metadata, "output_version") &&
      Object.getOwnPropertyDescriptor(metadata, "output_version")?.value === "v1"
      ? restoreCanonicalAiV1(data)
      : mapStoredMessageToChatMessage(message as unknown as StoredMessage)
  }
  catch { return fail() }
  if (serializeFunctionConversationNativeMessage(native) !== payload) fail()
  return native
}
