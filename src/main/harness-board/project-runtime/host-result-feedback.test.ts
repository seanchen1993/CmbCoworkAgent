import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HostProjectStore } from "./host-store"
import {
  hostProjectFixture,
  prepareFixture,
  receiptFixture,
  TEST_FINGERPRINT,
  TEST_NOW
} from "./host-fixtures.test-helper"
import {
  hostResultReview,
  parseHostOperation,
  parseHostResultFeedback
} from "./host-state-protocol"
import { captureHostResultFeedbackSource, readHostResultFeedback } from "./host-result-feedback"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-feedback-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "state.sqlite")
  const store = new HostProjectStore(path, () => TEST_NOW)
  cleanup.push(() => store.close())
  const creation = hostProjectFixture(root)
  creation.manifest.stages[0].resultApproval = "human"
  const project = store.create(creation)
  const operation = store.prepare(prepareFixture())
  const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
  store.bindExecutionThread(ticket, "original-thread")
  store.recordExecutionTerminal(ticket, { outcome: "success", code: "physically-settled" })
  const settled = store.recordResult(ticket, {
    outcome: "succeeded",
    receipts: [receiptFixture(ticket)]
  })
  const decision = {
    ...hostResultReview(project, settled, "d".repeat(64)),
    decision: "rejected" as const,
    actorId: "desktop-user",
    feedback: "  Revise the boundary.\n保留检查。  "
  }
  return { store, path, operation, settled, decision }
}

describe("native result revision feedback", () => {
  it("persists an exact rejection reference on explicit retry and preserves old terminal and receipts across reopen", () => {
    const f = fixture()
    const rejected = f.store.decideResultApproval(f.operation.operationId, f.decision)
    expect(rejected.resultApproval?.feedback).toBe("Revise the boundary.\n保留检查。")
    expect(() => f.store.prepare(prepareFixture({ idempotencyKey: "retry" }))).toThrow(
      "OPERATION_ACTIVE"
    )
    f.store.cancel(f.operation.operationId)
    const retry = f.store.prepare(prepareFixture({ idempotencyKey: "retry" }))
    expect(retry.resultFeedbackSource?.operationId).toBe(f.operation.operationId)
    expect(retry.approval).toBeNull()
    expect(retry.receipts).toEqual([])
    const cold = new HostProjectStore(f.path)
    cleanup.push(() => cold.close())
    const restored = cold.getOperation(retry.operationId)!
    const original = cold.getOperation(f.operation.operationId)!
    expect(original.execution).toEqual(f.settled.execution)
    expect(original.receipts).toEqual(f.settled.receipts)
    expect(readHostResultFeedback(restored, original)).toEqual({
      operationId: original.operationId,
      feedback: "Revise the boundary.\n保留检查。"
    })
    expect(cold.prepare(prepareFixture({ idempotencyKey: "retry" }))).toEqual(restored)
  })

  it("keeps rejection idempotent but rejects changes to its feedback or an approved decision with feedback", () => {
    const f = fixture()
    expect(() =>
      f.store.decideResultApproval(f.operation.operationId, {
        ...f.decision,
        decision: "approved"
      })
    ).toThrow("RESULT_FEEDBACK_INVALID")
    f.store.decideResultApproval(f.operation.operationId, f.decision)
    expect(
      f.store.decideResultApproval(f.operation.operationId, f.decision).resultApproval?.feedback
    ).toBe(f.decision.feedback.trim())
    expect(() =>
      f.store.decideResultApproval(f.operation.operationId, {
        ...f.decision,
        feedback: "Different opinion"
      })
    ).toThrow("RESULT_APPROVAL_ALREADY_DECIDED")
  })

  it.each([4001, 16001])("rejects oversized feedback of length %s", (length) => {
    expect(() => parseHostResultFeedback("x".repeat(length), "rejected")).toThrow(
      "RESULT_FEEDBACK_INVALID"
    )
  })

  it("keeps historical records compatible and rejects hidden controls, wrong types and forged reference fields", () => {
    const f = fixture()
    expect(parseHostOperation(f.operation).resultFeedbackSource).toBeUndefined()
    expect(parseHostResultFeedback(" \n ", "rejected")).toBeUndefined()
    expect(() => parseHostResultFeedback({ text: "x" }, "rejected")).toThrow()
    expect(() => parseHostResultFeedback("x\u0000y", "rejected")).toThrow()
    expect(() =>
      f.store.prepare({
        ...prepareFixture({ idempotencyKey: "forged" }),
        resultFeedbackSource: {
          operationId: f.operation.operationId,
          approvalDigest: "a".repeat(64)
        }
      } as never)
    ).toThrow("SCHEMA_INVALID")
  })

  it.each(["projectId", "stageId", "expectedVersion", "pluginDigest", "inputFingerprint"] as const)(
    "never inherits feedback across %s",
    (key) => {
      const f = fixture()
      f.store.decideResultApproval(f.operation.operationId, f.decision)
      const source = f.store.cancel(f.operation.operationId)
      const target = {
        ...source,
        operationId: "new-operation",
        status: "prepared" as const,
        [key]: key === "expectedVersion" ? 2 : "different"
      }
      expect(captureHostResultFeedbackSource(target, [source])).toBeUndefined()
    }
  )

  it.each(["unknown", "cancel_requested", "prepared", "succeeded"] as const)(
    "does not inherit a rejection from an original %s operation",
    (status) => {
      const f = fixture()
      const source = f.store.decideResultApproval(f.operation.operationId, f.decision)
      const target = { ...source, operationId: "new-operation", status: "prepared" as const }
      expect(captureHostResultFeedbackSource(target, [{ ...source, status }])).toBeUndefined()
    }
  )

  it("fails closed if the persisted rejection changes after the new operation was prepared", () => {
    const f = fixture()
    f.store.decideResultApproval(f.operation.operationId, f.decision)
    const source = f.store.cancel(f.operation.operationId)
    const retry = f.store.prepare(prepareFixture({ idempotencyKey: "retry" }))
    const changed = structuredClone(source)
    changed.resultApproval!.feedback = "Substituted later"
    expect(() => readHostResultFeedback(retry, changed)).toThrow("RESULT_FEEDBACK_CHANGED")
    expect(() => readHostResultFeedback(retry, undefined)).toThrow("RESULT_FEEDBACK_CHANGED")
    expect(Object.isFrozen(readHostResultFeedback(retry, source))).toBe(true)
  })
})
