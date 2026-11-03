import { describe, expect, it } from "vitest"
import { getIdleModelServiceWindow } from "./idle-model-service-window"

describe("idle model service window in Beijing time", () => {
  it.each([
    ["2026-11-03T06:59:59.999+08:00", true, "2026-11-03T07:00:00+08:00"],
    ["2026-11-03T07:00:00+08:00", false, "2026-11-03T22:00:00+08:00"],
    ["2026-11-03T12:00:00+08:00", false, "2026-11-03T22:00:00+08:00"],
    ["2026-11-03T21:59:59.999+08:00", false, "2026-11-03T22:00:00+08:00"],
    ["2026-11-03T22:00:00+08:00", true, "2026-11-04T07:00:00+08:00"],
    ["2026-12-31T23:59:59+08:00", true, "2027-01-01T07:00:00+08:00"],
    ["2027-01-01T00:00:00+08:00", true, "2027-01-01T07:00:00+08:00"]
  ])("evaluates %s independently of the machine's time zone", (time, available, next) => {
    expect(getIdleModelServiceWindow(Date.parse(time))).toEqual({
      available,
      nextChangeAt: Date.parse(next)
    })
  })

  it("treats equivalent UTC and local timestamps identically", () => {
    expect(getIdleModelServiceWindow(Date.parse("2026-11-03T14:00:00Z"))).toEqual(
      getIdleModelServiceWindow(Date.parse("2026-11-03T22:00:00+08:00"))
    )
  })
})
