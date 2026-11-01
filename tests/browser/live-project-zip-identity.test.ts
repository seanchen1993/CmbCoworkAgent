import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it } from "vitest"
import {
  derivationContentIdentity,
  snapshotDerivationSource
} from "../../src/main/plugins/derivation-source"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"
import { verifyLiveProjectZipIdentity } from "../support/live-project-zip-identity"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(existingReport = false) {
  const root = await mkdtemp(join(tmpdir(), "live-zip-identity-"))
  roots.push(root)
  const directory = join(root, "original")
  await mkdir(directory)
  const source = [
    { path: "plugin.json", text: JSON.stringify({ name: "fake-plugin", version: "0.1.0" }) },
    { path: "README.md", text: "unchanged package source\n" },
    ...(existingReport ? [{ path: "devclaw.package-report.json", text: '{"old":true}\n' }] : [])
  ]
  for (const file of source) await writeFile(join(directory, file.path), file.text)
  const snapshot = await snapshotDerivationSource(directory)
  const digest = createAuthoringSourceBundle(source).digest
  const report = {
    schemaVersion: 1,
    packageId: "fake-plugin",
    version: "0.1.0",
    sourceDigest: digest,
    files: source.map((file) => file.path),
    tests: { valid: true, digest }
  }
  const archive = new AdmZip()
  for (const file of source) archive.addFile(file.path, Buffer.from(file.text))
  const saveReport = () =>
    archive.addFile("devclaw.package-report.json", Buffer.from(JSON.stringify(report)))
  saveReport()
  const input = {
    zip: join(root, "export.zip"),
    originalDirectory: directory,
    expectedOriginalDigest: derivationContentIdentity(snapshot.files),
    name: "fake-plugin",
    version: "0.1.0"
  }
  const verify = async () => {
    await writeFile(input.zip, archive.toBuffer())
    return verifyLiveProjectZipIdentity(input)
  }
  return { input, archive, report, saveReport, verify }
}

describe("live project ZIP identity", () => {
  it.each([false, true])("verifies the report addition/rewrite (existing=%s)", async (old) => {
    const f = await fixture(old)
    const result = await f.verify()
    expect(result.originalContentDigest).toBe(f.input.expectedOriginalDigest)
    expect(result.zipContentDigest).not.toBe(result.originalContentDigest)
    expect(result.packageReport.sourceDigest).toBe(f.report.sourceDigest)
    expect(result.zipSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.keys(result.fileHashes)).toHaveLength(3)
  })

  it.each(["change", "missing", "extra"])("rejects a source %s", async (kind) => {
    const f = await fixture()
    if (kind === "change") f.archive.addFile("README.md", Buffer.from("changed\n"))
    if (kind === "missing") f.archive.deleteFile("README.md")
    if (kind === "extra") f.archive.addFile("extra.txt", Buffer.from("extra"))
    await expect(f.verify()).rejects.toThrow(/LIVE_ZIP_(SOURCE_CHANGED|EXTRA_FILE)/)
  })

  it.each(["source", "tests", "list", "package", "valid"])(
    "rejects incorrect report %s",
    async (kind) => {
      const f = await fixture()
      if (kind === "source") f.report.sourceDigest = "wrong"
      if (kind === "tests") f.report.tests.digest = "wrong"
      if (kind === "list") f.report.files.pop()
      if (kind === "package") f.report.packageId = "wrong"
      if (kind === "valid") f.report.tests.valid = false
      f.saveReport()
      await expect(f.verify()).rejects.toThrow(/LIVE_ZIP_REPORT_/)
    }
  )

  it("rejects a changed original identity", async () => {
    const f = await fixture()
    f.input.expectedOriginalDigest = "wrong"
    await expect(f.verify()).rejects.toThrow("LIVE_ZIP_ORIGINAL_CHANGED")
  })

  it.each(["README.MD", "unsafe/../bad.txt", "/bad.txt", "C:/bad.txt", ".env"])(
    "rejects unsafe or conflicting ZIP path %s",
    async (path) => {
      const f = await fixture()
      // Set the raw ZIP name after insertion: AdmZip's addFile sanitizes traversal names.
      f.archive.addFile("placeholder.txt", Buffer.from("bad"))
      f.archive.getEntry("placeholder.txt")!.entryName = path
      await expect(f.verify()).rejects.toThrow(/LIVE_ZIP_(UNSAFE_PATH|DUPLICATE_PATH)/)
    }
  )

  it("rejects duplicate file entries", async () => {
    const f = await fixture()
    f.archive.addFile("placeholder.txt", Buffer.from("bad"))
    f.archive.getEntry("placeholder.txt")!.entryName = "README.md"
    await expect(f.verify()).rejects.toThrow("LIVE_ZIP_DUPLICATE_PATH")
  })

  it("checks actual entry CRC while reading bytes", async () => {
    const f = await fixture()
    const bytes = f.archive.toBuffer()
    const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    bytes.writeUInt32LE((bytes.readUInt32LE(local + 14) ^ 1) >>> 0, local + 14)
    await writeFile(f.input.zip, bytes)
    await expect(verifyLiveProjectZipIdentity(f.input)).rejects.toThrow(/CRC/)
  })
})
