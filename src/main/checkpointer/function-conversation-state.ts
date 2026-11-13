import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationRef } from "../db/function-conversation-store"

export const FUNCTION_CONVERSATION_CHANNEL = "cmbFunctionConversation"

export interface FunctionConversationState {
  version: 1
  logicalSessionId: string
  conversationId: string
  branchId: string
  frontier: number
}

export function readFunctionConversationState(value: unknown): FunctionConversationState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModFunctionError("MODS_CONVERSATION_STATE_INVALID")
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => !["version", "logicalSessionId", "conversationId", "branchId", "frontier"].includes(key)) ||
    data.version !== 1 || typeof data.logicalSessionId !== "string" || !data.logicalSessionId ||
    typeof data.conversationId !== "string" || !data.conversationId ||
    typeof data.branchId !== "string" || !data.branchId ||
    typeof data.frontier !== "number" || !Number.isSafeInteger(data.frontier) || data.frontier < 0)
    throw new ModFunctionError("MODS_CONVERSATION_STATE_INVALID")
  return { version: 1, logicalSessionId: data.logicalSessionId,
    conversationId: data.conversationId, branchId: data.branchId, frontier: data.frontier }
}

export function assertFunctionConversationState(target: FunctionConversationRef, state: FunctionConversationState): void {
  if (state.logicalSessionId !== target.logicalSessionId || state.conversationId !== target.conversationId ||
    state.branchId !== target.branchId) throw new ModFunctionError("MODS_CONVERSATION_STATE_CHANGED")
}

