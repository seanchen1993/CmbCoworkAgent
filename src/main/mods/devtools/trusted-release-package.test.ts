import { createHash } from "node:crypto"
import AdmZip from "adm-zip"
import { expect, it } from "vitest"
import { AUTHORING_BUNDLE_LIMITS, createAuthoringSourceBundle } from "./authoring-bundle"
import { createAuthoringTemplate } from "./authoring-templates"
import {
  TRUSTED_RELEASE_PACKAGE_MAX_BYTES,
  assertTrustedReleaseCompiledDigest,
  createTrustedReleasePackage,
  readTrustedReleasePackage,
  readTrustedReleasePackageManifest
} from "./trusted-release-package"

const base = createAuthoringTemplate({
  id: "sample",
  name: "Sample",
  kind: "command",
  instruction: "Review"
})

const compiledDigest = "1".repeat(64)
const differentDigest = "2".repeat(64)
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

it("rejects inconsistent plugin names and spoofed version labels before creating a release", () => {
  for (const change of [{ name: "different" }, { version: "1.0\n发布者 other" }]) {
    const source = createAuthoringSourceBundle(base.files.map(file => file.path === "plugin.json"
      ? { ...file, text: JSON.stringify({ ...JSON.parse(file.text), ...change }) }
      : file
    ))
    expect(() => createTrustedReleasePackage(source, compiledDigest))
      .toThrow("TRUSTED_RELEASE_PACKAGE_IDENTITY_MISMATCH")
  }
})

it("creates deterministic ZIP bytes and verifies exact original text and file digests", () => {
  const source = createAuthoringSourceBundle([
    ...base.files,
    { path: "references/guide.md", text: "示例\r\n手册\n" },
    { path: "mods/empty.ts", text: "" }
  ])
  const { bytes, ...manifest } = createTrustedReleasePackage(source, compiledDigest)
  const reordered = createAuthoringSourceBundle([...source.files].reverse())
  expect(createTrustedReleasePackage(reordered, compiledDigest)).toEqual({ bytes, ...manifest })
  expect(manifest.packageSha256).toBe(hash(bytes))
  expect(manifest.files).toEqual(source.files.map(file => ({
    path: file.path, bytes: Buffer.byteLength(file.text), digest: hash(Buffer.from(file.text))
  })))
  expect(readTrustedReleasePackage(bytes, manifest)).toEqual(source)
  expect(() => assertTrustedReleaseCompiledDigest(compiledDigest, manifest.compiledDigest)).not.toThrow()
})

it("checks package, file, source and compiled digests independently", () => {
  const { bytes, ...manifest } = createTrustedReleasePackage(base, compiledDigest)
  const changed = Buffer.from(bytes)
  changed[0] ^= 1
  expect(() => readTrustedReleasePackage(changed, manifest)).toThrow("TRUSTED_RELEASE_PACKAGE_DIGEST")
  expect(() => readTrustedReleasePackage(bytes, {
    ...manifest,
    files: [{ ...manifest.files[0], digest: differentDigest }, ...manifest.files.slice(1)]
  })).toThrow("TRUSTED_RELEASE_FILE_DIGEST")
  expect(() => readTrustedReleasePackage(bytes, { ...manifest, sourceDigest: differentDigest }))
    .toThrow("TRUSTED_RELEASE_SOURCE_DIGEST")
  expect(() => assertTrustedReleaseCompiledDigest(differentDigest, manifest.compiledDigest))
    .toThrow("TRUSTED_RELEASE_COMPILED_DIGEST")
})

it("rejects unsupported compressed archives even with matching bytes and file manifests", () => {
  const { bytes: _original, ...manifest } = createTrustedReleasePackage(base, compiledDigest)
  const zip = new AdmZip(undefined, { noSort: true })
  for (const file of base.files) zip.addFile(file.path, Buffer.from(file.text))
  const bytes = zip.toBuffer()
  expect(() => readTrustedReleasePackage(bytes, { ...manifest, packageSha256: hash(bytes) }))
    .toThrow("TRUSTED_RELEASE_PACKAGE_FORMAT")
})

it("rejects noncanonical stored archives and bounds package bytes before parsing", () => {
  const { bytes: _original, ...manifest } = createTrustedReleasePackage(base, compiledDigest)
  const zip = new AdmZip(undefined, { noSort: true })
  for (const file of base.files) {
    const entry = zip.addFile(file.path, Buffer.from(file.text), "", 0o777)
    entry.header.method = 0
    entry.header.timeval = 0x00210000
  }
  const bytes = zip.toBuffer()
  expect(() => readTrustedReleasePackage(bytes, { ...manifest, packageSha256: hash(bytes) }))
    .toThrow("TRUSTED_RELEASE_PACKAGE_FORMAT")
  expect(() => readTrustedReleasePackage(Buffer.alloc(TRUSTED_RELEASE_PACKAGE_MAX_BYTES + 1), manifest))
    .toThrow("TRUSTED_RELEASE_PACKAGE_LIMIT")
})

it("rejects incompatible manifest paths, lengths and accessors before reading a ZIP", () => {
  const { bytes: _original, ...manifest } = createTrustedReleasePackage(base, compiledDigest)
  const changed = (file: object) => ({
    ...manifest,
    files: [{ ...manifest.files[0], ...file }, ...manifest.files.slice(1)]
  })
  expect(() => readTrustedReleasePackageManifest(changed({ path: "../plugin.json" })))
    .toThrow("AUTHORING_SOURCE_PATH")
  expect(() => readTrustedReleasePackageManifest(changed({ bytes: AUTHORING_BUNDLE_LIMITS.fileBytes + 1 })))
    .toThrow("TRUSTED_RELEASE_PACKAGE_MANIFEST")
  const files = Object.defineProperty([...manifest.files], "0", {
    get: () => { throw Error("Unexpected accessor execution") }
  })
  expect(() => readTrustedReleasePackageManifest({ ...manifest, files }))
    .toThrow("TRUSTED_RELEASE_PACKAGE_MANIFEST")
})

it("refuses authoring changes that introduce legacy auto-load declarations", () => {
  const source = createAuthoringSourceBundle([...base.files, {
    path: "hooks/hooks.json", text: "{}"
  }])
  expect(() => createTrustedReleasePackage(source, compiledDigest))
    .toThrow("AUTHORING_INSTALL_PURE_SOURCE_REQUIRED")
})
