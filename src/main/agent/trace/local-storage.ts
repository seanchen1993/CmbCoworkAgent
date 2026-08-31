import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile
} from "fs/promises"
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
const MIGRATION_IN_PROGRESS_FILE_NAME = ".trace-migration-v1.in-progress"
const TRACE_AAD = Buffer.from("cmbcowork.trace/v1", "utf8")
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const TRACE_INVENTORY_MAX_ENTRIES = 4_096
const TRACE_INVENTORY_MAX_DIRECTORIES = 2_048
const TRACE_INVENTORY_MAX_FILES = 4_096
const TRACE_MIGRATION_MAX_FILE_BYTES = 8 * 1024 * 1024
const TRACE_MIGRATION_MAX_TOTAL_BYTES = 64 * 1024 * 1024
const TRACE_MIGRATION_MAX_LINE_CHARS = 1536 * 1024
const TRACE_MIGRATION_YIELD_INTERVAL = 128
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
  private readonly fileOperations = new Map<string, Promise<void>>()
  private initializationPromise: Promise<TraceStorageInitializationResult> | undefined

  constructor(
    readonly rootDir: string,
    options: TraceLocalStorageOptions = {}
  ) {
    this.mode = options.mode ?? resolveTraceStorageMode()
    this.platform = options.platform ?? process.platform
    this.protector = options.protector
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
    const marker = await this.readMigrationMarker()
    const inventory = await collectTraceStorageInventory(this.rootDir)
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

    try {
      await this.writeMigrationInProgressMarker()
    } catch (error) {
      result.failedFiles += 1
      result.reason = `Trace migration progress marker write failed: ${
        error instanceof Error ? error.message : String(error)
      }`
      return result
    }

    let migratedBytes = 0
    for (let fileIndex = 0; fileIndex < selection.filePaths.length; fileIndex += 1) {
      const filePath = selection.filePaths[fileIndex]
      try {
        await this.runFileOperation(filePath, async () => {
          const fileStat = await lstat(filePath)
          if (
            !fileStat.isFile() ||
            fileStat.size > TRACE_MIGRATION_MAX_FILE_BYTES ||
            migratedBytes + fileStat.size > TRACE_MIGRATION_MAX_TOTAL_BYTES
          ) {
            throw new Error("Trace migration byte budget exceeded")
          }
          migratedBytes += fileStat.size
          await this.ensurePrivateDirectory(dirname(filePath))
          await this.ensurePrivateFile(filePath)
          const raw = await readFile(filePath, "utf8")
          let changed = false
          const protectedLines: string[] = []
          let cursor = 0
          let lineIndex = 0
          while (cursor <= raw.length) {
            const newline = raw.indexOf("\n", cursor)
            const end = newline < 0 ? raw.length : newline
            const line = raw.slice(cursor, end).replace(/\r$/, "")
            protectedLines.push(
              !line.trim()
                ? line
                : line.length > TRACE_MIGRATION_MAX_LINE_CHARS
                  ? (() => {
                      changed = true
                      return this.encryptLine(
                        JSON.stringify({
                          traceStorageNotice: "oversized legacy trace omitted during migration",
                          originalChars: line.length
                        })
                      )
                    })()
                  : parseEncryptedEnvelope(line)
                    ? line
                    : (() => {
                    changed = true
                    return this.encryptLine(line)
                      })()
            )
            lineIndex += 1
            if (lineIndex % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
            if (newline < 0) break
            cursor = newline + 1
          }
          const protectedContent = protectedLines.join("\n")
          if (changed) {
            await this.atomicPrivateWrite(filePath, protectedContent)
            result.migratedFiles += 1
          } else {
            result.protectedFiles += 1
          }
        })
      } catch {
        result.failedFiles += 1
      }
      if (fileIndex % TRACE_MIGRATION_YIELD_INTERVAL === 0) await yieldToEventLoop()
    }

    if (result.failedFiles === 0) {
      const finalInventory = await collectTraceStorageInventory(this.rootDir)
      if (finalInventory.failedPaths > 0) {
        result.failedFiles += finalInventory.failedPaths
        result.reason = `Trace inventory verification failed for ${finalInventory.failedPaths} path(s)`
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

  private async readMigrationMarker(): Promise<TraceMigrationMarker | undefined> {
    try {
      await lstat(this.migrationInProgressPath())
      return undefined
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") return undefined
    }
    const markerPath = this.migrationMarkerPath()
    try {
      await this.ensurePrivateFile(markerPath)
      return parseMigrationMarker(await readFile(markerPath, "utf8"))
    } catch {
      return undefined
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

  private async writeMigrationInProgressMarker(): Promise<void> {
    await this.atomicMarkerWrite(
      this.migrationInProgressPath(),
      `${JSON.stringify({ version: 1, startedAt: new Date().toISOString() })}\n`
    )
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
