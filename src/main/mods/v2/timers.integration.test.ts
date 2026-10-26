import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDispatcher } from "./dispatcher"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionSessionActivity } from "./session-activity"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})

async function fixture(body: string, extra: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start", async($,e,next)=>{
      await $.command.register({name:"start",description:"start"});return next(e)
    });${body}}}`)
  const debugLog = vi.fn()
  const session = new FunctionSession(
    [
      {
        name: "timer",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "timers",
      publish: async (v) => v,
      assertLive() {
        /* This fixture retains its grant until teardown. */
      },
      debugLog,
      ...extra
    }
  )
  sessions.push(session)
  return { session, guest, debugLog }
}

it("runs a timer after the command returns with a fresh callback SDK", async () => {
  const { session } = await fixture(`on("command.run",async($,e,next)=>{
    $.clock.after(20, async()=>{$.ui.log("background ready")});return {ok:true}
  });`)
  await session.run("start", "")
  await vi.waitFor(async () =>
    expect((await session.logSnapshot()).map((v) => v.text)).toContain("background ready")
  )
})

it("counts timer final publication and resumes queued callbacks after a failed candidate", async () => {
  const activity = new FunctionSessionActivity()
  const published = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let captured = false
  let creatorReturned = false
  const { session } = await fixture(
    `
    on("command.run",async($)=>{
      $.clock.after(10,()=>{$.ui.log("after publication")});return {ok:true}
    });`,
    {
      activity,
      publish: async (value) => {
        if (value && typeof value === "object" && !Array.isArray(value) && value.ok === true)
          creatorReturned = true
        if (
          !captured &&
          creatorReturned &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length === 0
        ) {
          captured = true
          published.resolve()
          await release.promise
        }
        return value
      }
    }
  )
  await session.run("start", "")
  await published.promise
  expect(activity.pauseIfIdle()).toBe(false)
  release.resolve()
  await vi.waitFor(async () =>
    expect((await session.logSnapshot()).map((v) => v.text)).toContain("after publication")
  )
  await vi.waitFor(() => expect(activity.size).toBe(0))
  expect(activity.pauseIfIdle()).toBe(true)
  const queued = activity.fresh(() => session.run("start", ""))
  await Promise.resolve()
  expect(activity.size).toBe(0)
  activity.resume()
  expect(await queued).toEqual({ ok: true })
  await vi.waitFor(async () => expect((await session.logSnapshot()).length).toBe(2))
})

it("cancels an interval through the module channel after its creator returned", async () => {
  const { session } = await fixture(`on("command.run",async($,e,next)=>{
    let ticks=0;const timer=$.clock.every(10,()=>{
      ++ticks;if(ticks===2)timer.cancel();$.ui.log("tick "+ticks)
    });return {ok:true}
  });`)
  await session.run("start", "")
  await vi.waitFor(async () => expect((await session.logSnapshot()).length).toBe(2))
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect((await session.logSnapshot()).map((v) => v.text)).toEqual(["tick 1", "tick 2"])
})

it("honors timer hook refusal and tears down pending resources on close", async () => {
  const { session, guest } = await fixture(`
    on("clock.after",async()=>({deny:"disabled"}));
    on("command.run",async($)=>{
      $.clock.after(100,()=>{$.ui.log("must not run")});return {ok:true}
    });`)
  await session.run("start", "")
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(await session.logSnapshot()).toEqual([])
  await session.close()
  expect(guest.stats.disposed).toBe(true)
})

it("continues an interval after an ordinary callback error and still honors cancel", async () => {
  const { session, guest, debugLog } = await fixture(`on("command.run",async $=>{
    let n=0;const timer=$.clock.every(20,()=>{
      n++;if(n===1)throw new Error("private-error-text");
      $.ui.log("recovered "+n);if(n===3)timer.cancel()
    });return {ok:true}
  });`)
  await session.run("start", "")
  await vi.waitFor(async () =>
    expect((await session.logSnapshot()).map((row) => row.text)).toEqual([
      "recovered 2",
      "recovered 3"
    ])
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect((await session.logSnapshot()).length).toBe(2)
  expect(debugLog.mock.calls.filter(([, code]) => code === "MODS_TIMER_FAILED")).toHaveLength(1)
  expect(debugLog).toHaveBeenCalledWith("timer", "MODS_TIMER_FAILED")
  await vi.waitFor(() => expect(guest.stats).toMatchObject({ frames: 0, replies: 0 }))
})

it("continues after asynchronous callback rejection and ignores a failing debug sink", async () => {
  const activity = new FunctionSessionActivity()
  const debugLog = vi.fn((_plugin: string, text: string) => {
    if (text === "MODS_TIMER_FAILED") throw new Error("debug sink unavailable")
  })
  const { session, guest } = await fixture(
    `on("command.run",async $=>{
      let n=0;const timer=$.clock.every(20,async()=>{
        n++;await $.clock.sleep(4);if(n===1)throw new Error("private");
        $.ui.log("async recovered");timer.cancel()
      });return {ok:true}
    });`,
    { activity, debugLog }
  )
  await session.run("start", "")
  await vi.waitFor(async () =>
    expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["async recovered"])
  )
  await vi.waitFor(() => expect(activity.size).toBe(0))
  expect(debugLog.mock.calls.filter(([, code]) => code === "MODS_TIMER_FAILED")).toHaveLength(1)
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("contains asynchronous diagnostic failure without treating guest codes as host facts", async () => {
  const debugLog = vi.fn((_plugin: string, text: string) => {
    if (text === "MODS_TIMER_FAILED") return Promise.reject(new Error("diagnostic unavailable"))
    return undefined
  })
  const { session } = await fixture(
    `on("command.run",async $=>{
      let n=0;const timer=$.clock.every(20,()=>{
        if(++n===1){const e=new Error("private");e.code="MODS_PRIVATE_SECRET_CODE";e.__downstream=true;throw e}
        $.ui.log("safe diagnostics");timer.cancel()
      });return {ok:true}
    });`,
    { debugLog }
  )
  await session.run("start", "")
  await vi.waitFor(async () =>
    expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["safe diagnostics"])
  )
  expect(debugLog).toHaveBeenCalledWith("timer", "MODS_TIMER_FAILED")
})

it.each(["after", "every"] as const)(
  "keeps a forged %s callback code out of the production console fallback",
  async (method) => {
    const diagnostic = vi.spyOn(console, "debug").mockImplementation(() => {})
    const { session, guest } = await fixture(
      `on("command.run",async $=>{
        let n=0;const timer=$.clock.${method}(20,()=>{
          if(++n===1){const error=new Error("private");error.code="MODS_PRIVATE_SECRET_CODE";
            error.__downstream=true;throw error}
          timer.cancel()
        });return {ok:true}
      });`,
      { debugLog: undefined }
    )
    const invocation = vi.spyOn(guest, "invoke")
    try {
      await session.run("start", "")
      await vi.waitFor(() =>
        expect(diagnostic).toHaveBeenCalledWith("[Mods] timer: MODS_TIMER_FAILED")
      )
      if (method === "every")
        await vi.waitFor(() =>
          expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(2)
        )
      await new Promise((resolve) => setTimeout(resolve, 70))
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("PRIVATE_SECRET")
      expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(
        method === "every" ? 2 : 1
      )
    } finally {
      await session.close()
      diagnostic.mockRestore()
    }
  }
)

it("keeps the eight-callback admission bound terminal", async () => {
  const { session, guest, debugLog } = await fixture(`on("command.run",async $=>{
    $.clock.every(2,async()=>{await $.clock.sleep(300)});return {ok:true}
  });`)
  const invocation = vi.spyOn(guest, "invoke")
  await session.run("start", "")
  await vi.waitFor(() =>
    expect(debugLog).toHaveBeenCalledWith("timer", "MODS_TIMER_CALLBACK_LIMIT")
  )
  expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(8)
  await vi.waitFor(() => expect(guest.stats).toMatchObject({ frames: 0, replies: 0 }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(8)
})

it("retries a period rejected by the native frame bound after capacity is released", async () => {
  const { session, guest, debugLog } = await fixture(`
    on("hold",()=>new Promise(()=>{}));
    on("command.run",async $=>{
      const timer=$.clock.every(30,()=>{$.ui.log("after capacity");timer.cancel()});return {ok:true}
    });`)
  await session.run("start", "")
  const release = new AbortController()
  const handler = guest.registrations.find((row) => row.pattern === "hold")!
  const holds = Array.from({ length: 32 }, () =>
    guest
      .invoke(handler.id, {}, async () => ({}), {
        event: "hold",
        plugin: { name: "timer", root: "/plugin" },
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        signal: release.signal,
        timeoutMs: 5000
      })
      .catch(() => {})
  )
  try {
    expect(guest.stats.frames).toBe(32)
    await vi.waitFor(() => expect(debugLog).toHaveBeenCalledWith("timer", "MODS_TIMER_FAILED"))
  } finally {
    release.abort()
    await Promise.all(holds)
  }
  await vi.waitFor(async () =>
    expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["after capacity"])
  )
  await vi.waitFor(() => expect(guest.stats).toMatchObject({ frames: 0, replies: 0 }))
})

it("does not continue if authority changes in the precise recovery window", async () => {
  let live = true
  const { session, guest } = await fixture(
    `on("command.run",async $=>{
      $.clock.every(20,()=>{throw new Error("private")});return {ok:true}
    });`,
    {
      assertLive() {
        if (!live) throw new Error("revoked before recovery")
      }
    }
  )
  const nativeInvoke = guest.invoke.bind(guest)
  const invocation = vi.spyOn(guest, "invoke").mockImplementation(async (...args) => {
    try {
      return await nativeInvoke(...args)
    } catch (error) {
      if (args[0] === "resource") live = false
      throw error
    }
  })
  await session.run("start", "")
  await vi.waitFor(() => expect(live).toBe(false))
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(1)
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("does not repeat a failing one-shot callback", async () => {
  const { session, guest, debugLog } = await fixture(`on("command.run",async $=>{
    $.clock.after(10,()=>{
      const error=new Error("private");error.code="MODS_SECRET_CANARY";error.__downstream=true;throw error
    });return {ok:true}
  });`)
  const invocation = vi.spyOn(guest, "invoke")
  await session.run("start", "")
  await vi.waitFor(() => expect(debugLog).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(1)
  expect(debugLog).toHaveBeenCalledWith("timer", "MODS_TIMER_FAILED")
  expect(JSON.stringify(debugLog.mock.calls)).not.toContain("CANARY")
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("keeps a refused later period terminal after an ordinary callback failed", async () => {
  const { session, guest, debugLog } = await fixture(`
    let periods=0;
    on("clock.every",async($,e,next)=>{
      if(++periods===2){await $.clock.sleep(20);return {deny:"stopped"}}return next(e)
    });
    on("command.run",async $=>{
      $.clock.every(20,()=>{throw new Error("first period")});return {ok:true}
    });`)
  const knownCodes = new Set([
    "MODS_BUDGET_EXCEEDED",
    "MODS_HOOK_BUDGET_EXCEEDED",
    "MODS_CANCELLED",
    "MODS_DISPATCH_TIMEOUT",
    "MODS_FRAME_LIMIT",
    "MODS_GUEST_ERROR",
    "MODS_HOOK_FAILED",
    "MODS_HOST_ERROR",
    "MODS_INVOCATION_ENDED",
    "MODS_RESOURCE_CLOSED",
    "MODS_RPC_LIMIT",
    "MODS_STALE_INVOCATION",
    "MODS_UNLOADED",
    "MODS_TRUSTED_WAIT_STALE",
    "MODS_TRUSTED_WAIT_EXPIRED",
    "MODS_TRUSTED_WAIT_DISPATCH_BLOCKED"
  ])
  const events: Array<{
    event: string
    resource: boolean
    elapsedMs: number
    outcome: "returned" | "rejected"
    nativeCode?: string
    stats: typeof guest.stats
  }> = []
  const dispatchErrors: Array<{ event: string; nativeCode: string }> = []
  const matcherErrors: Array<{ nativeCode: string; stats: typeof guest.stats }> = []
  const nativeMatches = guest.matches.bind(guest)
  const matcherSpy = vi.spyOn(guest, "matches").mockImplementation((...args) => {
    try {
      return nativeMatches(...args)
    } catch (error) {
      matcherErrors.push({
        nativeCode:
          error instanceof ModFunctionError && knownCodes.has(error.code)
            ? error.code
            : "REDACTED_NON_NATIVE_OR_UNLISTED",
        stats: guest.stats
      })
      throw error
    }
  })
  const nativeDispatch = FunctionDispatcher.prototype.dispatch
  const dispatchSpy = vi
    .spyOn(FunctionDispatcher.prototype, "dispatch")
    .mockImplementation(async function (this: FunctionDispatcher, ...args) {
      try {
        return await nativeDispatch.apply(this, args)
      } catch (error) {
        dispatchErrors.push({
          event: ["session.start", "command.run", "clock.every"].includes(args[0])
            ? args[0]
            : "other",
          nativeCode:
            error instanceof ModFunctionError && knownCodes.has(error.code)
              ? error.code
              : "REDACTED_NON_NATIVE_OR_UNLISTED"
        })
        throw error
      }
    })
  const nativeInvoke = guest.invoke.bind(guest)
  const invocation = vi.spyOn(guest, "invoke").mockImplementation(async (...args) => {
    const started = performance.now()
    const event = ["session.start", "command.run", "clock.every"].includes(args[3].event)
      ? args[3].event
      : "other"
    try {
      const value = await nativeInvoke(...args)
      events.push({
        event,
        resource: args[0] === "resource",
        elapsedMs: performance.now() - started,
        outcome: "returned",
        stats: guest.stats
      })
      return value
    } catch (error) {
      events.push({
        event,
        resource: args[0] === "resource",
        elapsedMs: performance.now() - started,
        outcome: "rejected",
        stats: guest.stats,
        nativeCode:
          error instanceof ModFunctionError && knownCodes.has(error.code)
            ? error.code
            : "REDACTED_NON_NATIVE_OR_UNLISTED"
      })
      throw error
    }
  })
  try {
    await session.run("start", "")
    await vi.waitFor(() => expect(debugLog).toHaveBeenCalledWith("timer", "MODS_TIMER_DENIED"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(1)
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  } catch (error) {
    // Never print callback text, arbitrary Guest codes, arguments, or returned payloads.
    console.error(
      "[timer-refusal-diagnostic]",
      JSON.stringify({
        events,
        dispatchErrors,
        matcherErrors,
        stats: guest.stats,
        debugCodes: debugLog.mock.calls.map(([, code]) =>
          [
            "MODS_TIMER_DENIED",
            "MODS_TIMER_FAILED",
            "MODS_TIMER_CALLBACK_LIMIT",
            "MODS_RESOURCE_CLOSED"
          ].includes(code)
            ? code
            : "REDACTED"
        )
      })
    )
    throw error
  } finally {
    dispatchSpy.mockRestore()
    matcherSpy.mockRestore()
  }
})

it.each(["revoke", "dispose", "close"] as const)(
  "keeps %s terminal when an asynchronous interval callback fails",
  async (mode) => {
    let live = true
    const { session, guest } = await fixture(
      `on("command.run",async $=>{
        $.clock.every(100,async()=>{await $.clock.sleep(40);throw new Error("private")});
        return {ok:true}
      });`,
      {
        assertLive() {
          if (!live) throw new Error("authority revoked")
        }
      }
    )
    const invocation = vi.spyOn(guest, "invoke")
    await session.run("start", "")
    await vi.waitFor(() =>
      expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(1)
    )
    if (mode === "revoke") live = false
    else if (mode === "dispose") guest.dispose()
    else await session.close()
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(invocation.mock.calls.filter(([id]) => id === "resource")).toHaveLength(1)
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  }
)
