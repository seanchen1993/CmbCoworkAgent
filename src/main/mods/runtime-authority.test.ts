import { AGENT_GRAPH_RECURSION_LIMIT_MIN } from "../../shared/agent-runtime-limits"
import { queryFunctionAgentList } from "./v2/agent-list-host"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "../agent/local-sandbox"
import { ModsManager, authorizeCurrentModInput, getModsManager, setModsManager } from "./manager"
import { withFunctionExecution } from "./v2/execution-context"
import { ProjectFunctionFiles } from "./v2/file-access"
import { FunctionRegisteredTools } from "./v2/registered-tools"
import { functionCallAuthority, withFunctionAgentExecution } from "./v2/host-call"
import { getModCallContext, modCallContext } from "./context"
import type { ModRuntimeAuthority } from "./runtime-instance"
import {
  createDeepAgent,
  createAgentRuntime,
  wrapTaskToolWithOwnerMetadata,
  SUBAGENT_OWNER_METADATA_KEY
} from "../agent/runtime"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createToolHookMiddleware } from "../agent/tool-hooks"
import { createHookScope } from "../hooks/scope"
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { FunctionGuestRuntime } from "./v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./v2/session"
import { FunctionModsManager } from "./v2/manager"
import { currentFunctionExecution } from "./v2/execution-context"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { functionSdkToolInput } from "./v2/tool-sdk"
import { queryFunctionToolPermission } from "./v2/tool-permission-host"
import type { ModObject } from "../../shared/mods/types"
import type { FunctionTaskModel } from "../agent/mods-task-model"
import type { FunctionTurnComplete } from "../../shared/mods/v2/turn"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
const cleanup: Array<() => void> = []
const TASK_AUTHORITY_ID = /^mod-task:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run()
})

it("rejects a stale session workspace before allocating Mods authority or starting a model", async () => {
  const f = fixture()
  const createAuthority = vi.spyOn(f.manager, "createRuntimeAuthority")
  try {
    await expect(
      createAgentRuntime({
        workspacePath: join(f.workspace, "missing"),
        threadId: "invalid-workspace"
      })
    ).rejects.toMatchObject({ code: "invalid_workspace_path" })
    expect(createAuthority).not.toHaveBeenCalled()
  } finally {
    createAuthority.mockRestore()
  }
})

it("validates a stale workspace when no Mods manager is installed", async () => {
  const previous = getModsManager()
  setModsManager(undefined)
  try {
    await expect(
      createAgentRuntime({
        workspacePath: join(tmpdir(), "missing-workspace", "Users", "demo"),
        threadId: "invalid-workspace-no-mods"
      })
    ).rejects.toMatchObject({ code: "invalid_workspace_path" })
  } finally {
    setModsManager(previous)
  }
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
  const instance = manager.createRuntimeAuthority({
    workspace,
    threadId: "thread",
    turnId: "turn",
    signal: controller.signal
  })
  const sandbox = new LocalSandbox({
    rootDir: executionWorkspace,
    modRuntimeAuthority: instance.authority,
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
    release: () => {
      release()
      instance.release()
    }
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

it("canonicalizes native Hook workspaces before entering the Function Mods thread guard", async () => {
  const f = fixture()
  const classicEvent = vi.fn(async (workspace: string) => {
    if (workspace !== f.scope.workspace) throw Error("MODS_CALL_SCOPE_CHANGED")
    return {}
  })
  f.manager.attachFunctions({
    invalidate: () => undefined,
    closeThread: () => undefined,
    close: () => undefined,
    classicEvent
  })
  await expect(f.manager.classicEvent(
    f.workspace, "thread", "classic.PreToolUse", { tool: "read_file", tool_use_id: "read" },
    f.controller.signal
  )).resolves.toEqual({})
  expect(classicEvent.mock.calls[0][0]).toBe(f.scope.workspace)
})

it("canonicalizes native agent offers before entering the Function Mods thread guard", async () => {
  const f = fixture()
  const offerAgent = vi.fn(async (workspace: string) => {
    if (workspace !== f.scope.workspace) throw Error("MODS_CALL_SCOPE_CHANGED")
    return { isOffered: true }
  })
  f.manager.attachFunctions({
    invalidate: () => undefined,
    closeThread: () => undefined,
    close: () => undefined,
    offerAgent
  })
  await expect(f.manager.offerAgent(
    f.workspace, "thread", { agentId: "reviewer" }, f.controller.signal
  )).resolves.toEqual({ isOffered: true })
  expect(offerAgent.mock.calls[0][0]).toBe(f.scope.workspace)
})

it("keeps the core model stream available when no Function Mods lifecycle is installed", async () => {
  const f = fixture()
  const authority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const calls: string[] = []
  const stream = await f.manager.functionModelStream(
    authority,
    { prompt: "native model" },
    async function* (input, { signal }) {
      signal.throwIfAborted()
      calls.push(String(input.prompt))
      yield { text: "native chunk" }
      return { text: "native result" }
    },
    f.controller.signal
  )
  expect(await stream.next()).toEqual({ done: false, value: { text: "native chunk" } })
  expect(await stream.next()).toEqual({ done: true, value: { text: "native result" } })
  expect(await stream.result).toEqual({ text: "native result" })
  expect(calls).toEqual(["native model"])
})

it("does not resume a native model stream after its runtime authority is released", async () => {
  const f = fixture()
  const authority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  let resumed = false
  const stream = await f.manager.functionModelStream(
    authority,
    {},
    async function* () {
      yield { text: "first" }
      resumed = true
      return { text: "late" }
    },
    f.controller.signal
  )
  const result = expect(stream.result).rejects.toThrow()
  await stream.next()
  f.release()
  await expect(stream.next()).rejects.toThrow()
  await result
  expect(resumed).toBe(false)
})

it("actively aborts an in-flight model provider when its exact runtime authority is replaced", async () => {
  const f = fixture()
  const authority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  let entered!: () => void
  const pendingProvider = new Promise<void>((resolve) => { entered = resolve })
  let providerSignal: AbortSignal | undefined
  let closed = false
  const stream = await f.manager.functionModelStream(authority, {}, async function* (_input, { signal }) {
    providerSignal = signal
    try {
      entered()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        if (signal.aborted) reject(signal.reason)
      })
      yield { text: "must not arrive" }
      return null
    } finally { closed = true }
  }, f.controller.signal)
  const result = expect(stream.result).rejects.toThrow()
  const pending = stream.next()
  void pending.catch(() => {})
  await pendingProvider
  f.manager.createRuntimeAuthority({ workspace: f.workspace, threadId: "thread", turnId: "replacement" })
  expect(providerSignal?.aborted).toBe(true)
  await expect(pending).rejects.toThrow()
  await result
  expect(closed).toBe(true)
})

it.each(["complete", "return-unused", "abort-unused", "creation-failure"])(
  "releases exact-authority stream resources after repeated %s",
  async (mode) => {
    const f = fixture()
    const authority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
    let entered = 0
    if (mode === "creation-failure") f.manager.attachFunctions({
      invalidate: () => {}, closeThread: () => {}, close: () => {},
      turnStep: async () => { throw Error("CREATION_FAILED") }
    })
    // Runtime ownership caps resources at 100. Every settled path must detach.
    for (let index = 0; index < 105; index++) {
      const controller = new AbortController()
      const open = f.manager.functionModelStream(authority, {}, async function* () {
        entered++
        yield { text: "one" }
        return null
      }, controller.signal)
      if (mode === "creation-failure") {
        await expect(open).rejects.toThrow("CREATION_FAILED")
        continue
      }
      const stream = await open
      if (mode === "complete") {
        for await (const value of stream) expect(value).toEqual({ text: "one" })
        await expect(stream.result).resolves.toBeNull()
      } else {
        const result = expect(stream.result).rejects.toThrow()
        if (mode === "return-unused") await stream.return(null)
        else controller.abort(Error("unused cancelled"))
        await result
      }
    }
    expect(entered).toBe(mode === "complete" ? 105 : 0)
  }
)

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

it("filters both MCP aliases in a shared child's catalog and refuses a late old-instance binding", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const metadata = [
    {
      capabilityId: "provider:read",
      providerKey: "provider",
      providerAlias: "server",
      providerDisplayName: "Server",
      toolName: "read",
      toolId: "mcp__scoped__read",
      canonicalToolId: "mcp__server__read",
      visibility: "eager" as const
    }
  ]
  const discover = vi.fn(async () => metadata)
  const invoke = vi.fn(async () => "unused")
  f.manager.bindMcp({ ...f.scope, runtimeAuthority: parent }, invoke, discover, () => metadata)
  const tools = metadata.flatMap((tool) => [{ name: tool.toolId }, { name: tool.canonicalToolId }])
  await f.manager.withSharedAgent(
    parent,
    "reader",
    f.controller.signal,
    {
      readOnly: true,
      blockedToolNames: new Set(["mcp__server__read"])
    },
    async () => {
      expect(f.manager.filterFunctionTools(f.workspace, "thread", tools)).toEqual([])
    }
  )
  await withFunctionExecution({ ...f.scope, runtimeAuthority: parent }, async () => {
    expect(f.manager.filterFunctionTools(f.workspace, "thread", tools)).toEqual(tools)
  })
  expect(discover).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
  f.manager.createRuntimeAuthority(f.scope)
  expect(() => f.manager.bindMcp({ ...f.scope, runtimeAuthority: parent }, invoke)).toThrow(
    "MODS_RUNTIME_INSTANCE_EXPIRED"
  )
})

it.each(["native", "mcp"] as const)(
  "does not evict a live %s binding at capacity and reclaims expired entries",
  (kind) => {
    const f = fixture()
    const controllers: AbortController[] = []
    const bind = (threadId: string, signal?: AbortSignal) => {
      const binding = { ...f.scope, threadId, signal }
      return kind === "native"
        ? f.manager.bindThread(binding)
        : f.manager.bindMcp(
            binding,
            async () => "unused",
            undefined,
            () => []
          )
    }
    if (kind === "mcp") bind("thread")
    for (let index = 1; index < 100; index++) {
      const controller = new AbortController()
      controllers.push(controller)
      bind(`thread-${index}`, controller.signal)
    }
    expect(() => bind("overflow")).toThrow("MODS_RUNTIME_CAPACITY")
    if (kind === "native")
      expect(f.manager.functionRuntimeScope(f.workspace, "thread").bound).toBe(true)
    else expect(f.manager.peekFunctionMcpTools(f.workspace, "thread")).toEqual([])
    controllers[0].abort()
    expect(() => bind("replacement")).not.toThrow()
    expect(() => bind("overflow")).toThrow("MODS_RUNTIME_CAPACITY")
  }
)

it("never lets an old callback acquire a replacement backend with the same agent and turn", async () => {
  const f = fixture(new Set(["read_file"]))
  const original = { ...f.scope, ...f.manager.functionUserScope(f.workspace, "thread") }
  let replacementRelease = () => {}
  await withFunctionExecution(original, async () => {
    const replacement = f.manager.createRuntimeAuthority({
      ...f.scope,
      signal: f.controller.signal
    })
    new LocalSandbox({
      modRuntimeAuthority: replacement.authority,
      rootDir: f.executionWorkspace,
      modWorkspace: f.workspace,
      runId: "thread",
      hookTurnId: "turn",
      windowsSandbox: "none",
      abortSignal: f.controller.signal,
      onModBinding: (release) => {
        replacementRelease = release
      }
    })
    f.release()
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
    ).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(() => f.manager.functionRuntimeScope(f.workspace, "thread")).toThrow(
      "MODS_RUNTIME_INSTANCE_EXPIRED"
    )
  })
  cleanup.push(() => replacementRelease())
  await withFunctionExecution(
    { ...f.scope, ...f.manager.functionUserScope(f.workspace, "thread") },
    async () => {
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
    }
  )
  expect(f.manager.store.audit(f.scope.workspace)).toHaveLength(1)
})

it("rejects a former project's direct ingress before merging another project's backend for the same thread", async () => {
  const f = fixture()
  const original = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  f.manager.configure(f.executionWorkspace, true, false)
  const replacement = f.manager.createRuntimeAuthority({
    ...f.scope,
    workspace: f.executionWorkspace
  })
  new LocalSandbox({
    rootDir: f.executionWorkspace,
    modWorkspace: f.executionWorkspace,
    modRuntimeAuthority: replacement.authority,
    runId: "thread",
    hookTurnId: "turn",
    windowsSandbox: "none",
    abortSignal: f.controller.signal
  })
  const run = vi.fn(async () => "must not execute")
  await expect(
    f.manager.dispatch(
      { ...f.scope, runtimeAuthority: original },
      "host:read_file",
      { file_path: "name.txt" },
      run
    )
  ).rejects.toThrow("MODS_RUNTIME_SCOPE_CHANGED")
  expect(run).not.toHaveBeenCalled()
  expect(f.manager.store.audit(f.scope.workspace)).toEqual([])
})

it("binds concurrent shared children explicitly and expires each scope when its task settles", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const children: ModRuntimeAuthority[] = []
  const values = await Promise.all(
    ["reader", "restricted"].map((agentId) =>
      f.manager.withSharedAgent(
        parent,
        agentId,
        f.controller.signal,
        {
          blockedToolNames: new Set(agentId === "restricted" ? ["read_file"] : ["write_file"]),
          readOnly: true
        },
        async () => {
          children.push(functionCallAuthority(f.scope.workspace, "thread")!)
          const scope = f.manager.functionRuntimeScope(f.workspace, "thread")
          expect(scope.workspace).toBe(f.manager.workspaceKey(f.executionWorkspace))
          const files = new ProjectFunctionFiles(
            scope.workspace,
            scope.assertLive,
            async (v) => v,
            scope.queryTool
          )
          if (agentId === "restricted") {
            await expect(files.run("fs.read", "name.txt", f.controller.signal)).rejects.toThrow(
              "MODS_FS_ACCESS_DENIED"
            )
            await expect(
              f.manager.invokeFunctionTool(
                f.workspace,
                "thread",
                f.grant,
                "host:read_file",
                { file_path: "name.txt" },
                f.controller.signal,
                false,
                false
              )
            ).rejects.toThrow("MODS_RUNTIME_TOOL_DENIED")
            return "denied"
          }
          const read = await f.manager.invokeFunctionTool(
            f.workspace,
            "thread",
            f.grant,
            "host:read_file",
            { file_path: "name.txt" },
            f.controller.signal,
            false,
            false
          )
          expect(JSON.stringify(read)).toContain("isolated checkout")
          expect(await files.run("fs.read", "name.txt", f.controller.signal)).toBe(
            "isolated checkout"
          )
          return "read"
        }
      )
    )
  )
  expect(values).toEqual(["read", "denied"])
  for (const child of children)
    expect(() => child.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  parent.assertLive()
  const audit = f.manager.store.audit(f.scope.workspace)
  expect(audit).toHaveLength(1)
  expect(audit[0].identity).toMatchObject({ agentId: "reader" })
})

it("keeps named registered MCP calls on the real shared child and native receipt chain", async () => {
  const f = fixture()
  const authority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const host = new FunctionRegisteredTools(f.manager.store, {
    assertScope: (workspace, threadId) => {
      f.manager.functionToolAgent(workspace, threadId)
    },
    admit: (...args) => f.manager.authorizeRegisteredTool(...args),
    publish: async (identity, value) => {
      f.manager.store.publication(identity.callId, "", [], "published")
      return value
    }
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.tool.register({name:"outer",description:"Outer"});
      await $.tool.register({name:"inner",description:"Inner"});
      return next(e);
    });
    on("tool.call",{tool:"mcp__demo__outer"},async($)=>({result:await $.mcp.call("demo","inner")}));
    on("tool.call",{tool:"mcp__demo__inner"},async($,e)=>({result:{agent:e.agentId,
      read:await $.tool.call({tool:"read_file",file_path:"name.txt"})}}));
  }}`)
  const physical = vi.fn()
  const session = new FunctionSession(
    [
      {
        name: "demo",
        root: f.workspace,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: f.scope.workspace,
      threadId: "thread",
      assertLive: () => f.manager.store.assertGrant(f.grant),
      publish: async (v) => v,
      assertToolNameAvailable: (_plugin, name) =>
        f.manager.assertFunctionToolNameAvailable(f.workspace, "thread", name),
      registeredTool: (_owner, input, kind, signal, run, caller) =>
        host.call(f.scope.workspace, "thread", f.grant, input, kind, signal, run, caller),
      callMcp: physical,
      callTool: async (_plugin, input, signal) => {
        const { target, args } = functionSdkToolInput(input)
        return f.manager.invokeFunctionTool(
          f.workspace,
          "thread",
          f.grant,
          target,
          args,
          signal,
          false,
          false
        )
      }
    }
  )
  try {
    const result = await f.manager.withSharedAgent(
      authority,
      "worker",
      f.controller.signal,
      { blockedToolNames: new Set(), readOnly: true },
      () =>
        session.interceptTool(
          {
            tool: "mcp__demo__outer",
            tool_use_id: "real-model-tool",
            agentId: "worker"
          },
          f.controller.signal,
          async () => {
            throw Error("Unexpected native fallback")
          }
        )
    )
    expect(JSON.stringify(result)).toContain("isolated checkout")
    const audit = f.manager.store.audit(f.scope.workspace)
    expect(audit).toHaveLength(3)
    const outer = audit.find((row) => row.toolId === "function:mcp__demo__outer")!
    const inner = audit.find((row) => row.toolId === "function:mcp__demo__inner")!
    const read = audit.find((row) => row.toolId === "host:read_file")!
    expect(inner.identity?.parentCallId).toBe(outer.identity?.callId)
    expect(read.identity?.parentCallId).toBe(inner.identity?.callId)
    expect(outer.identity?.turnId).not.toBe(authority.turnId)
    for (const row of audit)
      expect(row).toMatchObject({
        status: "succeeded",
        publication: "published",
        identity: { agentId: "worker", turnId: outer.identity!.turnId, modId: "function:demo" }
      })
    expect(physical).not.toHaveBeenCalled()
    authority.assertLive()
  } finally {
    await session.close()
  }
})

it("uses the constructor's fixed owner even when a backend is created inside a parent tool call", async () => {
  const f = fixture()
  const childIdentity = { ...f.scope, agentId: "explicit-child" }
  const instance = f.manager.createRuntimeAuthority(childIdentity)
  let release = () => {}
  modCallContext.run(
    {
      identity: {
        ...f.scope,
        agentId: "ambient-parent",
        callId: "parent",
        origin: "model",
        grantEpoch: 0
      },
      toolId: "host:task",
      routeClaimed: true,
      protectedOutput: false,
      readOnly: false
    },
    () =>
      new LocalSandbox({
        rootDir: f.executionWorkspace,
        modWorkspace: f.workspace,
        runId: "thread",
        hookTurnId: "turn",
        agentId: "explicit-child",
        modRuntimeAuthority: instance.authority,
        windowsSandbox: "none",
        onModBinding: (dispose) => {
          release = dispose
        }
      })
  )
  cleanup.push(() => {
    release()
    instance.release()
  })
  await withFunctionAgentExecution(
    { ...childIdentity, runtimeAuthority: instance.authority },
    async () => {
      const result = await f.manager.invokeFunctionTool(
        f.workspace,
        "thread",
        f.grant,
        "host:read_file",
        { file_path: "name.txt" },
        f.controller.signal,
        false,
        false
      )
      expect(JSON.stringify(result)).toContain("isolated checkout")
    }
  )
  expect(f.manager.store.audit(f.scope.workspace)[0].identity).toMatchObject({
    agentId: "explicit-child"
  })
})

it.each(["eager", "deferred"] as const)("serves a registered tool and nested file SDK inside a real deepagents task with the role's authority (%s)", async placement => {
  const deferred = placement === "deferred"
  const childSteps = deferred ? 3 : 2
  const f = fixture()
  const runtimeAuthority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const permissionQuestions: ModObject[] = [], callQuestions: ModObject[] = []
  const queryQuestions: ModObject[] = []
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.tool.register({name:"inspect",description:"Inspect actual files"${deferred ? "" : ",isDeferred:false"}});
      await $.tool.register({name:"forbidden",description:"Hidden from Explore",isDeferred:false});
      return next(e);
    });
    on("tool.call",{tool:"mcp__demo__inspect"},async($,e)=>{
      const permission=await $.tool.check({tool:"read_file",input:{file_path:"name.txt"},
        tool_use_id:e.tool_use_id,agentId:e.agentId,ceiling:"deny"});
      const read=await $.tool.call({tool:"read_file",file_path:"name.txt"});
      return {result:{agent:e.agentId,read:read.text,cwd:await $.session.cwd(),
        file:await $.fs.read("name.txt"),tools:await $.tool.list(),agents:await $.agent.list(),permission}};
    });
    on("tool.check",async($,e,next)=>{
      const result=await next(e);
      if(result.ceiling!==undefined)throw Error("no connector ceiling source");
      return {...result,hook:"OtherHook"};
    });
  }}`)
  const registered = new FunctionRegisteredTools(f.manager.store, {
    assertScope: (workspace, threadId) => {
      f.manager.functionToolAgent(workspace, threadId)
    },
    admit: (...args) => f.manager.authorizeRegisteredTool(...args),
    publish: async (_, value) => value
  })
  const session = new FunctionSession(
    [
      {
        name: "demo",
        root: f.workspace,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: f.scope.workspace,
      threadId: "thread",
      assertLive: () => f.manager.store.assertGrant(f.grant),
      publish: async (value) => value,
      cwd: () => f.manager.functionRuntimeScope(f.workspace, "thread").workspace,
      files: () => {
        const scope = f.manager.functionRuntimeScope(f.workspace, "thread")
        return new ProjectFunctionFiles(
          scope.workspace,
          scope.assertLive,
          async (v) => v,
          scope.queryTool
        )
      },
      listAgents: async (signal) => f.manager.listFunctionAgents(f.workspace, "thread", signal),
      listTools: async () =>
        f.manager.functionToolCatalog(f.workspace, "thread", currentFunctionExecution()?.agentId),
      filterTools: (tools) => f.manager.filterFunctionTools(f.workspace, "thread", tools),
      registeredTool: (_, input, origin, signal, run, caller) =>
        registered.call(f.scope.workspace, "thread", f.grant, input, origin, signal, run, caller),
      checkTool: (_plugin, input, signal) => {
        queryQuestions.push(JSON.parse(JSON.stringify(input)))
        return queryFunctionToolPermission(f.manager, () => {
          throw Error("unexpected cold permission fallback")
        }, f.workspace, "thread", f.grant, input, signal)
      },
      callTool: async (_, input, signal) => {
        callQuestions.push(JSON.parse(JSON.stringify(input)))
        if (typeof input.tool_use_id !== "string") throw Error("actual SDK tool.call id missing")
        const { target, args } = functionSdkToolInput(input)
        return f.manager.invokeFunctionTool(
          f.workspace,
          "thread",
          f.grant,
          target,
          args,
          signal,
          false,
          false,
          input.tool_use_id
        )
      }
    }
  )
  const childCompletions: FunctionTurnComplete[] = []
  const turnStarts = vi.fn(async () => {})
  f.manager.attachFunctions({
    turnStart: turnStarts,
    turnComplete: async (_workspace, _threadId, input) => {
      expect(getLocalThreadRunLease("thread")?.runId).toBe("parent-graph")
      expect(currentFunctionExecution()?.runtimeAuthority).toBeUndefined()
      expect(getModCallContext()).toBeUndefined()
      expect(functionCallAuthority(f.scope.workspace, "thread")).toBeUndefined()
      childCompletions.push(input)
      return { text: "ignored child decoration" }
    },
    invalidate: () => {
      void session.close()
    },
    closeThread: () => {
      void session.close()
    },
    close: () => {
      void session.close()
    },
    registeredTools: () => session.registeredTools(),
    hasToolCheck: () => true,
    toolCheck: (binding, input, core, origin) => {
      permissionQuestions.push(JSON.parse(JSON.stringify(input)))
      return session.checkTool(input, binding.signal, core, origin)
    },
    toolCall: (binding, input, core) => {
      callQuestions.push(JSON.parse(JSON.stringify(input)))
      return withFunctionExecution(
        {
          ...binding,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        () => session.interceptTool(input, binding.signal, core)
      )
    }
  })
  const initialCatalogs = new Map<string, string[]>()
  const definitions = new Map<string, string>()
  const replies: BaseMessage[] = []
  const childAuthorities: ModRuntimeAuthority[] = []
  const childDefinitions: string[] = []
  const childMessages: string[] = []
  let modelCalls = 0
  class Model extends FakeChatModel {
    bindTools(tools: unknown[]) {
      definitions.set(currentFunctionExecution()?.agentId ?? "main", JSON.stringify(tools))
      return this
    }
    async _generate(messages: BaseMessage[]) {
      modelCalls++
      const scope = currentFunctionExecution()
      const child = !!scope?.runtimeAuthority && scope.runtimeAuthority !== runtimeAuthority
      if (child) {
        childAuthorities.push(scope.runtimeAuthority!)
        childDefinitions.push(definitions.get(scope.runtimeAuthority!.agentId) ?? "")
        childMessages.push(JSON.stringify(messages))
      }
      const last = messages.at(-1)
      const toolReply = ToolMessage.isInstance(last)
      const searched = toolReply && last.name === "mods_tool_search"
      const done = toolReply && !searched
      if (toolReply) replies.push(last)
      const search = child && deferred && !toolReply
      const message = done
        ? new AIMessage(child ? "inspected" : "done")
        : new AIMessage({
            content: "",
            tool_calls: [
              child
                ? search
                  ? { name: "mods_tool_search", id: "search-child", args: { query: "inspect" }, type: "tool_call" }
                  : { name: "mcp__demo__inspect", id: "inspect-child", args: {}, type: "tool_call" }
                : {
                    name: "task",
                    id: "task-child",
                    args: { subagent_type: "Explore", description: "Inspect the checkout" },
                    type: "tool_call"
                  }
            ]
          })
      message.id = `${child ? "child" : "main"}-${done ? "answer" : search ? "search" : "tool"}`
      message.response_metadata = { model_name: child ? "child-provider" : "main-provider" }
      message.usage_metadata = {
        input_tokens: child ? 5 : 100,
        output_tokens: 3,
        total_tokens: child ? 8 : 103
      }
      return { generations: [{ text: done ? "done" : "", message }] }
    }
  }
  claimLocalThreadRunLease({ threadId: "thread", runId: "parent-graph", owner: "desktop" })
  try {
    const model = new Model({})
    const modTaskModels = new WeakMap<object, FunctionTaskModel>()
    modTaskModels.set(model, {
      model: "fixture-model",
      resolve: async () => ({
        provider: model, model: "fixture-model", contextWindow: 64000, inputBudget: 32000
      })
    })
    const agent = createDeepAgent({
      modFunctionRuntimeReady: true,
      model,
      modTaskModels,
      backend: f.sandbox,
      tools: [],
      threadId: "thread",
      modRuntimeAuthority: runtimeAuthority,
      modTurnRunId: "parent-graph",
      mainTodosEnabled: false,
      includeGeneralPurposeSubagent: false,
      registrySubagentSpecs: [
        {
          name: "Explore",
          description: "Read-only exploration",
          systemPrompt: "Inspect files",
          shellAccess: "read_only",
          disallowedTools: ["write_file", "edit_file", "mcp__demo__forbidden"]
        }
      ],
      toolHookMiddleware: {
        ...createToolHookMiddleware({
          workspacePath: f.scope.workspace,
          threadId: "thread",
          hookTurnId: "turn",
          runtimeAuthority,
          hookScope: createHookScope(),
          resolveHooksForContext: () => [],
          skipToolNames: new Set([
            "read_file",
            "write_file",
            "edit_file",
            "ls",
            "glob",
            "grep",
            "execute"
          ])
        }),
        beforeAgent: () => {
          const agentId = currentFunctionExecution()?.agentId ?? "main"
          initialCatalogs.set(
            agentId,
            f.manager.functionToolCatalog(f.workspace, "thread", agentId).map((tool) => tool.name)
          )
        }
      },
      summarizationTrigger: { type: "messages", value: 200 }
    })
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Explore" }] },
      // Discovery adds a graph round; exercise it within the supported minimum budget.
      { recursionLimit: deferred ? AGENT_GRAPH_RECURSION_LIMIT_MIN : 12 }
    )
    const taskReply = replies.find(
      message => ToolMessage.isInstance(message) && message.tool_call_id === "task-child"
    )
    expect(taskReply).toMatchObject({ name: "task", status: undefined, content: "inspected" })
    expect(result.messages.at(-1).content).toBe("done")
    expect(modelCalls).toBe(deferred ? 5 : 4)
    expect(childAuthorities).toHaveLength(childSteps)
    const childId = childAuthorities[0].agentId
    expect(childId).toMatch(TASK_AUTHORITY_ID)
    for (const authority of childAuthorities) expect(authority).toBe(childAuthorities[0])
    expect(childDefinitions).toHaveLength(childSteps)
    for (const definition of childDefinitions)
      expect(definition).not.toContain("mcp__demo__forbidden")
    for (const messages of childMessages)
      expect(messages).not.toContain("mcp__demo__forbidden")
    if (deferred) {
      expect(childDefinitions[0]).toContain("mods_tool_search")
      expect(childDefinitions[0]).not.toContain("mcp__demo__inspect")
      expect(childMessages[0]).toContain("mcp__demo__inspect")
      expect(childDefinitions[1]).toContain("mcp__demo__inspect")
      expect(childDefinitions[1]).toContain("Inspect actual files")
      expect(childDefinitions[1]).not.toContain("mods_tool_search")
      const searched = replies.find(
        message => ToolMessage.isInstance(message) && message.name === "mods_tool_search"
      )
      expect(searched).toMatchObject({ status: "success", tool_call_id: "search-child" })
      expect(JSON.parse(String(searched!.content))).toEqual({
        loaded: ["mcp__demo__inspect"], nextStep: true
      })
    } else {
      expect(childDefinitions[0]).toContain("mcp__demo__inspect")
      expect(childDefinitions[0]).not.toContain("mods_tool_search")
      expect(replies.some(message => ToolMessage.isInstance(message) &&
        message.name === "mods_tool_search")).toBe(false)
    }
    expect(initialCatalogs.get("main")).toContain("task")
    expect(initialCatalogs.get(childId)).toContain("read_file")
    expect(initialCatalogs.get(childId)).not.toContain("write_file")
    expect(initialCatalogs.get(childId)).not.toContain("task")
    expect(definitions.get(childId)).toContain("mcp__demo__inspect")
    expect(definitions.get(childId)).not.toContain("mcp__demo__forbidden")
    const reply = replies.find(
      (message) => ToolMessage.isInstance(message) && message.name === "mcp__demo__inspect"
    )!
    expect(reply).toBeDefined()
    const value = JSON.parse(String(reply.content))
    expect(value).toMatchObject({
      agent: childId,
      file: "isolated checkout",
      cwd: f.manager.workspaceKey(f.executionWorkspace)
    })
    expect(value.agents).toEqual([
      { id: childId, description: "Inspect the checkout", type: "Explore", status: "running" }
    ])
    expect(
      f.manager.listFunctionAgents(f.workspace, "thread", new AbortController().signal)
    ).toEqual([
      {
        id: childId,
        description: "Inspect the checkout",
        type: "Explore",
        status: "completed"
      }
    ])
    expect(value.read).toContain("isolated checkout")
    expect(value.permission).toEqual({ decision: "allow", hook: "OtherHook" })
    expect(queryQuestions).toHaveLength(2)
    expect(queryQuestions).toEqual(Array.from({ length: 2 }, () => ({
      tool: "read_file", input: { file_path: "name.txt" }
    })))
    expect(permissionQuestions).toHaveLength(3)
    expect(callQuestions).toHaveLength(3)
    for (const question of permissionQuestions) {
      const call = callQuestions.find(entry => entry.tool_use_id === question.tool_use_id)
      expect(call).toBeDefined()
      if (!call) throw Error("actual tool.check has no matching real tool.call")
      expect(question.tool).toBe(call.tool)
      expect(question.agentId).toBe(call.agentId)
      expect(question.ceiling).toBeUndefined()
      if (question.tool === "task") expect(Object.hasOwn(question, "agentId")).toBe(false)
      else expect(question.agentId).toBe(childId)
    }
    expect(value.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      "mcp__demo__forbidden"
    )
    for (const authority of childAuthorities)
      expect(() => authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    const audit = f.manager.store.audit(f.scope.workspace)
    expect(audit).toHaveLength(3)
    const task = audit.find((row) => row.identity?.agentId === "main")!
    const custom = audit.find((row) => row.identity?.toolCallId === "inspect-child")!
    expect(task.identity).toMatchObject({ agentId: "main", toolCallId: "task-child" })
    expect(custom.identity?.parentCallId).toBe(task.identity!.callId)
    expect(custom.identity?.turnId).not.toBe(task.identity?.turnId)
    await vi.waitFor(() => expect(childCompletions).toHaveLength(1))
    expect(turnStarts).not.toHaveBeenCalled()
    expect(childCompletions[0]).toMatchObject({
      agentId: childId,
      turnId: custom.identity!.turnId,
      reason: "answer",
      answer: "inspected",
      isAborted: false,
      usage: {
        model: "child-provider",
        input_tokens: childSteps * 5,
        output_tokens: childSteps * 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    })
    expect(audit.filter((row) => row.identity?.agentId === childId)).toHaveLength(2)
    expect(() => f.manager.functionToolCatalog(f.workspace, "thread", childId)).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
  } finally {
    releaseLocalThreadRunLease("thread", "desktop", "parent-graph")
    await session.close()
  }
})

it.each(["allow", "release", "replace"] as const)(
  "pins the genuine main permission authority through a %s hook without importing event identity",
  async mode => {
    const f = fixture()
    const actualScope = f.manager.functionUserScope(f.workspace, "thread")
    if (!actualScope.runtimeAuthority) throw Error("actual main runtime missing")
    const binding = { ...f.scope, ...actualScope, runtimeAuthority: actualScope.runtimeAuthority,
      signal: f.controller.signal }
    const foreign = mode === "replace" ? f.manager.createRuntimeAuthority({
      workspace: f.workspace, threadId: "foreign-thread", turnId: "foreign-turn",
      signal: f.controller.signal
    }) : undefined
    const checked = vi.fn(async (actualBinding, input) => {
      expect(input.tool).toBe("read_file")
      expect(input.input).toEqual({ file_path: "name.txt" })
      expect(typeof input.tool_use_id).toBe("string")
      expect(Object.hasOwn(input, "agentId")).toBe(false)
      expect(Object.hasOwn(input, "ceiling")).toBe(false)
      if (mode === "release") f.release()
      if (foreign) {
        expect(actualBinding).not.toBe(binding)
        actualBinding.runtimeAuthority = foreign.authority
      }
      return { decision: "allow" as const, hook: "OtherHook", ceiling: "deny" as const }
    })
    f.manager.attachFunctions({ invalidate: () => {}, closeThread: () => {}, close: () => {},
      hasToolCheck: () => true, toolCheck: checked })
    const effect = vi.fn(async () => "actual body")
    const call = f.manager.dispatch(binding, "host:read_file", { file_path: "name.txt" },
      async input => {
        await authorizeCurrentModInput("host:read_file", input)
        return effect()
      })
    if (mode === "allow") {
      await expect(call).resolves.toBe("actual body")
      expect(effect).toHaveBeenCalledOnce()
    } else {
      await expect(call).rejects.toThrow(mode === "release"
        ? "MODS_RUNTIME_INSTANCE_EXPIRED" : "MODS_RUNTIME_SCOPE_CHANGED")
      expect(effect).not.toHaveBeenCalled()
      expect(f.manager.store.audit(f.scope.workspace).some(row => row.status === "succeeded"))
        .toBe(false)
    }
    expect(checked).toHaveBeenCalledOnce()
  }
)

it.each(["error", "cancel", "refusal"])(
  "reports a real shared graph's %s even when the main graph can recover",
  async (ending) => {
    const f = fixture()
    const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
    const completions: FunctionTurnComplete[] = []
    f.manager.attachFunctions({
      invalidate: () => {},
      closeThread: () => {},
      close: () => {},
      turnComplete: async (_workspace, _thread, input) => {
        completions.push(input)
        return { text: input.answer }
      }
    })
    let childCalls = 0
    let childAgentId: string | undefined
    class Model extends FakeChatModel {
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]) {
        const authority = currentFunctionExecution()?.runtimeAuthority
        if (authority && authority !== parent) {
          childAgentId = authority.agentId
          childCalls++
          if (ending === "cancel") {
            f.controller.abort()
            f.controller.signal.throwIfAborted()
          }
          if (ending === "refusal") {
            const message = new AIMessage({
              content: "",
              response_metadata: { finish_reason: "content_filter" }
            })
            return { generations: [{ message, text: "" }] }
          }
          throw new Error("controlled child model failure")
        }
        const taskResult = messages.at(-1)
        if (ending === "refusal" && ToolMessage.isInstance(taskResult))
          expect(taskResult.status).toBe("error")
        const message = ToolMessage.isInstance(taskResult)
          ? new AIMessage("parent recovered")
          : new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "task",
                  id: "failing-child",
                  type: "tool_call",
                  args: { subagent_type: "Explore", description: "Inspect" }
                }
              ]
            })
        return { generations: [{ message, text: String(message.content) }] }
      }
    }
    const model = new Model({})
    const modTaskModels = new WeakMap<object, FunctionTaskModel>()
    modTaskModels.set(model, {
      model: "fixture-model",
      resolve: async () => ({
        provider: model, model: "fixture-model", contextWindow: 64000, inputBudget: 32000
      })
    })
    const agent = createDeepAgent({
      modFunctionRuntimeReady: true,
      model,
      modTaskModels,
      backend: f.sandbox,
      tools: [],
      threadId: "thread",
      modRuntimeAuthority: parent,
      modTurnRunId: "physical",
      mainTodosEnabled: false,
      includeGeneralPurposeSubagent: false,
      registrySubagentSpecs: [
        { name: "Explore", description: "Read", systemPrompt: "Inspect", shellAccess: "read_only" }
      ],
      toolHookMiddleware: createToolHookMiddleware({
        workspacePath: f.scope.workspace,
        threadId: "thread",
        hookTurnId: parent.turnId,
        runtimeAuthority: parent,
        hookScope: createHookScope(),
        resolveHooksForContext: () => []
      }),
      summarizationTrigger: { type: "messages", value: 200 }
    })
    const result = await agent
      .invoke(
        { messages: [{ role: "user", content: "Inspect" }] },
        { recursionLimit: 12, signal: f.controller.signal }
      )
      .catch((error: unknown) => error)
    expect(childCalls).toBe(1)
    expect(childAgentId).toMatch(TASK_AUTHORITY_ID)
    if (ending === "cancel") expect(result).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(completions[0]).toMatchObject({
      agentId: childAgentId,
      answer: "",
      reason: ending === "cancel" ? "aborted" : ending,
      isAborted: ending === "cancel"
    })
    expect(completions[0].turnId).not.toBe(parent.turnId)
    expect(completions[0].usage).toBeUndefined()
    if (ending === "refusal") {
      expect(completions[0]).toHaveProperty("refusal", { category: null, explanation: null })
      expect(result).not.toBeInstanceOf(Error)
    }
  }
)

it("clears inherited renderer ownership for an id-less task while assigning a fresh private agent", async () => {
  const seen: Array<{ metadata: unknown; configurable: unknown }> = []
  const raw = tool(
    async (_, config) => {
      seen.push({ metadata: config.metadata, configurable: config.configurable })
      return "ok"
    },
    {
      name: "task",
      description: "Inspect task ownership",
      schema: z.object({ description: z.string() })
    }
  )
  const agents: string[] = []
  const wrapped = wrapTaskToolWithOwnerMetadata(raw, undefined, undefined, async (input, run) => {
    agents.push(input.agentId)
    return run()
  })
  const parent = {
    metadata: { [SUBAGENT_OWNER_METADATA_KEY]: "parent-task", marker: "keep" },
    configurable: { [SUBAGENT_OWNER_METADATA_KEY]: "parent-task", marker: "keep" }
  }
  await wrapped.invoke({ description: "first child" }, parent)
  await wrapped.invoke({ description: "second child" }, parent)
  expect(new Set(agents).size).toBe(2)
  for (const agent of agents) expect(agent).toMatch(TASK_AUTHORITY_ID)
  for (const config of seen) {
    expect(config.metadata).not.toHaveProperty(SUBAGENT_OWNER_METADATA_KEY)
    expect(config.configurable).not.toHaveProperty(SUBAGENT_OWNER_METADATA_KEY)
    expect(config.metadata).toMatchObject({ marker: "keep" })
    expect(config.configurable).toMatchObject({ marker: "keep" })
  }
  expect(parent.metadata[SUBAGENT_OWNER_METADATA_KEY]).toBe("parent-task")
})

it("keeps repeated renderer id main out of two concurrent task authorities", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const spawned: string[] = []
  const seen: ModRuntimeAuthority[] = []
  const raw = tool(async (input, config) => {
    const authority = currentFunctionExecution()!.runtimeAuthority!
    expect(authority).not.toBe(parent)
    expect(authority.agentId).not.toBe("main")
    expect(config.metadata?.[SUBAGENT_OWNER_METADATA_KEY]).toBe("main")
    expect(config.configurable?.[SUBAGENT_OWNER_METADATA_KEY]).toBe("main")
    expect(getHookAgentIdFromRequest({ runtime: config })).toBe("main")
    expect(config.toolCall?.id).toBe("main")
    seen.push(authority)
    await Promise.resolve()
    authority.assertLive()
    return new ToolMessage({
      content: `task:${input.description}`, name: "task", tool_call_id: config.toolCall!.id!
    })
  }, {
    name: "task", description: "Concurrent task contract",
    schema: z.object({ description: z.string(), subagent_type: z.string() })
  })
  const wrapped = wrapTaskToolWithOwnerMetadata(raw, undefined, undefined, (input, run) => {
    spawned.push(input.agentId)
    return f.manager.withSharedAgent(
      parent, input.agentId, input.signal, { blockedToolNames: new Set(), readOnly: false },
      run, undefined, { type: input.subagentType!, description: input.description! }
    )
  })
  const inherited = {
    metadata: { [SUBAGENT_OWNER_METADATA_KEY]: "forged-authority", marker: "keep" },
    configurable: { [SUBAGENT_OWNER_METADATA_KEY]: "forged-authority" }
  }
  const results = await Promise.all(["A", "B"].map(description => wrapped.invoke({
    name: "task", type: "tool_call", id: "main",
    args: { description, subagent_type: "general-purpose" }
  }, inherited)))
  expect(new Set(spawned).size).toBe(2)
  for (const id of spawned) expect(id).toMatch(TASK_AUTHORITY_ID)
  expect(new Set(seen).size).toBe(2)
  expect(seen.map(authority => authority.agentId).sort()).toEqual([...spawned].sort())
  expect(results).toEqual(["A", "B"].map(description => expect.objectContaining({
    name: "task", tool_call_id: "main", content: `task:${description}`
  })))
  expect(inherited.metadata).toEqual({
    [SUBAGENT_OWNER_METADATA_KEY]: "forged-authority", marker: "keep"
  })
  expect(inherited.configurable).toEqual({ [SUBAGENT_OWNER_METADATA_KEY]: "forged-authority" })
  for (const authority of seen)
    expect(() => authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  parent.assertLive()
})

it("does not lend built-in authority to a custom agent that overrides general-purpose", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const entered: Array<ReturnType<typeof currentFunctionExecution>> = []
  let modelCalls = 0
  class Model extends FakeChatModel {
    bindTools() {
      return this
    }
    async _generate(messages: BaseMessage[]) {
      modelCalls++
      const scope = currentFunctionExecution()
      const custom = messages.some(message => message.type === "system" &&
        message.text.includes("Custom overridden general-purpose role"))
      if (custom) entered.push(scope)
      const done = custom || ToolMessage.isInstance(messages.at(-1))
      const message = done
        ? new AIMessage("done")
        : new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "task",
                id: "custom-child",
                type: "tool_call",
                args: { subagent_type: "general-purpose", description: "Inspect" }
              }
            ]
          })
      return { generations: [{ text: done ? "done" : "", message }] }
    }
  }
  const agent = createDeepAgent({
    modFunctionRuntimeReady: true,
    model: new Model({}),
    backend: f.sandbox,
    tools: [],
    threadId: "thread",
    modRuntimeAuthority: parent,
    mainTodosEnabled: false,
    subagents: [{
      name: "general-purpose", description: "Custom role",
      systemPrompt: "Custom overridden general-purpose role"
    }],
    summarizationTrigger: { type: "messages", value: 200 }
  })
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "Inspect" }] },
    { recursionLimit: 12 }
  )
  expect(result.messages.at(-1).content).toBe("done")
  expect(modelCalls).toBe(3)
  expect(entered).toHaveLength(1)
  expect(entered[0]?.agentId).toMatch(TASK_AUTHORITY_ID)
  expect(entered[0]?.runtimeAuthority).toBeUndefined()
  parent.assertLive()
})

it("fresh UI entry after Mods invalidation does not borrow an unbound runtime turn", async () => {
  const f = fixture()
  const previous = f.manager.functionUserScope(f.workspace, "thread")
  expect(previous.runtimeAuthority).toBeDefined()
  f.manager.invalidateAll()
  expect(f.manager.functionUserScope(f.workspace, "thread")).toEqual({})
  expect(f.manager.functionRuntimeScope(f.workspace, "thread").bound).toBe(false)
  await expect(withFunctionExecution({ ...f.scope, ...previous }, async () =>
    f.manager.functionRuntimeScope(f.workspace, "thread")
  )).rejects.toThrow("MODS_THREAD_CONTEXT_REQUIRED")
})

it("captures actual native and middleware tools at graph construction without a model request", () => {
  const f = fixture()
  const authority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const generated = vi.fn()
  class Model extends FakeChatModel {
    bindTools() {
      return this
    }
    async _generate(): Promise<never> {
      generated()
      throw Error("A catalog query must not call the model")
    }
  }
  const declared = tool(async () => "unused", {
    name: "declared",
    description: "Declared engine tool",
    schema: z.object({})
  })
  const hidden = tool(async () => "unused", {
    name: "hidden",
    description: "Transport blocked",
    schema: z.object({})
  })
  const fromMiddleware = tool(async () => "unused", {
    name: "middleware_tool",
    description: "Middleware tool",
    schema: z.object({})
  })
  createDeepAgent({
    modFunctionRuntimeReady: true,
    model: new Model({}),
    backend: f.sandbox,
    threadId: "thread",
    modRuntimeAuthority: authority,
    tools: [declared, hidden],
    middleware: [{ name: "extra", tools: [fromMiddleware] }],
    mainBlockedToolNames: ["hidden"],
    mainSubagentsEnabled: false,
    mainTodosEnabled: false
  })
  const initial = f.manager.functionToolCatalog(f.workspace, "thread")
  expect(initial).toContainEqual({
    name: "declared",
    description: "Declared engine tool",
    mcp: false
  })
  expect(initial).toContainEqual({
    name: "middleware_tool",
    description: "Middleware tool",
    mcp: false
  })
  expect(initial.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["read_file", "execute", "task_output"])
  )
  expect(initial.map((tool) => tool.name)).not.toContain("hidden")
  expect(initial.map((tool) => tool.name)).not.toContain("task")
  expect(generated).not.toHaveBeenCalled()
  expect(f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority).toBe(authority)
  expect(f.manager.store.audit(f.scope.workspace)).toHaveLength(0)
  authority.assertLive()
})

it("keeps live catalogs at capacity and only reclaims expired entries without borrowing SDK scope", async () => {
  const f = fixture()
  let expired = false
  for (let index = 0; index < 100; index++)
    f.manager.bindFunctionToolCatalog(
      {
        workspace: f.workspace,
        threadId: `catalog-${index}`,
        turnId: "turn",
        assertLive: () => {
          if (index === 50 && expired) throw Error("expired")
        }
      },
      [{ name: `tool-${index}`, description: "Actual host metadata", mcp: false }]
    )
  const next = { workspace: f.workspace, threadId: "catalog-next", turnId: "turn" }
  expect(() => f.manager.bindFunctionToolCatalog(next, [])).toThrow("MODS_RUNTIME_CAPACITY")
  expect(f.manager.functionToolCatalog(f.workspace, "catalog-0")[0].name).toBe("tool-0")
  expired = true
  await withFunctionExecution(f.scope, async () => f.manager.bindFunctionToolCatalog(next, []))
  expect(f.manager.functionToolCatalog(f.workspace, "catalog-next")).toEqual([])
  expect(f.manager.functionToolCatalog(f.workspace, "catalog-0")[0].name).toBe("tool-0")
  expect(() => f.manager.functionToolCatalog(f.workspace, "catalog-50")).toThrow(
    "MODS_TOOL_CONTEXT_REQUIRED"
  )
})

it("lists actual shared child instances with lifecycle status and parent identity", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const rows = () =>
    f.manager.listFunctionAgents(f.workspace, "thread", new AbortController().signal)
  expect(rows()).toEqual([])
  const access = { blockedToolNames: new Set<string>(), readOnly: true }
  await f.manager.withSharedAgent(
    parent,
    "listed-child",
    undefined,
    access,
    async () => {
      expect(rows()).toEqual([
        { id: "listed-child", description: "Inspect", type: "Explore", status: "running" }
      ])
      const child = currentFunctionExecution()!.runtimeAuthority!
      await f.manager.withSharedAgent(
        child,
        "nested-child",
        undefined,
        access,
        async () => {
          expect(rows().find((row) => row.id === "nested-child")).toMatchObject({
            parentId: "listed-child",
            status: "running"
          })
        },
        undefined,
        { description: "Nested", type: "Explore" }
      )
    },
    undefined,
    { description: "Inspect", type: "Explore" }
  )
  expect(rows().map((row) => row.status)).toEqual(["completed", "completed"])
  f.manager.configure(f.workspace, false, false)
  expect(() => rows()).toThrow()
  f.manager.configure(f.workspace, true, false)
  expect(rows()).toEqual([])
})
it.each(["failed", "killed"] as const)(
  "lists the actual shared child %s result without changing the thrown task error",
  async (status) => {
    const f = fixture()
    const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
    const controller = new AbortController()
    const error = new Error("native child failed")
    await expect(
      f.manager.withSharedAgent(
        parent,
        "terminal-child",
        controller.signal,
        { blockedToolNames: new Set<string>(), readOnly: true },
        async () => {
          if (status === "killed") controller.abort()
          throw error
        },
        undefined,
        { description: "Terminal", type: "Explore" }
      )
    ).rejects.toBe(error)
    expect(
      f.manager.listFunctionAgents(f.workspace, "thread", new AbortController().signal)[0].status
    ).toBe(status)
  }
)

it.each(["cancel", "disable", "replace", "workspace"])(
  "does not publish agent instances after %s while filtering",
  async (action) => {
    const f = fixture()
    const controller = new AbortController()
    let changed = false
    let resume!: () => void
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(f.manager, "publish").mockImplementationOnce(async (_workspace, value) => {
      entered()
      await pending
      return value
    })
    const result = queryFunctionAgentList(
      f.manager,
      f.workspace,
      "thread",
      controller.signal,
      () => {
        if (changed) throw Error("workspace changed")
      }
    )
    const rejected = expect(result).rejects.toThrow()
    await started
    if (action === "cancel") controller.abort()
    else if (action === "disable") f.manager.configure(f.workspace, false, false)
    else if (action === "replace")
      f.manager.createRuntimeAuthority({
        workspace: f.workspace,
        threadId: "thread",
        turnId: "replacement"
      })
    else changed = true
    resume()
    await rejected
  }
)

it("keeps an original native agent list alive when an unrelated Mod grant is revoked", async () => {
  const f = fixture()
  let enter!: () => void
  let resume!: () => void
  const entered = new Promise<void>((done) => { enter = done })
  const released = new Promise<void>((done) => { resume = done })
  const publish = vi.spyOn(f.manager, "publish").mockImplementationOnce(async (_workspace, value) => {
    enter()
    await released
    return value
  })
  const result = queryFunctionAgentList(
    f.manager,
    f.workspace,
    "thread",
    new AbortController().signal,
    () => {}
  )
  await entered
  f.manager.revoke(f.workspace, f.grant.modId)
  resume()
  await expect(result).resolves.toEqual([])
  expect(publish).toHaveBeenCalledOnce()
})

it.each(["off", "no-source", "unapproved"] as const)(
  "preserves the existing graph budget with Mods %s",
  async (mode) => {
    const f = fixture()
    const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
    const plugin = join(f.root, "unapproved")
    mkdirSync(join(plugin, "hooks"), { recursive: true })
    writeFileSync(join(plugin, "plugin.json"), '{"name":"unapproved","version":"1.0.0"}')
    writeFileSync(join(plugin, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    writeFileSync(
      join(plugin, "hooks/register.ts"),
      'export function register(on){on("session.start",()=>{})}'
    )
    const createClient = vi.fn(() => {
      throw Error("Readiness must not create a VM")
    })
    const functions = new FunctionModsManager(
      f.manager.store,
      {
        enabled: () => f.manager.isEnabled(f.workspace),
        plugins: () =>
          mode === "unapproved"
            ? [{ id: "unapproved", name: "unapproved", path: plugin, enabled: true }]
            : [],
        publish: async (_workspace, value) => value,
        changed: () => {}
      },
      createClient
    )
    f.manager.attachFunctions({
      runtimeReady: (...args) => functions.runtimeReady(...args),
      invalidate: (workspace) => functions.invalidate(workspace),
      closeThread: (threadId) => functions.closeThread(threadId),
      close: () => functions.close()
    })
    if (mode === "off") f.manager.configure(f.workspace, false, false)
    const ready = await f.manager.prepareFunctionRuntime(f.workspace, "thread")
    expect(ready).toBe(false)
    expect(createClient).not.toHaveBeenCalled()
    let calls = 0
    class Model extends FakeChatModel {
      bindTools() {
        return this
      }
      async _generate() {
        const index = ++calls
        const message = new AIMessage(
          index < 3
            ? {
                content: `step-${index}`,
                tool_calls: [{ name: "probe", id: `call-${index}`, args: {}, type: "tool_call" }]
              }
            : { content: "done" }
        )
        message.id = `model-${index}`
        return { generations: [{ text: index < 3 ? `step-${index}` : "done", message }] }
      }
    }
    const notify = vi.fn(async () => undefined)
    const model = new Model({})
    const activate = vi.fn(() => {
      f.manager.updateFunctionSessionModel(parent, "configured", 64000)
      return () => f.manager.updateFunctionSessionModel(parent, "configured", 64000)
    })
    const agent = createDeepAgent({
      model,
      backend: f.sandbox,
      tools: [
        tool(async () => "ok", { name: "probe", description: "probe", schema: z.object({}) })
      ],
      threadId: "thread",
      ...(mode !== "off" ? { modRuntimeAuthority: parent } : {}),
      modSessionModel: "configured",
      modFunctionRuntimeReady: ready,
      modStepModel: {
        resolve: async () => ({ model: "configured", provider: model, contextWindow: 64000, inputBudget: 32000 }),
        activate
      },
      mainTodosEnabled: false,
      mainFilesystemEnabled: false,
      mainSubagentsEnabled: false,
      modInstructions: {
        sources: [{ path: "AGENTS.md", content: "instructions" }],
        enabled: () => ready,
        assertLive: () => {},
        notify,
        failed: () => {}
      },
      modToolBatch: { enabled: () => ready, assertLive: () => {}, notify },
      summarizationTrigger: { type: "messages", value: 200 }
    })
    const graph = (await agent.getGraphAsync()) as unknown as { nodes: Record<string, unknown> }
    const nodes = Object.keys(graph.nodes)
    expect(nodes).toHaveLength(8)
    expect(
      nodes.some((name) => /functionSessionView|instructionsLoaded|functionToolBatch/.test(name))
    ).toBe(false)
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "probe twice" }] },
      { recursionLimit: 20 }
    )
    expect(result.messages.at(-1).content).toBe("done")
    expect(calls).toBe(3)
    expect(activate).toHaveBeenCalledTimes(mode === "off" ? 0 : 3)
    expect(notify).not.toHaveBeenCalled()
  }
)
it("retains native instruction and batch observers without an authorized Function Mods graph", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  class Model extends FakeChatModel {
    bindTools() {
      return this
    }
    async _generate() {
      return { generations: [{ text: "done", message: new AIMessage("done") }] }
    }
  }
  const instruction = vi.fn(async () => {})
  const batch = vi.fn(async () => undefined)
  const agent = createDeepAgent({
    model: new Model({}),
    backend: f.sandbox,
    tools: [],
    threadId: "thread",
    modRuntimeAuthority: parent,
    modSessionModel: "configured",
    modFunctionRuntimeReady: false,
    mainTodosEnabled: false,
    mainFilesystemEnabled: false,
    mainSubagentsEnabled: false,
    modInstructions: {
      sources: [{ path: "AGENTS.md", content: "native instructions" }],
      enabled: () => true,
      assertLive: () => {},
      notify: instruction,
      failed: () => {}
    },
    modToolBatch: { enabled: () => true, assertLive: () => {}, notify: batch },
    summarizationTrigger: { type: "messages", value: 200 }
  })
  const graph = (await agent.getGraphAsync()) as unknown as { nodes: Record<string, unknown> }
  expect(Object.keys(graph.nodes)).toContain("instructionsLoaded.before_model")
  expect(Object.keys(graph.nodes)).toContain("functionToolBatch.after_model")
  expect(Object.keys(graph.nodes)).not.toContain("functionSessionView.before_agent")
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "finish" }] },
    { recursionLimit: 20 }
  )
  expect(result.messages.at(-1).content).toBe("done")
  expect(instruction).toHaveBeenCalledOnce()
  expect(batch).not.toHaveBeenCalled()
})
