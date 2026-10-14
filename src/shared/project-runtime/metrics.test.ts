import { describe, it, expect } from "vitest"
import { projectLocalMetrics } from "./metrics"
import type { HostProjectOperation } from "./host-types"
const operation = (
  id: string,
  patch: Partial<HostProjectOperation> = {}
): HostProjectOperation => ({
  schemaVersion: 1,
  projectId: "project",
  operationId: id,
  expectedVersion: 1,
  stageId: "draft",
  idempotencyKey: id,
  inputFingerprint: "a".repeat(64),
  pluginDigest: "b".repeat(64),
  status: "succeeded",
  createdAt: 1000,
  updatedAt: 6000,
  startedAt: 5000,
  cancelRequestedAt: null,
  receipts: [],
  approval: {
    decision: "approved",
    actorId: "user",
    decidedAt: 4000,
    operationId: id,
    expectedVersion: 1,
    inputFingerprint: "a".repeat(64)
  },
  execution: { threadId: id, terminal: { outcome: "success", code: "complete", settledAt: 6000 } },
  ...patch
})
describe("local project metrics", () => {
  it("separates measured execution from approval wait and counts actual repeated starts", () => {
    const a = operation("a", { status: "failed" }),
      b = operation("b")
    const pending = operation("pending", {
      startedAt: null,
      execution: null,
      approval: null,
      status: "prepared"
    })
    expect(projectLocalMetrics([a, a, b, pending])).toEqual({
      retainedOperations: 3,
      failed: 1,
      unknown: 0,
      repeatedExecutions: 1,
      observedExecutionMs: 2000,
      observedApprovalWaitMs: 6000,
      measuredExecutions: 2
    })
  })
  it("does not invent duration for interrupted or unobserved execution", () => {
    expect(
      projectLocalMetrics([operation("a", { status: "unknown", approval: null, execution: null })])
    ).toMatchObject({
      unknown: 1,
      observedExecutionMs: null,
      observedApprovalWaitMs: null,
      measuredExecutions: 0
    })
    expect(projectLocalMetrics([]).observedExecutionMs).toBeNull()
  })
})
