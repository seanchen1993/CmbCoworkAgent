import { coordinatorWorkerManager } from "../../agent/coordinator-worker-manager"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import { hasPendingUserInputForRuntimeThread } from "../user-input"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import type { ThreadRow } from "../../db"

export interface ImThreadActivity {
  busy: boolean
  label: string
  interaction: string | null
}

interface ActivityDependencies {
  lease: typeof getLocalThreadRunLease
  coordinator: Pick<
    typeof coordinatorWorkerManager,
    | "hasRunningWorkersForThread"
    | "hasTerminalWorkerAwaitingNotificationForThread"
    | "hasAutoRunnableNotifications"
  >
  workflow: Pick<typeof workflowRunManager, "isActive" | "isBusyForThreadAsync">
  approval: (threadId: string) => boolean
  userInput: (threadId: string) => boolean
}

const DEFAULT_DEPENDENCIES: ActivityDependencies = {
  lease: getLocalThreadRunLease,
  coordinator: coordinatorWorkerManager,
  workflow: workflowRunManager,
  approval: hasPendingApprovalForRuntimeThread,
  userInput: hasPendingUserInputForRuntimeThread
}

/** Read live execution state, never infer idleness from the main turn alone. */
export async function readImThreadActivity(
  thread: Pick<ThreadRow, "thread_id" | "metadata">,
  imRunning: boolean,
  dependencies: ActivityDependencies = DEFAULT_DEPENDENCIES
): Promise<ImThreadActivity> {
  const id = thread.thread_id
  const interaction = dependencies.approval(id)
    ? "等待审批（请查看招乎通知或桌面）"
    : dependencies.userInput(id)
      ? "等待补充回答（请查看招乎提问或桌面）"
      : null
  const lease = dependencies.lease(id)
  const workers = dependencies.coordinator.hasRunningWorkersForThread(id)
  const teamPending =
    dependencies.coordinator.hasTerminalWorkerAwaitingNotificationForThread(id) ||
    dependencies.coordinator.hasAutoRunnableNotifications(id)
  const workflowActive = dependencies.workflow.isActive(id)
  // Active runs are in memory. Only workflow-mode idle parents need compact
  // persisted-notification discovery; never load full transcripts/run histories.
  const metadata = parseStandardThreadMetadata(thread.metadata)
  const workflowPending =
    !workflowActive &&
    metadata.agentMode === "workflow" &&
    (await dependencies.workflow.isBusyForThreadAsync(id, metadata.workspacePath))
  let label = interaction ?? "空闲"
  if (!interaction) {
    if (workers) label = "Team 子代理执行中"
    else if (workflowActive) label = "Workflow 子任务执行中"
    else if (imRunning || lease?.owner === "im") label = "招乎任务执行中"
    else if (lease?.owner === "desktop") label = "桌面任务执行中"
    else if (lease?.owner === "scheduler") label = "定时任务执行中"
    else if (lease?.owner === "mods") label = "Mods 命令执行中"
    else if (teamPending) label = "Team 子任务结果待汇总"
    else if (workflowPending) label = "Workflow 结果待汇总"
  }
  return { busy: label !== "空闲", label, interaction }
}
