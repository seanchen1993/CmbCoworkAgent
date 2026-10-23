import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { decide } from "../../../../resources/mods/autobiz-state-machine/graph"

it("uses the effective declared graph for inserted and replaced stages without fixing stage count", () => {
  const workflow = {
    apiVersion: "devclaw.compiled-workflow/v1",
    digest: "a".repeat(64),
    nodes: ["convert", "review", "publish"],
    allowedNext: { convert_in_progress: ["convert_done"], convert_done: ["review_in_progress"] }
  }
  expect(
    decide(
      { checkpoint: "convert_done", workflowNodes: workflow.nodes },
      "review_in_progress",
      workflow
    )
  ).toEqual({
    from: "convert_done",
    to: "review_in_progress",
    expectedWorkflowDigest: "a".repeat(64)
  })
  expect(() =>
    decide({ checkpoint: "convert_in_progress" }, "review_in_progress", workflow)
  ).toThrow("AUTOBIZ_MOD_TRANSITION_REJECTED")
  expect(() =>
    decide({ checkpoint: "convert_done" }, "review_in_progress", { ...workflow, digest: "forged" })
  ).toThrow("AUTOBIZ_MOD_WORKFLOW_CONTRACT_REQUIRED")
})

it("checks bounded schemas, validator bindings and actual adapter stdout isolation without an AutoBiz package", async () => {
  const result = await promisify(execFile)(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      resolve("tests/support/autobiz-composable-contract.py"),
      resolve("resources/mods/autobiz-state-machine")
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  )
  expect(result.stderr).toBe("")
  expect(JSON.parse(result.stdout)).toMatchObject({
    passed: true,
    checks: 19,
    actualAdapterStdoutProtocol: true
  })
})
