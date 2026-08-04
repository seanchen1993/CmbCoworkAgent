import { appendFile, readdir, stat, unlink } from "fs/promises"
import { existsSync } from "fs"
import { join, basename } from "path"
import { getHookLogFilePath, getHookLoggingConfig, resolveHookLogDir } from "../storage"
import { redactLogValue } from "../log-redaction"

/**
 * Hook execution log persistence — jsonl, one file per local calendar day.
 *
 * Only writes when `HookLoggingConfig.diagnostic === true`. The hook runner
 * owns timing and stdin/payload assembly; this module is intentionally just
 * "append a line to today's file, prune old ones occasionally".
 *
 * Buffer + interval flush:
 *   - Lines go into an in-memory buffer first.
 *   - Flush triggers: every 5s OR when buffer reaches FLUSH_BYTES.
 *   - This keeps disk pressure low under a turn that fires many hooks.
 *
 * Retention:
 *   - Files older than RETENTION_DAYS are deleted at app startup.
 *   - Directory total is capped at MAX_TOTAL_LOG_BYTES (oldest files first).
 *     A heavy diagnostic session can easily push hundreds of MB through these
 *     files in a single day; the per-day file alone wouldn't be caught by the
 *     7-day rule. Both checks run once at startup — no perpetual cron.
 */

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BYTES = 16 * 1024
const RETENTION_DAYS = 7
// One redo / restart's worth of headroom for a heavy diagnostic session.
// Tuned conservatively so users opting into diagnostic mode don't lose their
// own debugging data, but disk usage stays bounded if they leave it on.
const MAX_TOTAL_LOG_BYTES = 200 * 1024 * 1024
// `MAX_WRITE_RETRIES = 3` means the flush is attempted up to (1 initial + 3
// retries) = 4 times before the batch is dropped. Surface as a name that
// matches the actual semantics.
const MAX_WRITE_RETRIES = 3
const LOG_FILE_PREFIX = "hooks."
const LOG_FILE_SUFFIX = ".jsonl"

let pendingLines: string[] = []
let pendingBytes = 0
let flushTimer: NodeJS.Timeout | null = null
let flushPromise: Promise<void> | null = null
let consecutiveFlushFailures = 0

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow().catch((e) => console.warn("[Hooks] log flush failed:", e))
  }, FLUSH_INTERVAL_MS)
}

async function flushNow(): Promise<void> {
  if (flushPromise) return flushPromise
  if (pendingLines.length === 0) return

  flushPromise = (async () => {
    // Snapshot and clear before the await so new writes during flush don't get
    // dropped if appendFile throws — they end up in the next batch.
    const batchLines = pendingLines
    const batchBytes = pendingBytes
    const batch = batchLines.join("")
    pendingLines = []
    pendingBytes = 0
    try {
      await appendFile(getHookLogFilePath(), batch, {
        encoding: "utf-8",
        mode: 0o600
      })
      consecutiveFlushFailures = 0
    } catch (e) {
      if (consecutiveFlushFailures < MAX_WRITE_RETRIES) {
        consecutiveFlushFailures += 1
        pendingLines = [...batchLines, ...pendingLines]
        pendingBytes += batchBytes
        scheduleFlush()
      } else {
        consecutiveFlushFailures = 0
        console.warn(
          `[Hooks] dropping ${batchLines.length} log lines after ${MAX_WRITE_RETRIES} failed retries:`,
          e
        )
      }
      throw e
    } finally {
      flushPromise = null
      if (pendingLines.length > 0 && !flushTimer) {
        if (pendingBytes >= FLUSH_BYTES) {
          void flushNow().catch((e) => console.warn("[Hooks] log flush failed:", e))
        } else {
          scheduleFlush()
        }
      }
    }
  })()

  return flushPromise
}

/**
 * Persist one execution record. No-op when diagnostic mode is off — callers
 * don't need to guard; we re-check here so the gate is in one place.
 */
export function persistHookExecutionRecord(record: unknown): void {
  const cfg = getHookLoggingConfig()
  if (!cfg.diagnostic) return
  let line: string
  try {
    line = JSON.stringify(redactLogValue(record)) + "\n"
  } catch (e) {
    // Most likely a circular reference somewhere in stdinPayload or stderr —
    // drop silently rather than crash the hook runner.
    console.warn("[Hooks] failed to serialize log record:", e)
    return
  }
  pendingLines.push(line)
  pendingBytes += line.length
  if (pendingBytes >= FLUSH_BYTES) {
    void flushNow().catch((e) => console.warn("[Hooks] log flush failed:", e))
  } else {
    scheduleFlush()
  }
}

/** Force flush — call on app quit so pending lines aren't lost. */
export async function flushHookLogs(): Promise<void> {
  let lastError: unknown
  while (true) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    try {
      if (flushPromise) {
        await flushPromise
        lastError = undefined
        continue
      }
      if (pendingLines.length === 0) {
        if (lastError) throw lastError
        return
      }
      await flushNow()
      lastError = undefined
    } catch (e) {
      lastError = e
      // `flushNow` requeues retryable batches before rejecting. On shutdown we
      // cannot rely on the retry timer, so immediately loop and drain whatever
      // remains. If retries are exhausted, the failed batch is dropped and the
      // queue becomes empty; surface that final error to the caller.
      if (!flushPromise && pendingLines.length === 0) throw e
    }
  }
}

interface LogFileEntry {
  name: string
  fullPath: string
  fileDate: Date
  size: number
}

function parseLogFileName(name: string): Date | null {
  if (!name.startsWith(LOG_FILE_PREFIX) || !name.endsWith(LOG_FILE_SUFFIX)) return null
  const dateStr = name.slice(LOG_FILE_PREFIX.length, name.length - LOG_FILE_SUFFIX.length)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

async function collectLogFileEntries(dir: string): Promise<LogFileEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const entries: LogFileEntry[] = []
  for (const name of names) {
    const fileDate = parseLogFileName(name)
    if (!fileDate) continue
    const fullPath = join(dir, basename(name))
    let size = 0
    try {
      const st = await stat(fullPath)
      size = st.size
    } catch {
      // Could not stat — skip rather than risk deleting something we can't see.
      continue
    }
    entries.push({ name, fullPath, fileDate, size })
  }
  return entries
}

/**
 * Delete jsonl files older than RETENTION_DAYS based on the date in the
 * filename (filename-based, not mtime, so touching/renaming doesn't extend
 * retention). Then enforce the total-size cap by deleting oldest-first until
 * the remaining set fits under MAX_TOTAL_LOG_BYTES. The current day's file is
 * never deleted by the size pass — losing today's actively-growing log on
 * startup would defeat the purpose of diagnostic mode. Called once at app
 * startup.
 */
export async function pruneOldHookLogs(): Promise<void> {
  // Path-only lookup: don't create the directory just to discover it's empty.
  // Users who never enable Hook logging should see zero disk footprint here.
  const dir = resolveHookLogDir()
  if (!existsSync(dir)) return

  const entries = await collectLogFileEntries(dir)
  if (entries.length === 0) return

  const today = new Date()
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

  const survivors: LogFileEntry[] = []
  for (const entry of entries) {
    if (entry.fileDate < cutoff) {
      try {
        await unlink(entry.fullPath)
      } catch (e) {
        console.warn(`[Hooks] failed to delete old log ${entry.name}:`, e)
        // Treat un-deletable as still-present so the size accounting is honest.
        survivors.push(entry)
      }
      continue
    }
    survivors.push(entry)
  }

  // Oldest first for size-cap eviction. Stable on equal dates by filename,
  // which doesn't matter in practice since names embed the same date.
  survivors.sort((a, b) => a.fileDate.getTime() - b.fileDate.getTime())
  let totalBytes = survivors.reduce((sum, e) => sum + e.size, 0)
  for (const entry of survivors) {
    if (totalBytes <= MAX_TOTAL_LOG_BYTES) break
    // Never evict today's actively-growing file — would orphan in-memory
    // buffer's intended target and lose this session's debugging data.
    const entryKey = `${entry.fileDate.getFullYear()}-${String(entry.fileDate.getMonth() + 1).padStart(2, "0")}-${String(entry.fileDate.getDate()).padStart(2, "0")}`
    if (entryKey === todayKey) continue
    try {
      await unlink(entry.fullPath)
      totalBytes -= entry.size
    } catch (e) {
      console.warn(`[Hooks] failed to evict log ${entry.name} for size cap:`, e)
    }
  }
}
