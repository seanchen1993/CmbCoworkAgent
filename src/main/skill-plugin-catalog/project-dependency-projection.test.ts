import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { PluginMetadata } from "../types"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { createProjectActionBinding } from "../harness-board/project-runtime/action-input"
import { readProjectDependencyIds } from "../plugins/project-dependency-metadata"
import { groupInstalledPlugins } from "../../renderer/src/lib/installed-plugin-groups"
import { PROJECT_ACTION_LOCK_MAX_BYTES } from "../../shared/project-runtime/action-bindings"
import {
  SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_TOTAL_READ_BYTES,
  type SkillPluginCatalogSourceConfig
} from "./protocol"
import { readSkillPluginCatalogPage, resetSkillPluginCatalogSnapshotsForTests } from "./reader"

const roots: string[] = []
afterEach(() => {
  resetSkillPluginCatalogSnapshotsForTests()
  for (const root of roots.splice(0)) {
    const actual = realpathSync(root)
    expect(dirname(actual)).toBe(realpathSync(tmpdir()))
    expect(basename(actual)).toMatch(/^project-catalog-dependency-[a-zA-Z0-9]{6}$/)
    rmSync(actual, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-catalog-dependency-"))
  roots.push(root)
  const source: SkillPluginCatalogSourceConfig = {
    builtinSkillsDir: join(root, "builtin"),
    customSkillsDir: join(root, "custom"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled.json"),
    globalRevision: 0,
    disabledSkillsRevision: 0
  }
  const plugins: PluginMetadata[] = []
  const plugin = (id: string) => {
    const path = join(root, id)
    mkdirSync(path)
    const row: PluginMetadata = {
      id,
      name: id,
      path,
      version: "1.0.0",
      description: "",
      author: "fixture",
      enabled: true,
      skillCount: 0,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
    plugins.push(row)
    return row
  }
  const project = (id: string, dependencies: string[]) => {
    const row = plugin(id)
    const manifest = hostProjectFixture(row.path).manifest
    manifest.plugin = { id: row.name, version: row.version }
    const lock = {
      apiVersion: "devclaw.project-actions-lock/v1",
      bindings: dependencies.map((pluginId, index) =>
        createProjectActionBinding(
          `action-${index}`,
          {
            pluginId,
            plugin: "shared-display-name",
            digest: "a".repeat(64),
            actionId: "work",
            name: "Work",
            command: "work",
            inputSchema: { type: "object", properties: {}, additionalProperties: false }
          },
          {},
          {}
        )
      )
    }
    manifest.actions = lock.bindings.map(({ id, ref }) => ({ id, ref: { ...ref } }))
    manifest.stages[0].actionIds = manifest.actions.map(({ id }) => id)
    const save = () => {
      writeFileSync(join(row.path, "devclaw.project-runtime.json"), JSON.stringify(manifest))
      writeFileSync(join(row.path, "devclaw.project-actions.lock.json"), JSON.stringify(lock))
    }
    save()
    return { row, manifest, lock, save }
  }
  const page = (cursor?: string | null, limit = 128, cancel?: Int32Array) => {
    if (!cursor) writeFileSync(source.pluginsStorePath, JSON.stringify(plugins))
    return readSkillPluginCatalogPage(
      source,
      {
        kind: "plugins",
        cursor,
        limit,
        revision: "display-metadata"
      },
      cancel
    )
  }
  return { root, source, plugins, plugin, project, page }
}

describe("real paged plugin project dependencies", () => {
  it("preserves complete exact-ID grouping through the actual paged projection", async () => {
    const f = fixture()
    for (const id of ["rules", "knowledge", "delivery"]) f.plugin(id)
    for (let i = 0; i < 130; i += 1) f.plugin(`independent-${i}`)
    const project = f.project("report-project", ["knowledge", "delivery", "rules", "rules"])
    const first = f.page()
    expect(first.plugins).toHaveLength(128)
    expect(first.plugins.some((item) => item.id === project.row.id)).toBe(false)
    // A page without its owner must leave components visible, never hide by names.
    expect(groupInstalledPlugins(first.plugins).roots.map((item) => item.id)).toEqual(
      expect.arrayContaining(["rules", "knowledge", "delivery"])
    )
    const all = [...first.plugins]
    let cursor = first.cursor
    while (cursor) {
      const page = f.page(cursor)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES
      )
      all.push(...page.plugins)
      cursor = page.cursor
    }
    const projected = all.find((item) => item.id === project.row.id)!
    expect(projected.projectDependencyIds).toEqual(["delivery", "knowledge", "rules"])
    expect(projected.hasProjectMode).not.toBe(true) // Host metadata is not the legacy board flag.
    const grouped = groupInstalledPlugins(all)
    expect(grouped.roots).toHaveLength(131)
    expect(grouped.dependencies.get(project.row.id)?.map((item) => item.id)).toEqual([
      "delivery",
      "knowledge",
      "rules"
    ])
    expect(
      await readProjectDependencyIds(project.row, new Set(all.map((item) => item.id)))
    ).toEqual(projected.projectDependencyIds)
    expect(first.stats.scannedDirectories).toBe(0)
    expect(first.stats.discoveredSkills).toBe(0)
  })

  it("keeps shared components under both owners and independent Host projects visible", () => {
    const f = fixture()
    f.plugin("shared")
    f.plugin("same-display-name-unrelated")
    f.project("first", ["shared", "missing", "first"])
    f.project("second", ["shared", "first"])
    const rows = f.page().plugins
    const grouped = groupInstalledPlugins(rows)
    expect(grouped.roots.map((item) => item.id)).toEqual([
      "same-display-name-unrelated",
      "first",
      "second"
    ])
    expect(grouped.owners.get("shared")).toEqual(["first", "second"])
    expect(rows.find((item) => item.id === "first")?.projectDependencyIds).toEqual(["shared"])
  })

  it("marks a valid Host project with no actions and no optional lock with an empty array", () => {
    const f = fixture()
    const project = f.project("standalone-project", [])
    rmSync(join(project.row.path, "devclaw.project-actions.lock.json"))
    expect(f.page().plugins[0].projectDependencyIds).toEqual([])
  })

  it.each([
    { field: "id", value: "different-package" },
    { field: "version", value: "2.0.0" }
  ] as const)("rejects a self-consistent package with a mismatched $field", ({ field, value }) => {
    const f = fixture()
    f.plugin("component")
    const project = f.project("project", ["component"])
    expect(project.manifest.plugin).toEqual({ id: project.row.name, version: project.row.version })
    project.manifest.plugin[field] = value
    project.save()
    const page = f.page()
    const owner = page.plugins.find((item) => item.id === project.row.id)!
    expect(owner.name).toBe("project")
    expect(owner.version).toBe("1.0.0")
    expect(owner.projectDependencyIds).toBeUndefined()
    expect(groupInstalledPlugins(page.plugins).roots.map((item) => item.id)).toEqual([
      "component",
      "project"
    ])
    // Store + absent component manifest + mismatched owner manifest; its lock is never read.
    expect(page.stats.scannedFiles).toBe(3)
  })

  it.each([
    "missing-lock",
    "invalid-lock",
    "mismatched-lock",
    "invalid-input",
    "invalid-runtime",
    "legacy"
  ])("keeps invalid/incomplete metadata visible: %s", (failure) => {
    const f = fixture()
    f.plugin("component")
    const project = f.project("project", ["component"])
    const lockPath = join(project.row.path, "devclaw.project-actions.lock.json")
    const manifestPath = join(project.row.path, "devclaw.project-runtime.json")
    if (failure === "missing-lock") rmSync(lockPath)
    if (failure === "invalid-lock") writeFileSync(lockPath, "{")
    if (failure === "mismatched-lock") {
      project.lock.bindings[0].ref.pluginId = "missing"
      project.save()
    }
    if (failure === "invalid-input") {
      project.lock.bindings[0].input = { unapproved: true }
      project.save()
    }
    if (failure === "invalid-runtime") writeFileSync(manifestPath, "{}")
    if (failure === "legacy") {
      project.manifest.mode = "legacy"
      project.manifest.stateOwner = "plugin"
      project.save()
    }
    const rows = f.page().plugins
    expect(rows.find((item) => item.id === "project")?.projectDependencyIds).toBeUndefined()
    expect(groupInstalledPlugins(rows).roots.map((item) => item.id)).toEqual([
      "component",
      "project"
    ])
  })

  it("rejects oversized declarations without dropping ordinary plugin rows", () => {
    const f = fixture()
    f.plugin("component")
    const project = f.project("project", ["component"])
    truncateSync(
      join(project.row.path, "devclaw.project-actions.lock.json"),
      PROJECT_ACTION_LOCK_MAX_BYTES + 1
    )
    const page = f.page()
    expect(page.plugins.find((item) => item.id === "project")?.projectDependencyIds).toBeUndefined()
    expect(page.truncatedReasons).toContain("project-metadata-file-bytes")
    expect(page.stats.readBytes).toBeLessThanOrEqual(SKILL_PLUGIN_CATALOG_MAX_TOTAL_READ_BYTES)
    expect(page.plugins).toHaveLength(2)
  })

  it("bounds failed-read reservations across many invalid project locks", () => {
    const f = fixture()
    for (let i = 0; i < 530; i += 1) {
      const project = f.project(`project-${i}`, ["missing-provider"])
      // Only file length is enlarged; these locks are rejected before reading their contents.
      truncateSync(
        join(project.row.path, "devclaw.project-actions.lock.json"),
        PROJECT_ACTION_LOCK_MAX_BYTES + 1
      )
    }
    const page = f.page()
    expect(page.stats.readBytes).toBeLessThanOrEqual(SKILL_PLUGIN_CATALOG_MAX_TOTAL_READ_BYTES)
    expect(page.truncatedReasons).toContain("total-read-bytes")
    expect(page.plugins.every((item) => item.projectDependencyIds === undefined)).toBe(true)
    expect(page.total).toBe(530)
  }, 20_000)

  it("preserves cancellation instead of converting it into absent metadata", () => {
    const f = fixture()
    f.project("project", [])
    const cancel = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(cancel, 0, 1)
    expect(() => f.page(undefined, 128, cancel)).toThrow("superseded")
  })
})
