import { appendFile, readdir, stat, unlink } from "fs/promises"
import { existsSync } from "fs"
import { join, basename } from "path"
import { getHookLogFilePath, getHookLoggingConfig, resolveHookLogDir } from "../storage"
import { redactLogValue } from "../log-redaction"
import { getHookDateKey, parseHookTimestamp } from "../../shared/hook-time"

/**
 * Hook execution log persistence — jsonl, one file per Beijing calendar day.
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

interface PendingLogBatch {
  dateKey: string
  fileDate: Date
  lines: string[]
  bytes: number
  failedAttempts: number
}

interface FlushDateQueueResult {
  dateKey: string
  remaining: PendingLogBatch[]
  error?: unknown
  dropped?: PendingLogBatch
}

let pendingBatches = new Map<string, PendingLogBatch[]>()
let pendingBytes = 0
let flushTimer: NodeJS.Timeout | null = null
let flushPromise: Promise<void> | null = null
let terminalFlushError: unknown

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow().catch((e) => console.warn("[Hooks] log flush failed:", e))
  }, FLUSH_INTERVAL_MS)
}

async function flushDateQueue(batches: PendingLogBatch[]): Promise<FlushDateQueueResult> {
  const dateKey = batches[0].dateKey
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    try {
      await appendFile(getHookLogFilePath(batch.fileDate), batch.lines.join(""), {
        encoding: "utf-8",
        mode: 0o600
      })
    } catch (error) {
      const canRetry = batch.failedAttempts < MAX_WRITE_RETRIES
      const remaining = [
        ...(canRetry ? [{ ...batch, failedAttempts: batch.failedAttempts + 1 }] : []),
        ...batches.slice(index + 1)
      ]
      return {
        dateKey,
        remaining,
        error,
        ...(canRetry ? {} : { dropped: batch })
      }
    }
  }
  return { dateKey, remaining: [] }
}

function prependPendingBatches(dateKey: string, batches: PendingLogBatch[]): void {
  if (batches.length === 0) return
  const current = pendingBatches.get(dateKey) ?? []
  pendingBatches.set(dateKey, [...batches, ...current])
  pendingBytes += batches.reduce((sum, batch) => sum + batch.bytes, 0)
}

async function flushNow(): Promise<void> {
  if (flushPromise) return flushPromise
  if (pendingBatches.size === 0) return

  flushPromise = (async () => {
    // Snapshot and clear before the await so new writes during flush don't get
    // dropped if appendFile throws — they end up in the next batch.
    const dateQueues = [...pendingBatches.values()]
    pendingBatches = new Map()
    pendingBytes = 0

    try {
      const results = await Promise.all(dateQueues.map((batches) => flushDateQueue(batches)))
      let firstError: unknown
      for (const result of results) {
        prependPendingBatches(result.dateKey, result.remaining)
        if (result.error !== undefined && firstError === undefined) firstError = result.error
        if (result.dropped) {
          terminalFlushError ??= result.error
          console.warn(
            `[Hooks] dropping ${result.dropped.lines.length} log lines for ${result.dateKey} ` +
              `after ${MAX_WRITE_RETRIES} failed retries:`,
            result.error
          )
        }
      }

      if (firstError === undefined) return
      if (pendingBatches.size > 0) scheduleFlush()
      throw firstError
    } finally {
      flushPromise = null
      if (pendingBatches.size > 0 && !flushTimer) {
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

function resolveRecordDate(record: unknown): Date {
  if (record && typeof record === "object") {
    const timestamp = (record as { timestamp?: unknown }).timestamp
    if (
      timestamp instanceof Date ||
      typeof timestamp === "string" ||
      typeof timestamp === "number"
    ) {
      const parsed = parseHookTimestamp(timestamp)
      if (parsed) return parsed
    }
  }
  return new Date()
}

function enqueueLine(line: string, fileDate: Date): void {
  const dateKey = getHookDateKey(fileDate)
  const dateQueue = pendingBatches.get(dateKey) ?? []
  const current = dateQueue.at(-1)
  if (current?.failedAttempts === 0) {
    current.lines.push(line)
    current.bytes += line.length
  } else {
    dateQueue.push({
      dateKey,
      fileDate,
      lines: [line],
      bytes: line.length,
      failedAttempts: 0
    })
    pendingBatches.set(dateKey, dateQueue)
  }
  pendingBytes += line.length
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
  enqueueLine(line, resolveRecordDate(record))
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
      if (pendingBatches.size === 0) {
        if (terminalFlushError !== undefined) {
          const error = terminalFlushError
          terminalFlushError = undefined
          throw error
        }
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
      if (!flushPromise && pendingBatches.size === 0) {
        const error = terminalFlushError ?? e
        terminalFlushError = undefined
        throw error
      }
    }
  }
}

interface LogFileEntry {
  name: string
  fullPath: string
  dateKey: string
  dateOrdinal: number
  size: number
}

function parseLogFileName(name: string): { dateKey: string; dateOrdinal: number } | null {
  if (!name.startsWith(LOG_FILE_PREFIX) || !name.endsWith(LOG_FILE_SUFFIX)) return null
  const dateKey = name.slice(LOG_FILE_PREFIX.length, name.length - LOG_FILE_SUFFIX.length)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null
  const date = new Date(`${dateKey}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey) return null
  return { dateKey, dateOrdinal: date.getTime() }
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
    const parsedDate = parseLogFileName(name)
    if (!parsedDate) continue
    const fullPath = join(dir, basename(name))
    let size = 0
    try {
      const st = await stat(fullPath)
      size = st.size
    } catch {
      // Could not stat — skip rather than risk deleting something we can't see.
      continue
    }
    entries.push({ name, fullPath, ...parsedDate, size })
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

  const todayKey = getHookDateKey()
  const todayOrdinal = Date.parse(`${todayKey}T00:00:00.000Z`)
  const cutoffOrdinal = todayOrdinal - RETENTION_DAYS * 24 * 60 * 60 * 1_000

  const survivors: LogFileEntry[] = []
  for (const entry of entries) {
    if (entry.dateOrdinal < cutoffOrdinal) {
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
  survivors.sort((a, b) => a.dateOrdinal - b.dateOrdinal)
  let totalBytes = survivors.reduce((sum, e) => sum + e.size, 0)
  for (const entry of survivors) {
    if (totalBytes <= MAX_TOTAL_LOG_BYTES) break
    // Never evict today's actively-growing file — would orphan in-memory
    // buffer's intended target and lose this session's debugging data.
    if (entry.dateKey === todayKey) continue
    try {
      await unlink(entry.fullPath)
      totalBytes -= entry.size
    } catch (e) {
      console.warn(`[Hooks] failed to evict log ${entry.name} for size cap:`, e)
    }
  }
}
