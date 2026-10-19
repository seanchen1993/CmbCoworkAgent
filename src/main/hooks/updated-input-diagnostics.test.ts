import { expect, it } from "vitest"
import { HookInputMergeTracker, hookInputMergeNotice } from "./updated-input-diagnostics"
import { mergeUpdatedInput } from "./updated-input"

it("keeps existing deep merge and array replacement while diagnosing only changed overlapping writes", () => {
  const tracker = new HookInputMergeTracker()
  const first = { nested: { path: "private-first", keep: true }, array: [1, 2] }
  expect(tracker.observe("first", first)).toEqual([])
  expect(tracker.observe("same", { nested: { path: "private-first" }, array: [1, 2] })).toEqual([])
  const last = { nested: { path: "private-last" }, array: [2] }
  expect(tracker.observe("last", last).map((row) => row.field)).toEqual(["/nested/path", "/array"])
  expect(mergeUpdatedInput(first, last)).toEqual({
    nested: { path: "private-last", keep: true },
    array: [2]
  })
  expect(hookInputMergeNotice(tracker.diagnostics)).toContain("same → 3. last")
  expect(JSON.stringify(tracker.diagnostics)).not.toMatch(/private-first|private-last/)
})
it("handles parent replacements and empty object merges without prototype or ambiguous path diagnostics", () => {
  const tracker = new HookInputMergeTracker()
  tracker.observe("first", { data: { child: 1 }, empty: {}, "a/b": 1 })
  expect(tracker.observe("second", { data: {}, empty: { child: true } })).toEqual([])
  const rows = tracker.observe("third", { data: null, "a/b": 2 })
  expect(rows.map((row) => row.field)).toEqual(["/data", "/a~1b"])
  expect(tracker.observe("prototype", JSON.parse('{"__proto__":{"x":1}}'))).toEqual([])
  expect(({} as { x?: number }).x).toBeUndefined()
  tracker.observe("nested", { number: { child: 1 } })
  expect(tracker.observe("parent-replacement", { number: 1 }).map((row) => row.field)).toEqual([
    "/number"
  ])
})
it("bounds diagnostic count, field labels, source labels, scan depth and tracked fields", () => {
  const tracker = new HookInputMergeTracker()
  const first = Object.fromEntries(Array.from({ length: 2200 }, (_, index) => [`field${index}`, 1]))
  tracker.observe("first", first)
  tracker.observe(
    "later".repeat(100),
    Object.fromEntries(Object.keys(first).map((key) => [key, 2]))
  )
  expect(tracker.diagnostics).toHaveLength(32)
  expect(tracker.truncated).toBe(true)
  expect(
    tracker.diagnostics.every((row) => row.current.hookId.length <= 160 && row.field.length <= 180)
  ).toBe(true)
  expect((hookInputMergeNotice(tracker.diagnostics) ?? "").length).toBeLessThan(20_000)
})
