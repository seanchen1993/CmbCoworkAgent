import { appendFile, rename } from "fs/promises"
import { appendFileSync, existsSync, statSync } from "fs"
import { app } from "electron"
import { getMainLogPath, getRendererLogPath } from "./storage"

const MAX_LOG_BYTES = 5 * 1024 * 1024

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
  flushing: boolean
}

const fileStates = new Map<string, LogFileState>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function getFileState(filePath: string): LogFileState {
  let state = fileStates.get(filePath)
  if (!state) {
    state = { buffer: [], knownSize: 0, sizeSeeded: false, flushing: false }
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
}

async function flushFile(filePath: string, state: LogFileState): Promise<void> {
  if (state.flushing || state.buffer.length === 0) return
  state.flushing = true
  try {
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

    await appendFile(filePath, chunk, "utf-8")
    state.knownSize += Buffer.byteLength(chunk)
  } catch {
    // Never let file logging crash the app; drop the chunk on persistent failure.
  } finally {
    state.flushing = false
    // More arrived while we were writing — keep draining.
    if (state.buffer.length > 0) scheduleFlush()
  }
}

async function flushAll(): Promise<void> {
  await Promise.all(
    Array.from(fileStates.entries()).map(([filePath, state]) => flushFile(filePath, state))
  )
}

/**
 * Synchronously drain all buffered log lines. Registered on process exit so a
 * quit or crash doesn't lose the tail of the buffer (exit handlers must be sync).
 */
export function flushLogsSync(): void {
  for (const [filePath, state] of fileStates) {
    if (state.buffer.length === 0) continue
    try {
      appendFileSync(filePath, state.buffer.join(""), "utf-8")
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
  state.buffer.push(`[${timestamp}] [${level}] ${message}\n`)
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

export function writeMainLog(level: string, args: unknown[]): void {
  if (!isLevelEnabled(level)) return
  enqueueLine(getMainLogPath(), level, joinArgs(args))
}

export function writeRendererLog(
  level: string,
  message: string,
  meta?: { sourceId?: string; line?: number }
): void {
  if (!isLevelEnabled(level)) return
  const suffix = meta?.sourceId || typeof meta?.line === "number"
    ? ` (${meta?.sourceId || "unknown"}:${meta?.line ?? 0})`
    : ""
  enqueueLine(getRendererLogPath(), level, `${message}${suffix}`)
}
