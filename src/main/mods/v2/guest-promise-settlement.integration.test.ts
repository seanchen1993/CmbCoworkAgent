import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ModFunctionError,
  type FunctionInvocation,
  type FunctionHostReply
} from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSessionActivity } from "./session-activity"

const guests: FunctionGuestRuntime[] = []
const invocation: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["session.id"],
  plugin: { name: "settlement", root: "/settlement" },
  ownBudgetMs: 1000,
  timeoutMs: 5000
}

async function guest(body: string): Promise<FunctionGuestRuntime> {
  const runtime = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod={register(on){${body}}}`
  )
  guests.push(runtime)
  return runtime
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const runtime of guests.splice(0)) runtime.dispose()
})

describe("real Guest Promise settlement CPU and lifecycle", () => {
  it("delivers hundreds of async replies after the previous ambient slice has expired", async () => {
    const runtime = await guest(`on("command.run",async($,e,next)=>{
      const text=await $.session.id();
      return {text,ms:next.budget.ms};
    })`)
    let calls = 0
    for (let index = 0; index < 512; index++) {
      const expected = "actual-" + index
      const answer = await runtime.invoke("0", {}, async method => {
        expect(method).toBe("session.id")
        calls++
        // Control only the stale ambient slice. Frame/hook clocks, CPU accounting and VM
        // Promise execution remain real, including QuickJS's periodic interrupt sampling.
        Reflect.set(runtime, "deadline", 0)
        return { value: expected }
      }, invocation)
      expect(answer).toEqual({ value: { text: expected, ms: 1000 } })
    }
    expect(calls).toBe(512)
    expect(runtime.stats).toEqual({ frames: 0, replies: 0, disposed: false })
  }, 15000)

  it("bounds actual thenable assimilation after a raw resolver reply and retires its frame", async () => {
    const runtime = await guest(`on("ui.resolve",async($,e,next)=>{
      void $.session.id().catch(()=>$.session.id());
      return await next(e);
    })`)
    const context = runtime.uiResolveContext
    const response = Promise.withResolvers<FunctionHostReply>()
    const entered = Promise.withResolvers<void>()
    const activity = new FunctionSessionActivity()
    const newPromise = context.newPromise.bind(context)
    let lateSettlements = 0
    let calls = 0
    vi.spyOn(context, "newPromise").mockImplementation(() => {
      const actual = newPromise()
      const resolve = actual.resolve.bind(actual), reject = actual.reject.bind(actual)
      const observe = () => {
        if (Reflect.get(runtime, "cpuInterruptions") > 0) lateSettlements++
      }
      // These spies still execute the actual QuickJS deferred resolvers. An interrupted VM
      // must retire pending handles without giving its cleanup another guest execution slice.
      vi.spyOn(actual, "resolve").mockImplementation(value => { observe(); resolve(value) })
      vi.spyOn(actual, "reject").mockImplementation(value => { observe(); reject(value) })
      return actual
    })
    const pending = runtime.invokeUiResolver("0", { surface: "desktop", component: "Pane" },
      () => activity.run(async () => {
        calls++
        entered.resolve()
        return response.promise
      }), { ...invocation, event: "ui.resolve" }, async () => {
        await entered.promise
        return runtime.runUiResolverInspection(performance.now() + 1000, () => {
          // QuickJS may adopt this thenable in the later Promise job, after resolve returned.
          // Its real interrupt must still reject the frame rather than become a generic fault.
          const result = context.evalCode(`({get then(){while(true){}}})`)
          if (result.error) { result.error.dispose(); throw Error("fixture evaluation failed") }
          return result.value
        })
      }, performance.now() + 5000)
    try {
      await expect(pending).rejects.toMatchObject({ code: "MODS_BUDGET_EXCEEDED" })
      await expect.poll(() => runtime.stats).toEqual({ frames: 0, replies: 0, disposed: true })
      expect(lateSettlements).toBe(0)
      expect(calls).toBe(1)
      expect(activity.size).toBe(1)
      response.resolve({ value: "late" })
      await expect.poll(() => activity.size).toBe(0)
      await expect.poll(() => runtime.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
      expect(calls).toBe(1)
    } finally {
      response.resolve({ value: "late" })
    }
  })

  it("does not label an ordinary then getter exception as a CPU interruption", async () => {
    const runtime = await guest(`on("ui.resolve",async($,e,next)=>await next(e))`)
    const context = runtime.uiResolveContext
    const pending = runtime.invokeUiResolver("0", { surface: "desktop", component: "Pane" },
      async () => ({}), { ...invocation, event: "ui.resolve", capabilities: [] },
      async () => runtime.runUiResolverInspection(performance.now() + 1000, () => {
        const result = context.evalCode(`({get then(){throw Error("ordinary then getter");}})`)
        if (result.error) { result.error.dispose(); throw Error("fixture evaluation failed") }
        return result.value
      }), performance.now() + 5000)
    await expect(pending).rejects.toMatchObject({ code: "MODS_GUEST_ERROR" })
    await expect.poll(() => runtime.stats).toMatchObject({ frames: 0, replies: 0 })
    await expect.poll(() => runtime.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
  })

  it("refuses settlement at an exhausted CPU meter without dropping ignored-abort host work", async () => {
    const runtime = await guest(`on("command.run",async($)=>{
      await Promise.all([$.session.id(),$.session.id()]);
      return {text:await $.session.id()};
    })`)
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const activity = new FunctionSessionActivity()
    const signals: AbortSignal[] = []
    let calls = 0
    const pending = runtime.invoke("0", {}, (_method, _args, signal) => activity.run(async () => {
      const index = ++calls
      signals.push(signal)
      if (index === 2) entered.resolve()
      await (index === 1 ? first.promise : second.promise)
      return { value: "actual" }
    }), invocation)
    const rejected = expect(pending).rejects.toMatchObject({ code: "MODS_BUDGET_EXCEEDED" })
    try {
      await entered.promise
      // Exercise the synchronous admission fence exactly, rather than relying on CPU speed.
      Reflect.set(runtime, "cpuMs", 501)
      Reflect.set(runtime, "cpuWindow", performance.now())
      first.resolve()
      await rejected
      await expect.poll(() => runtime.stats).toEqual({ frames: 0, replies: 0, disposed: true })
      expect(calls).toBe(2)
      expect(signals.every(signal => signal.aborted)).toBe(true)
      expect(activity.size).toBe(1)
      expect(activity.pauseIfIdle()).toBe(false)
      second.resolve()
      await expect.poll(() => activity.size).toBe(0)
      expect(calls).toBe(2)
    } finally {
      first.resolve()
      second.resolve()
    }
  })

  for (const exhausted of [false, true]) {
    it(`settles native cancellation with ${exhausted ? "exhausted" : "live"} CPU and rejects late SDK effects`, async () => {
      const runtime = await guest(`on("command.run",async($)=>{
        try{await $.session.id();}catch{}
        return {text:await $.session.id()};
      })`)
      const response = Promise.withResolvers<FunctionHostReply>()
      const entered = Promise.withResolvers<void>()
      const controller = new AbortController()
      const activity = new FunctionSessionActivity()
      let calls = 0
      const pending = runtime.invoke("0", {}, () => activity.run(async () => {
        calls++
        entered.resolve()
        return response.promise
      }), { ...invocation, signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ code: "MODS_CANCELLED" })
      try {
        await entered.promise
        Reflect.set(runtime, "deadline", 0)
        if (exhausted) {
          Reflect.set(runtime, "cpuMs", 501)
          Reflect.set(runtime, "cpuWindow", performance.now())
        }
        controller.abort(new ModFunctionError("MODS_CANCELLED"))
        await rejected
        expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
        expect(activity.size).toBe(1)
        response.resolve({ value: "late" })
        await expect.poll(() => activity.size).toBe(0)
        await new Promise(resolve => setImmediate(resolve))
        expect(calls).toBe(1)
        if (exhausted) {
          await expect.poll(() => runtime.stats.disposed).toBe(true)
          await expect(runtime.invoke("0", {}, async () => ({ value: "wrong" }), invocation))
            .rejects.toMatchObject({ code: "MODS_BUDGET_EXCEEDED" })
        } else {
          expect(await runtime.invoke("0", {}, async () => ({ value: "new owner" }), invocation))
            .toEqual({ value: { text: "new owner" } })
        }
      } finally {
        response.resolve({ value: "late" })
      }
    })
  }

  it("preserves the active nested slice when cancellation settles a Promise reentrantly", async () => {
    const runtime = await guest(`on("command.run",async($)=>{
      const controller=new AbortController();
      const pending=$.clock.sleep(1000,{signal:controller.signal});
      controller.abort();
      try{await pending;}catch{}
      return {text:await $.session.id()};
    })`)
    const methods: string[] = []
    expect(await runtime.invoke("0", {}, async method => {
      methods.push(method)
      return { value: "actual" }
    }, { ...invocation, capabilities: ["clock.sleep", "session.id"] }))
      .toEqual({ value: { text: "actual" } })
    expect(methods).toEqual(["session.id"])
    expect(runtime.stats).toEqual({ frames: 0, replies: 0, disposed: false })
  })
})
