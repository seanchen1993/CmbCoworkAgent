import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "fs"
import type { Dirent } from "fs"
import { basename, dirname, join } from "path"

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
}

const TRACE_STORAGE_MODE_ENV = "CMB_COWORK_TRACE_STORAGE_MODE"
const KEY_FILE_NAME = ".trace-key-v1.json"
const MIGRATION_MARKER_FILE_NAME = ".trace-migration-v1.complete"
const TRACE_AAD = Buffer.from("cmbcowork.trace/v1", "utf8")
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

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

function collectTraceStorageInventory(rootDir: string): TraceStorageInventory {
  const snapshot: TraceMigrationSnapshot = {
    directories: Object.create(null) as Record<string, number>,
    rootFiles: Object.create(null) as Record<string, TraceFileFingerprint>
  }
  const directories = new Map<string, TraceInventoryDirectory>()
  const rootTraceFiles = new Map<string, { filePath: string; fingerprint: TraceFileFingerprint }>()
  let failedPaths = 0
  if (!existsSync(rootDir)) return { snapshot, directories, rootTraceFiles, failedPaths }

  const pending: Array<{ fullPath: string; relativePath: string }> = [
    { fullPath: rootDir, relativePath: "" }
  ]

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(current.fullPath, { withFileTypes: true })
    } catch {
      failedPaths += 1
      continue
    }

    const currentDirectory = current.relativePath
      ? directories.get(current.relativePath)
      : undefined
    for (const entry of entries) {
      const fullPath = join(current.fullPath, entry.name)
      if (entry.isDirectory()) {
        try {
          const relativePath = normalizeRelativePath(
            current.relativePath ? join(current.relativePath, entry.name) : entry.name
          )
          const mtimeMs = statSync(fullPath).mtimeMs
          snapshot.directories[relativePath] = mtimeMs
          directories.set(relativePath, { mtimeMs, traceFiles: [] })
          pending.push({ fullPath, relativePath })
        } catch {
          failedPaths += 1
        }
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue

      if (currentDirectory) {
        currentDirectory.traceFiles.push(fullPath)
        continue
      }

      try {
        const stat = statSync(fullPath)
        const fingerprint = { mtimeMs: stat.mtimeMs, size: stat.size }
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
  marker?: TraceMigrationMarker
): { filePaths: string[]; snapshotChanged: boolean } {
  if (!marker) {
    return {
      filePaths: [
        ...inventory.rootTraceFiles.values().map((entry) => entry.filePath),
        ...Array.from(inventory.directories.values()).flatMap((entry) => entry.traceFiles)
      ],
      snapshotChanged: true
    }
  }

  const filePaths: string[] = []
  for (const [relativePath, directory] of inventory.directories) {
    if (marker.snapshot.directories[relativePath] !== directory.mtimeMs) {
      filePaths.push(...directory.traceFiles)
    }
  }
  for (const [fileName, entry] of inventory.rootTraceFiles) {
    if (!sameFingerprint(marker.snapshot.rootFiles[fileName], entry.fingerprint)) {
      filePaths.push(entry.filePath)
    }
  }

  return {
    filePaths,
    snapshotChanged: !sameSnapshot(marker.snapshot, inventory.snapshot)
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
  private dataKey: Buffer | undefined

  constructor(
    readonly rootDir: string,
    options: TraceLocalStorageOptions = {}
  ) {
    this.mode = options.mode ?? resolveTraceStorageMode()
    this.platform = options.platform ?? process.platform
    this.protector = options.protector
  }

  /** Append one trace JSON document according to the configured storage mode. */
  appendJsonLine(filePath: string, plaintext: string): boolean {
    const storedLine = this.encodeLineForStorage(plaintext)
    if (storedLine === undefined) return false

    this.ensurePrivateDirectory(dirname(filePath))
    appendFileSync(filePath, `${storedLine}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE
    })
    this.ensurePrivateFile(filePath)
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
  initialize(): TraceStorageInitializationResult {
    const result: TraceStorageInitializationResult = {
      mode: this.mode,
      ready: this.mode !== "encrypted",
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    }

    if (this.mode === "off" && !existsSync(this.rootDir)) {
      return result
    }

    this.ensurePrivateDirectory(this.rootDir)
    if (this.mode === "plaintext") {
      // A later encrypted-mode launch must not trust a marker created before
      // this explicitly unsafe mode had a chance to add plaintext lines.
      this.invalidateMigrationMarker()
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
    const marker = this.readMigrationMarker()
    const inventory = collectTraceStorageInventory(this.rootDir)
    if (inventory.failedPaths > 0) {
      result.failedFiles += inventory.failedPaths
      result.reason = `Trace inventory scan failed for ${inventory.failedPaths} path(s)`
    }
    const selection = selectTraceFilesForMigration(inventory, marker)
    if (
      marker &&
      !selection.snapshotChanged &&
      selection.filePaths.length === 0 &&
      result.failedFiles === 0
    ) {
      result.migrationSkipped = true
      return result
    }

    for (const filePath of selection.filePaths) {
      try {
        this.ensurePrivateDirectory(dirname(filePath))
        this.ensurePrivateFile(filePath)
        const raw = readFileSync(filePath, "utf8")
        let changed = false
        const protectedContent = raw
          .split(/\r?\n/)
          .map((line) => {
            if (!line.trim() || parseEncryptedEnvelope(line)) return line
            changed = true
            return this.encryptLine(line)
          })
          .join("\n")

        if (changed) {
          this.atomicPrivateWrite(filePath, protectedContent)
          result.migratedFiles += 1
        } else {
          result.protectedFiles += 1
        }
      } catch {
        result.failedFiles += 1
      }
    }

    if (result.failedFiles === 0) {
      const finalInventory = collectTraceStorageInventory(this.rootDir)
      if (finalInventory.failedPaths > 0) {
        result.failedFiles += finalInventory.failedPaths
        result.reason = `Trace inventory verification failed for ${finalInventory.failedPaths} path(s)`
      } else {
        try {
          this.writeMigrationMarker(finalInventory.snapshot)
        } catch (error) {
          result.failedFiles += 1
          result.reason = `Trace migration marker write failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }

    return result
  }

  private encodeLineForStorage(plaintext: string): string | undefined {
    if (this.mode === "off") return undefined
    if (this.mode === "plaintext") {
      this.invalidateMigrationMarker()
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
    this.ensurePrivateDirectory(this.rootDir)
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
      this.ensurePrivateFile(keyPath)
      this.dataKey = generatedKey
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error
      this.dataKey = this.readWrappedKey(keyPath, this.protector)
    }
    return this.dataKey
  }

  private readWrappedKey(keyPath: string, protector: TraceKeyProtector): Buffer {
    this.ensurePrivateFile(keyPath)
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

  private ensurePrivateDirectory(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    if (this.platform !== "win32") chmodSync(dirPath, PRIVATE_DIRECTORY_MODE)
  }

  private ensurePrivateFile(filePath: string): void {
    if (this.platform !== "win32") chmodSync(filePath, PRIVATE_FILE_MODE)
  }

  private migrationMarkerPath(): string {
    return join(this.rootDir, MIGRATION_MARKER_FILE_NAME)
  }

  private readMigrationMarker(): TraceMigrationMarker | undefined {
    const markerPath = this.migrationMarkerPath()
    if (!existsSync(markerPath)) return undefined
    try {
      this.ensurePrivateFile(markerPath)
      return parseMigrationMarker(readFileSync(markerPath, "utf8"))
    } catch {
      return undefined
    }
  }

  private invalidateMigrationMarker(): void {
    const markerPath = this.migrationMarkerPath()
    try {
      unlinkSync(markerPath)
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
    }
  }

  private writeMigrationMarker(snapshot: TraceMigrationSnapshot): void {
    const markerPath = this.migrationMarkerPath()
    const marker: TraceMigrationMarker = {
      format: "cmbcowork.trace-migration",
      version: 1,
      completedAt: new Date().toISOString(),
      snapshot
    }
    const tempPath = join(
      this.rootDir,
      `.${MIGRATION_MARKER_FILE_NAME}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
    )
    try {
      writeFileSync(tempPath, `${JSON.stringify(marker)}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE
      })
      this.ensurePrivateFile(tempPath)
      renameSync(tempPath, markerPath)
      this.ensurePrivateFile(markerPath)
    } finally {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // Best effort only; the temporary marker contains no trace payload.
      }
    }
  }

  private atomicPrivateWrite(filePath: string, content: string): void {
    const originalTimes = statSync(filePath)
    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.secure-${process.pid}-${randomBytes(6).toString("hex")}`
    )
    try {
      writeFileSync(tempPath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      this.ensurePrivateFile(tempPath)
      renameSync(tempPath, filePath)
      utimesSync(filePath, originalTimes.atime, originalTimes.mtime)
      this.ensurePrivateFile(filePath)
    } finally {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // Best effort only; the temporary file contains encrypted content.
      }
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
  if (cached) return cached
  const storage = new TraceLocalStorage(rootDir, { mode, protector })
  storageCache.set(cacheKey, storage)
  return storage
}
