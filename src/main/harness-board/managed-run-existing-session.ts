import { getThreadCore, updateThread } from "../db"
import { hasActiveTopLevelAgentRun } from "../agent/agent-run-service"
import { coordinatorWorkerManager } from "../agent/coordinator-worker-manager"
import { workflowRunManager } from "../agent/workflow/run-manager"
import { bindThreadWorkspace } from "../services/workspace-metadata"
import { readHarnessFeatureMetadata } from "./service"

interface ExistingSessionInput {
  projectId: string
  featureId: string
  threadId: string
  launchWorkspacePath?: string
}

function assertIdleSession(threadId: string, status: string): void {
  if (
    status === "busy" ||
    hasActiveTopLevelAgentRun(threadId) ||
    coordinatorWorkerManager.hasRunningWorkersForThread(threadId) ||
    coordinatorWorkerManager.hasTerminalWorkerAwaitingNotificationForThread(threadId) ||
    coordinatorWorkerManager.hasAutoRunnableNotifications(threadId)
  ) {
    throw new Error("所选会话仍在运行或等待后台任务结果，请结束后再开启托管")
  }
}

export async function requireIdleManagedSession(input: ExistingSessionInput) {
  const thread = getThreadCore(input.threadId)
  if (!thread) throw new Error("所选会话已删除，请重新选择")
  let metadata: Record<string, unknown>
  try {
    metadata = JSON.parse(thread.metadata || "{}")
  } catch {
    throw new Error("所选会话的信息无法读取，请重新选择")
  }
  const feature = readHarnessFeatureMetadata(metadata)
  if (feature?.projectId !== input.projectId || feature.slug !== input.featureId) {
    throw new Error("所选会话不属于当前特性，请重新选择")
  }
  const workspacePath =
    typeof metadata.workspacePath === "string" ? metadata.workspacePath.trim() : ""
  if (!workspacePath) throw new Error("所选会话没有工作区，请重新选择")
  assertIdleSession(input.threadId, thread.status)
  if (await workflowRunManager.isBusyForThreadAsync(input.threadId, workspacePath)) {
    throw new Error("所选会话仍在运行或等待后台任务结果，请结束后再开启托管")
  }
  if (
    input.launchWorkspacePath &&
    input.launchWorkspacePath !== workspacePath &&
    (await workflowRunManager.isBusyForThreadAsync(input.threadId, input.launchWorkspacePath))
  ) {
    throw new Error("所选会话仍在运行或等待后台任务结果，请结束后再开启托管")
  }
  // Workflow inspection is asynchronous; confirm the session still exists and is idle afterwards.
  const current = getThreadCore(input.threadId)
  if (!current) throw new Error("所选会话已删除，请重新选择")
  if (current.metadata !== thread.metadata || current.status !== thread.status) {
    throw new Error("所选会话状态已变化，请重新选择后再开启托管")
  }
  assertIdleSession(input.threadId, current.status)
  return { thread, metadata, workspacePath }
}

export function bindExistingManagedSession(
  session: Awaited<ReturnType<typeof requireIdleManagedSession>>,
  runId: string,
  nodeId: string,
  workspacePath?: string
) {
  const metadata = { ...session.metadata }
  if (workspacePath && workspacePath !== session.workspacePath) {
    bindThreadWorkspace(metadata, workspacePath)
  }
  const thread = updateThread(session.thread.thread_id, {
    metadata: JSON.stringify({
      ...metadata,
      harnessFeature: {
        ...(session.metadata.harnessFeature as Record<string, unknown>),
        runId,
        nodeId
      }
    })
  })
  if (!thread) throw new Error("所选会话已删除，请重新选择")
}
