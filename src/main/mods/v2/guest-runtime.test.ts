import { afterEach, describe, expect, it, vi } from "vitest"
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
afterEach(() => {
  guests.splice(0).forEach((runtime) => runtime.dispose())
  vi.restoreAllMocks()
})

it("a held admission ACK cannot enter guest after its monotonic deadline", async () => {
  const runtime = await guest('on("command.run",async($)=>({text:await $.session.id()}))')
  const methods: string[] = []
  const epoch = performance.now()
  let monotonicNow = epoch
  const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow)
  let admitted!: () => void
  let releaseAck!: () => void
  const admissionEntered = new Promise<void>((resolve) => {
    admitted = resolve
  })
  const heldAck = new Promise<void>((resolve) => {
    releaseAck = resolve
  })
  const controller = new AbortController()
  // Cleanup watchdog only: cancellation must fail the budget assertion, never satisfy it.
  const safety = setTimeout(() => controller.abort(), 250)
  let settlement: Promise<unknown> | undefined
  try {
    const pending = runtime.invoke(
      "0",
      {},
      async (method) => {
        methods.push(method)
        if (method === "invoke.admitted") {
          admitted()
          await heldAck
        }
        return { value: "wrong" }
      },
      { ...options, admission: true, timeoutMs: 2, signal: controller.signal }
    )
    settlement = pending.then(
      () => "settled",
      () => "settled"
    )
    const first = await Promise.race([admissionEntered.then(() => "admitted"), settlement])
    expect(first).toBe("admitted")
    expect(methods).toEqual(["invoke.admitted"])
    // The ACK is now genuinely held. Only the test clock advances; the deadline stays 2 ms.
    monotonicNow = epoch + 12
    releaseAck()
    await expect(pending).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    expect(methods).toEqual(["invoke.admitted"])
    expect(runtime.stats.frames).toBe(0)
  } finally {
    clearTimeout(safety)
    releaseAck()
    try {
      runtime.dispose()
      await settlement
    } finally {
      clock.mockRestore()
    }
  }
})

it("does not issue an admission ACK once the original deadline has expired", async () => {
  const runtime = await guest('on("command.run",async($)=>({text:await $.session.id()}))')
  const methods: string[] = []
  const epoch = performance.now()
  let monotonicNow = epoch
  const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow)
  const controller = new AbortController()
  const safety = setTimeout(() => controller.abort(), 250)
  let settlement: Promise<unknown> | undefined
  try {
    const pending = runtime.invoke(
      "0",
      {},
      async (method) => {
        methods.push(method)
        return { value: "wrong" }
      },
      { ...options, admission: true, timeoutMs: 2, signal: controller.signal }
    )
    settlement = pending.then(
      () => undefined,
      () => undefined
    )
    // Advance before the original admission microtask runs; >= is the production boundary.
    monotonicNow = epoch + 2
    await expect(pending).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    expect(methods).toEqual([])
    expect(runtime.stats.frames).toBe(0)
  } finally {
    clearTimeout(safety)
    try {
      runtime.dispose()
      await settlement
    } finally {
      clock.mockRestore()
    }
  }
})

it("expires a pending guest even when the wall clock stops advancing", async () => {
  const runtime = await guest(`on("command.run", async () => new Promise(()=>{}))`)
  vi.spyOn(Date, "now").mockReturnValue(1)
  const controller = new AbortController()
  const safety = setTimeout(() => controller.abort(), 250)
  try {
    await expect(
      runtime.invoke("0", {}, async () => ({}), {
        ...options,
        timeoutMs: 20,
        signal: controller.signal
      })
    ).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    expect(runtime.stats.frames).toBe(0)
  } finally {
    clearTimeout(safety)
  }
})

it("does not expire a live guest when the wall clock jumps forward", async () => {
  const runtime = await guest(`on("command.run", async ($) => ({text:await $.session.id()}))`)
  const wall = Date.now()
  const pending = runtime.invoke("0", {}, async () => ({ value: "current" }), {
    ...options,
    timeoutMs: 1000
  })
  vi.spyOn(Date, "now").mockReturnValue(wall + 3600000)
  await expect(pending).resolves.toEqual({ value: { text: "current" } })
})

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
  it("allows a retained plugin SDK to use the calling hook's own continuation", async () => {
    const runtime = await guest(`let saved; on("command.run", async ($) => {
      if (!saved) {saved=()=>$.session.id(); return {text:"saved"};}
      return {text:await saved()};
    })`)
    await runtime.invoke("0", {}, async () => ({ value: "first" }), options)
    let calls = 0
    expect(
      await runtime.invoke(
        "0",
        {},
        async () => {
          calls++
          return { value: "second" }
        },
        options
      )
    ).toEqual({ value: { text: "second" } })
    expect(calls).toBe(1)
  })
  it("does not let a detached continuation borrow a later hook's authority", async () => {
    const runtime = await guest(`let saved,release,task;
      on("command.run",async($)=>{
        if(!saved){saved=$;const wait=new Promise(r=>release=r);
          task=wait.then(async()=>{try{await saved.session.id();return "escaped"}catch{return "blocked"}});
          return {text:"started"};
        }
        release();const status=await task;return {text:status+":"+await saved.session.id()};
      })`)
    let calls = 0
    const host = async () => {
      calls++
      return { value: "current" }
    }
    await runtime.invoke("0", {}, host, options)
    expect(await runtime.invoke("0", {}, host, options)).toEqual({
      value: { text: "blocked:current" }
    })
    expect(calls).toBe(1)
  })
  it("keeps retained next bound to the original dispatch", async () => {
    const runtime = await guest(`let saved;
      on("command.run",async($,e,next)=>{if(!saved){saved=next;return {text:"saved"}}return saved(e)});`)
    await runtime.invoke("0", {}, async () => ({}), options)
    let calls = 0
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          calls++
          return { value: { text: "escaped" } }
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
      generation:(()=>{try {({}).constructor.constructor("return typeof process")();return "executed"}
        catch(error){return error.message}})()
    }))`)
    expect(await runtime.invoke("0", { nested: { ok: true } }, async () => ({}), options)).toEqual({
      value: {
        frozen: true,
        globals: Array(5).fill("undefined"),
        generation: "MODS_CODE_GENERATION_DENIED"
      }
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
