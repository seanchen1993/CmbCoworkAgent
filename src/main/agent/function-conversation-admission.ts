import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { functionConversationTranscriptFields } from "../../shared/mods/v2/conversation-transcript"
import { readFunctionConversationState, type FunctionConversationState }
  from "../checkpointer/function-conversation-state"

export type FunctionConversationCheckpointAdmission =
  | { readonly kind: "ordinary"; readonly marked: false; readonly invalid: false }
  | { readonly kind: "unproven-native"; readonly marked: boolean; readonly invalid: boolean }
  | { readonly kind: "native"; readonly state: FunctionConversationState;
      readonly marked: boolean; readonly invalid: boolean }

/**
 * Classifies actual retained checkpoint data. This is never an execution/recovery proof.
 * Feature flags cannot turn native history into ordinary history. Callers still authenticate
 * native membership, or the exact original Saver tuple before enrolling ordinary history.
 */
export function inspectFunctionConversationAdmission(input: {
  readonly state: unknown
  readonly messages: readonly unknown[] | undefined
}, guard: () => void): FunctionConversationCheckpointAdmission {
  guard()
  const state = input.state === undefined ? undefined : readFunctionConversationState(input.state)
  let marked = false, invalid = false
  for (const message of input.messages ?? []) {
    guard()
    const fields = functionConversationTranscriptFields(message)
    marked ||= fields.function_row !== undefined
    invalid ||= fields.function_row_invalid === true
  }
  guard()
  if (state) return { kind: "native", state, marked, invalid }
  if (marked || invalid) return { kind: "unproven-native", marked, invalid }
  return { kind: "ordinary", marked: false, invalid: false }
}

/** Fork preflight must complete before creating a target, invoking recovery or copying rows. */
export function inspectFunctionConversationForkAdmission(checkpoints: readonly {
  readonly state: unknown
  readonly messages: readonly unknown[] | undefined
}[], guard: () => void): "ordinary" | "native" {
  let native = false
  for (const checkpoint of checkpoints) {
    const admission = inspectFunctionConversationAdmission(checkpoint, guard)
    if (admission.kind === "unproven-native")
      throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
    native ||= admission.kind === "native"
  }
  guard()
  return native ? "native" : "ordinary"
}
