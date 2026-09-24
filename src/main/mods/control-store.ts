import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  ModExecution,
  ModJson,
  ModIdentity,
  ModAuditEntry,
  ModCommandJob,
  ModArtifact
} from "../../shared/mods/types"
import { MOD_COMMAND_HISTORY_LIMIT } from "../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import { ModError } from "./errors"
import { FunctionStateStore } from "./v2/state-store"
import type { CompletionEvidenceRecord } from "./v2/completion-evidence"

export interface ModGrant {
  workspace: string
  modId: string
  digest: string
  epoch: number
  enabled: boolean
}

export class ModControlStore {
  private readonly db: DatabaseSync
  private grantQuery?: ReturnType<DatabaseSync["prepare"]>
  readonly functionState: FunctionStateStore
  readonly evidenceExcludedPaths: string[]

  constructor(path: string) {
    this.evidenceExcludedPaths = [path, `${path}-wal`, `${path}-shm`, `${path}.initialized`]
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    try {
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS mods_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mods_grants (
        workspace TEXT NOT NULL, mod_id TEXT NOT NULL, digest TEXT NOT NULL,
        epoch INTEGER NOT NULL, enabled INTEGER NOT NULL,
        PRIMARY KEY(workspace, mod_id)
      );
      CREATE TABLE IF NOT EXISTS mods_calls (
        id TEXT PRIMARY KEY, args_hash TEXT NOT NULL, status TEXT NOT NULL,
        at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mods_state (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE IF NOT EXISTS mods_cards (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mods_cards_thread ON mods_cards(thread_id,at);
      CREATE TABLE IF NOT EXISTS mods_consumed_actions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mods_jobs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mods_jobs_thread ON mods_jobs(thread_id,at);
      CREATE TABLE IF NOT EXISTS mods_artifacts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mods_artifacts_thread ON mods_artifacts(thread_id,at);      CREATE TABLE IF NOT EXISTS mods_completion_evidence (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        run_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL,
        payload TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mods_completion_evidence_scope
        ON mods_completion_evidence(workspace,thread_id,at);
    `)
      const version = this.getSetting("schema", "")
      if (version && !["1", "2", "3", "4", "5", "6", "7"].includes(version)) {
        throw new ModError("MODS_STORE_VERSION")
      }
      const columns = new Set(
        this.db
          .prepare("PRAGMA table_info(mods_calls)")
          .all()
          .map((row) => row.name)
      )
      for (const column of [
        "tool_id",
        "scope",
        "final_args_hash",
        "workspace",
        "thread_id",
        "policy_digest",
        "publication",
        "rule_ids",
        "reconciliation",
        "model_usage"
      ]) {
        if (!columns.has(column)) this.db.exec(`ALTER TABLE mods_calls ADD COLUMN ${column} TEXT`)
      }
      this.db.exec(`
      UPDATE mods_calls SET workspace=json_extract(scope,'$.workspace'),thread_id=json_extract(scope,'$.threadId')
        WHERE workspace IS NULL AND scope IS NOT NULL;
      CREATE INDEX IF NOT EXISTS mods_calls_workspace ON mods_calls(workspace,at);
      CREATE INDEX IF NOT EXISTS mods_calls_thread ON mods_calls(thread_id,at);
    `)
      this.functionState = new FunctionStateStore(this.db)
      this.setSetting("schema", "7")
      // An interrupted operation may have reached an external service. Never replay it.
      this.db.prepare("UPDATE mods_calls SET status = 'unknown' WHERE status = 'running'").run()
      this.db.prepare(
        `UPDATE mods_completion_evidence
         SET status='interrupted', payload=json_set(payload, '$.status', 'interrupted',
           '$.detail.error', 'MODS_PROCESS_RESTARTED')
         WHERE status='running'`
      ).run()
      for (const row of this.db
        .prepare(
          "SELECT payload FROM mods_jobs WHERE json_extract(payload,'$.state') IN ('queued','running')"
        )
        .all()) {
        const job = parseModJson(String(row.payload)) as unknown as ModCommandJob
        this.saveJob({
          ...job,
          state: job.state === "queued" ? "cancelled" : "unknown",
          error: "MODS_PROCESS_RESTARTED",
          finishedAt: Date.now()
        })
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  getSetting(key: string, fallback = "false"): string {
    const row = this.db.prepare("SELECT value FROM mods_meta WHERE key = ?").get(key)
    return typeof row?.value === "string" ? row.value : fallback
  }

  saveJob(job: ModCommandJob): void {
    const text = encodeModJson(job)
    if (Buffer.byteLength(text) > 64 * 1024) throw new ModError("MODS_JOB_RESULT_LIMIT")
    this.db
      .prepare(
        "INSERT INTO mods_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"
      )
      .run(job.id, job.threadId, text, job.createdAt)
    this.db
      .prepare(
        "DELETE FROM mods_jobs WHERE thread_id=? AND json_extract(payload,'$.state') NOT IN ('queued','running') AND id NOT IN (SELECT id FROM mods_jobs WHERE thread_id=? ORDER BY at DESC,rowid DESC LIMIT ?)"
      )
      .run(job.threadId, job.threadId, MOD_COMMAND_HISTORY_LIMIT)
  }

  jobs(threadId: string): ModCommandJob[] {
    return this.db
      .prepare(
        "SELECT payload FROM mods_jobs WHERE thread_id=? ORDER BY at DESC,rowid DESC LIMIT ?"
      )
      .all(threadId, MOD_COMMAND_HISTORY_LIMIT)
      .map((row) => parseModJson(String(row.payload)) as unknown as ModCommandJob)
  }

  turnSummary(workspace: string, threadId: string, turnId: string): Record<ModExecution, number> {
    const counts: Record<ModExecution, number> = {
      not_started: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0
    }
    for (const row of this.db
      .prepare(
        "SELECT status,COUNT(*) AS n FROM mods_calls WHERE workspace=? AND thread_id=? AND json_extract(scope,'$.turnId')=? GROUP BY status"
      )
      .all(workspace, threadId, turnId))
      if (Object.hasOwn(counts, String(row.status)))
        counts[String(row.status) as ModExecution] = Number(row.n)
    return counts
  }

  saveArtifact(artifact: ModArtifact): void {
    const text = encodeModJson(artifact)
    if (Buffer.byteLength(text) > 256 * 1024) throw new ModError("MODS_ARTIFACT_LIMIT")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .prepare("INSERT INTO mods_artifacts VALUES(?,?,?,?)")
        .run(artifact.id, artifact.threadId, text, artifact.createdAt)
      const total = this.db
        .prepare(
          "SELECT COUNT(*) AS n,SUM(length(CAST(payload AS BLOB))) AS bytes FROM mods_artifacts WHERE thread_id=?"
        )
        .get(artifact.threadId)!
      if (Number(total.n) > 50 || Number(total.bytes) > 2 * 1024 * 1024)
        throw new ModError("MODS_ARTIFACT_QUOTA")
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  artifact(id: string): ModArtifact | null {
    const row = this.db.prepare("SELECT payload FROM mods_artifacts WHERE id=?").get(id)
    return row ? (parseModJson(String(row.payload)) as unknown as ModArtifact) : null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO mods_meta(key,value) VALUES(?,?)").run(key, value)
  }

  setSettings(values: Record<string, string>): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const [key, value] of Object.entries(values)) this.setSetting(key, value)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  saveCard(id: string, threadId: string, payload: unknown): void {
    const text = encodeModJson(payload)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT INTO mods_cards VALUES(?,?,?,?)").run(id, threadId, text, Date.now())
      this.db
        .prepare(
          "DELETE FROM mods_cards WHERE thread_id=? AND id NOT IN (SELECT id FROM mods_cards WHERE thread_id=? ORDER BY at DESC,rowid DESC LIMIT 50)"
        )
        .run(threadId, threadId)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  cards(threadId: string): unknown[] {
    return this.db
      .prepare("SELECT payload FROM mods_cards WHERE thread_id=? ORDER BY at,rowid")
      .all(threadId)
      .map((row) => parseModJson(String(row.payload)))
  }

  saveCompletionEvidence(record: CompletionEvidenceRecord): void {
    const unbound = record.phase === "capture.started" || record.phase === "capture.failed"
    const unboundStatuses =
      record.phase === "capture.started"
        ? ["running", "completed", "cancelled", "error", "interrupted"]
        : ["cancelled", "error", "interrupted"]
    if (
      (record.binding === null) !== unbound ||
      (unbound && !unboundStatuses.includes(record.status)) ||
      (record.phase === "state.transition.started" &&
        !["running", "completed", "cancelled", "interrupted", "error"].includes(record.status)) ||
      (record.status === "completed" &&
        !["capture.started", "check.started", "state.transition.started"].includes(record.phase))
    )
      throw new ModError("MODS_EVIDENCE_UNBOUND")
    const text = encodeModJson(record)
    if (Buffer.byteLength(text) > 512 * 1024) throw new ModError("MODS_EVIDENCE_LIMIT")
    const detail = record.detail
    const attempt =
      detail && typeof detail === "object" && !Array.isArray(detail) ? detail.attempt : undefined
    const previous =
      record.phase === "check.started" || record.phase === "capture.failed"
        ? ["capture.started", "capture.started"]
        : (record.phase === "check.result" || record.phase === "invalidated") &&
            record.status !== "running"
          ? ["capture.started", "check.started"]
          : record.phase === "state.transition" && record.status !== "running"
            ? ["state.transition.started", "state.transition.started"]
            : undefined
    const settle = previous && typeof attempt === "string" && attempt.length > 0
    // The terminal fact and its start marker must be committed together. A crash
    // between the two must never turn a finished operation into an interrupted one.
    if (settle) this.db.exec("BEGIN IMMEDIATE")
    try {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO mods_completion_evidence
          (id,idempotency_key,workspace,thread_id,turn_id,run_id,phase,status,payload,at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.id,
          record.idempotencyKey,
          record.workspace,
          record.threadId,
          record.turnId,
          record.runId,
          record.phase,
          record.status,
          text,
          record.at
        )
      if (settle && inserted.changes > 0) {
        // completed means only that the step ended; it is never a PASS or a proof.
        this.db
          .prepare(
            `UPDATE mods_completion_evidence
          SET status='completed', payload=json_set(payload, '$.status', 'completed',
            '$.detail.settledBy', ?, '$.detail.settledAt', ?)
          WHERE workspace=? AND thread_id=? AND turn_id=? AND run_id=?
            AND phase IN (?,?) AND status='running' AND json_extract(payload,'$.detail.attempt')=?`
          )
          .run(
            record.id,
            record.at,
            record.workspace,
            record.threadId,
            record.turnId,
            record.runId,
            previous![0],
            previous![1],
            attempt
          )
      }
      if (settle) this.db.exec("COMMIT")
    } catch (error) {
      if (settle) this.db.exec("ROLLBACK")
      throw error
    }
  }

  completionEvidence(workspace: string, threadId: string, limit = 100): CompletionEvidenceRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new ModError("MODS_EVIDENCE_QUERY")
    return this.db
      .prepare(
        "SELECT payload FROM mods_completion_evidence WHERE workspace=? AND thread_id=? ORDER BY at DESC,rowid DESC LIMIT ?"
      )
      .all(workspace, threadId, limit)
      .map((row) => parseModJson(String(row.payload)) as unknown as CompletionEvidenceRecord)
  }
  hasCard(id: string, threadId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT id FROM mods_cards WHERE id=? AND thread_id=?").get(id, threadId)
    )
  }

  actionConsumed(id: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM mods_consumed_actions WHERE id=?").get(id))
  }

  consumeAction(id: string): void {
    if (!this.db.prepare("INSERT OR IGNORE INTO mods_consumed_actions VALUES(?)").run(id).changes) {
      throw new ModError("MODS_ACTION_ALREADY_USED")
    }
  }

  grant(workspace: string, modId: string, digest: string, enabled: boolean): ModGrant {
    this.db
      .prepare(
        `INSERT INTO mods_grants VALUES(?,?,?,1,?)
      ON CONFLICT(workspace,mod_id) DO UPDATE SET digest=excluded.digest,
      epoch=mods_grants.epoch+1, enabled=excluded.enabled`
      )
      .run(workspace, modId, digest, +enabled)
    return this.getGrant(workspace, modId)!
  }

  getGrant(workspace: string, modId: string): ModGrant | null {
    // Reuse the compiled query, never an authorization result. Each get sees
    // the current committed row, including changes from another connection.
    this.grantQuery ??= this.db.prepare("SELECT * FROM mods_grants WHERE workspace=? AND mod_id=?")
    const row = this.grantQuery.get(workspace, modId)
    return row
      ? {
          workspace,
          modId,
          digest: String(row.digest),
          epoch: Number(row.epoch),
          enabled: row.enabled === 1
        }
      : null
  }

  assertGrant(expected: ModGrant): void {
    const actual = this.getGrant(expected.workspace, expected.modId)
    if (!actual?.enabled || actual.digest !== expected.digest || actual.epoch !== expected.epoch) {
      throw new ModError("MODS_GRANT_REVOKED")
    }
  }

  claim(
    id: string,
    toolId: string,
    args: unknown,
    identity?: ModIdentity,
    finalArgs: unknown = args
  ): void {
    const hash = createHash("sha256").update(toolId).update(encodeModJson(args)).digest("hex")
    const finalHash =
      args === finalArgs
        ? hash
        : createHash("sha256").update(toolId).update(encodeModJson(finalArgs)).digest("hex")
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO mods_calls(id,args_hash,status,at,tool_id,scope,workspace,thread_id,publication,final_args_hash) VALUES(?,?,'running',?,?,?,?,?,'pending',?)"
      )
      .run(
        id,
        hash,
        Date.now(),
        toolId,
        identity ? encodeModJson(identity) : null,
        identity?.workspace ?? null,
        identity?.threadId ?? null,
        finalHash
      )
    if (!inserted.changes) {
      const row = this.db.prepare("SELECT args_hash FROM mods_calls WHERE id=?").get(id)
      throw new ModError(
        row?.args_hash === hash ? "MODS_CALL_ALREADY_STARTED" : "MODS_CALL_ID_COLLISION"
      )
    }
  }

  claimFunctionModel(
    identity: ModIdentity,
    input: unknown,
    finalInput: unknown,
    modelRef: string,
    outputTokenLimit: number
  ): void {
    if (!Number.isSafeInteger(outputTokenLimit) || outputTokenLimit < 1 || outputTokenLimit > 4096)
      throw new ModError("MODS_MODEL_ARGUMENTS")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const usage = this.db
        .prepare(
          `SELECT COUNT(*) AS calls, COALESCE(SUM(json_extract(model_usage,'$.outputTokenLimit')),0) AS tokens
         FROM mods_calls WHERE workspace=? AND tool_id='model.complete' AND at>?
         AND json_extract(scope,'$.modId')=?`
        )
        .get(identity.workspace, Date.now() - 60000, identity.modId ?? "")
      if (Number(usage?.calls) >= 30 || Number(usage?.tokens) + outputTokenLimit > 32768)
        throw new ModError("MODS_MODEL_BUDGET")
      this.claim(identity.callId, "model.complete", input, identity, finalInput)
      this.db
        .prepare("UPDATE mods_calls SET model_usage=? WHERE id=?")
        .run(encodeModJson({ modelRef, outputTokenLimit }), identity.callId)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  recordFunctionModelUsage(id: string, inputTokens?: number, outputTokens?: number): void {
    const row = this.db.prepare("SELECT model_usage FROM mods_calls WHERE id=?").get(id)
    if (typeof row?.model_usage !== "string") throw new ModError("MODS_MODEL_USAGE_SCOPE")
    const usage = JSON.parse(row.model_usage) as NonNullable<ModAuditEntry["modelUsage"]>
    // Missing provider accounting stays absent; it is never reported as zero cost.
    if (Number.isSafeInteger(inputTokens) && inputTokens! >= 0) usage.inputTokens = inputTokens
    if (Number.isSafeInteger(outputTokens) && outputTokens! >= 0) usage.outputTokens = outputTokens
    this.db.prepare("UPDATE mods_calls SET model_usage=? WHERE id=?").run(encodeModJson(usage), id)
  }

  blockPublication(id: string): void {
    this.db.prepare("UPDATE mods_calls SET publication='blocked' WHERE id=?").run(id)
  }

  bindFinalInput(id: string, toolId: string, args: unknown): void {
    const row = this.db
      .prepare("SELECT status,tool_id,final_args_hash FROM mods_calls WHERE id=?")
      .get(id)
    if (!row || row.status !== "running" || row.tool_id !== toolId)
      throw new ModError("MODS_FINAL_INPUT_SCOPE")
    const hash = createHash("sha256").update(toolId).update(encodeModJson(args)).digest("hex")
    if (row.final_args_hash === hash) return
    this.db.prepare("UPDATE mods_calls SET final_args_hash=? WHERE id=?").run(hash, id)
  }

  settle(id: string, status: ModExecution): void {
    this.db
      .prepare("UPDATE mods_calls SET status=?,finished_at=? WHERE id=? AND status='running'")
      .run(status, Date.now(), id)
  }

  status(id: string): string | undefined {
    const row = this.db.prepare("SELECT status FROM mods_calls WHERE id=?").get(id)
    return typeof row?.status === "string" ? row.status : undefined
  }

  publication(
    id: string,
    digest: string,
    ruleIds: string[],
    status: ModAuditEntry["publication"]
  ): void {
    this.db
      .prepare(
        "UPDATE mods_calls SET policy_digest=?,rule_ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(COALESCE(mods_calls.rule_ids,'[]')) UNION SELECT value FROM json_each(?))),publication=? WHERE id=?"
      )
      .run(digest, encodeModJson(ruleIds), status, id)
  }

  audit(workspace: string, limit = 50, before = Number.MAX_SAFE_INTEGER): ModAuditEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(before))
      throw new ModError("MODS_AUDIT_QUERY")
    return this.db
      .prepare(
        "SELECT rowid AS cursor,* FROM mods_calls WHERE workspace=? AND rowid<? ORDER BY rowid DESC LIMIT ?"
      )
      .all(workspace, before, limit)
      .map((row) => ({
        cursor: Number(row.cursor),
        callId: String(row.id),
        toolId: String(row.tool_id),
        identity: row.scope ? (parseModJson(String(row.scope)) as unknown as ModIdentity) : null,
        status: String(row.status) as ModExecution,
        startedAt: Number(row.at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at),
        originalArgsHash: String(row.args_hash),
        finalArgsHash: row.final_args_hash as string | null,
        policyDigest: row.policy_digest as string | null,
        publication: (row.publication ?? "pending") as ModAuditEntry["publication"],
        ruleIds: row.rule_ids ? JSON.parse(String(row.rule_ids)) : [],
        reconciliation: row.reconciliation as ModAuditEntry["reconciliation"],
        ...(typeof row.model_usage === "string" ? { modelUsage: JSON.parse(row.model_usage) } : {})
      }))
  }

  reconcile(
    workspace: string,
    id: string,
    resolution: "confirmed-success" | "confirmed-failure"
  ): void {
    if (!["confirmed-success", "confirmed-failure"].includes(resolution))
      throw new ModError("MODS_RECONCILIATION_INVALID")
    const result = this.db
      .prepare(
        "UPDATE mods_calls SET reconciliation=? WHERE workspace=? AND id=? AND status='unknown' AND reconciliation IS NULL"
      )
      .run(resolution, workspace, id)
    if (!result.changes) throw new ModError("MODS_RECONCILIATION_STALE")
  }

  backup(path: string): void {
    // VACUUM INTO is a consistent SQLite snapshot, including the live WAL.
    this.db.prepare("VACUUM INTO ?").run(path)
  }

  read(namespace: string, key: string): ModJson {
    this.checkKey(key)
    const row = this.db
      .prepare("SELECT value FROM mods_state WHERE namespace=? AND key=?")
      .get(namespace, key)
    return row ? (parseModJson(String(row.value)) as ModJson) : null
  }

  write(namespace: string, key: string, value: ModJson): void {
    this.checkKey(key)
    const text = encodeModJson(value)
    if (Buffer.byteLength(text) > 64 * 1024) throw new ModError("MODS_STORE_VALUE_LIMIT")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT OR REPLACE INTO mods_state VALUES(?,?,?)").run(namespace, key, text)
      const row = this.db
        .prepare(
          "SELECT SUM(length(CAST(value AS BLOB))) AS bytes, COUNT(*) AS count FROM mods_state WHERE namespace=?"
        )
        .get(namespace)
      if (Number(row?.bytes) > 1024 * 1024 || Number(row?.count) > 256) {
        throw new ModError("MODS_STORE_QUOTA")
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  delete(namespace: string, key: string): void {
    this.checkKey(key)
    this.db.prepare("DELETE FROM mods_state WHERE namespace=? AND key=?").run(namespace, key)
  }

  close(): void {
    this.db.close()
  }

  private checkKey(key: string): void {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) {
      throw new ModError("MODS_STORE_KEY")
    }
  }
}
