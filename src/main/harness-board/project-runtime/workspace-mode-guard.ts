import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** One shared mutex serializes actual configuration commits across both databases/processes. */
export class ProjectWorkspaceModeGuard {
  constructor(
    private readonly hostDatabasePath: string,
    private readonly legacyDatabasePath: string,
    private readonly lockDatabasePath: string
  ) {}

  run<T>(mode: "host" | "legacy", workspace: string, work: () => T): T {
    mkdirSync(dirname(this.lockDatabasePath), { recursive: true })
    const lock = new DatabaseSync(this.lockDatabasePath, { timeout: 5000 })
    try {
      lock.exec("CREATE TABLE IF NOT EXISTS workspace_mode_mutex (id INTEGER PRIMARY KEY)")
      lock.exec("BEGIN IMMEDIATE")
      try {
        this.assertNoOppositeBinding(mode, workspace)
        const result = work()
        lock.exec("COMMIT")
        return result
      } catch (error) {
        lock.exec("ROLLBACK")
        throw error
      }
    } finally {
      lock.close()
    }
  }

  private assertNoOppositeBinding(mode: "host" | "legacy", workspace: string): void {
    const path = mode === "host" ? this.legacyDatabasePath : this.hostDatabasePath
    if (!existsSync(path)) return
    const database = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
    try {
      const table = mode === "host" ? "legacy_bindings" : "host_projects"
      const key = (value: string) =>
        process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value)
      const target = key(workspace)
      for (const row of database
        .prepare(`SELECT json_extract(data,'$.workspace') AS workspace FROM ${table}`)
        .iterate()) {
        if (typeof row.workspace !== "string") throw Error("PROJECT_WORKSPACE_BINDING_INVALID")
        if (key(row.workspace) === target) throw Error("PROJECT_WORKSPACE_MODE_CONFLICT")
      }
    } finally {
      database.close()
    }
  }
}
