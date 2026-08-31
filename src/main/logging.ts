import {
  appendFile,
  chmod,
  lstat,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile
} from "fs/promises"
import { appendFileSync } from "fs"
import { app } from "electron"
import { join } from "path"
import { getLogsDir, getMainLogPath, getRendererLogPath, resolveHookLogDir } from "./storage"
import { redactLogValues, redactSensitiveText } from "./log-redaction"

const MAX_LOG_BYTES = 5 * 1024 * 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const REDACTION_MIGRATION_MARKER = ".redaction-v1"
const LOG_MIGRATION_MAX_FILES = 4_096
const LOG_MIGRATION_MAX_FILE_BYTES = 8 * 1024 * 1024
const LOG_MIGRATION_MAX_TOTAL_BYTES = 64 * 1024 * 1024
const LOG_MIGRATION_YIELD_INTERVAL = 128
const LOG_MIGRATION_MAX_LINE_CHARS = 64 * 1024

export interface LogRedactionInitializationResult {
  alreadyComplete: boolean
  scannedFiles: number
  redactedFiles: number
  failedFiles: number
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function redactHistoricalLog(raw: string): Promise<string> {
  const output: string[] = []
  let cursor = 0
  let processedChars = 0
  while (cursor < raw.length) {
    const newline = raw.indexOf("\n", cursor)
    const end = newline < 0 ? raw.length : newline + 1
    const line = raw.slice(cursor, end)
    output.push(
      line.length > LOG_MIGRATION_MAX_LINE_CHARS
        ? `[historical log line omitted: ${line.length} chars]\n`
        : redactSensitiveText(line)
    )
    processedChars += line.length
    cursor = end
    if (processedChars >= 512 * 1024) {
      processedChars = 0
      await yieldToEventLoop()
    }
  }
  return output.join("")
}

async function getHistoricalLogPaths(): Promise<{ paths: string[]; discoveryFailures: number }> {
  const mainPath = getMainLogPath()
  const rendererPath = getRendererLogPath()
  const paths = [mainPath, `${mainPath}.1`, rendererPath, `${rendererPath}.1`]
  const hookDir = resolveHookLogDir()
  let directory
  try {
    directory = await opendir(hookDir)
    let scannedEntries = 0
    for await (const entry of directory) {
      scannedEntries += 1
      if (scannedEntries > LOG_MIGRATION_MAX_FILES) {
        return { paths, discoveryFailures: 1 }
      }
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.startsWith("hooks.") &&
        entry.name.endsWith(".jsonl")
      ) {
        paths.push(join(hookDir, entry.name))
      }
      if (scannedEntries % LOG_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { paths, discoveryFailures: 0 }
    }
    return { paths, discoveryFailures: 1 }
  }
  return { paths, discoveryFailures: 0 }
}

async function tightenLogPermissions(paths: readonly string[]): Promise<void> {
  if (process.platform === "win32") return
  try {
    await chmod(getLogsDir(), PRIVATE_DIRECTORY_MODE)
  } catch {
    // Best effort; content redaction remains the primary control.
  }
  const hookDir = resolveHookLogDir()
  try {
    await chmod(hookDir, PRIVATE_DIRECTORY_MODE)
  } catch {
    // Best effort.
  }
  for (const filePath of paths) {
    try {
      if ((await lstat(filePath)).isFile()) await chmod(filePath, PRIVATE_FILE_MODE)
    } catch {
      // Best effort.
    }
  }
}

/**
 * One-time in-place migration for logs created by versions that wrote raw
 * console values. New writes are always redacted at enqueue time.
 */
export async function initializeLogRedaction(): Promise<LogRedactionInitializationResult> {
  const { paths, discoveryFailures } = await getHistoricalLogPaths()
  const markerPath = join(getLogsDir(), REDACTION_MIGRATION_MARKER)
  let migrationComplete = false
  try {
    migrationComplete =
      (await lstat(markerPath)).isFile() && (await readFile(markerPath, "utf8")) === "version=1\n"
  } catch {
    // No valid completion marker yet.
  }
  if (migrationComplete) {
    await tightenLogPermissions([...paths, markerPath])
    return { alreadyComplete: true, scannedFiles: 0, redactedFiles: 0, failedFiles: 0 }
  }

  let scannedFiles = 0
  let redactedFiles = 0
  let failedFiles = discoveryFailures
  let totalBytes = 0
  for (const filePath of paths) {
    try {
      // Never follow a user-created symlink while rewriting historical data.
      if (!(await lstat(filePath)).isFile()) {
        failedFiles += 1
        continue
      }
      const fileStat = await stat(filePath)
      if (
        fileStat.size > LOG_MIGRATION_MAX_FILE_BYTES ||
        totalBytes + fileStat.size > LOG_MIGRATION_MAX_TOTAL_BYTES
      ) {
        failedFiles += 1
        continue
      }
      totalBytes += fileStat.size
      await withLogFileMaintenance(filePath, async () => {
        const raw = await readFile(filePath, "utf8")
        const redacted = await redactHistoricalLog(raw)
        scannedFiles += 1
        if (redacted !== raw) {
          const tempPath = `${filePath}.redaction-${process.pid}-${Date.now()}`
          try {
            await writeFile(tempPath, redacted, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
            await rename(tempPath, filePath)
            await utimes(filePath, fileStat.atime, fileStat.mtime)
            redactedFiles += 1
          } finally {
            await unlink(tempPath).catch(() => undefined)
          }
        }
        if (process.platform !== "win32") await chmod(filePath, PRIVATE_FILE_MODE)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      failedFiles += 1
    }
    if (scannedFiles % LOG_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
  }

  await tightenLogPermissions(paths)
  if (failedFiles === 0) {
    try {
      await writeFile(markerPath, "version=1\n", {
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
  sizeSeedPromise: Promise<void> | null
  flushPromise: Promise<void> | null
  maintenancePromise: Promise<void> | null
  bufferBytes: number
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
    state = {
      buffer: [],
      knownSize: 0,
      sizeSeeded: false,
      sizeSeedPromise: null,
      flushPromise: null,
      maintenancePromise: null,
      bufferBytes: 0
    }
    fileStates.set(filePath, state)
  }
  return state
}

async function seedSizeOnce(filePath: string, state: LogFileState): Promise<void> {
  if (state.sizeSeeded) return state.sizeSeedPromise ?? Promise.resolve()
  state.sizeSeeded = true
  state.sizeSeedPromise = stat(filePath)
    .then((value) => {
      state.knownSize = value.size
    })
    .catch(() => {
      state.knownSize = 0
    })
    .finally(() => {
      state.sizeSeedPromise = null
    })
  return state.sizeSeedPromise
}

async function withLogFileMaintenance(filePath: string, operation: () => Promise<void>): Promise<void> {
  const state = getFileState(filePath)
  while (state.maintenancePromise || state.flushPromise) {
    await (state.maintenancePromise ?? state.flushPromise)
  }
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  state.maintenancePromise = gate
  try {
    await operation()
  } finally {
    release()
    if (state.maintenancePromise === gate) state.maintenancePromise = null
    if (state.buffer.length > 0) scheduleFlush()
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
    if (state.maintenancePromise) await state.maintenancePromise
    while (state.buffer.length > 0) {
      await seedSizeOnce(filePath, state)
      const chunk = state.buffer.join("")
      state.buffer.length = 0
      state.bufferBytes = 0

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
      state.bufferBytes = 0
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

function enqueueLine(
  filePath: string,
  level: string,
  message: string,
  alreadyRedacted = false
): void {
  const state = getFileState(filePath)
  const timestamp = new Date().toISOString()
  const boundedMessage = message.slice(0, LOG_LINE_MAX_CHARS)
  const line = `[${timestamp}] [${level}] ${
    alreadyRedacted ? boundedMessage : redactSensitiveText(boundedMessage)
  }\n`
  state.buffer.push(line)
  state.bufferBytes += Buffer.byteLength(line)
  // Bound memory if a flush can't keep up (e.g. disk stall): drop oldest lines.
  if (state.buffer.length > MAX_BUFFER_LINES) {
    const removed = state.buffer.splice(0, state.buffer.length - MAX_BUFFER_LINES)
    for (const item of removed) state.bufferBytes -= Buffer.byteLength(item)
  }
  const maxBufferBytes = 1024 * 1024
  while (state.bufferBytes > maxBufferBytes && state.buffer.length > 1) {
    state.bufferBytes -= Buffer.byteLength(state.buffer.shift() ?? "")
  }
  ensureExitHandler()
  scheduleFlush()
}

const LOG_VALUE_MAX_DEPTH = 5
const LOG_VALUE_MAX_ENTRIES = 64
const LOG_VALUE_MAX_STRING_CHARS = 2 * 1024
const LOG_ARGUMENT_MAX_CHARS = 8 * 1024
const LOG_LINE_MAX_CHARS = 16 * 1024
const LOG_ARGUMENT_MAX_COUNT = 32

function boundedString(value: string, limit = LOG_VALUE_MAX_STRING_CHARS): string {
  // Bound the raw input before any replacement. Replacing first would scan and
  // duplicate an arbitrarily large Error/message on Electron's main isolate,
  // even though only a tiny prefix can ever reach the log.
  const rawPrefix = value.length > limit ? value.slice(0, limit) : value
  const singleLine = rawPrefix.replace(/\r/g, "\\r").replace(/\n/g, "\\n")
  if (value.length <= limit && singleLine.length <= limit) return singleLine
  const truncatedChars =
    value.length > rawPrefix.length
      ? value.length - rawPrefix.length
      : Math.max(0, singleLine.length - limit)
  return `${singleLine.slice(0, limit)}…[truncated ${truncatedChars} chars]`
}

export function getLogQueueDiagnosticsForTest(): {
  bufferedLines: number
  bufferedBytes: number
  maxBufferedLinesPerFile: number
  maxBufferedBytesPerFile: number
} {
  let bufferedLines = 0
  let bufferedBytes = 0
  for (const state of fileStates.values()) {
    bufferedLines += state.buffer.length
    bufferedBytes += state.bufferBytes
  }
  return {
    bufferedLines,
    bufferedBytes,
    maxBufferedLinesPerFile: MAX_BUFFER_LINES,
    maxBufferedBytesPerFile: 1024 * 1024
  }
}

function projectLogValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (typeof value === "string") return boundedString(value)
  if (typeof value === "bigint") return `${value.toString()}n`
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "function") return `[Function ${boundedString(value.name || "anonymous")}]`
  if (typeof value === "symbol") return boundedString(value.toString())
  if (typeof value !== "object") return boundedString(String(value))
  if (seen.has(value)) return "[Circular]"
  if (depth >= LOG_VALUE_MAX_DEPTH) return `[${value.constructor?.name || "Object"} depth-limit]`
  seen.add(value)

  if (value instanceof Error) {
    return {
      name: boundedString(value.name),
      message: boundedString(value.message),
      stack: boundedString(value.stack || "")
    }
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp || value instanceof URL) return boundedString(value.toString())
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (Array.isArray(value)) {
    const count = Math.min(value.length, LOG_VALUE_MAX_ENTRIES)
    const output = new Array<unknown>(count)
    for (let index = 0; index < count; index += 1) {
      output[index] = projectLogValue(value[index], depth + 1, seen)
    }
    if (value.length > count) output.push(`[+${value.length - count} entries]`)
    return output
  }
  if (value instanceof Map) {
    const output: unknown[] = []
    let index = 0
    for (const [key, nested] of value) {
      if (index >= LOG_VALUE_MAX_ENTRIES) break
      output.push([
        projectLogValue(key, depth + 1, seen),
        projectLogValue(nested, depth + 1, seen)
      ])
      index += 1
    }
    if (value.size > index) output.push(`[+${value.size - index} entries]`)
    return { map: output }
  }
  if (value instanceof Set) {
    const output: unknown[] = []
    let index = 0
    for (const nested of value) {
      if (index >= LOG_VALUE_MAX_ENTRIES) break
      output.push(projectLogValue(nested, depth + 1, seen))
      index += 1
    }
    if (value.size > index) output.push(`[+${value.size - index} entries]`)
    return { set: output }
  }

  const output: Record<string, unknown> = {}
  let included = 0
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (included >= LOG_VALUE_MAX_ENTRIES) {
        output["…"] = `[entry-limit ${LOG_VALUE_MAX_ENTRIES}]`
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      output[boundedString(key, 256)] =
        descriptor && "value" in descriptor
          ? projectLogValue(descriptor.value, depth + 1, seen)
          : "[Getter]"
      included += 1
    }
  } catch {
    return "[Unserializable Object]"
  }
  return output
}

function projectLogValueSafely(value: unknown): unknown {
  try {
    return projectLogValue(value, 0, new WeakSet<object>())
  } catch {
    return "[Unserializable Object]"
  }
}

function safeStringify(value: unknown): string {
  const projected = projectLogValueSafely(value)
  let serialized: string
  try {
    if (typeof projected === "string") {
      serialized = projected
    } else {
      // JSON.stringify intentionally returns undefined for top-level undefined.
      // console.log accepts that value, so the file logger must preserve it as
      // text instead of letting its own length bound crash the business call.
      serialized = JSON.stringify(projected) ?? String(projected)
    }
  } catch {
    serialized = "[Unserializable Object]"
  }
  return serialized.length <= LOG_ARGUMENT_MAX_CHARS
    ? serialized
    : `${serialized.slice(0, LOG_ARGUMENT_MAX_CHARS)}…[argument-truncated]`
}

function joinArgs(args: unknown[]): string {
  let output = ""
  const count = Math.min(args.length, LOG_ARGUMENT_MAX_COUNT)
  for (let index = 0; index < count; index += 1) {
    const separator = output ? " " : ""
    const remaining = LOG_LINE_MAX_CHARS - output.length - separator.length
    if (remaining <= 0) break
    output += `${separator}${safeStringify(args[index]).slice(0, remaining)}`
  }
  if (args.length > count && output.length < LOG_LINE_MAX_CHARS) {
    output += ` [+${args.length - count} args]`
  }
  return output.slice(0, LOG_LINE_MAX_CHARS)
}

/**
 * Write a main-process log entry and return the detached arguments that are
 * safe to reuse for stdout/stderr and renderer forwarding.
 */
export function writeMainLog(level: string, args: unknown[]): unknown[] {
  const boundedArgs = args
    .slice(0, LOG_ARGUMENT_MAX_COUNT)
    .map((value) => projectLogValueSafely(value))
  if (args.length > boundedArgs.length) boundedArgs.push(`[+${args.length - boundedArgs.length} args]`)
  const redactedArgs = redactLogValues(boundedArgs)
  if (isLevelEnabled(level)) {
    enqueueLine(getMainLogPath(), level, joinArgs(redactedArgs), true)
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
      ? ` (${redactSensitiveText((meta?.sourceId || "unknown").slice(0, 512))}:${meta?.line ?? 0})`
      : ""
  enqueueLine(getRendererLogPath(), level, `${message.slice(0, LOG_LINE_MAX_CHARS)}${suffix}`)
}
