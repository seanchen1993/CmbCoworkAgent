import { describe, expect, it } from "vitest"
import type { FlowRun } from "../../../shared/mods/flows/types"
import type { ModControlStore } from "../control-store"
import { collectEvaluationObservation } from "./observations"

function fixture() {
  const root = "a".repeat(64),
    origin = "b".repeat(64)
  const run = {
    id: "flow_run",
    workspace: "workspace",
    threadId: "thread",
    status: "failed",
    startedAt: 1,
    finishedAt: 20,
    epoch: 0,
    failureCounts: {},
    fileNamespace: { schemaVersion: 1, treeId: "tree", initialRoot: root, originDigest: origin },
    flow: {
      digest: "c".repeat(64),
      revision: 1,
      updatedAt: 1,
      definition: {
        schemaVersion: 2,
        id: "flow",
        name: "Flow",
        goal: "Task",
        execution: { kind: "host", profile: "workspace-files-v1" },
        timeoutMs: 1000,
        maxExecutions: 3,
        steps: [{ id: "check", name: "Check", kind: "check", check: "unit-test", enabled: true }]
      }
    },
    attempts: [
      {
        executionId: "flow-attempt",
        stepId: "check",
        attempt: 1,
        epoch: 0,
        status: "failed",
        startedAt: 5,
        finishedAt: 15,
        inputFingerprint: root,
        outputFingerprint: root,
        result: {
          passed: false,
          summary: "ignored model text",
          source: "native-check",
          check: "unit-test",
          evidenceIds: ["check-evidence"]
        }
      }
    ]
  } as FlowRun
  const record = {
    id: "check-evidence",
    workspace: "workspace",
    threadId: "thread",
    runId: "flow_run",
    at: 10,
    phase: "check.result",
    status: "block",
    binding: {
      workspace: "workspace",
      threadId: "thread",
      runId: "flow_run",
      diffFingerprint: root,
      stateFingerprint: root,
      requirementVersion: origin
    },
    detail: {
      source: "host-virtual-tree-check",
      kind: "unit-test",
      stepId: "check",
      passed: false,
      executionId: "actual-native-process-not-flow-attempt",
      virtualRoot: root,
      originDigest: origin
    }
  }
  const lookup = ((workspace: string, thread: string, id: string, ids: readonly string[]) => ({
    records:
      workspace === record.workspace &&
      thread === record.threadId &&
      id === record.runId &&
      ids.includes(record.id)
        ? [record]
        : [],
    missingIds: [],
    invalidIds: [],
    limitedIds: []
  })) as unknown as ModControlStore["completionEvidenceByIds"]
  return { run, record, store: { completionEvidenceByIds: lookup } }
}
describe("host evaluation evidence", () => {
  it("recognizes an exact failed native virtual-tree check without equating process and Flow IDs", () => {
    const f = fixture(),
      observed = collectEvaluationObservation(f.run, "task", f.store)
    expect(observed.fact.result).toBe("failed")
    expect(observed.fact.evidenceIds).toEqual(["check-evidence"])
    expect(observed.fact.modelCalls).toBeNull()
    expect(observed.fact.inputTokens).toBeNull()
    expect(observed.environmentDigest).toBeNull()
  })
  it.each(["source", "virtualRoot", "originDigest", "stepId", "kind", "executionId"] as const)(
    "does not upgrade a changed %s field to a host check",
    (key) => {
      const f = fixture()
      f.record.detail[key] = key === "executionId" ? "" : "wrong"
      expect(collectEvaluationObservation(f.run, "task", f.store).fact.result).toBe("unknown")
    }
  )
  it.each(["workspace", "threadId", "runId"] as const)("requires exact %s", (key) => {
    const f = fixture()
    f.record[key] = "another"
    expect(collectEvaluationObservation(f.run, "task", f.store).fact.evidenceIds).toEqual([])
  })
  it("rejects after-attempt timestamps, stale output roots and invalidated check records", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.record.at = 16
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.attempts[0].outputFingerprint = "d".repeat(64)
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.attempts[0].invalidated = true
      }
    ]) {
      const f = fixture()
      change(f)
      expect(collectEvaluationObservation(f.run, "task", f.store).fact.result).toBe("unknown")
    }
  })
  it("model passed=true and a complete label cannot replace the actual runtime receipt", () => {
    const f = fixture()
    f.run.status = "complete"
    f.run.attempts[0].status = "passed"
    f.run.attempts[0].result!.passed = true
    f.record.status = "pass"
    f.record.detail.passed = true
    expect(collectEvaluationObservation(f.run, "task", f.store).fact.result).toBe("unknown")
    f.run.attempts[0].result!.source = "agent"
    expect(collectEvaluationObservation(f.run, "task", f.store).fact.evidenceIds).toEqual([])
  })
})
