import type { AuthoringPreviewAnalysis } from "./authoring-preflight"
import {
  inspectAuthoringPreparation,
  recoverAuthoringPreparation,
  measureAuthoringQuarantine
} from "./authoring-preparation-recovery"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { types } from "node:util"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import { AuthoringPreflightClient } from "./authoring-preflight-client"
import { readPureFunctionSource } from "./authoring-install-source"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"
import { AuthoringValidationError, authoringValidationResult } from "./authoring-validation-result"

export const AUTHORING_VERSION_LIMITS = Object.freeze({ versions: 16, bytes: 4 * 1024 * 1024 })
export interface PreparedAuthoringVersion {
  schemaVersion: 1
  coverage: "prepared-source-only-v1"
  versionId: string
  installationId: string
  workspace: string
  draftId: string
  revision: number
  source: AuthoringSourceBundle
  sourceDigest: string
  compiledDigest: string
  createdAt: number
}
export interface PrepareAuthoringVersionInput {
  installationId: string
  workspace: string
  draftId: string
  revision: number
  source: AuthoringSourceBundle
  signal: AbortSignal
  assertCurrent: () => void
}
/** A token only proves this process completed preparation. It grants no installation authority. */
export interface AuthoringPreparationToken {
  readonly kind: "authoring-preparation"
}
const tokens = new WeakMap<AuthoringPreparationToken, { repository: object; record: string }>()
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
function review(analysis: AuthoringPreviewAnalysis) {
  return {
    strictCompatible: analysis.sdk.strictCompatible,
    typesValid: analysis.typecheck.valid,
    modelProtocol: analysis.compiled.modelProtocol ?? "unknown",
    sdkMethods: [...new Set((analysis.sdk.usages ?? []).map((usage) => usage.method))].sort(),
    registrationEvents: [...new Set(
      (analysis.sdk as { registrationEvents?: string[] }).registrationEvents ?? []
    )].sort(),
    registrationEventsVerified:
      (analysis.sdk as { registrationEventsVerified?: boolean }).registrationEventsVerified === true
  }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    throw Error("AUTHORING_VERSION_INVALID")
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw Error("AUTHORING_VERSION_INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((item) => !("value" in item) || !item.enumerable)
  )
    throw Error("AUTHORING_VERSION_INVALID")
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]))
}

function identity(input: Record<string, unknown>) {
  if (
    !uuid(input.installationId) ||
    typeof input.workspace !== "string" ||
    !input.workspace ||
    input.workspace.length > 4096 ||
    input.workspace.includes("\0") ||
    typeof input.draftId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(input.draftId) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 1
  )
    throw Error("AUTHORING_VERSION_INVALID")
  return {
    installationId: input.installationId,
    workspace: input.workspace,
    draftId: input.draftId,
    revision: input.revision as number
  }
}

export function readPreparedAuthoringVersion(value: unknown): PreparedAuthoringVersion {
  const row = plain(value)
  if (
    row.schemaVersion !== 1 ||
    row.coverage !== "prepared-source-only-v1" ||
    !uuid(row.versionId) ||
    !sha(row.sourceDigest) ||
    !sha(row.compiledDigest) ||
    !Number.isSafeInteger(row.createdAt) ||
    Number(row.createdAt) < 0
  )
    throw Error("AUTHORING_VERSION_INVALID")
  const source = readPureFunctionSource(row.source)
  if (source.digest !== row.sourceDigest) throw Error("AUTHORING_VERSION_CHANGED")
  const result: PreparedAuthoringVersion = {
    schemaVersion: 1,
    coverage: "prepared-source-only-v1",
    versionId: row.versionId,
    ...identity(row),
    source,
    sourceDigest: source.digest,
    compiledDigest: row.compiledDigest,
    createdAt: row.createdAt as number
  }
  if (Object.keys(row).length !== Object.keys(result).length)
    throw Error("AUTHORING_VERSION_INVALID")
  return result
}
const readRecord = readPreparedAuthoringVersion

/**
 * Owns one application-created directory. Never point it at a workspace/plugin installation.
 * Cooperative writers serialize with an exclusive lock file, including capacity reservations.
 * A crash leaves its lock/staging directory for explicit reconciliation; never steal a lock.
 * No OS writer exclusion is claimed: callers revalidate before a later installation commit.
 */
export class AuthoringVersionRepository {
  private readonly root: string
  constructor(
    ownedRoot: string,
    private readonly fixedWorkerEntry: string
  ) {
    if (!isAbsolute(ownedRoot) || !isAbsolute(fixedWorkerEntry))
      throw Error("AUTHORING_VERSION_DIRECTORY")
    this.root = resolve(ownedRoot)
  }

  private rootIdentity() {
    const stat = lstatSync(this.root, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("AUTHORING_VERSION_DIRECTORY")
    return `${stat.dev}:${stat.ino}`
  }

  private verifyFiles(directory: string, source: AuthoringSourceBundle) {
    const expected = new Map(source.files.map((file) => [file.path, file.text]))
    const directories = new Set<string>()
    for (const file of source.files) {
      const segments = file.path.split("/")
      for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join("/"))
    }
    let seen = 0
    const visit = (relative: string) => {
      const path = relative ? join(directory, relative) : directory
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("AUTHORING_VERSION_CHANGED")
      for (const name of readdirSync(path)) {
        const key = relative ? `${relative}/${name}` : name
        const target = join(directory, key)
        const entry = lstatSync(target)
        if (entry.isSymbolicLink()) throw Error("AUTHORING_VERSION_CHANGED")
        if (entry.isDirectory() && directories.has(key)) visit(key)
        else if (
          entry.isFile() &&
          entry.nlink === 1 &&
          expected.has(key) &&
          entry.size === Buffer.byteLength(expected.get(key)!, "utf8") &&
          readBoundedAuthoringVersionFile(target, Buffer.byteLength(expected.get(key)!, "utf8")) ===
            expected.get(key)
        )
          seen++
        else throw Error("AUTHORING_VERSION_CHANGED")
      }
    }
    visit("")
    if (seen !== expected.size) throw Error("AUTHORING_VERSION_CHANGED")
  }

  private sourceIdentity(directory: string, source: AuthoringSourceBundle) {
    const paths = new Set([""])
    for (const file of source.files) {
      const parts = file.path.split("/")
      for (let count = 1; count <= parts.length; count++) paths.add(parts.slice(0, count).join("/"))
    }
    return JSON.stringify(
      [...paths].sort().map((path) => {
        const stat = lstatSync(join(directory, path), { bigint: true })
        return [
          path,
          ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
        ]
      })
    )
  }

  read(versionId: string): PreparedAuthoringVersion {
    if (!uuid(versionId)) throw Error("AUTHORING_VERSION_INVALID")
    this.rootIdentity()
    const directory = join(this.root, versionId)
    const stat = lstatSync(directory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      readdirSync(directory).sort().join(",") !== "record.json,source"
    )
      throw Error("AUTHORING_VERSION_CHANGED")
    const file = join(directory, "record.json")
    const recordStat = lstatSync(file)
    if (
      !recordStat.isFile() ||
      recordStat.isSymbolicLink() ||
      recordStat.nlink !== 1 ||
      recordStat.size > 1024 * 1024
    )
      throw Error("AUTHORING_VERSION_CHANGED")
    const record = readRecord(JSON.parse(readBoundedAuthoringVersionFile(file, 1024 * 1024)))
    if (record.versionId !== versionId) throw Error("AUTHORING_VERSION_CHANGED")
    this.verifyFiles(join(directory, "source"), record.source)
    return record
  }

  /** Reads are data, not renewed runtime checks. Tokens cannot survive process restart or clone. */
  assertPrepared(token: AuthoringPreparationToken): PreparedAuthoringVersion {
    const receipt = tokens.get(token)
    if (!receipt || receipt.repository !== this) throw Error("AUTHORING_VERSION_TOKEN")
    const original = readRecord(JSON.parse(receipt.record))
    const current = this.read(original.versionId)
    if (JSON.stringify(current) !== receipt.record) throw Error("AUTHORING_VERSION_CHANGED")
    return current
  }

  /** Host-only path for later preparation/commit. The returned path is not execution authority. */
  preparedSourceDirectory(token: AuthoringPreparationToken): string {
    const record = this.assertPrepared(token)
    return join(this.root, record.versionId, "source")
  }

  /** Recheck a retained version at its original compiler path; never consume another version slot. */
  async revalidate(versionId: string, input: { signal: AbortSignal; assertCurrent: () => void }) {
    const row = plain(input),
      signal = row.signal,
      guard = row.assertCurrent
    if (!(signal instanceof AbortSignal) || typeof guard !== "function")
      throw Error("AUTHORING_VERSION_INVALID")
    const controller = new AbortController(),
      abort = () => controller.abort()
    const deadline = performance.now() + 15_000
    const timer = setTimeout(abort, 15_000)
    signal.addEventListener("abort", abort, { once: true })
    const live = () => {
      if (signal.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw Error("AUTHORING_VERSION_CANCELLED")
      guard()
      if (signal.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw Error("AUTHORING_VERSION_CANCELLED")
    }
    const worker = new AuthoringPreflightClient(this.fixedWorkerEntry)
    let analysisReview!: ReturnType<typeof review>
    let captured!: PreparedAuthoringVersion, rootIdentity!: string, initialSourceIdentity!: string
    const directory = join(this.root, versionId, "source")
    try {
      live()
      captured = this.read(versionId)
      rootIdentity = this.rootIdentity()
      initialSourceIdentity = this.sourceIdentity(directory, captured.source)
      const analysis = await worker.run(directory, controller.signal)
      analysisReview = review(analysis)
      if (
        !analysis.sdk.strictCompatible ||
        !analysis.typecheck.valid ||
        analysis.compiled.digest !== captured.compiledDigest ||
        analysis.typecheck.digest !== captured.compiledDigest
      )
        throw Error("AUTHORING_VERSION_RECHECK_REQUIRED")
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      await worker.stop()
    }
    live()
    if (
      rootIdentity !== this.rootIdentity() ||
      initialSourceIdentity !== this.sourceIdentity(directory, captured.source) ||
      JSON.stringify(this.read(versionId)) !== JSON.stringify(captured)
    )
      throw Error("AUTHORING_VERSION_CHANGED")
    const token = Object.freeze({ kind: "authoring-preparation" as const })
    tokens.set(token, { repository: this, record: JSON.stringify(captured) })
    return { record: copy(captured), token, review: analysisReview }
  }

  inspectPreparation(workspace: string) {
    return inspectAuthoringPreparation(this.root, workspace)
  }
  recoverPreparation(workspace: string, fingerprint: string, assertCurrent: () => void) {
    return recoverAuthoringPreparation(this.root, workspace, fingerprint, assertCurrent, (id) => {
      this.read(id)
    })
  }

  /** Only the host's global reference check may authorize removing an unused preparation. */
  collectUnreferenced(
    workspace: string,
    isRetained: (record: PreparedAuthoringVersion) => boolean
  ) {
    if (!existsSync(this.root)) return
    const rootIdentity = this.rootIdentity()
    const lockPath = join(this.root, ".prepare-lock")
    let lock: number
    try {
      lock = openSync(lockPath, "wx", 0o600)
    } catch {
      throw Error("AUTHORING_VERSION_BUSY")
    }
    const lockIdentity = lstatSync(lockPath, { bigint: true })
    const current = () => {
      const stat = lstatSync(lockPath, { bigint: true })
      if (
        rootIdentity !== this.rootIdentity() ||
        stat.isSymbolicLink() ||
        stat.dev !== lockIdentity.dev ||
        stat.ino !== lockIdentity.ino
      )
        throw Error("AUTHORING_VERSION_CHANGED")
    }
    let deleting = false
    const owner = (versionId: string) => {
      const raw = JSON.stringify({ schemaVersion: 1, pid: process.pid, workspace, versionId })
      ftruncateSync(lock, 0)
      writeSync(lock, raw, 0, "utf8")
      fsyncSync(lock)
    }
    try {
      // A crash/failure leaves the ordinary preparation lock and remaining files for recovery.
      owner(randomUUID())
      const entries = readdirSync(this.root).filter(
        (name) => name !== ".prepare-lock" && name !== ".quarantine"
      )
      if (entries.some((name) => !uuid(name))) throw Error("AUTHORING_VERSION_RECONCILE_REQUIRED")
      // Validate the entire inventory before deleting anything; corrupt evidence is retained.
      const records = entries.map((id) => this.read(id))
      for (const record of records) {
        if (isRetained(record)) continue
        const directory = join(this.root, record.versionId)
        if (dirname(resolve(directory)) !== this.root) throw Error("AUTHORING_VERSION_DIRECTORY")
        const original = this.sourceIdentity(directory, {
          ...record.source,
          files: [
            { path: "record.json", text: JSON.stringify(record) },
            ...record.source.files.map((file) => ({ ...file, path: `source/${file.path}` }))
          ]
        })
        current()
        if (JSON.stringify(this.read(record.versionId)) !== JSON.stringify(record))
          throw Error("AUTHORING_VERSION_CHANGED")
        if (isRetained(record)) continue
        current()
        const observed = this.sourceIdentity(directory, {
          ...record.source,
          files: [
            { path: "record.json", text: JSON.stringify(record) },
            ...record.source.files.map((file) => ({ ...file, path: `source/${file.path}` }))
          ]
        })
        if (original !== observed) throw Error("AUTHORING_VERSION_CHANGED")
        owner(record.versionId)
        current()
        // UUID boundary, complete source verification and file identities precede recursive removal.
        deleting = true
        rmSync(directory, { recursive: true })
        deleting = false
      }
    } finally {
      closeSync(lock)
      if (!deleting) {
        current()
        unlinkSync(lockPath)
      }
    }
  }

  listRecords(excluded: ReadonlySet<string> = new Set()) {
    if (!existsSync(this.root)) return []
    this.rootIdentity()
    const entries = readdirSync(this.root).filter(
      (name) => name !== ".prepare-lock" && name !== ".quarantine"
    )
    if (entries.some((name) => !uuid(name))) throw Error("AUTHORING_VERSION_RECONCILE_REQUIRED")
    return entries.filter((id) => !excluded.has(id)).map((id) => this.read(id))
  }

  quarantineUsage() {
    if (!existsSync(this.root)) return { count: 0, bytes: 0 }
    this.rootIdentity()
    return measureAuthoringQuarantine(this.root)
  }

  /** Resumable deletion only after a durable, explicitly acknowledged retirement transaction. */
  retireRecords(
    records: PreparedAuthoringVersion[],
    retirementId: string,
    workspace: string,
    assertCurrent: () => void
  ) {
    if (!uuid(retirementId) || !records.length || records.length > 16)
      throw Error("AUTHORING_VERSION_INVALID")
    const rootIdentity = this.rootIdentity(),
      lockPath = join(this.root, ".prepare-lock")
    const current = () => {
      assertCurrent()
      if (rootIdentity !== this.rootIdentity()) throw Error("AUTHORING_VERSION_CHANGED")
    }
    current()
    if (existsSync(lockPath)) {
      const raw = readBoundedAuthoringVersionFile(lockPath, 8192)
      const owner = JSON.parse(raw)
      if (owner.retirementId !== retirementId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw Error("AUTHORING_VERSION_BUSY")
      if (owner.pid !== process.pid) {
        try {
          process.kill(owner.pid, 0)
          throw Error("AUTHORING_VERSION_BUSY")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      current()
      if (readBoundedAuthoringVersionFile(lockPath, 8192) !== raw)
        throw Error("AUTHORING_VERSION_CHANGED")
      unlinkSync(lockPath)
    }
    const lock = openSync(lockPath, "wx", 0o600)
    const identity = lstatSync(lockPath, { bigint: true })
    const ownsLock = () => {
      current()
      const stat = lstatSync(lockPath, { bigint: true })
      if (stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino)
        throw Error("AUTHORING_VERSION_CHANGED")
    }
    let complete = false
    try {
      writeFileSync(
        lock,
        JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          workspace,
          versionId: records[0].versionId,
          retirementId
        })
      )
      fsyncSync(lock)
      for (const original of records) {
        const record = readRecord(original)
        const directory = join(this.root, record.versionId)
        if (dirname(resolve(directory)) !== this.root) throw Error("AUTHORING_VERSION_DIRECTORY")
        try {
          lstatSync(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
          throw error
        }
        // A retry may see only a subset after a failed removal. Every remaining leaf must still
        // belong to the acknowledged immutable snapshot; unexpected data is retained.
        const expected = new Map([
          ["record.json", JSON.stringify(record)],
          ...record.source.files.map(
            (file) => [`source/${file.path}`, file.text] as [string, string]
          )
        ])
        const permitted = new Set([""])
        for (const path of expected.keys()) {
          const parts = path.split("/")
          for (let i = 1; i < parts.length; i++) permitted.add(parts.slice(0, i).join("/"))
        }
        const inspect = () => {
          const identities: string[] = []
          const visit = (relative: string) => {
            const target = join(directory, relative),
              stat = lstatSync(target, { bigint: true })
            if (stat.isSymbolicLink()) throw Error("AUTHORING_VERSION_CHANGED")
            identities.push(
              [relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(
                ":"
              )
            )
            if (stat.isDirectory() && permitted.has(relative)) {
              for (const name of readdirSync(target).sort())
                visit(relative ? `${relative}/${name}` : name)
            } else if (stat.isFile() && stat.nlink === 1n && expected.has(relative)) {
              const text = expected.get(relative)!
              if (readBoundedAuthoringVersionFile(target, Buffer.byteLength(text)) !== text)
                throw Error("AUTHORING_VERSION_CHANGED")
            } else throw Error("AUTHORING_VERSION_CHANGED")
          }
          visit("")
          return JSON.stringify(identities)
        }
        const before = inspect()
        ownsLock()
        if (inspect() !== before) throw Error("AUTHORING_VERSION_CHANGED")
        rmSync(directory, { recursive: true })
      }
      complete = true
    } finally {
      closeSync(lock)
      if (complete) {
        ownsLock()
        unlinkSync(lockPath)
      }
    }
  }

  async prepare(input: PrepareAuthoringVersionInput) {
    // Capture before any callback/await; caller mutation must not switch source or scope.
    const row = plain(input)
    const binding = identity(row)
    const source = readPureFunctionSource(row.source)
    const signal = row.signal as AbortSignal
    const assertCurrent = row.assertCurrent
    if (!(signal instanceof AbortSignal) || typeof assertCurrent !== "function")
      throw Error("AUTHORING_VERSION_INVALID")
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, 15_000)
    const deadline = performance.now() + 15_000
    const live = () => {
      if (signal.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw Error("AUTHORING_VERSION_CANCELLED")
      assertCurrent()
      if (signal.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw Error("AUTHORING_VERSION_CANCELLED")
    }
    let analysisReview!: ReturnType<typeof review>
    let lock: number | undefined
    let working: string | undefined
    let published: string | undefined
    let rootIdentity: string | undefined
    const worker = new AuthoringPreflightClient(this.fixedWorkerEntry)
    const versionId = randomUUID()
    const assertRoot = () => {
      if (rootIdentity !== this.rootIdentity()) throw Error("AUTHORING_VERSION_DIRECTORY")
    }
    const execute = async () => {
      try {
        live()
        mkdirSync(this.root, { recursive: true })
        rootIdentity = this.rootIdentity()
        try {
          lock = openSync(join(this.root, ".prepare-lock"), "wx", 0o600)
          writeFileSync(
            lock,
            JSON.stringify({
              schemaVersion: 1,
              pid: process.pid,
              workspace: binding.workspace,
              versionId
            })
          )
          fsyncSync(lock)
        } catch {
          throw Error("AUTHORING_VERSION_BUSY")
        }
        const entries = readdirSync(this.root).filter(
          (name) => name !== ".prepare-lock" && name !== ".quarantine"
        )
        const quarantined = measureAuthoringQuarantine(this.root)
        if (entries.some((name) => !uuid(name))) throw Error("AUTHORING_VERSION_RECONCILE_REQUIRED")
        if (entries.length + quarantined.count >= AUTHORING_VERSION_LIMITS.versions)
          throw Error("AUTHORING_VERSION_CAPACITY")
        let bytes = quarantined.bytes
        for (const entry of entries) {
          const record = this.read(entry)
          bytes +=
            Buffer.byteLength(JSON.stringify(record)) +
            record.source.files.reduce((total, file) => total + Buffer.byteLength(file.text), 0)
        }
        // Exact source is stored twice: executable directory and audit snapshot.
        const reservedBytes =
          Buffer.byteLength(JSON.stringify(source)) +
          source.files.reduce((total, file) => total + Buffer.byteLength(file.text), 0) +
          Buffer.byteLength(JSON.stringify(binding)) +
          2048
        if (bytes + reservedBytes > AUTHORING_VERSION_LIMITS.bytes)
          throw Error("AUTHORING_VERSION_CAPACITY")
        live()
        assertRoot()
        const finalDirectory = join(this.root, versionId)
        mkdirSync(finalDirectory)
        working = finalDirectory
        const sourceDirectory = join(working, "source")
        mkdirSync(sourceDirectory)
        for (const file of source.files) {
          const target = join(sourceDirectory, file.path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, file.text, { encoding: "utf8", flag: "wx", mode: 0o600 })
        }
        const initialSourceIdentity = this.sourceIdentity(sourceDirectory, source)
        const analysis = await worker.run(sourceDirectory, controller.signal)
        analysisReview = review(analysis)
        await worker.stop()
        live()
        assertRoot()
        this.verifyFiles(sourceDirectory, source)
        if (initialSourceIdentity !== this.sourceIdentity(sourceDirectory, source))
          throw Error("AUTHORING_VERSION_CHANGED")
        if (
          !sha(analysis.compiled.digest) ||
          analysis.compiled.digest !== analysis.typecheck.digest
        )
          throw Error("AUTHORING_VERSION_CHECK_FAILED")
        if (!analysis.sdk.strictCompatible || !analysis.typecheck.valid)
          throw new AuthoringValidationError(authoringValidationResult(source.digest, analysis))
        const record: PreparedAuthoringVersion = {
          schemaVersion: 1,
          coverage: "prepared-source-only-v1",
          versionId,
          ...binding,
          source,
          sourceDigest: source.digest,
          compiledDigest: analysis.compiled.digest,
          createdAt: Date.now()
        }
        const recordFile = join(working, "record.json")
        if (existsSync(recordFile)) throw Error("AUTHORING_VERSION_CHANGED")
        const temporaryRecord = join(working, ".record.json.pending")
        const recordDescriptor = openSync(temporaryRecord, "wx", 0o600)
        try {
          writeFileSync(recordDescriptor, JSON.stringify(record), "utf8")
          fsyncSync(recordDescriptor)
        } finally {
          closeSync(recordDescriptor)
        }
        live()
        assertRoot()
        this.verifyFiles(sourceDirectory, source)
        // The compiler's source path must never move after preflight: it affects its digest.
        renameSync(temporaryRecord, recordFile)
        published = working
        working = undefined
        closeSync(lock)
        lock = undefined
        unlinkSync(join(this.root, ".prepare-lock"))
        live()
        const checked = this.read(versionId)
        if (JSON.stringify(checked) !== JSON.stringify(record))
          throw Error("AUTHORING_VERSION_CHANGED")
        return record
      } catch (error) {
        // Never delete through a replaced root. Leave ambiguous state for explicit reconciliation.
        if (rootIdentity !== undefined && rootIdentity === this.rootIdentity()) {
          if (working) rmSync(working, { recursive: true, force: true })
          if (published) rmSync(published, { recursive: true, force: true })
        }
        throw error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        await worker.stop()
        if (lock !== undefined) {
          closeSync(lock)
          if (rootIdentity === this.rootIdentity()) unlinkSync(join(this.root, ".prepare-lock"))
        }
      }
    }
    const record = await execute()
    try {
      live()
      const checked = this.read(versionId)
      if (JSON.stringify(checked) !== JSON.stringify(record))
        throw Error("AUTHORING_VERSION_CHANGED")
      const token = Object.freeze({ kind: "authoring-preparation" as const })
      tokens.set(token, { repository: this, record: JSON.stringify(record) })
      return { record: copy(record), token, review: analysisReview }
    } catch (error) {
      if (rootIdentity === this.rootIdentity() && published)
        rmSync(published, { recursive: true, force: true })
      throw error
    }
  }
}
