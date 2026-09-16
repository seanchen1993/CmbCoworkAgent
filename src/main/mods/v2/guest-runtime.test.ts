import { afterEach, describe, expect, it } from "vitest"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"

const guests: FunctionGuestRuntime[] = []
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["session.id"],
  plugin: { name: "probe", root: "/probe" }
}
async function guest(body: string): Promise<FunctionGuestRuntime> {
  const result = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod = { register(on) { ${body} } }`
  )
  guests.push(result)
  return result
}
afterEach(() => guests.splice(0).forEach((runtime) => runtime.dispose()))

describe("persistent function guest frame boundaries", () => {
  it("keeps concurrent host calls attached to their original frames", async () => {
    const runtime = await guest(
      `on("command.run", async ($, e) => ({text: e.id + await $.session.id()}))`
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runtime.invoke(
      "0",
      { id: "A" },
      async () => {
        await gate
        return { value: "a" }
      },
      options
    )
    const second = runtime.invoke("0", { id: "B" }, async () => ({ value: "b" }), options)
    expect(await second).toEqual({ value: { text: "Bb" } })
    release()
    expect(await first).toEqual({ value: { text: "Aa" } })
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })
  it("cancels one pending frame while the other completes", async () => {
    const runtime = await guest(
      `on("command.run", async ($,e) => e.pending ? new Promise(()=>{}) : {text:"ok"})`
    )
    const controller = new AbortController()
    const pending = runtime.invoke("0", { pending: true }, async () => ({}), {
      ...options,
      signal: controller.signal
    })
    controller.abort()
    await expect(pending).rejects.toThrow("MODS_CANCELLED")
    expect(await runtime.invoke("0", {}, async () => ({}), options)).toEqual({
      value: { text: "ok" }
    })
    expect(runtime.stats.frames).toBe(0)
  })
  it("does not let a retained SDK inherit a later frame's authority", async () => {
    const runtime = await guest(`let saved; on("command.run", async ($) => {
      if (!saved) {saved=$; return {text:"saved"};}
      return {text:await saved.session.id()};
    })`)
    await runtime.invoke("0", {}, async () => ({ value: "first" }), options)
    let calls = 0
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          calls++
          return { value: "second" }
        },
        options
      )
    ).rejects.toThrow("MODS_STALE_INVOCATION")
    expect(calls).toBe(0)
  })
  it("bounds a hanging promise and rejects late host replies", async () => {
    const runtime = await guest(`on("command.run", async ($) => ({text:await $.session.id()}))`)
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          await wait
          return { value: "late" }
        },
        { ...options, timeoutMs: 10 }
      )
    ).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })
  it("freezes input and keeps all ambient host APIs absent", async () => {
    const runtime = await guest(`on("command.run", async ($,e) => ({
      frozen:Object.isFrozen(e)&&Object.isFrozen(e.nested),
      globals:[typeof process,typeof require,typeof fetch,typeof Bun,typeof document],
      escaped:({}).constructor.constructor("return typeof process")()
    }))`)
    expect(await runtime.invoke("0", { nested: { ok: true } }, async () => ({}), options)).toEqual({
      value: { frozen: true, globals: Array(5).fill("undefined"), escaped: "undefined" }
    })
  })
  it("evaluates regular expression matchers inside the bounded guest", async () => {
    const runtime = await guest(`on("command.run", {command:/^review-/}, () => ({text:"yes"}))`)
    expect(runtime.matches("0", { command: "review-file" })).toBe(true)
    expect(runtime.matches("0", { command: "other" })).toBe(false)
  })
  it("rejects duplicate catches and async registration", async () => {
    await expect(
      guest(
        `on("command.run",()=>({})).catch(()=>({})); const h=on("command.run",()=>({})); h.catch(()=>({})); h.catch(()=>({}));`
      )
    ).rejects.toThrow()
    await expect(
      FunctionGuestRuntime.create(`var __cmbFunctionMod={async register(){}}`)
    ).rejects.toThrow()
  })
})
