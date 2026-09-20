import { managedRunStore, type ManagedRunStore } from "./managed-run-store"
import { reportManagedRunEnded } from "./managed-run-telemetry"

const APP_RECOVERY_FAILURE_REASON = "应用重启导致托管运行中断，请重新开始托管"

export interface ManagedRunRecoveryResult {
  failedRunIds: string[]
  corruptRunCount: number
  /**
   * 磁盘上存在托管运行记录的项目，不论那次运行是不是已经结束。
   *
   * 「托管运行」标签的回填靠这个：托管记录本来就落在
   * `<工作区>/.cmbdevclaw/managed-runs/` 下，恢复流程本来就要把它们走一遍，顺手
   * 收集一下比再扫一次磁盘便宜。标记的写入是异步的，交给调用方做，这个函数保持同步。
   *
   * 只收集快照能读出来的运行。某个项目如果只有损坏的记录，它拿不到标签，接受这个
   * 结果——损坏的记录本来也读不出是哪个项目的。
   */
  projectIdsWithRuns: string[]
}

export function recoverManagedRunsAtStartup(
  store: ManagedRunStore = managedRunStore
): ManagedRunRecoveryResult {
  const failedRunIds: string[] = []
  const projectIdsWithRuns = new Set<string>()
  let corruptRunCount = 0

  for (const record of store.listRuns()) {
    if (record.corrupt || !record.snapshot) {
      corruptRunCount += 1
      continue
    }
    projectIdsWithRuns.add(record.snapshot.projectId)
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
      // 这条路径不经过 markTerminal，上报要单独补。少了它，被应用重启打断的托管运行
      // 在看板上就只有开始没有结束。
      reportManagedRunEnded(persisted, "failed", "app_interrupted")
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
  return { failedRunIds, corruptRunCount, projectIdsWithRuns: [...projectIdsWithRuns] }
}

export { APP_RECOVERY_FAILURE_REASON }
