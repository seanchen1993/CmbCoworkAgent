/**
 * Focused tests for subagent lifecycle state merging.
 *
 * Run:
 *   npx -y tsx tests/subagent-state.spec.ts
 */

import {
  orderSubagentsForDisplay,
  resolveIncomingSubagentStatus
} from "../src/renderer/src/lib/subagent-state"
import type { Subagent } from "../src/renderer/src/types"

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

async function testRunningSubagentsAreDisplayedFirstWithoutReorderingGroups(): Promise<void> {
  const subagents: Subagent[] = [
    {
      id: "done-old",
      name: "done-old",
      description: "",
      status: "completed",
      completedAt: new Date("2026-09-01T08:00:00.000Z")
    },
    { id: "running-1", name: "running-1", description: "", status: "running" },
    {
      id: "failed-new",
      name: "failed-new",
      description: "",
      status: "failed",
      completedAt: new Date("2026-09-01T09:00:00.000Z")
    },
    { id: "running-2", name: "running-2", description: "", status: "running" },
    { id: "pending-1", name: "pending-1", description: "", status: "pending" },
    {
      id: "cancelled-middle",
      name: "cancelled-middle",
      description: "",
      status: "cancelled",
      completedAt: new Date("2026-09-01T08:30:00.000Z")
    }
  ]

  const ordered = orderSubagentsForDisplay(subagents)
  assert(
    ordered.map((subagent) => subagent.id).join(",") ===
      "running-1,running-2,pending-1,failed-new,cancelled-middle,done-old",
    "running and pending subagents should come first, followed by newest terminal history"
  )
  assert(
    subagents[0].id === "done-old",
    "display ordering must not mutate the thread state's subagent array"
  )

  const fallbackOrdered = orderSubagentsForDisplay([
    { id: "fallback-old", name: "fallback-old", description: "", status: "completed" },
    { id: "fallback-new", name: "fallback-new", description: "", status: "completed" }
  ])
  assert(
    fallbackOrdered.map((subagent) => subagent.id).join(",") ===
      "fallback-new,fallback-old",
    "terminal history without timestamps should treat later appended cards as newer"
  )
}

async function run(): Promise<void> {
  await testTerminalStatusWinsOverStaleRunningSnapshot()
  console.log("PASS subagent state preserves terminal status over stale running")
  await testRunningSnapshotIsCancelledAfterParentStops()
  console.log("PASS subagent state cancels running after parent stop")
  await testIncomingTerminalStatusStillApplies()
  console.log("PASS subagent state applies incoming terminal status")
  await testRunningSubagentsAreDisplayedFirstWithoutReorderingGroups()
  console.log("PASS subagent display order prioritizes running work")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
