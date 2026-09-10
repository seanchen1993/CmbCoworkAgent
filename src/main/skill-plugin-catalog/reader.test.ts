import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SkillMetadata } from "../types"
import {
  SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE,
  SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_SNAPSHOT_BYTES,
  type SkillPluginCatalogSourceConfig
} from "./protocol"
import {
  readSkillPluginCatalogPage,
  resolveSkillPreview,
  resetSkillPluginCatalogSnapshotsForTests
} from "./reader"
import { commitCanonicalDisabledSkillMutation } from "../skills/disabled-state-mutation"
import {
  DISABLED_SKILL_STORE_MISSING_FINGERPRINT,
  fingerprintDisabledSkillStoreText
} from "../skills/disabled-store-fingerprint"

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
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
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

  it("resolves one legacy display-name alias to every matching standalone canonical id", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-alias-reader-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    for (const id of ["canonical-a", "canonical-b"]) {
      const directory = join(source.builtinSkillsDir, id)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "SKILL.md"), "---\nname: Shared Legacy Name\n---\n")
    }
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(source.pluginsStorePath, "[]")
    writeFileSync(source.disabledSkillsPath, '["Shared Legacy Name"]')

    const disabled = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10,
      revision: "legacy-alias"
    })
    expect(disabled.disabledSkillIds).toEqual(["canonical-a", "canonical-b"])

    source.disabledSkillsRevision += 1
    writeFileSync(source.disabledSkillsPath, '["persisted-x"]')
    const persistedDirectory = join(source.customSkillsDir, "persisted-x")
    mkdirSync(persistedDirectory, { recursive: true })
    writeFileSync(join(persistedDirectory, "SKILL.md"), "---\nname: Persisted X\n---\n")
    const merged = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10,
      mergeDisabledSkillIds: ["Shared Legacy Name"],
      revision: "legacy-alias-merge"
    })
    expect(merged.disabledSkillIds).toHaveLength(3)
    expect(merged.disabledSkillIds).toEqual(
      expect.arrayContaining(["canonical-a", "canonical-b", "persisted-x"])
    )
  })

  it("keeps disabled identity scans independent from a truncated plugin store", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-disabled-plugin-isolation-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 7,
      globalRevision: 0
    }
    const skillDirectory = join(source.builtinSkillsDir, "canonical-review")
    mkdirSync(skillDirectory, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: Legacy Review\n---\n")
    writeFileSync(source.disabledSkillsPath, '["Legacy Review"]')
    writeFileSync(source.pluginsStorePath, "x".repeat(8 * 1024 * 1024 + 1))

    const disabled = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 128,
      revision: "plugin-isolation"
    })
    expect(disabled.disabledSkillIds).toEqual(["canonical-review"])
    expect(disabled.disabledSkillsRevision).toBe(7)
    expect(disabled.truncated).toBe(false)
    expect(disabled.stats.readBytes).toBeLessThan(1024)

    source.globalRevision += 1
    const skills = readSkillPluginCatalogPage(source, {
      kind: "skills",
      limit: 128,
      revision: "plugin-isolation-control"
    })
    expect(skills.truncatedReasons).toContain("plugins-store-bytes")
  })

  it.each([
    ["malformed JSON", '["review"'],
    ["non-array JSON", '{"review":true}']
  ])("fails closed for an existing %s disabled-skill store", async (_label, contents) => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-disabled-invalid-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    mkdirSync(source.builtinSkillsDir, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(source.disabledSkillsPath, contents)

    const page = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10,
      revision: "invalid-disabled-store"
    })
    expect(page.truncated).toBe(true)
    expect(page.truncatedReasons).toContain("disabled-skills-invalid")
    expect(page.disabledStoreFingerprint).toBe(
      fingerprintDisabledSkillStoreText(contents)
    )

    let commitCalled = false
    await expect(
      commitCanonicalDisabledSkillMutation(
        async (input) => readSkillPluginCatalogPage(source, input),
        () => {
          commitCalled = true
          writeFileSync(source.disabledSkillsPath, "[]")
          return []
        }
      )
    ).rejects.toThrow("disabled-skills-invalid")
    expect(commitCalled).toBe(false)
    expect(readFileSync(source.disabledSkillsPath, "utf8")).toBe(contents)
  })

  it("treats a missing disabled-skill store as an empty valid store", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-disabled-missing-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    mkdirSync(source.builtinSkillsDir, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })

    const page = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10,
      revision: "missing-disabled-store"
    })
    expect(page.disabledSkillIds).toEqual([])
    expect(page.disabledStoreFingerprint).toBe(
      DISABLED_SKILL_STORE_MISSING_FINGERPRINT
    )
    expect(page.truncated).toBe(false)
  })

  it("fails closed when the disabled-skill store path is not a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-disabled-directory-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    mkdirSync(source.builtinSkillsDir, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    mkdirSync(source.disabledSkillsPath)

    const page = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10,
      revision: "directory-disabled-store"
    })
    expect(page.truncated).toBe(true)
    expect(page.truncatedReasons).toContain("disabled-skills-invalid")
  })

  it("bounds expanded skill metadata snapshots and preserves disabled summary semantics", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-snapshot-bytes-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    mkdirSync(source.builtinSkillsDir, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(source.pluginsStorePath, "[]")
    writeFileSync(source.disabledSkillsPath, '["skill-0000"]')

    const largeDescription = "x".repeat(8_192)
    for (let index = 0; index < 520; index += 1) {
      const name = `skill-${String(index).padStart(4, "0")}`
      const directory = join(source.builtinSkillsDir, name)
      mkdirSync(directory)
      writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${largeDescription}\n---\n`
      )
    }

    const retainedSkills: SkillMetadata[] = []
    let cursor: string | null = null
    let firstPage: ReturnType<typeof readSkillPluginCatalogPage> | null = null
    do {
      const page = readSkillPluginCatalogPage(source, {
        kind: "skills",
        cursor,
        limit: SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE,
        revision: "snapshot-bytes"
      })
      firstPage ??= page
      retainedSkills.push(...page.skills)
      cursor = page.cursor
    } while (cursor)

    const disabled = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE,
      revision: "snapshot-bytes"
    })
    const retainedPayloadBytes = Buffer.byteLength(
      JSON.stringify([...retainedSkills, ...disabled.disabledSkillIds]),
      "utf-8"
    )

    expect(firstPage?.truncatedReasons).toContain("snapshot-bytes")
    expect(firstPage?.total).toBe(retainedSkills.length)
    expect(retainedSkills.length).toBeLessThan(520)
    expect(disabled.disabledSkillIds).toContain("skill-0000")
    expect(firstPage?.enabledSkillCount).toBe(retainedSkills.length - 1)
    expect(retainedPayloadBytes).toBeLessThanOrEqual(
      SKILL_PLUGIN_CATALOG_MAX_SNAPSHOT_BYTES
    )
  })

  it("prioritizes retained-skill disabled ids when the disabled projection reaches its byte cap", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-plugin-disabled-bytes-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
    }
    const skillDirectory = join(source.builtinSkillsDir, "review")
    mkdirSync(skillDirectory, { recursive: true })
    mkdirSync(source.customSkillsDir, { recursive: true })
    writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: review\n---\n")
    writeFileSync(source.pluginsStorePath, "[]")
    const unrelated = Array.from(
      { length: 18_500 },
      (_, index) => `unused-${String(index).padStart(5, "0")}-${"x".repeat(84)}`
    )
    writeFileSync(source.disabledSkillsPath, JSON.stringify([...unrelated, "review"]))

    const skills = readSkillPluginCatalogPage(source, {
      kind: "skills",
      limit: 10,
      revision: "disabled-snapshot-bytes"
    })
    const disabled = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 10,
      revision: "disabled-snapshot-bytes"
    })

    expect(skills.total).toBe(1)
    expect(skills.enabledSkillCount).toBe(0)
    expect(skills.truncatedReasons).toContain("snapshot-bytes")
    expect(disabled.disabledSkillIds[0]).toBe("review")
  })

  it("resolves the exact plugin when two plugins expose the same skill name and id", () => {
    const root = mkdtempSync(join(tmpdir(), "cmb-skill-preview-reader-"))
    temporaryDirectories.push(root)
    const source: SkillPluginCatalogSourceConfig = {
      builtinSkillsDir: join(root, "builtin"),
      customSkillsDir: join(root, "custom"),
      pluginsStorePath: join(root, "plugins.json"),
      disabledSkillsPath: join(root, "disabled-skills.json"),
      disabledSkillsRevision: 0,
      globalRevision: 0
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
