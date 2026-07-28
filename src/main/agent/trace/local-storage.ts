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

export interface TraceStorageInitializationResult {
  mode: TraceStorageMode
  ready: boolean
  migratedFiles: number
  protectedFiles: number
  failedFiles: number
  reason?: string
}

export interface TraceLocalStorageOptions {
  mode?: TraceStorageMode
  protector?: TraceKeyProtector
  platform?: NodeJS.Platform
}

const TRACE_STORAGE_MODE_ENV = "CMB_COWORK_TRACE_STORAGE_MODE"
const KEY_FILE_NAME = ".trace-key-v1.json"
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

function listTraceFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return []
  const files: string[] = []
  const pending = [rootDir]

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) pending.push(fullPath)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath)
    }
  }

  return files
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
   * Prepare secure storage and rewrite every legacy JSONL line in place. If OS
   * key protection is unavailable, encrypted mode is fail-closed: new traces
   * are not written as plaintext.
   */
  initialize(): TraceStorageInitializationResult {
    const result: TraceStorageInitializationResult = {
      mode: this.mode,
      ready: this.mode !== "encrypted",
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0
    }

    if (this.mode === "off" && !existsSync(this.rootDir)) {
      return result
    }

    this.ensurePrivateDirectory(this.rootDir)
    if (this.mode === "plaintext") {
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
    for (const filePath of listTraceFiles(this.rootDir)) {
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

    return result
  }

  private encodeLineForStorage(plaintext: string): string | undefined {
    if (this.mode === "off") return undefined
    if (this.mode === "plaintext") return plaintext
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
