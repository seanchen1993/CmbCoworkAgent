import { describe, expect, it } from "vitest"
import { promptReceiptFixture } from "./prompt-recovery-fixture"
import { analyzePromptFlowRecovery } from "./prompt-recovery-analysis"
import { flowDigest } from "./store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { planFlowRecoveryReservation, type RecoveryHistoryRun } from "./recovery-history"
import type { FlowRecoveryObservation } from "./recovery"

function fixture() {
  const f = promptReceiptFixture()
  f.run.flow.definition = parseFlowDefinition(f.run.flow.definition)
  f.run.flow.digest = flowDigest(f.run.flow.definition)
  f.capture.dependencies.definitionDigest = f.run.flow.digest
  f.attempt.recoveryEvidence = f.bind()
  const observation: FlowRecoveryObservation = {
    authority: "current",
    definitionDigest: f.run.flow.digest,
    promptReceipts: { verifiedExecutionIds: [f.attempt.executionId] }
  }
  return {
    ...f,
    observation,
    analyze: () => analyzePromptFlowRecovery(f.run, [f.run], observation, false, 2000)
  }
}
describe("pure prompt-only recovery query projection", () => {
  it("uses verified text receipts without equating run-instance artifact fingerprints", () => {
    const f = fixture()
    f.observation.artifactFingerprint = "completely-different-run"
    const before = structuredClone(f.run)
    const result = f.analyze()
    expect(result.status).toBe("eligible")
    expect(result.steps.map((step) => step.disposition)).toEqual(["reusable", "pending"])
    expect(result.nextStepId).toBe("review")
    expect(result.consumedExecutions).toBe(1)
    expect(result.remainingExecutions).toBe(15)
    expect(f.run).toEqual(before)
    expect(f.run).not.toHaveProperty("executionPlan")
  })
  it.each(["missing", "partial", "duplicate", "authority", "definition", "legacy-evidence"])(
    "blocks %s verification",
    (kind) => {
      const f = fixture()
      if (kind === "missing") delete f.observation.promptReceipts
      if (kind === "partial") f.observation.promptReceipts!.verifiedExecutionIds = []
      if (kind === "duplicate")
        f.observation.promptReceipts!.verifiedExecutionIds.push(f.attempt.executionId)
      if (kind === "authority") f.observation.authority = "unverified"
      if (kind === "definition") f.observation.definitionDigest = "changed"
      if (kind === "legacy-evidence") delete f.attempt.recoveryEvidence
      const report = f.analyze()
      expect(report.status).toBe("blocked")
      expect(report.steps.every((step) => step.disposition !== "reusable")).toBe(true)
    }
  )
  it("uses actual parent links and inherited budget for copied earlier timestamps", () => {
    const f = fixture()
    const reserved = planFlowRecoveryReservation(
      [f.run],
      {
        schemaVersion: 1,
        sourceRunId: f.run.id,
        sourceDigest: flowDigest(f.run),
        hostInactive: true,
        prefix: [f.attempt]
      },
      { childRunId: "child", now: 2000 }
    )
    const report = analyzePromptFlowRecovery(
      reserved.child,
      reserved.rows,
      f.observation,
      false,
      3000
    )
    expect(report.status).toBe("eligible")
    expect(report.consumedExecutions).toBe(1)
    expect(report.remainingExecutions).toBe(15)
    expect(
      analyzePromptFlowRecovery(reserved.child, [reserved.child], f.observation, false, 3000).status
    ).toBe("blocked")
    const parent = reserved.rows.find((row) => row.id === f.run.id)!
    expect(
      analyzePromptFlowRecovery(parent, reserved.rows, f.observation, false, 3000).reasons
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source-consumed" })]))
  })
  it("blocks root timeout and reports inherited counts without allocating fresh budget", () => {
    const f = fixture()
    const report = analyzePromptFlowRecovery(f.run, [f.run], f.observation, false, 61000)
    expect(report.status).toBe("blocked")
    expect(report.consumedExecutions).toBe(1)
    expect(report.reasons.some((reason) => reason.code === "budget-exhausted")).toBe(true)
  })
  it("blocks unknown checks and finalization instead of suggesting replay", () => {
    for (const stepId of ["review", "__final"]) {
      const f = fixture()
      if (stepId === "review") {
        f.run.flow.definition.steps[1] = {
          id: "review",
          name: "Check",
          enabled: true,
          kind: "check",
          check: "unit-test"
        }
        f.run.flow.digest = flowDigest(f.run.flow.definition)
        f.observation.definitionDigest = f.run.flow.digest
      }
      f.run.attempts.push({
        stepId,
        executionId: "unknown",
        attempt: 1,
        epoch: 0,
        status: "unknown",
        startedAt: 1003
      })
      const report = f.analyze()
      expect(report.status).toBe("blocked")
      expect(report.nextStepId).toBeUndefined()
    }
  })
  it("maps settled checks and approval to fresh rechecks", () => {
    const f = fixture()
    f.run.flow.definition.steps[1] = {
      id: "review",
      name: "Check",
      enabled: true,
      kind: "check",
      check: "unit-test"
    }
    f.run.flow.definition.steps.push({
      id: "approve",
      name: "Approve",
      enabled: true,
      kind: "approval",
      prompt: "Confirm"
    })
    f.run.flow.definition = parseFlowDefinition(f.run.flow.definition)
    f.run.flow.digest = flowDigest(f.run.flow.definition)
    f.observation.definitionDigest = f.run.flow.digest
    f.run.attempts.push(
      {
        stepId: "review",
        executionId: "check",
        attempt: 1,
        epoch: 0,
        status: "passed",
        startedAt: 1003,
        finishedAt: 1004,
        result: { source: "native-check", passed: true, summary: "OK" }
      },
      {
        stepId: "approve",
        executionId: "approval",
        attempt: 1,
        epoch: 0,
        status: "waiting",
        startedAt: 1005
      }
    )
    const report = f.analyze()
    expect(report.status).toBe("eligible")
    expect(report.steps.map((step) => step.disposition)).toEqual(["reusable", "recheck", "recheck"])
    expect(report.nextStepId).toBe("review")
  })
  it("reports active and completed runs without offering recovery", () => {
    const f = fixture()
    expect(analyzePromptFlowRecovery(f.run, [f.run], f.observation, true, 2000).status).toBe(
      "active"
    )
    f.run.status = "complete"
    expect(f.analyze().status).toBe("complete")
  })
  it("refuses malformed history and missing/full provenance without exposing errors", () => {
    const f = fixture()
    expect(analyzePromptFlowRecovery(f.run, undefined, f.observation, false, 2000).status).toBe(
      "blocked"
    )
    const broken = { ...f.run, recovery: { parentRunId: "MISSING-SECRET" } } as RecoveryHistoryRun
    const report = analyzePromptFlowRecovery(broken, [broken], f.observation, false, 2000)
    expect(report.status).toBe("blocked")
    expect(JSON.stringify(report)).not.toContain("MISSING-SECRET")
  })
})
