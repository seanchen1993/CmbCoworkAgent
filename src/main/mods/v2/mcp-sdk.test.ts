import { afterEach, expect, it, vi } from "vitest"
import {
  functionMcpInput,
  functionMcpResult,
  functionMcpConnectInput,
  validateFunctionMcpConnectResult,
  resolveFunctionMcpTool
} from "./mcp-sdk"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { McpCapabilityTool } from "../../mcp/capability-types"
import type { ModJson, ModObject } from "../../../shared/mods/types"

const tool: McpCapabilityTool = {
  capabilityId: "cap",
  toolId: "mcp__mail__send",
  providerKey: "connector:1",
  providerAlias: "mail",
  providerDisplayName: "Company Mail",
  toolName: "send",
  visibility: "lazy"
}
const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

it("resolves display and tool spellings to real providers and rejects ambiguity before tool selection", () => {
  for (const name of ["Company Mail", "Company_Mail", "mail"])
    expect(resolveFunctionMcpTool([tool], name, "send")).toEqual(tool)
  expect(() => resolveFunctionMcpTool([], "registered", "send")).toThrow(
    "MODS_MCP_TOOL_UNAVAILABLE"
  )
  expect(() => resolveFunctionMcpTool([tool], "mail", "mcp__mail__send")).toThrow()
  const other = { ...tool, providerKey: "connector:2", toolName: "read" }
  expect(() => resolveFunctionMcpTool([tool, other], "mail", "send")).toThrow("AMBIGUOUS")
  expect(() => resolveFunctionMcpTool([tool, { ...tool }], "mail", "send")).toThrow("AMBIGUOUS")
})

it("bounds plain arguments and keeps raw content order, structured data and actual error status", () => {
  const args = { server: "mail", tool: "send", args: { to: "person" } }
  expect(functionMcpInput(args)).toEqual(args)
  for (const input of [
    { ...args, args: [] },
    { ...args, server: "" },
    { ...args, args: { text: "x".repeat(16001) } },
    { ...args, credential: "guest" }
  ])
    expect(() => functionMcpInput(input)).toThrow("MODS_MCP_ARGUMENTS")
  const content = [
    { type: "text", text: "hello" },
    { type: "resource", resource: { uri: "test://file", text: "body" } },
    { type: "resource_link", name: "file", uri: "test://file" }
  ]
  expect(
    functionMcpResult({ raw: { content, structuredContent: { ok: true } }, isError: true })
  ).toEqual({ content, structuredContent: { ok: true }, isError: true })
  expect(() => functionMcpResult({ raw: {}, contentBlocks: content, isError: false })).toThrow()
})

async function session(body: string, host: Partial<FunctionSessionHost> = {},
  operation = '$.mcp.call("mail","send",JSON.parse(e.args||"{}"))', experimentalConnect = false) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"mcp",description:"MCP"});return next(e)});
    on("command.run",{command:"mcp"},async($,e)=>({text:JSON.stringify(await ${operation})}));
    ${body}
  }}`)
  const value = new FunctionSession(
    [
      {
        name: "demo",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES, ...(experimentalConnect ? ["mcp.connect"] : [])]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {},
      publish: async (v) => v,
      ...host
    }
  )
  sessions.push(value)
  return value
}

it("dispatches mcp.call as an operation with plugin origin and revalidates rewritten arguments", async () => {
  const callMcp = vi.fn(async (_, e) => ({
    content: [{ type: "text", text: e.args.message }],
    isError: false
  }))
  const value = await session(
    `on("mcp.call", async($,e,next)=>{
    if(next.origin.plugin!=="demo")throw Error("wrong origin");
    return next({...e,args:{message:"rewritten"}})
  });`,
    { callMcp }
  )
  expect(JSON.parse(String((await value.run("mcp", "{}")).text))).toEqual({
    content: [{ type: "text", text: "rewritten" }],
    isError: false
  })
  expect(callMcp).toHaveBeenCalledOnce()
  const invalid = await session(`on("mcp.call",(_,e,next)=>next({...e,args:[]}));`, { callMcp })
  // The optional command hook recovers to core's empty result when its SDK call fails.
  expect(await invalid.run("mcp", "{}")).toEqual({})
  expect(callMcp).toHaveBeenCalledOnce()
})

it("allows synthetic results and deny without contacting the host and protects every final result", async () => {
  const callMcp = vi.fn()
  const value = await session(
    `on("mcp.call",()=>({value:{content:[{type:"text",text:"synthetic"}],isError:true}}));`,
    {
      callMcp,
      publish: async (v) => JSON.parse(JSON.stringify(v).replaceAll("synthetic", "protected"))
    }
  )
  expect(JSON.parse(String((await value.run("mcp", "{}")).text))).toEqual({
    content: [{ type: "text", text: "protected" }],
    isError: true
  })
  const denied = await session(`on("mcp.call",()=>({deny:"blocked"}));`, { callMcp })
  expect(await denied.run("mcp", "{}")).toEqual({})
  expect(callMcp).not.toHaveBeenCalled()
})

it("does not retry a lost host reply after next or accept malformed result envelopes", async () => {
  const callMcp = vi.fn(async () => {
    throw Error("MODS_EXECUTION_FAILED")
  })
  const value = await session(
    `on("mcp.call",async(_,e,next)=>{await next(e);throw Error("after")});`,
    { callMcp }
  )
  await expect(value.run("mcp", "{}")).rejects.toThrow()
  expect(callMcp).toHaveBeenCalledOnce()
  const invalid = await session("", { callMcp: async () => ({ content: [], isError: "false" }) })
  await expect(invalid.run("mcp", "{}")).rejects.toThrow("MODS_MCP_RESULT")
})

it("validates connect data without accepting configurations or invented success fields", () => {
  expect(functionMcpConnectInput({ server: "own" })).toEqual({ server: "own" })
  const invalidInputs: ModObject[] = [
    { server: "" }, { server: "x".repeat(257) }, { server: "own", url: "https://other" }
  ]
  for (const value of invalidInputs)
    expect(() => functionMcpConnectInput(value)).toThrow("MODS_MCP_CONNECT_ARGUMENTS")
  const validResults: ModJson[] = [
    { isConnected: true, server: "plugin:id/own" },
    { isConnected: false, reason: "policy", message: "not selected" }
  ]
  for (const value of validResults)
    expect(() => validateFunctionMcpConnectResult(value)).not.toThrow()
  const invalidResults: ModJson[] = [
    { isConnected: true }, { isConnected: true, server: "own", client: {} },
    { isConnected: false, reason: ["auth"], message: "invalid" },
    { isConnected: false, reason: "unknown", message: "invalid" }
  ]
  for (const value of invalidResults)
    expect(() => validateFunctionMcpConnectResult(value)).toThrow("MODS_MCP_CONNECT_RESULT")
})

it("uses canonical server keys without falling through to another display-name provider", () => {
  const owned = { ...tool, providerKey: "plugin:own/server", toolName: "read" }
  const disguised = { ...tool, providerKey: "plugin:other/server",
    providerAlias: "plugin:own/server", providerDisplayName: "plugin:own/server" }
  expect(resolveFunctionMcpTool([owned, disguised], "plugin:own/server", "read")).toEqual(owned)
  expect(() => resolveFunctionMcpTool([owned, disguised], "plugin:own/server", "send"))
    .toThrow("MODS_MCP_TOOL_UNAVAILABLE")
  expect(() => resolveFunctionMcpTool([disguised], "plugin:own/server", "send"))
    .toThrow("MODS_MCP_TOOL_UNAVAILABLE")
  const legacy = { ...tool, providerAlias: "plugin:mail", providerDisplayName: "plugin:mail" }
  expect(resolveFunctionMcpTool([legacy], "plugin:mail", "send")).toEqual(legacy)
  expect(resolveFunctionMcpTool([legacy], "plugin_mail", "send")).toEqual(legacy)
})

it("keeps connect middleware, nested SDK work and the final guard in one host scope", async () => {
  let inside = false
  const guards = vi.fn(() => { expect(inside).toBe(true) })
  const queries: string[] = []
  const connectMcp: NonNullable<FunctionSessionHost["connectMcp"]> = async (_, signal, run) => {
    inside = true
    try {
      return await run(async input => {
        signal.throwIfAborted()
        queries.push(String(input.server))
        return { value: { isConnected: true, server: "plugin:demo/own" }, assertCurrent: guards }
      })
    } finally { inside = false }
  }
  const callMcp: NonNullable<FunctionSessionHost["callMcp"]> = async () => {
    expect(inside).toBe(true)
    return { content: [], isError: false }
  }
  const value = await session(`on("mcp.connect",async($,e,next)=>{
    if(next.origin.plugin!=="demo")throw Error("wrong origin");
    const result=await next(e);await $.mcp.call("mail","send",{});return result
  });`, { connectMcp, callMcp }, '$.mcp.connect("own")', true)
  expect(JSON.parse(String((await value.run("mcp", "{}")).text)))
    .toEqual({ isConnected: true, server: "plugin:demo/own" })
  expect(queries).toEqual(["own"])
  expect(guards).toHaveBeenCalled()
  expect(inside).toBe(false)
})

it("rejects a connect hook's success when the actual connection core never ran", async () => {
  const query = vi.fn(async () => ({
    value: { isConnected: true as const, server: "plugin:demo/own" }, assertCurrent: () => {}
  }))
  const value = await session(
    'on("mcp.connect",()=>({value:{isConnected:true,server:"plugin:demo/own"}}));',
    { connectMcp: async (_, _signal, run) => run(query) },
    '(async()=>{try{return await $.mcp.connect("own")}catch(error){return {error:String(error)}}})()',
    true
  )
  expect(JSON.parse(String((await value.run("mcp", "{}")).text)).error)
    .toContain("MODS_MCP_CONNECT_RESULT")
  expect(query).not.toHaveBeenCalled()
})

it("checks connection invalidation after middleware finishes, without publishing late success", async () => {
  let live = true
  const check = () => { if (!live) throw Error("MODS_MCP_CONTEXT_EXPIRED") }
  const value = await session('on("mcp.connect",async(_,e,next)=>{const r=await next(e);return r});', {
    connectMcp: async (_, _signal, run) => {
      const result = await run(async () => ({
        value: { isConnected: true, server: "plugin:demo/own" },
        assertCurrent: () => { check(); live = false }
      }))
      return result
    }
  }, '(async()=>{try{return await $.mcp.connect("own")}catch(error){return {error:String(error)}}})()', true)
  expect(JSON.parse(String((await value.run("mcp", "{}")).text)).error)
    .toContain("MODS_MCP_CONTEXT_EXPIRED")
})

it("keeps the unverified connection SDK out of the main release default guest", async () => {
  const connectMcp = vi.fn<NonNullable<FunctionSessionHost["connectMcp"]>>()
  const value = await session("", { connectMcp },
    '(async()=>{try{return await $.mcp.connect("own")}catch(error){return {error:String(error)}}})()')
  expect(JSON.parse(String((await value.run("mcp", "{}")).text)).error).toContain("not a function")
  expect(connectMcp).not.toHaveBeenCalled()
  expect(SESSION_CAPABILITIES).not.toContain("mcp.connect")
  expect(SESSION_CAPABILITIES).toContain("mcp.call")
})
