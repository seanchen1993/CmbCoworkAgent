import { appendFile, rename } from "fs/promises"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync
} from "fs"
import { app } from "electron"
import { join } from "path"
import { getLogsDir, getMainLogPath, getRendererLogPath, resolveHookLogDir } from "./storage"
import { redactLogValues, redactSensitiveText } from "./log-redaction"

const MAX_LOG_BYTES = 5 * 1024 * 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const REDACTION_MIGRATION_MARKER = ".redaction-v1"

export interface LogRedactionInitializationResult {
  alreadyComplete: boolean
  scannedFiles: number
  redactedFiles: number
  failedFiles: number
}

function getHistoricalLogPaths(): { paths: string[]; discoveryFailures: number } {
  const mainPath = getMainLogPath()
  const rendererPath = getRendererLogPath()
  const paths = [mainPath, `${mainPath}.1`, rendererPath, `${rendererPath}.1`]
  const hookDir = resolveHookLogDir()
  if (!existsSync(hookDir)) return { paths, discoveryFailures: 0 }

  try {
    for (const entry of readdirSync(hookDir, { withFileTypes: true })) {
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.startsWith("hooks.") &&
        entry.name.endsWith(".jsonl")
      ) {
        paths.push(join(hookDir, entry.name))
      }
    }
  } catch {
    return { paths, discoveryFailures: 1 }
  }
  return { paths, discoveryFailures: 0 }
}

function tightenLogPermissions(paths: readonly string[]): void {
  if (process.platform === "win32") return
  try {
    chmodSync(getLogsDir(), PRIVATE_DIRECTORY_MODE)
  } catch {
    // Best effort; content redaction remains the primary control.
  }
  const hookDir = resolveHookLogDir()
  if (existsSync(hookDir)) {
    try {
      chmodSync(hookDir, PRIVATE_DIRECTORY_MODE)
    } catch {
      // Best effort.
    }
  }
  for (const filePath of paths) {
    try {
      if (lstatSync(filePath).isFile()) chmodSync(filePath, PRIVATE_FILE_MODE)
    } catch {
      // Best effort.
    }
  }
}

/**
 * One-time in-place migration for logs created by versions that wrote raw
 * console values. New writes are always redacted at enqueue time.
 */
export function initializeLogRedaction(): LogRedactionInitializationResult {
  const { paths, discoveryFailures } = getHistoricalLogPaths()
  const markerPath = join(getLogsDir(), REDACTION_MIGRATION_MARKER)
  let migrationComplete = false
  try {
    migrationComplete =
      lstatSync(markerPath).isFile() && readFileSync(markerPath, "utf8") === "version=1\n"
  } catch {
    // No valid completion marker yet.
  }
  if (migrationComplete) {
    tightenLogPermissions([...paths, markerPath])
    return { alreadyComplete: true, scannedFiles: 0, redactedFiles: 0, failedFiles: 0 }
  }

  let scannedFiles = 0
  let redactedFiles = 0
  let failedFiles = discoveryFailures
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue
    try {
      // Never follow a user-created symlink while rewriting historical data.
      if (!lstatSync(filePath).isFile()) {
        failedFiles += 1
        continue
      }
      const fileStat = statSync(filePath)
      const raw = readFileSync(filePath, "utf8")
      const redacted = redactSensitiveText(raw)
      scannedFiles += 1
      if (redacted !== raw) {
        writeFileSync(filePath, redacted, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
        utimesSync(filePath, fileStat.atime, fileStat.mtime)
        redactedFiles += 1
      }
      if (process.platform !== "win32") chmodSync(filePath, PRIVATE_FILE_MODE)
    } catch {
      failedFiles += 1
    }
  }

  tightenLogPermissions(paths)
  if (failedFiles === 0) {
    try {
      writeFileSync(markerPath, "version=1\n", {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE
      })
    } catch {
      failedFiles += 1
    }
  }
  if (redactedFiles > 0) resetKnownLogSizes()
  return { alreadyComplete: false, scannedFiles, redactedFiles, failedFiles }
}

// ─────────────────────────────────────────────────────────
// Level filtering
//
// Every console.* call in the main process is proxied into writeMainLog, so the
// cheapest win is to filter low-value lines before they ever reach the queue.
//
// In packaged builds DEBUG is *sampled* (keep 1-in-N) rather than dropped: that
// caps the volume of high-frequency bursts (file watchers, etc.) while still
// leaving a trail for troubleshooting. INFO/WARN/ERROR are always kept.
//
// Setting CMB_LOG_LEVEL pins an explicit floor and disables sampling, so it
// behaves strictly (e.g. CMB_LOG_LEVEL=DEBUG keeps everything, =WARN drops DEBUG
// entirely). Dev builds keep everything by default.
// ─────────────────────────────────────────────────────────
const LEVEL_ORDER: Record<string, number> = {
  DEBUG: 10,
  LOG: 20,
  INFO: 20,
  WARN: 30,
  ERROR: 40
}

// Keep 1 of every N debug lines while sampling.
const DEBUG_SAMPLE_RATE = 20

interface LevelPolicy {
  /** Hard floor: lines at or above this weight are always written. */
  minLevel: number
  /** When true, DEBUG (below the floor) is sampled rather than dropped. */
  sampleDebug: boolean
}

function resolveLevelPolicy(): LevelPolicy {
  const env = (process.env.CMB_LOG_LEVEL || "").toUpperCase()
  if (env && env in LEVEL_ORDER) {
    // Explicit override → strict, no sampling.
    return { minLevel: LEVEL_ORDER[env], sampleDebug: false }
  }
  let packaged = false
  try {
    packaged = app.isPackaged
  } catch {
    // app not ready / unavailable — fall through to dev default.
  }
  return packaged
    ? { minLevel: LEVEL_ORDER.INFO, sampleDebug: true }
    : { minLevel: LEVEL_ORDER.DEBUG, sampleDebug: false }
}

const LEVEL_POLICY = resolveLevelPolicy()
let debugSampleCounter = 0

function isLevelEnabled(level: string): boolean {
  const weight = LEVEL_ORDER[level.toUpperCase()] ?? LEVEL_ORDER.INFO
  if (weight >= LEVEL_POLICY.minLevel) return true
  // Below the floor: only DEBUG gets a sampled trickle (when enabled).
  if (LEVEL_POLICY.sampleDebug && weight === LEVEL_ORDER.DEBUG) {
    debugSampleCounter = (debugSampleCounter + 1) % DEBUG_SAMPLE_RATE
    return debugSampleCounter === 0
  }
  return false
}

// ─────────────────────────────────────────────────────────
// Async batched writer
//
// Lines are buffered in memory and flushed on a short timer with async
// appendFile, so logging never blocks the main thread during bursty work
// (builds, dependency installs, branch switches). Rotation uses an in-memory
// byte counter seeded once with a single statSync, avoiding a statSync per line.
// ─────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 250
const MAX_BUFFER_LINES = 5000

interface LogFileState {
  buffer: string[]
  knownSize: number
  sizeSeeded: boolean
  flushPromise: Promise<void> | null
}

const fileStates = new Map<string, LogFileState>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function resetKnownLogSizes(): void {
  for (const state of fileStates.values()) {
    state.knownSize = 0
    state.sizeSeeded = false
  }
}

function getFileState(filePath: string): LogFileState {
  let state = fileStates.get(filePath)
  if (!state) {
    state = { buffer: [], knownSize: 0, sizeSeeded: false, flushPromise: null }
    fileStates.set(filePath, state)
  }
  return state
}

function seedSizeOnce(filePath: string, state: LogFileState): void {
  if (state.sizeSeeded) return
  state.sizeSeeded = true
  try {
    state.knownSize = existsSync(filePath) ? statSync(filePath).size : 0
  } catch {
    state.knownSize = 0
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushAll()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

async function flushFile(filePath: string, state: LogFileState): Promise<void> {
  if (state.flushPromise) return state.flushPromise
  if (state.buffer.length === 0) return

  state.flushPromise = (async () => {
    while (state.buffer.length > 0) {
      seedSizeOnce(filePath, state)
      const chunk = state.buffer.join("")
      state.buffer.length = 0

      // Rotate before appending if this chunk would push us past the cap.
      if (state.knownSize + Buffer.byteLength(chunk) >= MAX_LOG_BYTES) {
        try {
          await rename(filePath, `${filePath}.1`)
          state.knownSize = 0
        } catch {
          // Best effort rotation; if rename fails, keep appending to current file.
        }
      }

      try {
        await appendFile(filePath, chunk, {
          encoding: "utf-8",
          mode: PRIVATE_FILE_MODE
        })
        state.knownSize += Buffer.byteLength(chunk)
      } catch {
        // Never let file logging crash the app; drop the chunk on persistent failure.
      }
    }
  })().finally(() => {
    state.flushPromise = null
    if (state.buffer.length > 0) scheduleFlush()
  })

  return state.flushPromise
}

async function flushAll(): Promise<void> {
  await Promise.all(
    Array.from(fileStates.entries()).map(([filePath, state]) => flushFile(filePath, state))
  )
}

/** Drain buffered and already in-flight log writes during an orderly shutdown. */
export async function flushLogs(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  for (;;) {
    await flushAll()
    const pending = Array.from(fileStates.values()).some(
      (state) => state.buffer.length > 0 || state.flushPromise
    )
    if (!pending) return
  }
}

/**
 * Synchronously drain all buffered log lines. Registered on process exit so a
 * crash keeps the queued tail where possible. An already in-flight async write
 * cannot be synchronously joined; orderly shutdown uses flushLogs() instead.
 */
export function flushLogsSync(): void {
  for (const [filePath, state] of fileStates) {
    if (state.buffer.length === 0) continue
    try {
      appendFileSync(filePath, state.buffer.join(""), {
        encoding: "utf-8",
        mode: PRIVATE_FILE_MODE
      })
      state.buffer.length = 0
    } catch {
      // Best effort on shutdown.
    }
  }
}

let exitHandlerRegistered = false
function ensureExitHandler(): void {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true
  process.once("exit", flushLogsSync)
}

function enqueueLine(filePath: string, level: string, message: string): void {
  const state = getFileState(filePath)
  const timestamp = new Date().toISOString()
  state.buffer.push(`[${timestamp}] [${level}] ${redactSensitiveText(message)}\n`)
  // Bound memory if a flush can't keep up (e.g. disk stall): drop oldest lines.
  if (state.buffer.length > MAX_BUFFER_LINES) {
    state.buffer.splice(0, state.buffer.length - MAX_BUFFER_LINES)
  }
  ensureExitHandler()
  scheduleFlush()
}

function safeStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`
  }
  if (typeof value === "string") {
    return value
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`
  }
  if (typeof value === "symbol") {
    return value.toString()
  }
  if (typeof value !== "object") {
    return String(value)
  }

  try {
    return JSON.stringify(
      value,
      (_key, nestedValue) => {
        if (typeof nestedValue === "bigint") return `${nestedValue.toString()}n`
        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack
          }
        }
        if (typeof nestedValue === "function") {
          return `[Function ${nestedValue.name || "anonymous"}]`
        }
        if (typeof nestedValue === "symbol") {
          return nestedValue.toString()
        }
        if (nestedValue && typeof nestedValue === "object") {
          if (seen.has(nestedValue)) return "[Circular]"
          seen.add(nestedValue)
        }
        return nestedValue
      },
      2
    )
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function joinArgs(args: unknown[]): string {
  return args.map((arg) => safeStringify(arg)).join(" ")
}

/**
 * Write a main-process log entry and return the detached arguments that are
 * safe to reuse for stdout/stderr and renderer forwarding.
 */
export function writeMainLog(level: string, args: unknown[]): unknown[] {
  const redactedArgs = redactLogValues(args)
  if (isLevelEnabled(level)) {
    enqueueLine(getMainLogPath(), level, joinArgs(redactedArgs))
  }
  return redactedArgs
}

export function writeRendererLog(
  level: string,
  message: string,
  meta?: { sourceId?: string; line?: number }
): void {
  if (!isLevelEnabled(level)) return
  const suffix =
    meta?.sourceId || typeof meta?.line === "number"
      ? ` (${redactSensitiveText(meta?.sourceId || "unknown")}:${meta?.line ?? 0})`
      : ""
  enqueueLine(getRendererLogPath(), level, `${message}${suffix}`)
}
