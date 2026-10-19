import { expect, it } from "vitest"
import { projectCreatorLegacyTrialJourney } from "./creator-trial-legacy-journey"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"

function fixture() {
  const digest = "a".repeat(64)
  const contract = {
    nodeId: "review",
    checkId: "postcheck",
    contractDigest: digest,
    artifacts: [{ id: "report", path: "report.md" }]
  }
  return {
    projectId: "trial",
    creatorThreadId: "creator",
    candidateDigest: "b".repeat(64),
    candidateCurrent: true,
    packageDigest: digest,
    workspace: "C:/trial",
    featureId: "feature",
    runId: "run",
    phase: "completed",
    manifest: { stages: [{ id: "review", title: "Review" }] } as ProjectRuntimeManifest,
    contracts: [contract],
    sessions: [
      {
        threadId: "stage-thread",
        nodeId: "review",
        startedAt: "start",
        endedAt: "end",
        outcome: "success",
        incarnation: { token: "native", legacyCreatedAt: 1 }
      }
    ],
    receipts: [
      {
        runId: "trial",
        unitId: "feature",
        engineRunId: "run",
        packageDigest: digest,
        threadId: "stage-thread",
        incarnationKey: JSON.stringify({ token: "native", legacyCreatedAt: 1 }),
        hookId: "original",
        receipt: {
          apiVersion: "devclaw.stage-check/v1" as const,
          ...contract,
          outcome: "passed" as const,
          artifacts: [{ id: "report", path: "report.md", digest }]
        }
      }
    ]
  }
}

it("requires original complete run, stage membership and actual original Hook receipts together", () => {
  const f = fixture()
  expect(projectCreatorLegacyTrialJourney(f)).toMatchObject({
    phase: "passed",
    canDeliver: true,
    stages: [{ status: "passed", artifacts: [{ required: null }], checks: [{ result: "passed" }] }]
  })
  expect(projectCreatorLegacyTrialJourney({ ...f, receipts: [] })).toMatchObject({
    phase: "unknown",
    canDeliver: false
  })
  expect(projectCreatorLegacyTrialJourney({ ...f, phase: "running" }).canDeliver).toBe(false)
})

it.each(["engineRunId", "packageDigest", "threadId", "incarnationKey"] as const)(
  "does not borrow original Hook receipts from another %s",
  (field) => {
    const f = fixture()
    f.receipts[0][field] = "another"
    expect(projectCreatorLegacyTrialJourney(f).canDeliver).toBe(false)
  }
)

it("does not infer success from missing producers, incomplete sessions or failed later attempts", () => {
  const f = fixture()
  expect(projectCreatorLegacyTrialJourney({ ...f, contracts: undefined }).canDeliver).toBe(false)
  expect(projectCreatorLegacyTrialJourney({ ...f, sessionsTruncated: true }).canDeliver).toBe(false)
  expect(
    projectCreatorLegacyTrialJourney({ ...f, diagnostic: "receipt unavailable" }).canDeliver
  ).toBe(false)
  f.sessions.push({ ...f.sessions[0], threadId: "later-failed-thread", outcome: "error" })
  expect(projectCreatorLegacyTrialJourney(f)).toMatchObject({
    canDeliver: false,
    stages: [{ status: "failed" }]
  })
})

it("retains historical passed checks while preventing delivery after source revocation or candidate replacement", () => {
  const f = fixture()
  expect(projectCreatorLegacyTrialJourney({ ...f, candidateCurrent: false })).toMatchObject({
    phase: "passed",
    canDeliver: false,
    candidateCurrent: false,
    stages: [{ status: "passed", checks: [{ result: "passed" }] }]
  })
})
