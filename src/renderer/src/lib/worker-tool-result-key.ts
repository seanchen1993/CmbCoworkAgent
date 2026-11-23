import type { Message } from "../types"
import { parseBotToolReceiptId, type BotToolReceipt } from "../../../shared/bots/turn-feedback"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId
} from "../../../shared/message-role-collision"
import { resolveToolResultOwnership } from "../../../shared/tool-result-ownership"

export { getWorkerToolResultKey, getWorkerToolUiKey } from "../../../shared/tool-result-ownership"

export interface ToolResultAssociation {
  content: unknown
  is_error?: boolean
  botReceipt?: BotToolReceipt
}

function getNativeBotReceipt(id: string, toolName: string): BotToolReceipt | undefined {
  if (!id.startsWith("bot-")) return undefined
  const identity = { id, role: "tool" }
  const occurrence = getMessageProviderOccurrence(identity)
  const source = getMessageProviderSourceId(identity)
  const isReplayId =
    occurrence && id === buildMessageSameRoleDuplicateId(source, "tool", occurrence)
  return parseBotToolReceiptId(isReplayId ? source : id, toolName)
}

export function buildToolResultAssociations(
  messages: readonly Message[]
): Map<string, ToolResultAssociation> {
  return resolveToolResultOwnership(messages, (message, toolName, nativeMessageId) => {
    const botReceipt = getNativeBotReceipt(nativeMessageId, toolName)
    return {
      content: message.content,
      is_error: message.is_error ?? message.status === "error",
      ...(botReceipt ? { botReceipt } : {})
    }
  })
}
