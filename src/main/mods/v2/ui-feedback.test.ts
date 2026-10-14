import { afterEach, expect, it, vi } from "vitest"
import { FunctionUiFeedback } from "./ui-feedback"

afterEach(() => vi.useRealTimers())

it("keeps an unpresented toast queued beyond its duration", () => {
  vi.useFakeTimers()
  const feedback = new FunctionUiFeedback(() => {})
  feedback.set("one", "ui.toast", { text: "not yet seen", timeoutMs: 200 })
  vi.advanceTimersByTime(1000)
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["not yet seen"])
  feedback.close()
})

it("replaces and clears only the caller status while preserving other plugins", () => {
  const feedback = new FunctionUiFeedback(() => {})
  feedback.set("one", "ui.status", { text: "first" })
  feedback.set("two", "ui.status", { text: "other" })
  feedback.set("one", "ui.status", { text: "last" })
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["last", "other"])
  feedback.set("one", "ui.status", {})
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["other"])
  feedback.close()
})

it("expires toasts without polling and never expires pinned status", () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const feedback = new FunctionUiFeedback(changed)
  feedback.set("one", "ui.status", { text: "pinned" })
  feedback.set("one", "ui.toast", { text: "temporary", timeoutMs: 200 })
  feedback.present(
    feedback
      .snapshot()
      .filter((row) => row.kind === "toast")
      .map((row) => row.id),
    [],
    [],
    false
  )
  vi.advanceTimersByTime(250)
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["pinned"])
  expect(changed).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  feedback.close()
})

it("pauses all callers for hold, hiding and hovering without resetting remaining time", () => {
  vi.useFakeTimers()
  const feedback = new FunctionUiFeedback(() => {})
  feedback.set("one", "ui.toast", { text: "first", timeoutMs: 200 })
  feedback.set("two", "ui.toast", { text: "second", timeoutMs: 200 })
  const ids = feedback.snapshot().map((row) => row.id)
  feedback.present(ids, [], [], false)
  vi.advanceTimersByTime(50)
  feedback.present(ids, [], [], true)
  vi.advanceTimersByTime(1000)
  expect(feedback.snapshot()).toHaveLength(2)
  feedback.present(ids, [ids[0]], [], false)
  vi.advanceTimersByTime(151)
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["first"])
  feedback.present([ids[0]], [], [], false)
  vi.advanceTimersByTime(100)
  feedback.pause()
  vi.advanceTimersByTime(1000)
  expect(feedback.snapshot()).toHaveLength(1)
  feedback.present([ids[0]], [], [], false)
  vi.advanceTimersByTime(51)
  expect(feedback.snapshot()).toEqual([])
  feedback.close()
})

it("dismisses only transient ids and never removes pinned status", () => {
  const feedback = new FunctionUiFeedback(() => {})
  feedback.set("one", "ui.status", { text: "pinned" })
  feedback.set("one", "ui.toast", { text: "first" })
  feedback.set("two", "ui.toast", { text: "second" })
  const rows = feedback.snapshot()
  feedback.present([], [], [rows[0].id, rows[1].id], true)
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["pinned", "second"])
  feedback.close()
})

it("zero duration waits until its first presentation and expires without polling", () => {
  vi.useFakeTimers()
  const feedback = new FunctionUiFeedback(() => {})
  feedback.set("one", "ui.toast", { text: "zero", timeoutMs: 0 })
  vi.advanceTimersByTime(100)
  expect(feedback.snapshot()).toHaveLength(1)
  feedback.present([feedback.snapshot()[0].id], [], [], false)
  vi.advanceTimersByTime(1)
  expect(feedback.snapshot()).toEqual([])
  feedback.close()
})

it("bounds burst output by caller and coalesces notifications without starving the last update", () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const feedback = new FunctionUiFeedback(changed)
  for (let i = 0; i < 100; i++) feedback.set("one", "ui.toast", { text: `toast ${i}` })
  feedback.set("two", "ui.toast", { text: "other" })
  expect(feedback.snapshot()).toHaveLength(5)
  vi.advanceTimersByTime(50)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(feedback.snapshot().map((row) => row.text)).toContain("toast 99")
  feedback.close()
  expect(feedback.snapshot()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  expect(() => feedback.set("one", "ui.status", { text: "late" })).toThrow("CLOSED")
})

it.each([
  ["ui.toast", { text: "x", timeoutMs: -1 }],
  ["ui.toast", { text: "x", timeoutMs: Number.NaN }],
  ["ui.toast", { text: "x", timeoutMs: 60001 }],
  ["ui.status", { text: 1 }],
  ["ui.status", { text: "x", plugin: "victim" }],
  ["ui.toast", { text: [] }]
])("rejects invalid %s output without modifying the snapshot", (method, value) => {
  const feedback = new FunctionUiFeedback(() => {})
  expect(() => feedback.set("one", method as "ui.toast", value)).toThrow()
  expect(feedback.snapshot()).toEqual([])
  feedback.close()
})

it("bounds UTF-8 publication size while retaining pinned status under a multibyte burst", () => {
  const feedback = new FunctionUiFeedback(() => {})
  for (let plugin = 0; plugin < 8; plugin++) {
    feedback.set(String(plugin), "ui.status", { text: "界".repeat(10000) })
    for (let i = 0; i < 4; i++)
      feedback.set(String(plugin), "ui.toast", { text: "界".repeat(10000) })
  }
  const rows = feedback.snapshot()
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(512 * 1024)
  expect(rows.filter((row) => row.kind === "status")).toHaveLength(8)
  feedback.close()
})

it("accepts long feedback and stores a bounded well-formed display copy", () => {
  const feedback = new FunctionUiFeedback(() => {})
  const text = `${"x".repeat(9999)}🙂${"界".repeat(20000)}`
  feedback.set("one", "ui.status", { text })
  feedback.set("two", "ui.toast", { text })
  expect(feedback.snapshot().map(row => row.text))
    .toEqual([`${"x".repeat(9999)}\uFFFD`, `${"x".repeat(9999)}\uFFFD`])
  expect(text).toHaveLength(30001)
  feedback.set("one", "ui.status", {})
  expect(feedback.snapshot()).toHaveLength(1)
  feedback.close()
})
