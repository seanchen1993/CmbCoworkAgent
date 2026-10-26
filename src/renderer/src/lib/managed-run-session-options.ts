import type { HarnessSessionBinding } from "../../../shared/harness-board-types"
import { formatGmt8Timestamp } from "../../../shared/gmt8-time"
import type { Thread } from "../types"
import { hasRunningThreadForDeletion, type ThreadDeletionState } from "./thread-group-deletion"

export interface ManagedRunSessionOption {
  threadId: string
  title: string
  lastActiveAt: string
  workspacePath: string
  disabledReason?: string
}

export function buildManagedRunSessionOptions(
  sessions: HarnessSessionBinding[],
  threadsById: ReadonlyMap<string, Thread>,
  threadStates: Record<string, ThreadDeletionState | undefined>,
  streamLoadingStates: Record<string, boolean>
): ManagedRunSessionOption[] {
  return [...sessions]
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .map((session) => {
      const thread = threadsById.get(session.threadId)
      const workspacePath =
        typeof thread?.metadata?.workspacePath === "string"
          ? thread.metadata.workspacePath.trim()
          : ""
      const running =
        thread?.status === "busy" ||
        hasRunningThreadForDeletion([session.threadId], threadStates, streamLoadingStates)
      const activityTime = new Date(session.lastActiveAt)
      return {
        threadId: session.threadId,
        title: thread?.title?.trim() || "未命名会话",
        lastActiveAt: Number.isFinite(activityTime.getTime())
          ? formatGmt8Timestamp(activityTime)
          : "",
        workspacePath,
        disabledReason: !thread
          ? "会话不可用"
          : running
            ? "运行中"
            : !workspacePath
              ? "缺少工作区"
              : undefined
      }
    })
}

export function getManagedRunInitialSession(
  sessions: ManagedRunSessionOption[],
  previousThreadId?: string
): ManagedRunSessionOption | undefined {
  return sessions.find(
    (session) => session.threadId === previousThreadId && !session.disabledReason
  )
}
