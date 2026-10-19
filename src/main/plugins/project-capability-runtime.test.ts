import { SkillLifecycleRegistry } from "../agent/skill-lifecycle/registry"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
vi.mock("../storage", () => ({ parsePluginHooks: () => [], parseMcpJsonFile: () => null }))
import { ProjectCapabilityRuntimeService } from "./project-capability-runtime"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import {
  currentRuntimeCapabilitySources,
  projectRuntimePluginSources,
  runtimeCapabilitySkillSources,
  runtimeCapabilityAllowsMcp,
  withRuntimePluginSource,
  issueRuntimePluginSourceToken,
  captureRuntimePluginSourceThreadGuard
} from "./runtime-source-scope"
import type { PluginMetadata } from "../types"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function fixture(requirements: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "native-capability-"))
  roots.push(root)
  const plugins = ["first", "second"].map((id) => {
    const path = join(root, id)
    mkdirSync(join(path, "skills", "review"), { recursive: true })
    writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: id, version: "1" }))
    writeFileSync(
      join(path, "skills", "review", "SKILL.md"),
      "# Real skill\nUse the packaged script."
    )
    writeFileSync(join(path, "skills", "review", "tool.py"), "print('retained')")
    writeFileSync(
      join(path, "devclaw.capabilities.json"),
      JSON.stringify({
        apiVersion: "devclaw.capabilities/v1",
        capabilities: [
          {
            id: "review",
            title: "Review",
            kind: "skill",
            usage: "project",
            entry: "skills/review/SKILL.md",
            ...requirements
          }
        ]
      })
    )
    return {
      id,
      name: id,
      version: "1",
      enabled: true,
      path,
      description: "",
      author: "",
      skillCount: 1,
      mcpServerCount: 0,
      hookCount: 0,
      createdAt: "",
      updatedAt: ""
    } satisfies PluginMetadata
  })
  const refs = await Promise.all(
    plugins.map(async (plugin) => ({
      pluginId: plugin.id,
      capabilityId: "review",
      packageDigest: (await readNativeCapabilityCatalog(plugin, "project")).packageDigest!
    }))
  )
  let live = true
  const service = new ProjectCapabilityRuntimeService(join(root, "retained"), {
    getPlugin: (id) => plugins.find((plugin) => plugin.id === id),
    assertCurrent: () => {
      if (!live) throw Error("expired")
    }
  })
  return {
    root,
    plugins,
    refs,
    service,
    revoke: () => {
      live = false
    }
  }
}

describe("native capability admission and retained runtime scope", () => {
  it("retains complete real packages and projects exactly both selected sources", async () => {
    const f = await fixture()
    const sources = await f.service.admit(f.refs)
    expect(sources[0].plugin.path).not.toBe(f.plugins[0].path)
    const token = f.service.issue(
      {
        threadId: "parent",
        incarnationKey: "inc",
        projectId: "project",
        workspace: f.root,
        operationId: "turn",
        sources
      },
      () => {}
    )
    withRuntimePluginSource(token, () => {
      expect(
        projectRuntimePluginSources([...f.plugins, { ...f.plugins[0], id: "unselected" }]).map(
          (p) => p.id
        )
      ).toEqual(["first", "second"])
      expect(runtimeCapabilitySkillSources()).toHaveLength(2)
      const registry = new SkillLifecycleRegistry(runtimeCapabilitySkillSources()!)
      for (const source of sources) {
        const path = join(source.plugin.path, source.capability.entry)
        expect(registry.resolveExplicit({ skillPath: path })?.pluginId).toBe(source.plugin.id)
        expect(registry.resolveRead(join(source.plugin.path, "skills/review/tool.py"))?.pluginId).toBe(source.plugin.id)
      }
      expect(registry.resolveExplicit({ skillPath: join(f.plugins[0].path, "skills/review/SKILL.md") })).toBeNull()
      expect(runtimeCapabilityAllowsMcp("first", "undeclared")).toBe(false)
      expect(() => captureRuntimePluginSourceThreadGuard("forged", f.root)).toThrow(
        "ADMISSION_REQUIRED"
      )
      expect(Object.isFrozen(currentRuntimeCapabilitySources()![0].capability)).toBe(true)
    })
    expect(currentRuntimeCapabilitySources()).toBeUndefined()
    f.revoke()
    expect(() => withRuntimePluginSource(token, () => {})).toThrow("expired")
  })
  it("keeps original legacy identity and mandatory guards when adding independent sources", async () => {
    const f = await fixture()
    const sources = await f.service.admit(f.refs)
    let legacy = true
    const original = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: "parent",
        incarnationKey: "inc",
        projectId: "project",
        workspace: f.root,
        operationId: "op",
        stageId: "review",
        packageDigest: "a".repeat(64),
        plugin: { ...f.plugins[0], id: "original" }
      },
      () => {
        if (!legacy) throw Error("original-check")
      }
    )
    const token = f.service.issue(
      {
        threadId: "parent",
        incarnationKey: "inc",
        projectId: "project",
        workspace: f.root,
        operationId: "op",
        sources
      },
      () => {},
      original
    )
    withRuntimePluginSource(token, () =>
      expect(projectRuntimePluginSources([]).map((p) => p.id)).toEqual([
        "original",
        "first",
        "second"
      ])
    )
    legacy = false
    expect(() => withRuntimePluginSource(token, () => {})).toThrow("original-check")
  })
  it("refuses required tools, missing hooks, changed sources and legacy dynamic stage context", async () => {
    const mcp = await fixture({ requiredMcpServers: ["missing"] })
    await expect(mcp.service.validate(mcp.refs)).rejects.toThrow("REQUIRED_MCP_MISSING")
    const hooks = await fixture({ requiredHooks: ["missing"] })
    await expect(hooks.service.validate(hooks.refs)).rejects.toThrow("REQUIRED_HOOK_MISSING")
    const changed = await fixture()
    writeFileSync(join(changed.plugins[0].path, "skills/review/SKILL.md"), "changed")
    await expect(changed.service.validate(changed.refs)).rejects.toThrow("SOURCE_CHANGED")
    const legacy = await fixture()
    mkdirSync(join(legacy.plugins[0].path, "board_core"))
    writeFileSync(join(legacy.plugins[0].path, "board_core/board_config.json"), "{}")
    legacy.refs[0].packageDigest = (
      await readNativeCapabilityCatalog(legacy.plugins[0], "project")
    ).packageDigest!
    await expect(legacy.service.validate(legacy.refs)).rejects.toThrow("LEGACY_CONTEXT_REQUIRED")
  })
  it("does not mistake an explicit Host's unrelated board resource for legacy standalone context", async () => {
    const f = await fixture()
    const plugin = f.plugins[0]
    const manifest = hostProjectFixture(f.root).manifest
    manifest.plugin = { id: plugin.name, version: plugin.version }
    // This standalone Skill is not a phase Skill of the separately declared Host project.
    manifest.stages = manifest.stages.filter((stage) => stage.id === "draft")
    mkdirSync(join(plugin.path, "skills/draft"), { recursive: true })
    writeFileSync(join(plugin.path, "skills/draft/SKILL.md"), "Independent Host phase")
    writeFileSync(join(plugin.path, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    mkdirSync(join(plugin.path, "board_core"))
    writeFileSync(join(plugin.path, "board_core/board_config.json"), JSON.stringify({
      workflow: "Unrelated business data, not an AutoBiz workflow"
    }))
    const catalog = await readNativeCapabilityCatalog(plugin, "project")
    expect(catalog.status).toBe("declared")
    f.refs[0].packageDigest = catalog.packageDigest!
    await expect(f.service.validate(f.refs)).resolves.toHaveLength(2)
  })
})
