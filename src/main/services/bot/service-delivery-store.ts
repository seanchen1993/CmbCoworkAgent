import { createHash } from "node:crypto"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import type { TextDeliveryReceipt, TextDeliverySummary } from "../../../shared/bot/text-delivery"
import type { ServiceModelBinding } from "./service-model-binding"
import { PartnerLocalFault } from "./partner-local-boundary"
export interface ServiceDeliveryAction {
  seq?: number
  id: string
  scopeKey: string
  taskRef: string
  kind: "publish" | "approve" | "reject" | "retry"
  phase: "prepare" | "remote" | "revision" | "done" | "blocked"
  notice: string | null
  sourceRequestId?: string | null
  requestId: string | null
  runId: string | null
  versionId: string | null
  comment: string | null
  commandId: string
  expectedTaskVersion: number | null
  expectedReviewVersion: number | null
  receipt: TextDeliveryReceipt | null
  model: ServiceModelBinding | null
  revisionRequestId: string | null
}
/** Same SQLite connection, separate durable review outbox. No credential or file content. */
export class ServiceDeliveryStore {
  constructor(private readonly db: NativeSqliteAdapter) {
    db.run(`CREATE TABLE IF NOT EXISTS service_delivery_actions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, id TEXT NOT NULL,
      task_ref TEXT NOT NULL, pending INTEGER NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL,
      UNIQUE(scope_key,id));
      CREATE INDEX IF NOT EXISTS service_delivery_pending ON service_delivery_actions(scope_key,pending,seq);
      CREATE INDEX IF NOT EXISTS service_delivery_task ON service_delivery_actions(scope_key,task_ref,seq);
      CREATE TABLE IF NOT EXISTS service_delivery_summaries(scope_key TEXT NOT NULL,task_ref TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope_key,task_ref));`)
  }
  private rows(sql: string, args: unknown[] = []) {
    const stmt = this.db.prepare(sql)
    stmt.bind(args)
    try {
      const rows: Record<string, unknown>[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      return rows
    } finally {
      stmt.free()
    }
  }
  get(scope: string, id: string): ServiceDeliveryAction | null {
    const row = this.rows("SELECT body FROM service_delivery_actions WHERE scope_key=? AND id=?", [
      scope,
      id
    ])[0]
    return row ? JSON.parse(String(row.body)) : null
  }
  accept(action: ServiceDeliveryAction): ServiceDeliveryAction {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          action.taskRef,
          action.kind,
          action.requestId,
          action.runId,
          action.versionId,
          action.comment,
          action.sourceRequestId ?? null
        ])
      )
      .digest("hex")
    const row = this.rows(
      "SELECT fingerprint,body FROM service_delivery_actions WHERE scope_key=? AND id=?",
      [action.scopeKey, action.id]
    )[0]
    if (row) {
      if (row.fingerprint !== fingerprint) throw new PartnerLocalFault("COMMAND_CONFLICT")
      return JSON.parse(String(row.body))
    }
    this.db.run(
      "INSERT INTO service_delivery_actions(scope_key,id,task_ref,pending,fingerprint,body) VALUES(?,?,?,1,?,?)",
      [action.scopeKey, action.id, action.taskRef, fingerprint, JSON.stringify(action)]
    )
    return action
  }
  save(action: ServiceDeliveryAction): void {
    this.db.run("UPDATE service_delivery_actions SET pending=?,body=? WHERE scope_key=? AND id=?", [
      ["done", "blocked"].includes(action.phase) ? 0 : 1,
      JSON.stringify(action),
      action.scopeKey,
      action.id
    ])
    if (this.db.getRowsModified() !== 1) throw new PartnerLocalFault("STORAGE_FAILURE")
  }
  pending(scope: string, after = 0): ServiceDeliveryAction[] {
    return this.rows(
      "SELECT seq,body FROM service_delivery_actions WHERE scope_key=? AND pending=1 AND seq>? ORDER BY seq LIMIT 8",
      [scope, after]
    ).map((r) => ({ ...JSON.parse(String(r.body)), seq: Number(r.seq) }))
  }
  actions(scope: string, task: string): ServiceDeliveryAction[] {
    return this.rows(
      "SELECT body FROM service_delivery_actions WHERE scope_key=? AND task_ref=? ORDER BY seq DESC LIMIT 40",
      [scope, task]
    ).map((r) => JSON.parse(String(r.body)))
  }
  hasPending(scope: string, task?: string, exclude?: string): boolean {
    return !!this.rows(
      "SELECT seq FROM service_delivery_actions WHERE scope_key=? AND pending=1" +
        (task ? " AND task_ref=?" : "") +
        (exclude ? " AND id<>?" : "") +
        " LIMIT 1",
      [scope, ...(task ? [task] : []), ...(exclude ? [exclude] : [])]
    )[0]
  }
  hasReviewIntent(scope: string, task: string): boolean {
    return !!this.rows(
      "SELECT seq FROM service_delivery_actions WHERE scope_key=? AND task_ref=? AND (pending=1 AND json_extract(body,'$.kind') IN ('approve','reject','retry') OR json_extract(body,'$.kind')='approve' AND json_extract(body,'$.receipt.summary.taskStatus')='completed') LIMIT 1",
      [scope, task]
    )[0]
  }
  summary(scope: string, task: string): TextDeliverySummary | null {
    const row = this.rows(
      "SELECT body FROM service_delivery_summaries WHERE scope_key=? AND task_ref=?",
      [scope, task]
    )[0]
    return row ? JSON.parse(String(row.body)) : null
  }
  saveSummary(scope: string, task: string, value: TextDeliverySummary): void {
    const old = this.summary(scope, task)
    if (old && old.taskVersion > value.taskVersion) return
    this.db.run(
      "INSERT INTO service_delivery_summaries(scope_key,task_ref,body) VALUES(?,?,?) ON CONFLICT(scope_key,task_ref) DO UPDATE SET body=excluded.body",
      [scope, task, JSON.stringify(value)]
    )
  }
}
