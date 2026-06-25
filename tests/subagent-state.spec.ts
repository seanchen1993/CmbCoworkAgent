/**
 * Focused tests for subagent lifecycle state merging.
 *
 * Run:
 *   npx -y tsx tests/subagent-state.spec.ts
 */

import { resolveIncomingSubagentStatus } from "../src/renderer/src/lib/subagent-state"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

async function testTerminalStatusWinsOverStaleRunningSnapshot(): Promise<void> {
  const status = resolveIncomingSubagentStatus({
    incomingStatus: "running",
    existingStatus: "completed",
    parentStreamHasStopped: true
  })
  assert(status === "completed", "stale running snapshot must not overwrite completed status")
}

async function testRunningSnapshotIsCancelledAfterParentStops(): Promise<void> {
  const status = resolveIncomingSubagentStatus({
    incomingStatus: "running",
    parentStreamHasStopped: true
  })
  assert(status === "cancelled", "running subagent should become cancelled after parent stops")
}

async function testIncomingTerminalStatusStillApplies(): Promise<void> {
  const status = resolveIncomingSubagentStatus({
    incomingStatus: "failed",
    existingStatus: "running",
    parentStreamHasStopped: true
  })
  assert(status === "failed", "terminal incoming status should still be applied")
}

async function run(): Promise<void> {
  await testTerminalStatusWinsOverStaleRunningSnapshot()
  console.log("PASS subagent state preserves terminal status over stale running")
  await testRunningSnapshotIsCancelledAfterParentStops()
  console.log("PASS subagent state cancels running after parent stop")
  await testIncomingTerminalStatusStillApplies()
  console.log("PASS subagent state applies incoming terminal status")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
