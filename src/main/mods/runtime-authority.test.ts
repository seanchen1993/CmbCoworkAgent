import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "../agent/local-sandbox"
import { ModsManager, getModsManager, setModsManager } from "./manager"
import { withFunctionExecution } from "./v2/execution-context"
import { ProjectFunctionFiles } from "./v2/file-access"
import { FunctionRegisteredTools } from "./v2/registered-tools"
import { functionCallAuthority, withFunctionAgentExecution } from "./v2/host-call"
import { modCallContext } from "./context"
import type { ModRuntimeAuthority } from "./runtime-instance"
import {
  createDeepAgent,
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
import { currentFunctionExecution } from "./v2/execution-context"
import { functionSdkToolInput } from "./v2/tool-sdk"

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
    for (const row of audit)
      expect(row).toMatchObject({
        status: "succeeded",
        publication: "published",
        identity: { agentId: "worker", turnId: "turn", modId: "function:demo" }
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

it("serves a registered tool and nested file SDK inside a real deepagents task with the role's authority", async () => {
  const f = fixture()
  const runtimeAuthority = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.tool.register({name:"inspect",description:"Inspect actual files"});
      await $.tool.register({name:"forbidden",description:"Hidden from Explore"});
      return next(e);
    });
    on("tool.call",{tool:"mcp__demo__inspect"},async($,e)=>{
      const read=await $.tool.call({tool:"read_file",file_path:"name.txt"});
      return {result:{agent:e.agentId,read:read.text,cwd:await $.session.cwd(),
        file:await $.fs.read("name.txt"),tools:await $.tool.list()}};
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
      listTools: async () =>
        f.manager.functionToolCatalog(f.workspace, "thread", currentFunctionExecution()?.agentId),
      filterTools: (tools) => f.manager.filterFunctionTools(f.workspace, "thread", tools),
      registeredTool: (_, input, origin, signal, run, caller) =>
        registered.call(f.scope.workspace, "thread", f.grant, input, origin, signal, run, caller),
      callTool: async (_, input, signal) => {
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
  f.manager.attachFunctions({
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
    toolCheck: (binding, input, core, origin) =>
      session.checkTool(input, binding.signal, core, origin),
    toolCall: (binding, input, core) =>
      withFunctionExecution(
        {
          ...binding,
          userInitiated: false,
          leased: true,
          immediate: false
        },
        () => session.interceptTool(input, binding.signal, core)
      )
  })
  const initialCatalogs = new Map<string, string[]>()
  const definitions = new Map<string, string>()
  const replies: BaseMessage[] = []
  const childAuthorities: ModRuntimeAuthority[] = []
  class Model extends FakeChatModel {
    bindTools(tools: unknown[]) {
      definitions.set(currentFunctionExecution()?.agentId ?? "main", JSON.stringify(tools))
      return this
    }
    async _generate(messages: BaseMessage[]) {
      const scope = currentFunctionExecution()
      const child = scope?.agentId === "task-child"
      if (child) childAuthorities.push(scope.runtimeAuthority!)
      const done = ToolMessage.isInstance(messages.at(-1))
      if (done) replies.push(messages.at(-1)!)
      const message = done
        ? new AIMessage(child ? "inspected" : "done")
        : new AIMessage({
            content: "",
            tool_calls: [
              child
                ? { name: "mcp__demo__inspect", id: "inspect-child", args: {}, type: "tool_call" }
                : {
                    name: "task",
                    id: "task-child",
                    args: { subagent_type: "Explore", description: "Inspect the checkout" },
                    type: "tool_call"
                  }
            ]
          })
      return { generations: [{ text: done ? "done" : "", message }] }
    }
  }
  try {
    const agent = createDeepAgent({
      model: new Model({}),
      backend: f.sandbox,
      tools: [],
      threadId: "thread",
      modRuntimeAuthority: runtimeAuthority,
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
      { recursionLimit: 12 }
    )
    expect(result.messages.at(-1).content).toBe("done")
    expect(initialCatalogs.get("main")).toContain("task")
    expect(initialCatalogs.get("task-child")).toContain("read_file")
    expect(initialCatalogs.get("task-child")).not.toContain("write_file")
    expect(initialCatalogs.get("task-child")).not.toContain("task")
    expect(definitions.get("task-child")).toContain("mcp__demo__inspect")
    expect(definitions.get("task-child")).not.toContain("mcp__demo__forbidden")
    const reply = replies.find(
      (message) => ToolMessage.isInstance(message) && message.name === "mcp__demo__inspect"
    )!
    expect(reply).toBeDefined()
    const value = JSON.parse(String(reply.content))
    expect(value).toMatchObject({
      agent: "task-child",
      file: "isolated checkout",
      cwd: f.manager.workspaceKey(f.executionWorkspace)
    })
    expect(value.read).toContain("isolated checkout")
    expect(value.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      "mcp__demo__forbidden"
    )
    for (const authority of childAuthorities)
      expect(() => authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    const audit = f.manager.store.audit(f.scope.workspace)
    expect(audit).toHaveLength(3)
    const task = audit.find((row) => row.identity?.agentId === "main")!
    const custom = audit.find((row) => row.identity?.toolCallId === "inspect-child")!
    expect(task.identity).toMatchObject({ agentId: "main" })
    expect(custom.identity?.parentCallId).toBe(task.identity!.callId)
    expect(audit.filter((row) => row.identity?.agentId === "task-child")).toHaveLength(2)
    expect(() => f.manager.functionToolCatalog(f.workspace, "thread", "task-child")).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
  } finally {
    await session.close()
  }
})

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
  for (const agent of agents) expect(agent).toMatch(/^mod-task:idless-task-/)
  for (const config of seen) {
    expect(config.metadata).not.toHaveProperty(SUBAGENT_OWNER_METADATA_KEY)
    expect(config.configurable).not.toHaveProperty(SUBAGENT_OWNER_METADATA_KEY)
    expect(config.metadata).toMatchObject({ marker: "keep" })
    expect(config.configurable).toMatchObject({ marker: "keep" })
  }
  expect(parent.metadata[SUBAGENT_OWNER_METADATA_KEY]).toBe("parent-task")
})

it("does not lend built-in authority to a custom agent that overrides general-purpose", async () => {
  const f = fixture()
  const parent = f.manager.functionUserScope(f.workspace, "thread").runtimeAuthority!
  const entered: Array<ReturnType<typeof currentFunctionExecution>> = []
  class Model extends FakeChatModel {
    bindTools() {
      return this
    }
    async _generate(messages: BaseMessage[]) {
      const scope = currentFunctionExecution()
      if (scope?.agentId === "custom-child") entered.push(scope)
      const done = scope?.agentId === "custom-child" || ToolMessage.isInstance(messages.at(-1))
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
    model: new Model({}),
    backend: f.sandbox,
    tools: [],
    threadId: "thread",
    modRuntimeAuthority: parent,
    mainTodosEnabled: false,
    subagents: [{ name: "general-purpose", description: "Custom role", systemPrompt: "Inspect" }],
    summarizationTrigger: { type: "messages", value: 200 }
  })
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "Inspect" }] },
    { recursionLimit: 12 }
  )
  expect(result.messages.at(-1).content).toBe("done")
  expect(entered).toHaveLength(1)
  expect(entered[0]?.runtimeAuthority).toBeUndefined()
  parent.assertLive()
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
