import { describe, expect, it } from "vitest"
import { shouldShowSupersededFallback } from "../renderer/src/components/dashboard/commit-adoption-trace-logic"

describe("commit adoption trace fallback", () => {
  it("shows stored superseded source details when available", () => {
    expect(shouldShowSupersededFallback("superseded", true, "stored_gen")).toBe(false)
  })

  it("hides commit matching for superseded legacy or unavailable details", () => {
    expect(shouldShowSupersededFallback("superseded", true, "commit_match")).toBe(true)
    expect(shouldShowSupersededFallback("superseded", true, undefined)).toBe(true)
  })

  it("does not replace loading or normal measurement views", () => {
    expect(shouldShowSupersededFallback("superseded", false, undefined)).toBe(false)
    expect(shouldShowSupersededFallback("committed", true, "commit_match")).toBe(false)
  })
})
