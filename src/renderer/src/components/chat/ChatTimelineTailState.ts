import type { ReactNode } from "react"
import type { Todo } from "@/types"
import type { HookInterruptionState, HookLogBucket, ModelRetryState } from "@/lib/thread-context"
import type { ContextCompactionLifecycleEvent } from "../../../../shared/context-compaction-events"
import type { WorkflowRunView } from "@/lib/workflow-run-view"

export interface ChatTimelineTailProps {
  bottomPadding?: number
  showDetachedHookLogs: boolean
  hookLoggingEnabled: boolean
  detachedHookLogBuckets: HookLogBucket[]
  onOpenHookLogBucket: (turnId: string) => void
  contextCompaction: ContextCompactionLifecycleEvent | null
  modelRetry: ModelRetryState | null
  isLoading: boolean
  thinkingMessage: string
  streamLoading: boolean
  activeTurnStartTime: number | null
  todos: Todo[]
  workflowRun: WorkflowRunView | null
  isWorkflowMode: boolean
  threadId: string
  hookInterruption: HookInterruptionState | null
  interruptionNotice: { title: string; explanation: string } | null
  onClearHookInterruption: () => void
  errorContent: ReactNode
}

export function hasChatTimelineTailContent({
  bottomPadding,
  showDetachedHookLogs,
  hookLoggingEnabled,
  detachedHookLogBuckets,
  contextCompaction,
  modelRetry,
  isLoading,
  workflowRun,
  isWorkflowMode,
  hookInterruption,
  errorContent
}: ChatTimelineTailProps): boolean {
  return (
    Boolean(bottomPadding) ||
    (showDetachedHookLogs && hookLoggingEnabled && detachedHookLogBuckets.length > 0) ||
    Boolean(contextCompaction) ||
    Boolean(modelRetry) ||
    isLoading ||
    Boolean(workflowRun) ||
    isWorkflowMode ||
    Boolean(hookInterruption && !isLoading) ||
    Boolean(errorContent)
  )
}
