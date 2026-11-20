import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "../agent/local-sandbox"
import { ModsManager, getModsManager, setModsManager } from "./manager"
import { withFunctionExecution } from "./v2/execution-context"
import { ProjectFunctionFiles } from "./v2/file-access"
import { FunctionRegisteredTools } from "./v2/registered-tools"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run()
})

function fixture(blockedToolNames = new Set<string>(), readOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "mods-runtime-authority-"))
  const workspace = join(root, "project"),
    executionWorkspace = join(root, "worktree")
  mkdirSync(workspace)
  mkdirSync(executionWorkspace)
  writeFileSync(join(workspace, "name.txt"), "grant project")
  writeFileSync(join(executionWorkspace, "name.txt"), "isolated checkout")
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const previous = getModsManager()
  setModsManager(manager)
  const controller = new AbortController()
  manager.configure(workspace, true, false)
  const grant = manager.store.grant(
    manager.workspaceKey(workspace),
    "function:demo",
    "digest",
    true
  )
  let release = () => {}
  const sandbox = new LocalSandbox({
    rootDir: executionWorkspace,
    modWorkspace: workspace,
    runId: "thread",
    hookTurnId: "turn",
    windowsSandbox: "none",
    abortSignal: controller.signal,
    modBlockedToolNames: blockedToolNames,
    modReadOnly: readOnly,
    onModBinding: (dispose) => {
      release = dispose
    },
    worktreeIsolation: {
      workspaceRoot: executionWorkspace,
      worktreeRoot: executionWorkspace
    } as import("../agent/workflow/types").WorkflowWorktreeIsolationBoundary
  })
  cleanup.push(() => {
    controller.abort()
    release()
    manager.close()
    setModsManager(previous)
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-runtime-authority-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  const scope = {
    workspace: manager.workspaceKey(workspace),
    threadId: "thread",
    turnId: "turn",
    leased: true,
    immediate: false,
    userInitiated: true
  }
  return {
    root,
    workspace,
    executionWorkspace,
    manager,
    controller,
    grant,
    sandbox,
    scope,
    release
  }
}

it("keeps project grants and receipts while native/file SDK reads use the actual isolated checkout", async () => {
  const f = fixture()
  await withFunctionExecution(f.scope, async () => {
    const result = await f.manager.invokeFunctionTool(
      f.workspace,
      "thread",
      f.grant,
      "host:read_file",
      { file_path: "name.txt" },
      f.controller.signal,
      false,
      true
    )
    expect(JSON.stringify(result)).toContain("isolated checkout")
    expect(JSON.stringify(result)).not.toContain("grant project")
    const scope = f.manager.functionRuntimeScope(f.workspace, "thread")
    expect(scope.workspace).toBe(f.manager.workspaceKey(f.executionWorkspace))
    expect(scope.bound).toBe(true)
    const files = new ProjectFunctionFiles(
      scope.workspace,
      scope.assertLive,
      async (v) => v,
      scope.queryTool
    )
    expect(await files.run("fs.read", "name.txt", f.controller.signal)).toBe("isolated checkout")
    expect(await files.run("fs.exists", join(f.workspace, "name.txt"), f.controller.signal)).toBe(
      false
    )
    writeFileSync(join(f.executionWorkspace, ".git"), "private git pointer")
    expect(await files.run("fs.exists", ".git", f.controller.signal)).toBe(false)
  })
  const receipt = f.manager.store.audit(f.scope.workspace)
  expect(receipt).toHaveLength(1)
  expect(receipt[0].identity).toMatchObject({ workspace: f.scope.workspace, turnId: "turn" })
})

it("enforces runtime tool restrictions even with no tool.check hooks and no mandatory output policy", async () => {
  const f = fixture(new Set(["read_file"]))
  await withFunctionExecution(f.scope, async () => {
    const query = vi.fn(async () => ({ decision: "allow" as const }))
    expect(
      await f.manager.queryFunctionTool(
        f.workspace,
        "thread",
        f.grant,
        "host:read_file",
        { file_path: "name.txt" },
        f.controller.signal,
        query
      )
    ).toEqual({
      decision: "deny",
      reason: "MODS_RUNTIME_TOOL_DENIED"
    })
    expect(query).not.toHaveBeenCalled()
    await expect(
      f.manager.invokeFunctionTool(
        f.workspace,
        "thread",
        f.grant,
        "host:read_file",
        { file_path: "name.txt" },
        f.controller.signal,
        false,
        true
      )
    ).rejects.toThrow("MODS_RUNTIME_TOOL_DENIED")
    const scope = f.manager.functionRuntimeScope(f.workspace, "thread")
    const files = new ProjectFunctionFiles(
      scope.workspace,
      scope.assertLive,
      async (v) => v,
      scope.queryTool
    )
    await expect(files.run("fs.read", "name.txt", f.controller.signal)).rejects.toThrow(
      "MODS_FS_ACCESS_DENIED"
    )
  })
  expect(f.manager.store.audit(f.scope.workspace)).toHaveLength(0)
})

it("captures binding generations and never turns a lost live scope into a project fallback", async () => {
  const f = fixture()
  await withFunctionExecution(f.scope, async () => {
    const captured = f.manager.functionRuntimeScope(f.workspace, "thread")
    f.release()
    expect(() => captured.assertLive()).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(() => f.manager.functionRuntimeScope(f.workspace, "thread")).toThrow(
      "MODS_THREAD_CONTEXT_REQUIRED"
    )
  })
  expect(f.manager.functionRuntimeScope(f.workspace, "thread").bound).toBe(false)
  await expect(
    withFunctionExecution({ ...f.scope, agentId: "unbound-child" }, async () =>
      f.manager.functionRuntimeScope(f.workspace, "thread")
    )
  ).rejects.toThrow("MODS_TOOL_AGENT_UNAVAILABLE")
})

it("rejects writes using the initial runtime readonly authority before backend post-construction setup", async () => {
  const f = fixture(new Set(), true)
  await expect(
    withFunctionExecution(f.scope, () =>
      f.manager.invokeFunctionTool(
        f.workspace,
        "thread",
        f.grant,
        "host:write_file",
        { file_path: "new.txt", content: "blocked" },
        f.controller.signal,
        false,
        true
      )
    )
  ).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
  expect(f.manager.store.audit(f.scope.workspace)).toHaveLength(0)
})

it("denies a runtime-blocked registered tool before entering guest code or claiming an execution", async () => {
  const f = fixture(new Set(["mcp__demo__edit"]))
  const run = vi.fn(async () => ({ result: "must not run" }))
  const registered = new FunctionRegisteredTools(f.manager.store, {
    assertScope: () => {},
    admit: (...args) => f.manager.authorizeRegisteredTool(...args),
    publish: async (_, result) => result
  })
  await expect(
    withFunctionExecution(f.scope, () =>
      registered.call(
        f.scope.workspace,
        "thread",
        f.grant,
        { tool: "mcp__demo__edit", tool_use_id: "call" },
        "model",
        f.controller.signal,
        run
      )
    )
  ).rejects.toThrow("MODS_RUNTIME_TOOL_DENIED")
  expect(run).not.toHaveBeenCalled()
  expect(f.manager.store.audit(f.scope.workspace)).toHaveLength(0)
})

it("filters captured and registered catalogs by the actual runtime tool restriction", async () => {
  const f = fixture(new Set(["execute", "mcp__demo__edit"]))
  f.manager.bindFunctionToolCatalog(f.scope, [
    { name: "execute", description: "Blocked", mcp: false },
    { name: "read_file", description: "Allowed", mcp: false }
  ])
  f.manager.attachFunctions({
    invalidate: () => {},
    closeThread: () => {},
    close: () => {},
    registeredTools: async () => [
      {
        name: "mcp__demo__edit",
        plugin: "demo",
        description: "Blocked",
        inputSchema: { type: "object" },
        mcp: true
      },
      {
        name: "mcp__demo__read",
        plugin: "demo",
        description: "Allowed",
        inputSchema: { type: "object" },
        mcp: true
      }
    ]
  })
  await withFunctionExecution(f.scope, async () => {
    expect(f.manager.functionToolCatalog(f.workspace, "thread").map((tool) => tool.name)).toEqual([
      "read_file"
    ])
    expect(
      (await f.manager.registeredFunctionTools(f.workspace, "thread")).map((tool) => tool.name)
    ).toEqual(["mcp__demo__read"])
  })
})
