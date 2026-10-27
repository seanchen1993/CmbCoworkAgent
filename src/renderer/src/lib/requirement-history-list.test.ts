import { describe, expect, it } from "vitest"
import {
  getRequirementCompletedSteps,
  normalizeRequirementHtmlFilePath,
  type RequirementRecord
} from "../components/requirement/requirement-data"

function requirementAtStep(
  currentStep: number,
  status: RequirementRecord["prdManifest"]["prd"]["status"] = "generated"
): RequirementRecord {
  return {
    id: "test",
    threadIds: [],
    systemId: "system",
    title: "测试需求",
    requirementPath: "",
    workspaceMissing: false,
    coreFilesMissing: false,
    coreFilesMissingReason: null,
    updatedAt: "",
    system: "测试系统",
    status: "已生成",
    fileName: "",
    link: "",
    sourceType: "text",
    sourceName: "",
    initialDescription: "",
    needDesign: "",
    prdManifest: {
      prd: { name: "测试需求", status, description: "", file: "", currentStep, needDesign: "" },
      functions: []
    },
    prd: "是"
  }
}

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

  it("caps step 5 at step 4 until the manifest is published", () => {
    expect(getRequirementCompletedSteps(requirementAtStep(5))).toBe(4)
    expect(getRequirementCompletedSteps(requirementAtStep(4))).toBe(4)
    expect(getRequirementCompletedSteps(requirementAtStep(5, "published"))).toBe(5)
  })

  it("clamps malformed steps to the five-step range", () => {
    expect(getRequirementCompletedSteps(requirementAtStep(99))).toBe(4)
    expect(getRequirementCompletedSteps(requirementAtStep(99, "published"))).toBe(5)
    expect(getRequirementCompletedSteps(requirementAtStep(0))).toBe(1)
  })
})
