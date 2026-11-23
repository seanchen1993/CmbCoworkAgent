import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { TrustedReleaseInstaller, type TrustedReleaseInstallInput } from "./trusted-release-install"

const source = createAuthoringSourceBundle([
  {
    path: "plugin.json",
    text: JSON.stringify({ name: "example", version: "1.1.0", mods: "mods/manifest.json" })
  },
  {
    path: "mods/manifest.json",
    text: JSON.stringify({ apiVersion: "cmb.mods/v2", entry: "main.ts" })
  },
  { path: "mods/main.ts", text: "export function register() {}" }
])
const release: TrustedReleaseInstallInput = {
  publisherId: "author-a",
  listingId: "listing-a",
  releaseId: "release-1",
  packageSha256: "a".repeat(64),
  compiledDigest: "b".repeat(64),
  sourceDigest: source.digest,
  name: "example",
  version: "1.1.0",
  description: "",
  source
}

let home: string
let root: string
let privateIndex: string
let legacyIndex: string
let olderSource: string

function installer() {
  return new TrustedReleaseInstaller({ root, index: new PluginCatalogIndex(privateIndex) })
}
function releaseDirectory() {
  return join(root, createHash("sha256").update(release.releaseId).digest("hex"))
}
function contents(path: string): string {
  return readFileSync(path, "utf8")
}
function readReceipt() {
  return JSON.parse(contents(join(releaseDirectory(), "receipt.json"))).receipt
}
function rows() {
  return JSON.parse(contents(privateIndex))
}

const legacyContent = JSON.stringify([
  {
    id: "old-example",
    name: "example",
    version: "1.0.0",
    enabled: true,
    grant: "existing"
  }
])
const current = () => {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trusted-release-install-"))
  root = join(home, "trusted-releases")
  privateIndex = join(root, "installations.json")
  legacyIndex = join(home, "plugins.json")
  olderSource = join(home, "old-example.ts")
  writeFileSync(legacyIndex, legacyContent)
  writeFileSync(olderSource, "existing source")
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("trusted release installation", () => {
  it("stores only inactive data in a private catalog and preserves existing plugin bytes", async () => {
    const foreground = installer()
    const receipt = await foreground.install(release, current)
    expect(receipt).toMatchObject({ state: "installed-inactive", sourceDigest: source.digest })
    expect(receipt).not.toHaveProperty("path")
    expect(rows()).toEqual([
      expect.objectContaining({ id: receipt.installationId, enabled: false })
    ])
    expect(contents(legacyIndex)).toBe(legacyContent)
    expect(contents(olderSource)).toBe("existing source")
    const before = contents(privateIndex)
    expect(await installer().install(release, current)).toEqual(receipt)
    expect(contents(privateIndex)).toBe(before)
  })

  it("keeps a new release in a separate source directory and rejects same-id rewrites", async () => {
    const foreground = installer()
    const original = await foreground.install(release, current)
    const next = await foreground.install({ ...release, releaseId: "release-2" }, current)
    expect(next.installationId).not.toBe(original.installationId)
    expect(new Set<string>(rows().map((row: { path: string }) => row.path)).size).toBe(2)
    for (const changed of [
      { publisherId: "author-b" },
      { listingId: "listing-b" },
      { packageSha256: "c".repeat(64) },
      { compiledDigest: "c".repeat(64) }
    ]) {
      await expect(foreground.install({ ...release, ...changed }, current)).rejects.toThrow(
        "TRUSTED_RELEASE_IDENTITY_CONFLICT"
      )
    }
    await expect(
      foreground.install({ ...release, sourceDigest: "c".repeat(64) }, current)
    ).rejects.toThrow("TRUSTED_RELEASE_SOURCE_CHANGED")
    expect(contents(legacyIndex)).toBe(legacyContent)
  })

  it("does not complete a precommit installation after the authorized scope changes", async () => {
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(current)
      .mockImplementationOnce(current)
      .mockImplementationOnce(() => {
        throw Error("ACCOUNT_CHANGED")
      })
    const foreground = installer()
    await expect(foreground.install(release, assertCurrent)).rejects.toThrow("ACCOUNT_CHANGED")
    const intended = readReceipt()
    await installer().recover()
    expect(existsSync(privateIndex)).toBe(false)
    expect(existsSync(join(releaseDirectory(), "staging"))).toBe(false)
    expect(await installer().install(release, current)).toEqual(intended)
  })

  it("rejects an altered committed payload instead of replacing it", async () => {
    await installer().install(release, current)
    const altered = join(releaseDirectory(), "source", "mods", "main.ts")
    writeFileSync(altered, "changed source")
    await expect(installer().install(release, current)).rejects.toThrow(
      "TRUSTED_RELEASE_SOURCE_CHANGED"
    )
    expect(contents(altered)).toBe("changed source")
    expect(contents(olderSource)).toBe("existing source")
  })

  it.each(["staging", "source-renamed", "index-committed"])(
    "recovers after an abrupt process exit at %s",
    async (phase) => {
      const childScript = [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'const { syncBuiltinESMExports } = require("node:module")',
        "const mkdir = fs.mkdirSync",
        "const rename = fs.renameSync",
        "const checkpoint = process.env.TRUSTED_RELEASE_TEST_CHECKPOINT",
        "fs.mkdirSync = (...args) => {",
        "  const result = mkdir(...args)",
        '  if (checkpoint === "staging" && path.basename(args[0]) === "staging") process.exit(86)',
        "  return result",
        "}",
        "fs.renameSync = (...args) => {",
        "  const result = rename(...args)",
        "  const destination = path.basename(args[1])",
        '  if (checkpoint === "source-renamed" && destination === "source") process.exit(86)',
        '  if (checkpoint === "index-committed" && destination === "installations.json") process.exit(86)',
        "  return result",
        "}",
        "syncBuiltinESMExports()",
        'const { PluginCatalogIndex } = require("./src/main/plugins/catalog-index.ts")',
        'const { TrustedReleaseInstaller } = require("./src/main/mods/devtools/trusted-release-install.ts")',
        "const root = process.env.TRUSTED_RELEASE_TEST_ROOT",
        "const installation = new TrustedReleaseInstaller({ root,",
        '  index: new PluginCatalogIndex(path.join(root, "installations.json")) })',
        "installation.install(JSON.parse(process.env.TRUSTED_RELEASE_TEST_INPUT), () => {})",
        "  .catch(error => { console.error(error); process.exitCode = 87 })"
      ].join("\n")
      const child = spawnSync(process.execPath, ["--require", "tsx/cjs", "-e", childScript], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...process.env,
          TRUSTED_RELEASE_TEST_CHECKPOINT: phase,
          TRUSTED_RELEASE_TEST_ROOT: root,
          TRUSTED_RELEASE_TEST_INPUT: JSON.stringify(release)
        }
      })
      expect(child.status, child.stderr || String(child.error ?? "")).toBe(86)
      const intended = readReceipt()
      await installer().recover()
      expect(existsSync(privateIndex)).toBe(phase === "index-committed")
      expect(existsSync(join(releaseDirectory(), "staging"))).toBe(false)
      expect(await installer().install(release, current)).toEqual(intended)
      expect(rows()).toHaveLength(1)
      expect(rows()[0].enabled).toBe(false)
      expect(contents(olderSource)).toBe("existing source")
      expect(contents(legacyIndex)).toBe(legacyContent)
    },
    30_000
  )
})
