import { afterEach, describe, expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { dispatchFunctionStream, type FunctionStreamOptions } from "./stream-dispatcher"

const guests: FunctionGuestRuntime[] = []
const input = { turnId: "turn", index: 0, model: "fixture", messageCount: 1 }
async function run(body: string, core: FunctionStreamOptions["core"]) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  guests.push(guest)
  return dispatchFunctionStream(
    [{ guest, name: "stream-probe", root: "/probe", tier: "user", capabilities: [] }],
    input,
    { core }
  )
}
async function* core(): AsyncGenerator<ModJson, ModJson> {
  yield { kind: "text", text: "one" }
  yield { kind: "text", text: "two" }
  return { answer: "onetwo" }
}
afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))

describe("function stream bridge", () => {
  it("closing an unread stream rejects result without starting a provider", async () => {
    let requests = 0
    const stream = await run(
      `on("turn.step",async function*($,e,next){return yield* next(e)})`,
      async function* () {
        requests++
        yield* []
        return {}
      }
    )
    await stream.return(null)
    await expect(stream.result).rejects.toThrow("MODS_STREAM_CLOSED")
    expect(requests).toBe(0)
  })
  it("transforms chunks while keeping generator result separate", async () => {
    const stream = await run(
      `on("turn.step",async function*($,e,next){
      const stream=next(e);
      for await(const c of stream) yield {...c,text:c.text.toUpperCase()};
      const result=await stream.result;
      return {...result,answer:"terminal-value"};
    })`,
      core
    )
    const chunks: ModJson[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual([
      { kind: "text", text: "ONE" },
      { kind: "text", text: "TWO" }
    ])
    expect(await stream.result).toEqual({ answer: "terminal-value" })
    expect(guests[0].stats).toMatchObject({ frames: 0, replies: 0 })
  })
  it("yield star forwards the terminal result", async () => {
    const stream = await run(
      `on("turn.step",async function*($,e,next){return yield* next(e)})`,
      core
    )
    const values: ModJson[] = []
    for await (const value of stream) values.push(value)
    expect(values).toHaveLength(2)
    expect(await stream.result).toEqual({ answer: "onetwo" })
  })
  it("keeps emitted chunks and continues downstream after a transforming hook fails", async () => {
    let requests = 0
    const stream = await run(
      `on("turn.step",async function*($,e,next){
      for await(const c of next(e)){yield {...c,text:"wrapped-"+c.text};throw Error("failed-after-first")}
    })`,
      async function* () {
        requests++
        return yield* core()
      }
    )
    const values: ModJson[] = []
    for await (const value of stream) values.push(value)
    expect(values).toEqual([
      { kind: "text", text: "wrapped-one" },
      { kind: "text", text: "two" }
    ])
    expect(requests).toBe(1)
    expect(await stream.result).toEqual({ answer: "onetwo" })
  })
  it("opens a fresh downstream request for each next", async () => {
    let requests = 0
    const stream = await run(
      `on("turn.step",async function*($,e,next){yield* next(e);return yield* next(e)})`,
      async function* () {
        requests++
        return yield* core()
      }
    )
    const values: ModJson[] = []
    for await (const value of stream) values.push(value)
    expect(values).toHaveLength(4)
    expect(requests).toBe(2)
  })
  it("a slow reader does not let a guest generate an unbounded stream", async () => {
    let reads = 0
    const stream = await run(
      `on("turn.step",async function*($,e,next){return yield* next(e)})`,
      async function* () {
        for (let i = 0; i < 10000; i++) {
          reads++
          yield { kind: "text", text: String(i) }
        }
        return {}
      }
    )
    expect((await stream.next()).done).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect(reads).toBeLessThanOrEqual(3)
    await stream.return(null)
    await expect(stream.result).rejects.toThrow("MODS_STREAM_CLOSED")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(guests[0].stats).toMatchObject({ frames: 0, replies: 0 })
  })
  it("does not restart a failed provider", async () => {
    let requests = 0
    const stream = await run(
      `on("turn.step",async function*($,e,next){return yield* next(e)})`,
      async function* () {
        requests++
        yield { kind: "text", text: "prefix" }
        throw Error("provider-disconnected")
      }
    )
    expect((await stream.next()).value).toEqual({ kind: "text", text: "prefix" })
    await expect(stream.next()).rejects.toThrow("provider-disconnected")
    expect(requests).toBe(1)
  })
})
