import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
const fixture = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{
    id: string
    name: string
    path: string
    enabled: boolean
    mcpServerCount: number
  }>
}))
const clients = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    constructor(config: Record<string, unknown>) {
      clients.push(config)
    }
    async initializeConnections() {
      return undefined
    }
    getClient() {
      return { listTools: async () => ({ tools: [] }) }
    }
    async close() {
      return undefined
    }
  }
}))
vi.mock("../storage", () => ({
  getEnabledMcpConnectors: () => [],
  getPlugins: () => fixture.plugins,
  getUserInfo: () => ({}),
  getOpenworkDir: () => fixture.root,
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => [],
  getEnabledHooks: () => [],
  getEnabledPluginSkillSourceMetadata: () => [],
  parseMcpJsonFile: (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers
}))
vi.mock("../mods/manager", () => ({
  getModsManager: () => null,
  authorizeCurrentModInput: async () => {}
}))
import {
  getGlobalMcpCapabilityService,
  getProjectMcpCapabilityService,
  closeGlobalMcpCapabilityService
} from "./capability-service"
import { setDerivationFamilies, observeDerivationInstallation } from "../plugins/derivation-scope"
import { PluginDerivationService } from "../plugins/derivation-service"
import { createHookScope, filterScopedHooks } from "../hooks/scope"
import type { HookConfig } from "../hooks/types"
import type { HookContext } from "../hooks/runner"
import type { PluginMetadata } from "../types"

afterEach(async () => {
  await closeGlobalMcpCapabilityService()
  setDerivationFamilies([])
  fixture.plugins = []
  clients.length = 0
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
})
it("excludes a late original's persistent Hooks and MCP from its directory-derived project", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "derivation-late-mcp-"))
  const source = join(fixture.root, "source")
  await mkdir(source)
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({ name: "original", version: "1.0.0" })
  )
  await writeFile(
    join(source, ".mcp.json"),
    JSON.stringify({ mcpServers: { business: { command: "never-executed" } } })
  )
  const service = new PluginDerivationService(join(fixture.root, "copies"), {
    plugins: () => fixture.plugins as PluginMetadata[],
    invalidate: () => {},
    install: async (directory, name, id, guard, verify) => {
      const path = join(fixture.root, id)
      await cp(directory, path, { recursive: true })
      await verify(path)
      guard()
      fixture.plugins.push({ id, name, path, enabled: true, mcpServerCount: 1 })
      return { success: true }
    }
  })
  const inspection = await service.inspect(source, "workspace", () => {})
  const copy = await service.create(
    "workspace",
    inspection.inspectionId,
    "copy",
    randomUUID(),
    () => {}
  )
  const checked = await service.check("workspace", copy.copyId, () => {})
  const installed = await service.install("workspace", copy.copyId, checked.digest, () => {})
  await observeDerivationInstallation("late-original", source, "original")
  fixture.plugins.push({
    id: "late-original",
    name: "original",
    path: source,
    enabled: true,
    mcpServerCount: 1
  })
  const hooks = ["late-original", installed.pluginId!].map(
    (pluginId) =>
      ({
        id: pluginId,
        pluginId,
        event: "SessionEnd",
        type: "command",
        command: "never-executed",
        enabled: true,
        persistAfterInterrupt: true,
        createdAt: "",
        updatedAt: ""
      }) as HookConfig & { pluginId: string }
  )
  const scope = createHookScope()
  hooks.forEach((hook) => scope.activatePlugin(hook.pluginId))
  scope.activatePersistentHooks(hooks)
  expect(
    filterScopedHooks(
      { baseHooks: [], pluginHooks: hooks, skillHooks: [] },
      { harnessProjectId: "project", harnessAdapterId: installed.pluginId } as HookContext,
      scope
    ).map((hook) => hook.id)
  ).toEqual([installed.pluginId])
  await getProjectMcpCapabilityService(installed.pluginId!).listTools()
  expect(JSON.stringify(clients)).toContain(`plugin:${installed.pluginId}/business`)
  expect(JSON.stringify(clients)).not.toContain("late-original")
})
it("does not expose or connect unbound copies and selects only the bound family member", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "derivation-mcp-"))
  setDerivationFamilies([
    { familyId: "family", originalId: "original", members: ["original", "copy", "sibling"] }
  ])
  for (const id of ["original", "copy", "sibling"]) {
    const path = join(fixture.root, id)
    await mkdir(path)
    await writeFile(
      join(path, ".mcp.json"),
      JSON.stringify({
        mcpServers: { [id]: { command: "fixture-never-executed" } }
      })
    )
    fixture.plugins.push({ id, name: id, path, enabled: true, mcpServerCount: 1 })
  }
  const global = getGlobalMcpCapabilityService()
  expect(global.configuredServerNames?.()).toEqual(["original"])
  const project = getProjectMcpCapabilityService("copy")
  expect(project.configuredServerNames?.()).toEqual(["copy"])
  expect(getProjectMcpCapabilityService("original")).toBe(global)
  expect(clients).toHaveLength(0)
  await global.listTools()
  await project.listTools()
  expect(JSON.stringify(clients)).not.toContain("sibling")
  expect(clients).toHaveLength(2)
})
