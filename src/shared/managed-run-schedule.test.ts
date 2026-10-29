import { describe, expect, it } from "vitest"
import { nextManagedRunScheduleTime, parseManagedRunScheduleTime } from "./managed-run-schedule"

describe("managed schedule time in GMT+8", () => {
  it("defaults to the next 22:00 including after midnight", () => {
    expect(nextManagedRunScheduleTime(new Date("2026-10-28T10:00:00Z"))).toBe("2026-10-28 22:00:00")
    expect(nextManagedRunScheduleTime(new Date("2026-10-28T14:00:00Z"))).toBe("2026-10-29 22:00:00")
    expect(nextManagedRunScheduleTime(new Date("2026-10-28T17:00:00Z"))).toBe("2026-10-29 22:00:00")
  })
  it("parses GMT+8 independently of the host timezone and rejects invalid dates", () => {
    expect(parseManagedRunScheduleTime("2026-10-28 22:00:00")).toBe(
      Date.parse("2026-10-28T14:00:00Z")
    )
    for (const value of ["", "2026-02-30 22:00:00", "2026-10-28T22:00:00", "2026-10-28 25:00:00"]) {
      expect(parseManagedRunScheduleTime(value)).toBeNaN()
    }
  })
})
