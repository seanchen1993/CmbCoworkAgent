import type { FlowRun } from "./types"

/** Only a current host receipt establishes that a project test actually ran. */
export function flowTestEvidence(run: FlowRun): {
  current: number
  passed: number
  failed: number
  stale: number
} {
  const tests = run.attempts.filter((attempt) => {
    if (attempt.result?.source !== "native-check") return false
    const step = run.flow.definition.steps.find((item) => item.id === attempt.stepId)
    const check = attempt.result.check ?? (step?.kind === "check" ? step.check : undefined)
    return check === "unit-test" || check === "e2e"
  })
  const current = tests.filter(
    (attempt) =>
      !attempt.invalidated &&
      attempt.epoch === run.epoch &&
      (attempt.status === "passed" || attempt.status === "failed") &&
      !!attempt.result?.evidenceIds?.length
  )
  return {
    current: current.length,
    passed: current.filter((item) => item.status === "passed").length,
    failed: current.filter((item) => item.status === "failed").length,
    stale: tests.filter((item) => item.invalidated || item.epoch !== run.epoch).length
  }
}
