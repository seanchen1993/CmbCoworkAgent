import type { Message } from "../types"
import { parseBotToolReceiptId, type BotToolReceipt } from "../../../shared/bots/turn-feedback"
import { resolveToolResultOwnership } from "../../../shared/tool-result-ownership"

export { getWorkerToolResultKey, getWorkerToolUiKey } from "../../../shared/tool-result-ownership"

export interface ToolResultAssociation {
  content: unknown
  is_error?: boolean
  botReceipt?: BotToolReceipt
}

export function buildToolResultAssociations(
  messages: readonly Message[]
): Map<string, ToolResultAssociation> {
  return resolveToolResultOwnership(messages, (message, toolName, nativeMessageId) => {
    const botReceipt = parseBotToolReceiptId(nativeMessageId, toolName)
    return {
      content: message.content,
      is_error: message.is_error ?? message.status === "error",
      ...(botReceipt ? { botReceipt } : {})
    }
  })
}
