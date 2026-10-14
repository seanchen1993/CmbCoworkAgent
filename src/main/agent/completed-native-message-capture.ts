import { AIMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  captureCompletedNativeNodeData,
  captureNativeMessage,
  constructCapturedNativeMessage,
  type CapturedNativeMessage
} from "./native-message-capture"
import {
  readFunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlot
} from "./function-conversation-native-node"

export interface CapturedCompletedNativeOccurrence {
  readonly message: AIMessage
  readonly snapshot: CapturedNativeMessage
  readonly originalId?: string
  readonly originalDigest: string
}

function completedFields(snapshot: CapturedNativeMessage): Record<string, unknown> {
  const data = { ...snapshot.data }
  const metadata = data.response_metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
    Object.getOwnPropertyDescriptor(metadata, "output_version")?.value === "v1") {
    if (!Array.isArray(data.content) || Object.hasOwn(data, "content_blocks") ||
      (Object.hasOwn(data, "contentBlocks") &&
        JSON.stringify(data.contentBlocks) !== JSON.stringify(data.content)))
      throw new ModFunctionError("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
    // Only the new full class receives this known derived constructor alias. The original
    // chunk digest still records its actual data, including an absent alias.
    data.contentBlocks = data.content
  }
  return data
}

/**
 * A completed node address enables a typed class conversion, never an append or target grant.
 * The caller must independently join its original model callback and actual occurrence to slot.
 */
export function captureNativeMessageForCompletedOccurrence(
  slot: FunctionConversationNativeNodeSlot, stableUuid: string, assertBoundedWork?: () => void
): Readonly<CapturedCompletedNativeOccurrence> {
  const view = readFunctionConversationNativeNodeSlot(slot)
  const guardSource = () => {
    assertBoundedWork?.()
    const current = readFunctionConversationNativeNodeSlot(slot)
    if (current !== view || current.message !== view.message)
      throw new ModFunctionError("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
  }
  guardSource()
  const captured = captureCompletedNativeNodeData(slot, stableUuid, assertBoundedWork)
  guardSource()
  // Only pure copied fields enter the known full constructor. In particular, its default v1
  // normalization never sees the original call/content arrays or provider getters.
  const message = constructCapturedNativeMessage("ai", completedFields(captured.snapshot))
  if (Object.getPrototypeOf(message) !== AIMessage.prototype || !(message instanceof AIMessage))
    throw new ModFunctionError("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
  const normalized = captureNativeMessage(message, assertBoundedWork)
  guardSource()
  return Object.freeze({ message, snapshot: Object.freeze({ ...normalized,
    executionSuppressed: captured.snapshot.executionSuppressed || normalized.executionSuppressed }),
    originalDigest: captured.originalDigest,
    ...(captured.originalId === undefined ? {} : { originalId: captured.originalId }) })
}
