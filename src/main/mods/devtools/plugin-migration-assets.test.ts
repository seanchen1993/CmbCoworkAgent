import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginMetadata } from "../../types"
import { listMigrationAssets, readMigrationAsset } from "./plugin-migration-assets"
import { pluginMigrationReport } from "./plugin-migration-report"

const owned: string[] = []
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-migration-test-"))
  owned.push(root)
  await mkdir(join(root, "scripts"))
  await mkdir(join(root, "skills", "demo"), { recursive: true })
  await writeFile(
    join(root, "scripts", "format.ts"),
    "export const format = (value: string) => value.trim()\n"
  )
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "# Demonstration\n")
  await writeFile(join(root, ".mcp.json"), "not a credential; should not be read")
  await writeFile(join(root, "scripts", "secret.ts"), "excluded")
  const plugin: PluginMetadata = {
    id: "original",
    name: "Original",
    version: "1.0",
    description: "",
    author: "",
    path: root,
    enabled: true,
    skillCount: 1,
    mcpServerCount: 1,
    createdAt: "",
    updatedAt: ""
  }
  return { root, plugins: [plugin] }
}
describe("plugin migration input", () => {
  it("preserves the original package and reports reuse without claiming conversion", async () => {
    const f = await fixture()
    expect(pluginMigrationReport(f.plugins, "original")[0].migration).toMatchObject({
      automaticConversion: false,
      skills: "reuse-original-skill-source",
      mcp: "reuse-original-configured-server"
    })
    expect((await listMigrationAssets(f.plugins, "original")).files).toEqual([
      "scripts/format.ts",
      "skills/demo/SKILL.md"
    ])
    const result = await readMigrationAsset(f.plugins, "original", "scripts/format.ts")
    expect(result).toMatchObject({ untrustedSource: true, originalPreserved: true })
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(join(f.root, "scripts", "format.ts"), "utf8")).toBe(result.text)
  })
  it("rejects traversal, settings and secret-labelled assets", async () => {
    const f = await fixture()
    for (const path of [
      "../scripts/format.ts",
      ".mcp.json",
      "scripts/secret.ts",
      "scripts/../format.ts"
    ])
      await expect(readMigrationAsset(f.plugins, "original", path)).rejects.toThrow()
  })
  it("does not follow a junction outside the selected package", async () => {
    const f = await fixture()
    const other = await mkdtemp(join(tmpdir(), "cmb-migration-test-"))
    owned.push(other)
    await writeFile(join(other, "external.ts"), "outside")
    await symlink(other, join(f.root, "scripts", "linked"), "junction")
    expect((await listMigrationAssets(f.plugins, "original")).files).not.toContain(
      "scripts/linked/external.ts"
    )
    await expect(
      readMigrationAsset(f.plugins, "original", "scripts/linked/external.ts")
    ).rejects.toThrow()
  })
  it("does not read an internal junction alias into excluded source", async () => {
    const f = await fixture()
    await mkdir(join(f.root, ".private"))
    await writeFile(join(f.root, ".private", "configuration.ts"), "excluded fixture")
    await symlink(join(f.root, ".private"), join(f.root, "scripts", "alias"), "junction")
    await expect(
      readMigrationAsset(f.plugins, "original", "scripts/alias/configuration.ts")
    ).rejects.toThrow("DEVELOPMENT_ASSET_PATH")
  })
})
