import { BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  functionConversationTranscriptFields,
  sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp,
  type FunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { getMessageProviderTupleFromMetadata } from "../../shared/message-role-collision"
import type { Message } from "../types"
import type { FunctionConversationRef, FunctionConversationRow,
  FunctionConversationRowReadCut, FunctionConversationStore } from "../db/function-conversation-store"
import type { PersistedRuntimeMessageOptions } from "./persisted-runtime-message"

export interface FunctionConversationRecoveryAdmission {
  readonly store: FunctionConversationStore
  readonly target: FunctionConversationRef
  readonly cut: FunctionConversationRowReadCut
  readonly guard: () => void
  /** Must verify the complete actual native DB projection at its captured destination. */
  readonly verifyProjection: (target: FunctionConversationRef, row: FunctionConversationRow) => void
  /** Exact original Saver tuple/namespace membership, captured by the native recovery admission. */
  readonly verifyCheckpointMembership: (message: Message, row: FunctionConversationRow) => void
  /** Actual native serializer adapter; it must return the original message class and payload. */
  readonly deserializeNative: (target: FunctionConversationRef, row: FunctionConversationRow) => BaseMessage
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_RECOVERY_REQUIRED") }

function canonicalStamp(target: FunctionConversationRef, row: FunctionConversationRow):
  FunctionConversationTranscriptStamp {
  const value = { conversationId: target.conversationId, branchId: row.branchId,
    uuid: row.uuid, sequence: row.sequence, door: row.door, messageType: row.message.type,
    ...(row.message.isMeta === true ? { isMeta: true } : {}), origin: row.origin }
  validateFunctionConversationTranscriptStamp(value)
  return value
}

function assertNativeIdentity(message: Message, native: BaseMessage): void {
  if (!BaseMessage.isInstance(native) || native.id !== message.id) fail()
  const type = native.getType()
  const role = type === "human" ? "user" : type === "ai" ? "assistant" : type
  if (role !== message.role) fail()
  if (role === "tool") {
    const toolId = Object.getOwnPropertyDescriptor(native, "tool_call_id")
    if (!toolId || !("value" in toolId) || typeof toolId.value !== "string" ||
      !toolId.value || toolId.value !== message.tool_call_id) fail()
  }
  const actual = getMessageProviderTupleFromMetadata(native.additional_kwargs)
  if ((actual?.provider_source_id ?? undefined) !== (message.provider_source_id ?? undefined) ||
    (actual?.provider_occurrence ?? undefined) !== (message.provider_occurrence ?? undefined)) fail()
  if (functionConversationTranscriptFields(native, message.id, message.role).function_row_invalid)
    fail()
}

/** Captured native admission only. Public stamps cannot select a target, branch or checkpoint. */
export function createFunctionConversationRecoveryResolver(
  admission: FunctionConversationRecoveryAdmission
): NonNullable<PersistedRuntimeMessageOptions["resolveFunctionRow"]> {
  const target = Object.freeze({ ...admission.target,
    incarnation: Object.freeze({ ...admission.target.incarnation }) })
  const cut = Object.freeze({ frontier: admission.cut.frontier,
    ...(admission.cut.notAfterCreatedAt !== undefined
      ? { notAfterCreatedAt: admission.cut.notAfterCreatedAt } : {}) })
  const { store, guard, verifyProjection, verifyCheckpointMembership, deserializeNative } = admission
  return (message, suppliedStamp) => {
    guard()
    const fields = functionConversationTranscriptFields(message, message.id, message.role)
    if (!fields.function_row || fields.function_row_invalid ||
      !sameFunctionConversationTranscriptStamp(fields.function_row, suppliedStamp)) fail()
    const row = store.readRowAtCut(target, message.id, cut, guard)
    const stamp = canonicalStamp(target, row)
    if (!sameFunctionConversationTranscriptStamp(stamp, suppliedStamp)) fail()
    verifyCheckpointMembership(message, row)
    guard()
    verifyProjection(target, row)
    guard()
    const native = deserializeNative(target, row)
    assertNativeIdentity(message, native)
    const nativeFields = functionConversationTranscriptFields(native, message.id, message.role)
    if (nativeFields.function_row &&
      !sameFunctionConversationTranscriptStamp(nativeFields.function_row, stamp)) fail()
    native.additional_kwargs = { ...native.additional_kwargs, function_row: stamp }
    guard()
    return native
  }
}
