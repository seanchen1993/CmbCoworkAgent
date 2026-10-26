import { afterEach, expect, it } from "vitest"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { withTrustedFunctionWait } from "./trusted-function-wait"

const guests: FunctionGuestRuntime[] = []
afterEach(() => guests.splice(0).forEach(guest => guest.dispose()))
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const options: FunctionInvocation = {
  event: "tool.describe", origin: { plugin: "engine", tier: "core" },
  plugin: { name: "wait-probe", root: "/wait-probe" },
  capabilities: ["session.id"], ownBudgetMs: 10000, timeoutMs: 1000
}
async function runtime(body: string) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  guests.push(guest)
  return guest
}

it("preserves a real Guest frame across trusted waiting longer than its active wall allowance", async () => {
  const guest = await runtime('on("tool.describe",async($)=>({id:await $.session.id()}))')
  const value = await guest.invoke("0", {}, async (_method, _args, signal) => {
    return withTrustedFunctionWait("user-approval", signal, async () => {
      await delay(1400)
      return { value: "approved" }
    })
  }, options)
  expect(value).toEqual({ value: { id: "approved" } })
})

it("does not exempt the actual Guest metadata hard cut during trusted approval waiting", async () => {
  const guest = await runtime('on("tool.describe",async($)=>({id:await $.session.id()}))')
  let completed = false
  const run = guest.invoke("0", {}, async (_method, _args, signal) => {
    const value = await withTrustedFunctionWait("user-approval", signal, async () => {
      await delay(500)
      return { value: "late" }
    })
    completed = true
    return value
  }, { ...options, dispatchCutNs: FunctionSharedWallCut.after(150).expiresAtNs })
  await expect(run).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT", downstream: true })
  await delay(550)
  expect(completed).toBe(false)
  expect(guest.stats.frames).toBe(0)
})

it("does not exempt original Guest CPU interrupts when a previously admitted reply continues", async () => {
  const guest = await runtime(`on("tool.describe",async($)=>{
    const approval=$.session.id();
    await $.session.id();
    while(true){}
    return approval;
  })`)
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const run = guest.invoke("0", {}, async (_method, _args, signal) => {
    calls++
    if (calls === 1) return withTrustedFunctionWait("user-approval", signal, async () => {
      await gate.promise
      return { value: "late" }
    })
    await delay(50)
    return { value: "already-admitted" }
  }, { ...options, timeoutMs: 3000 })
  try {
    await expect(run).rejects.toMatchObject({ code: "MODS_BUDGET_EXCEEDED" })
    expect(calls).toBe(2)
  } finally { gate.resolve() }
})
