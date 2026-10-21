import type { RunnableConfig } from "@langchain/core/runnables"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { hasInvalidFunctionConversationTranscriptStamp,
  readFunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import {
  FUNCTION_CONVERSATION_CHANNEL,
  FunctionConversationDeliveryBridge,
  type FunctionConversationDeliveryBinding
} from "./function-conversation-delivery"
import { wrapNativeLegacyHistory } from "./native-legacy-history"
import { SqlJsSaver } from "./sqljs-saver"

/** A host-local idle mutation uses its own admission, never a completed physical run's proof. */
export function createFunctionConversationIdleEditor(
  saver: SqlJsSaver,
  store: FunctionConversationStore,
  binding: FunctionConversationDeliveryBinding,
  onCommitted?: () => void
): SqlJsSaver {
  const assertCurrent = () => {
    binding.signal.throwIfAborted()
    binding.assertCurrent()
    store.assertCurrent(binding.target)
    binding.signal.throwIfAborted()
  }
  const assertScope = (config: RunnableConfig) => {
    assertCurrent()
    if (config.configurable?.thread_id !== binding.checkpointThreadId ||
      (config.configurable?.checkpoint_ns ?? "") !== binding.target.checkpointNamespace)
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  }
  assertCurrent()
  const bridge = new FunctionConversationDeliveryBridge(store, () => binding)
  const observer = bridge.bindSaver(saver)
  const wrapped = wrapNativeLegacyHistory(saver, bridge.wrap(saver, assertCurrent, onCommitted), {
    threadId: binding.checkpointThreadId,
    namespace: binding.target.checkpointNamespace,
    assertCurrent
  })
  return new Proxy(wrapped, {
    get(target, key) {
      if (key === "getTuple") return async (config: RunnableConfig) => {
        assertScope(config)
        let tuple = await target.getTuple(config)
        assertCurrent()
        if (tuple?.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL] !== undefined)
          tuple = await observer.readVerifiedRecovery(tuple.config, binding)
        else if (Array.isArray(tuple?.checkpoint.channel_values.messages) &&
          tuple.checkpoint.channel_values.messages.some(message =>
            hasInvalidFunctionConversationTranscriptStamp(message) ||
            readFunctionConversationTranscriptStamp(message)))
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        assertCurrent()
        return tuple
      }
      if (key === "put") return async (...args: Parameters<SqlJsSaver["put"]>) => {
        assertScope(args[0])
        if (args[1].channel_values[FUNCTION_CONVERSATION_CHANNEL] === undefined)
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        const result = await target.put(...args)
        assertCurrent()
        return result
      }
      if (key === "putWrites") return async (...args: Parameters<SqlJsSaver["putWrites"]>) => {
        assertScope(args[0])
        await SqlJsSaver.prototype.putWrites.call(saver, args[0], args[1], args[2], assertCurrent)
        assertCurrent()
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
}
