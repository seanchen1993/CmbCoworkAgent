import { BaseMessage } from "@langchain/core/messages"
import { isInternalNotificationMessage, isVisibleTranscriptMessage } from "../../../shared/checkpoint-transcript"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionConversationTranscriptFields,
  sameFunctionConversationTranscriptStamp } from "../../../shared/mods/v2/conversation-transcript"
import { validateFunctionSessionApiMessages, type FunctionApiContentBlock,
  type FunctionApiMessage } from "../../../shared/mods/v2/session-append"

const LIMIT = 4096
const SCAN_LIMIT = 100000

function fail(): never { throw new ModFunctionError("MODS_SESSION_MESSAGES_INVALID") }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function contentBlocks(content: unknown): FunctionApiContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) fail()
  return content.map(value => {
    if (typeof value === "string") return { type: "text", text: value }
    const block = parseModJson(encodeModJson(value))
    if (!isModObject(block) || typeof block.type !== "string" || !block.type.trim()) fail()
    // Images, documents, thinking and unknown native blocks retain their complete data.
    return block as FunctionApiContentBlock
  })
}

function project(value: unknown): FunctionApiMessage | undefined {
  const outer = object(value)
  if (!outer) return undefined
  const message = object(outer.kwargs) ?? object(outer.message) ?? outer
  const type = BaseMessage.isInstance(value) ? value.getType()
    : message.type ?? outer.type ?? message.role
  const className = Array.isArray(outer.id) ? outer.id.at(-1) : undefined
  const actualRole = type === "human" || type === "user" || className === "HumanMessage" ? "user"
    : type === "ai" || type === "assistant" || className === "AIMessage" ? "assistant"
    : type === "tool" || className === "ToolMessage" ? "tool"
    : type === "system" || className === "SystemMessage" ? "system" : undefined
  // A serialized constructor's outer id is its class path, not the stored message UUID.
  const messageId = Object.getOwnPropertyDescriptor(message, "id")
  const outerId = Object.getOwnPropertyDescriptor(outer, "id")
  const nativeId = messageId && "value" in messageId && typeof messageId.value === "string"
    ? messageId.value : undefined
  const envelopeId = outerId && "value" in outerId && typeof outerId.value === "string"
    ? outerId.value : undefined
  const actualId = nativeId ?? envelopeId
  const fields = functionConversationTranscriptFields(value, actualId, actualRole)
  const nestedFields = message === outer ? fields
    : functionConversationTranscriptFields(message, actualId, actualRole)
  if (fields.function_row_invalid || nestedFields.function_row_invalid) fail()
  const stamp = fields.function_row ?? nestedFields.function_row
  if (stamp && (!actualId?.trim() || !actualRole ||
    (nativeId !== undefined && envelopeId !== undefined && nativeId !== envelopeId) ||
    (fields.function_row && nestedFields.function_row &&
      !sameFunctionConversationTranscriptStamp(fields.function_row, nestedFields.function_row))))
    fail()
  // A system notice is a durable UI fact; it never becomes a model/API user message.
  if (!actualRole || actualRole === "system") return undefined
  const role = actualRole
  if (stamp?.messageType === "system") return undefined
  if (role === "user" && !(stamp?.door === "note" && stamp.messageType === "user") &&
    (outer.isMeta === true || message.isMeta === true || outer.isVirtual === true ||
      message.isVirtual === true || isInternalNotificationMessage(value) ||
      !isVisibleTranscriptMessage("user", message.content))) return undefined
  const content = contentBlocks(message.content)
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id.trim()) fail()
    return { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id,
      content: typeof message.content === "string" ? message.content : content,
      is_error: message.status === "error" || message.is_error === true }] }
  }
  if (role === "assistant") {
    // Some providers include the same call in both content and normalized tool_calls.
    // Match by complete value and occurrence; distinct calls and repeated calls remain.
    const consumed = new Set<number>()
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) fail()
    for (const value of (message.tool_calls as unknown[] | undefined) ?? []) {
      const call = object(value)
      if (!call || typeof call.id !== "string" || !call.id.trim() ||
        typeof call.name !== "string" || !call.name.trim()) fail()
      const args = parseModJson(encodeModJson(call.args))
      if (!isModObject(args)) fail()
      const block: FunctionApiContentBlock = { type: "tool_use", id: call.id,
        name: call.name, input: args }
      const match = content.findIndex((old, index) => !consumed.has(index) &&
        old.type === "tool_use" && old.id === block.id && old.name === block.name &&
        encodeModJson(old.input) === encodeModJson(args))
      if (match >= 0) consumed.add(match)
      else { content.push(block); consumed.add(content.length - 1) }
    }
    const reasoning = object(message.additional_kwargs)?.reasoning_content
    if (typeof reasoning === "string" && !content.some(block => block.type === "thinking"))
      content.push({ type: "thinking", thinking: reasoning })
  }
  return { role, content }
}

/** Actual retained graph messages or durable constructor envelopes, never renderer summaries. */
export function projectFunctionSessionApiMessages(messages: readonly unknown[]): FunctionApiMessage[] {
  const selected: FunctionApiMessage[] = []
  let scanned = 0
  for (let index = messages.length - 1; index >= 0 && selected.length < LIMIT; index--) {
    if (++scanned > SCAN_LIMIT) throw new ModFunctionError("MODS_SESSION_MESSAGE_SCAN_LIMIT")
    const value = project(messages[index])
    if (value) selected.push(value)
  }
  selected.reverse()
  validateFunctionSessionApiMessages(selected)
  return selected
}
