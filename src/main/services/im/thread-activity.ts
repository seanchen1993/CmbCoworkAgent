import { coordinatorWorkerManager } from "../../agent/coordinator-worker-manager"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import { hasPendingUserInputForRuntimeThread } from "../user-input"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import {
  readThreadBackgroundActivity,
  type ThreadBackgroundReaders
} from "../../agent/thread-background-activity"
import type { ThreadRow } from "../../db"

export interface ImThreadActivity {
  busy: boolean
  label: string
  interaction: string | null
}

interface ActivityDependencies extends ThreadBackgroundReaders {
  lease: typeof getLocalThreadRunLease
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
  const metadata = parseStandardThreadMetadata(thread.metadata)
  const background = await readThreadBackgroundActivity(
    id,
    metadata.workspacePath,
    dependencies,
    metadata.agentMode === "workflow"
  )
  const interaction = dependencies.approval(id)
    ? "等待审批（请查看招乎通知或桌面）"
    : dependencies.userInput(id)
      ? "等待补充回答（请查看招乎提问或桌面）"
      : null
  const lease = dependencies.lease(id)
  let label = interaction ?? "空闲"
  if (!interaction) {
    if (background.phase === "running") label = background.label
    else if (imRunning || lease?.owner === "im") label = "招乎任务执行中"
    else if (lease?.owner === "desktop") label = "桌面任务执行中"
    else if (lease?.owner === "scheduler") label = "定时任务执行中"
    else if (background.phase === "pending_results") label = background.label
  }
  return { busy: label !== "空闲", label, interaction }
}
