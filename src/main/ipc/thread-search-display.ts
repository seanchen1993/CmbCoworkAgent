import { nativeFunctionConversationWorkspace } from "../checkpointer/function-conversation-main-recovery"
import { getDb, getThreadRuntimeScope } from "../db"
import { getModsManager } from "../mods/manager"

/** Search workers read persisted text directly. Only the normal transcript readers can verify
 * native rows and publish text through the applicable output policy. */
export function canReadThreadSearchContent(threadId: string): boolean {
  try {
    const scope = getThreadRuntimeScope(threadId)
    if (!scope) return false
    const workspace = nativeFunctionConversationWorkspace(scope.metadata)
    if (getModsManager()?.protects(workspace ?? "")) return false
    const database = getDb()
    if (
      database.prepareReadOne(
        "SELECT 1 AS found FROM thread_messages WHERE thread_id=? AND function_row_json IS NOT NULL LIMIT 1"
      )([threadId])
    )
      return false
    const hasReceipts = database.prepareReadOne(
      "SELECT 1 AS found FROM sqlite_schema WHERE type='table' " +
        "AND name='function_conversation_projection_receipts'"
    )([])
    return (
      !hasReceipts ||
      !database.prepareReadOne(
        "SELECT 1 AS found FROM function_conversation_projection_receipts WHERE thread_id=? LIMIT 1"
      )([threadId])
    )
  } catch {
    // A policy or provenance failure cannot authorize a raw snippet.
    return false
  }
}
