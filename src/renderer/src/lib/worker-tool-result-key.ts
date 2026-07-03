export function getWorkerToolResultKey(
  messageId: string,
  toolCallId: string | undefined
): string | undefined {
  if (!toolCallId) return undefined
  if (!messageId.startsWith("worker-turn-")) return toolCallId

  const separatorIndex = messageId.indexOf("::")
  if (separatorIndex < 0) return toolCallId

  const prefix = messageId.slice(0, separatorIndex + 2)
  return toolCallId.startsWith(prefix) ? toolCallId : `${prefix}${toolCallId}`
}

export function getWorkerToolUiKey(
  messageId: string,
  toolCallId: string | undefined,
  index: number
): string {
  return getWorkerToolResultKey(messageId, toolCallId) ?? `${messageId}::tool-${index}`
}
