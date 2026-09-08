import {
  managedRunStore,
  type ManagedRunStore
} from "./managed-run-store"

const APP_RECOVERY_FAILURE_REASON = "应用重启导致托管运行中断，请重新开始托管"

export interface ManagedRunRecoveryResult {
  failedRunIds: string[]
  corruptRunCount: number
}

export function recoverManagedRunsAtStartup(store: ManagedRunStore = managedRunStore): ManagedRunRecoveryResult {
  const failedRunIds: string[] = []
  let corruptRunCount = 0

  for (const record of store.listRuns()) {
    if (record.corrupt || !record.snapshot) {
      corruptRunCount += 1
      continue
    }
    try {
      store.validateRunEvents(record)
      if (record.snapshot.status !== "running") continue

      const snapshot = {
        ...record.snapshot,
        status: "failed" as const,
        nextRetryAt: undefined,
        failureReason: APP_RECOVERY_FAILURE_REASON
      }
      const persisted = store.updateSnapshot(snapshot, {
        type: "run_failed",
        scope: "global",
        source: "managed_run",
        nodeId: snapshot.decisionBaseline?.nodeId,
        threadId: snapshot.currentSession?.threadId,
        reasonCode: "app_interrupted",
        summary: APP_RECOVERY_FAILURE_REASON
      })
      failedRunIds.push(persisted.runId)
    } catch (error) {
      corruptRunCount += 1
      console.warn("[ManagedRun] Failed to recover corrupt run:", {
        projectId: record.projectId,
        featureId: record.featureId,
        runId: record.runId,
        error
      })
    }
  }

  if (corruptRunCount > 0) {
    console.warn(`[ManagedRun] ${corruptRunCount} corrupt run record(s) require manual inspection`)
  }
  return { failedRunIds, corruptRunCount }
}

export { APP_RECOVERY_FAILURE_REASON }
