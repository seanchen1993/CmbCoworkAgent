import { functionConversationTranscriptFields } from "./conversation-transcript"

function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field && "value" in field ? field.value : undefined
}

/** Display only. A stamp does not grant permission to change the tool's execution facts. */
export function resolveFunctionConversationToolErrorPresentation(message: unknown):
  boolean | undefined {
  const kwargs = data(message, "kwargs") ?? message
  const id = data(kwargs, "id")
  const fields = functionConversationTranscriptFields(message,
    typeof id === "string" ? id : undefined, "tool")
  const stamp = fields.function_row
  const error = data(kwargs, "is_error")
  const additionalError = data(data(kwargs, "additional_kwargs"), "is_error")
  if (stamp && !fields.function_row_invalid && stamp.uuid === id &&
    stamp.messageType === "user" && ["tool-result", "tool-message"].includes(stamp.door)) {
    if (typeof error === "boolean") return error
    if (typeof additionalError === "boolean") return additionalError
  }
  return data(kwargs, "status") === "error" || error === true || additionalError === true
    ? true : undefined
}
