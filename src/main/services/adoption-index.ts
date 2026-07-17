/**
 * Adoption Index
 *
 * SQLite-backed index for CodeGen events produced by the adoption tracker.
 * The index is the authoritative lookup structure when we need to find
 * pending unmeasured generations for a file at commit time.
 *
 * Design notes:
 *   - Uses sql.js (same as db/index.ts) to stay consistent with the rest of
 *     the main process. The database file lives at
 *     `~/.cmbcoworkagent/adoption-index.sqlite`.
 *   - JSONL shards retain local measurement history. SQLite is authoritative
 *     for pending generations, durable commit jobs, and delivery state.
 *   - All methods are synchronous after init — sql.js runs in-process and
 *     the data volume (14-day window) is small enough that there's no need
 *     for async buffering.
 *   - Writes are debounced to disk (same pattern as db/index.ts) to avoid
 *     hot-loop IO when many gen events fire in quick succession.
 */

import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { getOpenworkDir } from "../storage"
import { TRACE_OBSERVABILITY_SCHEMA_VERSION } from "../agent/trace/types"

// ─────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────

function getAdoptionIndexPath(): string {
  return join(getOpenworkDir(), "adoption-index.sqlite")
}

// ─────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────

let db: SqlJsDatabase | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false

function scheduleSave(): void {
  if (!db) return
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (db && dirty) {
      try {
        const data = db.export()
        writeFileSync(getAdoptionIndexPath(), Buffer.from(data))
        dirty = false
      } catch (e) {
        console.warn("[AdoptionIndex] save failed:", e)
      }
    }
  }, 500)
}

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface GenIndexRow {
  event_id: string
  file_path: string
  /** Tool that produced this generation ("write_file" | "edit_file"); null on legacy rows. */
  tool: string | null
  content_fingerprint: string | null
  shard_file: string
  shard_offset: number
  line_hashes: Uint8Array | null
  old_line_hashes: Uint8Array | null
  /** gzip(JSON string[]) of net generated lines, local-only for trace/debug UI. */
  generated_lines_blob: Uint8Array | null
  created_at: number
  measured: number
  /** JSON-encoded string[] of skill names active at gen time, or null. */
  used_skills: string | null
  /** JSON-encoded source map keyed by used_skills entries, or null. */
  skill_source: string | null
  thread_id: string | null
  trace_id: string | null
  model_id: string | null
  model_name: string | null
  /** Harness Board project this generation belongs to (project-mode only), or null. */
  harness_project_id: string | null
  harness_feature_slug: string | null
  /** Harness Board stage name (group-label) current at gen time (project-mode only), or null. */
  harness_node_name: string | null
  /** Stage status (the group-label node's status) current at gen time, or null. */
  harness_node_status: string | null
  /** Adapter plugin bound to the project at gen time, so adoption can be sliced by plugin version. */
  harness_adapter_name: string | null
  harness_adapter_version: string | null
  observability_schema_version: number | null
  trace_kind: string | null
  execution_mode: string | null
  root_trace_id: string | null
  root_thread_id: string | null
  parent_trace_id: string | null
  parent_thread_id: string | null
  parent_span_id: string | null
  link_type: string | null
  subagent_kind: string | null
  subagent_run_id: string | null
  subagent_thread_id: string | null
  handoff_action: string | null
  handoff_source_agent: string | null
  handoff_target_agent: string | null
  coordinator_worker_id: string | null
  coordinator_worker_turn: number | null
  coordinator_worker_role: string | null
  coordinator_worker_workload: string | null
  workflow_run_id: string | null
  workflow_agent_index: number | null
  workflow_phase: string | null
  workflow_agent_label: string | null
}

export interface AdoptLineDetailsRow {
  commit_sha: string
  gen_event_id: string
  file_path: string | null
  rel_path: string | null
  details_blob: Uint8Array
  measured_at: number
}

export type AdoptLineDetailsInput = Omit<AdoptLineDetailsRow, "gen_event_id">

export interface AdoptLineDetailsLimits {
  maxRows: number
  maxBytes: number
}

function readBlobStats(sql: string): { count: number; bytes: number } | null {
  if (!db) return null
  let stmt: ReturnType<SqlJsDatabase["prepare"]> | null = null
  try {
    stmt = db.prepare(sql)
    if (!stmt.step()) return { count: 0, bytes: 0 }
    const row = stmt.getAsObject() as unknown as { count: number; bytes: number }
    return {
      count: Number(row.count) || 0,
      bytes: Number(row.bytes) || 0
    }
  } catch (e) {
    console.warn("[AdoptionIndex] readBlobStats failed:", e)
    return null
  } finally {
    stmt?.free()
  }
}

export type EventOutboxStatus = "pending" | "sending" | "retry" | "delivered" | "dead_letter"

export interface EventOutboxInput {
  /** Stable top-level CoworkEvent.eventId. Retries MUST reuse this id. */
  eventId: string
  eventName: string
  payloadJson: string
  createdAt: number
}

export interface EventOutboxRow {
  event_id: string
  event_name: string
  payload_json: string
  status: EventOutboxStatus
  attempts: number
  next_attempt_at: number
  last_error: string | null
  created_at: number
  updated_at: number
  delivered_at: number | null
}

export type CommitJobStatus = "pending" | "processing" | "completed"

export interface CommitJobInput {
  jobId: string
  repoPath: string
  commitSha: string
  commitTimeMs?: number
  createdAt: number
}

export interface CommitJobRow {
  job_id: string
  repo_path: string
  commit_sha: string
  commit_time_ms: number | null
  status: CommitJobStatus
  attempts: number
  next_attempt_at: number
  last_error: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface AdoptionMeasurementWrite {
  genEventId: string
  /** Absent when a generation has no net-new baseline and needs no cloud event. */
  outboxEvent?: EventOutboxInput
  /** Local-only per-line detail persisted atomically with the terminal measurement. */
  details?: AdoptLineDetailsInput | null
  /** Optional storage bounds applied before the transaction is flushed to disk. */
  detailsLimits?: AdoptLineDetailsLimits
}

export interface AdoptionMeasurementCommitResult {
  success: boolean
  measuredCount: number
  enqueuedCount: number
}

// ─────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────

export async function initializeAdoptionIndex(): Promise<void> {
  if (db) return

  const dbPath = getAdoptionIndexPath()
  try {
    const SQL = await initSqlJs()

    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath)
      db = new SQL.Database(buffer)
    } else {
      const dir = dirname(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      db = new SQL.Database()
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS gen_events (
        event_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        tool TEXT,
        content_fingerprint TEXT,
        shard_file TEXT NOT NULL,
        shard_offset INTEGER NOT NULL,
        line_hashes BLOB,
        old_line_hashes BLOB,
        generated_lines_blob BLOB,
        created_at INTEGER NOT NULL,
        measured INTEGER NOT NULL DEFAULT 0,
        used_skills TEXT,
        skill_source TEXT,
        thread_id TEXT,
        trace_id TEXT,
        model_id TEXT,
        model_name TEXT,
        harness_project_id TEXT,
        harness_feature_slug TEXT,
        harness_node_name TEXT,
        harness_node_status TEXT,
        harness_adapter_name TEXT,
        harness_adapter_version TEXT,
        observability_schema_version INTEGER,
        trace_kind TEXT,
        execution_mode TEXT,
        root_trace_id TEXT,
        root_thread_id TEXT,
        parent_trace_id TEXT,
        parent_thread_id TEXT,
        parent_span_id TEXT,
        link_type TEXT,
        subagent_kind TEXT,
        subagent_run_id TEXT,
        subagent_thread_id TEXT,
        handoff_action TEXT,
        handoff_source_agent TEXT,
        handoff_target_agent TEXT,
        coordinator_worker_id TEXT,
        coordinator_worker_turn INTEGER,
        coordinator_worker_role TEXT,
        coordinator_worker_workload TEXT,
        workflow_run_id TEXT,
        workflow_agent_index INTEGER,
        workflow_phase TEXT,
        workflow_agent_label TEXT
      )
    `)

    db.run(`
      CREATE TABLE IF NOT EXISTS adopt_line_details (
        commit_sha TEXT NOT NULL,
        gen_event_id TEXT NOT NULL,
        file_path TEXT,
        rel_path TEXT,
        details_blob BLOB NOT NULL,
        measured_at INTEGER NOT NULL,
        PRIMARY KEY (commit_sha, gen_event_id)
      )
    `)

    // Migrate older DBs that pre-date the attribution columns. sql.js does not
    // support "ADD COLUMN IF NOT EXISTS", so we swallow the "duplicate column"
    // error each ALTER may throw on an already-migrated DB.
    for (const col of [
      "tool TEXT",
      "used_skills TEXT",
      "skill_source TEXT",
      "thread_id TEXT",
      "trace_id TEXT",
      "model_id TEXT",
      "model_name TEXT",
      "old_line_hashes BLOB",
      "generated_lines_blob BLOB",
      "harness_project_id TEXT",
      "harness_feature_slug TEXT",
      "harness_node_name TEXT",
      "harness_node_status TEXT",
      "harness_adapter_name TEXT",
      "harness_adapter_version TEXT",
      "observability_schema_version INTEGER",
      "trace_kind TEXT",
      "execution_mode TEXT",
      "root_trace_id TEXT",
      "root_thread_id TEXT",
      "parent_trace_id TEXT",
      "parent_thread_id TEXT",
      "parent_span_id TEXT",
      "link_type TEXT",
      "subagent_kind TEXT",
      "subagent_run_id TEXT",
      "subagent_thread_id TEXT",
      "handoff_action TEXT",
      "handoff_source_agent TEXT",
      "handoff_target_agent TEXT",
      "coordinator_worker_id TEXT",
      "coordinator_worker_turn INTEGER",
      "coordinator_worker_role TEXT",
      "coordinator_worker_workload TEXT",
      "workflow_run_id TEXT",
      "workflow_agent_index INTEGER",
      "workflow_phase TEXT",
      "workflow_agent_label TEXT"
    ]) {
      try {
        db.run(`ALTER TABLE gen_events ADD COLUMN ${col}`)
      } catch {
        // column already exists — safe to ignore
      }
    }

    // Historical code-gen rows pre-date coordinator/workflow telemetry. Because
    // those modes were not emitted in that history, rows with an existing trace_id
    // can be safely normalized as root/normal for commit-time code_adopt events.
    db.run(
      `UPDATE gen_events
          SET observability_schema_version = COALESCE(observability_schema_version, ?),
              trace_kind = COALESCE(trace_kind, 'root'),
              execution_mode = COALESCE(execution_mode, 'normal'),
              root_trace_id = COALESCE(root_trace_id, trace_id),
              root_thread_id = COALESCE(root_thread_id, thread_id)
        WHERE trace_id IS NOT NULL
          AND (observability_schema_version IS NULL
            OR trace_kind IS NULL
            OR execution_mode IS NULL
            OR root_trace_id IS NULL
            OR root_thread_id IS NULL)`,
      [TRACE_OBSERVABILITY_SCHEMA_VERSION]
    )
    if (db.getRowsModified() > 0) scheduleSave()

    db.run(
      `CREATE INDEX IF NOT EXISTS idx_gen_file_pending
       ON gen_events(file_path, measured, created_at DESC)`
    )
    db.run(`CREATE INDEX IF NOT EXISTS idx_gen_created_at ON gen_events(created_at)`)
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_adopt_line_details_measured_at ON adopt_line_details(measured_at)`
    )

    // Transactional outbox for durable adoption telemetry (terminal adoption
    // events plus separately reported test-code generations). The complete
    // CoworkEvent payload is stored once so every retry reuses the
    // server-idempotent top-level eventId instead of rebuilding a new envelope.
    db.run(`
      CREATE TABLE IF NOT EXISTS event_outbox (
        event_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      )
    `)
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_event_outbox_due
         ON event_outbox(status, next_attempt_at, created_at)`
    )

    // Durable commit measurement queue. repo_path + commit_sha is enough to
    // reconstruct the committed blobs after restart, so large snapshots never
    // need to be copied into this sqlite file.
    db.run(`
      CREATE TABLE IF NOT EXISTS commit_jobs (
        job_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        commit_time_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(repo_path, commit_sha)
      )
    `)
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_commit_jobs_due
         ON commit_jobs(status, next_attempt_at, created_at)`
    )

    scheduleSave()
    console.log("[AdoptionIndex] initialized at", dbPath)
  } catch (e) {
    console.warn("[AdoptionIndex] init failed (tracker will degrade gracefully):", e)
    db = null
  }
}

export function flushAdoptionIndex(): boolean {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (db && dirty) {
    try {
      const data = db.export()
      writeFileSync(getAdoptionIndexPath(), Buffer.from(data))
      dirty = false
      return true
    } catch (e) {
      console.warn("[AdoptionIndex] flush failed:", e)
      return false
    }
  }
  return db !== null
}

export function closeAdoptionIndex(): void {
  flushAdoptionIndex()
  if (db) {
    db.close()
    db = null
  }
}

// ─────────────────────────────────────────────────────────
// Queries (all guarded against uninitialised db)
// ─────────────────────────────────────────────────────────

/**
 * Insert a generation baseline into the authoritative measurement index.
 *
 * The boolean result is intentionally fail-closed for cloud `code_gen`
 * reporting: callers must not publish a generation that cannot later be
 * resolved at commit time.
 */
export function insertGenEvent(row: GenIndexRow): boolean {
  if (!db) return false
  try {
    db.run(
      `INSERT OR REPLACE INTO gen_events
       (event_id, file_path, tool, content_fingerprint, shard_file, shard_offset, line_hashes, old_line_hashes,
        generated_lines_blob, created_at, measured,
        used_skills, skill_source, thread_id, trace_id, model_id, model_name,
        harness_project_id, harness_feature_slug, harness_node_name, harness_node_status, harness_adapter_name, harness_adapter_version,
        observability_schema_version, trace_kind, execution_mode, root_trace_id, root_thread_id,
        parent_trace_id, parent_thread_id, parent_span_id, link_type, subagent_kind, subagent_run_id,
        subagent_thread_id, handoff_action, handoff_source_agent, handoff_target_agent,
        coordinator_worker_id, coordinator_worker_turn, coordinator_worker_role, coordinator_worker_workload,
        workflow_run_id, workflow_agent_index, workflow_phase, workflow_agent_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.event_id,
        row.file_path,
        row.tool,
        row.content_fingerprint,
        row.shard_file,
        row.shard_offset,
        row.line_hashes ?? null,
        row.old_line_hashes ?? null,
        row.generated_lines_blob ?? null,
        row.created_at,
        row.measured,
        row.used_skills,
        row.skill_source,
        row.thread_id,
        row.trace_id,
        row.model_id,
        row.model_name,
        row.harness_project_id,
        row.harness_feature_slug,
        row.harness_node_name,
        row.harness_node_status,
        row.harness_adapter_name,
        row.harness_adapter_version,
        row.observability_schema_version,
        row.trace_kind,
        row.execution_mode,
        row.root_trace_id,
        row.root_thread_id,
        row.parent_trace_id,
        row.parent_thread_id,
        row.parent_span_id,
        row.link_type,
        row.subagent_kind,
        row.subagent_run_id,
        row.subagent_thread_id,
        row.handoff_action,
        row.handoff_source_agent,
        row.handoff_target_agent,
        row.coordinator_worker_id,
        row.coordinator_worker_turn,
        row.coordinator_worker_role,
        row.coordinator_worker_workload,
        row.workflow_run_id,
        row.workflow_agent_index,
        row.workflow_phase,
        row.workflow_agent_label
      ]
    )
    scheduleSave()
    return true
  } catch (e) {
    console.warn("[AdoptionIndex] insertGenEvent failed:", e)
    return false
  }
}

/**
 * Find all unmeasured gen events for a file within the retention window,
 * newest first. Returns an empty array when none exists.
 *
 * `maxCreatedAt` (optional) is an inclusive upper bound on the generation time.
 * Commit-driven measurement passes the commit's creation time here so a
 * generation that happened *after* the commit (e.g. the next turn editing the
 * same file before it is committed again) is never attributed to that commit.
 * Without it, an out-of-order re-measure of an old commit — notably the commit
 * reconciler / hook sync running long after the commit — would vacuum unrelated
 * later generations into the old commit, inflating its generated-line
 * denominator and consuming gens the real commit should have claimed.
 */
export function findPendingGensForFile(
  filePath: string,
  minCreatedAt: number,
  maxCreatedAt?: number
): GenIndexRow[] {
  if (!db) return []
  const hasMax = typeof maxCreatedAt === "number" && Number.isFinite(maxCreatedAt)
  const stmt = db.prepare(
    `SELECT event_id, file_path, content_fingerprint, shard_file, shard_offset,
            line_hashes, old_line_hashes, generated_lines_blob, created_at, measured,
            used_skills, skill_source, thread_id, trace_id, model_id, model_name,
            harness_project_id, harness_feature_slug, harness_node_name, harness_node_status, harness_adapter_name, harness_adapter_version,
            observability_schema_version, trace_kind, execution_mode, root_trace_id, root_thread_id,
            parent_trace_id, parent_thread_id, parent_span_id, link_type, subagent_kind, subagent_run_id,
            subagent_thread_id, handoff_action, handoff_source_agent, handoff_target_agent,
            coordinator_worker_id, coordinator_worker_turn, coordinator_worker_role, coordinator_worker_workload,
            workflow_run_id, workflow_agent_index, workflow_phase, workflow_agent_label,
            tool
       FROM gen_events
      WHERE file_path = ? AND measured = 0 AND created_at >= ?${hasMax ? " AND created_at <= ?" : ""}
      ORDER BY created_at DESC`
  )
  stmt.bind(hasMax ? [filePath, minCreatedAt, maxCreatedAt as number] : [filePath, minCreatedAt])
  try {
    const rows: GenIndexRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as GenIndexRow)
    }
    return rows
  } finally {
    stmt.free()
  }
}

/**
 * Fetch a single gen row by its `event_id` (primary key). Used by the local
 * line-level 溯源 reader to recover the stored per-line hashes + absolute file
 * path for a specific generation. Returns null when the row is absent (e.g.
 * already pruned by retention, oversize baselines that skip the index, or a gen
 * produced on another machine / by another user).
 */
export function getGenRowByEventId(eventId: string): GenIndexRow | null {
  if (!db || !eventId) return null
  const stmt = db.prepare(
    `SELECT event_id, file_path, content_fingerprint, shard_file, shard_offset,
            line_hashes, old_line_hashes, generated_lines_blob, created_at, measured,
            used_skills, skill_source, thread_id, trace_id, model_id, model_name,
            harness_project_id, harness_feature_slug, harness_node_name, harness_node_status, harness_adapter_name, harness_adapter_version,
            observability_schema_version, trace_kind, execution_mode, root_trace_id, root_thread_id,
            parent_trace_id, parent_thread_id, parent_span_id, link_type, subagent_kind, subagent_run_id,
            subagent_thread_id, handoff_action, handoff_source_agent, handoff_target_agent,
            coordinator_worker_id, coordinator_worker_turn, coordinator_worker_role, coordinator_worker_workload,
            workflow_run_id, workflow_agent_index, workflow_phase, workflow_agent_label,
            tool
       FROM gen_events
      WHERE event_id = ?`
  )
  stmt.bind([eventId])
  try {
    if (!stmt.step()) return null
    return stmt.getAsObject() as unknown as GenIndexRow
  } finally {
    stmt.free()
  }
}

/**
 * Lightweight listing of all *pending* (unmeasured) generations within the
 * window: just `event_id` + `file_path`, no BLOBs. Used by the agent shell-op
 * handler (rm/mv) to find pending gens at/under a deleted-or-moved path without
 * loading every line-hash blob.
 */
export function listPendingGenPaths(
  minCreatedAt: number
): { event_id: string; file_path: string }[] {
  if (!db) return []
  const stmt = db.prepare(
    `SELECT event_id, file_path FROM gen_events WHERE measured = 0 AND created_at >= ?`
  )
  stmt.bind([minCreatedAt])
  try {
    const rows: { event_id: string; file_path: string }[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as { event_id: string; file_path: string })
    }
    return rows
  } finally {
    stmt.free()
  }
}

/**
 * Rewrite a gen row's `file_path`. Used when an agent `mv` relocates a pending
 * generation before it is committed, so commit-time attribution (keyed by path)
 * finds it at its new home and still credits adoption.
 */
export function updateGenFilePath(eventId: string, newFilePath: string): void {
  if (!db) return
  try {
    db.run(`UPDATE gen_events SET file_path = ? WHERE event_id = ?`, [newFilePath, eventId])
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] updateGenFilePath failed:", e)
  }
}

function insertAdoptLineDetailsRow(eventId: string, row: AdoptLineDetailsInput): void {
  if (!db) throw new Error("adoption index is not initialized")
  db.run(
    `INSERT OR REPLACE INTO adopt_line_details
     (commit_sha, gen_event_id, file_path, rel_path, details_blob, measured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.commit_sha, eventId, row.file_path, row.rel_path, row.details_blob, row.measured_at]
  )
}

/**
 * Atomically finish one generation measurement. When line details are
 * available they are stored in the same transaction that marks the generation
 * measured and clears its temporary source-text payload.
 */
export function finalizeGenMeasurement(
  eventId: string,
  details: AdoptLineDetailsInput | null = null,
  limits?: AdoptLineDetailsLimits
): boolean {
  if (!db || !eventId) return false
  try {
    db.run("BEGIN")
    if (details) insertAdoptLineDetailsRow(eventId, details)
    db.run(
      `UPDATE gen_events
          SET measured = 1,
              generated_lines_blob = NULL
        WHERE event_id = ?`,
      [eventId]
    )
    if (db.getRowsModified() === 0) {
      throw new Error(`generation not found: ${eventId}`)
    }
    db.run("COMMIT")
    if (details && limits) trimAdoptLineDetails(limits.maxRows, limits.maxBytes)
    scheduleSave()
    return true
  } catch (e) {
    try {
      db.run("ROLLBACK")
    } catch {
      // best effort
    }
    console.warn("[AdoptionIndex] finalizeGenMeasurement failed:", e)
    return false
  }
}

function insertOutboxEventUnsafe(event: EventOutboxInput): boolean {
  if (!db) throw new Error("adoption index is not initialized")
  db.run(
    `INSERT OR IGNORE INTO event_outbox
       (event_id, event_name, payload_json, status, attempts, next_attempt_at,
        last_error, created_at, updated_at, delivered_at)
     VALUES (?, ?, ?, 'pending', 0, 0, NULL, ?, ?, NULL)`,
    [event.eventId, event.eventName, event.payloadJson, event.createdAt, event.createdAt]
  )
  if (db.getRowsModified() > 0) return true

  const stmt = db.prepare(`SELECT event_name, payload_json FROM event_outbox WHERE event_id = ?`)
  stmt.bind([event.eventId])
  try {
    if (!stmt.step()) throw new Error(`outbox conflict disappeared: ${event.eventId}`)
    const existing = stmt.getAsObject() as { event_name?: unknown; payload_json?: unknown }
    if (existing.event_name !== event.eventName || existing.payload_json !== event.payloadJson) {
      throw new Error(`outbox eventId reused with a different payload: ${event.eventId}`)
    }
    return false
  } finally {
    stmt.free()
  }
}

/** Persist a standalone adoption event (for example code_test_gen/skipped_large). */
export function enqueueEventOutbox(event: EventOutboxInput, flushNow = true): boolean {
  if (!db) return false
  try {
    db.run("BEGIN TRANSACTION")
    insertOutboxEventUnsafe(event)
    db.run("COMMIT")
    scheduleSave()
    return !flushNow || flushAdoptionIndex()
  } catch (e) {
    try {
      db.run("ROLLBACK")
    } catch {
      // transaction may already have committed
    }
    console.warn("[AdoptionIndex] enqueueEventOutbox failed:", e)
    return false
  }
}

/**
 * Atomically closes pending generation rows, enqueues their immutable cloud
 * events, and completes the owning commit job. Network delivery is deliberately
 * outside this transaction; the outbox survives offline periods and restarts.
 */
export function commitAdoptionMeasurements(
  writes: AdoptionMeasurementWrite[],
  commitJobId?: string
): AdoptionMeasurementCommitResult {
  if (!db) return { success: false, measuredCount: 0, enqueuedCount: 0 }
  let measuredCount = 0
  let enqueuedCount = 0
  let detailsLimits: AdoptLineDetailsLimits | undefined
  try {
    db.run("BEGIN TRANSACTION")
    for (const write of writes) {
      db.run(
        `UPDATE gen_events
            SET measured = 1,
                generated_lines_blob = NULL
          WHERE event_id = ? AND measured = 0`,
        [write.genEventId]
      )
      if (db.getRowsModified() <= 0) continue
      measuredCount += 1
      if (write.details) insertAdoptLineDetailsRow(write.genEventId, write.details)
      if (write.detailsLimits) detailsLimits = write.detailsLimits
      if (write.outboxEvent) {
        if (insertOutboxEventUnsafe(write.outboxEvent)) enqueuedCount += 1
      }
    }
    if (commitJobId) {
      const now = Date.now()
      db.run(
        `UPDATE commit_jobs
            SET status = 'completed', completed_at = ?, updated_at = ?, last_error = NULL
          WHERE job_id = ?`,
        [now, now, commitJobId]
      )
      if (db.getRowsModified() <= 0) {
        throw new Error(`commit job not found: ${commitJobId}`)
      }
    }
    db.run("COMMIT")
    if (detailsLimits) trimAdoptLineDetails(detailsLimits.maxRows, detailsLimits.maxBytes)
    scheduleSave()
    // A completed job must be durable before its caller writes processed-commits.json.
    if (!flushAdoptionIndex()) {
      // Keep the in-memory job retryable. Its measured rows and outbox payloads
      // remain together in the same database image and will be flushed on the
      // next attempt; callers must not advance processed-commits yet.
      if (commitJobId) {
        const now = Date.now()
        db.run(
          `UPDATE commit_jobs
              SET status = 'pending', completed_at = NULL, next_attempt_at = 0,
                  last_error = 'sqlite flush failed', updated_at = ?
            WHERE job_id = ?`,
          [now, commitJobId]
        )
        scheduleSave()
      }
      return { success: false, measuredCount: 0, enqueuedCount: 0 }
    }
    return { success: true, measuredCount, enqueuedCount }
  } catch (e) {
    try {
      db.run("ROLLBACK")
    } catch {
      // transaction may already have committed
    }
    console.warn("[AdoptionIndex] commitAdoptionMeasurements failed:", e)
    return { success: false, measuredCount: 0, enqueuedCount: 0 }
  }
}

export function enqueueCommitJob(input: CommitJobInput): CommitJobRow | null {
  if (!db) return null
  try {
    db.run(
      `INSERT INTO commit_jobs
         (job_id, repo_path, commit_sha, commit_time_ms, status, attempts,
          next_attempt_at, last_error, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?, NULL)
       ON CONFLICT(job_id) DO UPDATE SET
         repo_path = excluded.repo_path,
         commit_sha = excluded.commit_sha,
         commit_time_ms = COALESCE(commit_jobs.commit_time_ms, excluded.commit_time_ms),
         updated_at = CASE
           WHEN commit_jobs.status = 'completed' THEN commit_jobs.updated_at
           ELSE excluded.updated_at
         END`,
      [
        input.jobId,
        input.repoPath,
        input.commitSha,
        input.commitTimeMs ?? null,
        input.createdAt,
        input.createdAt
      ]
    )
    scheduleSave()
    // Persist the recovery record before starting any asynchronous measurement.
    if (!flushAdoptionIndex()) return null
    return getCommitJob(input.jobId)
  } catch (e) {
    console.warn("[AdoptionIndex] enqueueCommitJob failed:", e)
    return null
  }
}

export function getCommitJob(jobId: string): CommitJobRow | null {
  if (!db || !jobId) return null
  const stmt = db.prepare(`SELECT * FROM commit_jobs WHERE job_id = ?`)
  stmt.bind([jobId])
  try {
    return stmt.step() ? (stmt.getAsObject() as unknown as CommitJobRow) : null
  } finally {
    stmt.free()
  }
}

export function listDueCommitJobs(now: number, limit: number): CommitJobRow[] {
  if (!db) return []
  const stmt = db.prepare(
    `SELECT * FROM commit_jobs
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT ?`
  )
  stmt.bind([now, Math.max(1, limit)])
  try {
    const rows: CommitJobRow[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as CommitJobRow)
    return rows
  } finally {
    stmt.free()
  }
}

export function markCommitJobProcessing(jobId: string): boolean {
  if (!db) return false
  try {
    const now = Date.now()
    db.run(
      `UPDATE commit_jobs
          SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE job_id = ? AND status = 'pending'`,
      [now, jobId]
    )
    const changed = db.getRowsModified() > 0
    if (changed) scheduleSave()
    return changed
  } catch (e) {
    console.warn("[AdoptionIndex] markCommitJobProcessing failed:", e)
    return false
  }
}

export function markCommitJobRetry(jobId: string, nextAttemptAt: number, error: string): void {
  if (!db) return
  try {
    const now = Date.now()
    db.run(
      `UPDATE commit_jobs
          SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE job_id = ? AND status != 'completed'`,
      [nextAttemptAt, error.slice(0, 2000), now, jobId]
    )
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] markCommitJobRetry failed:", e)
  }
}

export function resetInterruptedCommitJobs(): void {
  if (!db) return
  try {
    const now = Date.now()
    db.run(
      `UPDATE commit_jobs
          SET status = 'pending', next_attempt_at = 0,
              last_error = COALESCE(last_error, 'interrupted before completion'), updated_at = ?
        WHERE status = 'processing'`,
      [now]
    )
    if (db.getRowsModified() > 0) scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] resetInterruptedCommitJobs failed:", e)
  }
}

export function listDueOutboxEvents(now: number, limit: number): EventOutboxRow[] {
  if (!db) return []
  const stmt = db.prepare(
    `SELECT * FROM event_outbox
      WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT ?`
  )
  stmt.bind([now, Math.max(1, limit)])
  try {
    const rows: EventOutboxRow[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as EventOutboxRow)
    return rows
  } finally {
    stmt.free()
  }
}

export function getOutboxEvent(eventId: string): EventOutboxRow | null {
  if (!db || !eventId) return null
  const stmt = db.prepare(`SELECT * FROM event_outbox WHERE event_id = ?`)
  stmt.bind([eventId])
  try {
    return stmt.step() ? (stmt.getAsObject() as unknown as EventOutboxRow) : null
  } finally {
    stmt.free()
  }
}

export function markOutboxSending(eventId: string): boolean {
  if (!db) return false
  try {
    const now = Date.now()
    db.run(
      `UPDATE event_outbox
          SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE event_id = ? AND status IN ('pending', 'retry')`,
      [now, eventId]
    )
    const changed = db.getRowsModified() > 0
    if (changed) scheduleSave()
    return changed
  } catch (e) {
    console.warn("[AdoptionIndex] markOutboxSending failed:", e)
    return false
  }
}

export function getAdoptLineDetails(
  commitSha: string,
  genEventId: string
): AdoptLineDetailsRow | null {
  if (!db || !commitSha || !genEventId) return null
  const stmt = db.prepare(
    `SELECT commit_sha, gen_event_id, file_path, rel_path, details_blob, measured_at
       FROM adopt_line_details
      WHERE commit_sha = ? AND gen_event_id = ?`
  )
  stmt.bind([commitSha, genEventId])
  try {
    if (!stmt.step()) return null
    return stmt.getAsObject() as unknown as AdoptLineDetailsRow
  } finally {
    stmt.free()
  }
}

export function markOutboxDelivered(eventId: string): void {
  if (!db) return
  try {
    const now = Date.now()
    db.run(
      `UPDATE event_outbox
          SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL
        WHERE event_id = ?`,
      [now, now, eventId]
    )
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] markOutboxDelivered failed:", e)
  }
}

export function markOutboxFailed(
  eventId: string,
  error: string,
  nextAttemptAt: number,
  permanent: boolean
): void {
  if (!db) return
  try {
    const now = Date.now()
    db.run(
      `UPDATE event_outbox
          SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE event_id = ?`,
      [permanent ? "dead_letter" : "retry", nextAttemptAt, error.slice(0, 2000), now, eventId]
    )
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] markOutboxFailed failed:", e)
  }
}

export function resetInterruptedOutboxEvents(staleBefore: number): void {
  if (!db) return
  try {
    const now = Date.now()
    db.run(
      `UPDATE event_outbox
          SET status = 'retry', next_attempt_at = 0,
              last_error = COALESCE(last_error, 'interrupted while sending'), updated_at = ?
        WHERE status = 'sending' AND updated_at <= ?`,
      [now, staleBefore]
    )
    if (db.getRowsModified() > 0) scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] resetInterruptedOutboxEvents failed:", e)
  }
}

export function cleanupAdoptionDeliveryRecords(cutoff: number): void {
  if (!db) return
  try {
    // The outbox has one total retention window measured from event creation.
    // This applies to unresolved rows too, so a permanently offline endpoint
    // cannot grow the database forever.
    db.run(`DELETE FROM event_outbox WHERE created_at < ?`, [cutoff])
    const outboxDeleted = db.getRowsModified()
    db.run(
      `DELETE FROM commit_jobs
        WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?`,
      [cutoff]
    )
    if (outboxDeleted > 0 || db.getRowsModified() > 0) scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] cleanupAdoptionDeliveryRecords failed:", e)
  }
}

/**
 * Remove rows older than `cutoff` (epoch ms). Used by retention cleanup.
 */
export function deleteOlderThan(cutoff: number): number {
  if (!db) return 0
  try {
    db.run(`DELETE FROM gen_events WHERE created_at < ?`, [cutoff])
    scheduleSave()
    // sql.js doesn't expose rowsAffected on run(); return 0 — callers use this for logging only.
    return 0
  } catch (e) {
    console.warn("[AdoptionIndex] deleteOlderThan failed:", e)
    return 0
  }
}

/**
 * Remove already-measured rows older than `cutoff`. These rows have no further
 * use (findPendingGensForFile filters measured=0), so
 * we can evict them far more aggressively than the full 14-day window.
 */
export function deleteMeasuredOlderThan(cutoff: number): void {
  if (!db) return
  try {
    db.run(`DELETE FROM gen_events WHERE measured = 1 AND created_at < ?`, [cutoff])
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] deleteMeasuredOlderThan failed:", e)
  }
}

export function deleteAdoptLineDetailsOlderThan(cutoff: number): void {
  if (!db) return
  try {
    db.run(`DELETE FROM adopt_line_details WHERE measured_at < ?`, [cutoff])
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] deleteAdoptLineDetailsOlderThan failed:", e)
  }
}

/**
 * Bound pending generated source text without deleting its attribution hashes.
 * Oldest source payloads degrade to the hash-only trace path first.
 */
export function trimGeneratedSourceTextToByteCap(maxBytes: number): void {
  if (!db || !Number.isFinite(maxBytes) || maxBytes < 0) return
  const stats = readBlobStats(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(length(generated_lines_blob)), 0) AS bytes
       FROM gen_events
      WHERE generated_lines_blob IS NOT NULL`
  )
  if (!stats) return
  if (stats.bytes <= maxBytes) return
  let stmt: ReturnType<SqlJsDatabase["prepare"]> | null = null
  try {
    stmt = db.prepare(
      `SELECT length(generated_lines_blob) AS bytes
         FROM gen_events
        WHERE generated_lines_blob IS NOT NULL
        ORDER BY created_at ASC, event_id ASC`
    )
    const sizes: number[] = []
    let totalBytes = 0
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { bytes: number }
      const bytes = Number(row.bytes) || 0
      sizes.push(bytes)
      totalBytes += bytes
    }
    if (totalBytes <= maxBytes) return

    let trimCount = 0
    while (trimCount < sizes.length && totalBytes > maxBytes) {
      totalBytes -= sizes[trimCount]
      trimCount++
    }
    if (trimCount === 0) return
    db.run(
      `UPDATE gen_events
          SET generated_lines_blob = NULL
        WHERE event_id IN (
          SELECT event_id
            FROM gen_events
           WHERE generated_lines_blob IS NOT NULL
           ORDER BY created_at ASC, event_id ASC
           LIMIT ?
        )`,
      [trimCount]
    )
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] trimGeneratedSourceTextToByteCap failed:", e)
  } finally {
    stmt?.free()
  }
}

/** Bound completed line details by both row count and compressed BLOB bytes. */
export function trimAdoptLineDetails(maxRows: number, maxBytes: number): void {
  if (
    !db ||
    !Number.isFinite(maxRows) ||
    maxRows < 0 ||
    !Number.isFinite(maxBytes) ||
    maxBytes < 0
  ) {
    return
  }
  const normalizedMaxRows = Math.floor(maxRows)
  const stats = readBlobStats(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(length(details_blob)), 0) AS bytes
       FROM adopt_line_details`
  )
  if (!stats) return
  if (stats.count <= normalizedMaxRows && stats.bytes <= maxBytes) return
  let stmt: ReturnType<SqlJsDatabase["prepare"]> | null = null
  try {
    stmt = db.prepare(
      `SELECT length(details_blob) AS bytes
         FROM adopt_line_details
        ORDER BY measured_at ASC, rowid ASC`
    )
    const sizes: number[] = []
    let totalBytes = 0
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { bytes: number }
      const bytes = Number(row.bytes) || 0
      sizes.push(bytes)
      totalBytes += bytes
    }

    let trimCount = Math.max(0, sizes.length - normalizedMaxRows)
    let remainingBytes = totalBytes
    for (let i = 0; i < trimCount; i++) remainingBytes -= sizes[i]
    while (trimCount < sizes.length && remainingBytes > maxBytes) {
      remainingBytes -= sizes[trimCount]
      trimCount++
    }
    if (trimCount === 0) return

    db.run(
      `DELETE FROM adopt_line_details
        WHERE rowid IN (
          SELECT rowid
            FROM adopt_line_details
           ORDER BY measured_at ASC, rowid ASC
           LIMIT ?
        )`,
      [trimCount]
    )
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] trimAdoptLineDetails failed:", e)
  } finally {
    stmt?.free()
  }
}

/**
 * Count rows currently in the index. Used by the hard row-count cap.
 */
export function countRows(): number {
  if (!db) return 0
  const stmt = db.prepare(`SELECT COUNT(*) AS c FROM gen_events`)
  try {
    if (!stmt.step()) return 0
    const row = stmt.getAsObject() as unknown as { c: number }
    return row.c ?? 0
  } finally {
    stmt.free()
  }
}

/**
 * Belt-and-suspenders cap on total rows. If the table exceeds `maxRows`, drop
 * the oldest *measured* rows first (they're expendable); only if still over
 * cap do we touch unmeasured rows.
 */
export function trimToRowCap(maxRows: number): void {
  if (!db) return
  const current = countRows()
  if (current <= maxRows) return
  const over = current - maxRows
  try {
    // Phase 1: drop oldest measured rows first
    db.run(
      `DELETE FROM gen_events
        WHERE event_id IN (
          SELECT event_id FROM gen_events
           WHERE measured = 1
           ORDER BY created_at ASC
           LIMIT ?
        )`,
      [over]
    )
    // Phase 2: if still over cap, drop oldest unmeasured rows (lose some L2 data)
    const after = countRows()
    if (after > maxRows) {
      db.run(
        `DELETE FROM gen_events
          WHERE event_id IN (
            SELECT event_id FROM gen_events
             ORDER BY created_at ASC
             LIMIT ?
          )`,
        [after - maxRows]
      )
    }
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] trimToRowCap failed:", e)
  }
}

/**
 * Reclaim disk space previously freed by DELETE. sql.js / sqlite do not
 * auto-shrink on DELETE — pages become "free" but the file size stays at
 * peak. We VACUUM periodically (not every sweep) to amortise the cost.
 */
export function vacuumAdoptionIndex(): void {
  if (!db) return
  try {
    db.run("VACUUM")
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] VACUUM failed:", e)
  }
}
