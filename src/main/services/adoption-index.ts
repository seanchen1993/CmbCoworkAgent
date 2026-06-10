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
 *   - The JSONL shard files on disk remain the source of truth; this index
 *     is a fast query layer and can be rebuilt from JSONL if lost.
 *   - All methods are synchronous after init — sql.js runs in-process and
 *     the data volume (7-day window) is small enough that there's no need
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
  content_fingerprint: string | null
  shard_file: string
  shard_offset: number
  line_hashes: Uint8Array | null
  old_line_hashes: Uint8Array | null
  created_at: number
  measured: number
  /** JSON-encoded string[] of skill names active at gen time, or null. */
  used_skills: string | null
  thread_id: string | null
  trace_id: string | null
  model_id: string | null
  model_name: string | null
  /** Harness Board project this generation belongs to (project-mode only), or null. */
  harness_project_id: string | null
  harness_feature_slug: string | null
  /** Adapter plugin bound to the project at gen time, so adoption can be sliced by plugin version. */
  harness_adapter_name: string | null
  harness_adapter_version: string | null
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
        content_fingerprint TEXT,
        shard_file TEXT NOT NULL,
        shard_offset INTEGER NOT NULL,
        line_hashes BLOB,
        old_line_hashes BLOB,
        created_at INTEGER NOT NULL,
        measured INTEGER NOT NULL DEFAULT 0,
        used_skills TEXT,
        thread_id TEXT,
        trace_id TEXT,
        model_id TEXT,
        model_name TEXT,
        harness_project_id TEXT,
        harness_feature_slug TEXT,
        harness_adapter_name TEXT,
        harness_adapter_version TEXT
      )
    `)

    // Migrate older DBs that pre-date the attribution columns. sql.js does not
    // support "ADD COLUMN IF NOT EXISTS", so we swallow the "duplicate column"
    // error each ALTER may throw on an already-migrated DB.
    for (const col of [
      "used_skills TEXT",
      "thread_id TEXT",
      "trace_id TEXT",
      "model_id TEXT",
      "model_name TEXT",
      "old_line_hashes BLOB",
      "harness_project_id TEXT",
      "harness_feature_slug TEXT",
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

    console.log("[AdoptionIndex] initialized at", dbPath)
  } catch (e) {
    console.warn("[AdoptionIndex] init failed (tracker will degrade gracefully):", e)
    db = null
  }
}

export function flushAdoptionIndex(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (db && dirty) {
    try {
      const data = db.export()
      writeFileSync(getAdoptionIndexPath(), Buffer.from(data))
      dirty = false
    } catch (e) {
      console.warn("[AdoptionIndex] flush failed:", e)
    }
  }
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
       (event_id, file_path, content_fingerprint, shard_file, shard_offset, line_hashes, old_line_hashes, created_at, measured,
        used_skills, thread_id, trace_id, model_id, model_name,
        harness_project_id, harness_feature_slug, harness_adapter_name, harness_adapter_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.event_id,
        row.file_path,
        row.content_fingerprint,
        row.shard_file,
        row.shard_offset,
        row.line_hashes ?? null,
        row.old_line_hashes ?? null,
        row.created_at,
        row.measured,
        row.used_skills,
        row.thread_id,
        row.trace_id,
        row.model_id,
        row.model_name,
        row.harness_project_id,
        row.harness_feature_slug,
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
            used_skills, thread_id, trace_id, model_id, model_name,
            harness_project_id, harness_feature_slug, harness_adapter_name, harness_adapter_version
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

export function markMeasured(eventId: string): void {
  if (!db) return
  try {
    db.run(`UPDATE gen_events SET measured = 1 WHERE event_id = ?`, [eventId])
    scheduleSave()
  } catch (e) {
    console.warn("[AdoptionIndex] markMeasured failed:", e)
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
 * we can evict them far more aggressively than the full 7-day window.
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
