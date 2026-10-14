import { expect, it } from "vitest"
import { flowTestEvidence } from "./test-evidence-summary"
import type { FlowRun, FlowAttempt } from "./types"
const attempt = (patch: Partial<FlowAttempt> = {}): FlowAttempt => ({
  executionId: "a",
  stepId: "test",
  attempt: 1,
  epoch: 2,
  status: "passed",
  startedAt: 1,
  result: {
    source: "native-check",
    check: "unit-test",
    passed: true,
    summary: "real",
    evidenceIds: ["receipt"]
  },
  ...patch
})
const run = (attempts: FlowAttempt[]): FlowRun => ({
  id: "r",
  threadId: "t",
  workspace: "w",
  epoch: 2,
  status: "complete",
  startedAt: 1,
  failureCounts: {},
  attempts,
  flow: {
    revision: 1,
    digest: "d",
    updatedAt: 1,
    definition: {
      schemaVersion: 2,
      execution: { kind: "host" },
      id: "f",
      name: "f",
      goal: "g",
      timeoutMs: 10000,
      maxExecutions: 10,
      steps: []
    }
  }
})
it("counts trusted final tests and excludes stale, skipped, and agent prose", () => {
  expect(
    flowTestEvidence(
      run([
        attempt(),
        attempt({ epoch: 1 }),
        attempt({ invalidated: true }),
        attempt({ status: "skipped" }),
        attempt({ result: { source: "agent", passed: true, summary: "all tests passed" } })
      ])
    )
  ).toEqual({ current: 1, passed: 1, failed: 0, stale: 2 })
})
it("does not accept native labels without a receipt or known test kind", () => {
  expect(
    flowTestEvidence(
      run([
        attempt({
          result: { source: "native-check", passed: true, summary: "ok", check: "unit-test" }
        }),
        attempt({
          result: { source: "native-check", passed: true, summary: "ok", evidenceIds: ["r"] }
        })
      ])
    ).current
  ).toBe(0)
})
