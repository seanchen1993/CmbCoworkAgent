import { afterEach, expect, it, vi } from "vitest"
import type { FunctionHostReply, FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"

const guests: FunctionGuestRuntime[] = []
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["clock.after", "session.id"],
  plugin: { name: "module", root: "/module" }
}
afterEach(() => {
  for (const guest of guests.splice(0)) guest.dispose()
})

async function fixture() {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("command.run",async $=>{const timer=$.clock.after(100,()=>{});await $.session.id();
      timer.cancel();return {text:"closed"}})
  }}`)
  guests.push(guest)
  return guest
}

const host = async (method: string): Promise<FunctionHostReply> => {
  if (method === "clock.after") return { value: { id: "resource-a" } }
  if (method === "session.id") return { value: "session-a" }
  throw Error("Unexpected invocation method")
}

it("keeps only the module resource reply alive after its opening hook returns", async () => {
  const guest = await fixture()
  let release!: (reply: FunctionHostReply) => void
  let activeSignal!: AbortSignal
  const moduleHost = vi.fn((method, args, signal) => {
    expect(method).toBe("resource.close")
    expect(args).toEqual({ id: "resource-a" })
    activeSignal = signal
    return new Promise<FunctionHostReply>((resolve) => {
      release = resolve
    })
  })
  guest.bindModuleHost(moduleHost)
  expect(await guest.invoke("0", {}, host, options)).toEqual({ value: { text: "closed" } })
  expect(moduleHost).toHaveBeenCalledOnce()
  expect(guest.stats).toMatchObject({ frames: 0, replies: 1 })
  expect(activeSignal.aborted).toBe(false)
  release({ value: null })
  await vi.waitFor(() => expect(guest.stats.replies).toBe(0))
})

it("revokes an outstanding resource call and runs cleanup once before a late reply", async () => {
  const guest = await fixture()
  let release!: (reply: FunctionHostReply) => void
  let signal!: AbortSignal
  const cleanup = vi.fn(() => {
    guest.dispose()
  })
  guest.bindModuleHost((_method, _args, active) => {
    signal = active
    return new Promise((resolve) => {
      release = resolve
    })
  }, cleanup)
  await guest.invoke("0", {}, host, options)
  guest.dispose()
  expect(signal.aborted).toBe(true)
  expect(cleanup).toHaveBeenCalledOnce()
  expect(guest.stats).toEqual({ disposed: true, frames: 0, replies: 0 })
  release({ value: { ignored: true } })
  await Promise.resolve()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(() => guest.bindModuleHost(async () => ({}))).toThrow("MODS_UNLOADED")
})

it("binds a principal only once and frees replies on rejection or synchronous errors", async () => {
  const guest = await fixture()
  guest.bindModuleHost(() => {
    throw Error("resource denied")
  })
  expect(() => guest.bindModuleHost(async () => ({}))).toThrow("MODS_MODULE_HOST_ALREADY_BOUND")
  await guest.invoke("0", {}, host, options)
  await vi.waitFor(() => expect(guest.stats.replies).toBe(0))
  expect(guest.stats.disposed).toBe(false)
})

it("keeps the private module bridge out of plugin globals and releases callback handles", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){let count=0;
    on("command.run",$=>{if(!count){count++;$.clock.after(1,()=>{count++})}return {count,hidden:typeof __functionModuleHost}})
  }}`)
  guests.push(guest)
  await guest.invoke("0", {}, host, options)
  guest.releaseResource(1)
  await guest.invoke("", {}, host, { ...options, resourceCallback: { handle: 1, release: true } })
  expect(await guest.invoke("0", {}, host, options)).toEqual({
    value: { count: 1, hidden: "undefined" }
  })
  expect(() => guest.releaseResource(-1)).toThrow("MODS_RESOURCE_INVALID")
})
