import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import AdmZip from "adm-zip"
import {
  DERIVATION_LIMITS,
  derivationContentIdentity,
  isDerivationExcludedName,
  snapshotDerivationSource,
  type DerivationFile
} from "../../src/main/plugins/derivation-source"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"

const reportPath = "devclaw.package-report.json"
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** Verify the export's one documented report mutation without weakening package identity. */
export async function verifyLiveProjectZipIdentity(input: {
  zip: string
  originalDirectory: string
  expectedOriginalDigest: string
  name: string
  version: string
}) {
  const original = await snapshotDerivationSource(input.originalDirectory)
  const originalContentDigest = derivationContentIdentity(original.files)
  assert.equal(originalContentDigest, input.expectedOriginalDigest, "LIVE_ZIP_ORIGINAL_CHANGED")
  const manifest = JSON.parse(
    original.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
  )
  assert.equal(manifest.name, input.name, "LIVE_ZIP_ORIGINAL_NAME")
  assert.equal(manifest.version, input.version, "LIVE_ZIP_ORIGINAL_VERSION")
  assert((await stat(input.zip)).size <= DERIVATION_LIMITS.totalBytes * 2, "LIVE_ZIP_SIZE")
  const bytes = await readFile(input.zip)
  const entries = new AdmZip(bytes).getEntries()
  assert(entries.length <= DERIVATION_LIMITS.files, "LIVE_ZIP_FILE_COUNT")
  const names = new Set<string>()
  const segments = new Map<string, string>()
  const files: DerivationFile[] = []
  let total = 0
  for (const entry of entries) {
    const path = entry.entryName
    const parts = path.split("/")
    assert(
      !entry.isDirectory &&
        parts.length <= DERIVATION_LIMITS.depth &&
        parts.every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !/[\\<>:"|?*]/.test(part) &&
            [...part].every((character) => character.charCodeAt(0) >= 32) &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
            !isDerivationExcludedName(part)
        ),
      "LIVE_ZIP_UNSAFE_PATH"
    )
    const key = path.toLowerCase()
    assert(!names.has(key), "LIVE_ZIP_DUPLICATE_PATH")
    names.add(key)
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join("/")
      const previous = segments.get(prefix.toLowerCase())
      assert(previous === undefined || previous === prefix, "LIVE_ZIP_CASE_COLLISION")
      segments.set(prefix.toLowerCase(), prefix)
    }
    assert(((entry.attr >>> 16) & 0o170000) !== 0o120000, "LIVE_ZIP_LINK")
    assert(entry.header.size <= DERIVATION_LIMITS.fileBytes, "LIVE_ZIP_FILE_SIZE")
    total += entry.header.size
    assert(total <= DERIVATION_LIMITS.totalBytes, "LIVE_ZIP_TOTAL_SIZE")
    // getData verifies the stored CRC while decompressing; never extract to disk.
    const data = entry.getData()
    assert.equal(data.length, entry.header.size, "LIVE_ZIP_ENTRY_SIZE")
    files.push({ path, bytes: data, digest: hash(data), mode: 0 })
  }
  for (const path of names) {
    const parts = path.split("/")
    for (let count = 1; count < parts.length; count++)
      assert(!names.has(parts.slice(0, count).join("/")), "LIVE_ZIP_FILE_DIRECTORY_COLLISION")
  }
  const originalFiles = new Map(original.files.map((file) => [file.path, file]))
  const zipFiles = new Map(files.map((file) => [file.path, file]))
  for (const file of original.files) {
    if (file.path === reportPath) continue
    assert(
      zipFiles.get(file.path)?.bytes.equals(file.bytes),
      `LIVE_ZIP_SOURCE_CHANGED:${file.path}`
    )
  }
  for (const file of files)
    assert(file.path === reportPath || originalFiles.has(file.path), "LIVE_ZIP_EXTRA_FILE")
  const reportFile = zipFiles.get(reportPath)
  assert(reportFile, "LIVE_ZIP_REPORT_REQUIRED")
  const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportFile.bytes))
  assert.equal(report.schemaVersion, 1, "LIVE_ZIP_REPORT_SCHEMA")
  assert.equal(report.packageId, input.name, "LIVE_ZIP_REPORT_PACKAGE")
  if (report.name !== undefined) assert.equal(report.name, input.name, "LIVE_ZIP_REPORT_NAME")
  assert.equal(report.version, input.version, "LIVE_ZIP_REPORT_VERSION")
  assert(Array.isArray(report.files), "LIVE_ZIP_REPORT_FILES")
  const reported: string[] = report.files
  assert(
    reported.every((path) => typeof path === "string" && originalFiles.has(path)),
    "LIVE_ZIP_REPORT_UNKNOWN_FILE"
  )
  assert.equal(new Set(reported).size, reported.length, "LIVE_ZIP_REPORT_DUPLICATE_FILE")
  assert.deepEqual(
    reported.filter((path) => path !== reportPath).sort(),
    original.files
      .map((file) => file.path)
      .filter((path) => path !== reportPath)
      .sort(),
    "LIVE_ZIP_REPORT_MISSING_FILE"
  )
  const bundle = createAuthoringSourceBundle(
    reported.map((path) => ({
      path,
      text: new TextDecoder("utf-8", { fatal: true }).decode(originalFiles.get(path)!.bytes)
    }))
  )
  assert.equal(report.sourceDigest, bundle.digest, "LIVE_ZIP_REPORT_SOURCE_DIGEST")
  assert.equal(report.tests?.valid, true, "LIVE_ZIP_REPORT_TESTS")
  assert.equal(report.tests.digest, bundle.digest, "LIVE_ZIP_REPORT_TEST_DIGEST")
  return {
    originalContentDigest,
    zipContentDigest: derivationContentIdentity(files),
    zipSha256: hash(bytes),
    fileHashes: Object.fromEntries(files.map((file) => [file.path, file.digest])),
    packageReport: {
      schemaVersion: 1,
      packageId: report.packageId as string,
      version: report.version as string,
      sourceDigest: bundle.digest,
      files: reported,
      tests: { valid: true, digest: bundle.digest }
    }
  }
}
