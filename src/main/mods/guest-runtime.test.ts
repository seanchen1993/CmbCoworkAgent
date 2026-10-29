import { afterEach, describe, expect, it } from "vitest"
import { ModGuestRuntime } from "./guest-runtime"

const guests: ModGuestRuntime[] = []
async function guest(body: string): Promise<ModGuestRuntime> {
  const runtime = await ModGuestRuntime.create(
    `var __cmbMod = {default: {register(on) { ${body} }}}`
  )
  guests.push(runtime)
  return runtime
}
afterEach(() => {
  for (const runtime of guests.splice(0)) runtime.dispose()
})

describe("Mod guest isolation and scheduling", () => {
  it("does not expose Node, network, or the host environment", async () => {
    const runtime = await guest(`on.command({id:"probe",command:"probe"}, async () => ({
      globals: [typeof process, typeof require, typeof fetch, typeof Bun, typeof XMLHttpRequest],
      prototypeEscape: ({}).constructor.constructor("return typeof process")()
    }))`)
    expect(await runtime.invoke("probe", {}, async () => null)).toEqual({
      globals: Array(5).fill("undefined"),
      prototypeEscape: "undefined"
    })
  })

  it("awaits an asynchronous host next and keeps call arguments alive", async () => {
    const runtime = await guest(`on.tool({id:"wrap",tools:["host:read_file"]}, async ($,e,next) => {
      const value = await next({args:{file_path:"note.txt"}});
      return {value, tail:"wrapped"};
    })`)
    const calls: unknown[] = []
    expect(
      await runtime.invoke("wrap", {}, async (method, input) => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        calls.push([method, input])
        return "core"
      })
    ).toEqual({ value: "core", tail: "wrapped" })
    expect(calls).toEqual([["next", { args: { file_path: "note.txt" } }]])
  })

  it("does not dispatch next a second time", async () => {
    const runtime =
      await guest(`on.tool({id:"twice",tools:["host:write_file"]}, async ($,e,next) => {
      await next({args:{}}); return next({args:{}});
    })`)
    let writes = 0
    await expect(
      runtime.invoke("twice", {}, async () => {
        writes++
        return null
      })
    ).rejects.toThrow()
    expect(writes).toBe(1)
  })

  it("interrupts synchronous loops instead of hanging the host", async () => {
    const runtime = await guest(
      `on.command({id:"loop",command:"loop"}, async () => {while(true){}})`
    )
    const started = performance.now()
    await expect(runtime.invoke("loop", {}, async () => null)).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it("rejects large allocations", async () => {
    const runtime = await guest(
      `on.command({id:"memory",command:"memory"}, async () => Array(5000000).fill("x"))`
    )
    await expect(runtime.invoke("memory", {}, async () => null)).rejects.toThrow()
  })

  it("keeps runtime globals separate", async () => {
    const a = await guest(
      `globalThis.privateValue=123; on.command({id:"read",command:"read"},async()=>typeof privateValue)`
    )
    const b = await guest(`on.command({id:"read",command:"read"},async()=>typeof privateValue)`)
    expect(await a.invoke("read", {}, async () => null)).toBe("number")
    expect(await b.invoke("read", {}, async () => null)).toBe("undefined")
  })

  it("cancels unresolved guest promises", async () => {
    const runtime = await guest(
      `on.command({id:"pending",command:"pending"},async()=>new Promise(()=>{}))`
    )
    const pending = runtime.invoke("pending", {}, async () => null)
    runtime.cancel()
    await expect(pending).rejects.toThrow("MODS_CANCELLED")
  })

  it("never grants host I/O during module registration", async () => {
    await expect(
      ModGuestRuntime.create(
        `var __cmbMod={default:{register(){ __cmbHostCall("x","tools.invoke","{}"); }}}`
      )
    ).rejects.toThrow()
  })
})
