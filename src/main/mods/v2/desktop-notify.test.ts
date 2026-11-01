import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import { FunctionDesktopNotifications } from "./desktop-notify"

class Handle extends EventEmitter {
  show = vi.fn()
  close = vi.fn()
}
function fixture() {
  const handle = new Handle()
  const create = vi.fn(() => handle)
  const notifier = new FunctionDesktopNotifications({ isSupported: () => true, create })
  const lifetime = new AbortController()
  const context = {
    signal: new AbortController().signal,
    lifetime: lifetime.signal,
    enabled: () => true,
    assertLive() { /* The fixture retains authority until teardown. */ }
  }
  return { handle, create, notifier, context, lifetime }
}

it("resolves only on actual OS show and closes visible notifications on revocation", async () => {
  const f = fixture()
  const pending = f.notifier.show("source", { text: "ready" }, f.context)
  expect(f.handle.show).toHaveBeenCalledOnce()
  f.handle.emit("show")
  expect(await pending).toEqual({ isSent: true, channel: "desktop" })
  f.lifetime.abort(Error("revoked"))
  expect(f.handle.close).toHaveBeenCalledOnce()
  expect(f.handle.listenerCount("show")).toBe(0)
})

it("reports OS failure, disabled preferences and cancellation before any success", async () => {
  const f = fixture()
  const pending = f.notifier.show("source", { text: "ready" }, f.context)
  f.handle.emit("failed")
  expect(await pending).toEqual({ isSent: false, reason: "failed" })
  expect(
    await f.notifier.show("source", { text: "ready" }, { ...f.context, enabled: () => false })
  ).toEqual({ isSent: false, reason: "disabled" })
  expect(f.create).toHaveBeenCalledOnce()
  const g = fixture()
  const cancelled = g.notifier.show("source", { text: "ready" }, g.context)
  g.lifetime.abort(Error("revoked"))
  await expect(cancelled).rejects.toThrow("revoked")
  expect(g.handle.close).toHaveBeenCalledOnce()
})

it("closing the preference settles a pending receipt and removes listeners", async () => {
  const f = fixture()
  const pending = f.notifier.show("source", { text: "ready" }, f.context)
  f.notifier.close()
  expect(await pending).toEqual({ isSent: false, reason: "disabled" })
  expect(f.handle.eventNames()).toEqual([])
  expect(f.handle.close).toHaveBeenCalledOnce()
})

it("reports native construction failure instead of leaving a pending receipt", async () => {
  const f = fixture()
  const notifier = new FunctionDesktopNotifications({
    isSupported: () => true,
    create: () => {
      throw Error("OS unavailable")
    }
  })
  expect(await notifier.show("source", { text: "ready" }, f.context)).toEqual({
    isSent: false,
    reason: "failed"
  })
})
