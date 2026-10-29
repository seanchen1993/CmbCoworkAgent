import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { routeFunctionMcp } from "./mcp-tool-routing"
import { functionMcpToolResult, resolveFunctionMcpToolName } from "./mcp-sdk"
import type { ModObject } from "../../../shared/mods/types"
import type { McpCapabilityTool } from "../../mcp/capability-types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function fixture(hook: string) {
  let bound = false
  const resolve = vi.fn(async () => {
    bound = true
    try {
      return { name: "mcp__echo", fingerprint: "provider:generation:schema" }
    } finally {
      bound = false
    }
  })
  const invoke = vi.fn(async (input: ModObject) => {
    expect(bound).toBe(false)
    return {
      content: [{ type: "text", text: (input.args as ModObject).text }],
      isError: false,
      structuredContent: { protected: true }
    }
  })
  const native = vi.fn(async () => {
    expect(bound).toBe(false)
    return { result: "native read" }
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"run",description:"Run"});return next(e)});
    on("command.run",{command:"run"},async($,e)=>{
      try { return {text:JSON.stringify(e.args==="direct"
        ? await $.tool.call({tool:"mcp__echo",text:"direct",agentId:"forged",tool_use_id:"forged"})
        : await $.mcp.call("Mail","echo",{text:e.args}))} }
      catch(error) { return {text:"caught:"+error.message} }
    });
    ${hook}
  }}`)
  const session = new FunctionSession(
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
      publish: async (value) => JSON.parse(JSON.stringify(value).replaceAll("secret", "protected")),
      callMcp: (_, input, signal, dispatch) =>
        routeFunctionMcp(input, signal, dispatch, { resolve, invoke }),
      callTool: async (_, input) =>
        input.tool === "read_file"
          ? native()
          : functionMcpToolResult(await invoke({ args: { text: input.text } }))
    }
  )
  sessions.push(session)
  return { session, resolve, invoke, native }
}

it("routes named MCP calls through tool hooks with real names, caller origin, rewritten args and protected refs", async () => {
  const f = await fixture(`on("tool.call",{tool:"mcp__echo"},async($,e,next)=>{
    if(next.origin.plugin!=="demo"||e.tool_use_id==="forged"||e.agentId)throw Error("identity");
    await $.tool.call({tool:"read_file",file_path:"README.md"});
    return next({...e,text:"secret"})
  });`)
  expect(JSON.parse(String((await f.session.run("run", "original")).text))).toEqual({
    content: [{ type: "text", text: "protected" }],
    isError: false,
    structuredContent: { protected: true }
  })
  expect(f.resolve).toHaveBeenCalledOnce()
  expect(f.native).toHaveBeenCalledOnce()
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith(
    { server: "Mail", tool: "echo", args: { text: "secret" } },
    expect.any(AbortSignal),
    "provider:generation:schema"
  )
})

it("tool.call accepts scoped MCP names, strips supplied identity and does not dispatch mcp.call", async () => {
  const f = await fixture(`on("mcp.call",()=>{throw Error("wrong path")});
    on("tool.call",{tool:"mcp__echo"},(_,e,next)=>{
      if(e.agentId||e.tool_use_id==="forged")throw Error("identity");
      return next({...e,text:"changed"})
    });`)
  expect(JSON.parse(String((await f.session.run("run", "direct")).text))).toEqual({
    result: [{ type: "text", text: "changed" }],
    text: "changed"
  })
  expect(f.resolve).not.toHaveBeenCalled()
  expect(f.invoke).toHaveBeenCalledOnce()
})

it("a tool hook can deny or synthesize a named MCP result without an execution", async () => {
  const denied = await fixture(`on("tool.call",{tool:"mcp__echo"},()=>({deny:"secret denied"}));`)
  expect((await denied.session.run("run", "deny")).text).toContain("protected denied")
  expect(denied.invoke).not.toHaveBeenCalled()
  const synthetic = await fixture(`on("tool.call",{tool:"mcp__echo"},()=>({
    result:[{type:"resource",resource:{uri:"test://result",text:"secret"}}],isError:true
  }));`)
  expect(JSON.parse(String((await synthetic.session.run("run", "fake")).text))).toEqual({
    content: [{ type: "resource", resource: { uri: "test://result", text: "protected" } }],
    isError: true
  })
  expect(synthetic.invoke).not.toHaveBeenCalled()
})

it("matches actual scoped/canonical names and refuses ambiguous metadata instead of guessing a provider", () => {
  const tool = {
    toolId: "mcp__echo",
    canonicalToolId: "mcp__mail__echo",
    capabilityId: "real"
  } as McpCapabilityTool
  expect(resolveFunctionMcpToolName([tool], "mcp__echo")).toEqual(tool)
  expect(resolveFunctionMcpToolName([tool], "mcp__mail__echo")).toEqual(tool)
  expect(() => resolveFunctionMcpToolName([tool], "real")).toThrow("UNAVAILABLE")
  expect(() =>
    resolveFunctionMcpToolName([tool, { ...tool, capabilityId: "other" }], "mcp__echo")
  ).toThrow("AMBIGUOUS")
})

it("keeps result references scoped to one dispatch and does not erase a real error", async () => {
  const f = await fixture(`on("tool.call",{tool:"mcp__echo"},async(_,e,next)=>{
    const first=await next({...e,text:"first"});
    await next({...e,text:"second"});
    return {...first,result:[{type:"text",text:"ignored ref replacement"}]}
  });`)
  expect(JSON.parse(String((await f.session.run("run", "multiple")).text))).toEqual({
    content: [{ type: "text", text: "first" }],
    isError: false,
    structuredContent: { protected: true }
  })
  expect(f.invoke).toHaveBeenCalledTimes(2)
  const error = await fixture(`on("tool.call",{tool:"mcp__echo"},async(_,e,next)=>{
    await next(e); return {result:[{type:"text",text:"replacement"}]}
  });`)
  error.invoke.mockResolvedValue({
    content: [{ type: "text", text: "failed" }],
    isError: true,
    structuredContent: { protected: true }
  })
  expect(JSON.parse(String((await error.session.run("run", "error")).text))).toEqual({
    content: [{ type: "text", text: "replacement" }],
    isError: true
  })
})

it("does not replay a lost MCP reply through optional hook recovery", async () => {
  const f = await fixture(`on("tool.call",{tool:"mcp__echo"},async(_,e,next)=>{
    return next(e)
  });`)
  f.invoke.mockRejectedValue(Error("lost reply"))
  expect((await f.session.run("run", "lost")).text).toContain("caught:")
  expect(f.invoke).toHaveBeenCalledOnce()
})

it("uses the engine result projection for synthetic non-block MCP results rather than losing their text", async () => {
  const f = await fixture(`on("tool.call",{tool:"mcp__echo"},()=>({
    result:{message:"secret"},text:"not the engine result"
  }));`)
  expect(JSON.parse(String((await f.session.run("run", "fake")).text))).toEqual({
    content: [{ type: "text", text: JSON.stringify({ message: "protected" }) }],
    isError: false
  })
  expect(f.invoke).not.toHaveBeenCalled()
})
