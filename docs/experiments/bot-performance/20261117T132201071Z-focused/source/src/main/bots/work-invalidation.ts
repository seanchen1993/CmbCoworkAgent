import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { BotWorkChange } from "../../shared/bots/contracts"

/** Connection-local invalidations follow the same transaction/rollback as their writes.
 * No transcript payload, persisted migration, polling or per-task event listeners.
 */
export class BotWorkInvalidations {
  constructor(private db: NativeSqliteAdapter, private rows: (sql: string) => Record<string, unknown>[]) {
    db.run(`CREATE TEMP TABLE IF NOT EXISTS bot_work_changes (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, audience TEXT NOT NULL, removed INTEGER NOT NULL)`)
    const upsert = "ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id,audience=excluded.audience,removed=excluded.removed"
    const record = (where: string) => `INSERT INTO bot_work_changes
      SELECT id,bot_id,audience_key,detached FROM bot_work_items WHERE ${where} ${upsert};`
    const related = (row: string) => `id IN (SELECT work_id FROM bot_tasks WHERE id=${row}.source_task_id
      UNION SELECT json_extract(origin_json,'$.rootWorkId') FROM bot_tasks WHERE id=${row}.source_task_id)`
    const sources = {
      bot_work_items: (row: string, deleted: boolean) => `INSERT INTO bot_work_changes
        VALUES(${row}.id,${row}.bot_id,${row}.audience_key,${deleted ? 1 : `${row}.detached`}) ${upsert};`,
      bot_tasks: (row: string) => record(`id IN (${row}.work_id,json_extract(${row}.origin_json,'$.rootWorkId'))`),
      bot_activity: (row: string) => record(`${row}.kind='work' AND id=${row}.id`),
      bot_commands: (row: string) => record(`thread_id=${row}.thread_id OR ${related(row)}`),
      bot_workflow_refs: (row: string) => record(related(row))
    }
    for (const [table, body] of Object.entries(sources))
      for (const action of ["INSERT", "UPDATE", "DELETE"])
        db.run(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_invalidate_${action}
          AFTER ${action} ON main.${table} BEGIN
          ${action === "INSERT" ? "" : body("old", action === "DELETE")}
          ${action === "DELETE" ? "" : body("new", false)} END`)
  }

  mark(workId: string) {
    this.db.run(`INSERT OR REPLACE INTO bot_work_changes SELECT id,bot_id,audience_key,detached
      FROM bot_work_items WHERE id=?`, [workId])
  }

  take(): BotWorkChange[] {
    const scopes = new Map<string, BotWorkChange>()
    for (const row of this.rows("SELECT * FROM bot_work_changes")) {
      const key = JSON.stringify([row.bot_id, row.audience])
      let scope = scopes.get(key)
      if (!scope) {
        scope = { botId: String(row.bot_id), audience: String(row.audience), workIds: [], removedIds: [] }
        scopes.set(key, scope)
      }
      if (scope.reset) continue
      if (scope.workIds.length + scope.removedIds.length >= 200) {
        scope.reset = true
        scope.workIds = []
        scope.removedIds = []
      } else (row.removed ? scope.removedIds : scope.workIds).push(String(row.id))
    }
    this.db.run("DELETE FROM bot_work_changes")
    return [...scopes.values()]
  }
}
