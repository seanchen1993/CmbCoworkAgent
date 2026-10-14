import { afterEach, expect, it, vi } from "vitest"
import { ChatTransientToasts } from "./chat-transient-toasts"
import type { ExternalToast } from "sonner"

const active: ChatTransientToasts[] = []
afterEach(() => {
  for (const queue of active.splice(0)) queue.close()
  vi.useRealTimers()
})
function fixture(thread = "thread") {
  const show = vi.fn().mockImplementation((_kind, _text, options) => options.id)
  const dismiss = vi.fn()
  const queue = new ChatTransientToasts(thread, crypto.randomUUID(), {
    show,
    dismiss,
    originalIds: (owner) =>
      show.mock.calls
        .filter((call) => call[2].className?.includes(`devclaw-original-${owner}`))
        .map((call) => call[2].id ?? "original")
  })
  active.push(queue)
  queue.present(true, false, false, false)
  return { queue, show, dismiss }
}
it.each([Infinity, 1000])(
  "same public id transfers from original duration %s to queued presentation",
  (duration) => {
    const f = fixture(),
      onDismiss = vi.fn(),
      onAutoClose = vi.fn()
    const original = duration === Infinity ? { duration } : { duration, toasterId: "foreign" }
    f.queue.show("info", "original", { id: "same", ...original, onDismiss, onAutoClose })
    f.queue.present(true, true, false, false)
    f.queue.show("success", "queued replacement", { id: "same", duration: 200 })
    expect(f.dismiss).toHaveBeenCalledExactlyOnceWith("same")
    expect(f.queue.pending).toBe(1)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(onAutoClose).not.toHaveBeenCalled()
  }
)
it.each([true, false])(
  "same queued public id transfers to persistent presentation when held=%s",
  (held) => {
    vi.useFakeTimers()
    const f = fixture(),
      onDismiss = vi.fn(),
      onAutoClose = vi.fn()
    f.queue.present(true, held, false, false)
    f.queue.show("info", "old queued", { id: "same", duration: 200, onDismiss, onAutoClose })
    const oldOptions = f.show.mock.calls.at(-1)?.[2] as ExternalToast | undefined
    f.queue.show("success", "persistent replacement", { id: "same", duration: Infinity })
    expect(f.queue.pending).toBe(0)
    oldOptions?.onDismiss?.({ id: "same" })
    f.queue.present(true, false, true, false)
    vi.advanceTimersByTime(1000)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(onAutoClose).not.toHaveBeenCalled()
    expect(f.show.mock.calls.at(-1)?.[2]).toMatchObject({ id: "same", duration: Infinity })
  }
)
it("holds new items longer than duration and admits FIFO only once after release", () => {
  vi.useFakeTimers()
  const f = fixture()
  f.queue.present(true, true, false, false)
  const one = f.queue.show("success", "first", { duration: 200 })
  f.queue.show("error", "second", { duration: 200 })
  vi.advanceTimersByTime(1000)
  expect(f.show).not.toHaveBeenCalled()
  f.queue.present(true, false, false, false)
  expect(f.show).toHaveBeenCalledTimes(1)
  expect(f.show.mock.calls[0][2]).toMatchObject({ duration: Infinity, toasterId: f.queue.owner })
  vi.advanceTimersByTime(1000)
  expect(f.queue.pending).toBe(2)
  f.queue.present(true, false, true, false)
  vi.advanceTimersByTime(201)
  expect(f.show).toHaveBeenCalledTimes(2)
  expect(f.show.mock.calls[1][1]).toBe("second")
  expect(one).toBeTypeOf("string")
})
it("pauses existing shown item for hold, hiding and hover without recreate or reset", () => {
  vi.useFakeTimers()
  const f = fixture()
  f.queue.show("success", "first", { duration: 200 })
  f.queue.present(true, false, true, false)
  vi.advanceTimersByTime(50)
  f.queue.present(true, true, false, false)
  vi.advanceTimersByTime(1000)
  f.queue.present(false, false, false, false)
  vi.advanceTimersByTime(1000)
  f.queue.present(true, false, true, true)
  vi.advanceTimersByTime(1000)
  expect(f.queue.pending).toBe(1)
  f.queue.present(true, false, true, false)
  vi.advanceTimersByTime(150)
  expect(f.queue.pending).toBe(0)
  expect(f.show).toHaveBeenCalledTimes(1)
})
it("preserves public ids/options, updates queued id without duplicate and dismisses without Sonner", () => {
  const f = fixture(),
    onDismiss = vi.fn()
  f.queue.present(true, true, false, false)
  expect(f.queue.show("info", "old", { id: 12, onDismiss })).toBe(12)
  expect(f.queue.show("warning", "updated", { id: 12, onDismiss, description: "details" })).toBe(12)
  expect(f.queue.pending).toBe(1)
  f.queue.dismiss(12)
  f.queue.present(true, false, false, false)
  expect(f.show).not.toHaveBeenCalled()
  expect(f.dismiss).not.toHaveBeenCalled()
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: 12, title: "updated" })
  )
})
it("auto close and late native onDismiss never replay user callback", () => {
  vi.useFakeTimers()
  const f = fixture(),
    onDismiss = vi.fn(),
    onAutoClose = vi.fn()
  f.queue.show("success", "first", { id: "caller-id", duration: 200, onDismiss, onAutoClose })
  const options = f.show.mock.calls[0][2] as ExternalToast
  expect(options.id).not.toBe("caller-id")
  f.queue.present(true, false, true, false)
  vi.advanceTimersByTime(201)
  options.onDismiss?.({ id: options.id! })
  expect(onAutoClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "caller-id" }))
  expect(onDismiss).not.toHaveBeenCalled()
})
it("updated submitted callback is the only callback retained", () => {
  const f = fixture(),
    old = vi.fn(),
    current = vi.fn()
  f.queue.show("info", "old", { id: 1, onDismiss: old })
  const oldOptions = f.show.mock.calls[0][2] as ExternalToast
  f.queue.show("info", "new", { id: 1, onDismiss: current })
  oldOptions.onDismiss?.({ id: oldOptions.id! })
  expect(f.queue.pending).toBe(1)
  f.queue.dismiss(1)
  expect(old).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledTimes(1)
})
it("persistent and foreign Toaster options keep original global behavior", () => {
  const f = fixture()
  f.queue.show("error", "pinned", { duration: Infinity })
  f.queue.show("warning", "foreign", { toasterId: "global-owned" })
  expect(f.show.mock.calls[0][2]).toMatchObject({ duration: Infinity })
  expect(f.show.mock.calls[1][2]).toMatchObject({ toasterId: "global-owned" })
  expect(f.queue.pending).toBe(0)
})

it("persistent original-path cancellation routes only the owner's actual native ids", () => {
  const f = fixture()
  f.queue.show("warning", "persistent", { id: "original", duration: Infinity })
  f.queue.dismiss("foreign-id")
  expect(f.dismiss).not.toHaveBeenCalled()
  f.queue.dismiss("original")
  expect(f.dismiss).toHaveBeenCalledExactlyOnceWith("original")
})

it("action and cancel release FIFO with original preventDefault semantics and no invented dismiss callback", () => {
  const f = fixture(),
    onDismiss = vi.fn(),
    clicked = vi.fn()
  f.queue.show("info", "action", { id: 1, onDismiss, action: { label: "Run", onClick: clicked } })
  f.queue.show("info", "next", { id: 2 })
  const options = f.show.mock.calls[0][2] as ExternalToast
  const action = options.action as { onClick(event: unknown): void }
  action.onClick({ defaultPrevented: true })
  expect(f.queue.pending).toBe(2)
  action.onClick({ defaultPrevented: false })
  expect(f.queue.pending).toBe(1)
  expect(f.show).toHaveBeenCalledTimes(2)
  expect(onDismiss).not.toHaveBeenCalled()
  expect(clicked).toHaveBeenCalledTimes(2)
})

it("a shown source cannot consume its FIFO successor's clock before successor presentation", () => {
  vi.useFakeTimers()
  const f = fixture()
  f.queue.show("info", "first", { id: 1, duration: 200 })
  f.queue.show("info", "next", { id: 2, duration: 200 })
  f.queue.present(true, false, true, false)
  const first = f.queue.activeId
  f.queue.dismiss(1)
  expect(f.queue.activeId).not.toBe(first)
  vi.advanceTimersByTime(1000)
  expect(f.queue.pending).toBe(1)
  f.queue.present(true, false, true, false)
  vi.advanceTimersByTime(200)
  expect(f.queue.pending).toBe(0)
})
it("bounds per-thread and renderer-wide retention and drops stale owners without replay", () => {
  const all = Array.from({ length: 5 }, (_, index) => fixture(String(index)))
  for (const f of all) {
    f.queue.present(true, true, false, false)
    for (let index = 0; index < 50; index++) f.queue.show("info", `line${index}`)
    expect(f.queue.pending).toBeLessThanOrEqual(40)
  }
  expect(all.reduce((sum, f) => sum + f.queue.pending, 0)).toBeLessThanOrEqual(160)
  all[0].queue.close()
  all[0].queue.show("info", "late")
  expect(all[0].show).not.toHaveBeenCalled()
})
it("bounds multibyte queued text while keeping newest updates", () => {
  const f = fixture()
  f.queue.present(true, true, false, false)
  for (let index = 0; index < 40; index++) f.queue.show("info", "界".repeat(10000))
  expect(f.queue.pending).toBeLessThanOrEqual(17)
  expect(f.show).not.toHaveBeenCalled()
})

it("does not admit until a mounted owner has supplied actual initial presentation", () => {
  const show = vi.fn(),
    dismiss = vi.fn()
  const queue = new ChatTransientToasts("new-owner", "owner", { show, dismiss })
  active.push(queue)
  queue.show("info", "first")
  expect(show).not.toHaveBeenCalled()
})

it("never resubmits an active row removed by aggregate bounds during its update", () => {
  const f = fixture()
  f.queue.show("info", "old", { id: "old" })
  f.queue.present(true, true, false, false)
  for (let index = 0; index < 4; index++) f.queue.show("info", "x".repeat(100 * 1024))
  const count = f.show.mock.calls.length
  f.queue.show("info", "x".repeat(400 * 1024), { id: "old" })
  expect(f.show).toHaveBeenCalledTimes(count)
})

it("dismiss all consumes pending rows without submitting any canceled successor", () => {
  const f = fixture()
  f.queue.show("info", "one")
  f.queue.show("info", "two")
  f.queue.show("info", "three")
  f.queue.dismiss()
  expect(f.show).toHaveBeenCalledTimes(1)
  expect(f.queue.pending).toBe(0)
})
