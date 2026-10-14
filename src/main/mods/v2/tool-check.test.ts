import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { createToolCheckResultParser, functionToolCheckInput, validateToolCheckResult } from "./tool-check"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import { constrainToolPermission } from "../../../shared/tool-permission"
import type { ModJson, ModObject } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function create(body: string, host: Partial<FunctionSessionHost> = {},
  query = '{tool:"read_file",input:{file_path:"a"}}',
  extraPlugins: readonly { name: string; body: string }[] = []) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"check",description:"Check"});return next(e)});
    on("command.run",{command:"check"},async($)=>({text:JSON.stringify(await $.tool.check(${query}))}));
    ${body}
  }}`)
  const guests = [guest]
  const plugins: FunctionPlugin[] = [{ name: "demo", root: "/plugin", tier: "user",
    guest, capabilities: [...SESSION_CAPABILITIES] }]
  try {
    for (const extra of extraPlugins) {
      const inner = await FunctionGuestRuntime.create(
        `var __cmbFunctionMod={register(on){${extra.body}}}`
      )
      guests.push(inner)
      plugins.push({ name: extra.name, root: `/plugin/${extra.name}`, tier: "append",
        guest: inner, capabilities: [...SESSION_CAPABILITIES] })
    }
    const session = new FunctionSession(plugins, {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {},
      publish: async (value) => value,
      ...host
    })
    sessions.push(session)
    return session
  } catch (error) {
    for (const actual of guests) actual.dispose()
    throw error
  }
}

it("strips caller query identity while retaining strict envelopes and malformed verdict rejection", () => {
  expect(functionToolCheckInput({ tool: "read_file", input: { file_path: "a" } })).toEqual({
    tool: "read_file",
    input: { file_path: "a" }
  })
  expect(
    functionToolCheckInput({ tool: "read_file", input: {}, tool_use_id: "forged" })
  ).toEqual({ tool: "read_file", input: {} })
  expect(() => functionToolCheckInput({ tool: "read_file", input: {}, unknown: true }))
    .toThrow("ARGUMENTS")
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

it.each(["allow", "deny", "not-a-decision", 17, null] as ModJson[])(
  "discards a proposed ceiling %j before validating against the original question",
  ceiling => {
    const parse = createToolCheckResultParser({ tool: "read_file", input: {}, ceiling: "ask" })
    expect(parse({ decision: "allow", ceiling, hook: "OtherHook" })).toEqual({
      decision: "allow", hook: "OtherHook", ceiling: "ask"
    })
    expect(createToolCheckResultParser({ tool: "read_file", input: {} })({
      decision: "allow", ceiling
    })).toEqual({ decision: "allow" })
  }
)

it("fixes the question snapshot and keeps synthetic ceiling independent from mandatory decision", () => {
  const question = { tool: "read_file", input: {}, ceiling: "deny" }
  const parse = createToolCheckResultParser(question)
  question.ceiling = "allow"
  expect(parse({ decision: "allow" })).toEqual({ decision: "allow", ceiling: "deny" })
  expect(parse(constrainToolPermission(
    parse({ decision: "allow", hook: "PreToolUse" }),
    { decision: "ask", reason: "mandatory" }
  ))).toEqual({ decision: "ask", reason: "mandatory", ceiling: "deny" })
})

it.each(["PreToolUse", "OtherHook"])("retains informational hook %s without classic effects", async hook => {
  const callTool = vi.fn()
  const checkTool = vi.fn(async () => ({ decision: "allow" as const }))
  const session = await create(`
    on("classic.PreToolUse",()=>{throw Error("classic must not execute")});
    on("tool.check",async($,e,next)=>({...await next(e),hook:${JSON.stringify(hook)}}));
  `, { checkTool, callTool })
  const classic = vi.spyOn(session, "classicEvent")
  expect(JSON.parse(String((await session.run("check", "")).text))).toEqual({
    decision: "allow", hook
  })
  expect(checkTool).toHaveBeenCalledTimes(2)
  expect(callTool).not.toHaveBeenCalled()
  expect(classic).not.toHaveBeenCalled()
})

it("recovers a non-string hook result using the already settled downstream verdict once", async () => {
  const session = await create('on("tool.check",async($,e,next)=>({...await next(e),hook:17}));')
  const core = vi.fn(async () => ({ decision: "ask" as const, reason: "actual core" }))
  await expect(session.checkTool({ tool: "read_file", input: {}, ceiling: "deny" }, undefined, core))
    .resolves.toEqual({ decision: "ask", reason: "actual core", ceiling: "deny" })
  expect(core).toHaveBeenCalledOnce()
})

it.each(["tool_use_id", "agentId", "ceiling"])(
  "projects caller query %s away before hooks and both real mandatory queries", async key => {
    const checkTool = vi.fn<NonNullable<FunctionSessionHost["checkTool"]>>(async () => ({
      decision: "allow", ceiling: "deny"
    }))
    const session = await create(`on("tool.check",async($,e,next)=>{
      if(Object.keys(e).sort().join(",")!=="input,tool")throw Error("query fields");
      const result=await next(e);
      if(result.ceiling!==undefined)throw Error("query result ceiling");
      return {...result,reason:"projected",ceiling:17};
    });`, { checkTool }, JSON.stringify({ tool: "read_file", input: { file_path: "a" },
      [key]: key === "ceiling" ? "deny" : "forged" }))
    expect(JSON.parse(String((await session.run("check", "")).text))).toEqual({
      decision: "allow", reason: "projected"
    })
    expect(checkTool).toHaveBeenCalledTimes(2)
    for (const call of checkTool.mock.calls) expect(call[1]).toEqual({
      tool: "read_file", input: { file_path: "a" }
    })
  }
)

it("keeps all real-call pins and the original ceiling visible through two guest layers and core", async () => {
  const input = { tool: "read_file", input: { file_path: "a" }, tool_use_id: "actual",
    agentId: "actual-child", ceiling: "ask" }
  const session = await create(`
    on("tool.check",async($,e,next)=>{
      if(e.tool_use_id!=="actual"||e.agentId!=="actual-child"||e.ceiling!=="ask")throw Error("outer pins");
      const result=await next({tool:e.tool,input:e.input});
      if(result.ceiling!=="ask"||result.reason!=="inner")throw Error("outer next");
      return {...result,reason:"outer",hook:"OtherHook",ceiling:null};
    });
  `, {}, undefined, [{ name: "inner", body: `
    on("tool.check",async($,e,next)=>{
      if(e.tool_use_id!=="actual"||e.agentId!=="actual-child"||e.ceiling!=="ask")throw Error("inner pins");
      const result=await next(e);
      if(result.ceiling!=="ask"||result.reason!=="core")throw Error("inner next");
      return {...result,reason:"inner",ceiling:17};
    });
  ` }])
  const core = vi.fn(async (received: ModObject) => {
    expect(received).toEqual(input)
    return { decision: "allow", reason: "core", ceiling: "not-a-decision" }
  })
  await expect(session.checkTool(input, undefined, core)).resolves.toEqual({
    decision: "allow", reason: "outer", hook: "OtherHook", ceiling: "ask"
  })
  expect(core).toHaveBeenCalledOnce()
})

it.each(["agentId", "ceiling"])("recovers a changed real-call %s without changing core identity", async key => {
  const input = { tool: "read_file", input: {}, tool_use_id: "actual",
    agentId: "actual-child", ceiling: "ask" }
  const session = await create(`on("tool.check",async($,e,next)=>next({...e,
    ${key}:${JSON.stringify(key === "ceiling" ? "deny" : "other-child")}}));`)
  const core = vi.fn(async (received: ModObject) => {
    expect(received).toEqual(input)
    return { decision: "deny", reason: "original" }
  })
  await expect(session.checkTool(input, undefined, core)).resolves.toEqual({
    decision: "deny", reason: "original", ceiling: "ask"
  })
  expect(core).toHaveBeenCalledOnce()
})

it("recovers added absent identity fields and rejects malformed real input before core", async () => {
  const session = await create('on("tool.check",async($,e,next)=>next({...e,agentId:"fake",ceiling:"deny"}));')
  const core = vi.fn(async (received: ModObject) => {
    expect(received).toEqual({ tool: "read_file", input: {} })
    return { decision: "allow" }
  })
  await expect(session.checkTool({ tool: "read_file", input: {} }, undefined, core))
    .resolves.toEqual({ decision: "allow" })
  expect(core).toHaveBeenCalledOnce()
  const invalidInputs: ModObject[] = [{ agentId: 17 }, { agentId: "" }, { ceiling: "no" }]
  for (const fields of invalidInputs)
    await expect(session.checkTool({ tool: "read_file", input: {}, ...fields }, undefined, core))
      .rejects.toThrow("ARGUMENTS")
  expect(core).toHaveBeenCalledOnce()
})

it("normalizes a catch result and short-circuit result without replaying the permission core", async () => {
  const session = await create(`on("tool.check",()=>{throw Error("optional")})
    .catch(()=>({decision:"allow",hook:"OtherHook",ceiling:17}));`)
  const core = vi.fn(async () => ({ decision: "deny" }))
  await expect(session.checkTool({ tool: "read_file", input: {}, ceiling: "ask" }, undefined, core))
    .resolves.toEqual({ decision: "allow", hook: "OtherHook", ceiling: "ask" })
  expect(core).not.toHaveBeenCalled()
})

it("restores original result metadata after real host publication and keeps protected reason", async () => {
  const publish = vi.fn(async (value: ModJson) => {
    if (value && typeof value === "object" && !Array.isArray(value) && value.decision)
      return { ...value, reason: "protected", ceiling: "deny" }
    return value
  })
  const session = await create('on("tool.check",async($,e,next)=>next(e));', { publish })
  const question = { tool: "read_file", input: {}, ceiling: "ask" }
  const core = vi.fn(async () => {
    question.ceiling = "deny"
    return { decision: "allow", reason: "private", ceiling: "allow" }
  })
  await expect(session.checkTool(question, undefined, core)).resolves.toEqual({
    decision: "allow", reason: "protected", ceiling: "ask"
  })
  expect(core).toHaveBeenCalledOnce()
})

it("keeps a nested SDK query in its actual permission domain without inheriting parent metadata", async () => {
  const checkTool = vi.fn<NonNullable<FunctionSessionHost["checkTool"]>>(async () => ({
    decision: "allow", ceiling: "deny"
  }))
  const session = await create(`
    on("tool.check",async($,e,next)=>{
      if(e.tool_use_id!=="actual")throw Error("outer actual call");
      const nested=await $.tool.check({tool:"read_file",input:{file_path:"nested"},
        tool_use_id:e.tool_use_id,agentId:e.agentId,ceiling:e.ceiling});
      if(nested.ceiling!==undefined||nested.hook!=="OtherHook")throw Error("nested metadata");
      return {...await next(e),reason:JSON.stringify(nested)};
    });
  `, { checkTool }, undefined, [{ name: "inner", body: `
    on("tool.check",async($,e,next)=>{
      if(e.input.file_path==="nested"&&
        (Object.keys(e).sort().join(",")!=="input,tool"||next.origin.plugin!=="demo"))
        throw Error("nested question");
      return {...await next(e),hook:"OtherHook"};
    });
  ` }])
  const core = vi.fn(async (received: ModObject) => {
    expect(received).toEqual({ tool: "read_file", input: { file_path: "outer" },
      tool_use_id: "actual", agentId: "actual-child", ceiling: "ask" })
    return { decision: "allow" }
  })
  await expect(session.checkTool({ tool: "read_file", input: { file_path: "outer" },
    tool_use_id: "actual", agentId: "actual-child", ceiling: "ask" }, undefined, core))
    .resolves.toEqual({ decision: "allow", hook: "OtherHook", ceiling: "ask",
      reason: JSON.stringify({ decision: "allow", hook: "OtherHook" }) })
  expect(core).toHaveBeenCalledOnce()
  expect(checkTool).toHaveBeenCalledTimes(2)
  for (const call of checkTool.mock.calls) expect(call[1]).toEqual({
    tool: "read_file", input: { file_path: "nested" }
  })
})

it("rejects accessor and unknown verdict fields without executing getters or relaxing text bounds", () => {
  const parse = createToolCheckResultParser({ tool: "read_file", input: {} })
  let reads = 0
  const value: ModObject = { decision: "allow" }
  Object.defineProperty(value, "ceiling", { enumerable: true, get() { reads++; return "deny" } })
  expect(() => parse(value)).toThrow("MODS_JSON_ACCESSOR")
  expect(reads).toBe(0)
  const invalidResults: ModJson[] = [{ decision: "allow", unknown: true },
    { decision: "allow", hook: 17 }, { decision: "ask", reason: "x".repeat(8001) }]
  for (const malformed of invalidResults)
    expect(() => parse(malformed)).toThrow("MODS_TOOL_CHECK_RESULT")
})

it("parses every dispatcher protection exit while leaving a generic dispatcher untouched", async () => {
  const parser = createToolCheckResultParser({ tool: "read_file", input: {}, ceiling: "ask" })
  const dispatcher = new FunctionDispatcher([])
  const protectResult = vi.fn(async () => ({ decision: "allow", hook: "OtherHook", ceiling: 17 }))
  const result = await dispatcher.dispatch("tool.check", { tool: "read_file", input: {} }, {
    core: async () => ({ decision: "allow", ceiling: "bad" }),
    parseResult: (_event, value) => parser(value), validateResult: (_event, value) => validateToolCheckResult(value),
    protectResult
  })
  expect(result.value).toEqual({ decision: "allow", hook: "OtherHook", ceiling: "ask" })
  expect(protectResult).toHaveBeenCalledOnce()
  const generic = { decision: "custom", ceiling: 17 }
  expect((await dispatcher.dispatch("custom.event", {}, { core: async () => generic })).value)
    .toEqual(generic)
})

it.each(["getter", "data"] as const)(
  "ignores inherited ceiling %s installed by the real permission source without granting metadata",
  async mode => {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "ceiling")
    let reads = 0, installed = false
    const checkTool = vi.fn<NonNullable<FunctionSessionHost["checkTool"]>>(async () => {
      if (!installed) {
        installed = true
        Object.defineProperty(Object.prototype, "ceiling", mode === "getter"
          ? { configurable: true, get() { reads++; return "deny" } }
          : { configurable: true, writable: true, value: "deny" })
      }
      return { decision: "allow" }
    })
    const session = await create(`on("tool.check",async($,e,next)=>{
      const result=await next(e);
      if(Object.prototype.hasOwnProperty.call(result,"ceiling"))throw Error("fake ceiling");
      return {...result,reason:"own question"};
    });`, { checkTool })
    let answer: unknown, restored: unknown, absence = false, getterRejected = false
    let missingRejected = false
    try {
      answer = JSON.parse(String((await session.run("check", "")).text))
      const query = functionToolCheckInput({ tool: "read_file", input: {} })
      absence = !Object.hasOwn(query, "ceiling")
      restored = createToolCheckResultParser({ tool: "read_file", input: {}, ceiling: "ask" })({
        decision: "allow"
      })
      const malformed: ModObject = { decision: "allow" }
      Object.defineProperty(malformed, "hook", { enumerable: true, get() { reads++; return "fake" } })
      try { validateToolCheckResult(malformed) }
      catch (error) { getterRejected = error instanceof Error && error.message === "MODS_TOOL_CHECK_RESULT" }
      try { validateToolCheckResult({}) }
      catch (error) { missingRejected = error instanceof Error && error.message === "MODS_TOOL_CHECK_RESULT" }
    } finally {
      if (prior) Object.defineProperty(Object.prototype, "ceiling", prior)
      else Reflect.deleteProperty(Object.prototype, "ceiling")
    }
    expect(answer).toEqual({ decision: "allow", reason: "own question" })
    expect(restored).toEqual({ decision: "allow", ceiling: "ask" })
    expect(absence).toBe(true)
    expect(getterRejected).toBe(true)
    expect(missingRejected).toBe(true)
    expect(reads).toBe(0)
    expect(checkTool).toHaveBeenCalledTimes(2)
  }
)
