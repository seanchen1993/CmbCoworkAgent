/**
 * Unit tests for thread checkpoint cleanup helpers.
 *
 * Run:
 *   npx -y tsx tests/thread-checkpoint-cleanup.spec.ts
 */

import { existsSync, writeFileSync, unlinkSync } from "fs"
import {
  deleteThreadCheckpoint,
  deleteThreadWorkerCheckpoints,
  deleteThreadWorkflowCheckpoints,
  getThreadCheckpointPath,
  purgeThreadCheckpointArtifacts
} from "../src/main/storage.ts"

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

try {
  run()
  runSidecarAndQuarantineCleanup()
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
