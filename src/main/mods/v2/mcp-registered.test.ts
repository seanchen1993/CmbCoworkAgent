import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function fixture(host: Partial<FunctionSessionHost> = {}, extra = "") {
  const plugins = await Promise.all(
    [
      [
        "owner.with.dot",
        `
      let registered;
      on("session.start",async($,e,next)=>{
        registered=await $.tool.register({name:"probe",description:"Probe",inputSchema:{
          type:"object",properties:{mode:{type:"string"}},required:["mode"],additionalProperties:false}});
        await $.command.register({name:"replace",description:"Replace"});
        return next(e);
      });
      on("command.run",{command:"replace"},async($,e)=>{
        await $.tool.register({name:"probe",description:e.args||"Changed",inputSchema:{
          type:"object",properties:{mode:{type:"string"}},required:["mode"],additionalProperties:false}});
        return {};
      });
      on("tool.call",async($,e,next)=>{
        if(e.tool!==registered.tool)return next(e);
        if(e.mode==="deny")return {deny:"refused"};
        if(e.mode==="blocks")return {result:[{type:"text",text:"one"},{type:"resource_link",uri:"test://fixture",name:"two"}],isError:true};
        return {result:{mode:e.mode,origin:next.origin.plugin,agent:e.agentId||"main"}};
      });
    `
      ],
      [
        "caller",
        `
      on("session.start",async($,e,next)=>{await $.command.register({name:"call",description:"Call"});return next(e)});
      on("command.run",{command:"call"},async($,e)=>{
        try { return {text:JSON.stringify(await $.mcp.call("owner.with.dot","probe",{mode:e.args||"ok"}))}; }
        catch(error){return {text:"ERROR:"+error.message};}
      });
      ${extra}
    `
      ]
    ].map(async ([name, body]) => ({
      name,
      root: "/plugin",
      tier: "user" as const,
      capabilities: [...SESSION_CAPABILITIES],
      guest: await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
    }))
  )
  const session = new FunctionSession(plugins, {
    workspace: "/project",
    threadId: "thread",
    assertLive: () => {},
    publish: async (v) => v,
    ...host
  })
  sessions.push(session)
  return session
}

it("routes a normalized registered name through the guest handler and owner admission without a physical MCP call", async () => {
  const callMcp = vi.fn()
  const ids = new Set<string>()
  const registeredTool = vi.fn<NonNullable<FunctionSessionHost["registeredTool"]>>(
    async (owner, input: ModObject, kind, _signal, run, caller) => {
      expect(owner.name).toBe("owner.with.dot")
      expect(kind).toBe("mod")
      expect(caller).toEqual({ plugin: "caller", tier: "user" })
      expect(input.tool).toBe("mcp__owner_with_dot__probe")
      expect(ids.has(String(input.tool_use_id))).toBe(false)
      ids.add(String(input.tool_use_id))
      return run()
    }
  )
  const session = await fixture({ callMcp, registeredTool })
  for (let i = 0; i < 2; i++)
    expect(JSON.parse(String((await session.run("call", "ok")).text))).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ mode: "ok", origin: "caller", agent: "main" }) }
      ],
      isError: false
    })
  expect(registeredTool).toHaveBeenCalledTimes(2)
  expect(callMcp).not.toHaveBeenCalled()
})

it("keeps content blocks and error status, and propagates registered denial as an MCP operation failure", async () => {
  const session = await fixture()
  expect(JSON.parse(String((await session.run("call", "blocks")).text))).toEqual({
    content: [
      { type: "text", text: "one" },
      { type: "resource_link", uri: "test://fixture", name: "two" }
    ],
    isError: true
  })
  expect((await session.run("call", "deny")).text).toBe("ERROR:refused")
})

it("selects after the MCP operation rewrites arguments and validates the real registered schema", async () => {
  const session = await fixture(
    {},
    `on("mcp.call",async(_,e,next)=>next({...e,args:{mode:"rewritten"}}));`
  )
  expect(String((await session.run("call", "ok")).text)).toContain("rewritten")
  const invalid = await fixture({}, `on("mcp.call",async(_,e,next)=>next({...e,args:{mode:2}}));`)
  expect((await invalid.run("call", "ok")).text).toMatch(/MODS_REGISTERED_TOOL_INPUT/)
})

it("does not execute a replacement definition after admission waited on the old registration", async () => {
  const session = await fixture({
    registeredTool: async (_owner, _input, _kind, _signal, run) => {
      await session.run("replace", "Changed")
      return run()
    }
  })
  expect((await session.run("call", "ok")).text).toMatch(/MODS_TOOL_CHANGED/)
})

it("does not invalidate an in-flight definition when an identical schema is registered again", async () => {
  const session = await fixture({
    registeredTool: async (_owner, _input, _kind, _signal, run) => {
      await session.run("replace", "Probe")
      return run()
    }
  })
  expect(String((await session.run("call", "ok")).text)).toContain("content")
})

it("rechecks an actual host name collision after admission before entering the registered handler", async () => {
  let occupied = false
  const session = await fixture({
    assertToolNameAvailable: () => {
      if (occupied) throw new ModFunctionError("MODS_TOOL_NAME_COLLISION")
    },
    registeredTool: async (_owner, _input, _kind, _signal, run) => {
      occupied = true
      return run()
    }
  })
  expect((await session.run("call", "ok")).text).toMatch(/MODS_TOOL_NAME_COLLISION/)
})

it("cancels pending named registered calls when the owning session is closed without retry", async () => {
  let entered!: () => void
  const admission = new Promise<void>((resolve) => {
    entered = resolve
  })
  const registeredTool = vi.fn<NonNullable<FunctionSessionHost["registeredTool"]>>(
    async (_owner, _input, _kind, signal) => {
      entered()
      await new Promise<void>((_resolve, reject) => {
        const stop = () => reject(new ModFunctionError("MODS_CANCELLED"))
        signal.addEventListener("abort", stop, { once: true })
        if (signal.aborted) stop()
      })
      return { result: "must not publish" }
    }
  )
  const session = await fixture({ registeredTool })
  const operation = session.run("call", "ok")
  const failure = expect(operation).rejects.toThrow(/MODS_(CANCELLED|SESSION_CLOSED)/)
  await admission
  await session.close()
  await failure
  expect(registeredTool).toHaveBeenCalledOnce()
})
