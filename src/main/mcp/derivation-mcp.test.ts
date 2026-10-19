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
const runtime = vi.hoisted(() => ({
  connectGate: undefined as Promise<void> | undefined,
  listGate: undefined as Promise<void> | undefined,
  closeGate: undefined as Promise<void> | undefined,
  failClose: false,
  connects: 0,
  lists: 0,
  closes: 0
}))
vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    constructor(config: Record<string, unknown>) {
      clients.push(config)
    }
    async initializeConnections() {
      runtime.connects++
      await runtime.connectGate
      return undefined
    }
    getClient() {
      return {
        listTools: async () => {
          runtime.lists++
          await runtime.listGate
          return { tools: [] }
        }
      }
    }
    async close() {
      runtime.closes++
      await runtime.closeGate
      if (runtime.failClose) throw Error("SDK_CLOSE_UNCONFIRMED")
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
  closeProjectCapabilityMcpService,
  closeGlobalMcpCapabilityService
} from "./capability-service"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { collectSnapshotGarbage } from "../harness-board/project-runtime/snapshot-retention"
import { readdirSync } from "node:fs"

it("keeps a selected retained package until its MCP service physically finishes closing", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "selected-mcp-retention-"))
  const installed = join(fixture.root, "installed"),
    root = join(fixture.root, "snapshots")
  await mkdir(installed)
  await writeFile(join(installed, "source.txt"), "fixed MCP source")
  const snapshot = new RetainedPackageSnapshots(root).capture(installed)
  const token = issueRuntimePluginSourceToken({
    mode: "capabilities",
    capabilitySources: [],
    threadId: "mcp-owner",
    incarnationKey: "inc",
    projectId: "project",
    operationId: "op",
    workspace: fixture.root,
    packageDigest: snapshot.digest,
    stageId: "stage",
    plugin: { id: "p", path: snapshot.root } as PluginMetadata
  })
  const service = withRuntimePluginSource(token, () => getProjectMcpCapabilityService())
  const gate = Promise.withResolvers<void>()
  const close = vi.spyOn(service, "close").mockImplementation(async () => {
    await gate.promise
  })
  const collect = () =>
    collectSnapshotGarbage(root, () => ({
      complete: true,
      digests: new Set<string>(),
      blockers: []
    }))
  expect(collect().protected).toEqual([snapshot.digest])
  const pending = closeProjectCapabilityMcpService(token)
  try {
    expect(collect().protected).toEqual([snapshot.digest])
  } finally {
    gate.resolve()
    await pending
    close.mockRestore()
  }
  expect(collect().removed).toEqual([snapshot.digest])
})
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
  runtime.connectGate = undefined
  runtime.listGate = undefined
  runtime.closeGate = undefined
  runtime.failClose = false
  runtime.connects = runtime.lists = runtime.closes = 0
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
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
it("uses token-specific MCP connections and retains both sources' mandatory hooks", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "selected-native-mcp-"))
  const selected: import("../plugins/runtime-source-scope").RuntimeCapabilitySource[] = []
  for (const id of ["original", "copy", "unselected"]) {
    const path = join(fixture.root, id)
    await mkdir(path)
    await writeFile(
      join(path, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          required: { command: "never-executed", scope: "plugin-active" },
          extra: { command: "never-executed" }
        }
      })
    )
    const plugin = { id, name: id, path, enabled: true, mcpServerCount: 2 } as PluginMetadata
    fixture.plugins.push(plugin)
    if (id !== "unselected")
      selected.push({
        plugin,
        packageDigest: "a".repeat(64),
        capability: {
          id: "review",
          title: "Review",
          kind: "skill" as const,
          usage: "project" as const,
          entry: "skills/review/SKILL.md",
          dependsOn: [],
          requiredMcpServers: ["required"]
        }
      })
  }
  setDerivationFamilies([
    { familyId: "family", originalId: "original", members: ["original", "copy"] }
  ])
  const token = issueRuntimePluginSourceToken({
    mode: "capabilities",
    threadId: "thread",
    incarnationKey: "inc",
    projectId: "parent",
    operationId: "op",
    workspace: fixture.root,
    stageId: "independent",
    packageDigest: "a".repeat(64),
    plugin: selected[0].plugin,
    capabilitySources: selected
  })
  await withRuntimePluginSource(token, async () => {
    const service = getProjectMcpCapabilityService()
    expect(service).not.toBe(getGlobalMcpCapabilityService())
    await service.listTools()
    const serverKeys = Object.keys(clients[0].mcpServers as object)
    expect(serverKeys).toEqual(["plugin:original/required", "plugin:copy/required"])
    const hooks = selected.map(
      (source) =>
        ({
          id: `${source.plugin.id}-required`,
          pluginId: source.plugin.id,
          event: "PreToolUse",
          type: "command",
          command: "never-executed",
          enabled: true
        }) as HookConfig & { pluginId: string }
    )
    const actual = filterScopedHooks(
      { baseHooks: [], pluginHooks: hooks, skillHooks: [] },
      { harnessProjectId: "parent" } as HookContext,
      createHookScope()
    )
    expect(actual.map((hook) => hook.id)).toEqual(["original-required", "copy-required"])
  })
})

async function retainedService(transport: "http" | "stdio" = "http") {
  fixture.root = await mkdtemp(join(tmpdir(), "mcp-owned-retention-"))
  const installed = join(fixture.root, "installed"),
    root = join(fixture.root, "snapshots")
  await mkdir(installed)
  await writeFile(join(installed, "source.txt"), "fixed source")
  await writeFile(
    join(installed, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        required:
          transport === "http"
            ? { type: "http", url: "https://fixture.invalid/mcp" }
            : { command: "node", args: ["server.js"] }
      }
    })
  )
  const plugin = { id: "owned", name: "Owned", path: installed, enabled: true, mcpServerCount: 1 }
  fixture.plugins = [plugin]
  const snapshot = new RetainedPackageSnapshots(root).capture(installed)
  const token = issueRuntimePluginSourceToken({
    mode: "capabilities",
    preserveParentContext: true,
    capabilitySources: [],
    threadId: "owned",
    incarnationKey: "inc",
    projectId: "project",
    operationId: "op",
    workspace: fixture.root,
    packageDigest: snapshot.digest,
    stageId: "stage",
    plugin: { ...plugin, path: snapshot.root } as PluginMetadata
  })
  const service = withRuntimePluginSource(token, () => getProjectMcpCapabilityService())
  const collect = () =>
    collectSnapshotGarbage(root, () => ({
      complete: true,
      digests: new Set<string>(),
      blockers: []
    }))
  return { root, snapshot, token, service, collect }
}

it.each(["connect", "list"] as const)(
  "drains the actual SDK %s gate before releasing retained bytes",
  async (phase) => {
    const f = await retainedService(),
      gate = Promise.withResolvers<void>()
    if (phase === "connect") runtime.connectGate = gate.promise
    else runtime.listGate = gate.promise
    const pending = f.service.listTools().then(
      () => undefined,
      (error) => error
    )
    await vi.waitFor(() => expect(phase === "connect" ? runtime.connects : runtime.lists).toBe(1), {
      timeout: 5000
    })
    let closed = false
    const closing = closeProjectCapabilityMcpService(f.token).then(() => {
      closed = true
    })
    try {
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(f.collect().protected).toEqual([f.snapshot.digest])
      await expect(f.service.listTools()).rejects.toThrow("MODS_MCP_SERVICE_CLOSED")
      expect(runtime.connects).toBe(1)
    } finally {
      gate.resolve()
      await closing
    }
    expect(await pending).toBeInstanceOf(Error)
    expect(runtime.closes).toBe(1)
    expect(f.collect().removed).toEqual([f.snapshot.digest])
  }
)

it("keeps the lease and closes admission when SDK cleanup rejects", async () => {
  const f = await retainedService()
  await f.service.listTools()
  runtime.failClose = true
  try {
    await expect(closeProjectCapabilityMcpService(f.token)).rejects.toThrow(
      "MODS_MCP_CLEANUP_UNCONFIRMED"
    )
    expect(f.collect().protected).toEqual([f.snapshot.digest])
    await expect(f.service.listTools()).rejects.toThrow("MODS_MCP_SERVICE_CLOSED")
    expect(runtime.connects).toBe(1)
  } finally {
    runtime.failClose = false
    await closeProjectCapabilityMcpService(f.token)
  }
  expect(f.collect().removed).toEqual([f.snapshot.digest])
})

it("waits for the SDK retirement itself before releasing the selected source", async () => {
  const f = await retainedService(),
    gate = Promise.withResolvers<void>()
  await f.service.listTools()
  runtime.closeGate = gate.promise
  let closed = false
  const pending = closeProjectCapabilityMcpService(f.token).then(() => {
    closed = true
  })
  try {
    await vi.waitFor(() => expect(runtime.closes).toBe(1))
    expect(closed).toBe(false)
    expect(f.collect().protected).toEqual([f.snapshot.digest])
    await expect(f.service.listTools()).rejects.toThrow("MODS_MCP_SERVICE_CLOSED")
  } finally {
    gate.resolve()
    await pending
  }
  expect(f.collect().removed).toEqual([f.snapshot.digest])
})

it("closes registry admission while global teardown drains a blocked SDK close", async () => {
  const f = await retainedService(),
    gate = Promise.withResolvers<void>()
  await f.service.listTools()
  runtime.closeGate = gate.promise
  const pending = closeGlobalMcpCapabilityService()
  try {
    await vi.waitFor(() => expect(runtime.closes).toBe(1))
    const token = issueRuntimePluginSourceToken({
      mode: "capabilities",
      preserveParentContext: true,
      capabilitySources: [],
      threadId: "late-owner",
      incarnationKey: "inc",
      projectId: "project",
      operationId: "late-operation",
      workspace: fixture.root,
      packageDigest: f.snapshot.digest,
      stageId: "stage",
      plugin: { ...fixture.plugins[0], path: f.snapshot.root } as PluginMetadata
    })
    expect(() => withRuntimePluginSource(token, () => getProjectMcpCapabilityService())).toThrow(
      "MODS_MCP_SERVICE_CLOSED"
    )
    expect(() => getGlobalMcpCapabilityService()).toThrow("MODS_MCP_SERVICE_CLOSED")
    expect(f.collect().protected).toEqual([f.snapshot.digest])
    expect(runtime.connects).toBe(1)
  } finally {
    gate.resolve()
    await pending
  }
  await expect(f.service.listTools()).rejects.toThrow("MODS_MCP_SERVICE_CLOSED")
  expect(f.collect().removed).toEqual([f.snapshot.digest])
})

it("invalidates and retires a still-connecting candidate before it can publish stale tools", async () => {
  const f = await retainedService(),
    gate = Promise.withResolvers<void>()
  runtime.connectGate = gate.promise
  const pending = f.service.listTools().then(
    () => undefined,
    (error) => error
  )
  await vi.waitFor(() => expect(runtime.connects).toBe(1))
  let invalidated = false
  const invalidating = f.service.invalidate("fixture").then(() => {
    invalidated = true
  })
  try {
    await Promise.resolve()
    expect(invalidated).toBe(false)
    expect(f.collect().protected).toEqual([f.snapshot.digest])
  } finally {
    gate.resolve()
    await invalidating
  }
  expect(await pending).toBeInstanceOf(Error)
  expect(runtime.closes).toBe(1)
  expect(f.service.peekTools?.()).toBeNull()
  runtime.connectGate = undefined
  await f.service.listTools()
  expect(runtime.connects).toBe(2)
  await closeProjectCapabilityMcpService(f.token)
  expect(f.collect().removed).toEqual([f.snapshot.digest])
})

it("does not treat SDK stdio close as proof that its process tree exited", async () => {
  const f = await retainedService("stdio")
  await f.service.listTools()
  await closeProjectCapabilityMcpService(f.token)
  expect(f.collect().protected).toEqual([f.snapshot.digest])
  const readers = readdirSync(join(f.root, ".snapshot-retention", "readers"))
  expect(readers).toHaveLength(1)
  const lease = JSON.parse(
    readFileSync(join(f.root, ".snapshot-retention", "readers", readers[0]), "utf8")
  )
  expect(lease.boot).not.toBe("")
  expect(lease.digests).toEqual([f.snapshot.digest])
})
