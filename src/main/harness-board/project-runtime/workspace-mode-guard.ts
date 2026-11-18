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

  run<T>(mode: "host" | "legacy", workspace: string, work: () => T, executionWorkspace?: string): T {
    mkdirSync(dirname(this.lockDatabasePath), { recursive: true })
    const lock = new DatabaseSync(this.lockDatabasePath, { timeout: 5000 })
    try {
      lock.exec("CREATE TABLE IF NOT EXISTS workspace_mode_mutex (id INTEGER PRIMARY KEY)")
      lock.exec("BEGIN IMMEDIATE")
      try {
        this.assertNoOppositeBinding(mode, workspace)
        if (executionWorkspace && executionWorkspace !== workspace)
          this.assertNoOppositeBinding(mode, executionWorkspace)
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
      const query = mode === "host"
        ? `SELECT json_extract(data,'$.workspace') AS workspace FROM legacy_bindings
           UNION SELECT json_extract(data,'$.executionWorkspace') AS workspace FROM legacy_operations
           WHERE status IN ('started','unknown') AND json_type(data,'$.executionWorkspace') IS NOT NULL`
        : "SELECT json_extract(data,'$.workspace') AS workspace FROM host_projects"
      const key = (value: string) =>
        process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value)
      const target = key(workspace)
      for (const row of database
        .prepare(query)
        .iterate()) {
        if (typeof row.workspace !== "string") throw Error("PROJECT_WORKSPACE_BINDING_INVALID")
        if (key(row.workspace) === target) throw Error("PROJECT_WORKSPACE_MODE_CONFLICT")
      }
    } finally {
      database.close()
    }
  }
}
