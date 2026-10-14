import { performance } from "node:perf_hooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionHostCall } from "../../../shared/mods/v2/contracts"

const close: Array<() => void> = []
afterEach(() => {
  for (const cleanup of close.splice(0).reverse()) cleanup()
})
const input = { surface: "desktop", component: "Pane" }
const metadata = {
  event: "ui.resolve",
  plugin: { name: "P", root: "/P" },
  origin: { plugin: "host", tier: "core" as const },
  capabilities: ["store.get", "store.set"]
}

async function runtime(body: string) {
  const guest = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    on("ui.resolve",($,e,next)=>{${body}});
  }};`)
  close.push(() => guest.dispose())
  return guest
}

describe("actual load-time resolver activity", () => {
  it("waits for an ignored SDK reply, its real reaction and second SDK before returning functions", async () => {
    const guest = await runtime(`void $.store.get("first").then(()=>$.store.set("second",1));
      return {Text:p=>({type:"Text",props:p})};`)
    const gate = Promise.withResolvers<void>()
    close.push(() => gate.resolve())
    const seen: string[] = []
    const host: FunctionHostCall = async (method) => {
      seen.push(method)
      if (method === "store.get") await gate.promise
      return { value: {} }
    }
    let settled = false
    const actual = guest.invokeUiResolver(
      "0",
      input,
      host,
      metadata,
      async () => guest.uiResolveContext.newObject(),
      performance.now() + 1000
    )
    void actual.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.waitFor(() => expect(seen).toEqual(["store.get"]))
    expect(settled).toBe(false)
    expect(guest.uiResolverActivityStats.roots).toBe(1)
    gate.resolve()
    const table = await actual
    try {
      const fn = guest.uiResolveContext.getProp(table, "Text")
      try {
        expect(guest.uiResolveContext.typeof(fn)).toBe("function")
      } finally {
        fn.dispose()
      }
    } finally {
      table.dispose()
    }
    expect(seen).toEqual(["store.get", "store.set"])
    expect(guest.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
  })

  it("drains a pure native Promise reaction without requiring any earlier SDK to wake the VM", async () => {
    const guest = await runtime(`void Promise.resolve().then(()=>$.store.set("reaction",1));
      return {Text:p=>({type:"Text",props:p})};`)
    const host = vi.fn<FunctionHostCall>(async () => ({ value: {} }))
    const table = await guest.invokeUiResolver(
      "0",
      input,
      host,
      metadata,
      async () => guest.uiResolveContext.newObject(),
      performance.now() + 1000
    )
    table.dispose()
    expect(host).toHaveBeenCalledExactlyOnceWith(
      "store.set",
      ["reaction", 1],
      expect.any(AbortSignal)
    )
    expect(guest.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
  })

  it("cancellation rejects preparation while ignored-abort host finally remains occupied and late SDK stays zero", async () => {
    const guest = await runtime(`void $.store.get("held").then(()=>$.store.set("late",1));
      return {Text:p=>({type:"Text",props:p})};`)
    const gate = Promise.withResolvers<void>()
    close.push(() => gate.resolve())
    const controller = new AbortController()
    const host = vi.fn<FunctionHostCall>(async () => {
      await gate.promise
      return { value: {} }
    })
    const actual = guest.invokeUiResolver(
      "0",
      input,
      host,
      { ...metadata, signal: controller.signal },
      async () => guest.uiResolveContext.newObject(),
      performance.now() + 1000
    )
    const rejected = expect(actual).rejects.toThrow("MODS_CANCELLED")
    await vi.waitFor(() => expect(host).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejected
    expect(guest.stats.frames).toBe(0)
    expect(guest.uiResolverActivityStats.roots).toBe(1)
    gate.resolve()
    await vi.waitFor(() =>
      expect(guest.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
    )
    expect(host).toHaveBeenCalledTimes(1)
  })
})
