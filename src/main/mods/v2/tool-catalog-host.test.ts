import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { McpCapabilityTool } from "../../mcp/capability-types"

const mocks = vi.hoisted(() => ({
  metadata: "",
  fingerprint: "one",
  tools: [] as McpCapabilityTool[],
  snapshot: vi.fn(),
  invoke: vi.fn(),
  memory: false,
  code: false,
  profiles: vi.fn(),
  roots: [] as string[]
}))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
vi.mock("../../db", async (original) => ({
  ...(await original<typeof import("../../db")>()),
  getThreadCore: () => ({ metadata: mocks.metadata })
}))
vi.mock("../../storage", async (original) => ({
  ...(await original<typeof import("../../storage")>()),
  getLspConfig: () => ({ enabled: false }),
  isThreadMemoryEnabled: () => mocks.memory,
  isCodeExecEnabled: () => mocks.code
}))
vi.mock("../../agent/agent-registry", async (original) => ({
  ...(await original<typeof import("../../agent/agent-registry")>()),
  loadAgentProfilesAsync: mocks.profiles
}))
vi.mock("../../code-exec/saved-tool-store", async (original) => ({
  ...(await original<typeof import("../../code-exec/saved-tool-store")>()),
  listSavedCodeExecTools: () => []
}))
vi.mock("../../mcp/capability-service", () => ({
  getGlobalMcpCapabilityService: () => ({ getSnapshot: mocks.snapshot, invoke: mocks.invoke })
}))
import { ModsManager, getModsManager, setModsManager } from "../manager"
import { queryFunctionToolCatalog } from "./tool-catalog-host"
import "../../agent/runtime"

const releases: Array<() => void> = []
beforeEach(() => {
  mocks.fingerprint = "one"
  mocks.tools = []
  mocks.memory = false
  mocks.code = false
  mocks.snapshot.mockImplementation(async () => ({
    fingerprint: mocks.fingerprint,
    tools: mocks.tools
  }))
  mocks.profiles.mockResolvedValue([
    {
      name: "Explore",
      description: "Explore",
      systemPrompt: "Inspect",
      shellAccess: "read_only",
      disallowedTools: []
    }
  ])
})
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release()
  vi.clearAllMocks()
})
function fixture(metadata: Record<string, unknown> = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "mods-cold-catalog-"))
  mocks.metadata = JSON.stringify({ workspacePath: workspace, ...metadata })
  const manager = new ModsManager(
    join(workspace, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const previous = getModsManager()
  setModsManager(manager)
  manager.configure(workspace, true, false)
  releases.push(() => {
    manager.close()
    setModsManager(previous)
    if (
      dirname(resolve(workspace)) !== resolve(tmpdir()) ||
      !basename(workspace).startsWith("mods-cold-catalog-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(workspace, { recursive: true, force: true })
  })
  const signal = new AbortController()
  const plain = vi.fn()
  return {
    manager,
    workspace,
    signal,
    plain,
    query: () => queryFunctionToolCatalog(manager, plain, workspace, "thread", signal.signal)
  }
}
function mcp(visibility: "eager" | "lazy"): McpCapabilityTool {
  return {
    capabilityId: "connector:fixture:echo",
    toolId: "mcp__fixture__echo",
    providerKey: "connector:fixture",
    providerAlias: "fixture",
    providerDisplayName: "Fixture",
    toolName: "echo",
    description: "Echo",
    visibility,
    sourceKind: "connector",
    scope: "global",
    inputSchema: { type: "object", properties: {} }
  }
}

it("lists actual cold builtins, task and eager MCP metadata with no runtime or execution receipt", async () => {
  const f = fixture()
  mocks.tools = [mcp("eager")]
  const authority = vi.spyOn(f.manager, "createRuntimeAuthority")
  const binding = vi.spyOn(f.manager, "bindThread")
  const result = await f.query()
  const names = result.map((tool) => tool.name)
  expect(names).toEqual(
    expect.arrayContaining([
      "read_file",
      "write_file",
      "task_output",
      "write_todos",
      "request_user_input",
      "manage_scheduler",
      "task"
    ])
  )
  expect(result.some((tool) => tool.mcp && tool.description.includes("Echo"))).toBe(true)
  expect(names).not.toContain("manage_skill")
  expect(names).not.toContain("memory_search")
  expect(names).not.toContain("code_exec")
  expect(result.every((tool) => Object.keys(tool).sort().join() === "description,mcp,name")).toBe(
    true
  )
  expect(authority).not.toHaveBeenCalled()
  expect(binding).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(f.manager.store.audit(f.manager.workspaceKey(f.workspace))).toEqual([])
})

it("uses Solo, memory and deferred MCP switches and reflects fresh configuration on the next query", async () => {
  const f = fixture({ subagentsEnabled: false })
  mocks.tools = [mcp("lazy")]
  mocks.memory = true
  mocks.code = true
  const names = (await f.query()).map((tool) => tool.name)
  expect(names).not.toContain("task")
  expect(names).toEqual(
    expect.arrayContaining([
      "memory_search",
      "memory_get",
      "search_tool",
      "inspect_tool",
      "invoke_deferred_tool",
      "code_exec"
    ])
  )
  expect(mocks.profiles).not.toHaveBeenCalled()
  mocks.tools = []
  mocks.memory = false
  mocks.code = false
  expect((await f.query()).map((tool) => tool.name)).not.toContain("search_tool")
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it("rejects a changed metadata scope or configuration instead of publishing a mixed cold snapshot", async () => {
  const f = fixture()
  mocks.snapshot.mockImplementationOnce(async () => {
    mocks.metadata = JSON.stringify({ workspacePath: f.workspace, subagentsEnabled: false })
    return { fingerprint: "one", tools: [] }
  })
  await expect(f.query()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  mocks.snapshot.mockResolvedValueOnce({ fingerprint: "old", tools: [] })
  await expect(f.query()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
})

it("does not replace an instance that starts during cold discovery", async () => {
  const f = fixture()
  let started: ReturnType<ModsManager["createRuntimeAuthority"]> | undefined
  mocks.snapshot.mockImplementationOnce(async () => {
    started = f.manager.createRuntimeAuthority({
      workspace: f.workspace, threadId: "thread", turnId: "turn"
    })
    return { fingerprint: "one", tools: [] }
  })
  await expect(f.query()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(started).toBeDefined()
  started!.authority.assertLive()
  // The ordinary runtime lives independently of a Mods adapter binding.
  expect(f.manager.functionUserScope(f.workspace, "thread")).toEqual({})
})

it("rejects cancellation and refuses a non-plain thread without discovering capabilities", async () => {
  const f = fixture()
  f.plain.mockImplementation(() => {
    throw Error("MODS_THREAD_CONTEXT_REQUIRED")
  })
  await expect(f.query()).rejects.toThrow("MODS_THREAD_CONTEXT_REQUIRED")
  expect(mocks.snapshot).not.toHaveBeenCalled()
  f.plain.mockImplementation(() => {})
  mocks.snapshot.mockImplementationOnce(async () => {
    f.signal.abort()
    return { fingerprint: "one", tools: [] }
  })
  await expect(f.query()).rejects.toThrow()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it.each([
  { targetKind: "inbox" },
  { targetKind: "feature" },
  { isHeartbeat: true },
  { scheduledTaskId: "scheduled" }
])("does not infer foreground tools for a cold transport-owned thread %j", async (metadata) => {
  const f = fixture(metadata)
  await expect(f.query()).rejects.toThrow("MODS_TOOL_CONTEXT_REQUIRED")
  expect(mocks.snapshot).not.toHaveBeenCalled()
})

it("reads an existing runtime's catalog without a cold fallback or provider discovery", async () => {
  const f = fixture({ targetKind: "inbox" })
  const instance = f.manager.createRuntimeAuthority({
    workspace: f.workspace,
    threadId: "thread",
    turnId: "run"
  })
  f.manager.bindFunctionToolCatalog(
    {
      workspace: f.workspace,
      threadId: "thread",
      turnId: "run",
      runtimeAuthority: instance.authority
    },
    [{ name: "actual_remote_tool", description: "Transport owned", mcp: false }]
  )
  expect(await f.query()).toEqual([
    { name: "actual_remote_tool", description: "Transport owned", mcp: false }
  ])
  expect(f.plain).not.toHaveBeenCalled()
  expect(mocks.snapshot).not.toHaveBeenCalled()
  instance.authority.assertLive()
})

it("expires a cold query on thread close even when it never owned a runtime", async () => {
  const f = fixture()
  mocks.snapshot.mockImplementationOnce(async () => {
    f.manager.closeFunctionThread("thread")
    return { fingerprint: "one", tools: [] }
  })
  await expect(f.query()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
})

it("releases completed cold query handles and refuses live query overflow without eviction", async () => {
  const f = fixture()
  for (let i = 0; i < 110; i++) {
    const scope = f.manager.captureFunctionToolCatalog(f.workspace, "thread")
    scope.release()
  }
  const scopes = Array.from({ length: 100 }, () =>
    f.manager.captureFunctionToolCatalog(f.workspace, "thread")
  )
  expect(() => f.manager.captureFunctionToolCatalog(f.workspace, "thread")).toThrow(
    "MODS_RUNTIME_CAPACITY"
  )
  scopes[0].assertLive()
  for (const scope of scopes) scope.release()
  const next = f.manager.captureFunctionToolCatalog(f.workspace, "thread")
  next.assertLive()
  next.release()
})
