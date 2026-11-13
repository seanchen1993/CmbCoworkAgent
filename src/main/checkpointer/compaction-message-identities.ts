import { BaseMessage, RemoveMessage } from "@langchain/core/messages"
import { messagesStateReducer, REMOVE_ALL_MESSAGES } from "@langchain/langgraph"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

/** Execute the installed SDK's exact idle-update identity preparation before hashing.
 * Its RemoveAll branch preserves existing duplicate IDs and message object references.
 */
export function prepareCompactionMessageIdentities(value: unknown): readonly BaseMessage[] {
  if (!Array.isArray(value) || value.some(message =>
    !BaseMessage.isInstance(message) || RemoveMessage.isInstance(message)))
    throw new ModFunctionError("MODS_CONVERSATION_COMPACTION_BOUNDARY")
  const original = value.slice() as BaseMessage[]
  const prepared = messagesStateReducer([], [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...original])
  if (prepared.length !== original.length || prepared.some((message, index) => message !== original[index]))
    throw new ModFunctionError("MODS_CONVERSATION_COMPACTION_BOUNDARY")
  return Object.freeze(prepared)
}
