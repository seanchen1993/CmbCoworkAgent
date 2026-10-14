import { afterEach, expect, it, vi } from "vitest"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDispatcher } from "./dispatcher"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { FunctionDispatchDeadline } from "./dispatch-deadline"

const guests: FunctionGuestRuntime[] = []
afterEach(() => { guests.splice(0).forEach(guest => guest.dispose()); vi.restoreAllMocks() })
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const options: FunctionInvocation = {
  event: "session.end", origin: { plugin: "engine", tier: "core" },
  plugin: { name: "end-probe", root: "/end-probe" },
  capabilities: ["session.id", "process.spawn"], ownBudgetMs: 10000, timeoutMs: 2000
}
async function runtime(body: string) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  guests.push(guest)
  return guest
}

it("charges actual SDK wait and ignores changes to the calendar clock", async () => {
  const guest = await runtime(`on("session.end",async($,e,next)=>{
    const first=next.budget;await $.session.id();return {first,second:next.budget};
  })`)
  vi.spyOn(Date, "now").mockReturnValue(1)
  const result = await guest.invoke("0", {}, async () => { await delay(80); return { value: "real" } },
    { ...options, dispatchCutNs: FunctionSharedWallCut.after(300).expiresAtNs })
  const value = result.value as { first: { ms: number; remainingMs: number }; second: { remainingMs: number } }
  expect(value.first.ms).toBeGreaterThan(200)
  expect(value.first.ms).toBeLessThanOrEqual(300)
  expect(value.first.remainingMs - value.second.remainingMs).toBeGreaterThan(60)
})

it("shares one native cut across handlers and does not enter recovery after expiry", async () => {
  const guest = await runtime(`
    on("session.end",async($,e,next)=>{await $.session.id();return next(e)})
      .catch(async($)=>{await $.session.id();return {wrong:true}});
  `)
  const second = await runtime('on("session.end",async($,e,next)=>{await $.session.id();return next(e)})')
  let calls = 0, core = 0
  const dispatcher = new FunctionDispatcher([
    { ...options.plugin, tier: "user", guest, capabilities: ["session.id"] },
    { name: "second", root: "/second", tier: "user", guest: second, capabilities: ["session.id"] }
  ])
  await expect(dispatcher.dispatch("session.end", {}, {
    timeoutMs: 70, capability: async () => { calls++; await delay(110); return "actual" },
    core: async () => { core++; return {} }
  })).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT", downstream: true })
  await delay(120)
  expect(calls).toBe(1)
  expect(core).toBe(0)
})

it("does not reset an inherited cut during delayed admission", async () => {
  const guest = await runtime('on("session.end",async($)=>({id:await $.session.id()}))')
  const cut = FunctionSharedWallCut.after(20)
  await delay(30)
  const calls = vi.fn(async () => ({ value: "late" }))
  await expect(guest.invoke("0", {}, calls, { ...options, dispatchCutNs: cut.expiresAtNs }))
    .rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT", downstream: true })
  expect(calls).not.toHaveBeenCalled()
})

it("aborts only the end frame's actual module pull and keeps its real reply occupied", async () => {
  const guest = await runtime(`on("session.end",async($,e)=>{
    const stream=$.process.spawn({argv:[e.id]});for await(const chunk of stream){};return {};
  })`)
  const endEntered = Promise.withResolvers<void>(), normalEntered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const signals = new Map<string, AbortSignal>()
  guest.bindModuleHost(async (method, args, signal, context) => {
    if (method !== "resource.pull") return {}
    const id = (args as { id: string }).id
    signals.set(id, signal)
    if (id === "end") { expect(context?.dispatchCutNs).toBeDefined(); endEntered.resolve() }
    else { expect(context).toBeUndefined(); normalEntered.resolve() }
    await gate.promise
    return { value: { done: true, value: { code: 0 } } }
  })
  const opening = async (_method: string, args: unknown) => ({ value: { id: (args as [{ argv: string[] }])[0].argv[0] } })
  const end = guest.invoke("0", { id: "end" }, opening,
    { ...options, dispatchCutNs: FunctionSharedWallCut.after(100).expiresAtNs })
  const rejected = expect(end).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT", downstream: true })
  const normal = guest.invoke("0", { id: "normal" }, opening, options)
  await Promise.all([endEntered.promise, normalEntered.promise])
  await rejected
  expect(signals.get("end")?.aborted).toBe(true)
  expect(signals.get("normal")?.aborted).toBe(false)
  expect(guest.stats.replies).toBeGreaterThan(0)
  gate.resolve()
  expect(await normal).toEqual({ value: {} })
  await delay(30)
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("retains a closed end token so its late continuation cannot become a background pull", async () => {
  const guest = await runtime(`on("session.end",async($)=>{
    const stream=$.process.spawn({argv:["end"]});
    stream.next().then(()=>stream.next()).catch(()=>{});return {};
  })`)
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let pulls = 0
  guest.bindModuleHost(async method => {
    if (method === "resource.pull") {
      pulls++; entered.resolve(); await gate.promise
      return { value: { done: false, value: { text: "late" } } }
    }
    return {}
  })
  await guest.invoke("0", {}, async () => ({ value: { id: "end" } }),
    { ...options, dispatchCutNs: FunctionSharedWallCut.after(200).expiresAtNs })
  // An unawaited open/pull can be revoked before reaching the host, too.
  await Promise.race([entered.promise, delay(30)])
  gate.resolve()
  await delay(50)
  expect(pulls).toBeLessThanOrEqual(1)
})

it("rejects malformed private cuts and closes bounded wait without resetting the inherited cut", async () => {
  expect(() => new FunctionSharedWallCut("1e9")).toThrow("MODS_DISPATCH_CUT_INVALID")
  expect(() => new FunctionDispatchDeadline(100, undefined, "invalid")).toThrow("MODS_DISPATCH_CUT_INVALID")
  const cut = FunctionSharedWallCut.after(20)
  const deadline = new FunctionDispatchDeadline(1000, undefined, cut.expiresAtNs)
  try { await expect(deadline.wait(delay(100))).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" }) }
  finally { deadline.close() }
})
