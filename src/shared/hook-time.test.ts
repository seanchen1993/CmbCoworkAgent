import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

let hookTime: typeof import("./hook-time")
const originalTimeZone = process.env.TZ

beforeAll(async () => {
  // Load the module while the host uses a non-Beijing timezone. A formatter
  // that accidentally falls back to OS-local time will fail these assertions.
  process.env.TZ = "America/New_York"
  vi.resetModules()
  hookTime = await import("./hook-time")
})

afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimeZone
  vi.resetModules()
})

describe("Hook fixed Beijing time", () => {
  it("formats UTC timestamps as UTC+8 regardless of the host timezone", () => {
    const timestamp = "2026-08-26T01:02:03.000Z"

    expect(hookTime.formatHookDateTime(timestamp)).toBe("2026-08-26 09:02:03")
    expect(hookTime.formatHookClockTime(timestamp)).toBe("09:02:03")
    expect(hookTime.HOOK_TIME_ZONE).toBe("Asia/Shanghai")
    expect(hookTime.HOOK_TIME_ZONE_LABEL).toContain("UTC+8")
  })

  it("treats UTC and explicit +08:00 timestamps for the same instant equally", () => {
    expect(hookTime.formatHookDateTime("2026-08-26T01:02:03.000Z")).toBe(
      hookTime.formatHookDateTime("2026-08-26T09:02:03.000+08:00")
    )
    expect(hookTime.formatHookDateTime("2026-08-26T01:02:03.123456Z")).toBe(
      "2026-08-26 09:02:03"
    )
  })

  it("interprets timezone-less legacy Hook timestamps as Beijing time", () => {
    expect(hookTime.formatHookDateTime("2026-08-26T09:02:03")).toBe("2026-08-26 09:02:03")
    expect(hookTime.formatHookDateTime("2026-08-26 09:02:03")).toBe("2026-08-26 09:02:03")
    expect(hookTime.formatHookDateTime("2026-08-26")).toBe("2026-08-26 00:00:00")
  })

  it("switches the Hook calendar date exactly at Beijing midnight", () => {
    expect(hookTime.getHookDateKey("2026-08-25T15:59:59.999Z")).toBe("2026-08-25")
    expect(hookTime.getHookDateKey("2026-08-25T16:00:00.000Z")).toBe("2026-08-26")
    expect(hookTime.formatHookClockTime("2026-08-25T16:00:00.000Z")).toBe("00:00:00")
  })

  it("keeps UTC+8 in winter, summer, and across the year boundary", () => {
    expect(hookTime.formatHookDateTime("2026-01-15T00:00:00.000Z")).toBe("2026-01-15 08:00:00")
    expect(hookTime.formatHookDateTime("2026-07-15T00:00:00.000Z")).toBe("2026-07-15 08:00:00")
    expect(hookTime.formatHookDateTime("2026-12-31T16:00:00.000Z")).toBe("2027-01-01 00:00:00")
  })

  it("does not display invalid timestamps as a valid local time", () => {
    expect(hookTime.formatHookDateTime("not-a-date")).toBeNull()
    expect(hookTime.formatHookClockTime(new Date(Number.NaN))).toBeNull()
    expect(() => hookTime.getHookDateKey("not-a-date")).toThrow(RangeError)
  })
})
