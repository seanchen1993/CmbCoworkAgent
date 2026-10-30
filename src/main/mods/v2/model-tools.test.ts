import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { createAgent } from "langchain"
import { createToolHookMiddleware } from "../../agent/tool-hooks"
import { createHookScope } from "../../hooks/scope"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { withFunctionExecution, scheduleFunctionTool } from "./execution-context"
import { functionToolContexts } from "./tool-result"
import type { ModObject } from "../../../shared/mods/types"
import { ModGuestRuntime, type ModHostCall } from "../guest-runtime"

// Only replace the process transport; both guest runtimes and mandatory policy execute for real.
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
import { withModToolCall } from "../adapters"
import { getModCallContext } from "../context"
import { DEFAULT_MOD_POLICY } from "../policy"
import { ModError, ModPermissionError } from "../errors"
import { FunctionRegisteredTools } from "./registered-tools"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  setModsManager(undefined)
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(code: string, denyTools: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "function-model-tools-"))
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {},
    undefined,
    { ...DEFAULT_MOD_POLICY, denyTools }
  )
  manager.configure(root, true, true)
  setModsManager(manager)
  const workspace = manager.workspaceKey(root)
  const binding = { workspace, threadId: "thread", turnId: "turn" }
  const grant = manager.store.grant(workspace, "function:demo", "snapshot", true)
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${code}}}`)
  const queue = {
    enqueue: vi.fn(() => {
      throw Error("Model hook waited for its own lease")
    })
  }
  const sdkCalls: string[] = []
  const session = new FunctionSession(
    [{ name: "demo", root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      ...binding,
      assertLive: () => manager.store.assertGrant(grant),
      publish: (value, signal) => manager.publish(workspace, value, undefined, signal),
      callTool: async (_plugin, input, signal) =>
        scheduleFunctionTool(
          queue as never,
          workspace,
          binding.threadId,
          `host:${input.tool}`,
          signal,
          async (_signal, _readOnly, userInitiated) => {
            expect(userInitiated).toBe(false)
            sdkCalls.push(String(input.tool))
            return { result: "sdk-read", text: "sdk-read" }
          }
        )
    }
  )
  manager.attachFunctions({
    registeredTools: () => session.registeredTools(),
    invalidate: () => {
      void session.close()
    },
    closeThread: () => {
      void session.close()
    },
    close: () => {
      void session.close()
    },
    toolCall: (scope, input, core) =>
      withFunctionExecution(
        {
          workspace,
          threadId: "thread",
          userInitiated: false,
          leased: true,
          immediate: false
        },
        () => session.interceptTool(input, scope.signal, core)
      )
  })
  cleanup.push(async () => {
    await session.close()
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("function-model-tools-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  const calls: Array<{ args: ModObject; callId: string }> = []
  let core = async (args: ModObject) => String(args.path ?? "core")
  const run = (args: ModObject = {}, signal?: AbortSignal, agentId?: string) =>
    withModToolCall(
      { ...binding, signal, agentId },
      { toolCall: { name: "fixture", id: "native-id", args } },
      new Set(),
      async (request) => {
        calls.push({ args: request.toolCall.args, callId: getModCallContext()!.identity.callId })
        return new ToolMessage({
          content: await core(request.toolCall.args),
          tool_call_id: "native-id",
          status: "success",
          name: "fixture"
        })
      }
    )
  return {
    manager,
    session,
    run,
    calls,
    workspace,
    sdkCalls,
    queue,
    setCore(value: typeof core) {
      core = value
    }
  }
}

it("routes model tools through real hooks, pins identities and records each explicit next separately", async () => {
  const f = await fixture(`
    on("tool.call", {tool:"fixture"}, async ($,e,next) => {
      if(next.origin.plugin!=="engine" || e.tool_use_id!=="native-id" || e.agentId!=="worker")
        throw Error("wrong identity");
      await next({...e,path:"first"});
      const answer=await next({...e,path:"second"});
      return {...answer,context:["private reminder"]};
    });
  `)
  const answer = await f.run({ path: "original" }, undefined, "worker")
  expect(answer.content).toBe("second")
  expect(functionToolContexts([answer])).toEqual(["private reminder"])
  expect(f.calls.map((call) => call.args.path)).toEqual(["first", "second"])
  expect(new Set(f.calls.map((call) => call.callId)).size).toBe(2)
  const audit = f.manager.store.audit(f.workspace)
  expect(audit).toHaveLength(2)
  expect(audit.every((row) => row.status === "succeeded")).toBe(true)
})

it("reports invalid dynamic tool input and missing handlers as model tool errors without native execution", async () => {
  const f = await fixture(`
    on("session.start",async($,e,next)=>{await $.tool.register({name:"probe",description:"Probe",inputSchema:{type:"object",properties:{count:{type:"integer"}},required:["count"]}});return next(e)});
  `)
  const call = (args: ModObject) =>
    withModToolCall(
      { workspace: f.workspace, threadId: "thread", turnId: "turn" },
      { toolCall: { name: "mcp__demo__probe", id: "dynamic", args } },
      new Set(),
      async () => {
        throw Error("native fallback")
      }
    )
  expect(await call({ count: "bad" })).toMatchObject({
    status: "error",
    content: "MODS_REGISTERED_TOOL_INPUT"
  })
  expect(await call({ count: 1 })).toMatchObject({
    status: "error",
    content: "MODS_REGISTERED_TOOL_UNHANDLED"
  })
  expect(f.manager.store.audit(f.workspace)).toEqual([])
})

it("advertises dynamic schemas through the real AgentNode, serves calls, refreshes replacements and hides revoked tools", async () => {
  const f = await fixture(`
    on("session.start",async($,e,next)=>{
      await $.tool.register({name:"probe",description:"First",inputSchema:{type:"object",properties:{count:{type:"integer"}},required:["count"]}});
      await $.command.register({name:"replace",description:"Replace"}); return next(e)
    });
    on("command.run",{command:"replace"},async($)=>{await $.tool.register({name:"probe",description:"Replaced"});return {text:"ok"}});
    on("tool.call",{tool:"mcp__demo__probe"},($,e)=>({result:{count:e.count},context:["custom context"]}));
  `)
  const definitions: unknown[][] = []
  const observed: BaseMessage[][] = []
  let count: number | string = 1
  class Model extends FakeChatModel {
    bindTools(tools: unknown[]) {
      definitions.push(tools)
      return this
    }
    async _generate(messages: BaseMessage[]) {
      observed.push(messages)
      const done =
        ToolMessage.isInstance(messages.at(-1)) ||
        !JSON.stringify(definitions.at(-1)).includes("mcp__demo__probe")
      const message = done
        ? new AIMessage("done")
        : new AIMessage({
            content: "",
            tool_calls: [
              { name: "mcp__demo__probe", id: "dynamic", args: { count }, type: "tool_call" }
            ]
          })
      return { generations: [{ text: done ? "done" : "", message }] }
    }
  }
  const middleware = (agentId?: string) =>
    createToolHookMiddleware({
      workspacePath: f.workspace,
      threadId: "thread",
      agentId,
      hookScope: createHookScope(),
      resolveHooksForContext: () => []
    })
  const agent = createAgent({ model: new Model({}), tools: [], middleware: [middleware()] })
  const first = await agent.invoke({ messages: [{ role: "user", content: "probe" }] })
  expect(JSON.stringify(definitions[0])).toContain('"description":"First"')
  expect(JSON.stringify(definitions[0])).toContain('"parameters":{"type":"object"')
  expect(first.messages.find(ToolMessage.isInstance)).toMatchObject({
    status: "success",
    content: '{"count":1}'
  })
  expect(JSON.stringify(observed.at(-1))).toContain("custom context")
  count = "bad"
  const invalid = await agent.invoke({ messages: [{ role: "user", content: "invalid" }] })
  expect(invalid.messages.find(ToolMessage.isInstance)).toMatchObject({
    status: "error",
    content: "MODS_REGISTERED_TOOL_INPUT"
  })
  await f.session.run("replace", "")
  await agent.invoke({ messages: [{ role: "user", content: "replacement" }] })
  expect(JSON.stringify(definitions.at(-1))).toContain('"description":"Replaced"')
  const child = createAgent({ model: new Model({}), tools: [], middleware: [middleware("worker")] })
  await child.invoke({ messages: [{ role: "user", content: "child" }] })
  expect(definitions.at(-1)).toEqual([])
  f.manager.configure(f.workspace, false, true)
  await agent.invoke({ messages: [{ role: "user", content: "revoked" }] })
  expect(definitions.at(-1)).toEqual([])
})

it("does not execute denied or locally answered calls", async () => {
  const f = await fixture(`
    on("tool.call",{path:"deny"},()=>({deny:"refused by mod"}));
    on("tool.call",{path:"local"},()=>({result:{text:"local answer"}}));
  `)
  expect(await f.run({ path: "deny" })).toMatchObject({
    status: "error",
    content: "refused by mod"
  })
  expect(await f.run({ path: "local" })).toMatchObject({ content: "local answer" })
  expect(f.calls).toEqual([])
  expect(f.manager.store.audit(f.workspace)).toEqual([])
})

it("keeps the last completed downstream result after a hook throws without replaying it", async () => {
  const f = await fixture(`on("tool.call",async($,e,next)=>{await next(e);throw Error("after")})`)
  expect(await f.run({ path: "once" })).toMatchObject({ content: "once" })
  expect(f.calls).toHaveLength(1)
})

it("allows nested read SDK calls without a queue deadlock but never grants user write authority", async () => {
  const f = await fixture(`on("tool.call",{tool:"fixture"},async($,e,next)=>{
    await $.tool.call({tool:"read_file",file_path:"README.md"});
    let error="";try{await $.tool.call({tool:"write_file",file_path:"x",content:"x"})}catch(e){error=e.message}
    const answer=await next(e);return {...answer,context:[error]};
  })`)
  const answer = await f.run()
  expect(f.sdkCalls).toEqual(["read_file"])
  expect(f.queue.enqueue).not.toHaveBeenCalled()
  expect(functionToolContexts([answer])[0]).toContain("MODS_WRITE_REQUIRES_USER_ACTION")
})

it("keeps mandatory host policy below hooks and protects core output before after-hooks see it", async () => {
  const denied = await fixture(`on("tool.call",async($,e,next)=>next(e))`, ["host:fixture"])
  await expect(denied.run()).rejects.toThrow("MODS_POLICY_TOOL_DENIED")
  expect(denied.calls).toEqual([])
  const f = await fixture(
    `on("tool.call",async($,e,next)=>{const r=await next(e);return {...r,context:[r.text]}})`
  )
  f.setCore(async () => "sk-private-fixture-123456789")
  const result = await f.run()
  expect(result.content).toBe("[REDACTED]")
  expect(functionToolContexts([result])).toEqual(["[REDACTED]"])
})

it("cancels pending hooks without executing core and preserves the cancellation error", async () => {
  const f = await fixture(
    `on("tool.call",async($,e,next)=>{await $.clock.sleep(1000);return next(e)})`
  )
  const controller = new AbortController()
  const pending = f.run({}, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: "MODS_CANCELLED" })
  await new Promise((resolve) => setTimeout(resolve, 30))
  controller.abort()
  await rejected
  expect(f.calls).toEqual([])
})

it("does not let a hook change the tool target or host identities", async () => {
  const f = await fixture(`on("tool.call",async($,e,next)=>{
    const errors=[];
    for(const key of ["tool","tool_use_id","agentId"]){
      try { await next({...e,[key]:"forged"}) } catch(error) { errors.push(error.message) }
    }
    return {...await next(e),context:errors};
  })`)
  const answer = await f.run()
  expect(functionToolContexts([answer])).toEqual([
    "MODS_PINNED_INPUT: tool.call.tool",
    "MODS_PINNED_INPUT: tool.call.tool_use_id",
    "MODS_PINNED_INPUT: tool.call.agentId"
  ])
  expect(f.calls).toHaveLength(1)
  expect(answer.tool_call_id).toBe("native-id")
})

it("preserves native parameters whose names collide with reserved event fields", async () => {
  const f = await fixture(`on("tool.call",async($,e,next)=>{
    if(e.tool!=="fixture" || e.tool_use_id!=="native-id")
      return {deny:"host fields lost"};
    return {...await next(e),context:[e.agentId??"main"]}
  })`)
  const parameters = {
    tool: "native argument",
    tool_use_id: "native parameter",
    agentId: "native agent"
  }
  expect(functionToolContexts([await f.run(parameters, undefined, "worker")])).toEqual(["worker"])
  expect(f.calls[0].args).toEqual(parameters)
  expect(functionToolContexts([await f.run(parameters)])).toEqual(["main"])
  expect(f.calls[1].args).toEqual(parameters)
  expect(parameters.agentId).toBe("native agent")
})

it.each([
  [
    new ModPermissionError("protected rule explanation"),
    "MODS_TOOL_PERMISSION_DENIED: protected rule explanation"
  ],
  [new ModError("MODS_RUNTIME_TOOL_DENIED"), "MODS_RUNTIME_TOOL_DENIED"]
])(
  "returns registered-tool denial %s as a model tool error without running the handler",
  async (error, message) => {
    const f = await fixture(`on("session.start",async($,e,next)=>{
    await $.tool.register({name:"probe",description:"Probe"});return next(e)
  });on("tool.call",{tool:"mcp__demo__probe"},()=>({result:"must not run"}));`)
    await f.session.registeredTools()
    const grant = f.manager.store.getGrant(f.workspace, "function:demo")!
    const run = vi.fn(async () => ({ result: "must not run" }))
    const registered = new FunctionRegisteredTools(f.manager.store, {
      assertScope: () => {},
      admit: async () => {
        throw error
      },
      publish: async (_, value) => value
    })
    f.manager.attachFunctions({
      invalidate: () => {},
      close: () => {},
      closeThread: () => {},
      toolCall: (scope, input) =>
        registered.call(
          f.workspace,
          "thread",
          grant,
          input,
          "model",
          scope.signal ?? new AbortController().signal,
          run
        )
    })
    const native = vi.fn()
    const call = (signal?: AbortSignal) =>
      withModToolCall(
        { workspace: f.workspace, threadId: "thread", turnId: "turn", signal },
        { toolCall: { name: "mcp__demo__probe", id: "denied", args: {} } },
        new Set(),
        native
      )
    expect(await call()).toMatchObject({
      tool_call_id: "denied",
      status: "error",
      content: message
    })
    expect(run).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
    expect(f.manager.store.audit(f.workspace)).toEqual([])
    await expect(call(AbortSignal.abort())).rejects.toThrow()
  }
)
