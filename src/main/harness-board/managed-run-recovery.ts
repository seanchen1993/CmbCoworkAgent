import { managedRunStore, type ManagedRunStore } from "./managed-run-store"

const APP_RECOVERY_FAILURE_REASON = "应用重启导致托管运行中断，请重新开始托管"

export interface ManagedRunRecoveryResult {
  failedRunIds: string[]
  corruptRunCount: number
}

export function recoverManagedRunsAtStartup(
  store: ManagedRunStore = managedRunStore
): ManagedRunRecoveryResult {
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

      const sourceEvent = store.appendEvent(record.snapshot, {
        type: "run_interrupted_after_restart",
        scope: "global",
        previousStatus: "running",
        summary: "应用重启后发现未结束的托管运行"
      })
      const policyResult = {
        type: "run_termination" as const,
        proposedAction: "fail_managed_run" as const,
        reasonCode: "app_interrupted",
        rule: "V2.5 不跨应用重启恢复执行。"
      }
      const decisionEvent = store.appendEvent(record.snapshot, {
        type: "managed_run_decision",
        scope: "global",
        sourceEventId: sourceEvent.eventId,
        sourceEventType: sourceEvent.type,
        policyResult,
        decisionActor: "system",
        decisionChannel: "system",
        decisionAction: "fail_managed_run",
        summary: APP_RECOVERY_FAILURE_REASON
      })

      const snapshot = {
        ...record.snapshot,
        status: "failed" as const,
        nextRetryAt: undefined,
        failureReason: APP_RECOVERY_FAILURE_REASON
      }
      const persisted = store.updateSnapshot(snapshot, {
        type: "run_failed",
        scope: "global",
        nodeId: snapshot.decisionBaseline?.nodeId,
        decisionEventId: decisionEvent.eventId,
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
