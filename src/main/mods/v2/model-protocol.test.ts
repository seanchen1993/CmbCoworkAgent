import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import {
  parseFunctionModelProtocol,
  validateFunctionModelResult,
  type FunctionModelProtocol
} from "../../../shared/mods/v2/model-protocol"
import type { FunctionGuest } from "../../../shared/mods/v2/contracts"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
const usage = {
  input_tokens: 1,
  output_tokens: 2,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 4
}
const answer = { isAnswered: true as const, text: "answer", usage }

async function plugin(
  name: string,
  protocol: FunctionModelProtocol | undefined,
  body: string
): Promise<FunctionPlugin> {
  return {
    name,
    root: `/${name}`,
    tier: "user",
    modelProtocol: protocol,
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  }
}
async function session(protocol: FunctionModelProtocol | undefined, observers: FunctionPlugin[] = []) {
  const caller = await plugin(
    "caller",
    protocol,
    `
    on("session.start", async ($,e,next)=>{await $.command.register({name:"probe",description:"Probe"});return next(e)});
    on("command.run", async ($)=>({text:JSON.stringify(await $.model.complete({model:"default",prompt:"hi"}))}));
  `
  )
  const old = vi.fn(async () => "old answer")
  const modern = vi.fn(async () => answer)
  const result = new FunctionSession([caller, ...observers], {
    workspace: "/workspace",
    threadId: "thread",
    assertLive: () => undefined,
    publish: async (value) => value,
    completeModel: old,
    completeModelResult: modern
  })
  sessions.push(result)
  await result.start()
  return { result, old, modern }
}

it("keeps legacy string results while explicitly selected modern calls receive a union", async () => {
  const old = await session("legacy-v1")
  expect((await old.result.run("probe", "")).text).toBe(JSON.stringify("old answer"))
  expect(old.modern).not.toHaveBeenCalled()
  const modern = await session("result-v1")
  expect(JSON.parse(String((await modern.result.run("probe", "")).text))).toEqual(answer)
  expect(modern.old).not.toHaveBeenCalled()
})

it("preserves structured same-mode after-hooks and separate next requests", async () => {
  const observer = await plugin(
    "observer",
    "result-v1",
    `on("model.complete",async($,e,next)=>{
    await next(e); const result=await next(e); return {value:{...result.value,text:"changed"}};
  });`
  )
  const f = await session("result-v1", [observer])
  expect(JSON.parse(String((await f.result.run("probe", "")).text))).toEqual({
    ...answer,
    text: "changed"
  })
  expect(f.modern).toHaveBeenCalledTimes(2)
})

it.each(["model.complete", "model.*", "*"])(
  "rejects cross-mode %s before provider or observer side effects",
  async (pattern) => {
    const observer = await plugin(
      "old-observer",
      "legacy-v1",
      `on(${JSON.stringify(pattern)},async($,e,next)=>next(e));`
    )
    const f = await session("result-v1", [observer])
    await expect(f.result.run("probe", "")).rejects.toThrow("conflicts with old-observer")
    expect(f.modern).not.toHaveBeenCalled()
  }
)

it("checks the frozen chain before matcher false and tier bypass can hide a conflict", async () => {
  const matches = vi.fn(async () => false),
    invoke = vi.fn()
  const legacy = {
    name: "legacy",
    modelProtocol: "legacy-v1" as const,
    root: "/legacy",
    tier: "append" as const,
    capabilities: [],
    guest: {
      registrations: [{ id: "0", pattern: "model.*", hasCatch: true }],
      matches,
      invoke
    } as unknown as FunctionGuest
  }
  const core = vi.fn(async () => ({}))
  const dispatcher = new FunctionDispatcher([legacy])
  await expect(
    dispatcher.dispatch(
      "model.complete",
      {},
      {
        core,
        validateChain: (plugins) => {
          if (plugins.some((p) => (p.modelProtocol ?? "result-v1") !== "result-v1"))
            throw Error("conflict")
        }
      }
    )
  ).rejects.toThrow("conflict")
  expect(matches).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
  expect(core).not.toHaveBeenCalled()
})

it("validates closed manifest options and every new result arm", () => {
  expect(parseFunctionModelProtocol(undefined)).toBe("result-v1")
  expect(parseFunctionModelProtocol({ modelProtocol: "legacy-v1" })).toBe("legacy-v1")
  expect(parseFunctionModelProtocol({ modelProtocol: "result-v1" })).toBe("result-v1")
  for (const value of [
    null,
    {},
    { modelProtocol: ["result-v1"] },
    { modelProtocol: "result-v1", extra: true }
  ])
    expect(() => parseFunctionModelProtocol(value)).toThrow()
  for (const value of [
    answer,
    { isAnswered: false, reason: "empty-reply", usage },
    { isAnswered: false, reason: "aborted", usage },
    { isAnswered: false, reason: "api-error", status: 429, error: "rate_limit", usage }
  ])
    expect(() => validateFunctionModelResult(value)).not.toThrow()
  expect(() =>
    validateFunctionModelResult({ isAnswered: false, reason: "nothing-to-fork" }, true)
  ).not.toThrow()
  for (const value of [
    { ...answer, text: "" },
    { ...answer, usage: {} },
    { ...answer, extra: true },
    { isAnswered: false, reason: "nothing-to-fork" },
    { isAnswered: false, reason: "api-error", status: 700, error: "unknown", usage },
    { isAnswered: false, reason: "api-error", status: null, error: "secret error text", usage }
  ])
    expect(() => validateFunctionModelResult(value)).toThrow()
})

it("freezes each nested caller mode without contaminating its parent operation", async () => {
  const modern = await plugin(
    "modern",
    "result-v1",
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"modern",description:"Modern"});return next(e)});
    on("command.run",{command:"modern"},async($)=>{
      const old=await $.legacyModel.call({});
      const result=await $.model.complete({model:"default",prompt:"modern"});
      return {text:JSON.stringify([old,result])};
    });`
  )
  const legacy = await plugin(
    "legacy",
    "legacy-v1",
    `
    on("engine.create",async($,e,next)=>{
      const built=await next(e);return {...built,legacyModel:{call:async()=>built.model.complete({model:"default",prompt:"old"})}};
    });`
  )
  const old = vi.fn(async () => "old"),
    structured = vi.fn(async () => answer)
  const f = new FunctionSession([modern, legacy], {
    workspace: "/workspace",
    threadId: "thread",
    assertLive: () => undefined,
    publish: async (value) => value,
    completeModel: old,
    completeModelResult: structured
  })
  sessions.push(f)
  await f.start()
  expect(JSON.parse(String((await f.run("modern", "")).text))).toEqual(["old", answer])
  expect(old).toHaveBeenCalledOnce()
  expect(structured).toHaveBeenCalledOnce()
})

it("never swallows a nested protocol conflict inside optional recovery", async () => {
  const caller = await plugin(
    "caller",
    "result-v1",
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"recover",description:"Recover"});return next(e)});
    on("command.run",async()=>{throw Error("ordinary hook failure")})
      .catch(async($)=>({text:JSON.stringify(await $.model.complete({model:"default",prompt:"hi"}))}));`
  )
  const observer = await plugin(
    "old-observer",
    "legacy-v1",
    `on("model.complete",async($,e,next)=>next(e));`
  )
  const modern = vi.fn(async () => answer)
  const f = new FunctionSession([caller, observer], {
    workspace: "/workspace",
    threadId: "thread",
    assertLive: () => undefined,
    publish: async (value) => value,
    completeModelResult: modern
  })
  sessions.push(f)
  await f.start()
  await expect(f.run("recover", "")).rejects.toThrow("conflicts with old-observer")
  expect(modern).not.toHaveBeenCalled()
})


it("uses official structured model results when a plugin omits protocol metadata", async () => {
  const f = await session(undefined)
  expect(JSON.parse(String((await f.result.run("probe", "")).text))).toEqual(answer)
  expect(f.modern).toHaveBeenCalledOnce()
  expect(f.old).not.toHaveBeenCalled()
})
