import { expect, it, vi } from "vitest"
import type { FlowRun } from "../../../shared/mods/flows/types"
import type { CompletionEvidenceRecord } from "../v2/completion-evidence"
import type { ModControlStore } from "../control-store"
import { bindingFingerprint } from "../v2/completion-evidence"
import { projectFlowExecutionEvidence } from "./execution-evidence"
import { promptReceiptFixture } from "./prompt-recovery-fixture"
import type { RecoveryHistoryRun } from "./recovery-history"

function fixture() {
  const { run } = promptReceiptFixture()
  const binding = {
    workspace: run.workspace,
    threadId: run.threadId,
    runId: run.id,
    turnId: run.id,
    pluginDigests: {},
    runtimeGeneration: 1,
    diffFingerprint: "diff",
    stateFingerprint: "state",
    requirementVersion: "requirement",
    configFingerprint: "config",
    files: []
  }
  run.attempts = [
    {
      executionId: "check-execution",
      stepId: "test",
      status: "passed",
      attempt: 1,
      epoch: 0,
      startedAt: 1001,
      finishedAt: 1005,
      outputFingerprint: bindingFingerprint(binding),
      result: {
        source: "native-check",
        passed: true,
        summary: "SECRET_OUTPUT",
        check: "unit-test",
        evidenceIds: ["receipt"]
      }
    }
  ]
  const record: CompletionEvidenceRecord = {
    id: "receipt",
    idempotencyKey: "receipt",
    workspace: run.workspace,
    threadId: run.threadId,
    runId: run.id,
    turnId: run.id,
    at: 1003,
    phase: "check.result",
    status: "pass",
    binding,
    detail: {
      source: "host-project-check",
      stepId: "test",
      executionId: "real-process",
      kind: "unit-test",
      passed: true,
      rawOutput: "SECRET_OUTPUT"
    }
  }
  const lookup = vi.fn<ModControlStore["completionEvidenceByIds"]>(() => ({
    records: [record],
    missingIds: [] as string[],
    invalidIds: [] as string[],
    limitedIds: [] as string[]
  }))
  const store = { completionEvidenceByIds: lookup }
  return { run, record, store, lookup, read: () => projectFlowExecutionEvidence(run, [run], store) }
}

it("links scoped native test facts while never exporting prompts, raw detail, output or bindings", () => {
  const f = fixture()
  const view = f.read()
  expect(view.attempts[0].checks[0]).toMatchObject({
    state: "found",
    kind: "native-project-test",
    check: "unit-test",
    status: "pass"
  })
  expect(f.lookup).toHaveBeenCalledExactlyOnceWith(f.run.workspace, f.run.threadId, f.run.id, [
    "receipt"
  ])
  expect(view.currentArtifacts).toBe("not-rechecked")
  expect(JSON.stringify(view)).not.toMatch(/SECRET_OUTPUT|pluginDigests|binding|prompt|summary/)
  expect(f.run.attempts[0].result?.summary).toBe("SECRET_OUTPUT")
})

it.each(["workspace", "threadId", "runId", "binding", "phase"])(
  "rejects mismatched %s returned by the storage boundary",
  (field) => {
    const f = fixture()
    Object.assign(f.record, {
      [field]: field === "binding" ? { ...f.record.binding, runId: "elsewhere" } : "elsewhere"
    })
    expect(f.read().attempts[0].checks[0]).toMatchObject({ state: "invalid", kind: "unknown" })
  }
)

it.each(["fingerprint", "time", "step", "check", "result"])(
  "does not upgrade an unrelated %s record to a native test",
  (field) => {
    const f = fixture()
    if (field === "fingerprint") f.run.attempts[0].outputFingerprint = "other"
    if (field === "time") f.record.at = 999
    if (field === "step") (f.record.detail as Record<string, unknown>).stepId = "other"
    if (field === "check") f.run.attempts[0].result!.check = "e2e"
    if (field === "result") f.run.attempts[0].result!.passed = false
    expect(f.read().attempts[0].checks[0]).toMatchObject({ state: "unlinked", kind: "unknown" })
  }
)

it("keeps plugin opinions, model assertions and approval separate from actual native checks", () => {
  const f = fixture()
  f.record.detail = { source: "guest-opinion-report", businessAccepted: false, passed: true }
  expect(f.read().attempts[0].checks[0].kind).toBe("plugin-opinion")
  f.run.attempts[0].result!.source = "agent"
  f.lookup.mockClear()
  expect(f.read().attempts[0].checks[0].state).toBe("unlinked")
  expect(f.lookup).not.toHaveBeenCalled()
  f.run.attempts[0].result!.source = "approval"
  expect(f.read().attempts[0].source).toBe("approval")
})

it("shows missing/corrupt/limited evidence and explicit truncation without optimistic totals", () => {
  const f = fixture()
  f.run.attempts[0].result!.evidenceIds = [
    "missing",
    "invalid",
    "limited",
    ...Array.from({ length: 30 }, (_, i) => `id-${i}`)
  ]
  f.lookup.mockReturnValue({
    records: [],
    missingIds: ["missing"],
    invalidIds: ["invalid"],
    limitedIds: ["limited"]
  })
  const view = f.read()
  expect(view.partial).toBe(true)
  expect(view.attempts[0].checks.slice(0, 3).map((r) => r.state)).toEqual([
    "missing",
    "invalid",
    "limited"
  ])
  expect(view.attempts[0].omittedChecks).toBe(17)
  f.run.attempts = Array.from({ length: 129 }, (_, i) => ({
    ...f.run.attempts[0],
    executionId: String(i)
  }))
  expect(f.read().omittedAttempts).toBe(1)
  expect(
    f.lookup.mock.calls.reduce((sum, call) => sum + (call[3]?.length ?? 0), 0)
  ).toBeLessThanOrEqual(144)
})

it("projects immutable copied text receipts and lineage without granting present recovery eligibility", () => {
  const f = promptReceiptFixture()
  f.attempt.recoveryEvidence = f.bind()
  const parent = f.run as RecoveryHistoryRun
  parent.recovery = {
    schemaVersion: 1,
    rootRunId: parent.id,
    consumedBy: "resumed",
    resumeCount: 0,
    rootDeadline: 61000,
    inheritedExecutions: 0
  }
  const child: RecoveryHistoryRun = {
    ...structuredClone(parent),
    id: "resumed",
    startedAt: 1006,
    recovery: {
      ...parent.recovery,
      consumedBy: undefined,
      parentRunId: parent.id,
      resumeCount: 1,
      inheritedExecutions: 1
    },
    attempts: [
      {
        ...structuredClone(f.attempt),
        reusedFrom: { runId: parent.id, executionId: f.attempt.executionId },
        invalidated: true
      }
    ]
  }
  const store = { completionEvidenceByIds: vi.fn() }
  const read = (history: FlowRun[]) => projectFlowExecutionEvidence(child, history, store)
  const view = read([parent, child])
  expect(view.lineage.state).toBe("linked")
  expect(view.attempts[0]).toMatchObject({
    historicalValidity: "invalidated",
    reusedFrom: { state: "linked" },
    receipt: { state: "recorded", originRunId: parent.id, modelCalls: 2 }
  })
  expect(read([child]).attempts[0].reusedFrom?.state).toBe("missing")
  child.attempts[0].result!.summary = "forged"
  expect(read([parent, child]).attempts[0].receipt.state).toBe("invalid")
  expect(store.completionEvidenceByIds).not.toHaveBeenCalled()
})

it("bounds malformed records and rejects duplicate history without leaking raw exceptions", () => {
  const f = fixture()
  expect(() => projectFlowExecutionEvidence(f.run, [f.run, f.run], f.store)).toThrow(
    "FLOW_EVIDENCE_HISTORY_INVALID"
  )
  f.run.attempts[0] = null as never
  expect(f.read()).toMatchObject({ partial: true, attempts: [{ receipt: { state: "invalid" } }] })
})

it("does not associate evidence with ambiguous duplicate execution identities", () => {
  const f = fixture()
  f.run.attempts.push(structuredClone(f.run.attempts[0]))
  expect(f.read()).toMatchObject({
    partial: true,
    attempts: [{ source: "unknown" }, { source: "unknown" }]
  })
  expect(f.lookup).not.toHaveBeenCalled()
})

it("shares one bounded scoped lookup across all native-check attempts", () => {
  const f = fixture()
  f.run.attempts = Array.from({ length: 128 }, (_, index) => ({
    ...f.run.attempts[0],
    executionId: `execution-${index}`,
    result: { ...f.run.attempts[0].result!, evidenceIds: [`receipt-${index}`] }
  }))
  f.lookup.mockReturnValue({
    records: [],
    missingIds: [],
    invalidIds: [],
    limitedIds: ["receipt-127"]
  })
  const view = f.read()
  expect(f.lookup).toHaveBeenCalledTimes(1)
  expect(f.lookup.mock.calls[0][3]).toHaveLength(128)
  expect(view.attempts[127].checks[0].state).toBe("limited")
})

it("keeps a failed native check historical and never treats completed markers as PASS", () => {
  const f = fixture()
  f.record.status = "block"
  Object.assign(f.record.detail!, { passed: false })
  f.run.attempts[0].status = "failed"
  f.run.attempts[0].result!.passed = false
  expect(f.read().attempts[0].checks[0]).toMatchObject({
    kind: "native-project-test",
    status: "block"
  })
  f.record.status = "completed"
  expect(f.read().attempts[0].checks[0]).toMatchObject({ state: "invalid", kind: "unknown" })
})
