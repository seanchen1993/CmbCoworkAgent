import { describe, expect, it } from "vitest"
import { resolveOperationsPeriod } from "./project-operations-period"

describe("Shanghai calendar periods", () => {
  it("starts weeks on Monday at local midnight, even across a year boundary", () => {
    expect(resolveOperationsPeriod({ kind: "week", anchorDate: "2026-01-01" })).toEqual({
      kind: "week",
      label: "2025-12-29 — 2026-01-04",
      timezone: "Asia/Shanghai",
      from: "2025-12-28T16:00:00.000Z",
      toExclusive: "2026-01-04T16:00:00.000Z"
    })
    expect(resolveOperationsPeriod({ kind: "week", anchorDate: "2026-01-04" }).from).toBe(
      "2025-12-28T16:00:00.000Z"
    )
  })
  it("uses calendar month boundaries, including leap years", () => {
    expect(resolveOperationsPeriod({ kind: "month", month: "2024-02" })).toMatchObject({
      from: "2024-01-31T16:00:00.000Z",
      toExclusive: "2024-02-29T16:00:00.000Z"
    })
    expect(resolveOperationsPeriod({ kind: "month", month: "2026-12" }).toExclusive).toBe(
      "2026-12-31T16:00:00.000Z"
    )
  })
  it.each(["2026-02-29", "2026-13-01", "2026-1-1", "bad"])(
    "rejects invalid dates %s",
    (anchorDate) => {
      expect(() => resolveOperationsPeriod({ kind: "week", anchorDate })).toThrow("有效")
    }
  )
})
