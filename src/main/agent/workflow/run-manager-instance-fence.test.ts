import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// run-manager pulls in electron at import time; the fence under test touches none of it.
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import { workflowRunManager } from "./run-manager"
import {
  createWorkflowRunStore,
  findUndeliveredTerminalRun,
  generateWorkflowRunId,
  loadWorkflowRun,
  markWorkflowRunNotified,
  workflowThreadDisposalEpoch
} from "./run-store"
import type { PersistedWorkflowRun } from "./types"

/**
 * recoverFlushFailedRun's instance fence — the sibling of setWorkflowRunNotified's.
 *
 * A resume REUSES the runId, and the error notification is what tells the model to
 * resume, so the resume is launched INSIDE the turn that will later ack that error.
 * If the resumed run reaches terminal but its FINAL persist fails, its snapshot sits
 * in `flushFailedRuns` under that same runId. The stale ack then arrives and — keyed
 * on runId alone — would mark the NEW instance's snapshot delivered and write it back,
 * swallowing that instance's own completion notification.
 *
 * `startedAt` is minted fresh on every launch, so it identifies the instance the
 * notification was built from. On mismatch the ack must still retry plain persistence
 * (the disk may have recovered) but leave `notificationDelivered` alone — that flag
 * belongs to the new instance's own ack.
 *
 * Behavioural on purpose: this guard fails SILENTLY (a notification just never arrives),
 * and a source-regex assertion stays green if `!==` is ever typo'd to `===`.
 */
describe("recoverFlushFailedRun instance fence", () => {
  const THREAD_ID = "thread-flushfail-fence"
  const FIRST_STARTED_AT = "2026-07-08T14:53:10.000Z"
  const RESUMED_STARTED_AT = "2026-07-08T14:53:16.267Z"

  let workspace: string

  // TS `private` is compile-time only; reach the maps to stage the exact race.
  const privates = workflowRunManager as unknown as {
    flushFailedRuns: Map<string, PersistedWorkflowRun>
    flushFailedEpochs: Map<string, number>
  }

  const record = (
    runId: string,
    startedAt: string,
    status: "running" | "completed"
  ): PersistedWorkflowRun => ({
    version: 1,
    runId,
    threadId: THREAD_ID,
    workflowName: "fence",
    script: "x",
    scriptSha256: "s",
    status,
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [],
    stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
    startedAt,
    updatedAt: startedAt
  })

  /** Stages the terminal snapshot of a run whose FINAL persist failed. */
  const seedFlushFailedSnapshot = (runId: string, startedAt: string): PersistedWorkflowRun => {
    const snapshot = record(runId, startedAt, "completed")
    privates.flushFailedRuns.set(runId, snapshot)
    privates.flushFailedEpochs.set(runId, workflowThreadDisposalEpoch(THREAD_ID))
    return snapshot
  }

  /** What `launch()` leaves on disk: the initial record. A failed final flush means the
   *  terminal status never lands, so the disk copy is stuck at "running". */
  const seedDiskRunningRecord = async (runId: string, startedAt: string): Promise<void> => {
    const store = createWorkflowRunStore({
      workspacePath: workspace,
      threadId: THREAD_ID,
      initial: record(runId, startedAt, "running")
    })
    expect(await store.flush()).toBe(true)
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "wf-fence-"))
  })

  afterEach(() => {
    privates.flushFailedRuns.clear()
    privates.flushFailedEpochs.clear()
    rmSync(workspace, { recursive: true, force: true })
  })

  test("a stale ack persists the resumed snapshot but never marks it delivered", async () => {
    const runId = generateWorkflowRunId()
    const snapshot = seedFlushFailedSnapshot(runId, RESUMED_STARTED_AT)

    // Instance 1's ack lands late, carrying instance 1's startedAt.
    const recovered = await workflowRunManager.recoverFlushFailedRun(
      workspace,
      THREAD_ID,
      runId,
      FIRST_STARTED_AT
    )

    expect(
      snapshot.notificationDelivered,
      "REGRESSION: stale ack marked the RESUMED snapshot delivered — that instance's " +
        "completion notification would be swallowed forever"
    ).toBeFalsy()

    // The write-back still happened (disk may have recovered) — just undelivered. The ack
    // path reads this boolean as "disk is consistent → kick the drain".
    expect(recovered, "a landed write-back must still signal the pending drain").toBe(true)
    const onDisk = loadWorkflowRun(workspace, THREAD_ID, runId)
    expect(onDisk?.startedAt, "the RESUMED instance's terminal state reached disk").toBe(
      RESUMED_STARTED_AT
    )
    expect(onDisk?.notificationDelivered, "written back undelivered").toBeFalsy()

    // …so it still surfaces as pending and its own notification will fire.
    expect(findUndeliveredTerminalRun(workspace, THREAD_ID)?.runId).toBe(runId)

    // And the resumed instance's OWN ack settles it for real.
    expect(await markWorkflowRunNotified(workspace, THREAD_ID, runId, RESUMED_STARTED_AT)).toBe(
      true
    )
    expect(loadWorkflowRun(workspace, THREAD_ID, runId)?.notificationDelivered).toBe(true)
    expect(findUndeliveredTerminalRun(workspace, THREAD_ID)).toBeNull()
  })

  test("on a flush-failed resumed instance, `recovered` is the ack's ONLY kick signal", async () => {
    // The full ack path, reproduced. A flush-failed run's DISK copy is still the initial
    // "running" record, and markNotified's `status === "running"` check precedes its own
    // instance fence — so markNotified returns false regardless of startedAt. That leaves
    // recoverFlushFailedRun as the sole producer of the `delivered || recovered` kick.
    // Returning false there strands a terminal, undelivered, drain-ready run with nobody
    // knocking: it only resurfaces on the next hydrate/reload.
    const runId = generateWorkflowRunId()
    await seedDiskRunningRecord(runId, RESUMED_STARTED_AT) // what launch() left behind
    seedFlushFailedSnapshot(runId, RESUMED_STARTED_AT) // terminal state, memory only

    const delivered = await markWorkflowRunNotified(workspace, THREAD_ID, runId, FIRST_STARTED_AT)
    expect(delivered, "disk says running → markNotified bails before its own fence").toBe(false)

    const recovered = await workflowRunManager.recoverFlushFailedRun(
      workspace,
      THREAD_ID,
      runId,
      FIRST_STARTED_AT
    )
    expect(
      delivered || recovered,
      "REGRESSION: neither signal fires → agent.ts's `if (delivered || recovered)` never " +
        "kicks, and the resumed instance's completion notification is stranded until hydrate"
    ).toBe(true)

    // The kick is worth making: the drain really does have something to report.
    const onDisk = loadWorkflowRun(workspace, THREAD_ID, runId)
    expect(onDisk?.status, "the terminal state replaced the stale running copy").toBe("completed")
    expect(
      onDisk?.notificationDelivered,
      "still unreported — the new instance owns its ack"
    ).toBeFalsy()
    expect(findUndeliveredTerminalRun(workspace, THREAD_ID)?.runId).toBe(runId)
  })

  test("a stale ack on a STILL-FAILING disk STILL kicks — the drain reads memory first", async () => {
    // The kick licence is "something still wants reporting", NOT "the disk write landed".
    // findPendingNotification scans flushFailedRuns BEFORE the disk, so the new instance's
    // memory snapshot is perfectly reportable even while the disk is faulty. Gating the
    // kick on write-back success strands it until the next hydrate/reload.
    const runId = generateWorkflowRunId()
    const fileAsWorkspace = join(workspace, "not-a-dir")
    writeFileSync(fileAsWorkspace, "x") // run dir under a regular FILE → mkdir ENOTDIR
    seedFlushFailedSnapshot(runId, RESUMED_STARTED_AT)

    const shouldKickPendingDrain = await workflowRunManager.recoverFlushFailedRun(
      fileAsWorkspace,
      THREAD_ID,
      runId,
      FIRST_STARTED_AT
    )

    expect(
      shouldKickPendingDrain,
      "REGRESSION: no kick while the drain has a reportable snapshot in memory — the " +
        "resumed instance's notification waits for a hydrate"
    ).toBe(true)
    // And the kick would really find it: memory-first, undelivered, not in flight.
    expect(workflowRunManager.findPendingNotification(fileAsWorkspace, THREAD_ID)?.runId).toBe(
      runId
    )
    expect(privates.flushFailedRuns.has(runId), "snapshot retained for a later retry").toBe(true)
    expect(
      privates.flushFailedRuns.get(runId)?.notificationDelivered,
      "and still never marked delivered — that flag belongs to its own ack"
    ).toBeFalsy()
  })

  test("a matching ack recovers the snapshot and marks it delivered", async () => {
    const runId = generateWorkflowRunId()
    seedFlushFailedSnapshot(runId, RESUMED_STARTED_AT)

    const shouldKickPendingDrain = await workflowRunManager.recoverFlushFailedRun(
      workspace,
      THREAD_ID,
      runId,
      RESUMED_STARTED_AT
    )

    expect(shouldKickPendingDrain, "the reporting instance's own ack recovers the snapshot").toBe(
      true
    )
    expect(loadWorkflowRun(workspace, THREAD_ID, runId)?.notificationDelivered).toBe(true)
    expect(privates.flushFailedRuns.has(runId), "recovered snapshot is dropped").toBe(false)
    expect(findUndeliveredTerminalRun(workspace, THREAD_ID)).toBeNull()
  })

  test("a matching ack on a STILL-FAILING disk kicks the backlog behind it", async () => {
    // Isomorphic to the stale-ack case: the write-back failing says nothing about whether
    // OTHER runs on this thread are waiting. The acked run can't be re-reported (its
    // snapshot is delivered=true in memory, its disk copy is pre-terminal), so the kick is
    // free — and the run behind it is drain-ready right now.
    const runId = generateWorkflowRunId()
    const backlogRunId = generateWorkflowRunId()
    const fileAsWorkspace = join(workspace, "not-a-dir")
    writeFileSync(fileAsWorkspace, "x")
    const acked = seedFlushFailedSnapshot(runId, RESUMED_STARTED_AT)
    seedFlushFailedSnapshot(backlogRunId, RESUMED_STARTED_AT) // a second completed run

    const shouldKickPendingDrain = await workflowRunManager.recoverFlushFailedRun(
      fileAsWorkspace,
      THREAD_ID,
      runId,
      RESUMED_STARTED_AT
    )

    expect(
      shouldKickPendingDrain,
      "REGRESSION: a failed write-back suppressed the kick and stranded the backlog"
    ).toBe(true)
    expect(acked.notificationDelivered, "the acked run is settled in memory").toBe(true)
    // The drain skips the (delivered) acked run and serves the one behind it.
    expect(workflowRunManager.findPendingNotification(fileAsWorkspace, THREAD_ID)?.runId).toBe(
      backlogRunId
    )
  })

  test("an unfenced ack (cancel path) still recovers and marks delivered", async () => {
    // The cancel path knows no instance: the run it marks IS the one being cancelled.
    const runId = generateWorkflowRunId()
    seedFlushFailedSnapshot(runId, RESUMED_STARTED_AT)

    expect(await workflowRunManager.recoverFlushFailedRun(workspace, THREAD_ID, runId)).toBe(true)
    expect(loadWorkflowRun(workspace, THREAD_ID, runId)?.notificationDelivered).toBe(true)
  })
})
