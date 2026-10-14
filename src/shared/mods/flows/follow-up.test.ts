import { expect, it } from "vitest"
import { flowFollowUp } from "./follow-up"
import type { FlowRun } from "./types"

it("cites the real task, version and invalidated outcomes, bounding old attempts", () => {
  const run = {
    id: "actual-run",
    flow: { revision: 2, definition: { name: "Review", goal: "template" } },
    taskGoal: "this request",
    status: "failed",
    summary: "unit test failed",
    attempts: Array.from({ length: 100 }, (_, i) => ({
      stepId: `s${i}`,
      status: "passed",
      invalidated: true,
      result: { summary: "x".repeat(50000) }
    }))
  } as FlowRun
  const result = flowFollowUp(run)
  expect(result).toContain("actual-run")
  expect(result).toContain("this request")
  expect(result).not.toContain("template")
  expect(result).toContain('"omittedAttempts": 88')
  expect(result).toContain('"invalidated": true')
  expect(result.length).toBeLessThan(16000)
})
