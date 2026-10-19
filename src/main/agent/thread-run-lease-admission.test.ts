import { expect, it } from "vitest"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  registerLocalThreadRunAdmissionGuard,
  releaseLocalThreadRunLease
} from "./thread-run-lease"

it("fences new and handed-off runs without changing existing ownership or cancellation", () => {
  const input = { threadId: "composition-admission", owner: "desktop" as const, runId: "first" }
  let busy = false
  const dispose = registerLocalThreadRunAdmissionGuard((_id, work) => {
    if (busy) throw Error("COMPOSITION_WORKSPACE_BUSY")
    return work()
  })
  try {
    expect(claimLocalThreadRunLease(input).acquired).toBe(true)
    busy = true
    expect(claimLocalThreadRunLease(input).acquired).toBe(true)
    expect(() =>
      claimLocalThreadRunLease({ ...input, runId: "next", handoffFromRunId: "first" })
    ).toThrow("WORKSPACE_BUSY")
    expect(getLocalThreadRunLease(input.threadId)?.runId).toBe("first")
    expect(releaseLocalThreadRunLease(input.threadId, "desktop", "first")).toBe(true)
    expect(() => claimLocalThreadRunLease(input)).toThrow("WORKSPACE_BUSY")
    expect(getLocalThreadRunLease(input.threadId)).toBeUndefined()
  } finally {
    dispose()
    releaseLocalThreadRunLease(input.threadId, "desktop", "first")
  }
  expect(claimLocalThreadRunLease(input).acquired).toBe(true)
  releaseLocalThreadRunLease(input.threadId, "desktop", "first")
})
