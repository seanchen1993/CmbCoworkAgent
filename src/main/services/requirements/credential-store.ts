import * as fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  requirementFailure,
  type RequirementCredentialStatus,
  type RequirementSecurityCode
} from "../../../shared/requirement-credentials"

export interface RequirementSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export class RequirementSecurityError extends Error {
  constructor(readonly code: RequirementSecurityCode) {
    super(code)
  }
}
type Envelope = { version: 1; credentialRef: string; ciphertext: string }
type LegacyIndex = Record<string, unknown>

/** One profile, one purpose. All secret persistence and legacy-index edits share a queue. */
export class RequirementCredentialStore {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly filePath: string
  constructor(
    private readonly options: {
      directory: string
      legacyIndexPath: () => string
      safeStorage: RequirementSafeStorage
      platform?: NodeJS.Platform
      filesystem?: typeof fs
    }
  ) {
    this.filePath = path.join(options.directory, "leanstar.json")
  }

  private get io(): typeof fs {
    return this.options.filesystem ?? fs
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action)
    this.queue = result.catch(() => undefined)
    return result
  }
  private requireSecureBackend(): void {
    try {
      const storage = this.options.safeStorage
      if (!storage?.isEncryptionAvailable()) throw new Error()
      if ((this.options.platform ?? process.platform) === "linux") {
        const backend = storage.getSelectedStorageBackend?.()
        if (!backend || !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend))
          throw new Error()
      }
    } catch {
      throw new RequirementSecurityError("STORAGE_UNAVAILABLE")
    }
  }
  private async atomicWrite(filePath: string, data: unknown, secure = false): Promise<void> {
    const directory = path.dirname(filePath)
    await this.io.mkdir(directory, { recursive: true, mode: 0o700 })
    if (secure) {
      if ((await this.io.lstat(directory)).isSymbolicLink()) throw new Error()
      await this.io.chmod(directory, 0o700)
    }
    const temporary = `${filePath}.${randomUUID()}.tmp`
    try {
      await this.io.writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: "wx" })
      await this.io.rename(temporary, filePath)
      if (secure) await this.io.chmod(filePath, 0o600)
    } finally {
      await this.io.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  private async readIndex(): Promise<LegacyIndex> {
    try {
      const value: unknown = JSON.parse(
        await this.io.readFile(this.options.legacyIndexPath(), "utf8")
      )
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
      return value as LegacyIndex
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw new RequirementSecurityError("MIGRATION_FAILED")
    }
  }
  private async readCredential(): Promise<{ envelope: Envelope; token: string } | null> {
    this.requireSecureBackend()
    let serialized: string
    try {
      if ((await this.io.lstat(this.options.directory)).isSymbolicLink()) throw new Error()
      const stat = await this.io.lstat(this.filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error()
      await this.io.chmod(this.options.directory, 0o700)
      await this.io.chmod(this.filePath, 0o600)
      serialized = await this.io.readFile(this.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new RequirementSecurityError("STORAGE_FAILURE")
    }
    try {
      const envelope = JSON.parse(serialized) as Envelope
      if (
        envelope.version !== 1 ||
        !/^cred-[\w-]+$/.test(envelope.credentialRef) ||
        typeof envelope.ciphertext !== "string" ||
        !envelope.ciphertext
      )
        throw new Error()
      const token = this.options.safeStorage.decryptString(
        Buffer.from(envelope.ciphertext, "base64")
      )
      if (!token.trim()) throw new Error()
      return { envelope, token }
    } catch {
      throw new RequirementSecurityError("CORRUPT_CREDENTIAL")
    }
  }
  private async persist(token: string): Promise<Envelope> {
    this.requireSecureBackend()
    try {
      const ciphertext = this.options.safeStorage.encryptString(token)
      if (this.options.safeStorage.decryptString(ciphertext) !== token) throw new Error()
      const envelope: Envelope = {
        version: 1,
        credentialRef: `cred-${randomUUID()}`,
        ciphertext: ciphertext.toString("base64")
      }
      await this.atomicWrite(this.filePath, envelope, true)
      const readback = await this.readCredential()
      if (readback?.token !== token || readback.envelope.credentialRef !== envelope.credentialRef)
        throw new Error()
      return envelope
    } catch (error) {
      if (error instanceof RequirementSecurityError) throw error
      throw new RequirementSecurityError("STORAGE_FAILURE")
    }
  }
  private async migrate(index: LegacyIndex): Promise<void> {
    if (typeof index.token !== "string" || !index.token.trim()) {
      if ("token" in index) {
        delete index.token
        await this.atomicWrite(this.options.legacyIndexPath(), index)
      }
      return
    }
    try {
      // The original is retained until encryption, durable write, and decryption verification succeed.
      const current = await this.readCredential()
      if (!current || current.token !== index.token.trim()) await this.persist(index.token.trim())
      const clean = { ...index }
      delete clean.token
      await this.atomicWrite(this.options.legacyIndexPath(), clean)
      delete index.token
    } catch {
      throw new RequirementSecurityError("MIGRATION_FAILED")
    }
  }
  async updateLegacyIndex(update: (index: LegacyIndex) => LegacyIndex): Promise<void> {
    return this.exclusive(async () => {
      const index = await this.readIndex()
      // A migration failure refuses this edit: preserve original bytes, no plaintext temp copy.
      await this.migrate(index)
      const next = update(index)
      delete next.token
      await this.atomicWrite(this.options.legacyIndexPath(), next)
    })
  }
  async status(): Promise<RequirementCredentialStatus> {
    return this.exclusive(async () => {
      try {
        await this.migrate(await this.readIndex())
        const stored = await this.readCredential()
        return {
          success: true,
          configured: Boolean(stored),
          available: true,
          credentialRef: stored?.envelope.credentialRef ?? null
        }
      } catch (error) {
        return requirementFailure(
          error instanceof RequirementSecurityError ? error.code : "STORAGE_FAILURE"
        )
      }
    })
  }
  async save(value: unknown): Promise<RequirementCredentialStatus> {
    return this.exclusive(async () => {
      try {
        if (
          typeof value !== "string" ||
          !value.trim() ||
          value.length > 16_384 ||
          /[\r\n\0]/.test(value)
        )
          throw new RequirementSecurityError("INVALID_INPUT")
        const index = await this.readIndex()
        await this.migrate(index)
        const envelope = await this.persist(value.trim())
        return {
          success: true,
          configured: true,
          available: true,
          credentialRef: envelope.credentialRef
        }
      } catch (error) {
        return requirementFailure(
          error instanceof RequirementSecurityError ? error.code : "STORAGE_FAILURE"
        )
      }
    })
  }
  async consume<T>(credentialRef: string, action: (token: string) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.migrate(await this.readIndex())
      const stored = await this.readCredential()
      if (!stored) throw new RequirementSecurityError("CREDENTIAL_MISSING")
      if (stored.envelope.credentialRef !== credentialRef)
        throw new RequirementSecurityError("UNKNOWN_CREDENTIAL")
      return action(stored.token)
    })
  }
}

/** Reject raw and common transport-encoded secret echoes before crossing IPC. */
export function containsRequirementCredential(value: unknown, token: string): boolean {
  const needles = [token, encodeURIComponent(token), Buffer.from(token).toString("base64")]
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return needles.some((secret) => item.includes(secret))
    if (Array.isArray(item)) return item.some(visit)
    if (item && typeof item === "object")
      return Object.entries(item).some(([key, data]) => visit(key) || visit(data))
    return false
  }
  return visit(value)
}
