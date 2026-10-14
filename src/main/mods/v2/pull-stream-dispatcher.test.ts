import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { dispatchFunctionPullStream } from "./pull-stream-dispatcher"
import type { FunctionPlugin } from "./dispatcher"
import type { ModJson } from "../../../shared/mods/types"
import { FUNCTION_STREAM_TERMINAL } from "./host-stream-lifetime"

const guests: FunctionGuestRuntime[] = []
afterEach(() => {
  for (const guest of guests.splice(0)) guest.dispose()
})
async function plugin(body: string): Promise<FunctionPlugin> {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  guests.push(guest)
  return { name: "stream", root: "/stream", tier: "prepend", guest, capabilities: [] }
}

it("pulls a persistent generator with fresh SDK scope and no live frame between chunks", async () => {
  const p = await plugin(`on("process.spawn",async function*($,e,next){
    const first=next.signal;yield {data:await $.session.id()};
    yield {data:await $.session.id(),fresh:first!==next.signal};return yield* next(e)
  })`)
  let calls = 0
  const sources: unknown[] = []
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      timeoutMs: 30,
      capabilities: () => ["session.id"],
      sdk: async (_owner, _method, _args, _signal, source) => {
        sources.push(source)
        return { value: String(++calls) }
      },
      core: async function* () {
        yield { data: "core" }
        return { code: 0 }
      }
    }
  )
  expect(await stream.next()).toEqual({ done: false, value: { data: "1" } })
  expect((p.guest as FunctionGuestRuntime).stats.frames).toBe(0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await stream.next()).toEqual({ done: false, value: { data: "2", fresh: true } })
  expect(await stream.next()).toEqual({ done: false, value: { data: "core" } })
  expect(await stream.next()).toEqual({ done: true, value: { code: 0 } })
  expect(await stream.result).toEqual({ code: 0 })
  const registration = p.guest.registrations[0]
  expect(sources).toEqual(Array.from({ length: 2 }, () => ({ event: "process.spawn",
    registration: registration.id, identity: registration })))
  for (const source of sources)
    expect((source as { identity: unknown }).identity).toBe(registration)
})

it("allows a successful never-next hook to refuse without spawning", async () => {
  const p = await plugin(`on("process.spawn",async function*(){return {code:7}})`)
  const core = vi.fn(async function* () {
    yield {}
    return { code: 0 }
  })
  const stream = dispatchFunctionPullStream([p], { argv: ["tool"] }, { core })
  expect(await stream.next()).toEqual({ done: true, value: { code: 7 } })
  expect(core).not.toHaveBeenCalled()
})

it("binds the per-piece budget getter to the actual live cursor pull rather than its closed open frame", async () => {
  const p = await plugin(`on("process.spawn",async function*($,e,next){
    yield {ms:next.budget.ms,infinite:next.budget.remainingMs===Infinity};
    yield {ms:next.budget.ms,infinite:next.budget.remainingMs===Infinity};return {code:0};
  })`)
  const stream = dispatchFunctionPullStream([p], { argv: ["tool"] }, {
    core: async function* () { yield { unexpected: true }; return { code: 1 } }
  })
  expect(await stream.next()).toEqual({ done: false, value: { ms: 10000, infinite: false } })
  expect((p.guest as FunctionGuestRuntime).stats.frames).toBe(0)
  expect(await stream.next()).toEqual({ done: false, value: { ms: 10000, infinite: false } })
  expect(await stream.next()).toEqual({ done: true, value: { code: 0 } })
})

it("does not restart a started process after a transforming hook fails", async () => {
  const p = await plugin(`on("process.spawn",async function*($,e,next){
    const stream=next(e);yield (await stream.next()).value;throw Error("transform failed")
  })`)
  let starts = 0
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      core: async function* () {
        starts++
        yield { data: "a" }
        yield { data: "b" }
        return { code: 0 }
      }
    }
  )
  expect((await stream.next()).value).toEqual({ data: "a" })
  expect((await stream.next()).value).toEqual({ data: "b" })
  expect(await stream.next()).toEqual({ done: true, value: { code: 0 } })
  expect(starts).toBe(1)
})

it("closes the real downstream iterator on early return", async () => {
  const p = await plugin(`on("process.spawn",async function*($,e,next){return yield* next(e)})`)
  let closed = 0
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      core: async function* () {
        try {
          yield { data: "a" }
          yield { data: "b" }
          return { code: 0 }
        } finally {
          closed++
        }
      }
    }
  )
  await stream.next()
  await stream.return(null)
  expect(closed).toBe(1)
  await expect(stream.result).rejects.toThrow("MODS_STREAM_CLOSED")
  expect((p.guest as FunctionGuestRuntime).stats.frames).toBe(0)
})

it("rejects a saved cursor continuation invoked by another hook", async () => {
  const p =
    await plugin(`let saved;on("process.spawn",async function*($,e,next){saved=()=>next(e);yield {data:"pause"};return {code:0}});
    on("command.run",()=>{try{saved();return {escaped:true}}catch(error){return {error:error.message}}})`)
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      // eslint-disable-next-line require-yield -- Intentionally test a stream with no emitted chunks.
      core: async function* () {
        return { code: 0 }
      }
    }
  )
  await stream.next()
  const result = await p.guest.invoke("1", {}, async () => ({}), {
    event: "command.run",
    origin: { plugin: "engine", tier: "core" },
    capabilities: [],
    plugin: { name: p.name, root: p.root }
  })
  expect(result).toEqual({ value: { error: "MODS_STALE_STREAM_PULL" } })
  await stream.return(null)
})

it("bounds a hanging pull and aborts its backend before return cleanup", async () => {
  const p = await plugin(`on("process.spawn",async function*($,e,next){return yield* next(e)})`)
  let aborted = false
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      timeoutMs: 20,
      // eslint-disable-next-line require-yield -- Intentionally test a stream with no emitted chunks.
      core: async function* (_input, { signal }) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(Error("ended"))
            },
            { once: true }
          )
        )
        return null as ModJson
      }
    }
  )
  await expect(stream.next()).rejects.toThrow()
  expect(aborted).toBe(true)
  await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
  expect((p.guest as FunctionGuestRuntime).stats.frames).toBe(0)
})

it("reuses a completed downstream result in catch without restarting the process", async () => {
  const p =
    await plugin(`on("process.spawn",async function*($,e,next){yield* next(e);throw Error("after done")})
    .catch(async function*($,e,next){return yield* next(e)})`)
  let starts = 0
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      // eslint-disable-next-line require-yield -- Intentionally test a stream with no emitted chunks.
      core: async function* () {
        starts++
        return { code: 0 }
      }
    }
  )
  expect(await stream.next()).toEqual({ done: true, value: { code: 0 } })
  expect(starts).toBe(1)
})

it("closes a pending next by aborting the backend before queuing generator return", async () => {
  const p = await plugin(`on("process.spawn",async function*($,e,next){return yield* next(e)})`)
  let ready!: () => void,
    closed = 0
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const stream = dispatchFunctionPullStream(
    [p],
    { argv: ["tool"] },
    {
      // eslint-disable-next-line require-yield -- Intentionally test a stream with no emitted chunks.
      core: async function* (_input, { signal }) {
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Error("closed")), { once: true })
            ready()
          })
          return null
        } finally {
          closed++
        }
      }
    }
  )
  const pending = stream.next()
  const failure = expect(pending).rejects.toThrow()
  await started
  await stream.return(null)
  await failure
  expect(closed).toBe(1)
})

it("releases even suspended guest cursors after repeated pull timeouts", async () => {
  const p = await plugin(
    `on("process.spawn",async function*($,e){if(e.argv[0]==="hang")await new Promise(()=>{});return {code:7}})`
  )
  // eslint-disable-next-line require-yield -- Intentionally test a stream with no emitted chunks.
  const core = async function* () {
    return { code: 0 }
  }
  for (let i = 0; i < 34; i++) {
    const stream = dispatchFunctionPullStream([p], { argv: ["hang"] }, { timeoutMs: 10, core })
    await expect(stream.next()).rejects.toThrow("组件处理超过总等待期限")
    await (stream as unknown as Record<symbol, Promise<void>>)[FUNCTION_STREAM_TERMINAL]
  }
  const next = dispatchFunctionPullStream([p], { argv: ["ok"] }, { core })
  expect((await next.next()).value).toEqual({ code: 7 })
})
