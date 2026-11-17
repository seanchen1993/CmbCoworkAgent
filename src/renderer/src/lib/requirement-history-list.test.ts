import { describe, expect, it } from "vitest"
import { normalizeRequirementHtmlFilePath } from "../components/requirement/requirement-data"

describe("requirement history progress", () => {
  it("accepts only absolute generated HTML paths", () => {
    expect(
      normalizeRequirementHtmlFilePath(
        "/workspace/requirement/.cmb-design/ds_123_design-main/index.html"
      )
    ).toBe("/workspace/requirement/.cmb-design/ds_123_design-main/index.html")
    expect(normalizeRequirementHtmlFilePath("原型设计/fr-1.html")).toBe("")
    expect(normalizeRequirementHtmlFilePath("prd/原型设计/fr-1.html")).toBe("")
    expect(normalizeRequirementHtmlFilePath("C:\\workspace\\.cmb-design\\index.html")).toBe(
      "C:/workspace/.cmb-design/index.html"
    )
  })
})
