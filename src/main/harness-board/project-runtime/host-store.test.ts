import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { HostProjectStore } from "./host-store"
import {
  hostProjectFixture,
  prepareFixture,
  receiptFixture,
  TEST_FINGERPRINT,
  TEST_NOW
} from "./host-fixtures.test-helper"

const roots: string[] = []
const stores: HostProjectStore[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-project-store-"))
  roots.push(root)
  const path = join(root, "state.sqlite")
  const store = openStore(path)
  store.create(hostProjectFixture(root))
  return { store, root, path }
}
function openStore(path: string) {
  const store = new HostProjectStore(path, () => TEST_NOW)
  stores.push(store)
  return store
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe("persistent host project state", () => {
  it("serializes distinct project ids sharing a workspace across store instances", () => {
    const { store, root, path } = fixture()
    const other = openStore(path)
    other.create({
      ...hostProjectFixture(process.platform === "win32" ? root.toUpperCase() : root),
      projectId: "second"
    })
    const first = store.prepare(prepareFixture())
    expect(() => other.prepare(prepareFixture({ projectId: "second" }))).toThrow(
      "WORKSPACE_OPERATION_ACTIVE"
    )
    const ticket = store.start(first.operationId, TEST_FINGERPRINT)
    store.recordResult(ticket, { outcome: "unknown", receipts: [] })
    expect(() => other.prepare(prepareFixture({ projectId: "second" }))).toThrow(
      "WORKSPACE_OPERATION_ACTIVE"
    )
    expect(store.getOperation(first.operationId)?.status).toBe("unknown")
  })
  it("releases a workspace after a prepared operation is cancelled", () => {
    const { store, root, path } = fixture()
    const other = openStore(path)
    other.create({ ...hostProjectFixture(root), projectId: "second" })
    const first = store.prepare(prepareFixture())
    store.cancel(first.operationId)
    const second = other.prepare(prepareFixture({ projectId: "second" }))
    expect(other.start(second.operationId, TEST_FINGERPRINT).projectId).toBe("second")
  })
  it("retains cancellation intent when reconciling a result after restart", async () => {
    const { store, path } = fixture()
    const operation = store.prepare(prepareFixture())
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    store.cancel(operation.operationId)
    const recovered = openStore(path)
    recovered.recoverInterrupted()
    const result = await recovered.reconcile(operation.operationId, async () => ({
      outcome: "succeeded",
      receipts: [receiptFixture(ticket)]
    }))
    expect(result.status).toBe("cancelled")
    expect(() => recovered.transition(operation.operationId, TEST_FINGERPRINT)).toThrow(
      "VALIDATION_REQUIRED"
    )
  })
  it("creates a local two-stage project without enterprise fields and persists real validated progress", () => {
    const { store, path } = fixture()
    const operation = store.prepare(prepareFixture())
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    store.recordResult(ticket, { outcome: "succeeded", receipts: [receiptFixture(ticket)] })
    const advanced = store.transition(operation.operationId, TEST_FINGERPRINT)
    expect(advanced).toMatchObject({
      stageIndex: 1,
      version: 2,
      status: "active",
      stateOwner: "host"
    })
    expect(openStore(path).get("local-docs")).toEqual(advanced)
    expect(advanced).not.toHaveProperty("systemId")
    expect(store.transition(operation.operationId, TEST_FINGERPRINT)).toEqual(advanced)
  })

  it("requires complete matching receipts and rejects forged or replayed tickets", () => {
    const { store } = fixture()
    const operation = store.prepare(prepareFixture())
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    expect(() => store.recordResult({ ...ticket }, { outcome: "succeeded", receipts: [] })).toThrow(
      "TICKET_INVALID"
    )
    expect(() =>
      store.recordResult(ticket, {
        outcome: "succeeded",
        receipts: [{ ...receiptFixture(ticket), projectId: "another" }]
      })
    ).toThrow("RECEIPT_MISMATCH")
    store.recordResult(ticket, { outcome: "succeeded", receipts: [] })
    expect(() => store.transition(operation.operationId, TEST_FINGERPRINT)).toThrow(
      "VALIDATION_REQUIRED"
    )
    expect(() =>
      store.recordResult(ticket, { outcome: "succeeded", receipts: [receiptFixture(ticket)] })
    ).toThrow("TICKET_INVALID")
    expect(store.get("local-docs")?.version).toBe(1)
  })

  it("enforces one owner and CAS across independently opened store instances", () => {
    const { store, path } = fixture()
    const other = openStore(path)
    const operation = store.prepare(prepareFixture())
    expect(other.prepare(prepareFixture())).toEqual(operation)
    expect(() => other.prepare(prepareFixture({ idempotencyKey: "competing" }))).toThrow(
      "OPERATION_ACTIVE"
    )
    const ticket = other.start(operation.operationId, TEST_FINGERPRINT)
    expect(() => store.start(operation.operationId, TEST_FINGERPRINT)).toThrow(
      "OPERATION_NOT_PREPARED"
    )
    other.recordResult(ticket, { outcome: "succeeded", receipts: [receiptFixture(ticket)] })
    other.transition(operation.operationId, TEST_FINGERPRINT)
    expect(() => store.prepare(prepareFixture({ idempotencyKey: "stale" }))).toThrow(
      "VERSION_CONFLICT"
    )
    expect(store.get("local-docs")?.version).toBe(2)
  })

  it("binds approval to operation, input and state version and requires a new retry key after rejection", () => {
    const { store } = fixture()
    const first = store.prepare(prepareFixture())
    const ticket = store.start(first.operationId, TEST_FINGERPRINT)
    store.recordResult(ticket, { outcome: "succeeded", receipts: [receiptFixture(ticket)] })
    store.transition(first.operationId, TEST_FINGERPRINT)
    const request = prepareFixture({
      expectedVersion: 2,
      stageId: "review",
      idempotencyKey: "review"
    })
    const operation = store.prepare(request)
    expect(() => store.start(operation.operationId, TEST_FINGERPRINT)).toThrow("APPROVAL_REQUIRED")
    expect(() =>
      store.decideApproval(operation.operationId, {
        expectedVersion: 1,
        inputFingerprint: TEST_FINGERPRINT,
        decision: "approved",
        actorId: "user"
      })
    ).toThrow("APPROVAL_MISMATCH")
    store.decideApproval(operation.operationId, {
      expectedVersion: 2,
      inputFingerprint: TEST_FINGERPRINT,
      decision: "rejected",
      actorId: "user"
    })
    expect(store.prepare(request).status).toBe("cancelled")
    expect(() => store.start(operation.operationId, TEST_FINGERPRINT)).toThrow(
      "OPERATION_NOT_PREPARED"
    )
    const retry = store.prepare({ ...request, idempotencyKey: "review-retry" })
    expect(retry.approval).toBeNull()
    store.decideApproval(retry.operationId, {
      expectedVersion: 2,
      inputFingerprint: TEST_FINGERPRINT,
      decision: "approved",
      actorId: "user"
    })
    const approvedTicket = store.start(retry.operationId, TEST_FINGERPRINT)
    store.recordResult(approvedTicket, {
      outcome: "succeeded",
      receipts: [receiptFixture(approvedTicket)]
    })
    expect(store.transition(retry.operationId, TEST_FINGERPRINT).status).toBe("completed")
    expect(store.transition(first.operationId, TEST_FINGERPRINT).version).toBe(2)
  })

  it("recovers interrupted writes as unknown, holds ownership and reconciles without replay", async () => {
    const { store, path } = fixture()
    const operation = store.prepare(prepareFixture())
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    const recovered = openStore(path)
    expect(recovered.recoverInterrupted()).toEqual([operation.operationId])
    expect(recovered.prepare(prepareFixture()).status).toBe("unknown")
    expect(() => recovered.prepare(prepareFixture({ idempotencyKey: "retry" }))).toThrow(
      "OPERATION_ACTIVE"
    )
    expect(() => store.recordResult(ticket, { outcome: "succeeded", receipts: [] })).toThrow(
      "RESULT_ALREADY_RECORDED"
    )
    let inspectionCount = 0
    await recovered.reconcile(operation.operationId, async () => {
      inspectionCount++
      return { outcome: "succeeded", receipts: [receiptFixture(ticket)] }
    })
    expect(inspectionCount).toBe(1)
    expect(recovered.transition(operation.operationId, TEST_FINGERPRINT).version).toBe(2)
  })

  it("holds cancellation ownership until a result is known and preserves failed history", () => {
    const { store } = fixture()
    const operation = store.prepare(prepareFixture())
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    expect(store.cancel(operation.operationId).status).toBe("cancel_requested")
    expect(() => store.prepare(prepareFixture({ idempotencyKey: "retry" }))).toThrow(
      "OPERATION_ACTIVE"
    )
    expect(store.recordResult(ticket, { outcome: "cancelled", receipts: [] }).status).toBe(
      "cancelled"
    )
    expect(store.prepare(prepareFixture()).status).toBe("cancelled")
    const retry = store.prepare(prepareFixture({ idempotencyKey: "retry" }))
    store.recordResult(store.start(retry.operationId, TEST_FINGERPRINT), {
      outcome: "failed",
      receipts: []
    })
    expect(store.listOperations("local-docs").map((row) => row.status)).toEqual([
      "failed",
      "cancelled"
    ])
  })

  it("rejects unknown schema fields, identity owner changes, stale input and key reuse", () => {
    const { store, root } = fixture()
    expect(() =>
      store.create({
        ...hostProjectFixture(root),
        projectId: "another",
        manifest: { ...hostProjectFixture(root).manifest, mode: "legacy", stateOwner: "plugin" }
      })
    ).toThrow()
    expect(() =>
      store.create({ ...hostProjectFixture(root), projectId: "another", packageId: "forged" })
    ).toThrow()
    const operation = store.prepare(prepareFixture())
    expect(() => store.start(operation.operationId, "c".repeat(64))).toThrow("INPUT_CHANGED")
    expect(() => store.prepare(prepareFixture({ inputFingerprint: "c".repeat(64) }))).toThrow(
      "IDEMPOTENCY_CONFLICT"
    )
    expect(() =>
      store.prepare({ ...prepareFixture(), command: "shell" } as ReturnType<typeof prepareFixture>)
    ).toThrow("SCHEMA_INVALID")
  })

  it("fails closed on corrupted versioned state rather than replacing project history", () => {
    const { store, path } = fixture()
    const db = new DatabaseSync(path)
    const state = store.get("local-docs")!
    db.prepare("UPDATE host_projects SET data=? WHERE id=?").run(
      JSON.stringify({ ...state, schemaVersion: 2 }),
      state.projectId
    )
    db.close()
    expect(() => store.get("local-docs")).toThrow("SCHEMA_INVALID")
  })
})
