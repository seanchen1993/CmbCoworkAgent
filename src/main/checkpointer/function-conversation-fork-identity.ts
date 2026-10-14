import { createHash } from "node:crypto"
import { BaseMessage } from "@langchain/core/messages"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  hasInvalidFunctionConversationTranscriptStamp,
  readFunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { serializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeHistoryMessage } from
  "../agent/function-conversation-native-message"
import { FUNCTION_CONVERSATION_CHANNEL, readFunctionConversationState } from
  "./function-conversation-delivery"

/** Data identity for history deduplication. This digest never grants fork or runtime authority. */
export function functionConversationForkIdentity(checkpoint: Checkpoint): string | undefined {
  const raw = checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL]
  if (raw === undefined) return undefined
  const state = readFunctionConversationState(raw)
  const messages: unknown = checkpoint.channel_values.messages ?? []
  if (!Array.isArray(messages))
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
  const native = messages.map((message: unknown) => {
    if (hasInvalidFunctionConversationTranscriptStamp(message))
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    const stamp = readFunctionConversationTranscriptStamp(message)
    if (BaseMessage.isInstance(message)) {
      if (stamp && message.id !== stamp.uuid)
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      return [stamp ?? null, typeof message.id === "string" && message.id
        ? serializeFunctionConversationNativeMessage(message)
        : serializeFunctionConversationNativeHistoryMessage(message)]
    }
    // Conservative identity for old serialized history. Conversion separately requires native proof.
    return [stamp ?? null, JSON.stringify(message)]
  })
  return createHash("sha256").update(JSON.stringify({ state, native })).digest("hex")
}
