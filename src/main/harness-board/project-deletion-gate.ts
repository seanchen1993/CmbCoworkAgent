import { hasActiveTopLevelAgentRun } from "../agent/agent-run-service"
import { coordinatorWorkerManager } from "../agent/coordinator-worker-manager"
import { workflowRunManager } from "../agent/workflow/run-manager"
import { getAllThreadSummaries } from "../db"
import { managedRunStore } from "./managed-run-store"
import { readHarnessFeatureMetadata } from "./service"

export async function assertHarnessProjectCanBeDeleted(projectId: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) throw new Error("Project id is required")
  const hasRunningManagedRun = managedRunStore
    .listProjectRuns(normalizedProjectId)
    .some(
      (record) =>
        record.projectId === normalizedProjectId &&
        !record.corrupt &&
        record.snapshot?.status === "running"
    )
  const hasActiveRuntime = getAllThreadSummaries().some((thread) => {
    if (!thread.metadata) return false
    try {
      const feature = readHarnessFeatureMetadata(JSON.parse(thread.metadata) as unknown)
      if (feature?.projectId !== normalizedProjectId) return false
      return (
        hasActiveTopLevelAgentRun(thread.thread_id) ||
        workflowRunManager.isActive(thread.thread_id) ||
        coordinatorWorkerManager.hasRunningWorkersForThread(thread.thread_id)
      )
    } catch {
      return false
    }
  })
  if (hasRunningManagedRun || hasActiveRuntime) {
    throw new Error("项目存在运行中的会话或托管任务，请结束后再删除")
  }
}
