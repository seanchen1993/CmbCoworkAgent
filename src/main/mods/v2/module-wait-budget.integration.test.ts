import { afterEach, expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionHostCall, FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"

const guests: FunctionGuestRuntime[] = []
afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  plugin: { name: "module-wait-budget", root: "/module-wait-budget" },
  capabilities: ["process.spawn"],
  timeoutMs: 2000,
  ownBudgetMs: 80
}
const opening: FunctionHostCall = async (_method, args) => ({
  value: { id: ((args as ModJson[])[0] as { argv: string[] }).argv[0] }
})

async function runtime(body: string, host?: FunctionHostCall) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("command.run",async($,e,next)=>{${body}})
  }}`)
  guests.push(guest)
  if (host) guest.bindModuleHost(host)
  return guest
}

it.each([false, true])(
  "stops only the actual reader clock when its creator has ended=%s",
  async (background) => {
    const entered = Promise.withResolvers<void>()
    const guest = await runtime(
      `
    if(e.which==="B")await new Promise(()=>{});
    const stream=$.process.spawn({argv:["A"]});
    const consume=async()=>{for await(const chunk of stream){};return {code:(await stream.result).code}};
    ${background ? "consume().catch(()=>{});return {started:true};" : "return consume();"}
  `,
      async (method) => {
        if (method === "resource.pull") {
          entered.resolve()
          await delay(150)
          return { value: { done: true, value: { code: 0 } } }
        }
        return {}
      }
    )
    const a = guest.invoke("0", { which: "A" }, opening, options)
    await entered.promise
    if (background) expect(await a).toEqual({ value: { started: true } })
    await expect(
      guest.invoke("0", { which: "B" }, opening, { ...options, ownBudgetMs: 30 })
    ).rejects.toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    if (!background) expect(await a).toEqual({ value: { code: 0 } })
    await delay(160)
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  }
)

it("refuses exhausted own time before starting a second actual module pull", async () => {
  let pulls = 0
  const guest = await runtime(
    `
    const stream=$.process.spawn({argv:["A"]});await stream.next();
    const until=Date.now()+30;while(Date.now()<until){};
    await stream.next();return {};
  `,
    async (method) => {
      if (method === "resource.pull") {
        pulls++
        return { value: { done: false, value: { text: "first" } } }
      }
      return {}
    }
  )
  await expect(guest.invoke("0", {}, opening, { ...options, ownBudgetMs: 20 })).rejects.toThrow(
    "MODS_HOOK_BUDGET_EXCEEDED"
  )
  expect(pulls).toBe(1)
})

it("ends a rejected module receipt and retains a cancelled actual reply until it really arrives", async () => {
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>()
  let actualSignal: AbortSignal | undefined
  const guest = await runtime(
    `const stream=$.process.spawn({argv:[e.which]});
    for await(const chunk of stream){};return {};`,
    async (method, args, signal) => {
      if (method !== "resource.pull") return {}
      if ((args as { id: string }).id === "reject") throw Error("actual-module-rejection")
      actualSignal = signal
      entered.resolve()
      await gate.promise
      return { value: { done: true, value: { code: 0 } } }
    }
  )
  await expect(guest.invoke("0", { which: "reject" }, opening, options)).rejects.toThrow(
    "actual-module-rejection"
  )
  const controller = new AbortController()
  const pending = guest.invoke("0", { which: "late" }, opening, {
    ...options,
    signal: controller.signal
  })
  const failed = expect(pending).rejects.toThrow("MODS_CANCELLED")
  await entered.promise
  controller.abort()
  await failed
  expect(guest.stats.frames).toBe(0)
  expect(guest.stats.replies).toBeGreaterThan(0)
  expect(actualSignal?.aborted).toBe(false)
  gate.resolve()
  await delay(30)
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})
