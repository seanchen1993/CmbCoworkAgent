import { expect, it } from "vitest"
import { AUTOBIZ_PRESETS, createAutobizPreset } from "./autobiz-presets"
import { parseFlowDefinition } from "./schema"

it.each(AUTOBIZ_PRESETS)("creates a valid $name without grants or stage writes", ({ id }) => {
  const flow = createAutobizPreset(id, `autobiz-${id}`)
  expect(parseFlowDefinition(flow)).toEqual(flow)
  expect(flow.schemaVersion).toBe(2)
  expect(flow.steps.some((step) => step.kind === "autobiz-stage")).toBe(false)
  expect(
    flow.steps
      .filter((step) => step.kind === "agent" && step.id !== "repair")
      .every((step) => step.kind === "agent" && step.agentType === "Explore")
  ).toBe(true)
})

it("does not imply testing in review-only and makes repair reachable only on real failure", () => {
  expect(createAutobizPreset("review", "review").steps.some((step) => step.kind === "check")).toBe(
    false
  )
  const flow = createAutobizPreset("repair-retest", "repair")
  expect(flow.steps.find((step) => step.id === "unit")).toMatchObject({
    onSuccess: "report",
    onFailure: { stepId: "repair", maxRetries: 1 }
  })
  expect(flow.steps.find((step) => step.id === "retest")).toMatchObject({
    onFailure: { stepId: "repair", maxRetries: 1 }
  })
})
