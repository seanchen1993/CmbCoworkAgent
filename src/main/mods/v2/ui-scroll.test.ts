import { afterEach, expect, it, vi } from "vitest"
import { FunctionScrollRequests } from "./ui-scroll"

const address = { pane: "demo:board", generation: "drawing", plugin: "demo", requestId: "board" }
const args = { to: "end", in: "board" } as const
const geometry = { height: 100, content: 1000, top: 200, row: 20, width: 500 }
const exchanges: FunctionScrollRequests[] = []
afterEach(() => {
  for (const exchange of exchanges.splice(0)) exchange.close()
  vi.useRealTimers()
})
function fixture() {
  const assertLive = vi.fn()
  const exchange = new FunctionScrollRequests({ assertLive, changed: vi.fn() })
  exchanges.push(exchange)
  const acknowledge = (allowed = true) => {
    const request = exchange.current(address.pane)!
    exchange.ack({
      pane: address.pane,
      generation: address.generation,
      id: request.id,
      phase: request.phase,
      allowed,
      ...(request.phase === "probe" && allowed ? { geometry } : {})
    })
  }
  return { exchange, assertLive, acknowledge }
}
it("derives the pinned event from actual geometry and waits for actual apply acknowledgement", async () => {
  const f = fixture()
  let finished = false
  const result = f.exchange
    .run(address, args, new AbortController().signal, async (input, select) => {
      expect(input).toEqual({
        component: "Pane",
        requestId: "board",
        offset: 45,
        by: 35,
        bodyRows: 5,
        contentRows: 50,
        origin: { kind: "plugin", name: "demo" }
      })
      return select(1000)
    })
    .then((value) => {
      finished = true
      return value
    })
  f.acknowledge()
  await vi.waitFor(() => expect(f.exchange.current(address.pane)?.phase).toBe("apply"))
  expect(f.exchange.current(address.pane)?.offset).toBe(45)
  expect(finished).toBe(false)
  f.acknowledge()
  expect(await result).toEqual({})
  expect(f.exchange.current(address.pane)).toBeUndefined()
})
it.each(["stop", ""])("does not move after a final hook veto %j", async (deny) => {
  const f = fixture()
  const result = f.exchange.run(
    address,
    args,
    new AbortController().signal,
    async (_input, select) => {
      await select(10)
      return { deny }
    }
  )
  f.acknowledge()
  expect(await result).toEqual({ deny })
  expect(f.exchange.current(address.pane)).toBeUndefined()
})
it("cannot invent a successful result without selecting or against a renderer denial", async () => {
  const f = fixture()
  const skipped = f.exchange.run(address, args, new AbortController().signal, async () => ({}))
  f.acknowledge()
  expect(await skipped).toEqual({ deny: expect.any(String) })
  const refused = f.exchange.run(
    address,
    args,
    new AbortController().signal,
    async (_input, select) => {
      await select(0)
      return {}
    }
  )
  f.acknowledge()
  await vi.waitFor(() => expect(f.exchange.current(address.pane)?.phase).toBe("apply"))
  f.acknowledge(false)
  expect(await refused).toEqual({ deny: expect.any(String) })
})
it("refuses another pending request and rejects stale or forged acknowledgements", async () => {
  const f = fixture()
  const controller = new AbortController()
  const operation = vi.fn(async () => ({}))
  const result = f.exchange.run(address, args, controller.signal, operation)
  const rejected = expect(result).rejects.toThrow()
  expect(await f.exchange.run(address, args, controller.signal, operation)).toEqual({
    deny: expect.any(String)
  })
  const request = f.exchange.current(address.pane)!
  expect(() =>
    f.exchange.ack({
      pane: address.pane,
      generation: "old",
      id: request.id,
      phase: "probe",
      allowed: true,
      geometry
    })
  ).toThrow("MODS_UI_SCROLL_STALE")
  controller.abort()
  await rejected
  expect(operation).not.toHaveBeenCalled()
})
it.each(["cancel", "redraw", "close"])("invalidates a pending scroll on %s", async (mode) => {
  const f = fixture()
  const controller = new AbortController()
  const result = f.exchange.run(address, args, controller.signal, async () => ({}))
  const rejected = expect(result).rejects.toThrow()
  if (mode === "cancel") controller.abort()
  else if (mode === "redraw") f.exchange.cancel(address.pane)
  else f.exchange.close()
  await rejected
  expect(f.exchange.current(address.pane)).toBeUndefined()
})
it("expires a stalled hook as well as missing renderer replies", async () => {
  vi.useFakeTimers()
  const f = fixture()
  const result = f.exchange.run(
    address,
    args,
    new AbortController().signal,
    () => new Promise(() => {})
  )
  const rejected = expect(result).rejects.toThrow("MODS_UI_SCROLL_TIMEOUT")
  f.acknowledge()
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
})
