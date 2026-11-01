import type { NativeSqliteAdapter } from "./native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import { deleteThreadCheckpoint } from "../storage"

const active = new WeakMap<NativeSqliteAdapter, Map<string, AbortController>>()
export function registerOwnedAgentCancellation(
  db: NativeSqliteAdapter,
  child: string,
  controller: AbortController
) {
  let entries = active.get(db)
  if (!entries) active.set(db, (entries = new Map()))
  entries.set(child, controller)
  return () => {
    if (entries!.get(child) === controller) entries!.delete(child)
  }
}

/** Retire owned children while their native parent/family identity is still available. */
export function cleanupOwnedAgentChildren(
  db: NativeSqliteAdapter,
  parent: string,
  remove: (id: string) => void
) {
  if (
    !db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='mods_owned_agents'")[0]
      ?.values.length
  )
    return
  const found = db.exec("SELECT child_id,data FROM mods_owned_agents WHERE parent_id=?", [
    parent
  ])[0]
  const children: string[] = []
  for (const values of found?.values ?? []) {
    const child = String(values[0])
    const record = JSON.parse(String(values[1])) as { child: string; childIncarnation: string }
    const row = db.exec("SELECT created_at,metadata FROM threads WHERE thread_id=?", [child])[0]
      ?.values[0]
    if (!row) continue
    if (
      record.child !== child ||
      JSON.stringify(
        captureThreadIncarnation({ created_at: Number(row[0]), metadata: String(row[1]) })
      ) !== record.childIncarnation
    )
      throw Error("MODS_AGENT_OWNER_CHANGED")
    children.push(child)
  }
  for (const child of children)
    active.get(db)?.get(child)?.abort(new Error("MODS_AGENT_PARENT_DELETED"))
  if (children.some((child) => getLocalThreadRunLease(child)))
    throw Error("MODS_AGENT_CHILD_RUNNING: 子任务正在停止，请等待结算后重试删除聊天。")
  for (const child of children) {
    deleteThreadCheckpoint(child)
    remove(child)
  }
  db.run("DELETE FROM mods_owned_agents WHERE parent_id=? OR child_id=?", [parent, parent])
}
