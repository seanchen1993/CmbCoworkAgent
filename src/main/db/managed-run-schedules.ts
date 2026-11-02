import type { ManagedRunSchedule } from "../../shared/managed-run-schedule"
import type { NativeSqliteAdapter } from "./native-sqlite-adapter"

export function ensureManagedRunSchedulesSchema(database: NativeSqliteAdapter): void {
  database.run(`CREATE TABLE IF NOT EXISTS managed_run_schedules (
    schedule_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    initial_user_message TEXT,
    existing_thread_id TEXT,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'starting', 'failed', 'missed')),
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, feature_id)
  )`)
  database.run(`CREATE INDEX IF NOT EXISTS idx_managed_run_schedules_due
    ON managed_run_schedules (status, scheduled_at)`)
}

const SELECT_COLUMNS = `schedule_id, project_id, feature_id, workspace_path,
  initial_user_message, existing_thread_id, scheduled_at, status, failure_reason, created_at, updated_at`

export class ManagedRunScheduleStore {
  constructor(private readonly getDatabase: () => NativeSqliteAdapter) {}

  private select(where: string, parameters: string[]): ManagedRunSchedule[] {
    const result = this.getDatabase().exec(
      `SELECT ${SELECT_COLUMNS} FROM managed_run_schedules ${where}`,
      parameters
    )[0]
    return (result?.values ?? []).map((row) => ({
      scheduleId: String(row[0]),
      projectId: String(row[1]),
      featureId: String(row[2]),
      workspacePath: String(row[3]),
      initialUserMessage: row[4] === null ? undefined : String(row[4]),
      existingThreadId: row[5] === null ? undefined : String(row[5]),
      scheduledAt: String(row[6]),
      status: row[7] as ManagedRunSchedule["status"],
      failureReason: row[8] === null ? undefined : String(row[8]),
      createdAt: String(row[9]),
      updatedAt: String(row[10])
    }))
  }

  get(projectId: string, featureId: string): ManagedRunSchedule | null {
    return this.select("WHERE project_id = ? AND feature_id = ?", [projectId, featureId])[0] ?? null
  }

  listActive(): ManagedRunSchedule[] {
    return this.select("WHERE status IN ('pending', 'starting')", [])
  }

  due(now: string): ManagedRunSchedule[] {
    return this.select(
      "WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at, schedule_id",
      [now]
    )
  }

  interrupted(now: string): ManagedRunSchedule[] {
    return this.select("WHERE status = 'starting' OR (status = 'pending' AND scheduled_at <= ?)", [
      now
    ])
  }

  hasActiveProject(projectId: string): boolean {
    return Boolean(
      this.getDatabase().exec(
        "SELECT 1 FROM managed_run_schedules WHERE project_id = ? AND status IN ('pending', 'starting') LIMIT 1",
        [projectId]
      )[0]?.values.length
    )
  }

  insert(row: ManagedRunSchedule): void {
    this.getDatabase().run(
      `INSERT INTO managed_run_schedules (${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.scheduleId,
        row.projectId,
        row.featureId,
        row.workspacePath,
        row.initialUserMessage,
        row.existingThreadId,
        row.scheduledAt,
        row.status,
        row.failureReason,
        row.createdAt,
        row.updatedAt
      ]
    )
  }

  update(row: ManagedRunSchedule): void {
    this.getDatabase().run(
      `UPDATE managed_run_schedules SET scheduled_at = ?, status = ?, failure_reason = ?, updated_at = ?
       WHERE schedule_id = ? AND project_id = ? AND feature_id = ?`,
      [
        row.scheduledAt,
        row.status,
        row.failureReason,
        row.updatedAt,
        row.scheduleId,
        row.projectId,
        row.featureId
      ]
    )
  }

  remove(row: ManagedRunSchedule): void {
    this.getDatabase().run(
      "DELETE FROM managed_run_schedules WHERE schedule_id = ? AND project_id = ? AND feature_id = ?",
      [row.scheduleId, row.projectId, row.featureId]
    )
  }

  removeProject(projectId: string): void {
    this.getDatabase().run("DELETE FROM managed_run_schedules WHERE project_id = ?", [projectId])
  }
}
