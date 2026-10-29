import { afterEach, expect, it, vi } from "vitest"
import { functionMcpInput, functionMcpResult, resolveFunctionMcpTool } from "./mcp-sdk"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { McpCapabilityTool } from "../../mcp/capability-types"

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

async function session(body: string, host: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"mcp",description:"MCP"});return next(e)});
    on("command.run",{command:"mcp"},async($,e)=>({text:JSON.stringify(await $.mcp.call("mail","send",JSON.parse(e.args||"{}")))}));
    ${body}
  }}`)
  const value = new FunctionSession(
    [
      {
        name: "demo",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
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
