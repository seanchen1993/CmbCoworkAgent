import { expect, it } from "vitest"
import { createHostDevelopmentFlow, createAutobizFlow } from "./templates"
import { parseFlowDefinition } from "./schema"

it("creates a valid host development flow without placeholder grants or project stage changes", () => {
  const flow = createHostDevelopmentFlow("development")
  expect(parseFlowDefinition(flow)).toEqual(flow)
  expect(flow.execution).toEqual({ kind: "host" })
  expect(flow).not.toHaveProperty("plugin")
  expect(flow.steps.some((step) => step.kind === "autobiz-stage")).toBe(false)
  expect(flow.steps.some((step) => step.kind === "check" && step.enabled)).toBe(true)
  expect(createAutobizFlow("existing").schemaVersion).toBe(1)
  expect(createAutobizFlow("existing").steps.some((step) => step.kind === "autobiz-stage")).toBe(
    true
  )
})
