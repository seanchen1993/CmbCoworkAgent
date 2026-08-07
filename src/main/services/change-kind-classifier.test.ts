import { describe, expect, it } from "vitest"
import {
  CHANGE_KIND_NEW_RATIO_THRESHOLD,
  attributeChangeKind,
  classifyChangeKind,
  computeNewRatio,
  normalizeChangeKind,
  normalizeNewRatio
} from "./change-kind-classifier"

describe("computeNewRatio", () => {
  it("returns 1 for a pure insertion (no net deletion)", () => {
    expect(computeNewRatio(40, 0)).toBe(1)
  })

  it("returns the added share when lines were replaced", () => {
    expect(computeNewRatio(30, 10)).toBeCloseTo(0.75)
    expect(computeNewRatio(10, 30)).toBeCloseTo(0.25)
  })

  it("returns 0 when the change only deletes", () => {
    expect(computeNewRatio(0, 12)).toBe(0)
  })

  it("returns null when nothing was touched", () => {
    expect(computeNewRatio(0, 0)).toBeNull()
  })

  it("treats non-finite / negative inputs as zero", () => {
    expect(computeNewRatio(Number.NaN, Number.NaN)).toBeNull()
    expect(computeNewRatio(-5, -5)).toBeNull()
    expect(computeNewRatio(10, -5)).toBe(1)
    expect(computeNewRatio(undefined, 8)).toBe(0)
  })
})

describe("classifyChangeKind", () => {
  it("classifies at or above the threshold as new", () => {
    expect(classifyChangeKind(CHANGE_KIND_NEW_RATIO_THRESHOLD)).toBe("new")
    expect(classifyChangeKind(1)).toBe("new")
  })

  it("classifies below the threshold as legacy", () => {
    expect(classifyChangeKind(CHANGE_KIND_NEW_RATIO_THRESHOLD - 0.01)).toBe("legacy")
    expect(classifyChangeKind(0)).toBe("legacy")
  })

  it("falls back to new when the ratio is absent", () => {
    expect(classifyChangeKind(null)).toBe("new")
  })
})

describe("attributeChangeKind", () => {
  it("labels a rewrite of existing code as legacy", () => {
    // edit_file replacing a 2-line signature with a 2-line one: half the change
    // is removal of prior code.
    expect(attributeChangeKind(2, 2)).toEqual({ newRatio: 0.5, changeKind: "legacy" })
  })

  it("labels appending a new function as new", () => {
    expect(attributeChangeKind(12, 0)).toEqual({ newRatio: 1, changeKind: "new" })
  })

  it("labels a mostly-additive edit as new once past the threshold", () => {
    const { newRatio, changeKind } = attributeChangeKind(90, 10)
    expect(newRatio).toBeCloseTo(0.9)
    expect(changeKind).toBe("new")
  })
})

describe("normalizers", () => {
  it("accepts only known change kinds", () => {
    expect(normalizeChangeKind("new")).toBe("new")
    expect(normalizeChangeKind("legacy")).toBe("legacy")
    expect(normalizeChangeKind("")).toBeNull()
    expect(normalizeChangeKind(undefined)).toBeNull()
    expect(normalizeChangeKind(1)).toBeNull()
  })

  it("accepts only ratios inside [0, 1]", () => {
    expect(normalizeNewRatio(0)).toBe(0)
    expect(normalizeNewRatio(0.42)).toBe(0.42)
    expect(normalizeNewRatio(1)).toBe(1)
    expect(normalizeNewRatio(1.5)).toBeNull()
    expect(normalizeNewRatio(-0.1)).toBeNull()
    expect(normalizeNewRatio("0.5")).toBeNull()
    expect(normalizeNewRatio(Number.NaN)).toBeNull()
  })
})
