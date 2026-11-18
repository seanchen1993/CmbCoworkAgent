import { describe, expect, it } from "vitest"
import { shouldAutoOpenRequirementQuickStart } from "../components/requirement/requirement-persona"

describe("shouldAutoOpenRequirementQuickStart", () => {
  it("opens for a first-time product-mode user without local requirements or a persona", () => {
    expect(shouldAutoOpenRequirementQuickStart(0, null)).toBe(true)
  })

  it("does not open when local requirements already exist", () => {
    expect(shouldAutoOpenRequirementQuickStart(1, null)).toBe(false)
  })

  it("does not open when a persona has already been selected", () => {
    expect(shouldAutoOpenRequirementQuickStart(0, "development")).toBe(false)
  })
})
