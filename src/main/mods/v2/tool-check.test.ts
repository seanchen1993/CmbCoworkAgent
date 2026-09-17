import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { functionToolCheckInput, validateToolCheckResult } from "./tool-check"
import { constrainToolPermission } from "../../../shared/tool-permission"
import type { ModJson } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function create(body: string, host: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"check",description:"Check"});return next(e)});
    on("command.run",{command:"check"},async($)=>({text:JSON.stringify(await $.tool.check({tool:"read_file",input:{file_path:"a"}}))}));
    ${body}
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
      publish: async (value) => value,
      ...host
    }
  )
  sessions.push(session)
  return session
}

it("validates the query envelope and rejects forged execution ids and malformed verdicts", () => {
  expect(functionToolCheckInput({ tool: "read_file", input: { file_path: "a" } })).toEqual({
    tool: "read_file",
    input: { file_path: "a" }
  })
  expect(() =>
    functionToolCheckInput({ tool: "read_file", input: {}, tool_use_id: "forged" })
  ).toThrow("ARGUMENTS")
  for (const value of [
    { decision: "yes" },
    { decision: "allow", value: {} },
    { decision: "ask", reason: 1 }
  ] as ModJson[])
    expect(() => validateToolCheckResult(value)).toThrow("RESULT")
  expect(
    constrainToolPermission({ decision: "allow" }, { decision: "deny", rule: "managed" })
  ).toEqual({ decision: "deny", rule: "managed" })
})

it("uses a bare verdict, query origin and pinned arguments without invoking a tool", async () => {
  const callTool = vi.fn()
  const checkTool = vi.fn<NonNullable<FunctionSessionHost["checkTool"]>>(async () => ({
    decision: "allow"
  }))
  const session = await create(
    `on("tool.check",async($,e,next)=>{
    if(e.tool_use_id!==undefined||next.origin.plugin!=="demo")throw Error("identity");
    const result=await next(e);return {...result,reason:"checked"};
  });`,
    { checkTool, callTool }
  )
  expect(JSON.parse(String((await session.run("check", "")).text))).toEqual({
    decision: "allow",
    reason: "checked"
  })
  expect(checkTool).toHaveBeenCalledTimes(2)
  expect(checkTool.mock.calls[0][1]).toEqual({ tool: "read_file", input: { file_path: "a" } })
  expect(callTool).not.toHaveBeenCalled()
})

it("rechecks mandatory policy even when a hook short-circuits to allow", async () => {
  const checkTool = vi.fn(async () => ({ decision: "deny" as const, reason: "host policy" }))
  const session = await create('on("tool.check",()=>({decision:"allow"}));', { checkTool })
  expect(JSON.parse(String((await session.run("check", "")).text))).toEqual({
    decision: "deny",
    reason: "host policy"
  })
  expect(checkTool).toHaveBeenCalledOnce()
})

it("retains real-call identity and recovers a failed rewrite using the original input", async () => {
  const session = await create(`on("tool.check",async($,e,next)=>{
    if(e.tool_use_id!=="actual"||next.origin.plugin!=="engine")throw Error("identity");
    return next({...e,input:{file_path:"other"}});
  });`)
  const core = vi.fn(async (input) => {
    expect(input).toEqual({ tool: "read_file", input: { file_path: "a" }, tool_use_id: "actual" })
    return { decision: "allow" }
  })
  await expect(
    session.checkTool(
      { tool: "read_file", input: { file_path: "a" }, tool_use_id: "actual" },
      undefined,
      core
    )
  ).resolves.toEqual({ decision: "allow" })
  expect(core).toHaveBeenCalledOnce()
})

it("publishes a clamped host verdict and rejects a registry owner revoked during a query", async () => {
  let revoked = false
  const session = await create('on("tool.check",()=>({decision:"allow"}));', {
    checkTool: async () => ({ decision: "deny", reason: "private" }),
    publish: async (value) => JSON.parse(JSON.stringify(value).replaceAll("private", "protected"))
  })
  expect(JSON.parse(String((await session.run("check", "")).text))).toEqual({
    decision: "deny",
    reason: "protected"
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.tool.register({name:"read",description:"Read"});
      await $.command.register({name:"query-owned",description:"Query"});return next(e)});
    on("command.run",{command:"query-owned"},async($)=>({text:JSON.stringify(await $.tool.check({tool:"mcp__owner__read",input:{}}))}));
  }}`)
  const owned = new FunctionSession(
    [
      {
        name: "owner",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      publish: async (value) => value,
      assertLive: () => {
        if (revoked) throw Error("revoked")
      },
      checkTool: async () => {
        revoked = true
        return { decision: "allow" }
      }
    }
  )
  sessions.push(owned)
  await expect(owned.run("query-owned", "")).rejects.toThrow("revoked")
})
