import { expect, it } from "vitest"
import { decide, transitions } from "../../../resources/mods/autobiz-state-machine/graph"

const workflowNodes = [
  "biz.prd",
  "dev.specs",
  "dev.design",
  "dev.plan",
  "dev.code",
  "ops.cicd",
  "ops.archive"
]

it("decides every declared fixed business edge in plugin JavaScript", () => {
  let checked = 0
  for (const [checkpoint, targets] of Object.entries(transitions)) {
    for (const to of targets) {
      expect(decide({ checkpoint, workflowNodes }, to)).toEqual({ from: checkpoint, to })
      checked++
    }
  }
  expect(checked).toBe(15)
  expect(
    decide(
      {
        checkpoint: "plan_done",
        workflowNodes: [
          ...workflowNodes.slice(0, 4),
          "dev.detail_design",
          ...workflowNodes.slice(4)
        ]
      },
      "detail_design_in_progress"
    )
  ).toEqual({ from: "plan_done", to: "detail_design_in_progress" })
})

it("rejects every undeclared edge, including skipped gates and terminal replay", () => {
  const states = Object.keys(transitions)
  let rejected = 0
  for (const checkpoint of states) {
    for (const to of states) {
      if (transitions[checkpoint].includes(to)) continue
      expect(() => decide({ checkpoint, workflowNodes }, to)).toThrow(
        "AUTOBIZ_MOD_TRANSITION_REJECTED"
      )
      rejected++
    }
  }
  expect(rejected).toBeGreaterThan(200)
})

it("rejects an unknown state and an unsupported custom workflow without inferring success", () => {
  expect(() => decide({ checkpoint: "model_says_done", workflowNodes }, "archived")).toThrow()
  expect(() =>
    decide(
      { checkpoint: "prd_done", workflowNodes: ["biz.prd", "ops.archive"] },
      "specs_in_progress"
    )
  ).toThrow("AUTOBIZ_MOD_FIXED_WORKFLOW_REQUIRED")
})
