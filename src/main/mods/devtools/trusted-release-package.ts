import { createHash } from "node:crypto"
import { types } from "node:util"
import AdmZip from "adm-zip"
import {
  AUTHORING_BUNDLE_LIMITS,
  createAuthoringSourceBundle,
  readAuthoringFileChanges,
  type AuthoringSourceBundle
} from "./authoring-bundle"
import { readPureFunctionSource } from "./authoring-install-source"

export interface TrustedReleaseFile {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

export interface TrustedReleasePackageManifest {
  readonly packageSha256: string
  readonly sourceDigest: string
  readonly compiledDigest: string
  readonly files: readonly TrustedReleaseFile[]
}

// The uncompressed source limit leaves room for at most 64 local and central ZIP headers.
export const TRUSTED_RELEASE_PACKAGE_MAX_BYTES = AUTHORING_BUNDLE_LIMITS.totalBytes + 32 * 1024

const SHA256 = /^[0-9a-f]{64}$/
const STORED = 0
const DOS_EPOCH = 0x00210000
const ZIP_END_BYTES = 22
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_BYTES = 46
const ZIP_CENTRAL_SIGNATURE = 0x02014b50

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value)
}

function manifestRecord(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(input)))
    throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== keys.length)
    throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
  return Object.fromEntries(keys.map(key => {
    const entry = Object.getOwnPropertyDescriptor(input, key)
    if (!entry || !entry.enumerable || !("value" in entry))
      throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
    return [key, entry.value]
  }))
}

export function readTrustedReleasePackageManifest(input: unknown): TrustedReleasePackageManifest {
  const row = manifestRecord(input, ["packageSha256", "sourceDigest", "compiledDigest", "files"])
  const { packageSha256, sourceDigest, compiledDigest } = row
  if (!isDigest(packageSha256) || !isDigest(sourceDigest) || !isDigest(compiledDigest) ||
      !Array.isArray(row.files) || types.isProxy(row.files) ||
      row.files.length < 1 || row.files.length > AUTHORING_BUNDLE_LIMITS.files)
    throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
  const files: TrustedReleaseFile[] = []
  let total = 0
  for (let index = 0; index < row.files.length; index++) {
    const item = Object.getOwnPropertyDescriptor(row.files, String(index))
    if (!item || !("value" in item)) throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
    const { path, bytes, digest } = manifestRecord(item.value, ["path", "bytes", "digest"])
    if (typeof path !== "string" || path.length > AUTHORING_BUNDLE_LIMITS.pathLength ||
        typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
        bytes > AUTHORING_BUNDLE_LIMITS.fileBytes || !isDigest(digest))
      throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
    total += bytes + Buffer.byteLength(path, "utf8")
    if (total > AUTHORING_BUNDLE_LIMITS.totalBytes) throw Error("TRUSTED_RELEASE_PACKAGE_LIMIT")
    if (index > 0 && files[index - 1].path >= path) throw Error("TRUSTED_RELEASE_PACKAGE_MANIFEST")
    files.push({ path, bytes, digest })
  }
  readAuthoringFileChanges(files.map(({ path }) => ({ path, text: "" })))
  return { packageSha256, sourceDigest, compiledDigest, files }
}

function sourceFileManifest(source: AuthoringSourceBundle): TrustedReleaseFile[] {
  return source.files.map(({ path, text }) => {
    const bytes = Buffer.from(text, "utf8")
    return { path, bytes: bytes.length, digest: sha256(bytes) }
  })
}

function createCanonicalZip(source: AuthoringSourceBundle): Buffer {
  // Sources already have a stable ASCII path order. Store bytes as-is for deterministic output
  // across time zones and compression library versions, and bound reads before allocation.
  const zip = new AdmZip(undefined, { noSort: true })
  for (const { path, text } of source.files) {
    const entry = zip.addFile(path, Buffer.from(text, "utf8"), "", 0o644)
    entry.header.method = STORED
    entry.header.timeval = DOS_EPOCH
  }
  return zip.toBuffer()
}

function assertCanonicalDirectory(bytes: Buffer, files: readonly TrustedReleaseFile[]): void {
  const end = bytes.length - ZIP_END_BYTES
  let cursor = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt32LE(end) !== ZIP_END_SIGNATURE ||
      bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 20) !== 0 ||
      bytes.readUInt16LE(end + 8) !== files.length || bytes.readUInt16LE(end + 10) !== files.length ||
      cursor > end || bytes.readUInt32LE(end + 12) !== end - cursor)
    throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
  // Match bounded names before AdmZip expands their parent folders into archive entries.
  for (const { path } of files) {
    const name = Buffer.from(path, "utf8")
    const nameStart = cursor + ZIP_CENTRAL_BYTES
    const next = nameStart + name.length
    if (next > end || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE ||
        bytes.readUInt16LE(cursor + 28) !== name.length || bytes.readUInt32LE(cursor + 30) !== 0 ||
        !bytes.subarray(nameStart, next).equals(name))
      throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
    cursor = next
  }
  if (cursor !== end) throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
}

export function readTrustedReleasePackageIdentity(source: AuthoringSourceBundle) {
  const metadata = JSON.parse(source.files.find(file => file.path === "plugin.json")!.text)
  const manifest = JSON.parse(source.files.find(file => file.path === "mods/manifest.json")!.text)
  const { name, version, description = "" } = metadata
  if (typeof name !== "string" || name !== manifest.id || typeof version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version) ||
    typeof description !== "string" || description.length > 4096)
    throw Error("TRUSTED_RELEASE_PACKAGE_IDENTITY_MISMATCH")
  return { name, version, description }
}

/** The caller supplies the portable digest from a revalidated host-owned saved version. */
export function createTrustedReleasePackage(
  source: AuthoringSourceBundle,
  compiledDigest: string
): TrustedReleasePackageManifest & { readonly bytes: Buffer } {
  if (!isDigest(compiledDigest)) throw Error("TRUSTED_RELEASE_COMPILED_DIGEST")
  const validated = readPureFunctionSource(source)
  readTrustedReleasePackageIdentity(validated)
  const bytes = createCanonicalZip(validated)
  if (bytes.length > TRUSTED_RELEASE_PACKAGE_MAX_BYTES) throw Error("TRUSTED_RELEASE_PACKAGE_LIMIT")
  return {
    bytes,
    packageSha256: sha256(bytes),
    sourceDigest: validated.digest,
    compiledDigest,
    files: sourceFileManifest(validated)
  }
}

/** The expected manifest must come from the host's publisher authority, outside the ZIP. */
export function readTrustedReleasePackage(
  bytes: Buffer,
  manifest: TrustedReleasePackageManifest
): AuthoringSourceBundle {
  if (!Buffer.isBuffer(bytes) || bytes.length < ZIP_END_BYTES ||
      bytes.length > TRUSTED_RELEASE_PACKAGE_MAX_BYTES)
    throw Error("TRUSTED_RELEASE_PACKAGE_LIMIT")
  const expected = readTrustedReleasePackageManifest(manifest)
  if (sha256(bytes) !== expected.packageSha256)
    throw Error("TRUSTED_RELEASE_PACKAGE_DIGEST")

  assertCanonicalDirectory(bytes, expected.files)

  const entries = new AdmZip(bytes).getEntries()
  if (entries.length !== expected.files.length) throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
  const files = entries.map((entry, index) => {
    const { path, bytes: fileBytes, digest } = expected.files[index]
    const { size, compressedSize, method, encrypted } = entry.header
    if (entry.isDirectory || entry.entryName !== path || encrypted ||
        method !== STORED || size !== compressedSize || size !== fileBytes)
      throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
    const data = entry.getData()
    if (data.length !== size || sha256(data) !== digest)
      throw Error("TRUSTED_RELEASE_FILE_DIGEST")
    const text = data.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(data)) throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
    return { path, text }
  })
  const source = readPureFunctionSource(createAuthoringSourceBundle(files))
  if (source.digest !== expected.sourceDigest) throw Error("TRUSTED_RELEASE_SOURCE_DIGEST")
  // Refuse divergent local headers, extra records, attributes and hidden trailing data.
  if (!createCanonicalZip(source).equals(bytes)) throw Error("TRUSTED_RELEASE_PACKAGE_FORMAT")
  return source
}

/** Verify the digest of the local compiler result before anything is installed. */
export function assertTrustedReleaseCompiledDigest(actual: string, expected: string): void {
  if (actual !== expected || !isDigest(actual)) throw Error("TRUSTED_RELEASE_COMPILED_DIGEST")
}
