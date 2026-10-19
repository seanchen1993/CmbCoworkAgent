import { createHash } from "node:crypto"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import type {
  ExpertConversationInput,
  ExpertCoordinationEnvelope,
  ExpertTaskReceipt
} from "../../../shared/bot/expert-conversation"
import { PartnerLocalFault } from "./partner-local-boundary"
import type { ServiceModelBinding } from "./service-model-binding"

export interface ExpertTaskSummary {
  taskId: string
  taskVersion: number
  status: "active" | "awaiting_business" | "completed"
  role: "main" | "task"
  busy: boolean
}
export interface ExpertAction {
  remoteStarted?: boolean
  model?: ServiceModelBinding
  seq?: number
  scopeKey: string
  id: string
  conversationId: string
  kind: "coordinate" | "complete" | "reopen" | "retry"
  commandId: string
  targetRef: string | null
  sourceRequestId: string | null
  sourceRunId: string | null
  intent: ExpertCoordinationEnvelope["intent"]
  expectedVersion: number | null
  phase: "remote" | "child" | "done" | "blocked"
  receipt: ExpertTaskReceipt | null
  childRequestId: string | null
  notice: string | null
}
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
function intentFingerprint(a: ExpertAction) {
  return fingerprint([
    a.conversationId,
    a.kind,
    a.targetRef,
    a.sourceRequestId,
    a.sourceRunId,
    a.intent
  ])
}
export class ServiceExpertStore {
  constructor(private readonly db: NativeSqliteAdapter) {
    db.run(`CREATE TABLE IF NOT EXISTS service_expert_inputs(scope_key TEXT NOT NULL,request_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope_key,request_id));
      CREATE TABLE IF NOT EXISTS service_expert_summaries(scope_key TEXT NOT NULL,task_ref TEXT NOT NULL,task_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope_key,task_ref));
      CREATE TABLE IF NOT EXISTS service_expert_actions(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope_key TEXT NOT NULL,id TEXT NOT NULL,task_ref TEXT,kind TEXT NOT NULL,pending INTEGER NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(scope_key,id));
      CREATE INDEX IF NOT EXISTS expert_actions_pending ON service_expert_actions(scope_key,pending,seq);
      CREATE INDEX IF NOT EXISTS expert_actions_task ON service_expert_actions(scope_key,task_ref,pending,seq);`)
  }
  private rows(sql: string, values: unknown[] = []) {
    const s = this.db.prepare(sql)
    s.bind(values)
    try {
      const rows: Record<string, unknown>[] = []
      while (s.step()) rows.push(s.getAsObject())
      return rows
    } finally {
      s.free()
    }
  }
  input(scope: string, request: string): ExpertConversationInput | null {
    const row = this.rows(
      "SELECT body FROM service_expert_inputs WHERE scope_key=? AND request_id=?",
      [scope, request]
    )[0]
    return row ? JSON.parse(String(row.body)) : null
  }
  saveInput(scope: string, request: string, input: ExpertConversationInput) {
    const previous = this.input(scope, request)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(input))
        throw new PartnerLocalFault("INPUT_CHANGED")
      return
    }
    this.db.run("INSERT INTO service_expert_inputs VALUES(?,?,?)", [
      scope,
      request,
      JSON.stringify(input)
    ])
  }
  summary(scope: string, ref: string): ExpertTaskSummary | null {
    const row = this.rows(
      "SELECT body FROM service_expert_summaries WHERE scope_key=? AND task_ref=?",
      [scope, ref]
    )[0]
    return row ? JSON.parse(String(row.body)) : null
  }
  saveSummary(scope: string, ref: string, value: ExpertTaskSummary) {
    const previous = this.summary(scope, ref)
    if (
      previous &&
      (previous.taskId !== value.taskId || previous.taskVersion > value.taskVersion)
    ) {
      if (previous.taskId !== value.taskId) throw new PartnerLocalFault("INPUT_CHANGED")
      return
    }
    this.db.run(
      "INSERT INTO service_expert_summaries VALUES(?,?,?,?,?) ON CONFLICT(scope_key,task_ref) DO UPDATE SET version=excluded.version,body=excluded.body",
      [scope, ref, value.taskId, value.taskVersion, JSON.stringify(value)]
    )
  }
  private decode(row: Record<string, unknown>): ExpertAction {
    return { ...JSON.parse(String(row.body)), seq: Number(row.seq) }
  }
  get(scope: string, id: string): ExpertAction | null {
    const row = this.rows(
      "SELECT seq,body FROM service_expert_actions WHERE scope_key=? AND id=?",
      [scope, id]
    )[0]
    return row ? this.decode(row) : null
  }
  accept(value: ExpertAction): ExpertAction {
    const old = this.rows(
      "SELECT seq,body,fingerprint FROM service_expert_actions WHERE scope_key=? AND id=?",
      [value.scopeKey, value.id]
    )[0]
    const hash = intentFingerprint(value)
    if (old) {
      if (old.fingerprint !== hash) throw new PartnerLocalFault("COMMAND_CONFLICT")
      return this.decode(old)
    }
    this.db.run(
      "INSERT INTO service_expert_actions(scope_key,id,task_ref,kind,pending,fingerprint,body) VALUES(?,?,?,?,1,?,?)",
      [value.scopeKey, value.id, value.targetRef, value.kind, hash, JSON.stringify(value)]
    )
    return this.get(value.scopeKey, value.id)!
  }
  save(value: ExpertAction) {
    const { seq: _, ...body } = value
    this.db.run(
      "UPDATE service_expert_actions SET task_ref=?,pending=?,body=? WHERE scope_key=? AND id=?",
      [
        value.targetRef,
        value.phase === "done" || value.phase === "blocked" ? 0 : 1,
        JSON.stringify(body),
        value.scopeKey,
        value.id
      ]
    )
    if (this.db.getRowsModified() !== 1) throw new PartnerLocalFault("STORAGE_FAILURE")
  }
  pending(scope: string, after = 0): ExpertAction[] {
    return this.rows(
      "SELECT seq,body FROM service_expert_actions WHERE scope_key=? AND pending=1 AND seq>? ORDER BY seq LIMIT 8",
      [scope, after]
    ).map((row) => this.decode(row))
  }
  hasPending(scope: string, ref?: string): boolean {
    return !!this.rows(
      "SELECT seq FROM service_expert_actions WHERE scope_key=? AND pending=1" +
        (ref ? " AND task_ref=?" : "") +
        " LIMIT 1",
      ref ? [scope, ref] : [scope]
    )[0]
  }
  actions(scope: string, ref?: string): ExpertAction[] {
    return this.rows(
      "SELECT seq,body FROM service_expert_actions WHERE scope_key=?" +
        (ref ? " AND task_ref=?" : "") +
        " ORDER BY seq DESC LIMIT 40",
      ref ? [scope, ref] : [scope]
    ).map((row) => this.decode(row))
  }
  lifecycleRevision(scope: string, ref: string): number {
    return Number(
      this.rows(
        "SELECT MAX(seq) AS last FROM service_expert_actions WHERE scope_key=? AND task_ref=? AND kind IN ('complete','reopen')",
        [scope, ref]
      )[0]?.last ?? 0
    )
  }
}
