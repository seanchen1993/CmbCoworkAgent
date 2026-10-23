import { expect, it } from "vitest"
import { decide } from "../../../resources/mods/autobiz-state-machine/graph"
import reviewedWorkflow from "./autobiz-business-routing-reviewed.json"

const workflowNodes = [
  "biz.prd",
  "dev.specs",
  "dev.design",
  "dev.plan",
  "dev.code",
  "ops.cicd",
  "ops.archive"
]

const workflow = {
  apiVersion: "devclaw.compiled-workflow/v1",
  nodes: workflowNodes,
  digest: "a".repeat(64),
  allowedNext: reviewedWorkflow.checkpoints.transitions as Record<string, string[]>
}

it("decides every edge declared by the original compiler contract in plugin JavaScript", () => {
  let checked = 0
  for (const [checkpoint, targets] of Object.entries(workflow.allowedNext)) {
    for (const to of targets) {
      expect(decide({ checkpoint, workflowNodes }, to, workflow)).toEqual({
        from: checkpoint,
        to,
        expectedWorkflowDigest: workflow.digest
      })
      checked++
    }
  }
  expect(checked).toBeGreaterThan(14)
  const branch = {
    ...workflow,
    nodes: [...workflowNodes.slice(0, 4), "dev.detail_design", ...workflowNodes.slice(4)],
    allowedNext: { ...workflow.allowedNext, plan_done: ["detail_design_in_progress"] }
  }
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
      "detail_design_in_progress",
      branch
    )
  ).toEqual({
    from: "plan_done",
    to: "detail_design_in_progress",
    expectedWorkflowDigest: workflow.digest
  })
})

it("rejects every undeclared edge, including skipped gates and terminal replay", () => {
  const states = Object.keys(workflow.allowedNext)
  let rejected = 0
  for (const checkpoint of states) {
    for (const to of states) {
      if (workflow.allowedNext[checkpoint].includes(to)) continue
      expect(() => decide({ checkpoint, workflowNodes }, to, workflow)).toThrow(
        "AUTOBIZ_MOD_TRANSITION_REJECTED"
      )
      rejected++
    }
  }
  const legalPairs = states.reduce(
    (count, state) =>
      count + workflow.allowedNext[state].filter((to) => states.includes(to)).length,
    0
  )
  expect(rejected).toBe(states.length ** 2 - legalPairs)
})

it("rejects unknown state and missing contracts while accepting a declared custom workflow", () => {
  expect(() =>
    decide({ checkpoint: "model_says_done", workflowNodes }, "archived", workflow)
  ).toThrow()
  expect(() =>
    decide(
      { checkpoint: "prd_done", workflowNodes: ["biz.prd", "ops.archive"] },
      "specs_in_progress",
      { ...workflow, digest: "" }
    )
  ).toThrow("AUTOBIZ_MOD_WORKFLOW_CONTRACT_REQUIRED")
  expect(
    decide({ checkpoint: "convert_done" }, "prd_in_progress", {
      ...workflow,
      nodes: ["requirements.convert", ...workflowNodes],
      allowedNext: { convert_done: ["prd_in_progress"] }
    })
  ).toMatchObject({ from: "convert_done", to: "prd_in_progress" })
})
