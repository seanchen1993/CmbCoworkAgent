import type { BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { captureNativeMessageForOccurrence, constructCapturedNativeMessage } from
  "./native-message-capture"

/** A safe inspection copy. Its temporary ID never reaches the original graph or a receipt. */
export function preflightFunctionConversationMessage(message: BaseMessage,
  assertBoundedWork: () => void): BaseMessage {
  const captured = captureNativeMessageForOccurrence(message, "conversation-preflight-copy",
    assertBoundedWork)
  if (captured.snapshot.executionSuppressed)
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
  const safe = constructCapturedNativeMessage(captured.snapshot.type,
    { ...captured.snapshot.data })
  Object.defineProperty(safe, "id", { value: captured.originalId, enumerable: true,
    configurable: true, writable: true })
  return safe
}
