import { afterEach, expect, it, vi } from "vitest"
import type { FunctionHostCall, FunctionInvocation } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { basicSdkInput, runBasicSdk } from "./basic-sdk"

const guests: FunctionGuestRuntime[] = []
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["clock.sleep", "session.id", "clock.after"],
  plugin: { name: "sleep", root: "/sleep" }
}
afterEach(() => {
  for (const guest of guests.splice(0)) guest.dispose()
  vi.restoreAllMocks()
})
async function fixture(body: string) {
  const guest = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod={register(on){on("command.run",async $=>{${body}})}}`
  )
  guests.push(guest)
  const calls: Array<{ method: string; signal: AbortSignal }> = []
  const host: FunctionHostCall = async (method, args, signal) => {
    calls.push({ method, signal })
    const value = await runBasicSdk(method, basicSdkInput(method, args as ModJson[]), {
      threadId: "current",
      workspace: "/sleep",
      plugin: "sleep",
      registry: new Map(),
      signal
    })
    return value === undefined ? {} : { value }
  }
  return { guest, host, calls }
}

it("cancels only one host timer, preserves reason identity and leaves the invocation usable", async () => {
  const cleared = vi.spyOn(globalThis, "clearTimeout")
  const f = await fixture(`const controller=new AbortController(),reason={kind:"cancel-one"};
    const first=$.clock.sleep(5000,{signal:controller.signal}).catch(error=>error===reason);
    const second=$.clock.sleep(15).then(()=>"second");await $.session.id();controller.abort(reason);
    const result=await Promise.all([first,second]);return {result,id:await $.session.id(),hidden:typeof __functionCancelCall};`)
  expect(await f.guest.invoke("0", {}, f.host, options)).toEqual({
    value: { result: [true, "second"], id: "current", hidden: "undefined" }
  })
  const sleeps = f.calls.filter((call) => call.method === "clock.sleep")
  expect(sleeps).toHaveLength(2)
  expect(cleared).toHaveBeenCalled()
  expect(f.guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("does not issue a host call for an already aborted signal or accept forged brands", async () => {
  const f = await fixture(`const signal=AbortSignal.abort("reason");let reason,invalid;
    try{await $.clock.sleep(5000,{signal})}catch(error){reason=error}
    try{await $.clock.sleep(5000,{signal:{aborted:false}})}catch(error){invalid=error.name}
    return {reason,invalid};`)
  expect(await f.guest.invoke("0", {}, f.host, options)).toEqual({
    value: { reason: "reason", invalid: "TypeError" }
  })
  expect(f.calls).toHaveLength(0)
})

it("ignores late cancellation of a finished sleep while a sibling remains live", async () => {
  const f =
    await fixture(`const controller=new AbortController();await $.clock.sleep(1,{signal:controller.signal});
    const sibling=$.clock.sleep(10);controller.abort("late");await sibling;return {ok:true};`)
  expect(await f.guest.invoke("0", {}, f.host, options)).toEqual({ value: { ok: true } })
  expect(f.calls).toHaveLength(2)
})

it("still cancels all pending sleep calls when the parent invocation is aborted", async () => {
  const f = await fixture(`const controller=new AbortController();
    await Promise.all([$.clock.sleep(5000,{signal:controller.signal}),$.clock.sleep(5000)]);return {};`)
  const parent = new AbortController()
  const pending = f.guest.invoke("0", {}, f.host, { ...options, signal: parent.signal })
  const rejected = expect(pending).rejects.toThrow("MODS_CANCELLED")
  await vi.waitFor(() => expect(f.calls).toHaveLength(2))
  parent.abort()
  await rejected
  expect(f.calls.every((call) => call.signal.aborted)).toBe(true)
  expect(f.guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("cannot cancel a later frame with a signal retained from an expired frame", async () => {
  const f = await fixture(`if(!globalThis.oldSleepController){
    globalThis.oldSleepController=new AbortController();
    await $.clock.sleep(1,{signal:globalThis.oldSleepController.signal});return {frame:1};
  }
  const pending=$.clock.sleep(15);globalThis.oldSleepController.abort("expired");
  await pending;return {frame:2};`)
  expect(await f.guest.invoke("0", {}, f.host, options)).toEqual({ value: { frame: 1 } })
  expect(await f.guest.invoke("0", {}, f.host, options)).toEqual({ value: { frame: 2 } })
  expect(f.calls).toHaveLength(2)
  expect(f.guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("rejects unsupported long background timer intervals before any host operation", async () => {
  const f = await fixture(
    `try{$.clock.after(60001,()=>{});return {accepted:true}}catch(error){return {error:error.message}}`
  )
  expect(await f.guest.invoke("0", {}, f.host, options)).toEqual({
    value: { error: "MODS_TIMER_ARGUMENTS" }
  })
  expect(f.calls).toHaveLength(0)
})
