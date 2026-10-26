import { describe, expect, it } from "vitest"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import {
  projectCreatorTrialJourney,
  type CreatorTrialProjectReference
} from "./creator-trial-journey"

const digest = "a".repeat(64)
const reference: CreatorTrialProjectReference = {
  requestId: "request",
  draftId: "draft",
  revision: 1,
  candidateDigest: "b".repeat(64),
  projectId: "project",
  installedPluginId: "preview",
  pluginDigest: digest,
  workspace: "C:/trial"
}
function fixture() {
  const project: HostProjectState = {
    schemaVersion: 1,
    stateOwner: "host",
    projectId: "project",
    installedPluginId: "preview",
    pluginDigest: digest,
    name: "Bound trial",
    goal: "Review",
    workspace: "C:/trial",
    packageId: "package",
    packageVersion: "1.0.0",
    version: 1,
    stageIndex: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    manifest: {
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: "package", version: "1.0.0" },
      mode: "host",
      stateOwner: "host",
      stages: [
        {
          id: "review",
          title: "Review",
          skill: "review",
          actionIds: [],
          artifactIds: ["report"],
          checkIds: ["schema"],
          approval: "human"
        }
      ],
      actions: [],
      artifacts: [{ id: "report", path: "report.json", required: true }],
      checks: [
        {
          id: "schema",
          artifactId: "report",
          kind: "json-schema",
          schema: { type: "object" },
          sideEffect: "read"
        }
      ],
      environment: [],
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: true,
        reconciliation: true,
        cancellation: true
      }
    }
  }
  const operation: HostProjectOperation = {
    schemaVersion: 1,
    projectId: project.projectId,
    pluginDigest: digest,
    stageId: "review",
    operationId: "operation",
    expectedVersion: 1,
    idempotencyKey: "attempt",
    inputFingerprint: digest,
    status: "succeeded",
    createdAt: 2,
    updatedAt: 3,
    cancelRequestedAt: null,
    startedAt: 2,
    execution: {
      threadId: "stage-thread",
      terminal: { outcome: "success", code: "done", settledAt: 3 }
    },
    approval: null,
    receipts: [
      {
        schemaVersion: 1,
        operationId: "operation",
        projectId: project.projectId,
        stageId: "review",
        pluginDigest: digest,
        inputFingerprint: digest,
        checkId: "schema",
        artifactFingerprint: digest,
        result: "passed",
        validatorVersion: "host-json-schema/v1",
        checkedAt: 3
      }
    ]
  }
  return {
    project,
    operation,
    read: (operations = [operation], candidateCurrent = true) =>
      projectCreatorTrialJourney({
        reference,
        creatorThreadId: "creator",
        project,
        operations,
        candidateCurrent
      })
  }
}

describe("creator trial native evidence projection", () => {
  it("shows output approval as a real pending decision rather than an ordinary transition", () => {
    const f = fixture()
    f.project.manifest.stages[0].resultApproval = "human"
    expect(f.read()).toMatchObject({
      phase: "needs-approval", canDeliver: false, stages: [{ status: "needs-approval" }]
    })
    f.operation.resultApproval = {
      operationId: "operation", expectedVersion: 1, inputFingerprint: digest,
      pluginDigest: digest, artifactFingerprint: digest, receiptFingerprint: digest,
      policyDigest: digest, actorId: "person", decision: "approved", decidedAt: 4
    }
    expect(f.read()).toMatchObject({ phase: "needs-transition", canDeliver: false })
    f.operation.resultApproval.decision = "rejected"
    expect(f.read()).toMatchObject({ phase: "needs-approval", canDeliver: false })
  })
  it("keeps a successful model with missing checks unknown rather than successful", () => {
    const f = fixture()
    f.operation.receipts = []
    expect(f.read()).toMatchObject({
      phase: "unknown",
      canDeliver: false,
      stages: [
        {
          status: "unknown",
          checks: [{ result: "unknown" }],
          sessions: [{ threadId: "stage-thread", terminalOutcome: "success" }]
        }
      ]
    })
  })

  it("separates checked artifacts from native stage confirmation and complete delivery", () => {
    const f = fixture()
    expect(f.read()).toMatchObject({
      phase: "needs-transition",
      canDeliver: false,
      stages: [{ status: "checks-passed" }]
    })
    f.operation.status = "transitioned"
    f.project.status = "completed"
    expect(f.read()).toMatchObject({
      phase: "passed",
      canDeliver: true,
      creatorThreadId: "creator",
      candidateDigest: reference.candidateDigest,
      stages: [
        {
          status: "passed",
          checks: [{ result: "passed", validatorVersion: "host-json-schema/v1" }]
        }
      ]
    })
  })

  it.each(["operationId", "projectId", "stageId", "pluginDigest", "inputFingerprint"] as const)(
    "rejects a receipt bound to a different %s",
    (field) => {
      const f = fixture()
      f.operation.receipts[0][field] = "other"
      expect(f.read().canDeliver).toBe(false)
      expect(f.read().stages[0].checks[0].result).toBe("unknown")
    }
  )

  it("rejects a substituted project without exposing its sessions or artifacts", () => {
    const f = fixture()
    f.project.installedPluginId = "another-preview"
    expect(f.read()).toMatchObject({ phase: "unknown", canDeliver: false, stages: [] })
  })

  it("does not reuse an earlier successful attempt for a later failed attempt", () => {
    const f = fixture()
    const failed = {
      ...f.operation,
      operationId: "later",
      status: "failed" as const,
      createdAt: 4,
      updatedAt: 5,
      receipts: []
    }
    expect(f.read([f.operation, failed])).toMatchObject({
      phase: "failed",
      canDeliver: false,
      stages: [{ status: "failed", checks: [{ result: "unknown" }] }]
    })
  })

  it("preserves historical results while requiring changed candidate versions to be tried again", () => {
    const f = fixture()
    f.operation.status = "transitioned"
    f.project.status = "completed"
    const result = f.read([f.operation], false)
    expect(result).toMatchObject({ phase: "passed", canDeliver: false, candidateCurrent: false })
    expect(result.diagnostics.join(" ")).toContain("旧版本")
  })

  it("does not infer success from completed state when operation history was truncated", () => {
    const f = fixture()
    f.operation.status = "transitioned"
    f.project.status = "completed"
    expect(
      projectCreatorTrialJourney({
        reference,
        creatorThreadId: "creator",
        project: f.project,
        operations: [f.operation],
        operationLimit: 1,
        candidateCurrent: true
      })
    ).toMatchObject({ phase: "unknown", canDeliver: false, operationsTruncated: true })
  })

  it("requires declared checks for every required artifact instead of vacuous success", () => {
    const f = fixture()
    f.operation.status = "transitioned"
    f.project.status = "completed"
    f.project.manifest.stages[0].checkIds = []
    f.project.manifest.checks = []
    expect(f.read()).toMatchObject({ phase: "unknown", canDeliver: false })
  })
})
