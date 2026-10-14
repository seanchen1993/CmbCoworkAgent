import { describe, expect, it } from "vitest"
import type { FlowRun, SavedFlow } from "../../../shared/mods/flows/types"
import { flowDigest } from "../flows/store"
import {
  assertEvaluationSnapshotRun,
  bindEvaluationSnapshotRun,
  registerEvaluationSnapshotStart
} from "./snapshot-lease"
function fixture() {
  const definition: SavedFlow["definition"] = {
    schemaVersion: 2,
    id: "fixture",
    name: "Fixture",
    goal: "Fixed",
    timeoutMs: 1000,
    maxExecutions: 3,
    execution: { kind: "host", profile: "prompt-only-v1" },
    steps: [{ id: "agent", name: "Agent", enabled: true, kind: "agent", prompt: "Fixed" }]
  }
  const saved: SavedFlow = { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 }
  const run: FlowRun = {
    id: "owned",
    workspace: "workspace",
    threadId: "thread",
    flow: structuredClone(saved),
    status: "queued",
    startedAt: 1,
    epoch: 0,
    failureCounts: {},
    attempts: []
  }
  return { saved, run }
}
describe("private evaluation snapshot run lease", () => {
  it("requires exact start object and never trusts a fabricated persistent marker", () => {
    const { saved, run } = fixture()
    expect(assertEvaluationSnapshotRun(run)).toBe(false)
    const release = registerEvaluationSnapshotStart(
      saved,
      { workspace: "workspace", threadId: "thread", pairDigest: "a".repeat(64) },
      () => {}
    )
    try {
      bindEvaluationSnapshotRun(structuredClone(saved), run)
      expect(assertEvaluationSnapshotRun(run)).toBe(false)
      bindEvaluationSnapshotRun(saved, run)
      expect(assertEvaluationSnapshotRun(run)).toBe(true)
      expect(assertEvaluationSnapshotRun({ ...run, id: "another" })).toBe(false)
      expect(() => assertEvaluationSnapshotRun({ ...run, workspace: "other" })).toThrow(/INVALID/)
      expect(() => assertEvaluationSnapshotRun({ ...run, threadId: "other" })).toThrow(/INVALID/)
      expect(() => assertEvaluationSnapshotRun({ ...run, taskGoal: "other task" })).toThrow(
        /INVALID/
      )
      expect(() =>
        assertEvaluationSnapshotRun({ ...run, flow: { ...run.flow, revision: 2 } })
      ).toThrow(/INVALID/)
      expect(() => assertEvaluationSnapshotRun({ ...run, startedAt: 2 })).toThrow(/INVALID/)
      expect(() => assertEvaluationSnapshotRun({ ...run, epoch: 1 })).toThrow(/INVALID/)
      const changed = structuredClone(run)
      changed.flow.definition.goal = "changed"
      expect(() => assertEvaluationSnapshotRun(changed)).toThrow(/INVALID/)
    } finally {
      release()
    }
    expect(assertEvaluationSnapshotRun(run)).toBe(false)
  })
  it("rechecks source and cancellation on every current read and binds only one run", () => {
    const { saved, run } = fixture()
    let current = true
    const release = registerEvaluationSnapshotStart(
      saved,
      { workspace: "workspace", threadId: "thread", pairDigest: "a".repeat(64) },
      () => {
        if (!current) throw Error("FIXTURE_CHANGED")
      }
    )
    try {
      bindEvaluationSnapshotRun(saved, run)
      expect(() => bindEvaluationSnapshotRun(saved, { ...run, id: "borrowed" })).toThrow(/INVALID/)
      current = false
      expect(() => assertEvaluationSnapshotRun(run)).toThrow("FIXTURE_CHANGED")
    } finally {
      release()
    }
  })
})
