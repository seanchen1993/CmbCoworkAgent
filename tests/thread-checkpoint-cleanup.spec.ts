/**
 * Unit tests for thread checkpoint cleanup helpers.
 *
 * Run:
 *   npx -y tsx tests/thread-checkpoint-cleanup.spec.ts
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import {
  deleteThreadCheckpoint,
  deleteThreadWorkerCheckpoints,
  deleteThreadWorkflowCheckpoints,
  getThreadCheckpointArtifactDirectoryScanCount,
  getThreadCheckpointPath,
  purgeThreadCheckpointArtifacts
} from "../src/main/storage.ts"
import { registerSqliteQuarantineArtifact } from "../src/main/utils/sqlite-durable-file.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Best-effort cleanup for test scratch files.
  }
}

function run(): void {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const parentThreadId = `cleanup-${suffix}`
  const workerThreadIdA = `${parentThreadId}__worker__implementer-${suffix}-1`
  const workerThreadIdB = `${parentThreadId}__worker__verifier-${suffix}-2`
  const wfThreadIdA = `${parentThreadId}__wf_run${suffix}_a1`
  const wfThreadIdB = `${parentThreadId}__wf_run${suffix}_a2`
  const unrelatedThreadId = `unrelated-${suffix}__worker__implementer-${suffix}-1`

  const parentPath = getThreadCheckpointPath(parentThreadId)
  const workerPathA = getThreadCheckpointPath(workerThreadIdA)
  const workerPathB = getThreadCheckpointPath(workerThreadIdB)
  const wfPathA = getThreadCheckpointPath(wfThreadIdA)
  const wfPathB = getThreadCheckpointPath(wfThreadIdB)
  const unrelatedPath = getThreadCheckpointPath(unrelatedThreadId)

  try {
    writeFileSync(parentPath, "parent")
    writeFileSync(workerPathA, "worker-a")
    writeFileSync(workerPathB, "worker-b")
    writeFileSync(wfPathA, "wf-a")
    writeFileSync(wfPathB, "wf-b")
    writeFileSync(unrelatedPath, "unrelated")

    // __wf_ (workflow subagent) cleanup must remove ONLY __wf_ files, leaving the
    // coordinator __worker__ files, the parent, and unrelated threads intact. (#3)
    const deletedWf = deleteThreadWorkflowCheckpoints(parentThreadId)
    assert(deletedWf === 2, "workflow checkpoint cleanup should delete matching __wf_ files")
    assert(!existsSync(wfPathA), "workflow checkpoint A should be removed")
    assert(!existsSync(wfPathB), "workflow checkpoint B should be removed")
    assert(existsSync(workerPathA), "workflow cleanup must NOT touch coordinator __worker__ files")
    assert(existsSync(parentPath), "workflow cleanup should keep the parent checkpoint")
    assert(existsSync(unrelatedPath), "workflow cleanup should keep unrelated threads")

    const deleted = deleteThreadWorkerCheckpoints(parentThreadId)
    assert(deleted === 2, "worker checkpoint cleanup should delete matching worker files")
    assert(existsSync(parentPath), "worker checkpoint cleanup should keep parent checkpoint")
    assert(existsSync(unrelatedPath), "worker checkpoint cleanup should keep unrelated workers")
    assert(!existsSync(workerPathA), "worker checkpoint A should be removed")
    assert(!existsSync(workerPathB), "worker checkpoint B should be removed")

    deleteThreadCheckpoint(parentThreadId)
    assert(!existsSync(parentPath), "parent checkpoint helper should still remove parent only")

    let threwReservedDelimiter = false
    try {
      deleteThreadWorkerCheckpoints(`${parentThreadId}__worker__legacy`)
    } catch (error) {
      threwReservedDelimiter =
        error instanceof Error && error.message.includes("reserved __worker__ delimiter")
    }
    assert(
      threwReservedDelimiter,
      "worker checkpoint cleanup should reject parent thread ids that contain the reserved delimiter"
    )

    let threwReservedWfDelimiter = false
    try {
      deleteThreadWorkflowCheckpoints(`${parentThreadId}__wf_legacy`)
    } catch (error) {
      threwReservedWfDelimiter =
        error instanceof Error && error.message.includes("reserved __wf_ delimiter")
    }
    assert(
      threwReservedWfDelimiter,
      "workflow checkpoint cleanup should reject parent thread ids that contain the reserved __wf_ delimiter"
    )
  } finally {
    safeUnlink(parentPath)
    safeUnlink(workerPathA)
    safeUnlink(workerPathB)
    safeUnlink(wfPathA)
    safeUnlink(wfPathB)
    safeUnlink(unrelatedPath)
  }

  console.log("PASS thread worker + workflow checkpoint cleanup")
}

/** Privacy-residue regression: deleting a thread must remove EVERY on-disk form
 * of its transcript — the live .sqlite, durable recovery sidecars (.bak/.tmp/
 * .flush.tmp/.bak.tmp) AND quarantine archives (.corrupt.<ts> / .bak.<ts>),
 * which are not recovery candidates but still hold full checkpoint data.
 * Fixes-forward for the dcafb3d1 durable-file introduction. */
function runSidecarAndQuarantineCleanup(): void {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const parentThreadId = `privacy-${suffix}`
  const workerThreadId = `${parentThreadId}__worker__impl-${suffix}-1`
  const wfThreadId = `${parentThreadId}__wf_run${suffix}_a1`

  const allPaths: string[] = []
  const fabricate = (threadId: string): string[] => {
    const base = getThreadCheckpointPath(threadId)
    const variants = [
      base,
      `${base}.bak`,
      `${base}.tmp`,
      `${base}.flush.tmp`,
      `${base}.bak.tmp`,
      `${base}.corrupt.1719999999`,
      `${base}.bak.1719999999`
    ]
    for (const path of variants) writeFileSync(path, threadId)
    for (const path of variants.slice(5)) registerSqliteQuarantineArtifact(base, path)
    allPaths.push(...variants)
    return variants
  }

  try {
    const parentVariants = fabricate(parentThreadId)
    const workerVariants = fabricate(workerThreadId)
    const wfVariants = fabricate(wfThreadId)

    // Fast path (subagent finally): removes durable variants, leaves quarantine
    // (privacy cleanup belongs to the cold thread-deletion path).
    const durableOnly = parentVariants.slice(0, 5)
    const quarantineOnly = parentVariants.slice(5)
    deleteThreadCheckpoint(parentThreadId)
    for (const path of durableOnly) {
      assert(!existsSync(path), `deleteThreadCheckpoint must remove ${path}`)
    }
    for (const path of quarantineOnly) {
      assert(existsSync(path), `fast path must NOT scan for quarantine: ${path}`)
    }

    // Deep path (user deletes the thread): quarantine goes too.
    purgeThreadCheckpointArtifacts(parentThreadId)
    for (const path of parentVariants) {
      assert(!existsSync(path), `purgeThreadCheckpointArtifacts must remove ${path}`)
    }
    // Exact-id cleanup must not touch the sub-thread files.
    assert(existsSync(workerVariants[0]), "parent cleanup must not touch worker files")

    const deletedWorkers = deleteThreadWorkerCheckpoints(parentThreadId)
    assert(deletedWorkers === 1, "worker sweep should count one checkpoint")
    for (const path of workerVariants) {
      assert(!existsSync(path), `worker sweep must remove ${path}`)
    }

    const deletedWf = deleteThreadWorkflowCheckpoints(parentThreadId)
    assert(deletedWf === 1, "workflow sweep should count one checkpoint")
    for (const path of wfVariants) {
      assert(!existsSync(path), `workflow sweep must remove ${path}`)
    }
  } finally {
    for (const path of allPaths) safeUnlink(path)
  }

  console.log("PASS sidecar + quarantine privacy cleanup")
}

/** Performance contract: one lazy directory index serves an entire large
 * deletion batch. Cleanup work should scale with the deleted families, not
 * rescan every checkpoint file once per parent and once per subtype. */
function runIndexedBatchCleanup(): void {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const parents = Array.from({ length: 48 }, (_, index) => `batch-${suffix}-${index}`)
  const allPaths: string[] = []

  try {
    for (const parentThreadId of parents) {
      const workerThreadId = `${parentThreadId}__worker__impl-${suffix}`
      const workflowThreadId = `${parentThreadId}__wf_run${suffix}_a1`
      const parentPath = getThreadCheckpointPath(parentThreadId)
      const workerPath = getThreadCheckpointPath(workerThreadId)
      const workflowPath = getThreadCheckpointPath(workflowThreadId)
      const workerQuarantinePath = `${workerPath}.corrupt.1719999999`
      for (const path of [parentPath, workerPath, workflowPath, workerQuarantinePath]) {
        writeFileSync(path, parentThreadId)
        allPaths.push(path)
      }
      registerSqliteQuarantineArtifact(workerPath, workerQuarantinePath)
    }

    const scansBefore = getThreadCheckpointArtifactDirectoryScanCount()
    for (const parentThreadId of parents) {
      purgeThreadCheckpointArtifacts(parentThreadId)
      assert(
        deleteThreadWorkerCheckpoints(parentThreadId) === 1,
        "indexed worker cleanup should remove exactly one worker checkpoint"
      )
      assert(
        deleteThreadWorkflowCheckpoints(parentThreadId) === 1,
        "indexed workflow cleanup should remove exactly one workflow checkpoint"
      )
    }
    const scanDelta = getThreadCheckpointArtifactDirectoryScanCount() - scansBefore
    assert(
      scanDelta <= 1,
      `48 family deletions must share at most one checkpoint-directory scan, got ${scanDelta}`
    )
    for (const path of allPaths) {
      assert(!existsSync(path), `indexed batch cleanup must remove ${path}`)
    }
  } finally {
    for (const path of allPaths) safeUnlink(path)
  }

  console.log("PASS indexed batch cleanup avoids repeated global directory scans")
}

/** No background/deferred sweep is allowed: after the old cleanup returns, a
 * legitimate same-id incarnation must remain untouched by later unrelated
 * family cleanup. */
function runSameIdRecreationIsolation(): void {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const reusedThreadId = `reused-${suffix}`
  const unrelatedParentId = `unrelated-recreate-${suffix}`
  const unrelatedWorkerId = `${unrelatedParentId}__worker__impl-${suffix}`
  const reusedPath = getThreadCheckpointPath(reusedThreadId)
  const unrelatedWorkerPath = getThreadCheckpointPath(unrelatedWorkerId)

  try {
    writeFileSync(reusedPath, "old-incarnation")
    purgeThreadCheckpointArtifacts(reusedThreadId)
    assert(!existsSync(reusedPath), "old incarnation should be gone when cleanup returns")

    // getThreadCheckpointPath is the same registration point used by every new
    // production saver, including a revived fixed-id service thread.
    writeFileSync(getThreadCheckpointPath(reusedThreadId), "new-incarnation")
    writeFileSync(unrelatedWorkerPath, "unrelated")
    deleteThreadWorkerCheckpoints(unrelatedParentId)

    assert(existsSync(reusedPath), "unrelated old-family cleanup must not delete a revived id")
    assert(
      readFileSync(reusedPath, "utf8") === "new-incarnation",
      "the revived checkpoint contents must remain intact"
    )
  } finally {
    deleteThreadCheckpoint(reusedThreadId)
    safeUnlink(reusedPath)
    safeUnlink(unrelatedWorkerPath)
  }

  console.log("PASS same-id recreation remains isolated from prior cleanup")
}

/** A late old-saver recovery may quarantine a worker DB after a parent sweep
 * already observed no files and forgot that family member. Registration must
 * synchronously put the member back; a generic path registry alone is not
 * enumerable from the parent id and would leave transcript-bearing residue. */
function runLateWorkerQuarantineRegistration(): void {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const parentThreadId = `late-quarantine-${suffix}`
  const workerThreadId = `${parentThreadId}__worker__impl-${suffix}`
  const workerPath = getThreadCheckpointPath(workerThreadId)
  const quarantinePath = `${workerPath}.corrupt.1719999999`

  try {
    assert(
      deleteThreadWorkerCheckpoints(parentThreadId) === 0,
      "the first sweep should forget a registered worker that owns no artifacts"
    )

    writeFileSync(quarantinePath, "late old-incarnation quarantine")
    registerSqliteQuarantineArtifact(workerPath, quarantinePath)
    // Mirrors the post-initialize refusal cleanup: durable variants are gone,
    // but privacy quarantine must remain indexed for its parent's deep sweep.
    deleteThreadCheckpoint(workerThreadId)

    assert(
      deleteThreadWorkerCheckpoints(parentThreadId) === 1,
      "a late quarantine registration must restore the worker family membership"
    )
    assert(!existsSync(quarantinePath), "the restored family sweep must remove late quarantine")
  } finally {
    safeUnlink(quarantinePath)
  }

  console.log("PASS late worker quarantine registration restores family membership")
}

/** Preserve the old prefix-sweep semantics when a generated checkpoint id
 * contains both reserved delimiters: the delimiter nearest the root parent
 * determines which family owns it. */
function runNestedDelimiterFamilyCleanup(): void {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const parentThreadId = `nested-family-${suffix}`
  const workflowNestedId = `${parentThreadId}__wf_run${suffix}_a1__worker__nested`
  const workerNestedId = `${parentThreadId}__worker__impl-${suffix}__wf_nested_a1`
  const workflowNestedPath = getThreadCheckpointPath(workflowNestedId)
  const workerNestedPath = getThreadCheckpointPath(workerNestedId)

  try {
    writeFileSync(workflowNestedPath, "workflow-rooted")
    writeFileSync(workerNestedPath, "worker-rooted")
    assert(
      deleteThreadWorkflowCheckpoints(parentThreadId) === 1,
      "the earliest workflow delimiter must keep the nested id in the root workflow family"
    )
    assert(!existsSync(workflowNestedPath), "workflow-rooted nested checkpoint must be deleted")
    assert(existsSync(workerNestedPath), "workflow sweep must not consume worker-rooted checkpoint")
    assert(
      deleteThreadWorkerCheckpoints(parentThreadId) === 1,
      "the earliest worker delimiter must keep the nested id in the root worker family"
    )
    assert(!existsSync(workerNestedPath), "worker-rooted nested checkpoint must be deleted")
  } finally {
    safeUnlink(workflowNestedPath)
    safeUnlink(workerNestedPath)
  }

  console.log("PASS nested delimiter ids preserve root family cleanup semantics")
}

try {
  runIndexedBatchCleanup()
  run()
  runSidecarAndQuarantineCleanup()
  runSameIdRecreationIsolation()
  runLateWorkerQuarantineRegistration()
  runNestedDelimiterFamilyCleanup()
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
