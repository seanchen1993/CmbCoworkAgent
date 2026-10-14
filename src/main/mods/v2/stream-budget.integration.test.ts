import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionGuest } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionPlugin } from "./dispatcher"
import { dispatchFunctionStream } from "./stream-dispatcher"
import { dispatchFunctionPullStream } from "./pull-stream-dispatcher"
import { FunctionSessionActivity } from "./session-activity"
import { FUNCTION_STREAM_TERMINAL } from "./host-stream-lifetime"

const guests: FunctionGuestRuntime[] = []
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))
async function plugin(source: string, smallBudget?: number): Promise<FunctionPlugin> {
  const runtime = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod={register(on){${source}}}`
  )
  guests.push(runtime)
  const guest: FunctionGuest =
    smallBudget === undefined
      ? runtime
      : {
          registrations: runtime.registrations,
          get stats() {
            return runtime.stats
          },
          invoke: (id, input, host, options) =>
            runtime.invoke(
              id,
              input,
              host,
              options.ownBudgetMs === 10000 ? { ...options, ownBudgetMs: smallBudget } : options
            ),
          matches: (id, input) => runtime.matches(id, input),
          releaseUi: (id) => runtime.releaseUi(id),
          dispose: () => runtime.dispose()
        }
  return {
    name: "stream-budget",
    root: "/stream-budget",
    tier: "user",
    guest,
    capabilities: ["session.id"]
  }
}
const work = `const stop=Date.now()+25;while(Date.now()<stop){}`

it.each(["undefined", "{invalid:true}"])(
  "preserves native first input after an invalid process transformation: %s",
  async (invalid) => {
    const p = await plugin(`on("process.spawn",async function*($,e,next){
    const stream=next(e);await stream.next();yield ${invalid};return {code:0}
  })`)
    let calls = 0
    const stream = dispatchFunctionPullStream(
      [p],
      {},
      {
        core: async function* () {
          calls++
          yield { text: "a" }
          yield { text: "b" }
          return { code: 0 }
        },
        validateChunk: (chunk) => {
          if (
            !chunk ||
            typeof chunk !== "object" ||
            Array.isArray(chunk) ||
            typeof chunk.text !== "string"
          )
            throw Error("invalid native chunk")
        }
      }
    )
    const chunks: ModJson[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "a" }, { text: "b" }])
    expect(await stream.result).toEqual({ code: 0 })
    expect(calls).toBe(1)
  }
)

it("accumulates turn work across chunks, preserving the unpublished second input on own expiry", async () => {
  const p = await plugin(
    `on("turn.step",async function*($,e,next){
    for await(const chunk of next(e)){${work};yield {text:"changed-"+chunk.text}}
    return {text:"done"}
  })`,
    40
  )
  let calls = 0
  const stream = dispatchFunctionStream(
    [p],
    {},
    {
      core: async function* () {
        calls++
        yield { text: "a" }
        yield { text: "b" }
        return { text: "native-done" }
      }
    }
  )
  const chunks: ModJson[] = []
  for await (const chunk of stream) chunks.push(chunk)
  expect(chunks).toEqual([{ text: "changed-a" }, { text: "b" }])
  expect(await stream.result).toEqual({ text: "native-done" })
  expect(calls).toBe(1)
})

it("starts a fresh own budget for each real process piece instead of accumulating the process lifetime", async () => {
  const p = await plugin(
    `on("process.spawn",async function*($,e,next){
    for await(const chunk of next(e)){${work};yield {text:"changed-"+chunk.text}}
    return {code:0}
  })`,
    40
  )
  let calls = 0
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["actual"] },
    {
      core: async function* () {
        calls++
        yield { text: "a" }
        yield { text: "b" }
        return { code: 0 }
      }
    }
  )
  const chunks: ModJson[] = []
  for await (const chunk of stream) chunks.push(chunk)
  expect(chunks).toEqual([{ text: "changed-a" }, { text: "changed-b" }])
  expect(calls).toBe(1)
})

it.each(["turn.step", "process.spawn"])(
  "a real failed %s hook reuses its pending first pull without losing a chunk",
  async (event) => {
    const entered = Promise.withResolvers<void>()
    const p = await plugin(`on("${event}",async function*($,e,next){
    const downstream=next(e);const first=downstream.next();first.catch(()=>{});
    await $.session.id();throw Error("before pending first item");yield {};
  })`)
    let calls = 0
    const core = async function* () {
      calls++
      entered.resolve()
      await delay(70)
      yield { text: "first" }
      yield { text: "second" }
      return { text: "native-done" }
    }
    const sdk = async () => {
      await entered.promise
      return { value: "actual" }
    }
    const options = { core, sdk, capabilities: () => p.capabilities }
    const stream =
      event === "turn.step"
        ? dispatchFunctionStream([p], {}, options)
        : dispatchFunctionPullStream([p], { argv: ["actual"] }, options)
    const chunks: ModJson[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "first" }, { text: "second" }])
    expect(await stream.result).toEqual({ text: "native-done" })
    expect(calls).toBe(1)
  }
)

it.each(["turn.step", "process.spawn"])(
  "a %s hook's failed finally cannot close input needed by recovery",
  async (event) => {
    const p = await plugin(`on("${event}",async function*($,e,next){
    const downstream=next(e);
    try{yield (await downstream.next()).value;await $.session.id();throw Error("after first")}
    finally{await downstream.return()}
  })`)
    let calls = 0
    const core = async function* () {
      calls++
      yield { text: "first" }
      yield { text: "second" }
      return { code: 0 }
    }
    const sdk = async () => ({ value: "actual" })
    const options = { core, sdk, capabilities: () => p.capabilities }
    const stream =
      event === "turn.step"
        ? dispatchFunctionStream([p], {}, options)
        : dispatchFunctionPullStream([p], { argv: ["actual"] }, options)
    const chunks: ModJson[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "first" }, { text: "second" }])
    expect(calls).toBe(1)
  }
)

it("pauses the turn clock while waiting for downstream and for actual consumer backpressure", async () => {
  const p = await plugin(
    `on("turn.step",async function*($,e,next){
    const before=next.budget.remainingMs;for await(const chunk of next(e))yield chunk;
    return {lost:before-next.budget.remainingMs,ms:next.budget.ms};
  })`,
    80
  )
  const stream = dispatchFunctionStream(
    [p],
    {},
    {
      core: async function* () {
        await delay(100)
        yield { text: "a" }
        yield { text: "b" }
        return {}
      }
    }
  )
  expect((await stream.next()).value).toEqual({ text: "a" })
  await delay(120)
  expect((await stream.next()).value).toEqual({ text: "b" })
  const result = await stream.next()
  expect(result.done).toBe(true)
  expect(Number((result.value as ModObject).lost)).toBeLessThan(50)
})

it("retains recovery's one-second identity over multiple real process cursor pulls and slow SDK waits", async () => {
  const p = await plugin(`on("process.spawn",async function*(){throw Error("probe");yield {}})
    .catch(async function*($,e,next){
      await $.session.id();yield {ms:next.budget.ms,errorBudget:next.error.budget};
      await $.session.id();yield {ms:next.budget.ms,errorBudget:next.error.budget};return {code:0};
    })`)
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["actual"] },
    {
      capabilities: () => p.capabilities,
      sdk: async () => {
        await delay(1100)
        return { value: "actual" }
      },
      core: async function* () {
        yield { unexpected: true }
        return { code: 1 }
      }
    }
  )
  expect((await stream.next()).value).toEqual({ ms: 1000, errorBudget: 1000 })
  expect((await stream.next()).value).toEqual({ ms: 1000, errorBudget: 1000 })
  expect(await stream.next()).toEqual({ done: true, value: { code: 0 } })
})

it.each(["turn.step", "process.spawn"])(
  "a %s caller cut retains actual next and a yielding finally until real terminal",
  async (event) => {
    const p = await plugin(`on("${event}",async function*($,e,next){return yield* next(e)})`)
    const activity = new FunctionSessionActivity(),
      outer = new FunctionSessionActivity()
    const release = Promise.withResolvers<void>(),
      cleaning = Promise.withResolvers<void>(),
      cleaned = Promise.withResolvers<void>()
    let calls = 0,
      closes = 0
    const core = async function* () {
      calls++
      try {
        await release.promise
        yield { text: "late" }
        return { code: 0 }
      } finally {
        closes++
        cleaning.resolve()
        yield { text: "cleanup" }
        await cleaned.promise
      }
    }
    const options = {
      core,
      timeoutMs: 40,
      transport: {
        run: <T>(run: () => Promise<T>) => activity.run(run),
        cleanup: <T>(run: () => Promise<T>) => activity.cleanup(run)
      }
    }
    const stream = await outer.run(() =>
      activity.run(async () =>
        event === "turn.step"
          ? dispatchFunctionStream([p], {}, options)
          : dispatchFunctionPullStream([p], { argv: ["actual"] }, options)
      )
    )
    await expect(stream.next()).rejects.toThrow("组件处理超过总等待期限")
    expect(calls).toBe(1)
    expect(activity.size).toBeGreaterThan(0)
    expect(outer.size).toBe(1)
    release.resolve()
    await cleaning.promise
    expect(activity.size).toBeGreaterThan(0)
    expect(outer.size).toBe(1)
    cleaned.resolve()
    await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
    await Promise.resolve()
    expect(closes).toBe(1)
    expect(activity.size).toBe(0)
    expect(outer.size).toBe(0)
  }
)

it("cancels a paused turn and settles result and actual cleanup without another consumer pull", async () => {
  const p = await plugin(`on("turn.step",async function*($,e,next){return yield* next(e)})`)
  const controller = new AbortController()
  let closes = 0
  const stream = dispatchFunctionStream(
    [p],
    {},
    {
      signal: controller.signal,
      core: async function* () {
        try {
          yield { text: "a" }
          yield { text: "b" }
          return {}
        } finally {
          closes++
        }
      }
    }
  )
  await stream.next()
  const failed = expect(stream.result).rejects.toThrow("MODS_CANCELLED")
  controller.abort()
  await failed
  await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
  expect(closes).toBe(1)
})

it.each(["turn.step", "process.spawn"])(
  "a no-hook %s keeps original lifetime and observes real yielding cleanup",
  async (event) => {
    const activity = new FunctionSessionActivity(),
      outer = new FunctionSessionActivity()
    const finish = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    const core = async function* () {
      try {
        await delay(55)
        yield { text: "first" }
        return {}
      } finally {
        entered.resolve()
        yield { text: "cleanup" }
        await finish.promise
      }
    }
    // No hook means the optional 10ms setting does not change the native operation's lifetime.
    const options = { core, timeoutMs: 10 }
    const stream = await outer.run(() =>
      activity.run(async () =>
        event === "turn.step"
          ? dispatchFunctionStream([], {}, options)
          : dispatchFunctionPullStream([], {}, options)
      )
    )
    expect((await stream.next()).value).toEqual({ text: "first" })
    const failed = expect(stream.result).rejects.toThrow("MODS_STREAM_CLOSED")
    const returning = stream.return(null)
    await entered.promise
    await failed
    expect((await returning).done).toBe(false)
    expect(activity.size).toBe(1)
    expect(outer.size).toBe(1)
    const draining = stream.next()
    finish.resolve()
    await draining
    await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
    await Promise.resolve()
    expect(activity.size).toBe(0)
    expect(outer.size).toBe(0)
  }
)

it.each(["turn.step", "process.spawn"])(
  "a no-hook %s returned before first pull reaches actual terminal",
  async (event) => {
    let calls = 0
    const options = {
      core: async function* () {
        calls++
        yield {}
        return {}
      }
    }
    const stream =
      event === "turn.step"
        ? dispatchFunctionStream([], {}, options)
        : dispatchFunctionPullStream([], {}, options)
    await stream.return(null)
    await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
    expect(calls).toBe(0)
  }
)

it("starts cleanup for every actual turn cursor before waiting for the first provider's finally", async () => {
  const p = await plugin(`on("turn.step",async function*($,e,next){
    const first=next({which:1});await first.next();
    const second=next({which:2});yield (await second.next()).value;return {};
  })`)
  const release = Promise.withResolvers<void>(),
    firstCleaning = Promise.withResolvers<void>()
  const closes: number[] = []
  let calls = 0
  const stream = dispatchFunctionStream(
    [p],
    {},
    {
      core: async function* (input) {
        calls++
        try {
          yield { text: String(input.which) }
          return {}
        } finally {
          closes.push(Number(input.which))
          if (input.which === 1) {
            firstCleaning.resolve()
            await release.promise
          }
        }
      }
    }
  )
  expect((await stream.next()).value).toEqual({ text: "2" })
  const pending = stream.next()
  await firstCleaning.promise
  await delay(15)
  expect(closes).toEqual([1, 2])
  release.resolve()
  expect((await pending).done).toBe(true)
  expect(calls).toBe(2)
})
