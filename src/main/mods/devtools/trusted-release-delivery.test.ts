import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, expect, it, vi } from "vitest"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { compileFunctionPlugin } from "../v2/loader"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { createAuthoringTemplate } from "./authoring-templates"
import { TrustedReleaseAuthority } from "./trusted-release-authority"
import { TrustedReleaseDelivery, writeReleaseCandidate } from "./trusted-release-delivery"
import { TrustedReleaseInstaller } from "./trusted-release-install"
import { createTrustedReleasePackage, readTrustedReleasePackage } from "./trusted-release-package"

const roots: string[] = []
const reference = { publisherId: "publisher", listingId: "listing", releaseId: "release-1" }
const scope = () => ({ signal: new AbortController().signal, assertCurrent: () => {} })

afterEach(async () => {
  for (const directory of roots.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) ||
        !basename(directory).startsWith("cmb-release-delivery-test-"))
      throw Error("TEST_CLEANUP_BOUNDARY")
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-release-delivery-test-"))
  roots.push(directory)
  const template = createAuthoringTemplate({
    id: "example", name: "Example", kind: "command", instruction: "Summarize"
  })
  const source = createAuthoringSourceBundle([
    ...template.files.map(file => file.path === "mods/main.ts" ? {
      ...file, text: 'import { label } from "./lib/labels"\nexport const sourceLabel = label\n' + file.text
    } : file),
    { path: "mods/lib/labels.ts", text: 'import { word } from "./word"\nexport const label = word + "!"' },
    { path: "mods/lib/word.ts", text: 'export const word = "Summary"' }
  ])
  for (const file of source.files) {
    const path = join(directory, "author", file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.text)
  }
  const compiled = await compileFunctionPlugin(join(directory, "author"), {
    captureSources: false, portablePaths: true
  })
  const prepared = createTrustedReleasePackage(source, compiled.digest)
  const { bytes, ...manifest } = prepared
  const accountId = "subscriber"
  const metadata = { ...reference, accountId, canDownload: true, package: manifest }
  const downloaded = { ...reference, accountId, packageSha256: manifest.packageSha256, bytes }
  let current = true
  const authority = new TrustedReleaseAuthority(() => ({
    accountId,
    isCurrent: () => current,
    authorizePublication: async () => ({ ...reference, accountId, canPublish: false }),
    resolveRelease: async () => metadata,
    downloadRelease: async () => downloaded
  }))
  const root = join(directory, "releases")
  const index = new PluginCatalogIndex(join(root, "installations.json"))
  const installer = new TrustedReleaseInstaller({ root, index })
  const legacyPath = join(directory, "plugins.json")
  const legacy = JSON.stringify([{ id: "legacy", name: compiled.name, path: "old", enabled: true }])
  await writeFile(legacyPath, legacy)
  return {
    directory, source, prepared, metadata, downloaded, installer, index, legacyPath, legacy,
    delivery: new TrustedReleaseDelivery(authority, installer),
    changeAccount: () => { current = false }
  }
}

it("round-trips the exported candidate and saves its authenticated release outside the plugin catalog", async () => {
  const f = await fixture()
  const path = join(f.directory, "candidate.zip")
  await writeReleaseCandidate(path, f.prepared)
  const outer = new AdmZip(await readFile(path))
  const review = JSON.parse(outer.readAsText("release.json"))
  expect(review.schemaVersion).toBe(1)
  expect(readTrustedReleasePackage(outer.readFile("plugin.zip")!, review.package)).toEqual(f.source)

  const confirm = vi.fn(async () => {
    expect(f.index.capture().raw).toBeNull()
    expect(await readFile(f.legacyPath, "utf8")).toBe(f.legacy)
    return true
  })
  const receipt = await f.delivery.install(reference, scope(), confirm)
  expect(receipt).toMatchObject({
    ...reference, state: "installed-inactive", packageSha256: f.prepared.packageSha256
  })
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
    release: expect.objectContaining(reference), name: "example"
  }))
  await f.delivery.recover()
  const retried = await f.delivery.install(reference, scope(), async () => true)
  expect(retried).toEqual(receipt)
  expect(JSON.parse(f.index.capture().raw!)).toMatchObject([{ enabled: false }])
  expect(await readFile(f.legacyPath, "utf8")).toBe(f.legacy)
})

it("requires both the authenticated identity and package or compiled digest before prompting", async () => {
  const f = await fixture()
  const confirm = vi.fn(async () => true)
  f.metadata.publisherId = "other"
  await expect(f.delivery.install(reference, scope(), confirm))
    .rejects.toThrow("TRUSTED_RELEASE_IDENTITY_MISMATCH")
  f.metadata.publisherId = reference.publisherId
  const actual = f.downloaded.bytes
  f.downloaded.bytes = Buffer.from(actual)
  f.downloaded.bytes[0] ^= 1
  await expect(f.delivery.install(reference, scope(), confirm))
    .rejects.toThrow("TRUSTED_RELEASE_PACKAGE_DIGEST")
  f.downloaded.bytes = actual
  f.metadata.package = { ...f.metadata.package, compiledDigest: "0".repeat(64) }
  await expect(f.delivery.install(reference, scope(), confirm))
    .rejects.toThrow("TRUSTED_RELEASE_COMPILED_DIGEST")
  expect(confirm).not.toHaveBeenCalled()
  expect(f.index.capture().raw).toBeNull()
})

it("keeps cancellation and account changes outside the durable commit", async () => {
  const f = await fixture()
  await expect(f.delivery.install(reference, scope(), async () => false)).resolves.toBeNull()
  await expect(f.delivery.install(reference, scope(), async () => {
    f.changeAccount()
    return true
  })).rejects.toThrow("TRUSTED_RELEASE_ACCOUNT_CHANGED")
  expect(f.index.capture().raw).toBeNull()
})

it("keeps the online path unavailable without a main-process authority", async () => {
  const f = await fixture()
  const delivery = new TrustedReleaseDelivery(new TrustedReleaseAuthority(), f.installer)
  const confirm = vi.fn(async () => true)
  expect(delivery.available).toBe(false)
  await expect(delivery.install(reference, scope(), confirm))
    .rejects.toThrow("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
  expect(confirm).not.toHaveBeenCalled()
  expect(f.index.capture().raw).toBeNull()
})
