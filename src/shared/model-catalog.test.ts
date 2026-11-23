import { describe, expect, it } from "vitest"
import { isModelAvailable } from "./model-catalog"

describe("model availability", () => {
  it.each([
    undefined,
    { apiKey: undefined },
    { apiKey: "test-key", unavailableReason: "请完善 SAP 工号" }
  ])("rejects unavailable models: %j", (model) => {
    expect(isModelAvailable(model)).toBe(false)
  })

  it("allows a configured model", () => {
    expect(isModelAvailable({ apiKey: "test-key" })).toBe(true)
  })
})
