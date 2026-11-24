import type { Message } from "@/types"
import { parseBotFileDelivery } from "../../../shared/bots/file-delivery"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"

/** Successful delivery cards already present before each assistant reply in the same turn.
 * Exact paths only: unrelated turns, failed calls and prose must not suppress a file card.
 */
export function botDeliveredFileReferences(
  messages: readonly Message[]
): Map<string, ReadonlySet<string>> {
  const references = new Map<string, ReadonlySet<string>>()
  const results = buildToolResultAssociations(messages)
  let delivered: ReadonlySet<string> = new Set()
  for (const message of messages) {
    if (message.role === "user") delivered = new Set()
    if (message.role !== "assistant") continue
    if (delivered.size) references.set(message.id, delivered)
    for (const [index, tool] of (message.tool_calls ?? []).entries()) {
      if (tool.name !== "bot_deliver_files") continue
      const result = results.get(getWorkerToolUiKey(message.id, tool.id, index))
      const files = result && !result.is_error ? parseBotFileDelivery(result.content) : null
      if (files) delivered = new Set([...delivered, ...files.map((file) => file.filePath)])
    }
  }
  return references
}
