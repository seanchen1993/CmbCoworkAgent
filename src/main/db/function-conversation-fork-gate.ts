import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import type { NativeSqliteAdapter } from "./native-sqlite-adapter"

const denied = new WeakMap<NativeSqliteAdapter, Set<string>>()
type Target = { readonly threadId: string; readonly incarnation: ThreadIncarnation }

function targetKey(target: Target): string {
  return JSON.stringify([target.threadId, target.incarnation.token === null
    ? ["legacy", target.incarnation.legacyCreatedAt] : ["token", target.incarnation.token]])
}

/** Native revocation only. A failed backend must not be reopened by a later ready journal read. */
export function denyFunctionConversationForkReady(database: NativeSqliteAdapter,
  target: Target): void {
  let entries = denied.get(database)
  if (!entries) { entries = new Set(); denied.set(database, entries) }
  entries.add(targetKey(target))
}

/** Read-only native gate, also available before a canonical Store or Saver is constructed. */
export function assertFunctionConversationForkReady(database: NativeSqliteAdapter, target: {
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
}): void {
  if (denied.get(database)?.has(targetKey(target)))
    throw new ModFunctionError("MODS_CONVERSATION_FORK_PREPARING")
  const exists = database.exec(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='function_conversation_fork_imports'"
  )[0]?.values.length
  if (!exists) return
  const key = JSON.stringify(target.incarnation.token === null
    ? ["legacy", target.incarnation.legacyCreatedAt] : ["token", target.incarnation.token])
  const status = database.exec(`SELECT status FROM function_conversation_fork_imports
    WHERE target_thread_id=? AND target_incarnation=?`, [target.threadId, key])[0]?.values[0]?.[0]
  if (status !== undefined && status !== "ready")
    throw new ModFunctionError("MODS_CONVERSATION_FORK_PREPARING")
}
