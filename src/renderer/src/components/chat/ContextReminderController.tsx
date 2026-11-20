import React, { useCallback, useEffect, useRef, useState } from "react"
import { CircleAlert } from "lucide-react"
import { toast } from "sonner"
import type { Thread } from "@/types"
import type { ContextReminderState, TokenUsage } from "@/lib/thread-context"
import { createHarnessFeatureThreadFromLatestRun } from "@/lib/harness-feature-thread"
import { getContextLimit } from "@/lib/model-context-limit"
import { cn } from "@/lib/utils"

const CONTEXT_REMINDER_THRESHOLD_PERCENT = 70
const CONTEXT_REMINDER_INTERVAL_TURNS = 2
const CONTEXT_REMINDER_MAX_SHOWN = 3

type CreateHarnessThread = (
  config: {
    workspacePath: string | null
    harnessFeature: { projectId: string; slug: string; source: string }
  },
  options?: { preserveView?: boolean }
) => Promise<Thread>

interface HarnessFeatureBinding {
  projectId: string
  slug: string
}

interface ContextReminderControllerProps {
  enabled: boolean
  isLoading: boolean
  historyLoading: boolean
  hasPendingApproval: boolean
  hasQueuedApprovals: boolean
  hasPendingUserInput: boolean
  tokenUsage: TokenUsage | null
  currentModel: string
  modelContextLimit?: number
  contextReminder: ContextReminderState | undefined
  setContextReminder: (
    update:
      | ContextReminderState
      | ((prev: ContextReminderState) => ContextReminderState)
  ) => void
  harnessFeatureBinding: HarnessFeatureBinding | null
  workspacePath: string | null
  currentThreadMetadata?: Record<string, unknown>
  createThread: CreateHarnessThread
  reserveLeftSpace: boolean
  creatingDisabled?: boolean
  onHarnessSessionCreated?: (threadId: string) => void
}

export function isContextReminderPending(
  enabled: boolean,
  contextReminder: ContextReminderState | undefined
): boolean {
  return enabled && Boolean(contextReminder?.pending)
}

export function ContextReminderController({
  enabled,
  isLoading,
  historyLoading,
  hasPendingApproval,
  hasQueuedApprovals,
  hasPendingUserInput,
  tokenUsage,
  currentModel,
  modelContextLimit,
  contextReminder,
  setContextReminder,
  harnessFeatureBinding,
  workspacePath,
  currentThreadMetadata,
  createThread,
  reserveLeftSpace,
  creatingDisabled = false,
  onHarnessSessionCreated
}: ContextReminderControllerProps): React.JSX.Element | null {
  const [creatingSession, setCreatingSession] = useState(false)
  const creatingRef = useRef(false)
  const wasLoadingRef = useRef(false)
  const isCustomModel = currentModel.startsWith("custom:")
  const contextLimit = currentModel
    ? (modelContextLimit ?? (isCustomModel ? undefined : getContextLimit(currentModel)))
    : undefined
  const usagePercent =
    tokenUsage && contextLimit ? Math.min((tokenUsage.inputTokens / contextLimit) * 100, 100) : 0
  const pending = isContextReminderPending(enabled, contextReminder)

  useEffect(() => {
    if (enabled && wasLoadingRef.current && !isLoading) {
      setContextReminder((prev) => ({
        ...prev,
        completedTurnCount: prev.completedTurnCount + 1
      }))
    }
    wasLoadingRef.current = isLoading
  }, [enabled, isLoading, setContextReminder])

  useEffect(() => {
    if (!enabled) return
    if (usagePercent <= CONTEXT_REMINDER_THRESHOLD_PERCENT) return
    if (isLoading || historyLoading) return
    if (hasPendingApproval || hasQueuedApprovals || hasPendingUserInput) return

    setContextReminder((prev) => {
      if (prev.pending || prev.shownCount >= CONTEXT_REMINDER_MAX_SHOWN) return prev
      if (prev.completedTurnCount <= 0) return prev

      const enoughTurnsSinceLastPrompt =
        prev.shownCount === 0 ||
        prev.completedTurnCount - prev.lastPromptCompletedTurnCount >=
          CONTEXT_REMINDER_INTERVAL_TURNS
      if (!enoughTurnsSinceLastPrompt) return prev

      return {
        ...prev,
        pending: true,
        shownCount: prev.shownCount + 1,
        lastPromptCompletedTurnCount: prev.completedTurnCount
      }
    })
  }, [
    enabled,
    hasPendingApproval,
    hasPendingUserInput,
    hasQueuedApprovals,
    historyLoading,
    isLoading,
    setContextReminder,
    usagePercent
  ])

  useEffect(() => {
    if (!enabled) return
    if (usagePercent > CONTEXT_REMINDER_THRESHOLD_PERCENT) return

    setContextReminder((prev) => (prev.pending ? { ...prev, pending: false } : prev))
  }, [enabled, setContextReminder, usagePercent])

  const handleDismiss = useCallback(() => {
    setContextReminder((prev) => ({ ...prev, pending: false }))
  }, [setContextReminder])

  const handleCreateSession = useCallback(async (): Promise<void> => {
    if (!harnessFeatureBinding || creatingRef.current || creatingDisabled) return

    creatingRef.current = true
    setCreatingSession(true)
    try {
      const metadataWorkspacePath = currentThreadMetadata?.workspacePath
      const nextWorkspacePath =
        workspacePath ??
        (typeof metadataWorkspacePath === "string" && metadataWorkspacePath.trim()
          ? metadataWorkspacePath
          : null)
      const thread = await createHarnessFeatureThreadFromLatestRun({
        projectId: harnessFeatureBinding.projectId,
        slug: harnessFeatureBinding.slug,
        workspacePath: nextWorkspacePath,
        createThread
      })

      setContextReminder((prev) => ({ ...prev, pending: false }))
      onHarnessSessionCreated?.(thread.thread_id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "开启新会话失败")
    } finally {
      creatingRef.current = false
      setCreatingSession(false)
    }
  }, [
    createThread,
    creatingDisabled,
    currentThreadMetadata,
    harnessFeatureBinding,
    onHarnessSessionCreated,
    setContextReminder,
    workspacePath
  ])

  if (!pending) return null

  return (
    <div className={cn("px-4 pb-2", reserveLeftSpace && "md:pl-20")}>
      <div className="mx-auto max-w-3xl rounded-lg border-2 border-status-warning/50 bg-status-warning/5 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CircleAlert className="size-4 text-status-warning" />
          <span className="text-sm font-medium">上下文占用较高</span>
        </div>
        <div className="text-sm text-muted-foreground">
          当前项目会话上下文占用约 {Math.round(usagePercent)}%，建议开启新会话继续当前特性。
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60"
            disabled={creatingSession}
            onClick={handleDismiss}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-button px-4 py-2 text-sm font-semibold text-button-foreground shadow-sm transition-colors hover:bg-button/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={creatingSession}
            onClick={() => void handleCreateSession()}
          >
            {creatingSession ? "正在开启..." : "开启新会话"}
          </button>
        </div>
      </div>
    </div>
  )
}
