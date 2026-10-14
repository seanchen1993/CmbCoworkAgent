import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDispatcher } from "./dispatcher"
import { FunctionSessionActivity } from "./session-activity"

const guests: FunctionGuestRuntime[] = []
const invocation: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  plugin: { name: "budget", root: "/budget" },
  capabilities: ["session.id", "clock.sleep", "model.complete"]
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function guest(body: string): Promise<FunctionGuestRuntime> {
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  guests.push(runtime)
  return runtime
}
afterEach(() => {
  guests.splice(0).forEach((runtime) => runtime.dispose())
  vi.restoreAllMocks()
})

describe("real QuickJS own-time and bounded downstream waits", () => {
  it("keeps a live fresh frozen budget unchanged across a slow SDK reply", async () => {
    const runtime = await guest(`on("command.run",async($,e,next)=>{
      const before=next.budget;await $.session.id();const after=next.budget;
      return {ms:after.ms,before:before.remainingMs,after:after.remainingMs,
        fresh:before!==after,frozen:Object.isFrozen(after)};
    })`)
    const result = await runtime.invoke(
      "0",
      {},
      async () => {
        await delay(100)
        return { value: "actual" }
      },
      { ...invocation, ownBudgetMs: 50, timeoutMs: 1000 }
    )
    expect(result.value).toMatchObject({ ms: 50, fresh: true, frozen: true })
    const value = result.value as ModObject
    expect(Number(value.before) - Number(value.after)).toBeLessThan(20)
    expect(Number(value.after)).toBeGreaterThan(20)
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("keeps overlapping free requests paused until the final actual reply", async () => {
    const runtime = await guest(`on("command.run",async($,e,next)=>{
      const a=$.session.id();const b=$.session.id();await a;
      const first=next.budget.remainingMs;await b;
      return {first,last:next.budget.remainingMs};
    })`)
    let calls = 0
    const result = await runtime.invoke(
      "0",
      {},
      async () => {
        await delay(++calls === 1 ? 70 : 120)
        return { value: "actual" }
      },
      { ...invocation, ownBudgetMs: 50, timeoutMs: 1000 }
    )
    expect(calls).toBe(2)
    expect(Number((result.value as ModObject).first)).toBeGreaterThan(20)
    expect(Number((result.value as ModObject).last)).toBeGreaterThan(20)
  })

  it("charges active clock waiting and never lets a later SDK revive an exhausted frame", async () => {
    const runtime = await guest(`on("command.run",async($)=>{
      await $.clock.sleep(100);return {text:await $.session.id()};
    })`)
    const methods: string[] = []
    await expect(
      runtime.invoke(
        "0",
        {},
        async (method) => {
          methods.push(method)
          await delay(100)
          return { value: "late" }
        },
        { ...invocation, ownBudgetMs: 30, timeoutMs: 1000 }
      )
    ).rejects.toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    await delay(110)
    expect(methods).toEqual(["clock.sleep"])
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("synchronously refuses SDK entry exactly at exhaustion before watchdog", async () => {
    let now = 0
    const runtime = await guest(`on("command.run",async($,e,next)=>{
      const n=next.budget;return {text:await $.session.id()};
    })`)
    // The first runtime read establishes the wall; own start and next.budget are subsequent reads.
    let reads = 0
    vi.spyOn(performance, "now").mockImplementation(() => {
      if (++reads >= 6) now = 20
      return now
    })
    let hostCalls = 0
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          hostCalls++
          return { value: "wrong" }
        },
        { ...invocation, ownBudgetMs: 10, timeoutMs: 1000 }
      )
    ).rejects.toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    expect(hostCalls).toBe(0)
  })

  it("does not pause another frame and cannot recharge it with an old late reply", async () => {
    const runtime = await guest(`on("command.run",async($,e)=>e.pending
      ? {text:await $.session.id()} : new Promise(()=>{}))`)
    let complete!: (value: { value: string }) => void
    const first = runtime.invoke(
      "0",
      { pending: true },
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
      { ...invocation, ownBudgetMs: 40, timeoutMs: 80 }
    )
    const second = runtime.invoke("0", { pending: false }, async () => ({}), {
      ...invocation,
      ownBudgetMs: 30,
      timeoutMs: 1000
    })
    await expect(second).rejects.toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    await expect(first).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    complete({ value: "late" })
    await delay(20)
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("settles an explicitly canceled free SDK call even when its host ignores abort", async () => {
    const runtime = await guest(`on("command.run",async($,e,next)=>{
      const c=new AbortController();const pending=$.model.complete({prompt:"ask"},{signal:c.signal});
      c.abort();try{await pending}catch{}return {left:next.budget.remainingMs};
    })`)
    const result = await runtime.invoke("0", {}, async () => new Promise(() => {}), {
      ...invocation,
      ownBudgetMs: 100,
      timeoutMs: 500
    })
    expect(Number((result.value as ModObject).left)).toBeGreaterThan(0)
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("keeps the original explicit short absolute cap despite a free SDK wait", async () => {
    const runtime = await guest(`on("command.run",async($)=>({text:await $.session.id()}))`)
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          await delay(100)
          return { value: "late" }
        },
        { ...invocation, ownBudgetMs: 10000, timeoutMs: 20 }
      )
    ).rejects.toThrow("MODS_BUDGET_EXCEEDED")
  })

  it("constructs unmetered Infinity as a real QuickJS number rather than JSON null", async () => {
    const runtime = await guest(`on("engine.create",($,e,next)=>{
      if(next.budget.ms!==0||next.budget.remainingMs!==Infinity||!Object.isFrozen(next.budget))
        throw Error("invalid native budget");return {};
    })`)
    expect(
      await runtime.invoke("0", {}, async () => ({}), {
        ...invocation,
        event: "engine.create",
        ownBudgetMs: 0
      })
    ).toEqual({ value: {} })
  })

  it("starts own accounting after admission but still bounds admission by the absolute cap", async () => {
    const runtime = await guest(`on("command.run",($,e,next)=>({left:next.budget.remainingMs}))`)
    const result = await runtime.invoke(
      "0",
      {},
      async () => {
        await delay(100)
        return {}
      },
      { ...invocation, admission: true, ownBudgetMs: 40, timeoutMs: 1000 }
    )
    expect(Number((result.value as ModObject).left)).toBeGreaterThan(25)
  })

  it("still interrupts infinite CPU while a free SDK call is outstanding", async () => {
    const runtime = await guest(`on("command.run",async($)=>{
      $.session.id();while(true){};
    })`)
    await expect(
      runtime.invoke("0", {}, async () => new Promise(() => {}), {
        ...invocation,
        ownBudgetMs: 10000,
        timeoutMs: 500
      })
    ).rejects.toThrow(/interrupted|MODS_GUEST_ERROR/)
    expect(runtime.stats.frames).toBe(0)
  })

  it("gives recovery a fresh 1-second budget and replays the settled next only once", async () => {
    const runtime = await guest(`on("command.run",async($,e,next)=>{
      await next(e);throw Error("probe");
    }).catch(async($,e,next)=>{
      const result=await next(e);return {text:result.text+":"+next.budget.ms+":"+next.error.budget};
    })`)
    const dispatcher = new FunctionDispatcher([
      { ...invocation.plugin, tier: "user", guest: runtime, capabilities: [] }
    ])
    let calls = 0
    const result = await dispatcher.dispatch(
      "command.run",
      {},
      {
        core: async () => {
          await delay(70)
          return { text: String(++calls) }
        }
      }
    )
    expect(result.value).toEqual({ text: "1:1000:1000" })
    expect(calls).toBe(1)
  })

  it("reports own expiry as timeout and cannot read the closed original frame from catch", async () => {
    const runtime = await guest(`let original;on("command.run",($,e,next)=>{
      original=next;return new Promise(()=>{});
    }).catch(async($,e,next)=>{
      let stale=false;try{original.budget}catch{stale=true}
      const result=await next(e);return {text:result.text+":"+next.error.kind+":"+next.budget.ms,
        stale,errorBudget:next.error.budget,messageAbsent:!Object.hasOwn(next.error,"message")};
    })`)
    const dispatcher = new FunctionDispatcher([
      {
        ...invocation.plugin,
        tier: "user",
        capabilities: [],
        guest: {
          get stats() {
            return runtime.stats
          },
          registrations: runtime.registrations,
          matches: (id, input) => runtime.matches(id, input),
          releaseUi: (id) => runtime.releaseUi(id),
          dispose: () => runtime.dispose(),
          invoke: (id, input, host, options) =>
            runtime.invoke(id, input, host, {
              ...options,
              ownBudgetMs: options.caught ? options.ownBudgetMs : 20
            })
        }
      }
    ])
    const result = await dispatcher.dispatch(
      "command.run",
      {},
      { core: async () => ({ text: "once" }) }
    )
    expect(result.value).toEqual({
      text: "once:timeout:1000",
      stale: true,
      errorBudget: 1000,
      messageAbsent: true
    })
  })

  it("excludes a recovery SDK wait over one second from its actual one-second grace", async () => {
    const runtime = await guest(`on("command.run",()=>{throw Error("probe")})
      .catch(async($,e,next)=>{await $.session.id();return {ms:next.budget.ms,left:next.budget.remainingMs}})`)
    const dispatcher = new FunctionDispatcher([
      { ...invocation.plugin, tier: "user", guest: runtime, capabilities: ["session.id"] }
    ])
    const result = await dispatcher.dispatch(
      "command.run",
      {},
      {
        capability: async () => {
          await delay(1150)
          return "actual"
        },
        core: async () => {
          throw Error("unexpected fallback")
        }
      }
    )
    expect(result.value).toMatchObject({ ms: 1000 })
    expect(Number((result.value as ModObject).left)).toBeGreaterThan(900)
  })

  it("times out an unfinished recovery and falls back once without reusing its old frame", async () => {
    const runtime = await guest(`on("command.run",()=>{throw Error("probe")})
      .catch(()=>new Promise(()=>{}))`)
    const dispatcher = new FunctionDispatcher([
      { ...invocation.plugin, tier: "user", guest: runtime, capabilities: [] }
    ])
    let calls = 0
    const result = await dispatcher.dispatch(
      "command.run",
      {},
      {
        core: async () => ({ text: String(++calls) })
      }
    )
    expect(result.value).toEqual({ text: "1" })
    expect(calls).toBe(1)
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("resumes consuming own time after the final free reply", async () => {
    const runtime = await guest(`on("command.run",async($)=>{
      await $.session.id();return await new Promise(()=>{});
    })`)
    const started = performance.now()
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          await delay(100)
          return { value: "actual" }
        },
        { ...invocation, ownBudgetMs: 40, timeoutMs: 1000 }
      )
    ).rejects.toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    expect(performance.now() - started).toBeGreaterThan(125)
  })

  it("rejects a fulfilled continuation which exhausts own time within a single valid CPU slice", async () => {
    const runtime = await guest(`on("command.run",async($)=>{
      await $.session.id();const stop=Date.now()+20;
      while(Date.now()<stop){};return {text:"expired within jobs slice"};
    })`)
    await expect(
      runtime.invoke(
        "0",
        {},
        async () => {
          await delay(30)
          return { value: "actual" }
        },
        { ...invocation, ownBudgetMs: 10, timeoutMs: 1000 }
      )
    ).rejects.toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it.each(["before-recovery", "kept-result", "issued-cleanup"])(
    "bounds an abort-ignoring actual core at %s and keeps it occupied until real finally",
    async (variant) => {
      const ending =
        variant === "before-recovery"
          ? 'throw Error("probe")'
          : variant === "kept-result"
            ? "return undefined"
            : 'return {text:"ignored"}'
      const runtime = await guest(`on("command.run",($,e,next)=>{next(e);${ending}})
        .catch(()=>({text:"must-not-recover-late"}))`)
      const dispatcher = new FunctionDispatcher([
        { ...invocation.plugin, tier: "user", guest: runtime, capabilities: [] }
      ])
      const activity = new FunctionSessionActivity()
      let complete!: (value: ModObject) => void
      let calls = 0
      const pending = activity.fresh(() =>
        dispatcher.dispatch(
          "command.run",
          {},
          {
            timeoutMs: 70,
            retainHost: (run) => activity.run(run),
            core: async () => {
              calls++
              return await new Promise<ModObject>((resolve) => {
                complete = resolve
              })
            }
          }
        )
      )
      await expect(pending).rejects.toThrow("组件处理超过总等待期限")
      expect(calls).toBe(1)
      expect(activity.foregroundSize).toBe(1)
      expect(activity.pauseIfIdle(false)).toBe(false)
      complete({ text: "late" })
      await delay(30)
      expect(calls).toBe(1)
      expect(activity.size).toBe(0)
      expect(runtime.stats.frames).toBe(0)
    }
  )

  it("original cancellation cuts downstream waiting without replaying an actual effect", async () => {
    const runtime = await guest(`on("command.run",async($,e,next)=>await next(e))`)
    const dispatcher = new FunctionDispatcher([
      { ...invocation.plugin, tier: "user", guest: runtime, capabilities: [] }
    ])
    const controller = new AbortController()
    let calls = 0
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = dispatcher.dispatch(
      "command.run",
      {},
      {
        signal: controller.signal,
        core: async () => {
          calls++
          entered()
          return await new Promise(() => {})
        }
      }
    )
    await ready
    controller.abort()
    await expect(pending).rejects.toThrow("MODS_CANCELLED")
    expect(calls).toBe(1)
    expect(runtime.stats.frames).toBe(0)
  })

  it("rejects a synchronous core result past its monotonic wall even before the timer runs", async () => {
    const runtime = await guest(`on("command.run",{command:"other"},($,e,next)=>next(e))`)
    const dispatcher = new FunctionDispatcher([
      { ...invocation.plugin, tier: "user", guest: runtime, capabilities: [] }
    ])
    let calls = 0
    await expect(
      dispatcher.dispatch(
        "command.run",
        { command: "actual" },
        {
          timeoutMs: 20,
          core: async () => {
            calls++
            const stop = performance.now() + 50
            while (performance.now() < stop) {
              /* Actual blocking native core, no timer can run. */
            }
            return { text: "expired" }
          }
        }
      )
    ).rejects.toThrow("组件处理超过总等待期限")
    expect(calls).toBe(1)
  })

  it("cannot enter a recovery hook after a continuation crossed the total wall before its timer", async () => {
    const runtime = await guest(`let recovered=0;
      on("command.run",{command:"slow"},async($)=>{
        await $.session.id();const stop=Date.now()+30;while(Date.now()<stop){};
        return {text:"expired"};
      }).catch(()=>{recovered++;return {text:"must not run"}});
      on("command.run",{command:"read"},()=>({text:String(recovered)}));
    `)
    const dispatcher = new FunctionDispatcher([
      { ...invocation.plugin, tier: "user", guest: runtime, capabilities: ["session.id"] }
    ])
    await expect(dispatcher.dispatch("command.run", { command: "slow" }, {
      timeoutMs: 20,
      capability: async () => { await delay(5); return "actual" },
      core: async () => { throw Error("unexpected core") }
    })).rejects.toThrow("组件处理超过总等待期限")
    expect((await dispatcher.dispatch("command.run", { command: "read" }, {
      core: async () => { throw Error("unexpected core") }
    })).value).toEqual({ text: "0" })
  })

  it.each(["input", "result"])(
    "retains an abort-ignoring actual %s publisher until its own finally",
    async (kind) => {
      const runtime = await guest(`on("command.run",($,e,next)=>next(e))`)
      const dispatcher = new FunctionDispatcher([
        { ...invocation.plugin, tier: "user", guest: runtime, capabilities: [] }
      ])
      const activity = new FunctionSessionActivity()
      let complete!: (value: ModObject) => void
      let calls = 0
      const publish = async (value: ModObject): Promise<ModObject> => {
        calls++
        await new Promise<ModObject>((resolve) => {
          complete = resolve
        })
        return value
      }
      const pending = activity.fresh(() =>
        dispatcher.dispatch(
          "command.run",
          {},
          {
            timeoutMs: 50,
            retainHost: (run) => activity.run(run),
            ...(kind === "input"
              ? { protectInput: publish }
              : {
                  protectResult: (value) => publish(value as ModObject)
                }),
            core: async () => ({ text: "actual" })
          }
        )
      )
      await expect(pending).rejects.toThrow("组件处理超过总等待期限")
      expect(activity.foregroundSize).toBe(1)
      complete({ text: "late" })
      await delay(30)
      expect(activity.size).toBe(0)
      expect(calls).toBe(1)
    }
  )
})
