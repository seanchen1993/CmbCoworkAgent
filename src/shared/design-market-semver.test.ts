import { describe, expect, it } from "vitest"
import {
  compareSemVer,
  formatCompatibilityRange,
  formatMarketVersion,
  isHigherSemVer,
  isSystemVersionCompatible,
  normalizeSemVer,
  parseSemVer,
  pickLatestCompatibleVersion
} from "./design-market-semver"

describe("design-market-semver", () => {
  it("parses and normalizes only stable SemVer strings", () => {
    expect(parseSemVer("v1.2.0")).toEqual({ major: 1, minor: 2, patch: 0 })
    expect(normalizeSemVer("1.2.3")).toBe("1.2.3")
    expect(formatMarketVersion("v0.2.3")).toBe("v0.2.3")

    expect(() => normalizeSemVer("1.2")).toThrow()
    expect(() => normalizeSemVer("01.2.0")).toThrow()
    expect(() => normalizeSemVer("1.2.0-beta.1")).toThrow()
    expect(() => normalizeSemVer("1.2.0+build")).toThrow()
  })

  it("compares numeric segments properly", () => {
    expect(compareSemVer("1.10.0", "1.2.0")).toBe(1)
    expect(compareSemVer("v1.2.0", "1.2.0")).toBe(0)
    expect(isHigherSemVer("2.0.0", "1.99.99")).toBe(true)
    expect(isHigherSemVer("1.2.0", "1.2.0")).toBe(false)
  })

  it("enforces major >= 1 and 0.x minor compatibility bounds", () => {
    expect(isSystemVersionCompatible("1.2.0", "1.2.0")).toBe(true)
    expect(isSystemVersionCompatible("1.2.1", "1.2.0")).toBe(true)
    expect(isSystemVersionCompatible("1.9.0", "1.2.0")).toBe(true)
    expect(isSystemVersionCompatible("1.1.9", "1.2.0")).toBe(false)
    expect(isSystemVersionCompatible("2.0.0", "1.2.0")).toBe(false)

    expect(isSystemVersionCompatible("0.2.3", "0.2.3")).toBe(true)
    expect(isSystemVersionCompatible("0.2.8", "0.2.3")).toBe(true)
    expect(isSystemVersionCompatible("0.2.2", "0.2.3")).toBe(false)
    expect(isSystemVersionCompatible("0.3.0", "0.2.3")).toBe(false)
    expect(isSystemVersionCompatible("1.0.0", "0.2.3")).toBe(false)
  })

  it("formats compatibility range and selects highest compatible version", () => {
    expect(formatCompatibilityRange("1.2.0")).toBe("v1.2.0 及以上，低于 v2.0.0")
    expect(formatCompatibilityRange("0.2.3")).toBe("v0.2.3 及以上，低于 v0.3.0")

    const picked = pickLatestCompatibleVersion(
      [{ v: "1.0.0" }, { v: "1.2.0" }, { v: "1.4.2" }, { v: "2.0.0" }],
      (item) => item.v,
      "1.2.0"
    )
    expect(picked?.v).toBe("1.4.2")
  })
})
