/**
 * Coordinator worker inactivity watchdog — pure decision logic.
 *
 * The watchdog exists because a worker whose model call stalls mid-stream has
 * no other exit: the fetch timeout covers only up to the first byte, so the
 * record would stay "running" forever and everything downstream (coordinator
 * notification turn, goal defer guard, busy guards) would wait forever.
 *
 * The sweep loop reuses cancelRecord (the battle-tested parent-abort terminal
 * path), so these tests pin the DECISION function and the window resolution —
 * the parts with actual logic.
 *
 * Run:
 *   npx tsx tests/coordinator-worker-watchdog.spec.ts
 */

import { mkdir, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  CoordinatorWorkerManager,
  getCoordinatorWorkerInactivityMs,
  isWorkerAwaitingTerminalNotification,
  isWorkerInactiveForWatchdog,
  type CoordinatorWorkerStatus
} from "../src/main/agent/coordinator-worker-manager.ts"
import { getWorkflowRunWallClockMs } from "../src/main/agent/workflow/types.ts"
import { approvalMatchesRuntimeThread } from "../src/main/agent/approval-thread-match.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

const NOW = Date.parse("2026-07-16T12:00:00.000Z")
const WINDOW = 2 * 60 * 60 * 1000 // 2h

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString()
}

function worker(overrides: {
  status?: CoordinatorWorkerStatus
  lastActivityAt?: string
  lastStartedAt?: string
  updatedAt?: string
  createdAt?: string
}): {
  status: CoordinatorWorkerStatus
  lastActivityAt?: string
  lastStartedAt?: string
  updatedAt: string
  createdAt: string
} {
  return {
    status: overrides.status ?? "running",
    lastActivityAt: overrides.lastActivityAt,
    lastStartedAt: overrides.lastStartedAt,
    updatedAt: overrides.updatedAt ?? iso(3 * 60 * 60 * 1000),
    createdAt: overrides.createdAt ?? iso(4 * 60 * 60 * 1000)
  }
}

function testRunningStaleIsInactive(): void {
  assert(
    isWorkerInactiveForWatchdog(
      worker({ lastActivityAt: iso(WINDOW + 60_000) }),
      NOW,
      WINDOW
    ),
    "running worker idle past the window must be flagged inactive"
  )
}

function testRunningFreshIsNotInactive(): void {
  assert(
    !isWorkerInactiveForWatchdog(worker({ lastActivityAt: iso(60_000) }), NOW, WINDOW),
    "running worker with recent activity must not be flagged"
  )
  // Long-quiet-but-inside-window (e.g. a 30min build with no stream events).
  assert(
    !isWorkerInactiveForWatchdog(
      worker({ lastActivityAt: iso(30 * 60 * 1000) }),
      NOW,
      WINDOW
    ),
    "a long quiet period inside the window must not be flagged"
  )
}

function testExactWindowBoundaryIsNotInactive(): void {
  assert(
    !isWorkerInactiveForWatchdog(worker({ lastActivityAt: iso(WINDOW) }), NOW, WINDOW),
    "idle time exactly equal to the window must not be flagged (strict >)"
  )
}

function testTerminalStatusesNeverFlagged(): void {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert(
      !isWorkerInactiveForWatchdog(
        worker({ status, lastActivityAt: iso(10 * WINDOW) }),
        NOW,
        WINDOW
      ),
      `${status} worker must never be flagged regardless of idle time`
    )
  }
}

function testTimestampFallbackChain(): void {
  // No lastActivityAt -> falls back to lastStartedAt.
  assert(
    isWorkerInactiveForWatchdog(
      worker({ lastStartedAt: iso(WINDOW + 60_000) }),
      NOW,
      WINDOW
    ),
    "missing lastActivityAt must fall back to a stale lastStartedAt"
  )
  assert(
    !isWorkerInactiveForWatchdog(worker({ lastStartedAt: iso(60_000) }), NOW, WINDOW),
    "missing lastActivityAt with a fresh lastStartedAt must not be flagged"
  )
  // No lastActivityAt/lastStartedAt -> falls back to updatedAt.
  assert(
    isWorkerInactiveForWatchdog(
      worker({ updatedAt: iso(WINDOW + 60_000) }),
      NOW,
      WINDOW
    ),
    "missing activity stamps must fall back to a stale updatedAt"
  )
  assert(
    !isWorkerInactiveForWatchdog(worker({ updatedAt: iso(60_000) }), NOW, WINDOW),
    "fresh updatedAt fallback must not be flagged"
  )
}

function testUnparseableTimestampFallsBackToParseableOnes(): void {
  // A hung worker never writes again, so a corrupt lastActivityAt must not shield
  // it forever: the fallback walks to the next PARSEABLE stamp.
  assert(
    isWorkerInactiveForWatchdog(
      worker({ lastActivityAt: "not-a-date", lastStartedAt: iso(WINDOW + 60_000) }),
      NOW,
      WINDOW
    ),
    "corrupt lastActivityAt must fall back to a stale parseable lastStartedAt"
  )
  assert(
    !isWorkerInactiveForWatchdog(
      worker({ lastActivityAt: "not-a-date", lastStartedAt: iso(60_000) }),
      NOW,
      WINDOW
    ),
    "corrupt lastActivityAt with a fresh parseable lastStartedAt must not be flagged"
  )
  // Only when EVERY stamp is unreadable do we decline to terminate.
  assert(
    !isWorkerInactiveForWatchdog(
      worker({
        lastActivityAt: "not-a-date",
        lastStartedAt: "also-bad",
        updatedAt: "nope",
        createdAt: "still-nope"
      }),
      NOW,
      WINDOW
    ),
    "all-corrupt timestamps must never terminate a worker"
  )
}

async function testWatchdogReleasesHungWorkerConcurrencySlot(): Promise<void> {
  // Integration: the exact chain the watchdog exists for — a runner that NEVER
  // settles. The sweep must (1) cancel the hung worker and (2) release its
  // concurrency slot (occupiesWorkerConcurrencySlot counts a lingering
  // currentRun), or a hung write worker would block verify/write workers on the
  // parent forever even after cancellation.
  const workspace = await mkdtemp(join(tmpdir(), "coordinator-watchdog-"))
  const savedWindow = process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
  process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = "60000"
  const parentThreadId = "thread-watchdog-hung-slot"
  try {
    const manager = new CoordinatorWorkerManager()
    const hung = manager.startWorker({
      parentThreadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      description: "hangs forever mid-stream",
      prompt: "hang",
      runner: () => new Promise(() => {})
    })

    let refusedWhileRunning = false
    try {
      manager.startWorker({
        parentThreadId,
        workspacePath: workspace,
        role: "verifier",
        workload: "verify",
        description: "verify while writer runs",
        prompt: "verify",
        runner: async () => ({ summary: "ok" })
      })
    } catch {
      refusedWhileRunning = true
    }
    assert(refusedWhileRunning, "verify worker must be refused while the write worker runs")

    // Drive one watchdog pass from a future clock beyond the 60s window.
    manager.sweepInactiveWorkers(Date.now() + 120_000)

    const afterSweep = manager.readWorkers(parentThreadId, hung.worker_id)[0]
    assertEqual(
      afterSweep?.status,
      "cancelled",
      "hung worker must be cancelled by the watchdog sweep"
    )

    const verifier = manager.startWorker({
      parentThreadId,
      workspacePath: workspace,
      role: "verifier",
      workload: "verify",
      description: "verify after watchdog release",
      prompt: "verify",
      runner: async () => ({ summary: "ok" })
    })
    assertEqual(
      verifier.status,
      "running",
      "verify worker must start once the watchdog released the hung worker's slot"
    )
  } finally {
    if (savedWindow === undefined) delete process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
    else process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = savedWindow
    // Let queued state persists settle before removing the temp workspace.
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(workspace, { recursive: true, force: true })
  }
}

async function testWatchdogExemptsApprovalWaitingWorker(): Promise<void> {
  // A worker blocked on a pending user approval is WAITING, not hung: the sweep
  // must reset its idle clock and skip termination (coordinator-worker-manager
  // approval-probe branch), so an absent user's approval prompt can sit for hours
  // without the watchdog reaping a healthy worker. Control: once the probe stops
  // reporting a pending approval, the SAME stale worker IS cancelled — proving the
  // exemption (not some other guard) is what protected it.
  const workspace = await mkdtemp(join(tmpdir(), "coordinator-watchdog-approval-"))
  const savedWindow = process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
  process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = "60000"
  const parentThreadId = "thread-watchdog-approval"
  try {
    const manager = new CoordinatorWorkerManager()
    let awaitingApproval = true
    manager.setWorkerApprovalProbe(() => awaitingApproval)

    const waiting = manager.startWorker({
      parentThreadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      description: "blocked on a user approval prompt",
      prompt: "await approval",
      runner: () => new Promise(() => {})
    })

    // Idle far beyond the window, but the probe reports a pending approval → exempt.
    manager.sweepInactiveWorkers(Date.now() + 120_000)
    assertEqual(
      manager.readWorkers(parentThreadId, waiting.worker_id)[0]?.status,
      "running",
      "worker awaiting a user approval must NOT be cancelled by the watchdog"
    )

    // Approval resolved / no longer pending → the same stale worker is now reapable.
    awaitingApproval = false
    manager.sweepInactiveWorkers(Date.now() + 120_000)
    assertEqual(
      manager.readWorkers(parentThreadId, waiting.worker_id)[0]?.status,
      "cancelled",
      "once no approval is pending, the stale worker must be cancelled by the sweep"
    )
  } finally {
    if (savedWindow === undefined) delete process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
    else process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = savedWindow
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(workspace, { recursive: true, force: true })
  }
}

function testApprovalMatchesRuntimeThread(): void {
  // The pure matcher behind hasPendingApprovalForRuntimeThread (the watchdog's
  // approval-exemption probe). Extracted from the Electron-coupled runtime.ts so
  // it can be unit-tested directly.
  const worker = "parent__worker__impl-1"
  // Exact thread → match.
  assert(
    approvalMatchesRuntimeThread(worker, worker),
    "an approval on the exact thread must match"
  )
  // A deeper sub-thread of the target → match.
  assert(
    approvalMatchesRuntimeThread(`${worker}__nested-run`, worker),
    "an approval on a sub-thread must match the target"
  )
  // The `__` separator guard: a sibling sharing a name prefix must NOT match.
  assert(
    !approvalMatchesRuntimeThread("parent__worker__impl-10", "parent__worker__impl-1"),
    "a sibling sharing a name prefix (impl-1 vs impl-10) must NOT match"
  )
  // A parent-thread approval must NOT exempt a child worker (worker owns its own
  // approvals only).
  assert(
    !approvalMatchesRuntimeThread("parent", worker),
    "a parent-thread approval must not match a child worker thread"
  )
  // Unrelated thread → no match.
  assert(
    !approvalMatchesRuntimeThread("other__worker__x", worker),
    "an unrelated thread's approval must not match"
  )
}

function testFreshestStampWinsNotFirstParseable(): void {
  // Regression guard: the decision must take the MAX over parseable stamps, not
  // the first present/parseable one. A stale-or-corrupt lastActivityAt must not
  // mask a fresh updatedAt and get a still-active worker killed.
  assert(
    !isWorkerInactiveForWatchdog(
      worker({ lastActivityAt: "not-a-date", lastStartedAt: iso(WINDOW + 60_000), updatedAt: iso(60_000) }),
      NOW,
      WINDOW
    ),
    "corrupt lastActivityAt + old lastStartedAt but FRESH updatedAt must NOT be flagged"
  )
  assert(
    !isWorkerInactiveForWatchdog(
      worker({ lastActivityAt: iso(WINDOW + 60_000), updatedAt: iso(60_000) }),
      NOW,
      WINDOW
    ),
    "stale lastActivityAt but fresh updatedAt must NOT be flagged (freshest wins)"
  )
  // But when EVERY stamp is stale, max is still stale → terminated.
  assert(
    isWorkerInactiveForWatchdog(
      worker({
        lastActivityAt: iso(WINDOW + 60_000),
        lastStartedAt: iso(WINDOW + 120_000),
        updatedAt: iso(WINDOW + 90_000),
        createdAt: iso(WINDOW + 300_000)
      }),
      NOW,
      WINDOW
    ),
    "a genuinely hung worker (every stamp stale) is still terminated"
  )
}

function testWorkerAwaitingTerminalNotificationDecision(): void {
  const promise = Promise.resolve()
  // The gap the goal-defer guard must catch: terminal result produced
  // (terminalPersistPromise in flight) but notification not yet enqueued.
  assert(
    isWorkerAwaitingTerminalNotification({
      terminalPersistPromise: promise,
      notificationEnqueued: false
    }),
    "terminal-persisting worker without an enqueued notification must be flagged"
  )
  // Deadlock-safety: enqueueNotification sets notificationEnqueued first, so the
  // notification a delivery turn is currently handling must NOT be flagged.
  assert(
    !isWorkerAwaitingTerminalNotification({
      terminalPersistPromise: promise,
      notificationEnqueued: true
    }),
    "an already-enqueued notification (incl. the one being delivered) must not be flagged"
  )
  // Not yet terminal / normal running: no terminalPersistPromise.
  assert(
    !isWorkerAwaitingTerminalNotification({ notificationEnqueued: false }),
    "a worker without a terminalPersistPromise must not be flagged"
  )
  // Excluded: suppressed and dismissal workers (their results are not auto-
  // delivered, so the goal must not defer forever waiting).
  assert(
    !isWorkerAwaitingTerminalNotification({
      terminalPersistPromise: promise,
      notificationEnqueued: false,
      suppressNotificationAutoRun: true
    }),
    "a suppress_notification_auto_run worker must not be flagged"
  )
  assert(
    !isWorkerAwaitingTerminalNotification({
      terminalPersistPromise: promise,
      notificationEnqueued: false,
      dismissNotificationOnTerminalPersist: true
    }),
    "a dismissal worker must not be flagged"
  )
  assert(
    !isWorkerAwaitingTerminalNotification({
      terminalPersistPromise: promise,
      notificationEnqueued: false,
      discarded: true
    }),
    "a discarded worker must not be flagged"
  )
}

async function testWorkspaceScopedRunningWorkerPredicate(): Promise<void> {
  // auto-commit uses hasRunningWorkersForWorkspace to avoid sweeping ANOTHER
  // task/thread's in-progress worker writes into a commit on the same repo.
  const workspace = await mkdtemp(join(tmpdir(), "coordinator-ws-scope-"))
  const nestedPath = join(workspace, "packages", "app")
  const unrelated = await mkdtemp(join(tmpdir(), "coordinator-ws-other-"))
  try {
    const manager = new CoordinatorWorkerManager()
    assert(
      !manager.hasRunningWorkersForWorkspace(workspace),
      "no running workers → false"
    )
    // A running worker on thread-A writing the shared repo.
    manager.startWorker({
      parentThreadId: "thread-A",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      description: "writes the shared repo",
      prompt: "write",
      runner: () => new Promise(() => {})
    })
    assert(
      manager.hasRunningWorkersForWorkspace(workspace),
      "a running worker on the same workspace → true (task-B commit must skip)"
    )
    assert(
      manager.hasRunningWorkersForWorkspace(nestedPath),
      "worker in the parent + commit on a nested path overlaps → true"
    )
    assert(
      !manager.hasRunningWorkersForWorkspace(unrelated),
      "an unrelated workspace → false (no cross-task false positive)"
    )
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(workspace, { recursive: true, force: true })
    await rm(unrelated, { recursive: true, force: true })
  }
}

async function testWorkspaceScopePredicateReverseNesting(): Promise<void> {
  // The OTHER nesting direction: a worker writes a SUBPACKAGE while a commit
  // targets the PARENT repo. The predicate ORs both directions, so this must
  // also overlap → true. Pins the intent the implementation already covers.
  const parentRepo = await mkdtemp(join(tmpdir(), "coordinator-ws-parent-"))
  const childPkg = join(parentRepo, "packages", "app")
  await mkdir(childPkg, { recursive: true })
  try {
    const manager = new CoordinatorWorkerManager()
    manager.startWorker({
      parentThreadId: "thread-C",
      workspacePath: childPkg,
      role: "implementer",
      workload: "write",
      description: "writes a subpackage",
      prompt: "write",
      runner: () => new Promise(() => {})
    })
    assert(
      manager.hasRunningWorkersForWorkspace(parentRepo),
      "worker in a subdir + commit on the parent repo overlaps → true (reverse nesting)"
    )
    assert(
      manager.hasRunningWorkersForWorkspace(childPkg),
      "same subdir → true"
    )
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(parentRepo, { recursive: true, force: true })
  }
}

function testInactivityWindowResolution(): void {
  const savedCoordinator = process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
  const savedWorkflow = process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
  try {
    // No env -> follows the workflow window (one shared timeout policy).
    delete process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
    delete process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
    assertEqual(
      getCoordinatorWorkerInactivityMs(),
      getWorkflowRunWallClockMs(),
      "default window must follow the workflow run window"
    )

    // Own knob wins when valid.
    process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = "120000"
    assertEqual(
      getCoordinatorWorkerInactivityMs(),
      120_000,
      "a valid CMB_COORDINATOR_WORKER_TIMEOUT_MS must be honored"
    )

    // Below the 60s floor -> ignored, falls back to the workflow window.
    process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = "1000"
    assertEqual(
      getCoordinatorWorkerInactivityMs(),
      getWorkflowRunWallClockMs(),
      "a sub-minute override must be ignored (misconfig foot-gun guard)"
    )

    // Garbage -> ignored.
    process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = "soon"
    assertEqual(
      getCoordinatorWorkerInactivityMs(),
      getWorkflowRunWallClockMs(),
      "a non-numeric override must be ignored"
    )

    // Workflow env moves the shared default.
    delete process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
    process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS = "900000"
    assertEqual(
      getCoordinatorWorkerInactivityMs(),
      900_000,
      "with no own knob, the workflow env must move the coordinator window too"
    )
  } finally {
    if (savedCoordinator === undefined) delete process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
    else process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS = savedCoordinator
    if (savedWorkflow === undefined) delete process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS
    else process.env.CMB_WORKFLOW_RUN_TIMEOUT_MS = savedWorkflow
  }
}

async function run(): Promise<void> {
  testRunningStaleIsInactive()
  testRunningFreshIsNotInactive()
  testExactWindowBoundaryIsNotInactive()
  testTerminalStatusesNeverFlagged()
  testTimestampFallbackChain()
  testUnparseableTimestampFallsBackToParseableOnes()
  testFreshestStampWinsNotFirstParseable()
  testWorkerAwaitingTerminalNotificationDecision()
  testInactivityWindowResolution()
  await testWorkspaceScopedRunningWorkerPredicate()
  await testWorkspaceScopePredicateReverseNesting()
  await testWatchdogReleasesHungWorkerConcurrencySlot()
  await testWatchdogExemptsApprovalWaitingWorker()
  testApprovalMatchesRuntimeThread()
  console.log("coordinator-worker-watchdog.spec.ts passed")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
