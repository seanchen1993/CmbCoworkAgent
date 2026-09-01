import { describe, expect, it } from "vitest"
import { harnessNextActionFingerprint, resolveHarnessNextAction } from "./harness-run-next-action"
import type { HarnessWorkflow } from "./harness-board-types"

const workflow: HarnessWorkflow = {
  display: { mode: "ordered_nodes" },
  nodes: [
    {
      id: "dev.plan",
      label: "计划",
      states: [{ nodeStatus: "in_progress", nextAction: { slashSkill: "dev-plan", userMessage: "继续计划" } }]
    }
  ]
}

describe("Harness nextAction resolver", () => {
  it("resolves node-local state and keeps route fingerprints stable", () => {
    const action = resolveHarnessNextAction(workflow, "dev.plan", "in_progress")
    expect(action).toEqual({ slashSkill: "dev-plan", userMessage: "继续计划" })
    expect(harnessNextActionFingerprint("dev.plan", "in_progress", action)).toBe(
      harnessNextActionFingerprint("dev.plan", "in_progress", action)
    )
  })

  it("falls back to undefined for unknown routes", () => {
    expect(resolveHarnessNextAction(workflow, "dev.code", "in_progress")).toBeUndefined()
  })
})
