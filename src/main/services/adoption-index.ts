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
        harness_adapter_version TEXT
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
      "harness_project_id TEXT",
      "harness_feature_slug TEXT",
      "harness_node_name TEXT",
      "harness_node_status TEXT",
      "harness_adapter_name TEXT",
      "harness_adapter_version TEXT"
    ]) {
      try {
        db.run(`ALTER TABLE gen_events ADD COLUMN ${col}`)
      } catch {
        // column already exists — safe to ignore
      }
    }

    db.run(
      `CREATE INDEX IF NOT EXISTS idx_gen_file_pending
       ON gen_events(file_path, measured, created_at DESC)`
    )
    db.run(`CREATE INDEX IF NOT EXISTS idx_gen_created_at ON gen_events(created_at)`)

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

export function insertGenEvent(row: GenIndexRow): void {
  if (!db) return
  try {
    db.run(
      `INSERT OR REPLACE INTO gen_events
       (event_id, file_path, tool, content_fingerprint, shard_file, shard_offset, line_hashes, old_line_hashes, created_at, measured,
        used_skills, skill_source, thread_id, trace_id, model_id, model_name,
        harness_project_id, harness_feature_slug, harness_node_name, harness_node_status, harness_adapter_name, harness_adapter_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.event_id,
        row.file_path,
        row.tool,
        row.content_fingerprint,
        row.shard_file,
        row.shard_offset,
        row.line_hashes ?? null,
        row.old_line_hashes ?? null,
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
        row.harness_adapter_version
      ]
    )
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] insertGenEvent failed:", e)
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
            line_hashes, old_line_hashes, created_at, measured,
            used_skills, skill_source, thread_id, trace_id, model_id, model_name,
            harness_project_id, harness_feature_slug, harness_node_name, harness_node_status, harness_adapter_name, harness_adapter_version,
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
            line_hashes, old_line_hashes, created_at, measured,
            used_skills, skill_source, thread_id, trace_id, model_id, model_name,
            harness_project_id, harness_feature_slug, harness_node_name, harness_node_status, harness_adapter_name, harness_adapter_version,
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
  try {
    db.run("BEGIN TRANSACTION")
    for (const write of writes) {
      db.run(`UPDATE gen_events SET measured = 1 WHERE event_id = ? AND measured = 0`, [
        write.genEventId
      ])
      if (db.getRowsModified() <= 0) continue
      measuredCount += 1
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
    db.run(
      `DELETE FROM event_outbox WHERE created_at < ?`,
      [cutoff]
    )
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
