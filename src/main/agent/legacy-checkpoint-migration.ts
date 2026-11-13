import { BaseMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { serializeFunctionConversationNativeHistoryMessage } from
  "./function-conversation-native-message"
import { preflightFunctionConversationMessage } from "./function-conversation-message-preflight"

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_MIGRATION_REQUIRED")
}

function ordinaryHistory(messages: readonly unknown[], guard: () => void): readonly string[] {
  return messages.map(message => {
    guard()
    if (!BaseMessage.isInstance(message)) fail()
    const native = preflightFunctionConversationMessage(message, guard)
    // A public/canonical stamp needs its original membership path. This migration
    // handles only historical ordinary messages, never an orphan native receipt.
    if (Object.hasOwn(native.additional_kwargs, "function_row") ||
      Object.hasOwn(native.additional_kwargs, "function_row_invalid")) fail()
    return serializeFunctionConversationNativeHistoryMessage(native)
  })
}

/** Authenticate an old ordinary graph snapshot through its actual original Saver tuple. */
export async function captureLegacyCheckpointMigration(input: {
  saver: SqlJsSaver
  config: RunnableConfig
  snapshotConfig?: RunnableConfig
  messages: readonly BaseMessage[]
  assertCurrent(): void
}): Promise<() => void> {
  const { saver, messages } = input
  if (!(saver instanceof SqlJsSaver)) fail()
  const fixed = { configurable: { ...input.config.configurable } }
  const point = fixed.configurable
  const snapshot = input.snapshotConfig?.configurable
  if (!snapshot || typeof point.checkpoint_id !== "string" || !point.checkpoint_id ||
    snapshot?.thread_id !== point.thread_id ||
    (snapshot.checkpoint_ns ?? "") !== (point.checkpoint_ns ?? "") ||
    snapshot.checkpoint_id !== point.checkpoint_id) fail()
  const before = ordinaryHistory(messages, input.assertCurrent)
  input.assertCurrent()
  const { tuple, assertCurrent: assertEvidence } =
    await SqlJsSaver.prototype.getExactTupleForLegacyMigration.call(saver, fixed)
  input.assertCurrent()
  if (!tuple || tuple.config.configurable?.thread_id !== point.thread_id ||
    (tuple.config.configurable?.checkpoint_ns ?? "") !== (point.checkpoint_ns ?? "") ||
    tuple.config.configurable?.checkpoint_id !== point.checkpoint_id ||
    tuple.checkpoint.id !== point.checkpoint_id ||
    tuple.checkpoint.channel_values.cmbFunctionConversation !== undefined) fail()
  const stored = tuple.checkpoint.channel_values.messages ?? []
  if (!Array.isArray(stored)) fail()
  const lifetime = assertEvidence
  const original = ordinaryHistory(stored, input.assertCurrent)
  const current = ordinaryHistory(messages, input.assertCurrent)
  if (original.length !== before.length || current.length !== before.length ||
    original.some((value, index) => value !== before[index] || value !== current[index])) fail()
  // The verifier stays live across intake/protection awaits. It retains no UI or
  // SDK authority, and no checkpoint channel or persisted message is rewritten.
  return () => {
    lifetime()
    const next = ordinaryHistory(messages, lifetime)
    if (next.length !== original.length || next.some((value, index) => value !== original[index]))
      fail()
    lifetime()
  }
}
