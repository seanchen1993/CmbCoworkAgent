import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { types } from "node:util"
import { SqlJsSaver } from "./sqljs-saver"
import { captureMessage, constructCapturedNativeMessage } from "../agent/native-message-capture-data"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

const nativeRead = SqlJsSaver.prototype.getTuple

/**
 * Legacy persisted graph history is data, not a newly completed model occurrence. Only the
 * actual SQLite reader can reach this conversion; submitted inputs and pending writes cannot.
 * The first protected graph commit naturally stores the full message class. No DB repair,
 * append permission, completed slot or provider receipt is manufactured here.
 */
export function wrapNativeLegacyHistory(
  saver: SqlJsSaver,
  wrapped: SqlJsSaver,
  scope: { threadId: string; namespace: string; assertCurrent(): void }
): SqlJsSaver {
  const threadId = scope.threadId, namespace = scope.namespace
  const guard = scope.assertCurrent.bind(scope)
  if (types.isProxy(saver) || Object.getPrototypeOf(saver) !== SqlJsSaver.prototype)
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
  const read = async (config: RunnableConfig) => {
    guard()
    const fixed = { ...config, configurable: { ...config.configurable } }
    // Child namespaces retain their own adapters and must not inherit this conversion.
    if (fixed.configurable.thread_id !== threadId ||
      (fixed.configurable.checkpoint_ns ?? "") !== namespace)
      return nativeRead.call(saver, fixed)
    const tuple = await nativeRead.call(saver, fixed)
    guard()
    if (!tuple || tuple.checkpoint.channel_values.cmbFunctionConversation !== undefined) return tuple
    if (tuple.config.configurable?.thread_id !== threadId ||
      (tuple.config.configurable?.checkpoint_ns ?? "") !== namespace ||
      tuple.config.configurable?.checkpoint_id !== tuple.checkpoint.id)
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    const messages = tuple.checkpoint.channel_values.messages
    if (!Array.isArray(messages)) return tuple
    let changed = false
    const normalized = messages.map((message: BaseMessage, index) => {
      guard()
      if (!message || typeof message !== "object" || types.isProxy(message))
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      if (Object.getPrototypeOf(message) !== AIMessageChunk.prototype) return message
      const captured = captureMessage(message, guard, `legacy-checkpoint:${index}`, "checkpoint")
      const data = { ...captured.snapshot.data }
      const additional = data.additional_kwargs
      if (captured.snapshot.executionSuppressed || (additional && typeof additional === "object" &&
        (Object.hasOwn(additional, "function_row") || Object.hasOwn(additional, "function_row_invalid"))))
        throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
      const metadata = data.response_metadata
      if (metadata && typeof metadata === "object" &&
        Object.getOwnPropertyDescriptor(metadata, "output_version")?.value === "v1") {
        if (!Array.isArray(data.content) || Object.hasOwn(data, "content_blocks") ||
          (Object.hasOwn(data, "contentBlocks") &&
            JSON.stringify(data.contentBlocks) !== JSON.stringify(data.content)))
          throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        data.contentBlocks = data.content
      }
      const full = constructCapturedNativeMessage("ai", data)
      Object.defineProperty(full, "id", { value: captured.originalId, enumerable: true,
        writable: true, configurable: true })
      changed = true
      return full
    })
    guard()
    return changed ? { ...tuple, checkpoint: { ...tuple.checkpoint,
      channel_values: { ...tuple.checkpoint.channel_values, messages: normalized } } } : tuple
  }
  const methods = new Map<PropertyKey, unknown>()
  return new Proxy(wrapped, { get(target, key) {
    if (key === "getTuple") return read
    const value = Reflect.get(target, key, target)
    if (typeof value !== "function") return value
    if (!methods.has(key)) methods.set(key, value.bind(target))
    return methods.get(key)
  } })
}
