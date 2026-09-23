import { afterEach, expect, it, vi } from "vitest"
import { FunctionFocusRequests } from "./ui-focus"

const target = { pane: "demo:board", generation: "drawing", plugin: "demo", element: "next" }
const exchanges: FunctionFocusRequests[] = []
afterEach(() => {
  for (const exchange of exchanges.splice(0)) exchange.close()
  vi.useRealTimers()
})
function fixture() {
  const assertLive = vi.fn()
  const changed = vi.fn()
  const exchange = new FunctionFocusRequests({ assertLive, changed })
  exchanges.push(exchange)
  return { exchange, assertLive, changed }
}
const pass = (apply: (address: typeof target) => Promise<{ deny?: string }>) => apply(target)

it("requires both keyboard ownership and actual focus acknowledgements", async () => {
  const { exchange } = fixture()
  let finished = false
  const result = exchange.run(target, new AbortController().signal, pass).then((value) => {
    finished = true
    return value
  })
  const probe = exchange.current(target.pane)!
  expect(probe.phase).toBe("probe")
  expect(finished).toBe(false)
  exchange.ack({ ...probe, allowed: true })
  await vi.waitFor(() => expect(exchange.current(target.pane)?.phase).toBe("apply"))
  expect(finished).toBe(false)
  const apply = exchange.current(target.pane)!
  expect(() => exchange.ack({ ...probe, allowed: true })).toThrow("MODS_UI_FOCUS_STALE")
  exchange.ack({ ...apply, allowed: true })
  expect(await result).toEqual({})
  expect(exchange.current(target.pane)).toBeUndefined()
  expect(() => exchange.ack({ ...apply, allowed: true })).toThrow("MODS_UI_FOCUS_STALE")
})

it("does not dispatch focus hooks when the renderer rejects ownership", async () => {
  const { exchange } = fixture()
  const dispatch = vi.fn(pass)
  const result = exchange.run(target, new AbortController().signal, dispatch)
  exchange.ack({ ...exchange.current(target.pane)!, allowed: false })
  expect(await result).toEqual({ deny: expect.any(String) })
  expect(dispatch).not.toHaveBeenCalled()
})

it("keeps a hook veto and rejects a competing request without replacing the first", async () => {
  const { exchange } = fixture()
  const result = exchange.run(target, new AbortController().signal, async () => ({ deny: "kept" }))
  const request = exchange.current(target.pane)!
  expect(await exchange.run(target, new AbortController().signal, pass)).toEqual({
    deny: expect.any(String)
  })
  expect(exchange.current(target.pane)).toEqual(request)
  exchange.ack({ ...request, allowed: true })
  expect(await result).toEqual({ deny: "kept" })
})

it.each(["pane", "generation", "plugin", "element", "id"] as const)(
  "rejects an acknowledgement with a different %s",
  async (field) => {
    const { exchange } = fixture()
    const controller = new AbortController()
    const result = exchange.run(target, controller.signal, pass)
    const rejected = expect(result).rejects.toThrow()
    expect(() =>
      exchange.ack({ ...exchange.current(target.pane)!, [field]: "foreign", allowed: true })
    ).toThrow("MODS_UI_FOCUS_STALE")
    controller.abort()
    await rejected
  }
)

it.each(["cancel", "drawing", "close"])(
  "settles pending requests on %s without accepting a late acknowledgement",
  async (mode) => {
    const { exchange } = fixture()
    const controller = new AbortController()
    const result = exchange.run(target, controller.signal, pass)
    const rejected = expect(result).rejects.toThrow()
    const request = exchange.current(target.pane)!
    if (mode === "cancel") controller.abort()
    else if (mode === "drawing") exchange.cancel(target.pane)
    else exchange.close()
    await rejected
    expect(exchange.current(target.pane)).toBeUndefined()
    expect(() => exchange.ack({ ...request, allowed: true })).toThrow("MODS_UI_FOCUS_STALE")
  }
)

it("expires a missing renderer response without returning success", async () => {
  vi.useFakeTimers()
  const { exchange } = fixture()
  const result = exchange.run(target, new AbortController().signal, pass)
  const rejected = expect(result).rejects.toThrow("MODS_UI_FOCUS_TIMEOUT")
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(exchange.current(target.pane)).toBeUndefined()
})

it("does not let a hook erase the actual renderer denial", async () => {
  const { exchange } = fixture()
  const result = exchange.run(target, new AbortController().signal, async (apply) => {
    await apply(target)
    return {}
  })
  exchange.ack({ ...exchange.current(target.pane)!, allowed: true })
  await vi.waitFor(() => expect(exchange.current(target.pane)?.phase).toBe("apply"))
  exchange.ack({ ...exchange.current(target.pane)!, allowed: false })
  expect(await result).toEqual({ deny: expect.any(String) })
})

it("expires even while a hook never settles", async () => {
  vi.useFakeTimers()
  const { exchange } = fixture()
  const result = exchange
    .run(target, new AbortController().signal, () => new Promise(() => {}))
    .catch((error: unknown) => error)
  exchange.ack({ ...exchange.current(target.pane)!, allowed: true })
  await vi.advanceTimersByTimeAsync(5000)
  const settled = await Promise.race([result, Promise.resolve("still waiting")])
  expect(settled).toBeInstanceOf(Error)
  expect(String(settled)).toContain("MODS_UI_FOCUS_TIMEOUT")
  expect(exchange.current(target.pane)).toBeUndefined()
})

it("does not request a physical move until middleware has returned its final verdict", async () => {
  const { exchange } = fixture()
  let returned = false
  const result = exchange.run(target, new AbortController().signal, async (select) => {
    await select(target)
    returned = true
    return { deny: "keep original focus" }
  })
  void result.catch(() => {})
  exchange.ack({ ...exchange.current(target.pane)!, allowed: true })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(returned).toBe(true)
  expect(exchange.current(target.pane)).toBeUndefined()
  expect(await result).toEqual({ deny: "keep original focus" })
})

it("retains the probe identity while middleware is pending so refresh cannot lose ownership", async () => {
  const { exchange } = fixture()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = exchange.run(target, new AbortController().signal, async (select) => {
    await waiting
    return select(target)
  })
  void result.catch(() => {})
  const request = exchange.current(target.pane)!
  exchange.ack({ ...request, allowed: true })
  await Promise.resolve()
  expect(exchange.current(target.pane)).toEqual(request)
  release()
  await vi.waitFor(() => expect(exchange.current(target.pane)?.phase).toBe("apply"))
  exchange.ack({ ...exchange.current(target.pane)!, allowed: true })
  expect(await result).toEqual({})
})

it("does not enter a queued focus hook after its request was cancelled", async () => {
  const { exchange } = fixture()
  const controller = new AbortController()
  const operation = vi.fn(pass)
  const result = exchange.run(target, controller.signal, operation)
  const rejected = expect(result).rejects.toThrow()
  exchange.ack({ ...exchange.current(target.pane)!, allowed: true })
  await Promise.resolve()
  controller.abort()
  await rejected
  expect(operation).not.toHaveBeenCalled()
})

it("treats an empty deny string as a veto before any physical focus request", async () => {
  const { exchange } = fixture()
  const controller = new AbortController()
  const result = exchange.run(target, controller.signal, async (select) => {
    await select(target)
    return { deny: "" }
  })
  const settled = result.catch((error: unknown) => error)
  exchange.ack({ ...exchange.current(target.pane)!, allowed: true })
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(exchange.current(target.pane)).toBeUndefined()
    expect(await settled).toEqual({ deny: "" })
  } finally {
    controller.abort()
    await settled
  }
})
