import { expect, it } from "vitest"
import { desktopSoakOptions, qualifiesDesktopSoak } from "../support/mods-desktop-soak-options"

it("requires two actual hours and ten thousand completed desktop events", () => {
  const options = desktopSoakOptions({})
  expect(options).toEqual({ smoke: false, durationMs: 7200000, events: 10000, reloadEvery: 250 })
  expect(qualifiesDesktopSoak(options, 7200000, 10000)).toBe(true)
  expect(qualifiesDesktopSoak(options, 7199999, 10000)).toBe(false)
  expect(qualifiesDesktopSoak(options, 7200000, 9999)).toBe(false)
})

it("marks reduced functional runs as smoke even after enough time has elapsed", () => {
  const options = desktopSoakOptions({ smoke: "1" })
  expect(options).toEqual({ smoke: true, durationMs: 10000, events: 24, reloadEvery: 8 })
  expect(qualifiesDesktopSoak(options, 7200000, 10000)).toBe(false)
  expect(() => desktopSoakOptions({ smoke: "false" })).toThrow()
})

it("does not qualify malformed elapsed time or event evidence", () => {
  const options = desktopSoakOptions({})
  expect(qualifiesDesktopSoak(options, Infinity, 10000)).toBe(false)
  expect(qualifiesDesktopSoak(options, 7200000, Infinity)).toBe(false)
  expect(qualifiesDesktopSoak(options, 7200000, 10000.5)).toBe(false)
})
