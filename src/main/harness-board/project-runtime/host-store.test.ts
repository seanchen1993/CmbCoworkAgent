import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { HostProjectStore } from "./host-store"
import { hostResultReview, parseHostOperation } from "./host-state-protocol"
import { boundHostCheckDiagnostic } from "./host-check-diagnostics"
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
  it("freezes explicit stage instructions across reopen and idempotency without inheriting them", () => {
    const { store, path } = fixture()
    const project = store.get("local-docs")
    const operation = store.prepare({ ...prepareFixture(), stageInstructions: "  Review the boundary.\n保留检查。  " })
    expect(operation.stageInstructions).toBe("Review the boundary.\n保留检查。")
    const cold = openStore(path)
    expect(cold.getOperation(operation.operationId)?.stageInstructions).toBe(operation.stageInstructions)
    expect(cold.prepare({ ...prepareFixture(), stageInstructions: operation.stageInstructions })).toEqual(operation)
    expect(() => cold.prepare(prepareFixture())).toThrow("IDEMPOTENCY_CONFLICT")
    expect(() => cold.prepare({ ...prepareFixture(), stageInstructions: "Changed" })).toThrow("IDEMPOTENCY_CONFLICT")
    expect(() => cold.prepare({ ...prepareFixture(), idempotencyKey: "active", stageInstructions: "New" }))
      .toThrow("OPERATION_ACTIVE")
    cold.cancel(operation.operationId)
    const next = cold.prepare({ ...prepareFixture(), idempotencyKey: "explicit-next" })
    expect(next.stageInstructions).toBeUndefined()
    expect(next.approval).toBeNull()
    expect(next.receipts).toEqual([])
    expect(cold.get("local-docs")).toEqual(project)
    expect(() => parseHostOperation({ ...next, stageInstructions: " Unnormalized " }))
      .toThrow("STAGE_INSTRUCTIONS_INVALID")
  })

  it.each(["", " \n\t ", "x".repeat(4001), "bad\u0000text", 3, null])(
    "rejects invalid supplemental stage instructions %j", value => {
      const { store } = fixture()
      expect(() => store.prepare({ ...prepareFixture(), stageInstructions: value as string }))
        .toThrow("STAGE_INSTRUCTIONS_INVALID")
    }
  )

  it("does not allow supplemental instructions to replay an unknown operation", () => {
    const { store } = fixture()
    const operation = store.prepare({ ...prepareFixture(), stageInstructions: "Original instruction" })
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    store.recordResult(ticket, { outcome: "unknown", receipts: [] })
    expect(() => store.prepare({ ...prepareFixture(), idempotencyKey: "retry", stageInstructions: "Retry" }))
      .toThrow("OPERATION_ACTIVE")
    expect(store.getOperation(operation.operationId)?.stageInstructions).toBe("Original instruction")
  })

  it("persists original failure diagnostics across reopen without creating a validation receipt or success", () => {
    const root = mkdtempSync(join(tmpdir(), "host-failed-check-store-"))
    roots.push(root)
    const path = join(root, "state.sqlite")
    const store = openStore(path)
    const creation = hostProjectFixture(root)
    const provider = { pluginId: "checker-installation", plugin: "checker", digest: "c".repeat(64), actionId: "check" }
    creation.manifest.actions = [{ id: "validate", ref: provider }]
    creation.manifest.checks[0] = { id: "document-exists", artifactId: "document",
      kind: "action", actionId: "validate", sideEffect: "read" }
    store.create(creation)
    const operation = store.prepare(prepareFixture())
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    store.bindExecutionThread(ticket, "original-thread")
    const diagnostic = boundHostCheckDiagnostic({ checkId: "document-exists", actionId: "validate",
      provider, runId: "original-flow", executionId: "original-execution",
      inputFingerprint: TEST_FINGERPRINT, resultDigest: "d".repeat(64)
    }, "check failed", { errors: [{ code: "INVALID_SOURCE", detail: "version must be 1" }] })
    expect(() => store.recordExecutionTerminal(ticket, { outcome: "success", code: "forged",
      checkDiagnostics: [diagnostic] })).toThrow("CHECK_DIAGNOSTICS_INVALID")
    expect(() => store.recordExecutionTerminal(ticket, { outcome: "error", code: "project_checks_failed",
      checkDiagnostics: [{ ...diagnostic, provider: { ...provider, pluginId: "other" } }] }))
      .toThrow("CHECK_DIAGNOSTICS_INVALID")
    store.recordExecutionTerminal(ticket, { outcome: "error", code: "project_checks_failed",
      checkDiagnostics: [diagnostic] })
    store.recordResult(ticket, { outcome: "failed", receipts: [] })
    const cold = openStore(path)
    const result = cold.getOperation(operation.operationId)!
    expect(result.status).toBe("failed")
    expect(result.receipts).toEqual([])
    expect(result.execution?.terminal?.checkDiagnostics).toEqual([diagnostic])
    expect(() => cold.transition(operation.operationId, TEST_FINGERPRINT)).toThrow()
    const mismatched = structuredClone(result)
    mismatched.execution!.terminal!.checkDiagnostics![0].inputFingerprint = "e".repeat(64)
    expect(() => parseHostOperation(mismatched)).toThrow("CHECK_DIAGNOSTICS_INVALID")
  })

  it("normalizes historical operations without result approval without accepting unknown fields", () => {
    const { store } = fixture()
    const operation = store.prepare(prepareFixture())
    const historical = { ...operation }
    delete historical.resultApproval
    expect(parseHostOperation(historical).resultApproval).toBeNull()
    expect(() => parseHostOperation({ ...historical, implicitResultApproval: true })).toThrow(
      "SCHEMA_INVALID"
    )
  })

  it("requires a separate exact result binding even after execution was approved", () => {
    const root = mkdtempSync(join(tmpdir(), "host-result-store-"))
    roots.push(root)
    const store = openStore(join(root, "state.sqlite"))
    const creation = hostProjectFixture(root)
    creation.manifest.stages[0].approval = "human"
    creation.manifest.stages[0].resultApproval = "human"
    const project = store.create(creation)
    const operation = store.prepare(prepareFixture())
    store.decideApproval(operation.operationId, {
      expectedVersion: 1,
      inputFingerprint: TEST_FINGERPRINT,
      decision: "approved",
      actorId: "user"
    })
    const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
    const settled = store.recordResult(ticket, {
      outcome: "succeeded",
      receipts: [receiptFixture(ticket)]
    })
    const review = hostResultReview(project, settled, "d".repeat(64))
    expect(() => store.transition(operation.operationId, TEST_FINGERPRINT, review)).toThrow(
      "RESULT_APPROVAL_REQUIRED"
    )
    expect(() =>
      store.decideResultApproval(operation.operationId, {
        ...review,
        receiptFingerprint: "f".repeat(64),
        decision: "approved",
        actorId: "user"
      })
    ).toThrow("RESULT_APPROVAL_MISMATCH")
    store.decideResultApproval(operation.operationId, {
      ...review,
      decision: "approved",
      actorId: "user"
    })
    expect(() =>
      store.transition(operation.operationId, TEST_FINGERPRINT, {
        ...review,
        artifactFingerprint: "f".repeat(64)
      })
    ).toThrow("RESULT_APPROVAL_MISMATCH")
    expect(store.transition(operation.operationId, TEST_FINGERPRINT, review).version).toBe(2)
    expect(store.transition(operation.operationId, TEST_FINGERPRINT).version).toBe(2)
  })

  it("binds separate context-script consent to the exact durable operation even for automatic stages", () => {
    const f = fixture()
    const contextProvider = {
      protocol: "devclaw.context-text/v1" as const,
      policyDigest: "a".repeat(64),
      notice: "Provider may access a network; approve this exact operation."
    }
    const operation = f.store.prepare({ ...prepareFixture(), contextProvider })
    expect(() => f.store.start(operation.operationId, TEST_FINGERPRINT)).toThrow(
      "CONTEXT_PROVIDER_APPROVAL_REQUIRED"
    )
    const approval = {
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved" as const,
      actorId: "native-user"
    }
    expect(() => f.store.decideApproval(operation.operationId, approval)).toThrow(
      "CONTEXT_PROVIDER_APPROVAL_REQUIRED"
    )
    expect(() =>
      f.store.decideApproval(operation.operationId, {
        ...approval,
        contextProviderApproval: { policyDigest: "b".repeat(64), allowNetworkSideEffects: true }
      })
    ).toThrow("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
    f.store.decideApproval(operation.operationId, {
      ...approval,
      contextProviderApproval: {
        policyDigest: contextProvider.policyDigest,
        allowNetworkSideEffects: true
      }
    })
    const cold = openStore(f.path)
    expect(cold.getOperation(operation.operationId)).toMatchObject({
      contextProvider,
      approval: {
        contextProviderApproval: {
          policyDigest: contextProvider.policyDigest,
          allowNetworkSideEffects: true
        }
      }
    })
    expect(cold.start(operation.operationId, TEST_FINGERPRINT)).toMatchObject({
      operationId: operation.operationId
    })
  })
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
