import { describe, expect, it } from "vitest"
import { isModelAvailable, isModelSelectable } from "./model-catalog"
import { IDLE_MODEL_OUTSIDE_HOURS_MESSAGE } from "./idle-model-service-window"

describe("model selection versus request availability", () => {
  it("allows preselecting an idle model outside hours without making it callable", () => {
    const model = {
      apiKey: "test-key",
      transport: "idle-gateway" as const,
      unavailableReason: IDLE_MODEL_OUTSIDE_HOURS_MESSAGE
    }
    expect(isModelSelectable(model)).toBe(true)
    expect(isModelAvailable(model)).toBe(false)
  })

  it.each([
    undefined,
    { transport: "idle-gateway" as const, unavailableReason: IDLE_MODEL_OUTSIDE_HOURS_MESSAGE },
    {
      apiKey: "test-key",
      transport: "idle-gateway" as const,
      unavailableReason: "请完善 SAP 工号"
    },
    { apiKey: "test-key", unavailableReason: IDLE_MODEL_OUTSIDE_HOURS_MESSAGE }
  ])("keeps other unavailability reasons non-selectable: %j", (model) => {
    expect(isModelSelectable(model)).toBe(false)
  })

  it("keeps configured ordinary models selectable and callable", () => {
    const model = { apiKey: "test-key" }
    expect(isModelSelectable(model)).toBe(true)
    expect(isModelAvailable(model)).toBe(true)
  })
})
