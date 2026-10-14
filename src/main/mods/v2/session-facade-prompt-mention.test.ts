import { expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionActivity } from "./session-activity"
import { trackFunctionSession } from "./session-facade"
import { trackFunctionGuest } from "./session-guest"
import { FunctionSessionInitializer } from "./session-initializer"

const input: ModObject = {
  mention: "file.txt#L2-3",
  path: "C:/project/file.txt",
  offset: 2,
  limit: 2
}

async function fixture() {
  const idle = Promise.withResolvers<void>()
  const activity = new FunctionSessionActivity(() => idle.resolve())
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("prompt.mention",async($,e,next)=>{
      await $.store.get("actual-entry");
      const first=next({...e,path:"C:/project/first.txt"});
      const second=next({...e,path:"C:/project/second.txt"});
      return {...await second,context:[JSON.stringify(await first),"完整上下文🙂"]};
    });
  }}`)
  let hostCalls = 0
  try {
    const guest = trackFunctionGuest(runtime, activity, new FunctionSessionInitializer(false))
    const actual = new FunctionSession([{
      name: "mention",
      root: "/plugin/mention",
      tier: "user",
      guest,
      capabilities: [...SESSION_CAPABILITIES]
    }], {
      workspace: "C:/project",
      threadId: "thread",
      activity,
      assertLive() { /* This fixture tests entry lifetime, without minting runtime authority. */ },
      publish: async (value: ModJson) => value,
      state: () => ({
        get: async key => {
          expect(key).toBe("actual-entry")
          expect(activity.withinEntry).toBe(true)
          hostCalls++
          return "actual host value"
        },
        set: async () => { /* The actual Hook uses only the persistent store read. */ },
        delete: () => { /* No deletion is used by this entry-lifetime fixture. */ },
        keys: async () => []
      })
    })
    return {
      activity,
      idle: idle.promise,
      session: trackFunctionSession(actual, activity),
      hostCalls: () => hostCalls,
      close: () => actual.close()
    }
  } catch (error) {
    runtime.dispose()
    throw error
  }
}

it("keeps the genuine facade entry through deferred first next and rejects its late continuation", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const wakeLate = Promise.withResolvers<void>()
  const result: ModObject = { type: "file" }
  let coreCalls = 0
  let coreFinally = false
  let late: Promise<void> | undefined
  let lateEffects = 0
  const call = f.session.promptMention(input, new AbortController().signal, async received => {
    coreCalls++
    console.info("[prompt-mention-facade-core]", JSON.stringify({ received, hostCalls: f.hostCalls() }))
    expect(received).toEqual({ ...input, path: "C:/project/first.txt" })
    expect(f.activity.withinEntry).toBe(true)
    late = wakeLate.promise.then(async () => {
      expect(() => f.activity.retain()).toThrow("MODS_ENTRY_EXPIRED")
      await expect(f.activity.run(async () => { lateEffects++ }))
        .rejects.toThrow("MODS_ENTRY_EXPIRED")
    })
    entered.resolve()
    try {
      await proceed.promise
      expect(f.activity.withinEntry).toBe(true)
      return result
    } finally { coreFinally = true }
  })
  try {
    await Promise.race([entered.promise, call.then(() => {
      throw Error("mention returned before actual Core entry")
    })])
    expect(coreFinally).toBe(false)
    expect(f.activity.size).toBeGreaterThan(0)
    expect(f.activity.pauseIfIdle()).toBe(false)
    proceed.resolve()
    expect(await call).toEqual({
      type: "file",
      context: [JSON.stringify(result), "完整上下文🙂"]
    })
    await f.idle
    expect(coreFinally).toBe(true)
    expect(f.activity.size).toBe(0)
    expect(coreCalls).toBe(1)
    expect(f.hostCalls()).toBe(1)
    expect(late).toBeDefined()
    wakeLate.resolve()
    await late
    expect(lateEffects).toBe(0)
  } finally {
    proceed.resolve()
    wakeLate.resolve()
    await Promise.allSettled([call, ...(late ? [late] : [])])
    await f.close()
  }
})

it("propagates the actual Core rejection once and retires the genuine facade occupancy", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const failure = Error("actual mention Core failed")
  let coreCalls = 0
  let coreFinally = false
  const call = f.session.promptMention(input, new AbortController().signal, async received => {
    coreCalls++
    console.info("[prompt-mention-facade-core]", JSON.stringify({ received, hostCalls: f.hostCalls() }))
    expect(received).toEqual({ ...input, path: "C:/project/first.txt" })
    entered.resolve()
    try { await proceed.promise; throw failure }
    finally { coreFinally = true }
  })
  const rejected = expect(call).rejects.toThrow("actual mention Core failed")
  try {
    await Promise.race([entered.promise, call.then(() => {
      throw Error("mention returned before actual Core entry")
    })])
    expect(f.activity.size).toBeGreaterThan(0)
    expect(f.activity.pauseIfIdle()).toBe(false)
    proceed.resolve()
    await rejected
    await f.idle
    expect(coreFinally).toBe(true)
    expect(coreCalls).toBe(1)
    expect(f.hostCalls()).toBe(1)
    expect(f.activity.size).toBe(0)
  } finally {
    proceed.resolve()
    await Promise.allSettled([call, rejected])
    await f.close()
  }
})

it("keeps actual Core occupancy after a cancelled facade result until its true finally", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const controller = new AbortController()
  let coreCalls = 0
  let coreFinally = false
  const call = f.session.promptMention(input, controller.signal, async received => {
    coreCalls++
    console.info("[prompt-mention-facade-core]", JSON.stringify({ received, hostCalls: f.hostCalls() }))
    expect(received).toEqual({ ...input, path: "C:/project/first.txt" })
    entered.resolve()
    try {
      await proceed.promise
      controller.signal.throwIfAborted()
      return { type: "file" }
    } finally { coreFinally = true }
  })
  const rejected = expect(call).rejects.toThrow("MODS_CANCELLED")
  try {
    await Promise.race([entered.promise, call.then(() => {
      throw Error("mention returned before actual Core entry")
    })])
    controller.abort(Error("actual mention cancelled"))
    await rejected
    expect(coreFinally).toBe(false)
    expect(f.activity.size).toBeGreaterThan(0)
    expect(f.activity.pauseIfIdle()).toBe(false)
    proceed.resolve()
    await f.idle
    expect(coreFinally).toBe(true)
    expect(coreCalls).toBe(1)
    expect(f.hostCalls()).toBe(1)
    expect(f.activity.size).toBe(0)
  } finally {
    proceed.resolve()
    await Promise.allSettled([call, rejected])
    await f.idle
    await f.close()
  }
})
