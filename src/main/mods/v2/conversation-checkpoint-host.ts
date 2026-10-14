import { existsSync } from "node:fs"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { peekThreadCheckpointPath } from "../../storage"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { FUNCTION_CONVERSATION_CHANNEL, readFunctionConversationState } from
  "../../checkpointer/function-conversation-delivery"
import type { FunctionConversationCurrentCheckpoint } from "./conversation-coordinator"

/** A current read starts at native admission; historical recovery must use its original ID. */
export async function readCurrentFunctionConversationCheckpoint(threadId: string,
  signal: AbortSignal, assertCurrent: () => void): Promise<FunctionConversationCurrentCheckpoint | null> {
  const guard = () => { signal.throwIfAborted(); assertCurrent() }
  guard()
  const path = peekThreadCheckpointPath(threadId)
  if (!existsSync(path)) return null
  const saver = new SqlJsSaver(path)
  try {
    const tuple = await SqlJsSaver.prototype.getTuple.call(saver,
      { configurable: { thread_id: threadId, checkpoint_ns: "" } })
    guard()
    if (!tuple) return null
    if (tuple.config.configurable?.thread_id !== threadId ||
      (tuple.config.configurable?.checkpoint_ns ?? "") !== "")
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_SCOPE")
    const values = tuple.checkpoint.channel_values
    const messages = values.messages
    if (messages !== undefined && !Array.isArray(messages))
      throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED")
    const raw = values[FUNCTION_CONVERSATION_CHANNEL]
    return { checkpointId: tuple.checkpoint.id,
      ...(raw !== undefined ? { state: readFunctionConversationState(raw) } : {}),
      messages: messages ?? [] }
  } finally {
    await saver.close()
    guard()
  }
}
