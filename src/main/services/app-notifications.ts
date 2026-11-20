import type { AppNotification } from "../../shared/app-notifications"
import { getDb } from "../db"

export interface NotificationCursor { timestamp: string; id: string }
const TERMINAL_MESSAGES = "status IN ('resolved', 'invalidated')"
const PAGE_SIZE = 200

/** Persistence only: no channels, callbacks, domain rules, or Journal access. */
class AppNotificationStore {
  private query(sql: string, parameters: (string | number)[] = [], paginated = false): {
    values: AppNotification[]; cursor?: NotificationCursor; count: number
  } {
    const statement = getDb().prepare(sql)
    try {
      statement.bind(parameters)
      const values: AppNotification[] = []
      let cursor: NotificationCursor | undefined
      let count = 0
      while (statement.step()) {
        const row = statement.getAsObject()
        count += 1
        if (paginated) cursor = { timestamp: String(row.page_time), id: String(row.notification_id) }
        try {
          const envelope = JSON.parse(String(row.envelope_json))
          if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !Array.isArray(envelope.targets)) continue
          values.push({
            ...envelope,
            notificationId: String(row.notification_id), kind: row.kind, type: row.source_type,
            status: row.status, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
            completedAt: row.completed_at == null ? undefined : String(row.completed_at)
          })
        } catch (error) {
          console.warn("[Notifications] Unreadable record:", row.notification_id, error)
        }
      }
      return { values, cursor, count }
    } finally {
      statement.free()
    }
  }
  private envelope(value: AppNotification): string {
    return JSON.stringify({
      targets: value.targets, disabledTargets: value.disabledTargets,
      title: value.title, message: value.message, payload: value.payload,
      action: value.action, channel: value.channel,
      reasonCode: value.reasonCode, result: value.result
    })
  }
  get(id: string): AppNotification | undefined {
    return this.query("SELECT * FROM app_messages WHERE notification_id = ?", [id]).values[0]
  }
  recoveryPage(kind: "pending" | "terminal", cutoff: string, cursor?: NotificationCursor, limit = PAGE_SIZE) {
    const column = kind === "pending" ? "created_at" : "completed_at"
    const where = kind === "pending" ? "kind = 'decision' AND status = 'pending'"
      : `${TERMINAL_MESSAGES} AND completed_at >= ?`
    const parameters: (string | number)[] = kind === "pending" ? [] : [cutoff]
    if (cursor) parameters.push(cursor.timestamp, cursor.id)
    parameters.push(limit)
    return this.query(`SELECT *, ${column} AS page_time FROM app_messages
      ${kind === "terminal" ? "INDEXED BY idx_app_messages_terminal" : ""} WHERE ${where}
      ${cursor ? `AND (${column}, notification_id) < (?, ?)` : ""}
      ORDER BY ${column} DESC, notification_id DESC LIMIT ?`, parameters, true)
  }
  deleteExpiredBatch(cutoff: string): number {
    const db = getDb()
    db.run(`DELETE FROM app_messages WHERE notification_id IN (
      SELECT notification_id FROM app_messages INDEXED BY idx_app_messages_terminal
      WHERE ${TERMINAL_MESSAGES}
      AND completed_at < ? ORDER BY completed_at, notification_id LIMIT ?
    )`, [cutoff, PAGE_SIZE])
    return db.getRowsModified()
  }
  deleteOverflowBatch(keep: number): number {
    const db = getDb()
    db.run(`DELETE FROM app_messages WHERE notification_id IN (
      SELECT notification_id FROM app_messages INDEXED BY idx_app_messages_terminal
      WHERE ${TERMINAL_MESSAGES}
      ORDER BY completed_at DESC, notification_id DESC LIMIT ? OFFSET ?
    )`, [PAGE_SIZE, keep])
    return db.getRowsModified()
  }
  pending(): AppNotification[] {
    return this.query("SELECT * FROM app_messages WHERE kind = 'decision' AND status = 'pending' ORDER BY created_at DESC, notification_id DESC").values
  }
  insert(value: AppNotification): void {
    getDb().run(`INSERT INTO app_messages
      (notification_id, kind, source_type, status, envelope_json, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [value.notificationId, value.kind, value.type, value.status,
      this.envelope(value), value.createdAt, value.updatedAt, value.completedAt ?? null])
  }
  updatePending(value: AppNotification): boolean {
    const db = getDb()
    db.run(`UPDATE app_messages SET status = ?, envelope_json = ?, updated_at = ?, completed_at = ?
      WHERE notification_id = ? AND status = 'pending'`,
    [value.status, this.envelope(value), value.updatedAt, value.completedAt ?? null, value.notificationId])
    return db.getRowsModified() === 1
  }
}
export const appNotificationStore = new AppNotificationStore()
