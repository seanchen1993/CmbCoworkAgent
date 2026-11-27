import { getUserInfo } from "../storage"
import type { NativeSqliteAdapter } from "./native-sqlite-adapter"
import { normalizeWorkspacePathKey } from "../../shared/workspace-path"
import { readChatProject, type ChatProject } from "../../shared/chat-project"

type ChatEventProject = {
  generationMode: "chat"
  projectCode: string | null
  projectFromLean: boolean
}
let activeDatabase: NativeSqliteAdapter | null = null
// Consecutive file edits and commit measurements usually share the same root.
let lastSnapshot: { id: string; owner?: string; fields?: ChatEventProject } | undefined

export function closeChatProjectSnapshots(): void {
  activeDatabase = null
  lastSnapshot = undefined
}

export function chatProjectEventSnapshot(
  id: unknown,
  owner?: string
): ChatEventProject | undefined {
  if (!activeDatabase || typeof id !== "string" || !id) return
  if (lastSnapshot?.id === id && lastSnapshot.owner === owner) return lastSnapshot.fields
  try {
    const row = activeDatabase.exec(
      "SELECT sap_id,code,lean FROM chat_project_bindings WHERE thread_id=? AND mode='chat'",
      [id]
    )[0].values[0]
    const fields =
      row && (!row[0] || row[0] === owner)
        ? {
            generationMode: "chat" as const,
            projectCode: row[1] as string | null,
            projectFromLean: row[2] === 1
          }
        : undefined
    lastSnapshot = { id, owner, fields }
    return fields
  } catch {
    // The durable root ID still supports attribution when the catalog cannot be read.
    return undefined
  }
}

export function initializeChatProjectTables(db: NativeSqliteAdapter): void {
  db.run(`CREATE TABLE IF NOT EXISTS workspace_project_defaults (
    path TEXT PRIMARY KEY, code TEXT NOT NULL, lean INTEGER NOT NULL, name TEXT);
    CREATE TABLE IF NOT EXISTS chat_project_bindings (
      thread_id TEXT PRIMARY KEY, sap_id TEXT, mode TEXT NOT NULL, code TEXT, lean INTEGER NOT NULL,
      revision INTEGER NOT NULL, next_attempt INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_chat_project_delivery ON chat_project_bindings(next_attempt)
      WHERE next_attempt IS NOT NULL`)
  const columns = db.exec("PRAGMA table_info(workspace_project_defaults)")[0].values
  if (!columns.some((column) => column[1] === "name"))
    db.run("ALTER TABLE workspace_project_defaults ADD COLUMN name TEXT")
  activeDatabase = db
  lastSnapshot = undefined
}

export function workspaceProject(db: NativeSqliteAdapter, path: unknown): ChatProject | null {
  if (typeof path !== "string" || !path.trim()) return null
  const row = db.exec("SELECT code,lean,name FROM workspace_project_defaults WHERE path=?", [
    normalizeWorkspacePathKey(path)
  ])[0]?.values[0]
  return row ? readChatProject({ code: row[0], fromLean: row[1] === 1, name: row[2] }) : null
}

export function saveWorkspaceProject(
  db: NativeSqliteAdapter,
  path: string,
  project: ChatProject | null
) {
  if (typeof path !== "string" || !path.trim() || path.length > 32768)
    throw new Error("工作区路径无效")
  const key = normalizeWorkspacePathKey(path)
  if (project)
    db.run("INSERT OR REPLACE INTO workspace_project_defaults(path,code,lean,name) VALUES (?,?,?,?)", [
      key,
      project.code,
      Number(project.fromLean),
      project.name ?? null
    ])
  else db.run("DELETE FROM workspace_project_defaults WHERE path=?", [key])
}

// One pending revision per session. An older in-flight delivery can never acknowledge a newer edit.
export function saveChatBinding(
  db: NativeSqliteAdapter,
  id: string,
  mode: "chat" | "project",
  project: ChatProject | null,
  onlyIfMissing = false
): void {
  if (
    onlyIfMissing &&
    db.exec("SELECT 1 FROM chat_project_bindings WHERE thread_id=?", [id])[0].values.length
  )
    return
  // Preserve the account even if the machine is logged into a different account at retry time.
  // A new local installation can create a thread before its identity is available.
  let sapId: string | null = null
  try {
    sapId = getUserInfo()?.sapId || null
  } catch {
    /* account is not available yet */
  }
  db.run(
    `INSERT INTO chat_project_bindings(thread_id,sap_id,mode,code,lean,revision,next_attempt)
    VALUES (?,?,?,?,?,?,0) ON CONFLICT(thread_id) ${
      onlyIfMissing
        ? "DO NOTHING"
        : `DO UPDATE SET
    sap_id=COALESCE(chat_project_bindings.sap_id,excluded.sap_id),
    mode=excluded.mode,code=excluded.code,lean=excluded.lean,
    revision=max(chat_project_bindings.revision+1,excluded.revision),next_attempt=0,attempts=0
    WHERE mode!=excluded.mode OR code IS NOT excluded.code OR lean!=excluded.lean`
    }`,
    [id, sapId, mode, project?.code ?? null, Number(project?.fromLean ?? false), Date.now()]
  )
  if (lastSnapshot?.id === id) lastSnapshot = undefined
}
