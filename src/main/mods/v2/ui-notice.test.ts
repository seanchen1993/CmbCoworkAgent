import { afterEach, expect, it, vi } from "vitest"
import { FunctionUiNotices, type FunctionNoticeDialog } from "./ui-notice"

const disposables: FunctionUiNotices[] = []
afterEach(() => {
  for (const value of disposables.splice(0)) value.close()
  vi.useRealTimers()
})
function fixture(owner?: string) {
  let dialog: FunctionNoticeDialog | undefined = { toolUseId: "call", requestId: "request", owner }
  let removed: ((requestId: string) => void) | undefined
  const unsubscribe = vi.fn()
  const changed = vi.fn()
  const notices = new FunctionUiNotices(
    {
      lookup: (id) => (id === dialog?.toolUseId ? dialog : undefined),
      subscribeClosed: (listener) => {
        removed = listener
        return unsubscribe
      }
    },
    changed
  )
  disposables.push(notices)
  const set = (plugin: string, text?: string) => {
    const ticket = notices.reserve(plugin, "call")
    try {
      notices.commit(ticket, text)
    } finally {
      notices.release(ticket)
    }
  }
  return {
    notices,
    set,
    changed,
    unsubscribe,
    remove() {
      dialog = undefined
      removed?.("request")
    }
  }
}
it("only an open native dialog can receive a notice from its owning plugin", () => {
  const f = fixture("function:alpha")
  expect(() => f.notices.reserve("beta", "call")).toThrow("MODS_UI_NOTICE_OWNER")
  expect(() => f.notices.reserve("alpha", "unknown")).toThrow("MODS_UI_NOTICE_CLOSED")
  f.set("alpha", "Context")
  expect(f.notices.snapshot()).toMatchObject([
    { plugin: "alpha", requestId: "request", toolUseId: "call", text: "Context" }
  ])
  f.remove()
  expect(f.notices.snapshot()).toEqual([])
  expect(() => f.notices.reserve("alpha", "call")).toThrow("MODS_UI_NOTICE_CLOSED")
})
it("keeps separate plugin lines on a model dialog and undefined clears only the caller", () => {
  const f = fixture()
  f.set("alpha", "One")
  f.set("beta", "Two")
  f.set("alpha")
  expect(f.notices.snapshot()).toMatchObject([{ plugin: "beta", text: "Two" }])
})
it("does not let a slow earlier publication overwrite a newer notice", () => {
  const f = fixture()
  const first = f.notices.reserve("alpha", "call")
  const second = f.notices.reserve("alpha", "call")
  f.notices.commit(second, "New")
  f.notices.commit(first, "Old")
  f.notices.release(first)
  f.notices.release(second)
  expect(f.notices.snapshot()).toMatchObject([{ text: "New" }])
})
it("rejects publication after dialog settlement or caller cancellation", () => {
  const f = fixture()
  const ticket = f.notices.reserve("alpha", "call")
  expect(() =>
    f.notices.commit(ticket, "Cancelled", () => {
      throw Error("cancelled")
    })
  ).toThrow("cancelled")
  expect(f.notices.snapshot()).toEqual([])
  f.remove()
  expect(() => f.notices.commit(ticket, "Late")).toThrow("MODS_UI_NOTICE_CLOSED")
  f.notices.release(ticket)
})
it("bounds pending notices and removes listener and notification timers on close", () => {
  vi.useFakeTimers()
  const f = fixture()
  const tickets = Array.from({ length: 32 }, () => f.notices.reserve("alpha", "call"))
  expect(() => f.notices.reserve("alpha", "call")).toThrow("MODS_UI_NOTICE_CAPACITY")
  f.notices.commit(tickets[0], "Text")
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  f.notices.close()
  expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(() => f.notices.reserve("alpha", "call")).toThrow("MODS_SESSION_CLOSED")
})
