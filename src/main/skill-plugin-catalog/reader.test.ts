import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE,
  SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES,
  type SkillPluginCatalogSourceConfig
} from "./protocol"
import {
  readSkillPluginCatalogPage,
  resolveSkillPreview,
  resetSkillPluginCatalogSnapshotsForTests
} from "./reader"

const temporaryDirectories: string[] = []

afterEach(() => {
  resetSkillPluginCatalogSnapshotsForTests()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("skill/plugin catalog reader", () => {
  it("releases an old snapshot before a cache-miss scan allocates the replacement", () => {
    const source = readFileSync(new URL("./reader.ts", import.meta.url), "utf8")
    const build = source.slice(
      source.indexOf("function buildSnapshot("),
      source.indexOf("function parseCursor(")
    )

    expect(build.indexOf("reserveSnapshotSlot()"))
      .toBeLessThan(build.indexOf("const context"))
    expect(build.match(/reserveSnapshotSlot\(\)/g)).toHaveLength(1)
  })

  it("preserves custom precedence, plugin enablement and disabled ids", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-reader-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json")
    }
    const builtin = join(source.builtinSkillsDir, "review")
    const custom = join(source.customSkillsDir, "review")
    const enabledPlugin = join(root, "enabled-plugin")
    const disabledPlugin = join(root, "disabled-plugin")
    mkdirSync(builtin, { recursive: true })
    mkdirSync(custom, { recursive: true })
    mkdirSync(join(enabledPlugin, "skills", "review"), { recursive: true })
    mkdirSync(join(disabledPlugin, "skills", "hidden-skill"), { recursive: true })
    writeFileSync(join(builtin, "SKILL.md"), "---\nname: review\n---\n")
    writeFileSync(join(custom, "SKILL.md"), "---\nname: review\n---\n")
    writeFileSync(join(enabledPlugin, "plugin.json"), '{"name":"enabled","skills":"skills"}')
    writeFileSync(
      join(enabledPlugin, "skills", "review", "SKILL.md"),
      "---\nname: review\n---\n"
    )
    writeFileSync(join(disabledPlugin, "plugin.json"), '{"name":"disabled","skills":"skills"}')
    writeFileSync(
      join(disabledPlugin, "skills", "hidden-skill", "SKILL.md"),
      "---\nname: Hidden skill\n---\n"
    )
    const pluginRow = (id: string, path: string, enabled: boolean) => ({
      id,
      name: id,
      version: "1",
      description: id,
      author: "test",
      path,
      enabled,
      skillCount: 1,
      mcpServerCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })
    writeFileSync(
      source.pluginsStorePath,
      JSON.stringify([
        pluginRow("enabled", enabledPlugin, true),
        pluginRow("disabled", disabledPlugin, false)
      ])
    )
    writeFileSync(source.disabledSkillsPath, '["review"]')

    const skills = readSkillPluginCatalogPage(source, {
      kind: "skills",
      limit: 10_000,
      revision: "semantics"
    })
    const plugins = readSkillPluginCatalogPage(source, {
      kind: "plugins",
      limit: 10_000,
      revision: "semantics"
    })
    const disabled = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10_000,
      revision: "semantics"
    })

    expect(skills.skills).toHaveLength(2)
    expect(skills.skills.find((skill) => skill.id === "review")).toMatchObject({
      name: "review",
      source: "user"
    })
    expect(skills.skills.find((skill) => skill.pluginId === "enabled")).toMatchObject({
      id: "plugin:enabled/review",
      name: "review",
      pluginName: "enabled"
    })
    expect(skills.skills.some((skill) => skill.pluginId === "disabled")).toBe(false)
    expect(skills.total).toBe(2)
    expect(skills.enabledSkillCount).toBe(1)
    expect(plugins.plugins).toHaveLength(2)
    expect(plugins.stats.discoveredSkills).toBe(0)
    expect(plugins.stats.scannedDirectories).toBe(0)
    expect(disabled.disabledSkillIds).toEqual(["review"])
    expect(skills.skills.length).toBeLessThanOrEqual(SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE)
    expect(Buffer.byteLength(JSON.stringify(skills), "utf-8")).toBeLessThanOrEqual(
      SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES
    )
    expect(
      resolveSkillPreview(source, {
        id: "review",
        name: "review",
        source: "project"
      })
    ).toBeNull()
    expect(
      resolveSkillPreview(source, {
        id: "review",
        name: "review",
        source: "user"
      })
    ).toEqual({ filePath: join(custom, "SKILL.md") })
  })

  it("resolves the exact plugin when two plugins expose the same skill name and id", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-preview-reader-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json")
    }
    mkdirSync(source.builtinSkillsDir, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(source.disabledSkillsPath, "[]")
    const plugins = ["plugin-a", "plugin-b"].map((id) => {
      const pluginRoot = join(root, id)
      mkdirSync(join(pluginRoot, "skills", "shared"), { recursive: true })
      writeFileSync(join(pluginRoot, "plugin.json"), '{"name":"shared-plugin","skills":"skills"}')
      writeFileSync(
        join(pluginRoot, "skills", "shared", "SKILL.md"),
        "---\nname: Same name\n---\n"
      )
      return {
        id,
        name: id,
        version: "1",
        description: id,
        author: "test",
        path: pluginRoot,
        enabled: true,
        skillCount: 1,
        mcpServerCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    })
    writeFileSync(source.pluginsStorePath, JSON.stringify(plugins))

    expect(
      resolveSkillPreview(source, {
        id: "plugin:plugin-b/shared",
        name: "Same name",
        source: "user",
        pluginId: "plugin-b"
      })
    ).toEqual({ filePath: join(root, "plugin-b", "skills", "shared", "SKILL.md") })
    expect(
      resolveSkillPreview(source, {
        id: "plugin:plugin-a/shared",
        name: "Same name",
        source: "user",
        pluginId: "plugin-b"
      })
    ).toBeNull()
  })
})
