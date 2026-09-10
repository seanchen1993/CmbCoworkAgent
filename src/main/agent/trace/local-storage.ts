import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "fs"
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile
} from "fs/promises"
import { basename, dirname, join } from "path"
import { pipeline } from "stream/promises"

export type TraceStorageMode = "encrypted" | "off" | "plaintext"

export interface TraceKeyProtector {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

interface EncryptedTraceEnvelope {
  format: "cmbcowork.trace"
  version: 1
  algorithm: "aes-256-gcm"
  iv: string
  authTag: string
  ciphertext: string
}

interface WrappedTraceKey {
  format: "cmbcowork.trace-key"
  version: 1
  protection: "electron.safeStorage"
  wrappedKey: string
}

interface TraceFileFingerprint {
  mtimeMs: number
  size: number
}

interface TraceMigrationSnapshot {
  directories: Record<string, number>
  rootFiles: Record<string, TraceFileFingerprint>
}

interface TraceMigrationMarker {
  format: "cmbcowork.trace-migration"
  version: 1
  completedAt: string
  snapshot: TraceMigrationSnapshot
}

interface TraceMigrationProgress {
  format: "cmbcowork.trace-migration-progress"
  version: 2
  startedAt: string
  verifiedFiles: Record<string, TraceFileFingerprint>
  oversizedProbeOffsets: Record<string, TraceOversizedProbeProgress>
}

interface TraceOversizedProbeProgress extends TraceFileFingerprint {
  offset: number
}

interface TraceMigrationCandidate {
  filePath: string
  relativePath: string
}

interface TraceFileProtectionResult {
  changed: boolean | null
  bytesRead: number
  nextProbeOffset?: number
}

interface OversizedTraceProbeResult {
  classification: "encrypted" | "plaintext-or-corrupt" | "unknown"
  bytesRead: number
  nextOffset?: number
}

interface TraceInventoryDirectory {
  mtimeMs: number
  traceFiles: string[]
}

interface TraceStorageInventory {
  snapshot: TraceMigrationSnapshot
  directories: Map<string, TraceInventoryDirectory>
  rootTraceFiles: Map<string, { filePath: string; fingerprint: TraceFileFingerprint }>
  failedPaths: number
}

export interface TraceStorageInitializationResult {
  mode: TraceStorageMode
  ready: boolean
  migratedFiles: number
  protectedFiles: number
  failedFiles: number
  migrationSkipped: boolean
  reason?: string
}

export interface TraceLocalStorageOptions {
  mode?: TraceStorageMode
  protector?: TraceKeyProtector
  platform?: NodeJS.Platform
  /** Internal work budget override used by deterministic migration regression tests. */
  migrationMaxTotalBytes?: number
}

const TRACE_STORAGE_MODE_ENV = "CMB_COWORK_TRACE_STORAGE_MODE"
const KEY_FILE_NAME = ".trace-key-v1.json"
const MIGRATION_MARKER_FILE_NAME = ".trace-migration-v1.complete"
const MIGRATION_IN_PROGRESS_FILE_NAME = ".trace-migration-v1.in-progress"
const TRACE_AAD = Buffer.from("cmbcowork.trace/v1", "utf8")
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
// Keep startup inventory bounded, with enough headroom for long-lived installations.
// The previous 2,048-directory / 4,096-file limits were below observed production
// stores (2,824 directories and 5,060 encrypted traces), so a safe store was reported
// as incomplete and scanned again on every launch.
export const TRACE_INVENTORY_MAX_ENTRIES = 32_768
export const TRACE_INVENTORY_MAX_DIRECTORIES = 8_192
export const TRACE_INVENTORY_MAX_FILES = 16_384
const TRACE_MIGRATION_MAX_FILE_BYTES = 8 * 1024 * 1024
const TRACE_MIGRATION_MAX_TOTAL_BYTES = 64 * 1024 * 1024
const TRACE_MIGRATION_MAX_LINE_CHARS = 1536 * 1024
// A line encrypted from the largest accepted legacy payload grows because its
// ciphertext is base64 encoded. Keep that known envelope parseable on a later
// streaming verification pass without allowing arbitrary lines to grow unbounded.
const TRACE_MIGRATION_MAX_ENVELOPE_CHARS = 8 * 1024 * 1024
// Read only enough to classify the first complete non-empty record. Two extra
// bytes allow the largest accepted envelope to be followed by CRLF.
const TRACE_OVERSIZED_PROBE_MAX_BYTES = TRACE_MIGRATION_MAX_ENVELOPE_CHARS + 2
const TRACE_OVERSIZED_PROBE_CHUNK_BYTES = 64 * 1024
const TRACE_ENVELOPE_PROPERTY_NAMES = new Set([
  "format",
  "version",
  "algorithm",
  "iv",
  "authTag",
  "ciphertext"
])
const TRACE_MIGRATION_YIELD_INTERVAL = 128
// Rewriting the growing progress document too often becomes quadratic on stores
// with thousands of traces. A 256-file checkpoint keeps crash replay below the
// per-launch byte budget without turning migration metadata into the dominant IO.
const TRACE_MIGRATION_PROGRESS_FLUSH_INTERVAL = 256
const TRACE_STORAGE_CACHE_MAX_ENTRIES = 32
const TRACE_APPEND_MAX_PLAINTEXT_BYTES = 1024 * 1024

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

export function resolveTraceStorageMode(
  value = process.env[TRACE_STORAGE_MODE_ENV]
): TraceStorageMode {
  switch (value?.trim().toLowerCase()) {
    case "off":
    case "disabled":
      return "off"
    case "plaintext":
    case "plain":
      return "plaintext"
    case "encrypted":
    case undefined:
    case "":
      return "encrypted"
    default:
      // Unknown values must fail toward the secure default, never plaintext.
      return "encrypted"
  }
}

function parseEncryptedEnvelope(line: string): EncryptedTraceEnvelope | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<EncryptedTraceEnvelope>
    if (
      parsed.format !== "cmbcowork.trace" ||
      parsed.version !== 1 ||
      parsed.algorithm !== "aes-256-gcm" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.authTag !== "string" ||
      typeof parsed.ciphertext !== "string"
    ) {
      return undefined
    }
    return parsed as EncryptedTraceEnvelope
  } catch {
    return undefined
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseMigrationSnapshot(value: unknown): TraceMigrationSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.directories) || !isRecord(value.rootFiles)) {
    return undefined
  }

  const directories = Object.create(null) as Record<string, number>
  for (const [relativePath, mtimeMs] of Object.entries(value.directories)) {
    if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined
    directories[relativePath] = mtimeMs
  }

  const rootFiles = Object.create(null) as Record<string, TraceFileFingerprint>
  for (const [fileName, rawFingerprint] of Object.entries(value.rootFiles)) {
    if (!isRecord(rawFingerprint)) return undefined
    const { mtimeMs, size } = rawFingerprint
    if (
      typeof mtimeMs !== "number" ||
      !Number.isFinite(mtimeMs) ||
      typeof size !== "number" ||
      !Number.isFinite(size) ||
      mtimeMs < 0 ||
      size < 0
    ) {
      return undefined
    }
    rootFiles[fileName] = { mtimeMs, size }
  }

  return { directories, rootFiles }
}

function parseMigrationMarker(raw: string): TraceMigrationMarker | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const snapshot = parseMigrationSnapshot(parsed.snapshot)
    if (
      parsed.format !== "cmbcowork.trace-migration" ||
      parsed.version !== 1 ||
      typeof parsed.completedAt !== "string" ||
      !snapshot
    ) {
      return undefined
    }
    return {
      format: "cmbcowork.trace-migration",
      version: 1,
      completedAt: parsed.completedAt,
      snapshot
    }
  } catch {
    return undefined
  }
}

/**
 * Decide whether an incomplete first record can still be one of our generated
 * encrypted envelopes. Product envelopes contain only the six known top-level
 * properties, although their order is not security-significant. An unfinished
 * object or property name remains ambiguous; a complete unknown first property
 * proves the record is legacy plaintext/corrupt without reading the whole file.
 */
function couldBeEncryptedEnvelopePrefix(prefix: Buffer): boolean {
  let index = 0
  const skipWhitespace = (): void => {
    while (index < prefix.length) {
      const byte = prefix[index]
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a) break
      index += 1
    }
  }

  skipWhitespace()
  if (index >= prefix.length) return true
  if (prefix[index] !== 0x7b) return false
  index += 1
  skipWhitespace()
  if (index >= prefix.length) return true
  if (prefix[index] === 0x7d) return false
  if (prefix[index] !== 0x22) return false
  index += 1

  const propertyStart = index
  while (index < prefix.length) {
    const byte = prefix[index]
    if (byte === 0x22) {
      return TRACE_ENVELOPE_PROPERTY_NAMES.has(
        prefix.subarray(propertyStart, index).toString("ascii")
      )
    }
    // Escaped or unfinished property names stay conservative: they might decode
    // to a known property, and preserving a possible encrypted file is safer.
    if (byte === 0x5c) return true
    if (byte < 0x20 || byte > 0x7e) return false
    index += 1
  }
  return true
}

function parseTraceFileFingerprint(value: unknown): TraceFileFingerprint | undefined {
  if (!isRecord(value)) return undefined
  const { mtimeMs, size } = value
  if (
    typeof mtimeMs !== "number" ||
    !Number.isFinite(mtimeMs) ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    mtimeMs < 0 ||
    size < 0
  ) {
    return undefined
  }
  return { mtimeMs, size }
}

function parseMigrationProgress(raw: string): TraceMigrationProgress | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      parsed.format !== "cmbcowork.trace-migration-progress" ||
      parsed.version !== 2 ||
      typeof parsed.startedAt !== "string" ||
      !isRecord(parsed.verifiedFiles)
    ) {
      return undefined
    }
    const entries = Object.entries(parsed.verifiedFiles)
    if (entries.length > TRACE_INVENTORY_MAX_FILES) return undefined
    const verifiedFiles = Object.create(null) as Record<string, TraceFileFingerprint>
    for (const [relativePath, rawFingerprint] of entries) {
      const fingerprint = parseTraceFileFingerprint(rawFingerprint)
      if (!fingerprint) return undefined
      verifiedFiles[relativePath] = fingerprint
    }
    const rawProbeOffsets = parsed.oversizedProbeOffsets
    if (rawProbeOffsets !== undefined && !isRecord(rawProbeOffsets)) return undefined
    const probeEntries = Object.entries(rawProbeOffsets ?? {})
    if (probeEntries.length > TRACE_INVENTORY_MAX_FILES) return undefined
    const oversizedProbeOffsets = Object.create(null) as Record<string, TraceOversizedProbeProgress>
    for (const [relativePath, rawProgress] of probeEntries) {
      const fingerprint = parseTraceFileFingerprint(rawProgress)
      const offset = isRecord(rawProgress) ? rawProgress.offset : undefined
      if (
        !fingerprint ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > fingerprint.size
      ) {
        return undefined
      }
      oversizedProbeOffsets[relativePath] = { ...fingerprint, offset }
    }
    return {
      format: "cmbcowork.trace-migration-progress",
      version: 2,
      startedAt: parsed.startedAt,
      verifiedFiles,
      oversizedProbeOffsets
    }
  } catch {
    return undefined
  }
}

function sameFingerprint(
  left: TraceFileFingerprint | undefined,
  right: TraceFileFingerprint | undefined
): boolean {
  return Boolean(left && right && left.mtimeMs === right.mtimeMs && left.size === right.size)
}

function sameSnapshot(left: TraceMigrationSnapshot, right: TraceMigrationSnapshot): boolean {
  const leftDirectories = Object.entries(left.directories)
  const rightDirectories = Object.entries(right.directories)
  if (leftDirectories.length !== rightDirectories.length) return false
  for (const [relativePath, mtimeMs] of leftDirectories) {
    if (right.directories[relativePath] !== mtimeMs) return false
  }

  const leftRootFiles = Object.entries(left.rootFiles)
  const rightRootFiles = Object.entries(right.rootFiles)
  if (leftRootFiles.length !== rightRootFiles.length) return false
  return leftRootFiles.every(([fileName, fingerprint]) =>
    sameFingerprint(fingerprint, right.rootFiles[fileName])
  )
}

async function collectTraceStorageInventory(rootDir: string): Promise<TraceStorageInventory> {
  const snapshot: TraceMigrationSnapshot = {
    directories: Object.create(null) as Record<string, number>,
    rootFiles: Object.create(null) as Record<string, TraceFileFingerprint>
  }
  const directories = new Map<string, TraceInventoryDirectory>()
  const rootTraceFiles = new Map<string, { filePath: string; fingerprint: TraceFileFingerprint }>()
  let failedPaths = 0
  const pending: Array<{ fullPath: string; relativePath: string }> = [
    { fullPath: rootDir, relativePath: "" }
  ]
  let scannedEntries = 0
  let traceFileCount = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    let directory
    try {
      directory = await opendir(current.fullPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && current.relativePath === "") {
        return { snapshot, directories, rootTraceFiles, failedPaths }
      }
      failedPaths += 1
      continue
    }

    const currentDirectory = current.relativePath
      ? directories.get(current.relativePath)
      : undefined
    for await (const entry of directory) {
      scannedEntries += 1
      if (scannedEntries > TRACE_INVENTORY_MAX_ENTRIES) {
        failedPaths += 1
        return { snapshot, directories, rootTraceFiles, failedPaths }
      }
      if (scannedEntries % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
      const fullPath = join(current.fullPath, entry.name)
      if (entry.isDirectory()) {
        if (directories.size >= TRACE_INVENTORY_MAX_DIRECTORIES) {
          failedPaths += 1
          continue
        }
        try {
          const relativePath = normalizeRelativePath(
            current.relativePath ? join(current.relativePath, entry.name) : entry.name
          )
          const mtimeMs = (await stat(fullPath)).mtimeMs
          snapshot.directories[relativePath] = mtimeMs
          directories.set(relativePath, { mtimeMs, traceFiles: [] })
          pending.push({ fullPath, relativePath })
        } catch {
          failedPaths += 1
        }
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      if (traceFileCount >= TRACE_INVENTORY_MAX_FILES) {
        failedPaths += 1
        continue
      }
      traceFileCount += 1

      if (currentDirectory) {
        currentDirectory.traceFiles.push(fullPath)
        continue
      }

      try {
        const fileStat = await stat(fullPath)
        const fingerprint = { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
        snapshot.rootFiles[entry.name] = fingerprint
        rootTraceFiles.set(entry.name, { filePath: fullPath, fingerprint })
      } catch {
        failedPaths += 1
      }
    }
  }

  return { snapshot, directories, rootTraceFiles, failedPaths }
}

function selectTraceFilesForMigration(
  inventory: TraceStorageInventory,
  marker?: TraceMigrationMarker,
  progress?: TraceMigrationProgress
): {
  candidates: TraceMigrationCandidate[]
  verifiedFiles: Record<string, TraceFileFingerprint>
  oversizedProbeOffsets: Record<string, TraceOversizedProbeProgress>
  snapshotChanged: boolean
} {
  const candidates: TraceMigrationCandidate[] = []
  const verifiedFiles = Object.create(null) as Record<string, TraceFileFingerprint>
  const oversizedProbeOffsets = Object.create(null) as Record<string, TraceOversizedProbeProgress>
  for (const [directoryPath, directory] of inventory.directories) {
    if (marker?.snapshot.directories[directoryPath] === directory.mtimeMs) continue
    for (const filePath of directory.traceFiles) {
      const relativePath = normalizeRelativePath(join(directoryPath, basename(filePath)))
      const fingerprint = progress?.verifiedFiles[relativePath]
      if (fingerprint) verifiedFiles[relativePath] = fingerprint
      const probeProgress = progress?.oversizedProbeOffsets[relativePath]
      if (probeProgress) oversizedProbeOffsets[relativePath] = probeProgress
      candidates.push({ filePath, relativePath })
    }
  }
  for (const [fileName, entry] of inventory.rootTraceFiles) {
    if (sameFingerprint(marker?.snapshot.rootFiles[fileName], entry.fingerprint)) continue
    const fingerprint = progress?.verifiedFiles[fileName]
    if (fingerprint) verifiedFiles[fileName] = fingerprint
    const probeProgress = progress?.oversizedProbeOffsets[fileName]
    if (probeProgress) oversizedProbeOffsets[fileName] = probeProgress
    candidates.push({ filePath: entry.filePath, relativePath: fileName })
  }

  return {
    candidates,
    verifiedFiles,
    oversizedProbeOffsets,
    snapshotChanged: !marker || !sameSnapshot(marker.snapshot, inventory.snapshot)
  }
}

/**
 * Encrypts trace JSON lines with an AES-GCM data key. The data key is wrapped
 * by Electron safeStorage, so trace payloads are never persisted in plaintext
 * and the key remains bound to the current OS user profile.
 */
export class TraceLocalStorage {
  readonly mode: TraceStorageMode

  private readonly platform: NodeJS.Platform
  private readonly protector: TraceKeyProtector | undefined
  private readonly migrationMaxTotalBytes: number
  private dataKey: Buffer | undefined
  private readonly fileOperations = new Map<string, Promise<void>>()
  private initializationPromise: Promise<TraceStorageInitializationResult> | undefined

  constructor(
    readonly rootDir: string,
    options: TraceLocalStorageOptions = {}
  ) {
    this.mode = options.mode ?? resolveTraceStorageMode()
    this.platform = options.platform ?? process.platform
    this.protector = options.protector
    this.migrationMaxTotalBytes =
      typeof options.migrationMaxTotalBytes === "number" &&
      Number.isFinite(options.migrationMaxTotalBytes) &&
      options.migrationMaxTotalBytes > 0
        ? Math.floor(options.migrationMaxTotalBytes)
        : TRACE_MIGRATION_MAX_TOTAL_BYTES
  }

  /** Append one trace JSON document according to the configured storage mode. */
  async appendJsonLine(filePath: string, plaintext: string): Promise<boolean> {
    if (Buffer.byteLength(plaintext, "utf8") > TRACE_APPEND_MAX_PLAINTEXT_BYTES) return false
    if (this.mode === "plaintext") await this.invalidateMigrationMarkers()
    const storedLine = this.encodeLineForStorage(plaintext)
    if (storedLine === undefined) return false
    await this.runFileOperation(filePath, async () => {
      await this.ensurePrivateDirectory(dirname(filePath))
      await appendFile(filePath, `${storedLine}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE
      })
      await this.ensurePrivateFile(filePath)
    })
    return true
  }

  /** Decode a stored line. Legacy plaintext lines remain readable during migration. */
  decodeStoredLine(line: string): string {
    const envelope = parseEncryptedEnvelope(line)
    if (!envelope) return line

    const key = this.getOrCreateDataKey(false)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
    decipher.setAAD(TRACE_AAD)
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8")
  }

  /**
   * Prepare secure storage and rewrite legacy JSONL lines in place. A versioned
   * marker makes the full content scan one-time; later launches only revisit
   * directories whose metadata changed. If OS key protection is unavailable,
   * encrypted mode is fail-closed: new traces are not written as plaintext.
   */
  async initialize(): Promise<TraceStorageInitializationResult> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce().finally(() => {
        this.initializationPromise = undefined
      })
    }
    return this.initializationPromise
  }

  private async initializeOnce(): Promise<TraceStorageInitializationResult> {
    const result: TraceStorageInitializationResult = {
      mode: this.mode,
      ready: this.mode !== "encrypted",
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    }

    if (this.mode === "off") {
      try {
        await lstat(this.rootDir)
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return result
        throw error
      }
    }

    await this.ensurePrivateDirectory(this.rootDir)
    if (this.mode === "plaintext") {
      // A later encrypted-mode launch must not trust a marker created before
      // this explicitly unsafe mode had a chance to add plaintext lines.
      await this.invalidateMigrationMarkers()
      result.ready = true
      return result
    }

    const availability = this.encryptionAvailability()
    if (!availability.available) {
      result.reason = availability.reason
      return result
    }

    try {
      this.getOrCreateDataKey(true)
    } catch (error) {
      result.reason = error instanceof Error ? error.message : String(error)
      return result
    }

    result.ready = true
    const migrationState = await this.readMigrationState()
    const { marker, progress } = migrationState
    const inventory = await collectTraceStorageInventory(this.rootDir)
    if (inventory.failedPaths > 0) {
      result.failedFiles += inventory.failedPaths
      result.reason = `Trace inventory scan failed for ${inventory.failedPaths} path(s)`
    }
    const selection = selectTraceFilesForMigration(inventory, marker, progress)
    if (
      marker &&
      !selection.snapshotChanged &&
      selection.candidates.length === 0 &&
      result.failedFiles === 0
    ) {
      try {
        if (progress) await this.removeMigrationInProgressMarker()
        result.migrationSkipped = true
      } catch (error) {
        result.failedFiles += 1
        result.reason = `Trace migration progress marker cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
      return result
    }

    const migrationStartedAt = progress?.startedAt ?? new Date().toISOString()
    try {
      await this.writeMigrationProgress(
        selection.verifiedFiles,
        selection.oversizedProbeOffsets,
        migrationStartedAt
      )
    } catch (error) {
      result.failedFiles += 1
      result.reason = `Trace migration progress marker write failed: ${
        error instanceof Error ? error.message : String(error)
      }`
      return result
    }

    let migratedBytes = 0
    let deferredFiles = 0
    let verifiedSinceFlush = 0
    let progressWriteFailed = false
    for (let fileIndex = 0; fileIndex < selection.candidates.length; fileIndex += 1) {
      const candidate = selection.candidates[fileIndex]
      const previousFingerprint = selection.verifiedFiles[candidate.relativePath]
      const previousProbeProgress = selection.oversizedProbeOffsets[candidate.relativePath]
      delete selection.verifiedFiles[candidate.relativePath]
      delete selection.oversizedProbeOffsets[candidate.relativePath]
      try {
        const outcome = await this.runFileOperation(candidate.filePath, async () => {
          const fileStat = await lstat(candidate.filePath)
          if (!fileStat.isFile()) throw new Error("Trace migration target is not a regular file")
          const currentFingerprint = { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
          if (sameFingerprint(previousFingerprint, currentFingerprint)) {
            return { status: "resumed" as const, fingerprint: currentFingerprint }
          }
          // Stop before starting another file once this launch reaches its IO budget.
          // The first file is allowed through so every launch can make progress.
          // A file above the hard single-pass limit is deferred intact below: the
          // migration must never trade a startup IO bound for silent trace loss.
          const estimatedReadBytes =
            fileStat.size > this.migrationSinglePassLimit()
              ? Math.min(fileStat.size, TRACE_OVERSIZED_PROBE_MAX_BYTES)
              : fileStat.size
          if (
            migratedBytes > 0 &&
            migratedBytes + estimatedReadBytes > this.migrationMaxTotalBytes
          ) {
            return {
              status: "deferred" as const,
              probeProgress: sameFingerprint(previousProbeProgress, currentFingerprint)
                ? previousProbeProgress
                : undefined
            }
          }
          await this.ensurePrivateDirectory(dirname(candidate.filePath))
          await this.ensurePrivateFile(candidate.filePath)
          const probeOffset = sameFingerprint(previousProbeProgress, currentFingerprint)
            ? previousProbeProgress.offset
            : 0
          const protection = await this.protectTraceFile(
            candidate.filePath,
            fileStat.size,
            probeOffset
          )
          migratedBytes += Math.min(protection.bytesRead, this.migrationMaxTotalBytes)
          if (protection.changed === null) {
            return {
              status: "deferred" as const,
              probeProgress:
                protection.nextProbeOffset === undefined
                  ? undefined
                  : { ...currentFingerprint, offset: protection.nextProbeOffset }
            }
          }
          const protectedStat = await lstat(candidate.filePath)
          return {
            status: protection.changed ? ("migrated" as const) : ("protected" as const),
            fingerprint: { mtimeMs: protectedStat.mtimeMs, size: protectedStat.size }
          }
        })

        if (outcome.status === "deferred") {
          if (previousFingerprint) {
            selection.verifiedFiles[candidate.relativePath] = previousFingerprint
          }
          if (outcome.probeProgress) {
            selection.oversizedProbeOffsets[candidate.relativePath] = outcome.probeProgress
            verifiedSinceFlush += 1
          }
          // A single oversized/corrupt trace must not starve every later file.
          // Its bounded probe is charged above, while the remaining launch budget
          // stays available to independent candidates.
          deferredFiles += 1
        } else {
          selection.verifiedFiles[candidate.relativePath] = outcome.fingerprint
          if (outcome.status === "migrated") result.migratedFiles += 1
          if (outcome.status === "protected") result.protectedFiles += 1
          verifiedSinceFlush += 1
        }
      } catch (error) {
        result.failedFiles += 1
        result.reason ??= `Trace migration failed for ${candidate.relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
      if (fileIndex % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
      if (verifiedSinceFlush >= TRACE_MIGRATION_PROGRESS_FLUSH_INTERVAL) {
        try {
          await this.writeMigrationProgress(
            selection.verifiedFiles,
            selection.oversizedProbeOffsets,
            migrationStartedAt
          )
          verifiedSinceFlush = 0
        } catch (error) {
          result.failedFiles += 1
          progressWriteFailed = true
          result.reason = `Trace migration progress marker write failed: ${
            error instanceof Error ? error.message : String(error)
          }`
          break
        }
      }
    }

    if (!progressWriteFailed) {
      try {
        await this.writeMigrationProgress(
          selection.verifiedFiles,
          selection.oversizedProbeOffsets,
          migrationStartedAt
        )
      } catch (error) {
        result.failedFiles += 1
        result.reason = `Trace migration progress marker write failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }

    if (deferredFiles > 0 && result.failedFiles === 0) {
      result.reason = `Trace migration deferred ${deferredFiles} file(s) after reaching the per-launch IO budget`
    }

    if (result.failedFiles === 0 && deferredFiles === 0) {
      const finalInventory = await collectTraceStorageInventory(this.rootDir)
      if (finalInventory.failedPaths > 0) {
        result.failedFiles += finalInventory.failedPaths
        result.reason = `Trace inventory verification failed for ${finalInventory.failedPaths} path(s)`
      } else if (
        !(await this.isMigrationProgressComplete(finalInventory, marker, selection.verifiedFiles))
      ) {
        result.reason =
          "Trace inventory changed during migration; remaining files will resume next launch"
      } else {
        try {
          await this.writeMigrationMarker(finalInventory.snapshot)
          await this.removeMigrationInProgressMarker()
        } catch (error) {
          result.failedFiles += 1
          result.reason = `Trace migration marker write failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }

    return result
  }

  private protectLegacyLine(line: string): { storedLine: string; changed: boolean } {
    const normalizedLine = line.replace(/\r$/, "")
    if (!normalizedLine.trim() || parseEncryptedEnvelope(normalizedLine)) {
      return { storedLine: normalizedLine, changed: false }
    }
    if (normalizedLine.length > TRACE_MIGRATION_MAX_LINE_CHARS) {
      return {
        storedLine: this.encryptLine(
          JSON.stringify({
            traceStorageNotice: "oversized legacy trace omitted during migration",
            originalChars: normalizedLine.length
          })
        ),
        changed: true
      }
    }
    return { storedLine: this.encryptLine(normalizedLine), changed: true }
  }

  private migrationSinglePassLimit(): number {
    return Math.max(TRACE_MIGRATION_MAX_FILE_BYTES, this.migrationMaxTotalBytes)
  }

  private async protectTraceFile(
    filePath: string,
    fileSize: number,
    oversizedProbeOffset = 0
  ): Promise<TraceFileProtectionResult> {
    // A corrupt or unexpectedly huge trace must not monopolize startup IO. A
    // bounded first-record probe lets us fail secure when plaintext/corruption is
    // explicit, while valid encrypted or indeterminate files remain intact.
    // `null` deliberately remains distinct from `false`: deferred files must not
    // receive a verified fingerprint or let the completed marker advance.
    // Keep the fixed streaming threshold as a floor for deterministic tests that
    // intentionally configure a tiny aggregate budget.
    const maxSinglePassBytes = this.migrationSinglePassLimit()
    if (fileSize > maxSinglePassBytes) {
      const probe = await this.probeOversizedTraceFile(filePath, oversizedProbeOffset, fileSize)
      if (probe.classification === "unknown") {
        return {
          changed: null,
          bytesRead: probe.bytesRead,
          nextProbeOffset: probe.nextOffset
        }
      }
      if (probe.classification === "encrypted") {
        return { changed: false, bytesRead: probe.bytesRead }
      }
      // Trace files are disposable diagnostics, never task/checkpoint state. Once
      // any record in a file above the hard IO limit is proven unsafe, preserve a
      // small encrypted audit notice instead of either retaining plaintext or
      // performing an unbounded startup rewrite. This intentionally extends the
      // pre-existing oversized-plaintext policy to mixed encrypted/plain files.
      await this.atomicPrivateWrite(
        filePath,
        this.encryptLine(
          JSON.stringify({
            traceStorageNotice: "oversized legacy trace file omitted during migration",
            originalBytes: fileSize,
            migrationLimitBytes: maxSinglePassBytes
          })
        )
      )
      return { changed: true, bytesRead: probe.bytesRead }
    }
    if (fileSize > TRACE_MIGRATION_MAX_FILE_BYTES) {
      return {
        changed: await this.protectLargeTraceFile(filePath),
        bytesRead: fileSize
      }
    }

    const raw = await readFile(filePath, "utf8")
    let changed = false
    const protectedLines: string[] = []
    let cursor = 0
    let lineIndex = 0
    while (cursor <= raw.length) {
      const newline = raw.indexOf("\n", cursor)
      const end = newline < 0 ? raw.length : newline
      const protectedLine = this.protectLegacyLine(raw.slice(cursor, end))
      protectedLines.push(protectedLine.storedLine)
      changed ||= protectedLine.changed
      lineIndex += 1
      if (lineIndex % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
      if (newline < 0) break
      cursor = newline + 1
    }
    if (changed) await this.atomicPrivateWrite(filePath, protectedLines.join("\n"))
    return { changed, bytesRead: fileSize }
  }

  /**
   * Authenticate a bounded record-aligned slice of an oversized file. The next
   * launch resumes at the last complete newline, so a valid encrypted prefix can
   * never hide plaintext appended later in the same file. No content is changed
   * until a complete plaintext/corrupt record is observed.
   */
  private async probeOversizedTraceFile(
    filePath: string,
    requestedOffset: number,
    fileSize: number
  ): Promise<OversizedTraceProbeResult> {
    const handle = await open(filePath, "r")
    const startOffset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 && requestedOffset < fileSize
        ? requestedOffset
        : 0
    let bytesReadTotal = 0
    let lineBytes = 0
    let lineSegments: Buffer[] = []
    let position = startOffset
    let lineStartOffset = startOffset

    const lineIsAuthenticated = (line: string): boolean => {
      const normalizedLine = line.replace(/\r$/, "")
      if (!normalizedLine.trim()) return true
      if (!parseEncryptedEnvelope(normalizedLine)) return false
      try {
        this.decodeStoredLine(normalizedLine)
        return true
      } catch {
        return false
      }
    }

    try {
      while (bytesReadTotal < TRACE_OVERSIZED_PROBE_MAX_BYTES && position < fileSize) {
        const bytesToRead = Math.min(
          TRACE_OVERSIZED_PROBE_CHUNK_BYTES,
          TRACE_OVERSIZED_PROBE_MAX_BYTES - bytesReadTotal,
          fileSize - position
        )
        const chunk = Buffer.allocUnsafe(bytesToRead)
        const chunkStart = position
        const { bytesRead } = await handle.read(chunk, 0, bytesToRead, position)
        if (bytesRead === 0) break
        bytesReadTotal += bytesRead
        position += bytesRead
        const data = chunk.subarray(0, bytesRead)

        let cursor = 0
        while (cursor < data.length) {
          const newline = data.indexOf(0x0a, cursor)
          if (newline < 0) {
            const segment = data.subarray(cursor)
            lineSegments.push(segment)
            lineBytes += segment.length
            break
          }

          const segment = data.subarray(cursor, newline)
          if (segment.length > 0) {
            lineSegments.push(segment)
            lineBytes += segment.length
          }
          const line = Buffer.concat(lineSegments, lineBytes).toString("utf8").replace(/\r$/, "")
          lineSegments = []
          lineBytes = 0
          cursor = newline + 1
          lineStartOffset = chunkStart + newline + 1
          if (!lineIsAuthenticated(line)) {
            return { classification: "plaintext-or-corrupt", bytesRead: bytesReadTotal }
          }
        }
      }

      if (position >= fileSize) {
        if (lineBytes > 0) {
          const line = Buffer.concat(lineSegments, lineBytes).toString("utf8")
          if (!lineIsAuthenticated(line)) {
            return { classification: "plaintext-or-corrupt", bytesRead: bytesReadTotal }
          }
        }
        return { classification: "encrypted", bytesRead: bytesReadTotal }
      }

      // Resume only at a complete record boundary. If the current budget ended
      // partway through a line after earlier records, replay just that partial
      // line next launch rather than losing its authentication context.
      if (lineBytes === 0 || lineStartOffset > startOffset) {
        return {
          classification: "unknown",
          bytesRead: bytesReadTotal,
          nextOffset: lineBytes === 0 ? position : lineStartOffset
        }
      }

      // One record alone exceeded the maximum envelope budget. Preserve a prefix
      // that could still be a legacy/reordered encrypted envelope; an explicit
      // plaintext prefix remains safe to omit under the existing oversized-file
      // policy.
      const prefix = Buffer.concat(lineSegments, lineBytes)
      return {
        classification: couldBeEncryptedEnvelopePrefix(prefix) ? "unknown" : "plaintext-or-corrupt",
        bytesRead: bytesReadTotal,
        nextOffset: startOffset
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Stream large legacy traces through an encrypted temporary file. This keeps
   * heap usage bounded and avoids a permanently failing file that would force a
   * complete startup scan forever.
   */
  private async protectLargeTraceFile(filePath: string): Promise<boolean> {
    const originalTimes = await stat(filePath)
    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.secure-${process.pid}-${randomBytes(6).toString("hex")}`
    )
    let changed = false
    const protectLine = (line: string): string => {
      const protectedLine = this.protectLegacyLine(line)
      changed ||= protectedLine.changed
      return protectedLine.storedLine
    }

    try {
      await pipeline(
        createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 }),
        async function* (source: AsyncIterable<Buffer | string>) {
          let lineBuffer = ""
          let oversizedChars = 0
          let lineCount = 0

          const appendSegment = (segment: string): void => {
            if (oversizedChars > 0) {
              oversizedChars += segment.length
              return
            }
            const bufferedLimit = lineBuffer.startsWith('{"format":"cmbcowork.trace","version":1,')
              ? TRACE_MIGRATION_MAX_ENVELOPE_CHARS
              : TRACE_MIGRATION_MAX_LINE_CHARS
            if (lineBuffer.length + segment.length > bufferedLimit) {
              oversizedChars = lineBuffer.length + segment.length
              lineBuffer = ""
            } else {
              lineBuffer += segment
            }
          }
          const finishLine = (): string => {
            const storedLine =
              oversizedChars > 0
                ? protectLine(
                    JSON.stringify({
                      traceStorageNotice: "oversized legacy trace omitted during migration",
                      originalChars: oversizedChars
                    })
                  )
                : protectLine(lineBuffer)
            if (oversizedChars > 0) changed = true
            lineBuffer = ""
            oversizedChars = 0
            return storedLine
          }

          for await (const rawChunk of source) {
            const chunk = typeof rawChunk === "string" ? rawChunk : rawChunk.toString("utf8")
            let cursor = 0
            for (;;) {
              const newline = chunk.indexOf("\n", cursor)
              if (newline < 0) {
                appendSegment(chunk.slice(cursor))
                break
              }
              appendSegment(chunk.slice(cursor, newline))
              yield `${finishLine()}\n`
              lineCount += 1
              if (lineCount % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
              cursor = newline + 1
            }
          }
          if (lineBuffer || oversizedChars > 0) yield finishLine()
        },
        createWriteStream(tempPath, {
          encoding: "utf8",
          mode: PRIVATE_FILE_MODE,
          flags: "wx"
        })
      )
      await this.ensurePrivateFile(tempPath)
      if (!changed) return false
      await rename(tempPath, filePath)
      await utimes(filePath, originalTimes.atime, originalTimes.mtime)
      await this.ensurePrivateFile(filePath)
      return true
    } finally {
      await unlink(tempPath).catch(() => undefined)
    }
  }

  private async isMigrationProgressComplete(
    inventory: TraceStorageInventory,
    marker: TraceMigrationMarker | undefined,
    verifiedFiles: Record<string, TraceFileFingerprint>
  ): Promise<boolean> {
    const selection = selectTraceFilesForMigration(inventory, marker, {
      format: "cmbcowork.trace-migration-progress",
      version: 2,
      startedAt: "verification",
      verifiedFiles,
      oversizedProbeOffsets: Object.create(null) as Record<string, TraceOversizedProbeProgress>
    })
    for (let index = 0; index < selection.candidates.length; index += 1) {
      const candidate = selection.candidates[index]
      try {
        const fileStat = await lstat(candidate.filePath)
        if (
          !fileStat.isFile() ||
          !sameFingerprint(verifiedFiles[candidate.relativePath], {
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size
          })
        ) {
          return false
        }
      } catch {
        return false
      }
      if (index % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
    }
    return true
  }

  private encodeLineForStorage(plaintext: string): string | undefined {
    if (this.mode === "off") return undefined
    if (this.mode === "plaintext") {
      return plaintext
    }
    return this.encryptLine(plaintext)
  }

  private encryptLine(plaintext: string): string {
    const key = this.getOrCreateDataKey(true)
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(TRACE_AAD)
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    const envelope: EncryptedTraceEnvelope = {
      format: "cmbcowork.trace",
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    }
    return JSON.stringify(envelope)
  }

  private encryptionAvailability(): { available: boolean; reason?: string } {
    if (
      !this.protector ||
      typeof this.protector.isEncryptionAvailable !== "function" ||
      typeof this.protector.encryptString !== "function" ||
      typeof this.protector.decryptString !== "function"
    ) {
      return { available: false, reason: "Electron safeStorage is unavailable" }
    }

    try {
      if (!this.protector.isEncryptionAvailable()) {
        return { available: false, reason: "OS-backed encryption is unavailable" }
      }
      if (this.platform === "linux" && this.protector.getSelectedStorageBackend) {
        const backend = this.protector.getSelectedStorageBackend()
        if (backend === "basic_text" || backend === "unknown") {
          return {
            available: false,
            reason: `Electron safeStorage selected an unsafe Linux backend: ${backend}`
          }
        }
      }
      return { available: true }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private getOrCreateDataKey(allowCreate: boolean): Buffer {
    if (this.dataKey) return this.dataKey

    const availability = this.encryptionAvailability()
    if (!availability.available || !this.protector) {
      throw new Error(availability.reason ?? "Trace encryption is unavailable")
    }

    const keyPath = join(this.rootDir, KEY_FILE_NAME)
    this.ensurePrivateDirectoryForKey(this.rootDir)
    if (existsSync(keyPath)) {
      this.dataKey = this.readWrappedKey(keyPath, this.protector)
      return this.dataKey
    }
    if (!allowCreate) {
      throw new Error("Trace encryption key is missing")
    }

    const generatedKey = randomBytes(32)
    const wrapped: WrappedTraceKey = {
      format: "cmbcowork.trace-key",
      version: 1,
      protection: "electron.safeStorage",
      wrappedKey: this.protector.encryptString(generatedKey.toString("base64")).toString("base64")
    }

    try {
      writeFileSync(keyPath, `${JSON.stringify(wrapped)}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
        flag: "wx"
      })
      this.ensurePrivateFileForKey(keyPath)
      this.dataKey = generatedKey
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error
      this.dataKey = this.readWrappedKey(keyPath, this.protector)
    }
    return this.dataKey
  }

  private readWrappedKey(keyPath: string, protector: TraceKeyProtector): Buffer {
    this.ensurePrivateFileForKey(keyPath)
    const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Partial<WrappedTraceKey>
    if (
      parsed.format !== "cmbcowork.trace-key" ||
      parsed.version !== 1 ||
      parsed.protection !== "electron.safeStorage" ||
      typeof parsed.wrappedKey !== "string"
    ) {
      throw new Error("Trace encryption key file has an unsupported format")
    }

    const unwrapped = protector.decryptString(Buffer.from(parsed.wrappedKey, "base64"))
    const key = Buffer.from(unwrapped, "base64")
    if (key.length !== 32) throw new Error("Trace encryption key is invalid")
    return key
  }

  private async ensurePrivateDirectory(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    if (this.platform !== "win32") await chmod(dirPath, PRIVATE_DIRECTORY_MODE)
  }

  private async ensurePrivateFile(filePath: string): Promise<void> {
    if (this.platform !== "win32") await chmod(filePath, PRIVATE_FILE_MODE)
  }

  private ensurePrivateDirectoryForKey(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    if (this.platform !== "win32") chmodSync(dirPath, PRIVATE_DIRECTORY_MODE)
  }

  private ensurePrivateFileForKey(filePath: string): void {
    if (this.platform !== "win32") chmodSync(filePath, PRIVATE_FILE_MODE)
  }

  private migrationMarkerPath(): string {
    return join(this.rootDir, MIGRATION_MARKER_FILE_NAME)
  }

  private migrationInProgressPath(): string {
    return join(this.rootDir, MIGRATION_IN_PROGRESS_FILE_NAME)
  }

  private async readCompletedMigrationMarker(): Promise<TraceMigrationMarker | undefined> {
    const markerPath = this.migrationMarkerPath()
    try {
      await this.ensurePrivateFile(markerPath)
      return parseMigrationMarker(await readFile(markerPath, "utf8"))
    } catch {
      return undefined
    }
  }

  private async readMigrationState(): Promise<{
    marker?: TraceMigrationMarker
    progress?: TraceMigrationProgress
  }> {
    const progressPath = this.migrationInProgressPath()
    try {
      await this.ensurePrivateFile(progressPath)
      const progress = parseMigrationProgress(await readFile(progressPath, "utf8"))
      // An old or corrupt durable marker means the previous migration may have
      // stopped at any point. Ignore the completed snapshot and conservatively
      // rebuild progress from the files themselves.
      if (!progress) return {}
      return { marker: await this.readCompletedMigrationMarker(), progress }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") return {}
      return { marker: await this.readCompletedMigrationMarker() }
    }
  }

  private async invalidateMigrationMarkers(): Promise<void> {
    for (const markerPath of [this.migrationMarkerPath(), this.migrationInProgressPath()]) {
      try {
        await unlink(markerPath)
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error
      }
    }
  }

  private async writeMigrationProgress(
    verifiedFiles: Record<string, TraceFileFingerprint>,
    oversizedProbeOffsets: Record<string, TraceOversizedProbeProgress>,
    startedAt: string
  ): Promise<void> {
    const progress: TraceMigrationProgress = {
      format: "cmbcowork.trace-migration-progress",
      version: 2,
      startedAt,
      verifiedFiles,
      oversizedProbeOffsets
    }
    await this.atomicMarkerWrite(this.migrationInProgressPath(), `${JSON.stringify(progress)}\n`)
  }

  private async removeMigrationInProgressMarker(): Promise<void> {
    try {
      await unlink(this.migrationInProgressPath())
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
    }
  }

  private async writeMigrationMarker(snapshot: TraceMigrationSnapshot): Promise<void> {
    const markerPath = this.migrationMarkerPath()
    const marker: TraceMigrationMarker = {
      format: "cmbcowork.trace-migration",
      version: 1,
      completedAt: new Date().toISOString(),
      snapshot
    }
    await this.atomicMarkerWrite(markerPath, `${JSON.stringify(marker)}\n`)
  }

  private async atomicMarkerWrite(markerPath: string, content: string): Promise<void> {
    const tempPath = join(
      this.rootDir,
      `.${basename(markerPath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
    )
    try {
      await writeFile(tempPath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      await this.ensurePrivateFile(tempPath)
      await rename(tempPath, markerPath)
      await this.ensurePrivateFile(markerPath)
    } finally {
      await unlink(tempPath).catch(() => undefined)
    }
  }

  private async atomicPrivateWrite(filePath: string, content: string): Promise<void> {
    const originalTimes = await stat(filePath)
    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.secure-${process.pid}-${randomBytes(6).toString("hex")}`
    )
    try {
      await writeFile(tempPath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      await this.ensurePrivateFile(tempPath)
      await rename(tempPath, filePath)
      await utimes(filePath, originalTimes.atime, originalTimes.mtime)
      await this.ensurePrivateFile(filePath)
    } finally {
      try {
        await unlink(tempPath)
      } catch {
        // Best effort only; the temporary file contains encrypted content.
      }
    }
  }

  /** Serialize append/migration/prune/delete work touching the same trace file. */
  async runFileOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.fileOperations.get(filePath) ?? Promise.resolve()
    let resolveCurrent!: () => void
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve
    })
    this.fileOperations.set(filePath, current)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      resolveCurrent()
      if (this.fileOperations.get(filePath) === current) this.fileOperations.delete(filePath)
    }
  }
}

const storageCache = new Map<string, TraceLocalStorage>()

export function getTraceLocalStorage(
  rootDir: string,
  protector?: TraceKeyProtector
): TraceLocalStorage {
  const mode = resolveTraceStorageMode()
  const cacheKey = `${mode}\u0000${rootDir}`
  const cached = storageCache.get(cacheKey)
  if (cached) {
    storageCache.delete(cacheKey)
    storageCache.set(cacheKey, cached)
    return cached
  }
  const storage = new TraceLocalStorage(rootDir, { mode, protector })
  storageCache.set(cacheKey, storage)
  while (storageCache.size > TRACE_STORAGE_CACHE_MAX_ENTRIES) {
    const oldest = storageCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    storageCache.delete(oldest)
  }
  return storage
}

export function getTraceStorageCacheDiagnostics(): { size: number; maxEntries: number } {
  return { size: storageCache.size, maxEntries: TRACE_STORAGE_CACHE_MAX_ENTRIES }
}
