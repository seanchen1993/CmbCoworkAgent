import type { BaseMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import {
  assertFunctionConversationState,
  readFunctionConversationState,
  type FunctionConversationDeliveryBinding,
  type FunctionConversationState
} from "./function-conversation-delivery"
import {
  captureMissingConversationCheckpointMembership,
  restoreMissingConversationCheckpointMessages
} from "./function-conversation-checkpoint-membership"
import {
  SqlJsSaver,
  type SqlJsSaverFunctionConversationRecoveryReceipt
} from "./sqljs-saver"

export interface FunctionConversationMissingRecoveryOptions {
  readonly store: FunctionConversationStore
  readonly saver: SqlJsSaver
  readonly receipt: SqlJsSaverFunctionConversationRecoveryReceipt
  /** Original host DB/namespace/incarnation selector. No UI/SDK authority is minted here. */
  readonly capture: (
    exactConfig: RunnableConfig,
    state: FunctionConversationState
  ) => FunctionConversationDeliveryBinding | undefined
}

/** Run only from the actual Saver's missing-snapshot callback while its native gate is held. */
export function recoverMissingFunctionConversationMessages(
  options: FunctionConversationMissingRecoveryOptions
): readonly BaseMessage[] {
  const { store, saver, receipt } = options
  const raw = SqlJsSaver.prototype.readFunctionConversationRecoveryCheckpoint.call(saver, receipt)
  const state = readFunctionConversationState(raw.checkpoint.channel_values.cmbFunctionConversation)
  const actual = options.capture(raw.config, state)
  if (!actual) throw new ModFunctionError("MODS_CONVERSATION_RECOVERY_REQUIRED")
  const target = actual.target, signal = actual.signal, threadId = actual.checkpointThreadId
  const assertCurrent = actual.assertCurrent.bind(actual)
  const incarnation = actual.checkpointIncarnation ??
    (threadId === target.threadId ? target.incarnation : undefined)
  if (!incarnation || raw.config.configurable?.thread_id !== threadId ||
    raw.config.configurable?.checkpoint_ns !== target.checkpointNamespace)
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  const guard = () => {
    signal.throwIfAborted()
    assertCurrent()
    store.assertCurrent(target)
    assertFunctionConversationState(target, state)
  }
  guard()
  const proof = captureMissingConversationCheckpointMembership(store, saver, receipt, {
    target, checkpointThreadId: threadId, checkpointIncarnation: Object.freeze({ ...incarnation }),
    signal, assertCurrent: guard
  })
  const messages = restoreMissingConversationCheckpointMessages(proof)
  guard()
  return messages
}
