import { afterEach, expect, it, vi } from "vitest"
import { FunctionUiFeedback } from "./ui-feedback"

afterEach(() => vi.useRealTimers())

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
  vi.advanceTimersByTime(250)
  expect(feedback.snapshot().map((row) => row.text)).toEqual(["pinned"])
  expect(changed).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
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
  ["ui.toast", { text: "x".repeat(10001) }]
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
