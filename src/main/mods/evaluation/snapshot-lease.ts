import type { FlowRun, SavedFlow } from "../../../shared/mods/flows/types"
import { flowDigest } from "../flows/store"

interface Lease {
  workspace: string
  threadId: string
  digest: string
  pairDigest: string
  assertCurrent: () => void
  runId?: string
  executionDigest?: string
  released: boolean
}
const executionDigest = (run: FlowRun, pairDigest: string) =>
  flowDigest({
    pairDigest,
    workspace: run.workspace,
    threadId: run.threadId,
    runId: run.id,
    flow: run.flow,
    taskGoal: run.taskGoal ?? null,
    startedAt: run.startedAt,
    epoch: run.epoch
  })
const starts = new WeakMap<SavedFlow, Lease>()
const runs = new Map<string, Lease>()

/** Host-only start object identity. Data persisted in a Flow is never a lease. */
export function registerEvaluationSnapshotStart(
  saved: SavedFlow,
  binding: { workspace: string; threadId: string; pairDigest: string },
  assertCurrent: () => void
): () => void {
  if (starts.has(saved) || saved.digest !== flowDigest(saved.definition))
    throw Error("EVALUATION_SNAPSHOT_INVALID")
  assertCurrent()
  const lease: Lease = { ...binding, digest: saved.digest, assertCurrent, released: false }
  starts.set(saved, lease)
  return () => {
    lease.released = true
    starts.delete(saved)
    if (lease.runId && runs.get(lease.runId) === lease) runs.delete(lease.runId)
  }
}

/** FlowManager binds before scheduling execution, only for the exact registered object. */
export function bindEvaluationSnapshotRun(saved: SavedFlow, run: FlowRun): void {
  const lease = starts.get(saved)
  if (!lease) return
  lease.assertCurrent()
  if (
    lease.released ||
    lease.runId ||
    runs.has(run.id) ||
    run.workspace !== lease.workspace ||
    run.threadId !== lease.threadId ||
    run.flow.digest !== lease.digest ||
    flowDigest(run.flow.definition) !== lease.digest
  )
    throw Error("EVALUATION_SNAPSHOT_INVALID")
  lease.executionDigest = executionDigest(run, lease.pairDigest)
  lease.runId = run.id
  runs.set(run.id, lease)
}

/** No fallback for another run, restart, or a fabricated persistent snapshot marker. */
export function assertEvaluationSnapshotRun(run: FlowRun): boolean {
  const lease = runs.get(run.id)
  if (!lease) return false
  lease.assertCurrent()
  if (
    lease.released ||
    lease.executionDigest !== executionDigest(run, lease.pairDigest) ||
    run.workspace !== lease.workspace ||
    run.threadId !== lease.threadId ||
    run.flow.digest !== lease.digest ||
    flowDigest(run.flow.definition) !== lease.digest
  )
    throw Error("EVALUATION_SNAPSHOT_INVALID")
  return true
}
