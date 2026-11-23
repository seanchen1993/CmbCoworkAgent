import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { TrustedReleaseInstallReceipt } from "../../../shared/mods/trusted-release"
import type { TrustedReleaseMetadata } from "./trusted-release-authority"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { withPluginCatalogMutation } from "../../plugins/catalog-mutation"
import {
  AUTHORING_BUNDLE_LIMITS,
  createAuthoringSourceBundle,
  type AuthoringSourceBundle,
  type AuthoringSourceFile
} from "./authoring-bundle"
import { readPureFunctionSource } from "./authoring-install-source"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"

export type { TrustedReleaseInstallReceipt } from "../../../shared/mods/trusted-release"

export interface TrustedReleaseInstallInput extends Omit<
  TrustedReleaseInstallReceipt,
  "state" | "installationId"
> {
  source: AuthoringSourceBundle
  name: string
  version: string
  description: string
}

interface InstallationIntent {
  schemaVersion: 1
  receipt: TrustedReleaseInstallReceipt
  name: string
  version: string
  description: string
}
interface IndexedInstallation extends InstallationIntent {
  id: string
  path: string
  enabled: false
}

const sha256 = /^[a-f0-9]{64}$/
const installationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const externalId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const releaseKey = (releaseId: string) => createHash("sha256").update(releaseId).digest("hex")

function statIfPresent(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  }
}

function requireDirectory(path: string): void {
  const stat = statIfPresent(path)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw Error("TRUSTED_RELEASE_STORAGE_PATH")
}

function readText(path: string, maxBytes: number): string {
  try {
    if (!statIfPresent(path)?.isFile()) throw Error("TRUSTED_RELEASE_STORAGE_PATH")
    return readBoundedAuthoringVersionFile(path, maxBytes)
  } catch (cause) {
    throw Error("TRUSTED_RELEASE_STORAGE_PATH", { cause })
  }
}

function syncDirectory(path: string): void {
  // Directory handles cannot be fsynced on Windows. Files are flushed before rename there.
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeNewFile(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600)
  try {
    writeFileSync(fd, text, "utf8")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("TRUSTED_RELEASE_INSTALL_INVALID")
  return input as Record<string, unknown>
}

function readIntent(input: unknown, releaseDirectoryName: string): InstallationIntent {
  const row = record(input)
  const value = record(row.receipt)
  const { publisherId, listingId, releaseId, packageSha256, compiledDigest, sourceDigest } = value
  if (
    row.schemaVersion !== 1 ||
    value.state !== "installed-inactive" ||
    typeof value.installationId !== "string" ||
    !installationId.test(value.installationId) ||
    typeof publisherId !== "string" ||
    !externalId.test(publisherId) ||
    typeof listingId !== "string" ||
    !externalId.test(listingId) ||
    typeof releaseId !== "string" ||
    !externalId.test(releaseId) ||
    releaseKey(releaseId) !== releaseDirectoryName ||
    typeof packageSha256 !== "string" ||
    !sha256.test(packageSha256) ||
    typeof compiledDigest !== "string" ||
    !sha256.test(compiledDigest) ||
    typeof sourceDigest !== "string" ||
    !sha256.test(sourceDigest) ||
    typeof row.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(row.name) ||
    typeof row.version !== "string" ||
    !row.version ||
    row.version.length > 128 ||
    typeof row.description !== "string" ||
    row.description.length > 4096
  )
    throw Error("TRUSTED_RELEASE_INSTALL_INVALID")
  return {
    schemaVersion: 1,
    receipt: {
      state: "installed-inactive",
      installationId: value.installationId,
      publisherId,
      listingId,
      releaseId,
      packageSha256,
      compiledDigest,
      sourceDigest
    },
    name: row.name,
    version: row.version,
    description: row.description
  }
}

function verifySource(directory: string, digest: string): AuthoringSourceBundle {
  const files: AuthoringSourceFile[] = []
  let bytes = 0
  function visit(path: string, prefix: string): void {
    requireDirectory(path)
    for (const name of readdirSync(path)) {
      const local = join(path, name)
      const relative = prefix + name
      const status = lstatSync(local)
      if (relative.length > AUTHORING_BUNDLE_LIMITS.pathLength || status.isSymbolicLink())
        throw Error("TRUSTED_RELEASE_SOURCE_CHANGED")
      if (status.isDirectory()) {
        visit(local, relative + "/")
      } else {
        const text = readText(local, AUTHORING_BUNDLE_LIMITS.fileBytes)
        files.push({ path: relative, text })
        bytes += Buffer.byteLength(relative) + Buffer.byteLength(text)
        if (
          files.length > AUTHORING_BUNDLE_LIMITS.files ||
          bytes > AUTHORING_BUNDLE_LIMITS.totalBytes
        )
          throw Error("TRUSTED_RELEASE_SOURCE_CHANGED")
      }
    }
  }
  visit(directory, "")
  const source = readPureFunctionSource(createAuthoringSourceBundle(files))
  if (source.digest !== digest) throw Error("TRUSTED_RELEASE_SOURCE_CHANGED")
  return source
}

/** Owns only the private inactive release store. The legacy plugin catalog is outside this service. */
export class TrustedReleaseInstaller {
  private readonly root: string
  private readonly index: PluginCatalogIndex

  constructor(options: { root: string; index: PluginCatalogIndex }) {
    this.root = resolve(options.root)
    this.index = options.index
  }

  /** An interrupted transaction without a committed private index entry cannot be used. */
  readForUse(id: string, expected: TrustedReleaseMetadata) {
    if (!installationId.test(id) || !statIfPresent(this.root))
      throw Error("TRUSTED_RELEASE_INSTALLATION_UNAVAILABLE")
    requireDirectory(this.root)
    const entry = this.readIndex(this.index.capture().raw).find(row => row.id === id)
    if (!entry) throw Error("TRUSTED_RELEASE_INSTALLATION_UNAVAILABLE")
    const { receipt } = entry
    if (receipt.publisherId !== expected.publisherId || receipt.listingId !== expected.listingId ||
      receipt.releaseId !== expected.releaseId || receipt.packageSha256 !== expected.package.packageSha256 ||
      receipt.sourceDigest !== expected.package.sourceDigest ||
      receipt.compiledDigest !== expected.package.compiledDigest)
      throw Error("TRUSTED_RELEASE_IDENTITY_MISMATCH")
    const directory = dirname(entry.path)
    requireDirectory(directory)
    const intent = readIntent(JSON.parse(readText(join(directory, "receipt.json"), 24 * 1024)),
      releaseKey(receipt.releaseId))
    if (!this.sameIntent(entry, intent)) throw Error("TRUSTED_RELEASE_INDEX_CONFLICT")
    return { entry, source: verifySource(entry.path, receipt.sourceDigest) }
  }

  install(
    input: TrustedReleaseInstallInput,
    assertCurrent: () => void
  ): Promise<TrustedReleaseInstallReceipt> {
    return withPluginCatalogMutation(async () => {
      assertCurrent()
      const source = readPureFunctionSource(input.source)
      if (input.sourceDigest !== source.digest) throw Error("TRUSTED_RELEASE_SOURCE_CHANGED")
      const manifest = source.files.find((file) => file.path === "plugin.json")
      if (!manifest) throw Error("TRUSTED_RELEASE_SOURCE_CHANGED")
      const metadata = record(JSON.parse(manifest.text))
      if (
        metadata.name !== input.name ||
        metadata.version !== input.version ||
        (metadata.description ?? "") !== input.description
      )
        throw Error("TRUSTED_RELEASE_SOURCE_CHANGED")
      if (typeof input.releaseId !== "string" || !externalId.test(input.releaseId))
        throw Error("TRUSTED_RELEASE_INSTALL_INVALID")
      const key = releaseKey(input.releaseId)
      const requested = readIntent(
        {
          schemaVersion: 1,
          receipt: {
            state: "installed-inactive",
            installationId: randomUUID(),
            publisherId: input.publisherId,
            listingId: input.listingId,
            releaseId: input.releaseId,
            packageSha256: input.packageSha256,
            compiledDigest: input.compiledDigest,
            sourceDigest: source.digest
          },
          name: input.name,
          version: input.version,
          description: input.description
        },
        key
      )
      this.ensureRoot()
      const directory = join(this.root, key)
      if (!statIfPresent(directory)) {
        mkdirSync(directory, { mode: 0o700 })
        syncDirectory(this.root)
      }
      requireDirectory(directory)
      const intentPath = join(directory, "receipt.json")
      const staging = join(directory, "staging")
      const payload = join(directory, "source")
      let intent = requested
      if (statIfPresent(intentPath)) {
        intent = readIntent(JSON.parse(readText(intentPath, 24 * 1024)), key)
        requested.receipt.installationId = intent.receipt.installationId
        if (!this.sameIntent(requested, intent)) throw Error("TRUSTED_RELEASE_IDENTITY_CONFLICT")
      } else {
        const pending = join(directory, "receipt.pending")
        if (statIfPresent(staging) || statIfPresent(payload))
          throw Error("TRUSTED_RELEASE_STORAGE_PATH")
        if (statIfPresent(pending)) this.discardPendingFile(pending)
        assertCurrent()
        writeNewFile(pending, JSON.stringify(intent))
        renameSync(pending, intentPath)
        syncDirectory(directory)
      }

      const snapshot = this.index.capture()
      const rows = this.readIndex(snapshot.raw)
      const row = rows.find((item) => item.receipt.releaseId === intent.receipt.releaseId)
      if (row) {
        if (!this.sameIntent(row, intent)) throw Error("TRUSTED_RELEASE_INDEX_CONFLICT")
        verifySource(payload, intent.receipt.sourceDigest)
        assertCurrent()
        return { ...intent.receipt }
      }

      if (!statIfPresent(payload)) {
        this.removeStaging(staging)
        mkdirSync(staging, { mode: 0o700 })
        const directories = new Set([staging])
        for (const file of source.files) {
          const target = join(staging, file.path)
          const parent = dirname(target)
          mkdirSync(parent, { mode: 0o700, recursive: true })
          writeNewFile(target, file.text)
          for (let path = parent; path !== staging; path = dirname(path)) directories.add(path)
        }
        verifySource(staging, intent.receipt.sourceDigest)
        for (const path of [...directories].sort((left, right) => right.length - left.length))
          syncDirectory(path)
        assertCurrent()
        renameSync(staging, payload)
        syncDirectory(directory)
      }
      verifySource(payload, intent.receipt.sourceDigest)
      assertCurrent()
      this.index.replace(
        snapshot,
        JSON.stringify([
          ...rows,
          {
            ...intent,
            id: intent.receipt.installationId,
            path: payload,
            enabled: false
          }
        ])
      )
      syncDirectory(this.root)
      return { ...intent.receipt }
    })
  }

  recover(): Promise<void> {
    return withPluginCatalogMutation(async () => {
      if (!statIfPresent(this.root)) return
      requireDirectory(this.root)
      const rows = this.readIndex(this.index.capture().raw)
      const indexed = new Map(rows.map((row) => [releaseKey(row.receipt.releaseId), row]))
      for (const [key, item] of indexed) {
        const directory = join(this.root, key)
        requireDirectory(directory)
        const intent = readIntent(
          JSON.parse(readText(join(directory, "receipt.json"), 24 * 1024)),
          key
        )
        if (!this.sameIntent(item, intent)) throw Error("TRUSTED_RELEASE_INDEX_CONFLICT")
        requireDirectory(item.path)
      }
      for (const key of readdirSync(this.root)) {
        if (!sha256.test(key) || indexed.has(key)) continue
        const directory = join(this.root, key)
        requireDirectory(directory)
        // Incomplete staging can be discarded. A renamed payload remains private
        // until an authorized retry verifies it and commits the index.
        this.removeStaging(join(directory, "staging"))
      }
    })
  }

  private ensureRoot(): void {
    if (!statIfPresent(this.root)) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      syncDirectory(dirname(this.root))
    }
    requireDirectory(this.root)
  }

  private readIndex(raw: string | null): IndexedInstallation[] {
    if (raw === null) return []
    const input: unknown = JSON.parse(raw)
    if (!Array.isArray(input)) throw Error("TRUSTED_RELEASE_INDEX_CONFLICT")
    const releases = new Set<string>()
    const ids = new Set<string>()
    return input.map((value) => {
      const row = record(value)
      const receipt = record(row.receipt)
      if (typeof receipt.releaseId !== "string" || !externalId.test(receipt.releaseId))
        throw Error("TRUSTED_RELEASE_INDEX_CONFLICT")
      const key = releaseKey(receipt.releaseId)
      const intent = readIntent(row, key)
      const path = join(this.root, key, "source")
      if (
        row.id !== intent.receipt.installationId ||
        row.path !== path ||
        row.enabled !== false ||
        ids.has(intent.receipt.installationId) ||
        releases.has(key)
      )
        throw Error("TRUSTED_RELEASE_INDEX_CONFLICT")
      ids.add(intent.receipt.installationId)
      releases.add(key)
      return { ...intent, id: intent.receipt.installationId, path, enabled: false }
    })
  }

  private sameIntent(left: InstallationIntent, right: InstallationIntent): boolean {
    return (
      JSON.stringify(left.receipt) === JSON.stringify(right.receipt) &&
      left.name === right.name &&
      left.version === right.version &&
      left.description === right.description
    )
  }

  private removeStaging(path: string): void {
    if (!statIfPresent(path)) return
    requireDirectory(path)
    rmSync(path, { recursive: true })
  }

  private discardPendingFile(path: string): void {
    const item = lstatSync(path)
    if (!item.isFile() || item.nlink !== 1) throw Error("TRUSTED_RELEASE_STORAGE_PATH")
    rmSync(path)
  }
}
