import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModGuestRuntime } from "./guest-runtime"
import type { ModHostCall } from "./guest-runtime"
import type { ModObject, ModUiNode } from "../../shared/mods/types"

vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const g = await ModGuestRuntime.create(code)
      this.guests.set(id, g)
      return g.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      return this.guests.get(id)!.invoke(handler, event, call)
    }
    async unload(id: string) {
      this.guests.get(id)?.dispose()
      this.guests.delete(id)
    }
    stop() {
      for (const g of this.guests.values()) g.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))
import {
  ModsManager,
  authorizeCurrentModInput,
  hasModOperationApproval,
  getModsManager,
  setModsManager,
  setModsUnavailable
} from "./manager"
import type { ModThreadBinding } from "./manager"
import { DEFAULT_MOD_POLICY, type ManagedModDeployment } from "./policy"
import { withScopedModMcp, withRawModMcp } from "./adapters"
import { withFunctionExecution } from "./v2/execution-context"
import { FunctionRegisteredTools } from "./v2/registered-tools"
import { getModCallContext } from "./context"
import type { McpCapabilityTool } from "../mcp/capability-types"
import { beforeModToolExecution } from "./execution-error"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

it("does not lend a main backend to a model-raised unbound child through a legacy Mod", async () => {
  const f = await fixture()
  const manifestPath = join(f.plugin, "manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.permissions.readTools = ["host:read_file"]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(
    join(f.plugin, "index.ts"),
    `export default {register(on){
    on.tool({id:"read",tools:["host:write_file"]},async($,e,next)=>{
      try { await $.tools.invoke("host:read_file",{file_path:"private.txt"}) } catch {}
      const result=await next({args:e.args});
      return {kind:"result",receipt:result.receipt,projection:result.projection}
    })
  }}`
  )
  const digest = (await f.manager.status(f.root)).mods[0].digest!
  await f.manager.approve(f.root, "plugin", digest)
  f.manager.configure(f.root, true, false)
  const mainRead = vi.fn(async () => "main-only data")
  f.manager.bindThread({ ...f.scope, invokeTool: mainRead })
  const core = vi.fn(async () => "child model result")
  expect(
    await f.manager.dispatch(
      { ...f.scope, agentId: "child-instance" },
      "host:write_file",
      { content: "model arguments" },
      core
    )
  ).toBe("child model result")
  expect(mainRead).not.toHaveBeenCalled()
  expect(core).toHaveBeenCalledOnce()
})

it("does not route a native v2 manifest into the v1 runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-mods-v2-routing-"))
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith("cmb-mods-v2-routing-")
  )
    throw Error("Unexpected cleanup path")
  mkdirSync(join(root, ".claude-plugin"))
  writeFileSync(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "v2", mods: "manifest.json" })
  )
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "v2", entry: "register.ts" })
  )
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [{ id: "v2", name: "v2", path: root, enabled: true }],
    async () => true,
    () => undefined
  )
  try {
    expect((await manager.status(root)).mods).toEqual([])
  } finally {
    manager.close()
    rmSync(root, { recursive: true, force: true })
  }
})

async function fixture(
  deployment?: ManagedModDeployment,
  globalEnabled: () => boolean = () => true
) {
  const root = mkdtempSync(join(tmpdir(), "cmb-mods-manager-"))
  const plugin = join(root, "plugin")
  mkdirSync(join(plugin, ".codex-plugin"), { recursive: true })
  writeFileSync(
    join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "Review", mods: "manifest.json" })
  )
  writeFileSync(
    join(plugin, "manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v1",
      id: "review",
      name: "Review",
      entry: "index.ts",
      activation: "project",
      events: ["tool.call", "command.run", "ui.render", "prompt.context"],
      tools: ["host:write_file"],
      permissions: {
        readTools: [],
        writeTools: ["host:execute"],
        context: ["project.name"],
        store: false
      }
    })
  )
  writeFileSync(
    join(plugin, "index.ts"),
    `export default { register(on) {
    on.tool({id:"tool",tools:["host:write_file"]},async($,e,next)=> {
      const r=await next({args:{...e.args,content:e.args.content+" checked"}});
      return {kind:"result",receipt:r.receipt,projection:r.projection}
    });
    on.context({id:"context"},async($)=>[{text:"Context "+await $.context.get("project.name")}]);
    on.command({id:"run",command:"review:run"},async($)=> {
      const r=await $.tools.invoke("host:execute",{command:"echo verified"}); return r.projection
    });
    on.ui({id:"card",slot:"tool.result.after"},async()=>[{type:"button",label:"Verify",command:"review:run",args:{}}]);
    on.ui({id:"summary",slot:"turn.summary"},async(e)=>[{type:"text",text:e.model.text}]);
  } }`
  )
  const confirm = vi.fn(async () => true)
  const notify = vi.fn()
  const plugins = [{ id: "plugin", name: "Review", path: plugin, enabled: true }]
  const control = join(root, "control.sqlite")
  const manager = new ModsManager(
    control,
    () => plugins,
    confirm,
    notify,
    undefined,
    deployment,
    globalEnabled
  )
  cleanup.push(() => {
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-mods-manager-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  const scope = { workspace: root, threadId: "thread", turnId: "turn" }
  const executions: unknown[] = []
  manager.bindThread({
    ...scope,
    invokeTool: (id, args) =>
      manager.dispatch(scope, id, args, async (input) => {
        await authorizeCurrentModInput(id, input)
        expect(hasModOperationApproval(id, input)).toBe(true)
        expect(hasModOperationApproval(id, { command: "different" })).toBe(false)
        executions.push(input)
        return { output: "verified", exitCode: 0 }
      })
  })
  const digest = (await manager.status(root)).mods[0].digest!
  const enable = async () => {
    await manager.approve(root, "plugin", digest)
    manager.configure(root, true, false)
  }
  const dispatch = () =>
    manager.dispatch(scope, "host:write_file", { content: "text" }, async (args) =>
      String(args.content)
    )
  const button = (): Extract<ModUiNode, { type: "button" }> =>
    manager.listCards("thread", "", 7)[0].nodes[0] as Extract<ModUiNode, { type: "button" }>
  return {
    manager,
    root,
    plugin,
    scope,
    confirm,
    notify,
    enable,
    dispatch,
    button,
    executions,
    plugins,
    digest
  }
}

describe("project Mods lifecycle and UI authority", () => {
  it("honors the application switch and falls through to the native path when disabled", async () => {
    let globalEnabled = true
    const f = await fixture(undefined, () => globalEnabled)
    await f.enable()
    expect((await f.manager.status(f.root)).globalEnabled).toBe(true)
    expect(f.manager.isEnabled(f.root)).toBe(true)
    globalEnabled = false
    f.manager.invalidateAll()
    expect((await f.manager.status(f.root)).globalEnabled).toBe(false)
    expect(f.manager.isEnabled(f.root)).toBe(false)
    expect(f.manager.isActive(f.root)).toBe(false)
    expect(f.manager.protects(f.root)).toBe(false)
    expect(await f.dispatch()).toBe("text")
    expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
    await f.manager.finishTurn(f.scope.threadId)
  })

  it("queries real permissions without approval, execution or receipt writes", async () => {
    const f = await fixture()
    f.manager.configure(f.root, true, false)
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:query", "snapshot", true)
    const query = vi.fn(async () => ({ decision: "allow" as const }))
    f.manager.bindThread({ ...f.scope, queryTool: query })
    const fallback = vi.fn(async () => ({ decision: "deny" as const }))
    const run = (tool: string) =>
      f.manager.queryFunctionTool(
        workspace,
        "thread",
        grant,
        tool,
        {},
        new AbortController().signal,
        fallback
      )
    expect(await run("host:read_file")).toEqual({ decision: "allow" })
    expect(await run("host:write_file")).toMatchObject({ decision: "deny" })
    await withFunctionExecution(
      {
        workspace,
        threadId: "thread",
        turnId: "turn",
        leased: true,
        userInitiated: true,
        immediate: false
      },
      async () => {
        expect(await run("host:write_file")).toMatchObject({ decision: "ask" })
      }
    )
    expect(query).toHaveBeenCalledTimes(3)
    expect(fallback).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.manager.store.audit(workspace)).toEqual([])
  })

  it("rejects a permission query whose native binding was replaced while awaiting metadata", async () => {
    const f = await fixture()
    f.manager.configure(f.root, true, false)
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:query", "snapshot", true)
    const query = vi.fn(async () => {
      f.manager.bindThread(f.scope)
      return { decision: "allow" as const }
    })
    f.manager.bindThread({ ...f.scope, queryTool: query })
    await expect(
      f.manager.queryFunctionTool(
        workspace,
        "thread",
        grant,
        "host:read_file",
        {},
        new AbortController().signal,
        query
      )
    ).rejects.toThrow("CONTEXT_EXPIRED")
    expect(f.manager.store.audit(workspace)).toEqual([])
  })

  it.each(["allow", "deny", "ask"] as const)(
    "applies a %s permission hook to the actual model tool with pinned real input and origin",
    async (decision) => {
      const f = await fixture()
      f.manager.configure(f.root, true, false)
      const workspace = f.manager.workspaceKey(f.root)
      const checked = vi.fn(async (_binding, input, _core, origin) => {
        expect(input).toMatchObject({ tool: "read_file", input: { file_path: "final.txt" } })
        expect(typeof input.tool_use_id).toBe("string")
        expect(origin).toEqual({ plugin: "engine", tier: "core" })
        return { decision, reason: "permission explanation" }
      })
      f.manager.attachFunctions({
        invalidate: () => {},
        closeThread: () => {},
        close: () => {},
        toolCheck: checked
      })
      const actual = vi.fn(async () => "read")
      const call = f.manager.dispatch(
        f.scope,
        "host:read_file",
        { file_path: "final.txt" },
        async (input) => {
          await authorizeCurrentModInput("host:read_file", input)
          return actual()
        }
      )
      if (decision === "deny") {
        await expect(call).rejects.toThrow("MODS_TOOL_PERMISSION_DENIED: permission explanation")
        expect(actual).not.toHaveBeenCalled()
        expect(f.manager.store.audit(workspace)[0].status).toBe("not_started")
      } else {
        expect(await call).toBe("read")
        expect(actual).toHaveBeenCalledOnce()
      }
      expect(checked).toHaveBeenCalledOnce()
      expect(f.confirm).toHaveBeenCalledTimes(decision === "ask" ? 1 : 0)
      if (decision === "ask")
        expect(f.confirm).toHaveBeenCalledWith(
          "thread",
          "engine",
          "host:read_file",
          { file_path: "final.txt" },
          undefined,
          "permission explanation"
        )
    }
  )

  it("clamps a hook allow to a changed native permission and does not execute", async () => {
    const f = await fixture()
    f.manager.configure(f.root, true, false)
    const query = vi.fn(async () => ({ decision: "allow" as const }))
    query.mockResolvedValueOnce({ decision: "allow" })
    const finalQuery = vi.fn(async () => ({ decision: "deny" as const }))
    let changed = false
    f.manager.bindThread({ ...f.scope, queryTool: () => (changed ? finalQuery() : query()) })
    f.manager.attachFunctions({
      invalidate: () => {},
      closeThread: () => {},
      close: () => {},
      toolCheck: async () => {
        changed = true
        return { decision: "allow" }
      }
    })
    const actual = vi.fn(async () => "read")
    await expect(
      f.manager.dispatch(f.scope, "host:read_file", {}, async (input) => {
        await authorizeCurrentModInput("host:read_file", input)
        return actual()
      })
    ).rejects.toThrow("PERMISSION_DENIED")
    expect(actual).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledOnce()
    expect(finalQuery).toHaveBeenCalledOnce()
  })

  it("does not execute a native SDK request after its binding changes during approval", async () => {
    const f = await fixture()
    f.manager.configure(f.root, true, false)
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:native", "snapshot", true)
    const actual = vi.fn(async () => ({ exitCode: 0, output: "ran" }))
    const bind = () =>
      f.manager.bindThread({
        ...f.scope,
        invokeTool: (tool, args) =>
          f.manager.dispatch(f.scope, tool, args, async (input) => {
            await authorizeCurrentModInput(tool, input)
            return actual()
          })
      })
    const release = bind()
    bind()
    release()
    f.confirm.mockImplementation(async () => {
      bind()
      return true
    })
    await expect(
      f.manager.invokeFunctionTool(
        workspace,
        "thread",
        grant,
        "host:execute",
        { command: "echo test" },
        new AbortController().signal,
        false,
        true
      )
    ).rejects.toThrow("CONTEXT_EXPIRED")
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(actual).not.toHaveBeenCalled()
    expect(f.manager.store.audit(workspace)[0]).toMatchObject({
      status: "not_started",
      publication: "blocked"
    })
  })

  async function mcpFixture() {
    const f = await fixture()
    await f.enable()
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:mcp", "snapshot", true)
    const tool: McpCapabilityTool = {
      capabilityId: "connector:mail/send",
      toolId: "mcp__mail__send",
      providerKey: "connector:mail",
      providerAlias: "mail",
      providerDisplayName: "Company Mail",
      toolName: "send",
      visibility: "lazy",
      inputSchema: { type: "object", properties: { text: { type: "string" } } }
    }
    const scope = { ...f.scope, workspace, leased: true, immediate: false, userInitiated: true }
    const actual = vi.fn(async () => ({
      capabilityId: tool.capabilityId,
      text: "delivered",
      raw: { content: [{ type: "text", text: "delivered" }], structuredContent: { id: 1 } },
      isError: false
    }))
    const invoke = (id: string, args: ModObject) =>
      f.manager.dispatch(scope, `mcp:${id}`, args, async (input) => {
        await authorizeCurrentModInput(`mcp:${id}`, input)
        await beforeModToolExecution(() => getModCallContext()?.assertMcpTool?.(tool))
        return actual()
      })
    const bind = (extra: Partial<ModThreadBinding> = {}) =>
      f.manager.bindMcp(
        { ...scope, ...extra },
        invoke,
        async () => [tool],
        () => [structuredClone(tool)]
      )
    const release = bind()
    const controller = new AbortController()
    const call = (userInitiated = true) =>
      f.manager.invokeFunctionMcp(
        workspace,
        scope.threadId,
        grant,
        { server: "Company_Mail", tool: "send", args: { text: "hello" } },
        controller.signal,
        false,
        userInitiated
      )
    return { ...f, workspace, grant, tool, scope, actual, bind, release, controller, call }
  }

  it("routes MCP SDK through final approval with one real receipt and preserved structured output", async () => {
    const f = await mcpFixture()
    const result = await withFunctionExecution(f.scope, () => f.call())
    expect(result).toEqual({
      content: [{ type: "text", text: "delivered" }],
      structuredContent: { id: 1 },
      isError: false
    })
    expect(f.confirm).toHaveBeenCalledWith(
      "thread",
      "function:mcp",
      `mcp:${f.tool.capabilityId}`,
      { text: "hello" },
      expect.anything()
    )
    expect(f.actual).toHaveBeenCalledOnce()
    const rows = f.manager.store.audit(f.workspace)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      publication: "published",
      identity: { modId: "function:mcp", turnId: "turn", agentId: "main" }
    })
    expect(rows[0].identity?.parentCallId).toBeUndefined()
    expect(f.executions).toEqual([])
  })

  it("enforces canonical MCP restrictions in queries and calls before approval or execution", async () => {
    const f = await mcpFixture()
    f.tool.canonicalToolId = "mcp__canonical__send"
    f.bind({ blockedToolNames: new Set([f.tool.canonicalToolId]) })
    await withFunctionExecution(f.scope, async () => {
      expect(
        await f.manager.queryFunctionTool(
          f.workspace,
          "thread",
          f.grant,
          `mcp:${f.tool.capabilityId}`,
          { text: "blocked" },
          f.controller.signal,
          async () => ({ decision: "allow" }),
          [f.tool.toolId, f.tool.canonicalToolId!]
        )
      ).toEqual({ decision: "deny", reason: "MODS_RUNTIME_TOOL_DENIED" })
      await expect(f.call()).rejects.toThrow("MODS_RUNTIME_TOOL_DENIED")
    })
    expect(f.actual).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.manager.store.audit(f.workspace)).toHaveLength(0)
  })

  it("keeps readonly MCP binding authority for SDK calls independently of native adapters", async () => {
    const f = await mcpFixture()
    f.bind({ readOnly: true })
    await expect(withFunctionExecution(f.scope, () => f.call())).rejects.toThrow("USER_ACTION")
    expect(f.actual).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it("rejects automatic, child, cross-turn and closed MCP calls without borrowing a native adapter", async () => {
    const f = await mcpFixture()
    await expect(withFunctionExecution(f.scope, () => f.call(false))).rejects.toThrow("USER_ACTION")
    await expect(
      withFunctionExecution({ ...f.scope, agentId: "worker" }, () => f.call())
    ).rejects.toThrow("AGENT_UNAVAILABLE")
    await expect(
      withFunctionExecution({ ...f.scope, turnId: "other" }, () => f.call())
    ).rejects.toThrow("SCOPE_CHANGED")
    f.manager.closeFunctionThread(f.scope.threadId)
    await expect(f.call()).rejects.toThrow("MCP_CONTEXT_REQUIRED")
    expect(f.actual).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.executions).toEqual([])
  })

  it("routes exact scoped SDK names to the real MCP provider and approves only the tool arguments", async () => {
    const f = await mcpFixture()
    f.tool.canonicalToolId = f.tool.toolId
    f.tool.toolId = "mcp__send"
    expect(
      await withFunctionExecution(f.scope, () =>
        f.manager.invokeFunctionMcpTool(
          f.workspace,
          "thread",
          f.grant,
          { tool: "mcp__send", tool_use_id: "guest-id", agentId: "guest-agent", text: "final" },
          f.controller.signal,
          false,
          true
        )
      )
    ).toEqual({ result: [{ type: "text", text: "delivered" }], text: "delivered" })
    expect(f.confirm).toHaveBeenCalledWith(
      "thread",
      "function:mcp",
      `mcp:${f.tool.capabilityId}`,
      { text: "final" },
      expect.anything()
    )
    expect(f.actual).toHaveBeenCalledOnce()
    expect(f.manager.store.audit(f.workspace)).toHaveLength(1)
  })

  it("resolves names without receipts and rejects schema changes between lookup and tool-hook continuation", async () => {
    const f = await mcpFixture()
    const input = { server: "mail", tool: "send", args: { text: "before" } }
    const selected = await f.manager.resolveFunctionMcp(
      f.workspace,
      "thread",
      f.grant,
      input,
      f.controller.signal
    )
    expect(selected.name).toBe(f.tool.toolId)
    expect(f.actual).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.manager.store.audit(f.workspace)).toEqual([])
    f.tool.inputSchema = { type: "object", properties: { changed: { type: "boolean" } } }
    await expect(
      f.manager.invokeFunctionMcp(
        f.workspace,
        "thread",
        f.grant,
        input,
        f.controller.signal,
        false,
        true,
        String(selected.fingerprint)
      )
    ).rejects.toThrow("MODS_MCP_TOOL_CHANGED")
    expect(f.actual).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it("reads only the current MCP scope for permission metadata and refuses a removed live turn", async () => {
    const f = await mcpFixture()
    await withFunctionExecution(f.scope, async () => {
      expect(f.manager.peekFunctionMcpTools(f.workspace, "thread")).toEqual([f.tool])
      f.release()
      expect(() => f.manager.peekFunctionMcpTools(f.workspace, "thread")).toThrow(
        "MCP_CONTEXT_REQUIRED"
      )
    })
    expect(f.manager.peekFunctionMcpTools(f.workspace, "thread")).toBeUndefined()
    expect(f.actual).not.toHaveBeenCalled()
  })

  it.each(["replace", "schema", "connection", "revoke", "cancel"])(
    "rechecks MCP %s while approval is outstanding before any transport side effect",
    async (mode) => {
      const f = await mcpFixture()
      let approve!: (value: boolean) => void
      f.confirm.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            approve = resolve
          })
      )
      const operation = withFunctionExecution(f.scope, () => f.call())
      const rejection = expect(operation).rejects.toThrow(/MODS_/)
      await expect.poll(() => f.confirm.mock.calls.length).toBe(1)
      if (mode === "replace") f.bind()
      if (mode === "schema") f.tool.inputSchema = { type: "object", required: ["newArgument"] }
      if (mode === "connection") f.tool.connectionGeneration = "replacement"
      if (mode === "revoke") f.manager.store.grant(f.workspace, "function:mcp", "snapshot", false)
      if (mode === "cancel") f.controller.abort()
      approve(true)
      await rejection
      expect(f.actual).not.toHaveBeenCalled()
      expect(f.manager.store.audit(f.workspace)[0]?.publication).toBe("blocked")
      expect(f.manager.store.audit(f.workspace)[0]?.status).toBe("not_started")
    }
  )

  it("keeps replacement MCP bindings when an old disposer runs and never replays a lost reply", async () => {
    const f = await mcpFixture()
    f.bind()
    f.release()
    f.actual.mockImplementation(async () => {
      throw Error("ECONN disconnected sk-secret-value")
    })
    await expect(withFunctionExecution(f.scope, () => f.call())).rejects.toThrow(
      "MODS_EXECUTION_FAILED"
    )
    expect(f.actual).toHaveBeenCalledOnce()
    expect(f.manager.store.audit(f.workspace)[0]).toMatchObject({
      status: "unknown",
      publication: "blocked"
    })
  })

  it("scopes discovered tools by workspace, thread and agent and clears closed thread catalogs", async () => {
    const f = await fixture()
    expect(() => f.manager.functionToolCatalog(f.root, "thread")).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
    const tools = [{ name: "read_file", description: "Read", mcp: false }]
    f.manager.bindFunctionToolCatalog(f.scope, tools)
    tools[0].description = "mutated"
    f.manager.bindFunctionToolCatalog({ ...f.scope, agentId: "worker" }, [
      { name: "mcp__demo__tool", description: "MCP", mcp: true }
    ])
    expect(f.manager.functionToolCatalog(f.root, "thread")[0].description).toBe("Read")
    expect(f.manager.functionToolCatalog(f.root, "thread", "worker")[0].mcp).toBe(true)
    expect(() => f.manager.functionToolCatalog(f.root, "other")).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
    expect(() => f.manager.functionToolCatalog(f.plugin, "thread")).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
    f.manager.closeFunctionThread("thread")
    expect(() => f.manager.functionToolCatalog(f.root, "thread")).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
    expect(() => f.manager.functionToolCatalog(f.root, "thread", "worker")).toThrow(
      "MODS_TOOL_CONTEXT_REQUIRED"
    )
  })

  it("rejects registered names that shadow scoped native or canonical MCP tools without discovery", async () => {
    const f = await fixture()
    const name = "mcp__demo__probe"
    f.manager.assertFunctionToolNameAvailable(f.root, "thread", name)
    f.manager.bindFunctionToolCatalog(f.scope, [{ name, description: "Host", mcp: true }])
    expect(() => f.manager.assertFunctionToolNameAvailable(f.root, "thread", name)).toThrow(
      "MODS_TOOL_NAME_COLLISION"
    )
    f.manager.assertFunctionToolNameAvailable(f.root, "other", name)
    f.manager.bindFunctionToolCatalog(f.scope, [])
    const discovery = vi.fn(async () => [] as McpCapabilityTool[])
    const invoke = vi.fn(async () => ({}))
    const release = f.manager.bindMcp(f.scope, invoke, discovery, () => [
      { toolId: "mcp__probe", canonicalToolId: name } as McpCapabilityTool
    ])
    expect(() => f.manager.assertFunctionToolNameAvailable(f.root, "thread", name)).toThrow(
      "MODS_TOOL_NAME_COLLISION"
    )
    release()
    f.manager.assertFunctionToolNameAvailable(f.root, "thread", name)
    expect(discovery).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("executes a function SDK write through final-input approval and refuses stale or read-only calls", async () => {
    const f = await fixture()
    await f.enable()
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:sdk", "snapshot", true)
    const signal = new AbortController().signal
    const args = { command: "echo function" }
    expect(
      await f.manager.invokeFunctionTool(
        workspace,
        "thread",
        grant,
        "host:execute",
        args,
        signal,
        false,
        true
      )
    ).toMatchObject({ result: { output: "verified", exitCode: 0 } })
    expect(f.confirm).toHaveBeenCalledWith(
      "thread",
      "function:sdk",
      "host:execute",
      args,
      expect.any(AbortSignal)
    )
    expect(f.executions).toEqual([args])
    const native = f.manager.store.audit(workspace).find((row) => row.toolId === "host:execute")!
    expect(native.identity?.parentCallId).toBeUndefined()
    await expect(
      f.manager.invokeFunctionTool(
        workspace,
        "thread",
        grant,
        "host:execute",
        args,
        signal,
        true,
        true
      )
    ).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
    f.confirm.mockResolvedValueOnce(false)
    await expect(
      f.manager.invokeFunctionTool(
        workspace,
        "thread",
        grant,
        "host:execute",
        args,
        signal,
        false,
        true
      )
    ).rejects.toThrow("MODS_USER_REJECTED")
    f.manager.store.grant(workspace, "function:sdk", "snapshot", false)
    await expect(
      f.manager.invokeFunctionTool(
        workspace,
        "thread",
        grant,
        "host:execute",
        args,
        signal,
        false,
        true
      )
    ).rejects.toThrow("MODS_GRANT_REVOKED")
    expect(f.executions).toEqual([args])
  })
  it("links nested SDK tools to their real parent and never borrows the main binding for a worker", async () => {
    const f = await fixture()
    await f.enable()
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:sdk", "snapshot", true)
    const signal = new AbortController().signal
    const scope = {
      workspace,
      threadId: "thread",
      turnId: "actual-turn",
      leased: true,
      immediate: false,
      userInitiated: true
    }
    f.scope.turnId = scope.turnId
    f.manager.bindThread({
      ...f.scope,
      invokeTool: (tool, args) =>
        f.manager.dispatch(f.scope, tool, args, async (input) => {
          await authorizeCurrentModInput(tool, input)
          f.executions.push(input)
          return { output: "verified", exitCode: 0 }
        })
    })
    const invoke = () =>
      f.manager.invokeFunctionTool(
        workspace,
        "thread",
        grant,
        "host:execute",
        { command: "echo nested" },
        signal,
        false,
        true
      )
    const tools = new FunctionRegisteredTools(f.manager.store, {
      assertScope: () => {},
      admit: async () => {},
      publish: async (_identity, value) => value
    })
    await withFunctionExecution(scope, () =>
      tools.call(
        workspace,
        "thread",
        grant,
        { tool: "mcp__sdk__nested", tool_use_id: "model-call" },
        "model",
        signal,
        invoke
      )
    )
    const audit = f.manager.store.audit(workspace)
    const parent = audit.find((row) => row.toolId === "function:mcp__sdk__nested")!
    const native = audit.find((row) => row.toolId === "host:execute")!
    expect(native.identity).toMatchObject({
      parentCallId: parent.identity!.callId,
      turnId: "actual-turn",
      agentId: "main"
    })
    expect(audit).toHaveLength(2)
    await expect(withFunctionExecution({ ...scope, agentId: "worker" }, invoke)).rejects.toThrow(
      "MODS_TOOL_AGENT_UNAVAILABLE"
    )
    expect(f.executions).toHaveLength(1)
    expect(f.confirm).toHaveBeenCalledOnce()
    await expect(
      withFunctionExecution({ ...scope, turnId: "different-turn" }, invoke)
    ).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  })
  it("rechecks the live function scope after native approval before allowing a side effect", async () => {
    const f = await fixture()
    await f.enable()
    const workspace = f.manager.workspaceKey(f.root)
    const grant = f.manager.store.grant(workspace, "function:sdk", "snapshot", true)
    let approve!: (value: boolean) => void
    f.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve
        })
    )
    let operation!: Promise<unknown>
    await withFunctionExecution(
      { workspace, threadId: "thread", leased: true, immediate: false, userInitiated: true },
      async () => {
        operation = f.manager.invokeFunctionTool(
          workspace,
          "thread",
          grant,
          "host:execute",
          { command: "echo expired" },
          new AbortController().signal,
          false,
          true
        )
        await expect.poll(() => f.confirm.mock.calls.length).toBe(1)
      }
    )
    const rejected = expect(operation).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
    approve(true)
    await rejected
    expect(f.executions).toEqual([])
  })
  it("consumes the MCP scoped route once before entering the raw service", async () => {
    const f = await fixture()
    await f.enable()
    setModsManager(f.manager)
    const tool = {
      capabilityId: "connector:test:echo",
      toolId: "mcp__test__echo",
      providerKey: "connector:test",
      providerAlias: "test",
      providerDisplayName: "Test",
      toolName: "echo",
      visibility: "eager" as const
    }
    let executions = 0
    try {
      await withScopedModMcp(f.scope, tool, { input: "one" }, (args) =>
        withRawModMcp(tool, args, async () => {
          executions++
          return {
            capabilityId: tool.capabilityId,
            raw: { text: "result" },
            text: "result",
            isError: false
          }
        })
      )
      expect(executions).toBe(1)
      expect(
        f.manager.store
          .audit(f.manager.workspaceKey(f.root))
          .filter((row) => row.toolId === `mcp:${tool.capabilityId}`)
      ).toHaveLength(1)
    } finally {
      setModsManager(undefined)
    }
  })
  it("discovers approved commands and rechecks queued permission snapshots", async () => {
    const f = await fixture()
    expect(await f.manager.commands(f.root, "thread")).toEqual([])
    await f.enable()
    const [command] = await f.manager.commands(f.root, "thread")
    expect(command.command).toBe("review:run")
    expect(
      (await f.manager.runCommand(f.root, "thread", command, {}, new AbortController().signal)).text
    ).toBe("verified")
    expect(f.executions).toHaveLength(1)
    f.manager.revoke(f.root, "review")
    await expect(
      f.manager.runCommand(f.root, "thread", command, {}, new AbortController().signal)
    ).rejects.toThrow("SCOPE_CHANGED")
    expect(f.executions).toHaveLength(1)
  })
  it("summarizes a settled turn once from execution facts", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    await f.manager.finishTurn("thread")
    await f.manager.finishTurn("thread")
    const cards = f.manager.listCards("thread", "turn:turn", 7)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      slot: "turn.summary",
      nodes: [{ type: "text", text: "本轮工具：成功 1，失败 0，待核查 0，未执行 0。" }]
    })
  })
  it("renders cancelled turn facts without restoring its expired execution authority", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const controller = new AbortController()
    const instance = f.manager.createRuntimeAuthority({ ...f.scope, signal: controller.signal })
    const invokeTool = vi.fn(async () => "must not execute")
    f.manager.bindThread({
      ...f.scope,
      signal: controller.signal,
      runtimeAuthority: instance.authority,
      invokeTool
    })
    controller.abort()
    await f.manager.finishTurn("thread")
    await f.manager.finishTurn("thread")
    expect(f.manager.listCards("thread", "turn:turn", 7)).toHaveLength(1)
    expect(() => instance.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(invokeTool).not.toHaveBeenCalled()
  })
  it("releases cancelled adapters and catalogs without reviving old authority or dropping replacements", async () => {
    const f = await fixture()
    await f.enable()
    const bind = (threadId: string) => {
      const controller = new AbortController()
      const scope = { ...f.scope, threadId, signal: controller.signal }
      const instance = f.manager.createRuntimeAuthority(scope)
      const binding = { ...scope, runtimeAuthority: instance.authority }
      const release = f.manager.bindThread(binding)
      const releaseMcp = f.manager.bindMcp(
        binding,
        async () => ({}),
        undefined,
        () => []
      )
      // Production catalogs retain the authority, but need not retain the abort signal.
      f.manager.bindFunctionToolCatalog(
        { ...f.scope, threadId, runtimeAuthority: instance.authority },
        [{ name: "read_file", description: "Read", mcp: false }]
      )
      return { controller, instance, release, releaseMcp }
    }
    const old = bind("thread")
    const other = bind("other")
    other.controller.abort()
    old.controller.abort()
    f.manager.releaseExpiredRuntimeBindings("thread")
    expect(f.manager.needsCommandBinding("thread")).toBe(true)
    expect(f.manager.filterFunctionTools(f.root, "thread", [{ name: "read_file" }])).toHaveLength(1)
    expect(await f.manager.registeredFunctionTools(f.root, "thread")).toEqual([])
    expect(f.manager.peekFunctionMcpTools(f.root, "thread")).toBeUndefined()
    expect(() => f.manager.functionToolCatalog(f.root, "thread")).toThrow("CONTEXT_REQUIRED")
    expect(() => f.manager.peekFunctionMcpTools(f.root, "other")).toThrow("INSTANCE_EXPIRED")
    expect(() => old.instance.authority.assertLive()).toThrow("INSTANCE_EXPIRED")

    const current = bind("thread")
    old.release()
    old.releaseMcp()
    f.manager.releaseExpiredRuntimeBindings("thread")
    expect(() => current.instance.authority.assertLive()).not.toThrow()
    expect(f.manager.needsCommandBinding("thread")).toBe(false)
    expect(f.manager.peekFunctionMcpTools(f.root, "thread")).toEqual([])
    expect(f.manager.functionToolCatalog(f.root, "thread")).toHaveLength(1)
  })
  it("never transfers artifacts across workspaces, threads or code grants", async () => {
    const f = await fixture()
    await f.enable()
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const workspace = f.manager.workspaceKey(f.root)
    f.manager.store.saveArtifact({
      id,
      workspace,
      threadId: "thread",
      modId: "review",
      digest: f.digest,
      label: "Report",
      text: "result",
      createdAt: Date.now()
    })
    expect(await f.manager.artifact(f.root, "thread", id)).toEqual({
      label: "Report",
      text: "result"
    })
    await expect(f.manager.artifact(f.root, "other", id)).rejects.toThrow("UNAVAILABLE")
    await expect(f.manager.artifact(f.plugin, "thread", id)).rejects.toThrow("UNAVAILABLE")
    const pending = f.manager.artifact(f.root, "thread", id)
    f.manager.revoke(f.root, "review")
    await expect(pending).rejects.toThrow("REVOKED")
    await expect(f.manager.artifact(f.root, "thread", id)).rejects.toThrow("UNAVAILABLE")
  })
  it("does not recreate a missing initialized control store or silently bypass unavailable policy", async () => {
    const f = await fixture()
    const path = join(f.root, "missing.sqlite")
    writeFileSync(`${path}.initialized`, "cmb.mods/v1")
    expect(
      () =>
        new ModsManager(
          path,
          () => [],
          async () => true,
          () => {}
        )
    ).toThrow("RECOVERY_REQUIRED")
    setModsUnavailable("MODS_CONTROL_RECOVERY_REQUIRED")
    try {
      expect(() => getModsManager()).toThrow("RECOVERY_REQUIRED")
    } finally {
      setModsManager(undefined)
    }
  })
  it("enforces mandatory deployment policy with ordinary Mods disabled", async () => {
    const f = await fixture({
      ...DEFAULT_MOD_POLICY,
      required: true,
      denyTools: ["host:write_file"],
      redactLiterals: ["private-value"]
    })
    expect(() => f.manager.configure(f.root, false, false)).toThrow("POLICY_REQUIRED")
    const core = vi.fn(async () => "private-value")
    await expect(f.manager.dispatch(f.scope, "host:write_file", {}, core)).rejects.toThrow(
      "POLICY_TOOL_DENIED"
    )
    expect(core).not.toHaveBeenCalled()
    expect(f.manager.store.audit(f.manager.workspaceKey(f.root))[0].status).toBe("not_started")
    expect(await f.manager.dispatch(f.scope, "host:read_file", {}, core)).toBe("[REDACTED]")
    expect(f.manager.store.audit(f.manager.workspaceKey(f.root))[0]).toMatchObject({
      status: "succeeded",
      publication: "published",
      policyDigest: f.manager.policy.digest
    })
  })
  it("keeps the disabled path unchanged and injects context only after approval", async () => {
    const f = await fixture()
    expect(await f.dispatch()).toBe("text")
    expect(await f.manager.context(f.scope)).toEqual([])
    await f.enable()
    expect(await f.dispatch()).toBe("text checked")
    expect((await f.manager.context(f.scope))[0]).toContain("Context cmb-mods-manager-")
  })
  it("binds a stable one-shot button to sender/thread and confirms final arguments", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    expect(f.button().actionId).toBe(id)
    await expect(f.manager.act(8, "thread", id)).rejects.toThrow("ACTION_INVALID")
    await expect(f.manager.act(7, "other", id)).rejects.toThrow("ACTION_INVALID")
    expect((await f.manager.act(7, "thread", id)).text).toBe("verified")
    expect(f.confirm).toHaveBeenCalledWith(
      "thread",
      "review",
      "host:execute",
      {
        command: "echo verified"
      },
      expect.any(AbortSignal)
    )
    expect(f.executions).toHaveLength(1)
    expect(f.button().actionId).toBeUndefined()
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow()
  })
  it("does not execute after rejection or revive a button after reapproval", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.manager.act(7, "thread", f.button().actionId!)).rejects.toThrow()
    expect(f.executions).toHaveLength(0)
    f.manager.revoke(f.root, "review")
    await f.manager.approve(f.root, "plugin", f.digest)
    expect(f.button().actionId).toBeUndefined()
    expect(await f.dispatch()).toBe("text checked")
  })
  it("revokes active sessions when the plugin is disabled", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    f.plugins[0].enabled = false
    f.manager.pluginsChanged()
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow()
    expect(await f.dispatch()).toBe("text")
    expect(f.button().actionId).toBeUndefined()
  })
  it("rejects stale code grants and cancelled scopes", async () => {
    const f = await fixture()
    writeFileSync(join(f.plugin, "index.ts"), "export default { register() {} }")
    await expect(f.manager.approve(f.root, "plugin", f.digest)).rejects.toThrow("CODE_CHANGED")
    f.manager.configure(f.root, true, false)
    const signal = AbortSignal.abort()
    let invoked = false
    await expect(
      f.manager.dispatch({ ...f.scope, signal }, "host:write_file", {}, async () => {
        invoked = true
      })
    ).rejects.toThrow("CANCELLED")
    expect(invoked).toBe(false)
  })

  it("does not transfer a previously minted action into another turn", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    f.manager.bindThread({ ...f.scope, turnId: "next-turn" })
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow("ACTION_STALE")
    expect(f.executions).toHaveLength(0)
  })

  it("does not enter the disabled fast path with an in-flight revoked capability", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    let executions = 0
    f.manager.bindThread({
      ...f.scope,
      invokeTool: async (tool, args) => {
        await Promise.resolve()
        f.manager.configure(f.root, false, false)
        return f.manager.dispatch(f.scope, tool, args, async () => ++executions)
      }
    })
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow()
    expect(executions).toBe(0)
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it("applies current policy to historical cards even without a live agent binding", async () => {
    const f = await fixture()
    await f.enable()
    const workspace = f.manager.workspaceKey(f.root)
    f.manager.store.saveCard("historical", "archive", {
      card: {
        id: "historical",
        agentId: "main",
        modId: "review",
        name: "Review",
        threadId: "archive",
        callId: "past",
        nodes: [{ type: "text", text: "sk-private-old-card-123456789" }]
      },
      grant: f.manager.store.getGrant(workspace, "review"),
      workspaceEpoch: 1,
      turnId: "past"
    })
    f.manager.configure(f.root, true, true)
    const cards = f.manager.listCards("archive", "past", 7)
    expect(JSON.stringify(cards)).not.toContain("sk-private")
    expect(JSON.stringify(cards)).toContain("[REDACTED]")
  })

  it("validates declared registrations before persisting approval", async () => {
    const f = await fixture()
    writeFileSync(
      join(f.plugin, "index.ts"),
      'export default { register(on) { on.tool({id:"bad",tools:["host:delete_file"]},async()=>({kind:"deny"})) } }'
    )
    const candidate = (await f.manager.status(f.root)).mods[0]
    await expect(f.manager.approve(f.root, "plugin", candidate.digest!)).rejects.toThrow(
      "UNDECLARED_TOOL"
    )
    expect(f.manager.store.getGrant(f.manager.workspaceKey(f.root), "review")).toBeNull()
  })
})
