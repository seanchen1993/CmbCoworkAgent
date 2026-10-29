import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  readInstalledPluginFlowDefinition,
  readPluginFlowDefinition
} from "./plugin-flow-definition"

const roots: string[] = []
const manifest = async () =>
  JSON.parse(
    await readFile(resolve("examples/project-docs-lite/devclaw.project-runtime.json"), "utf8")
  )
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "installed-flow-"))
  roots.push(path)
  return {
    id: "installed",
    name: "project-docs-lite",
    version: "0.2.0",
    path,
    enabled: false,
    updatedAt: "one"
  }
}
async function legacy(path: string, workflow: unknown) {
  await mkdir(join(path, "board_core"), { recursive: true })
  await writeFile(join(path, "board_core/board_config.json"), JSON.stringify({ workflow }))
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("installed plugin flow definitions", () => {
  it("reads the current native package while disabled, without a project or session", async () => {
    const plugin = await fixture()
    await writeFile(
      join(plugin.path, "devclaw.project-runtime.json"),
      JSON.stringify(await manifest())
    )
    const definition = await readInstalledPluginFlowDefinition(
      { pluginId: plugin.id, expected: { name: plugin.name, version: plugin.version } },
      () => [plugin],
      () => {}
    )
    expect(definition).toMatchObject({
      status: "ready",
      format: "native",
      source: { pluginId: plugin.id, version: "0.2.0", enabled: false },
      templates: [{ nodeIds: ["draft", "review"] }],
      nodes: [
        { id: "draft", outputs: ["draft.md"] },
        { id: "review", approval: "human" }
      ]
    })
    expect(definition.nodes[1].checks).toContain("review-schema · json-schema · read")
    expect(definition.declarationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(plugin.enabled).toBe(false)
    expect(definition).not.toHaveProperty("project")
    expect(definition).not.toHaveProperty("available")
  })

  it("reads real legacy templates, nodes and optional stages without compiling a route", async () => {
    const plugin = await fixture()
    const runtime = { ...(await manifest()), mode: "legacy", stateOwner: "plugin", stages: [] }
    await writeFile(join(plugin.path, "devclaw.project-runtime.json"), JSON.stringify(runtime))
    await legacy(plugin.path, {
      templates: {
        fixed: { kind: "nodeSubset", nodes: ["draft"] },
        standard: { kind: "profile", label: "Original profile" },
        custom: { kind: "custom", requiredNodes: ["draft"] }
      },
      nodes: [
        {
          id: "draft",
          label: "Package draft",
          skill: "original-skill",
          checkpoints: ["draft_done"],
          artifacts: { inputs: [{ path: "input.md" }], outputs: [{ path: "actual.md" }] }
        }
      ],
      dynamicStages: [
        {
          id: "extra",
          label: "Optional review",
          insertAfter: "draft",
          nodes: [{ id: "review", label: "Package review" }]
        }
      ]
    })
    const definition = await readPluginFlowDefinition(plugin)
    expect(definition).toMatchObject({
      status: "ready",
      format: "legacy",
      declarationPath: "board_core/board_config.json",
      nodes: [
        { id: "draft", inputs: ["input.md"], outputs: ["actual.md"], checks: ["draft_done"] },
        { id: "review", optional: { title: "Optional review", insertAfter: "draft" } }
      ]
    })
    expect(definition.templates[0].nodeIds).toEqual(["draft"])
    expect(definition.templates[1]).not.toHaveProperty("nodeIds")
    expect(definition.templates[2].requiredNodeIds).toEqual(["draft"])
    expect(definition.diagnostics.join()).toContain("未在静态配置中列出固定步骤序列")
  })

  it("also reads older declared templates without the native runtime file", async () => {
    const plugin = await fixture()
    await legacy(plugin.path, {
      templates: { original: { nodes: ["original"] } },
      nodes: [{ id: "original", label: "Actual old node" }]
    })
    expect(await readPluginFlowDefinition(plugin)).toMatchObject({
      status: "ready",
      format: "legacy",
      nodes: [{ id: "original", title: "Actual old node" }]
    })
  })

  it("reports absent declarations without inventing stages from unrelated configuration", async () => {
    const plugin = await fixture()
    expect(await readPluginFlowDefinition(plugin)).toMatchObject({
      status: "undeclared",
      nodes: []
    })
    await legacy(plugin.path, { nodes: "business-reference-only" })
    expect(await readPluginFlowDefinition(plugin)).toMatchObject({
      status: "undeclared",
      nodes: []
    })
  })

  it("reports invalid references and read failures instead of an empty successful flow", async () => {
    const plugin = await fixture()
    await legacy(plugin.path, { templates: { invalid: { nodes: ["missing"] } }, nodes: [] })
    const invalid = await readPluginFlowDefinition(plugin)
    expect(invalid.status).toBe("invalid")
    expect(invalid.diagnostics.join()).toContain("PLUGIN_FLOW_NODE_REFERENCE_INVALID")
    await rm(plugin.path, { recursive: true })
    const unreadable = await readPluginFlowDefinition(plugin)
    expect(unreadable).toMatchObject({ status: "invalid", nodes: [] })
    expect(JSON.stringify(unreadable)).not.toContain(plugin.path)
  })

  it("never returns configuration values, commands or private absolute artifact paths", async () => {
    const plugin = await fixture()
    await legacy(plugin.path, {
      templates: {},
      nodes: [{ id: "node", artifacts: { outputs: [{ path: "C:/private/secret.md" }] } }],
      environment: { secret: "private-config-value" },
      inspectCommands: { command: "private-command" }
    })
    const definition = await readPluginFlowDefinition(plugin)
    expect(definition.status).toBe("invalid")
    const serialized = JSON.stringify(definition)
    for (const secret of ["C:/private", "private-config-value", "private-command", plugin.path])
      expect(serialized).not.toContain(secret)
  })

  it("does not hide a broken native declaration behind a legacy fallback", async () => {
    const plugin = await fixture()
    await writeFile(join(plugin.path, "devclaw.project-runtime.json"), "{broken")
    await legacy(plugin.path, { templates: {}, nodes: [{ id: "old" }] })
    expect(await readPluginFlowDefinition(plugin)).toMatchObject({
      status: "invalid",
      declarationPath: "devclaw.project-runtime.json",
      nodes: []
    })
  })

  it("rejects uninstall, update and scope changes while a read is pending", async () => {
    for (const mutation of ["remove", "version", "account"] as const) {
      const plugin = await fixture()
      let installed = [plugin]
      let active = true
      const read = vi.fn(async () => {
        if (mutation === "remove") installed = []
        if (mutation === "version") plugin.version = "0.3.0"
        if (mutation === "account") active = false
        return { source: {}, status: "ready", templates: [], nodes: [], diagnostics: [] } as never
      })
      await expect(
        readInstalledPluginFlowDefinition(
          { pluginId: plugin.id, expected: { name: plugin.name, version: plugin.version } },
          () => installed,
          () => {
            if (!active) throw Error("account changed")
          },
          read
        )
      ).rejects.toThrow()
      expect(read).toHaveBeenCalledTimes(1)
    }
  })

  it("rejects a stale version before reading package files", async () => {
    const plugin = await fixture()
    const read = vi.fn()
    await expect(
      readInstalledPluginFlowDefinition(
        { pluginId: plugin.id, expected: { name: plugin.name, version: "old" } },
        () => [plugin],
        () => {},
        read
      )
    ).rejects.toThrow("版本已变化")
    expect(read).not.toHaveBeenCalled()
  })
})
