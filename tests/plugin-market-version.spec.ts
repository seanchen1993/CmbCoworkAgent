/**
 * Regression tests for marketplace plugin version propagation.
 *
 * Run:
 *   npx tsx tests/plugin-market-version.spec.ts
 */

import AdmZip from "adm-zip"
import { mkdir, mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { PluginMetadata } from "../src/main/types.ts"
import { exportPluginForMarketZip, resolvePluginInstallVersion } from "../src/main/ipc/plugins.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function readJsonEntry(zip: AdmZip, entryName: string): Record<string, unknown> {
  const entry = zip.getEntry(entryName)
  assert(entry, `missing zip entry ${entryName}`)
  return JSON.parse(entry!.getData().toString("utf-8")) as Record<string, unknown>
}

function createPluginMetadata(path: string, patch: Partial<PluginMetadata> = {}): PluginMetadata {
  const now = new Date().toISOString()
  return {
    id: "plugin-id",
    name: "market-plugin",
    version: "0.1.0",
    description: "plugin description",
    author: "tester",
    path,
    enabled: true,
    skillCount: 1,
    mcpServerCount: 0,
    hookCount: 0,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

async function testExportUpdatesExistingManifestVersion(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "plugin-market-version-existing-"))
  await mkdir(join(root, "skills", "alpha"), { recursive: true })
  await writeFile(join(root, "skills", "alpha", "SKILL.md"), "# Alpha\n", "utf-8")
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify(
      {
        name: "market-plugin",
        version: "0.1.0",
        description: "kept description",
        keywords: ["kept"]
      },
      null,
      2
    ),
    "utf-8"
  )

  const exported = await exportPluginForMarketZip(createPluginMetadata(root), {
    version: "v2.3.4"
  })
  const zip = new AdmZip(Buffer.from(exported.buffer))
  const manifest = readJsonEntry(zip, "plugin.json")

  assert(manifest.version === "2.3.4", "export should normalize and write market version")
  assert(manifest.description === "kept description", "export should preserve manifest fields")
  assert(Array.isArray(manifest.keywords), "export should preserve unknown compatible fields")
}

async function testExportAddsManifestWhenMissing(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "plugin-market-version-missing-"))
  await mkdir(join(root, "skills", "alpha"), { recursive: true })
  await writeFile(join(root, "skills", "alpha", "SKILL.md"), "# Alpha\n", "utf-8")

  const exported = await exportPluginForMarketZip(
    createPluginMetadata(root, {
      version: "v1.4.0",
      description: "generated manifest description"
    })
  )
  const zip = new AdmZip(Buffer.from(exported.buffer))
  const manifest = readJsonEntry(zip, ".codex-plugin/plugin.json")

  assert(manifest.name === "market-plugin", "generated manifest should include plugin name")
  assert(manifest.version === "1.4.0", "generated manifest should normalize plugin version")
  assert(
    manifest.description === "generated manifest description",
    "generated manifest should include plugin metadata"
  )
}

function testInstallVersionResolution(): void {
  assert(resolvePluginInstallVersion("0.1.0", "v9.8.7") === "9.8.7", "market version wins")
  assert(resolvePluginInstallVersion("v0.1.0") === "0.1.0", "manifest version is normalized")
  assert(resolvePluginInstallVersion(undefined, undefined) === "1.0.0", "default fallback")
}

async function main(): Promise<void> {
  await testExportUpdatesExistingManifestVersion()
  await testExportAddsManifestWhenMissing()
  testInstallVersionResolution()
  console.log("plugin-market-version.spec.ts: all assertions passed ✓")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
