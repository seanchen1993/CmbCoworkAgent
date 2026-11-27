import type { Message } from "../types"
import { parseBotToolReceiptId, type BotToolReceipt } from "../../../shared/bots/turn-feedback"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId
} from "../../../shared/message-role-collision"
import { resolveToolResultOwnership } from "../../../shared/tool-result-ownership"
import { parseGeneratedImageReceipt } from "../../../shared/generated-image"

export { getWorkerToolResultKey, getWorkerToolUiKey } from "../../../shared/tool-result-ownership"

export interface ToolResultAssociation {
  content: unknown
  is_error?: boolean
  botReceipt?: BotToolReceipt
  repeatedGeneratedImage?: true
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
  const displayedImages = new Set<string>()
  return resolveToolResultOwnership(messages, (message, toolName, nativeMessageId) => {
    const botReceipt = getNativeBotReceipt(nativeMessageId, toolName)
    const failed = message.is_error ?? message.status === "error"
    const image = !failed && toolName === "generate_image" && parseGeneratedImageReceipt(message.content)
    const repeated = image && displayedImages.has(image.actionId)
    if (image) displayedImages.add(image.actionId)
    return {
      content: message.content,
      is_error: failed,
      ...(repeated ? { repeatedGeneratedImage: true as const } : {}),
      ...(botReceipt ? { botReceipt } : {})
    }
  })
}
