import { expect, it } from "vitest"
import { createReviewFlow } from "./templates"
import { parseFlowDefinition } from "./schema"

it("the first-use review flow runs without an Autobiz Feature or project test script", () => {
  const flow = parseFlowDefinition(createReviewFlow("my-claw", "review-flow"))
  expect(flow.steps.map((step) => step.kind)).toEqual(["agent", "approval"])
  expect(flow.feature).toBeUndefined()
  expect(flow.stageStart).toBeUndefined()
  expect(flow.plugin).toBe("my-claw")
})

it("a starter never substitutes a plugin or grants permission when no plugin is selected", () => {
  expect(() => parseFlowDefinition(createReviewFlow("", "review-flow"))).toThrow("Mods 插件")
})
