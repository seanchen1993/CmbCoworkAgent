import { afterEach, expect, it, vi } from "vitest"
import type { FunctionHostCall, FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"

const guests: FunctionGuestRuntime[] = []
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["model.complete", "session.id"],
  plugin: { name: "cancel-model", root: "/cancel" },
  modelProtocol: "result-v1"
}
afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))
async function fixture(body: string) {
  const guest = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod={register(on){on("command.run",async $=>{${body}})}}`
  )
  guests.push(guest)
  return guest
}
const aborted = {
  isAnswered: false,
  reason: "aborted",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  }
}

it("pre-cancelled model requests issue no host call and forged signals remain rejected", async () => {
  const guest = await fixture(`const cancelled=await $.model.complete({model:"default",prompt:"x"},
    {signal:AbortSignal.abort("stop")});let invalid=false;
    try{await $.model.complete({model:"default",prompt:"x"},{signal:{aborted:true}})}
    catch(error){invalid=error.name==="TypeError"}return {cancelled,invalid};`)
  const host = vi.fn<FunctionHostCall>()
  expect(await guest.invoke("0", {}, host, options)).toEqual({
    value: { cancelled: aborted, invalid: true }
  })
  expect(host).not.toHaveBeenCalled()
})

it("cancels only the chosen model call and leaves its sibling and invocation alive", async () => {
  const guest = await fixture(`const stop=new AbortController();
    const first=$.model.complete({model:"default",prompt:"wait"},{signal:stop.signal});
    const second=$.model.complete({model:"default",prompt:"answer"});
    await $.session.id();stop.abort();return {first:await first,second:await second,id:await $.session.id()};`)
  const signals: AbortSignal[] = []
  let beforeFrameEnd: boolean[] = []
  const host: FunctionHostCall = async (method, args, signal) => {
    if (method === "session.id") {
      beforeFrameEnd = signals.map((signal) => signal.aborted)
      return { value: "thread" }
    }
    signals.push(signal)
    if (JSON.stringify(args).includes("wait")) {
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
    }
    return { value: "answer" }
  }
  expect(await guest.invoke("0", {}, host, options)).toEqual({
    value: { first: aborted, second: "answer", id: "thread" }
  })
  expect(beforeFrameEnd).toEqual([true, false])
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("parent cancellation still rejects the invocation and cancels all child requests", async () => {
  const guest = await fixture(`const stop=new AbortController();
    await Promise.all([$.model.complete({model:"default",prompt:"a"},{signal:stop.signal}),
      $.model.complete({model:"default",prompt:"b"})]);return {};`)
  const signals: AbortSignal[] = []
  const host: FunctionHostCall = async (_method, _args, signal) => {
    signals.push(signal)
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    )
    return {}
  }
  const parent = new AbortController()
  const pending = guest.invoke("0", {}, host, { ...options, signal: parent.signal })
  const rejected = expect(pending).rejects.toThrow("MODS_CANCELLED")
  await vi.waitFor(() => expect(signals).toHaveLength(2))
  parent.abort()
  await rejected
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

it("preserves legacy cancellation rejection instead of returning a new protocol object", async () => {
  const guest = await fixture(`try{await $.model.complete({model:"default",prompt:"x"},
    {signal:AbortSignal.abort("legacy-stop")});return {failed:false}}
    catch(error){return {reason:error}}`)
  const host = vi.fn<FunctionHostCall>()
  expect(await guest.invoke("0", {}, host, { ...options, modelProtocol: "legacy-v1" })).toEqual({
    value: { reason: "legacy-stop" }
  })
  expect(host).not.toHaveBeenCalled()
})
