import { getModCallContext, modCallContext } from "../context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModGuestRuntime } from "../guest-runtime"
import type { ModHostCall } from "../guest-runtime"
import type { ModObject } from "../../../shared/mods/types"

const fixtureState = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{
    id: string
    name: string
    path: string
    enabled: boolean
    mcpServerCount: number
  }>
}))
vi.mock("../../storage", async (original) => ({
  ...(await original<typeof import("../../storage")>()),
  getEnabledMcpConnectors: () => [],
  getPlugins: () => fixtureState.plugins,
  getUserInfo: () => ({}),
  getOpenworkDir: () => fixtureState.root,
  getEnabledHooks: () => [],
  getLspConfig: () => ({ enabled: false }),
  isThreadMemoryEnabled: () => false,
  isCodeExecEnabled: () => false,
  parseMcpJsonFile: (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers
}))
vi.mock("../../agent/agent-registry", async original => ({
  ...(await original<typeof import("../../agent/agent-registry")>()),
  loadAgentProfilesAsync: async () => []
}))
vi.mock("../../code-exec/saved-tool-store", async original => ({
  ...(await original<typeof import("../../code-exec/saved-tool-store")>()),
  listSavedCodeExecTools: () => []
}))
vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn(async () => null) }))
vi.mock("../../mcp/tool-example-store", () => ({ recordSuccessfulToolExample: () => {} }))
vi.mock("../../browser/cdp/playwright-mcp-bridge", () => ({
  autoSelectPlaywrightInAppBrowserTab: ({ tool }: { tool: { toolName: string } }) => {
    if (tool.toolName !== "echo") throw Error("Unexpected browser helper")
  },
  invokeMcpToolWithPlaywrightInAppBrowserSupport: ({ tool, invoke }: { tool: { toolName: string }; invoke(): Promise<unknown> }) => {
    if (tool.toolName !== "echo") throw Error("Unexpected browser reroute")
    return invoke()
  }
}))
vi.mock("../runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const guest = await ModGuestRuntime.create(code)
      this.guests.set(id, guest)
      return guest.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      return this.guests.get(id)!.invoke(handler, event, call)
    }
    async unload(id: string) {
      this.guests.get(id)?.dispose()
      this.guests.delete(id)
    }
    stop() {
      for (const guest of this.guests.values()) guest.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))

import { ModsManager, setModsManager } from "../manager"
import { readClawMcpSources } from "../claw-mcp"
import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService,
  getProjectMcpCapabilityService,
  closeProjectCapabilityMcpService
} from "../../mcp/capability-service"
import {
  issueRuntimePluginSourceToken, withRuntimePluginSource,
  type RuntimePluginSourceToken
} from "../../plugins/runtime-source-scope"
import { withFunctionMcpCommand } from "../v2/mcp-command"
import { withFunctionExecution } from "../v2/execution-context"
import { listNativeMcpTools, nativeMcpSchemaDigest, prepareNativeMcpStep } from "./native-mcp"
import { runHooksEnriched } from "../../hooks/required-skill"
import type { McpCapabilityTool } from "../../mcp/capability-types"
import { DEFAULT_MOD_POLICY } from "../policy"

let manager: ModsManager | undefined
const sourceTokens: RuntimePluginSourceToken[] = []
afterEach(async () => {
  releaseLocalThreadRunLease("flow-thread", "mods", "flow-run")
  for (const token of sourceTokens.splice(0)) await closeProjectCapabilityMcpService(token)
  await closeGlobalMcpCapabilityService()
  setModsManager(undefined)
  manager?.close()
  manager = undefined
  fixtureState.plugins = []
  vi.mocked(runHooksEnriched).mockReset().mockResolvedValue(null)
  if (fixtureState.root) {
    if (
      dirname(resolve(fixtureState.root)) !== resolve(tmpdir()) ||
      !basename(fixtureState.root).startsWith("native-flow-mcp-")
    )
      throw Error("Unexpected fixture cleanup path")
    await rm(fixtureState.root, { recursive: true, force: true })
  }
  fixtureState.root = ""
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-flow-mcp-"))
  fixtureState.root = root
  const journal = join(root, "journal.jsonl")
  fixtureState.plugins = [
    { id: "fixture", name: "Fixture", path: root, enabled: true, mcpServerCount: 2 }
  ]
  const config = (provider: string) => ({
    command: process.execPath,
    args: [resolve("tests/support/native-flow-mcp-server.mjs"), journal, provider]
  })
  const configPath = join(root, ".mcp.json")
  await writeFile(configPath, JSON.stringify({ mcpServers: { a: config("a"), b: config("b") } }))
  const confirm = vi.fn(async () => true)
  manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    confirm,
    () => {},
    undefined,
    DEFAULT_MOD_POLICY,
    () => true
  )
  setModsManager(manager)
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const grant = manager.store.grant(workspace, "function:flow-owner", "owner-digest", true)
  const scope = {
    workspace,
    threadId: "flow-thread",
    turnId: "flow-run",
    leased: true,
    immediate: false,
    userInitiated: true
  }
  const controller = new AbortController()
  const sources = readClawMcpSources()
  const selection = { mode: "selected" as const, items: [sources[0]] }
  const catalog = () => listNativeMcpTools(selection)
  const prepare = async () => {
    const [descriptor] = await catalog()
    return prepareNativeMcpStep({
      ...descriptor,
      manager: manager!,
      ...scope,
      selection,
      signal: controller.signal,
      assertLive: () => controller.signal.throwIfAborted(),
      withOwnerGrant: async (run) => {
        manager!.store.assertGrant(grant)
        return run(grant)
      }
    })
  }
  const records = () =>
    existsSync(journal)
      ? readFileSync(journal, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
  const call = async (text = "hello") => {
    const prepared = await prepare()
    return withFunctionExecution(scope, () => prepared.invoke({ tool: text }))
  }
  return {
    workspace,
    scope,
    controller,
    grant,
    confirm,
    sources,
    selection,
    catalog,
    prepare,
    call,
    records,
    journal,
    configPath
  }
}

it.each(["flow", "cold-command"] as const)("uses only the exact retained parent's real stdio peer for %s and leaves global peers independent", async route => {
  const f = await fixture()
  const foreignRoot = join(f.workspace, "unselected-plugin")
  await mkdir(foreignRoot)
  await writeFile(join(foreignRoot, ".mcp.json"), JSON.stringify({ mcpServers: {
    c: { command: process.execPath, args: [resolve("tests/support/native-flow-mcp-server.mjs"), f.journal, "unselected-plugin"] }
  } }))
  fixtureState.plugins.push({ id: "unselected", name: "Unselected", path: foreignRoot, enabled: true, mcpServerCount: 1 })
  const global = getGlobalMcpCapabilityService()
  const globalTools = await global.listTools()
  const foreign = globalTools.find(tool => tool.providerKey === "plugin:unselected/c")!
  const foreignSource = readClawMcpSources().find(source => source.id === foreign.providerKey)!
  expect(foreign).toBeDefined()
  const snapshot = join(f.workspace, "retained-parent")
  await mkdir(snapshot)
  await writeFile(join(snapshot, ".mcp.json"), JSON.stringify({ mcpServers: {
    a: { command: process.execPath, args: [resolve("tests/support/native-flow-mcp-server.mjs"), f.journal, "retained-a"] }
  } }))
  let current = true
  const token = issueRuntimePluginSourceToken({
    mode: "legacy", threadId: f.scope.threadId, incarnationKey: "exact-parent",
    projectId: "retained-project", operationId: "retained-operation", workspace: f.workspace,
    packageDigest: "d".repeat(64), stageId: "code",
    plugin: { id: "fixture", name: "Fixture", version: "1", path: snapshot,
      description: "", author: "", enabled: true, skillCount: 0, mcpServerCount: 1,
      hookCount: 0, createdAt: "", updatedAt: "" }
  }, () => { if (!current) throw Error("retained-content-changed") }, () => {
    if (!current) throw Error("retained-owner-revoked")
  })
  sourceTokens.push(token)
  await withRuntimePluginSource(token, async () => {
    const { prepareForegroundRuntimeToolCatalog } = await import("../../agent/runtime")
    const foreground = await prepareForegroundRuntimeToolCatalog(f.workspace,
      f.scope.threadId, { subagentsEnabled: false }, f.controller.signal)
    const discovered = getProjectMcpCapabilityService().peekTools!()!
    expect(discovered.map(tool => tool.providerKey)).toEqual(["plugin:fixture/a"])
    // Ordinary cold catalogs deliberately defer plugin-active MCP tools. The
    // actual initialized cache/peer must nevertheless belong to this retained owner.
    expect(foreground.some(tool => tool.name === "search_tool")).toBe(true)
    expect(foreground.filter(tool => tool.mcp)).toEqual([])
    expect(f.records().filter(row => row.event === "ready" && row.provider === "retained-a")).toHaveLength(1)
    expect(f.records().filter(row => row.event === "call")).toHaveLength(0)
    const catalog = await listNativeMcpTools()
    expect(catalog.map(tool => tool.provider.id)).toEqual(["plugin:fixture/a"])
    const service = getProjectMcpCapabilityService()
    const [tool] = await service.listTools()
    const invoke = async (value: string) => route === "flow"
      ? (await prepareNativeMcpStep({
          ...catalog[0], manager: manager!, ...f.scope, signal: f.controller.signal,
          assertLive: () => f.controller.signal.throwIfAborted(),
          withOwnerGrant: async run => run(f.grant)
        })).invoke({ tool: value })
      : withFunctionMcpCommand(f.workspace, f.scope.threadId, f.scope.turnId,
          f.controller.signal, () => manager!.invokeFunctionMcp(f.workspace,
            f.scope.threadId, f.grant, { server: tool.providerAlias, tool: "echo", args: { tool: value } },
            f.controller.signal, false, true))
    await withFunctionExecution(f.scope, async () => {
      const result = await invoke("exact-retained-call")
      expect(result).toMatchObject({ structuredContent: { provider: "retained-a", value: "exact-retained-call" } })
      if (route === "flow") {
        await expect(prepareNativeMcpStep({
          provider: foreignSource, toolName: foreign.toolName, schemaDigest: nativeMcpSchemaDigest(foreign),
          manager: manager!, ...f.scope, signal: f.controller.signal, assertLive: () => {},
          withOwnerGrant: async run => run(f.grant)
        })).rejects.toThrow("CLAW_MCP_SOURCE_CHANGED")
      } else {
        await expect(withFunctionMcpCommand(f.workspace, f.scope.threadId, f.scope.turnId,
          f.controller.signal, () => manager!.invokeFunctionMcp(f.workspace, f.scope.threadId,
            f.grant, { server: foreign.providerAlias, tool: "echo", args: { tool: "must-not-reach-global" } },
            f.controller.signal, false, true))).rejects.toThrow()
      }
      f.confirm.mockImplementation(async () => { current = false; return true })
      await expect(invoke("must-not-run-after-native-approval-revocation")).rejects.toThrow()
    })
  })
  expect(f.confirm).toHaveBeenCalledTimes(2)
  expect(f.records().filter(row => row.event === "call")).toEqual([
    { event: "call", provider: "retained-a", args: { tool: "exact-retained-call" } }
  ])
  current = false
  expect(() => withRuntimePluginSource(token, async () => listNativeMcpTools())).toThrow("retained")
  await closeProjectCapabilityMcpService(token)
  expect((await global.listTools()).map(tool => tool.providerKey).sort()).toEqual(["plugin:fixture/a", "plugin:fixture/b", "plugin:unselected/c"])
  expect(await global.invoke(foreign.capabilityId, { tool: "global-remains-usable" })).toMatchObject({
    structuredContent: { provider: "unselected-plugin", value: "global-remains-usable" }
  })
}, 30_000)

it("discovers explicitly, executes the exact real provider with reserved parameter names and records authority", async () => {
  const f = await fixture()
  expect(existsSync(f.journal)).toBe(false)
  expect(await listNativeMcpTools({ mode: "selected", items: [] })).toEqual([])
  expect(existsSync(f.journal)).toBe(false)
  const catalog = await f.catalog()
  expect(catalog).toHaveLength(1)
  expect(catalog[0].unavailableReason).toBeUndefined()
  const prepared = await f.prepare()
  const result = await withFunctionExecution(f.scope, () => prepared.invoke({ tool: "hello" }))
  expect(result).toMatchObject({
    text: "hello",
    structuredContent: { provider: "a", value: "hello" },
    isError: false
  })
  expect(f.records().filter((row) => row.event === "call")).toEqual([
    { event: "call", provider: "a", args: { tool: "hello" } }
  ])
  expect(f.confirm).toHaveBeenCalledOnce()
  expect(manager!.store.audit(f.workspace)).toEqual([
    expect.objectContaining({
      status: "succeeded",
      publication: "published",
      identity: expect.objectContaining({ modId: "function:flow-owner", turnId: "flow-run" })
    })
  ])
  await expect(
    withFunctionExecution(f.scope, () => prepared.invoke({ tool: "again" }))
  ).rejects.toThrow("FLOW_MCP_ALREADY_ATTEMPTED")
}, 30_000)

it("blocks denied and prehook-blocked calls before real transport", async () => {
  const f = await fixture()
  f.confirm.mockResolvedValue(false)
  await expect(f.call()).rejects.toThrow()
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
  f.confirm.mockResolvedValue(true)
  vi.mocked(runHooksEnriched).mockResolvedValue({
    blocked: true,
    reason: "denied by hook"
  } as never)
  await expect(f.call()).rejects.toThrow()
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
  vi.mocked(runHooksEnriched).mockResolvedValue({ updatedInput: { tool: 123 } } as never)
  await expect(f.call()).rejects.toThrow()
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
}, 30_000)

it("rejects provider changes during approval, generation changes, cancellation and unselected providers", async () => {
  const f = await fixture()
  const prepared = await f.prepare()
  f.confirm.mockImplementation(async () => {
    fixtureState.plugins[0].enabled = false
    return true
  })
  await expect(
    withFunctionExecution(f.scope, () => prepared.invoke({ tool: "stale" }))
  ).rejects.toThrow()
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
  fixtureState.plugins[0].enabled = true
  const next = await f.prepare()
  await getGlobalMcpCapabilityService().invalidate("test reconnect")
  await getGlobalMcpCapabilityService().listTools()
  expect(() => next.assertCurrent()).toThrow("FLOW_MCP_CONNECTION_CHANGED")
  const [descriptor] = await f.catalog()
  await expect(
    prepareNativeMcpStep({
      ...descriptor,
      provider: f.sources[1],
      manager: manager!,
      ...f.scope,
      selection: f.selection,
      signal: f.controller.signal,
      assertLive: () => {},
      withOwnerGrant: (run) => run(f.grant)
    })
  ).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
  f.controller.abort()
  expect(() => next.assertCurrent()).toThrow()
}, 30_000)

it("never retries a real server disconnect, and preserves remote isError", async () => {
  const f = await fixture()
  expect(await f.call("error")).toMatchObject({ isError: true })
  await expect(f.call("disconnect")).rejects.toThrow()
  expect(
    f
      .records()
      .filter((row) => row.event === "call")
      .map((row) => row.args.tool)
  ).toEqual(["error", "disconnect"])
}, 30_000)

it("requires owner authority and protects published raw, text and structured results", async () => {
  const f = await fixture()
  const detached = await f.prepare()
  await expect(detached.invoke({ tool: "no-runtime" })).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
  manager!.configure(f.workspace, true, true)
  const result = await f.call("sk-private-native-flow-123456789")
  expect(JSON.stringify(result)).not.toContain("sk-private-native-flow")
  expect(JSON.stringify(result)).toContain("[REDACTED]")
  const revoked = await f.prepare()
  manager!.store.grant(f.workspace, f.grant.modId, "replaced-digest", true)
  await expect(
    withFunctionExecution(f.scope, () => revoked.invoke({ tool: "revoked" }))
  ).rejects.toThrow()
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(1)
}, 30_000)

it("persists only bounded text/structured output and the minimal execution identity", async () => {
  const f = await fixture()
  const prepared = await f.prepare()
  expect(Object.keys(prepared.plan).sort()).toEqual([
    "connectionGeneration",
    "provider",
    "schemaDigest",
    "toolName"
  ])
  expect(prepared.plan.connectionGeneration).toBeTruthy()
  const result = await withFunctionExecution(f.scope, () => prepared.invoke({ tool: "binary" }))
  expect(result).toEqual({
    isError: false,
    text: "binary",
    structuredContent: { provider: "a", value: "binary" }
  })
  expect(JSON.stringify(result)).not.toContain("YQ==")
  expect(f.records().filter((row) => row.event === "call")).toHaveLength(1)
}, 30_000)

it("fails protected output schema validation after exactly one real call without replay", async () => {
  const f = await fixture()
  manager!.configure(f.workspace, true, true)
  const prepared = await f.prepare()
  await expect(
    withFunctionExecution(f.scope, () => prepared.invoke({ tool: "protected-schema" }))
  ).rejects.toThrow("MODS_REGISTERED_TOOL_INPUT")
  await expect(
    withFunctionExecution(f.scope, () => prepared.invoke({ tool: "protected-schema" }))
  ).rejects.toThrow("FLOW_MCP_ALREADY_ATTEMPTED")
  expect(f.records().filter((row) => row.event === "call")).toEqual([
    { event: "call", provider: "a", args: { tool: "protected-schema" } }
  ])
}, 30_000)

it("pins canonical input/output schemas while exposing unsupported schemas as unavailable", async () => {
  const tool = {
    providerKey: "a",
    capabilityId: "a:echo",
    toolId: "a_echo",
    providerAlias: "a",
    providerDisplayName: "a",
    toolName: "echo",
    visibility: "eager",
    inputSchema: { type: "object", properties: { x: { type: "string" } } }
  } as McpCapabilityTool
  expect(nativeMcpSchemaDigest(tool)).toBe(
    nativeMcpSchemaDigest({
      ...tool,
      connectionGeneration: "new",
      inputSchema: { properties: { x: { type: "string" } }, type: "object" }
    })
  )
  expect(nativeMcpSchemaDigest(tool)).not.toBe(
    nativeMcpSchemaDigest({ ...tool, outputSchema: { type: "object" } })
  )
  const bad = { ...tool, inputSchema: { type: "object", patternProperties: {} } }
  const [descriptor] = await listNativeMcpTools(undefined, {
    readSources: () => [{ id: "a", name: "a", digest: "a".repeat(64) }],
    service: { listTools: async () => [bad] } as never
  })
  expect(descriptor.unavailableReason).toBeTruthy()
})

async function hostFixture() {
  const f = await fixture()
  manager!.store.grant(f.workspace, "function:flow-owner", "owner-digest", false)
  expect(
    claimLocalThreadRunLease({ threadId: "flow-thread", owner: "mods", runId: "flow-run" }).acquired
  ).toBe(true)
  const runtime = manager!.createRuntimeAuthority({ ...f.scope, signal: f.controller.signal })
  const scope = { ...f.scope, runtimeAuthority: runtime.authority }
  const release = manager!.bindThread({ ...scope, signal: f.controller.signal })
  const authority = manager!.createHostFlowAuthority({
    workspace: f.workspace,
    threadId: "flow-thread",
    runId: "flow-run",
    definitionDigest: "a".repeat(64),
    runtimeAuthority: runtime.authority,
    signal: f.controller.signal,
    assertLive: () => f.controller.signal.throwIfAborted()
  })
  const prepare = async () => {
    const [descriptor] = await f.catalog()
    return prepareNativeMcpStep({
      ...descriptor,
      ...scope,
      manager: manager!,
      selection: f.selection,
      signal: f.controller.signal,
      assertLive: () => authority.assertLive(),
      hostAuthority: () => authority
    })
  }
  return {
    ...f,
    scope,
    authority,
    prepare,
    dispose: () => {
      release()
      runtime.release()
    }
  }
}

it("executes real stdio MCP as an audited host Flow without any enabled owner grant", async () => {
  const f = await hostFixture()
  try {
    const prepared = await f.prepare()
    expect(
      await withFunctionExecution(f.scope, () => prepared.invoke({ tool: "host-call" }))
    ).toMatchObject({
      text: "host-call",
      structuredContent: { provider: "a", value: "host-call" }
    })
    expect(f.records().filter((row) => row.event === "call")).toHaveLength(1)
    const [audit] = manager!.store.audit(f.workspace)
    expect(audit.identity).not.toHaveProperty("modId")
    expect(audit.identity).toMatchObject({
      origin: "user-action",
      flow: { runId: "flow-run", definitionDigest: "a".repeat(64) }
    })
    expect(audit).toMatchObject({ status: "succeeded", publication: "published" })
    expect(f.confirm).toHaveBeenCalledOnce()
    await expect(
      withFunctionExecution(f.scope, () => prepared.invoke({ tool: "again" }))
    ).rejects.toThrow("FLOW_MCP_ALREADY_ATTEMPTED")
  } finally {
    f.dispose()
  }
}, 30_000)

it("host MCP rejects denial and late scope replacement before transport", async () => {
  const f = await hostFixture()
  try {
    f.confirm.mockResolvedValue(false)
    const denied = await f.prepare()
    await expect(
      withFunctionExecution(f.scope, () => denied.invoke({ tool: "denied" }))
    ).rejects.toThrow()
    expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
    f.confirm.mockImplementation(async () => {
      releaseLocalThreadRunLease("flow-thread", "mods", "flow-run")
      return true
    })
    const stale = await f.prepare()
    await expect(
      withFunctionExecution(f.scope, () => stale.invoke({ tool: "stale" }))
    ).rejects.toThrow()
    expect(f.records().filter((row) => row.event === "call")).toHaveLength(0)
  } finally {
    f.dispose()
  }
}, 30_000)

it("keeps the host liveness guard valid inside a nested grant context without lending its token", async () => {
  const f = await hostFixture()
  const grant = manager!.store.grant(f.workspace, "function:observer", "observer", true)
  let nested = false
  try {
    vi.mocked(runHooksEnriched).mockImplementation(async (_hooks, event) => {
      if (event !== "PreToolUse") return null
      const parent = getModCallContext()!
      expect(parent.identity.flow?.runId).toBe("flow-run")
      await modCallContext.run(
        {
          ...parent,
          identity: {
            ...parent.identity,
            modId: grant.modId,
            grantEpoch: grant.epoch,
            origin: "mod"
          },
          originMod: grant.modId
        },
        async () => {
          // A nested observer may retain its parent's liveness fence, but never borrow its principal.
          await expect(
            manager!.invokeHostFlowMcp(f.authority, {}, f.controller.signal, "invalid")
          ).rejects.toThrow("FLOW_AUTHORITY_SCOPE_CHANGED")
          expect(() => parent.assertLive?.()).not.toThrow()
          nested = true
        }
      )
      return null
    })
    const prepared = await f.prepare()
    expect(
      await withFunctionExecution(f.scope, () => prepared.invoke({ tool: "nested" }))
    ).toMatchObject({ text: "nested" })
    expect(nested).toBe(true)
    expect(f.records().filter((row) => row.event === "call")).toHaveLength(1)
  } finally {
    f.dispose()
  }
}, 30_000)
