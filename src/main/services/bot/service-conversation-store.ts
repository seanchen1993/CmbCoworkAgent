import { createHash, randomUUID } from "node:crypto"
import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import type { Task } from "../../../shared/bot/contracts.generated"
import type { PartnerRequirementResult, PartnerRequirementRun } from "./requirement-execution-types"
import type { ServiceModelBinding } from "./service-model-binding"
import { PartnerLocalFault } from "./partner-local-boundary"
import type { ServiceRequestStatus } from "../../../shared/bot/service-conversation"

export interface ServiceScope {
  url: string
  spaceId: string
  businessPrincipalId: string
  ownerPrincipalId: string
  nodeId: string
  workspaceRef: string
  workspaceHash?: string
  groupId: string
  botId: string
}
export function serviceScopeKey(scope: ServiceScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.url,
        scope.spaceId,
        scope.businessPrincipalId,
        scope.ownerPrincipalId,
        scope.nodeId,
        scope.workspaceRef,
        scope.workspaceHash ?? null,
        scope.groupId,
        scope.botId
      ])
    )
    .digest("hex")
}
export interface ConversationRecord {
  id: string
  scope: ServiceScope
  model: ServiceModelBinding | null
}
export interface ServiceTaskRecord {
  ref: string
  conversationId: string
  title: string
  task: Task | null
}
export interface ExecutionBinding extends ServiceScope {
  commandId: string
  taskId: string
  taskVersion: number
  stageId: string
  groupVersion: number
  botVersionId: string
  deadline: string
  model: ServiceModelBinding
  kind: "service" | "legacy"
  runId: string | null
  attemptId: string | null
}
export interface ServiceRequestRecord {
  seq: number
  revision: number
  scopeKey: string
  conversationId: string
  taskRef: string
  requestId: string
  text: string
  createdAt: string
  deadline: string | null
  createCommand: string
  messageCommand: string
  enqueueCommand: string
  expectedVersion: number | null
  taskVersion: number | null
  phase: "saved" | "create" | "message" | "bind" | "enqueue" | "run" | "terminal"
  status: ServiceRequestStatus
  notice: string | null
  runId: string | null
  runVersion: number | null
  cancelRequested: boolean
  model: ServiceModelBinding
  result: PartnerRequirementResult | null
}
const PAGE = 40
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
/** All intent/transition writes are SQLite transactions, committed before HTTP.
 * Indexed keyset pages bound both UI history reads and the recovery pump. */
export class ServiceConversationStore {
  constructor(private readonly db: NativeSqliteAdapter) {
    db.run(`CREATE TABLE IF NOT EXISTS service_conversations (
      scope_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_conversation_tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
      ref TEXT NOT NULL UNIQUE, server_task_id TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS service_tasks_server ON service_conversation_tasks(scope_key,server_task_id);
      CREATE INDEX IF NOT EXISTS service_tasks_scope ON service_conversation_tasks(scope_key,conversation_id,seq);
      CREATE TABLE IF NOT EXISTS service_conversation_requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
      task_ref TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
      pending INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(scope_key,request_id));
      CREATE INDEX IF NOT EXISTS service_requests_task ON service_conversation_requests(scope_key,task_ref,seq);
      CREATE INDEX IF NOT EXISTS service_requests_command ON service_conversation_requests(scope_key,json_extract(body,'$.enqueueCommand'));
      CREATE INDEX IF NOT EXISTS service_requests_pending ON service_conversation_requests(scope_key,pending,seq);
      CREATE TABLE IF NOT EXISTS service_execution_bindings (
      scope_key TEXT NOT NULL, command_id TEXT NOT NULL, task_id TEXT NOT NULL,
      run_id TEXT, attempt_id TEXT, body TEXT NOT NULL, PRIMARY KEY(scope_key,command_id));
      CREATE UNIQUE INDEX IF NOT EXISTS service_binding_run ON service_execution_bindings(scope_key,run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS service_binding_attempt ON service_execution_bindings(scope_key,attempt_id);`)
  }
  private rows(sql: string, values: unknown[] = []): Record<string, unknown>[] {
    const statement = this.db.prepare(sql)
    statement.bind(values)
    try {
      const rows: Record<string, unknown>[] = []
      while (statement.step()) rows.push(statement.getAsObject())
      return rows
    } finally {
      statement.free()
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.run("BEGIN IMMEDIATE")
    try {
      const result = fn()
      this.db.run("COMMIT")
      return result
    } catch (error) {
      this.db.run("ROLLBACK")
      throw error
    }
  }
  conversation(scope: ServiceScope): ConversationRecord {
    const key = serviceScopeKey(scope)
    const row = this.rows("SELECT body FROM service_conversations WHERE scope_key=?", [key])[0]
    if (row) return JSON.parse(String(row.body))
    const value = { id: randomUUID(), scope, model: null }
    this.db.run("INSERT INTO service_conversations VALUES(?,?,?)", [
      key,
      value.id,
      JSON.stringify(value)
    ])
    return value
  }
  requireConversation(scope: ServiceScope, id: string): ConversationRecord {
    const row = this.rows("SELECT body FROM service_conversations WHERE scope_key=? AND id=?", [
      serviceScopeKey(scope),
      id
    ])[0]
    if (!row) throw new PartnerLocalFault("FORBIDDEN")
    return JSON.parse(String(row.body))
  }
  setModel(scope: ServiceScope, id: string, model: ServiceModelBinding): void {
    const value = this.requireConversation(scope, id)
    value.model = model
    this.db.run("UPDATE service_conversations SET body=? WHERE scope_key=? AND id=?", [
      JSON.stringify(value),
      serviceScopeKey(scope),
      id
    ])
  }
  task(scopeKey: string, ref: string): ServiceTaskRecord {
    const row = this.rows(
      "SELECT body FROM service_conversation_tasks WHERE scope_key=? AND ref=?",
      [scopeKey, ref]
    )[0]
    if (!row) throw new PartnerLocalFault("FORBIDDEN")
    return JSON.parse(String(row.body))
  }
  saveTask(scopeKey: string, record: ServiceTaskRecord): void {
    this.db.run(
      "UPDATE service_conversation_tasks SET server_task_id=?,body=? WHERE scope_key=? AND ref=?",
      [record.task?.id ?? null, JSON.stringify(record), scopeKey, record.ref]
    )
    if (this.db.getRowsModified() !== 1) throw new PartnerLocalFault("STORAGE_FAILURE")
  }
  accept(
    scope: ServiceScope,
    conversationId: string,
    taskRef: string | null,
    requestId: string,
    text: string,
    model: ServiceModelBinding | null = null
  ): ServiceRequestRecord {
    const key = serviceScopeKey(scope),
      fingerprint = hash([conversationId, taskRef, text])
    return this.transaction(() => {
      const old = this.rows(
        "SELECT * FROM service_conversation_requests WHERE scope_key=? AND request_id=?",
        [key, requestId]
      )[0]
      if (old) {
        if (old.fingerprint !== fingerprint) throw new PartnerLocalFault("COMMAND_CONFLICT")
        return this.decode(old)
      }
      this.requireConversation(scope, conversationId)
      if (!model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
      const ref = taskRef ?? randomUUID()
      if (taskRef) {
        if (this.task(key, taskRef).conversationId !== conversationId)
          throw new PartnerLocalFault("FORBIDDEN")
      } else {
        const task: ServiceTaskRecord = {
          ref,
          conversationId,
          title: text.slice(0, 80),
          task: null
        }
        this.db.run(
          "INSERT INTO service_conversation_tasks(scope_key,conversation_id,ref,body) VALUES(?,?,?,?)",
          [key, conversationId, ref, JSON.stringify(task)]
        )
      }
      const value: Omit<ServiceRequestRecord, "seq"> = {
        revision: 1,
        scopeKey: key,
        conversationId,
        taskRef: ref,
        requestId,
        text,
        createdAt: new Date().toISOString(),
        deadline: null,
        createCommand: "sc-create:" + randomUUID(),
        messageCommand: "sc-message:" + randomUUID(),
        enqueueCommand: "sc-run:" + randomUUID(),
        expectedVersion: null,
        taskVersion: null,
        phase: "saved",
        status: "saved",
        notice: null,
        runId: null,
        runVersion: null,
        cancelRequested: false,
        model,
        result: null
      }
      this.db.run(
        "INSERT INTO service_conversation_requests(scope_key,conversation_id,task_ref,request_id,fingerprint,revision,pending,body) VALUES(?,?,?,?,?,1,1,?)",
        [key, conversationId, ref, requestId, fingerprint, JSON.stringify(value)]
      )
      return this.request(key, requestId)
    })
  }
  private decode(row: Record<string, unknown>): ServiceRequestRecord {
    return { ...JSON.parse(String(row.body)), seq: Number(row.seq), revision: Number(row.revision) }
  }
  findRequest(scopeKey: string, requestId: string): ServiceRequestRecord | null {
    const row = this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND request_id=?",
      [scopeKey, requestId]
    )[0]
    return row ? this.decode(row) : null
  }
  request(scopeKey: string, requestId: string): ServiceRequestRecord {
    const row = this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND request_id=?",
      [scopeKey, requestId]
    )[0]
    if (!row) throw new PartnerLocalFault("FORBIDDEN")
    return this.decode(row)
  }
  update(
    scopeKey: string,
    requestId: string,
    action: (value: ServiceRequestRecord) => void
  ): ServiceRequestRecord {
    return this.transaction(() => {
      const value = this.request(scopeKey, requestId),
        revision = value.revision
      action(value)
      value.revision++
      this.db.run(
        "UPDATE service_conversation_requests SET revision=?,pending=?,body=? WHERE scope_key=? AND request_id=? AND revision=?",
        [
          value.revision,
          value.phase === "terminal" ? 0 : 1,
          JSON.stringify(value),
          scopeKey,
          requestId,
          revision
        ]
      )
      if (this.db.getRowsModified() !== 1) throw new PartnerLocalFault("VERSION_CONFLICT")
      return value
    })
  }
  previousPending(value: ServiceRequestRecord): ServiceRequestRecord | null {
    const row = this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND task_ref=? AND seq<? AND (pending=1 OR json_extract(body,'$.status') IN ('outcome_unknown','blocked')) ORDER BY seq LIMIT 1",
      [value.scopeKey, value.taskRef, value.seq]
    )[0]
    return row ? this.decode(row) : null
  }
  pending(scopeKey: string, after: number): ServiceRequestRecord[] {
    return this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND pending=1 AND seq>? ORDER BY seq LIMIT 8",
      [scopeKey, after]
    ).map((row) => this.decode(row))
  }
  hasPending(scopeKey: string): boolean {
    return !!this.rows(
      "SELECT seq FROM service_conversation_requests WHERE scope_key=? AND pending=1 LIMIT 1",
      [scopeKey]
    )[0]
  }
  requestPage(scopeKey: string, ref: string, after: number) {
    return this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND task_ref=? AND seq<? ORDER BY seq DESC LIMIT ?",
      [scopeKey, ref, after || Number.MAX_SAFE_INTEGER, PAGE + 1]
    ).map((row) => this.decode(row))
  }
  taskPage(scopeKey: string, conversationId: string, after: number) {
    return this.rows(
      "SELECT seq,body FROM service_conversation_tasks WHERE scope_key=? AND conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
      [scopeKey, conversationId, after || Number.MAX_SAFE_INTEGER, PAGE + 1]
    ).map((row) => ({
      seq: Number(row.seq),
      task: JSON.parse(String(row.body)) as ServiceTaskRecord
    }))
  }
  latest(scopeKey: string, ref: string): ServiceRequestRecord | null {
    const row = this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND task_ref=? ORDER BY seq DESC LIMIT 1",
      [scopeKey, ref]
    )[0]
    return row ? this.decode(row) : null
  }
  bind(scopeKey: string, binding: ExecutionBinding): void {
    this.transaction(() => {
      const old = this.binding(scopeKey, binding.commandId)
      if (old) {
        if (
          hash({ ...old, runId: null, attemptId: null }) !==
          hash({ ...binding, runId: null, attemptId: null })
        )
          throw new PartnerLocalFault("COMMAND_CONFLICT")
        return
      }
      this.db.run("INSERT INTO service_execution_bindings VALUES(?,?,?,?,?,?)", [
        scopeKey,
        binding.commandId,
        binding.taskId,
        null,
        null,
        JSON.stringify(binding)
      ])
    })
  }
  binding(scopeKey: string, command: string): ExecutionBinding | null {
    const row = this.rows(
      "SELECT body FROM service_execution_bindings WHERE scope_key=? AND command_id=?",
      [scopeKey, command]
    )[0]
    return row ? JSON.parse(String(row.body)) : null
  }
  ownsTask(scopeKey: string, taskId: string): boolean {
    return !!this.rows(
      "SELECT ref FROM service_conversation_tasks WHERE scope_key=? AND server_task_id=? LIMIT 1",
      [scopeKey, taskId]
    )[0]
  }
  claim(scopeKey: string, run: PartnerRequirementRun): ExecutionBinding {
    return this.transaction(() => {
      const b = this.binding(scopeKey, run.commandId ?? "")
      if (
        !b ||
        run.requesterPrincipalId !== b.businessPrincipalId ||
        ![
          "spaceId",
          "nodeId",
          "ownerPrincipalId",
          "workspaceRef",
          "groupId",
          "botId",
          "botVersionId",
          "taskId",
          "taskVersion",
          "stageId",
          "groupVersion"
        ].every(
          (k) =>
            (b as unknown as Record<string, unknown>)[k] ===
            (run as unknown as Record<string, unknown>)[k]
        ) ||
        Date.parse(b.deadline) !== Date.parse(run.deadline) ||
        (b.runId !== null && b.runId !== run.id) ||
        (b.attemptId !== null && b.attemptId !== run.attemptId)
      )
        throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
      b.runId = run.id
      b.attemptId = run.attemptId
      this.db.run(
        "UPDATE service_execution_bindings SET run_id=?,attempt_id=?,body=? WHERE scope_key=? AND command_id=?",
        [run.id, run.attemptId, JSON.stringify(b), scopeKey, b.commandId]
      )
      return b
    })
  }
  requestByCommand(scopeKey: string, command: string): ServiceRequestRecord | null {
    // Command IDs are indexed separately in bindings; this bounded lookup is
    // performed once per claimed Run, not one HTTP query per historical request.
    const row = this.rows(
      "SELECT * FROM service_conversation_requests WHERE scope_key=? AND json_extract(body,'$.enqueueCommand')=? LIMIT 1",
      [scopeKey, command]
    )[0]
    return row ? this.decode(row) : null
  }
}
export const SERVICE_PAGE_SIZE = PAGE
