import { useCallback } from "react"
import { toast } from "sonner"
import type { Message } from "@/types"
import { useAppStore } from "@/lib/store"
import { useCurrentThread, useThreadStream } from "@/lib/thread-context"
import { isCoordinatorModeMetadata, isWorkflowModeMetadata } from "@/lib/coordinator-mode-helpers"
import {
  releaseSubmitInFlightLock,
  sharedSubmitInFlightLockRef,
  tryAcquireSubmitInFlightLock
} from "@/lib/submit-in-flight-lock"
import { buildVisualEditPrompt } from "./visual-context-builder"
import {
  getSubmittableVisualAnnotations,
  getVisualEditSubmitDisabledReason
} from "./visual-submit-guards"
import type { ClawVisualFeedbackContext } from "./visual-edit-types"

type VisualEditAgentMode = "normal" | "coordinator" | "workflow"

async function resolveAgentMode(threadId: string): Promise<VisualEditAgentMode> {
  const thread = useAppStore.getState().threads.find((item) => item.thread_id === threadId)
  const metadata = thread?.metadata ?? {}
  if (isWorkflowModeMetadata(metadata)) return "workflow"
  if (isCoordinatorModeMetadata(metadata)) return "coordinator"

  const forced = await window.api.agent.isCoordinatorModeForced().catch(() => false)
  return forced ? "coordinator" : "normal"
}

export function useVisualEditSubmit(threadId: string): {
  submitVisualFeedback: (context: ClawVisualFeedbackContext) => Promise<boolean>
  canSubmitVisualFeedback: boolean
  submitDisabledReason: string | null
} {
  const models = useAppStore((state) => state.models)
  const generateTitleForFirstMessage = useAppStore((state) => state.generateTitleForFirstMessage)
  const threads = useAppStore((state) => state.threads)
  const {
    appendMessage,
    clearError,
    clearFinishedWorkflowRun,
    currentModel,
    error: threadError,
    errorDetail,
    pendingApproval,
    approvalQueue,
    historyLoading,
    messages,
    scheduledTaskLoading,
    setActiveTab,
    setActiveTurnStartTime,
    setError,
    setMessages,
    workspacePath
  } = useCurrentThread(threadId)
  const streamData = useThreadStream(threadId)
  const selectedModel = currentModel ? models.find((model) => model.id === currentModel) : null
  const submitDisabledReason = getVisualEditSubmitDisabledReason({
    historyLoading,
    scheduledTaskLoading,
    streamLoading: streamData.isLoading,
    hasStream: Boolean(streamData.stream),
    hasPendingApproval: Boolean(pendingApproval) || approvalQueue.length > 0,
    currentModel,
    selectedModelExists: Boolean(selectedModel),
    selectedModelAvailable: selectedModel?.available === true,
    workspacePath
  })

  const canSubmitVisualFeedback = !submitDisabledReason

  const submitVisualFeedback = useCallback(
    async (context: ClawVisualFeedbackContext): Promise<boolean> => {
      if (submitDisabledReason || !streamData.stream || !currentModel) {
        if (submitDisabledReason) {
          toast.warning(submitDisabledReason)
          setError(submitDisabledReason)
        }
        setActiveTab("agent")
        return false
      }

      const submittableAnnotations = getSubmittableVisualAnnotations(context.annotations)
      if (submittableAnnotations.length === 0) {
        toast.warning("没有待提交的视觉标注。")
        return false
      }

      if (!tryAcquireSubmitInFlightLock(sharedSubmitInFlightLockRef, true, threadId)) {
        toast.warning("当前线程已有提交正在处理中，请稍后再试。")
        return false
      }

      const submitContext: ClawVisualFeedbackContext = {
        ...context,
        annotations: submittableAnnotations
      }
      const prompt = buildVisualEditPrompt(submitContext)
      const startAt = new Date()
      const targetLabel = context.targetPath?.split("/").pop() || context.targetUrl || "当前预览"
      const displayContent = `提交了 ${submittableAnnotations.length} 条视觉标注（${targetLabel}）`
      const visibleMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: displayContent,
        created_at: startAt,
        start_at: startAt,
        end_at: startAt
      }

      try {
        if (threadError || errorDetail) {
          clearError()
        }

        appendMessage(visibleMessage)
        clearFinishedWorkflowRun()
        const startTime = Date.now()
        setActiveTurnStartTime(startTime)

        const agentMode = await resolveAgentMode(threadId)
        window.setTimeout(() => setActiveTab("agent"), 0)
        await streamData.stream.submit(
          {
            messages: [{ type: "human", content: prompt }]
          },
          {
            config: {
              configurable: {
                thread_id: threadId,
                model_id: currentModel,
                agent_mode: agentMode,
                hook_turn_id: visibleMessage.id
              }
            }
          }
        )

        window.api.threads
          .mergeThreadValues(threadId, {
            messageTimes: {
              [visibleMessage.id]: {
                start_at: startAt.toISOString(),
                end_at: startAt.toISOString()
              }
            },
            messageTimeOrder: [
              {
                id: visibleMessage.id,
                start_at: startAt.toISOString(),
                end_at: startAt.toISOString()
              }
            ]
          })
          .catch((error) => {
            console.warn("[visual-edit] failed to persist message time:", error)
          })

        const currentThread = threads.find((thread) => thread.thread_id === threadId)
        if (messages.length === 0 && currentThread?.title?.startsWith("Thread ")) {
          void generateTitleForFirstMessage(threadId, displayContent)
        }

        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : "提交视觉标注失败。"
        setMessages(messages)
        setError(message)
        toast.error(message)
        return false
      } finally {
        setActiveTurnStartTime(null)
        releaseSubmitInFlightLock(sharedSubmitInFlightLockRef, true, threadId)
      }
    },
    [
      appendMessage,
      clearError,
      clearFinishedWorkflowRun,
      currentModel,
      errorDetail,
      generateTitleForFirstMessage,
      messages,
      setActiveTab,
      setActiveTurnStartTime,
      setError,
      setMessages,
      streamData.stream,
      submitDisabledReason,
      threadError,
      threadId,
      threads
    ]
  )

  return {
    submitVisualFeedback,
    canSubmitVisualFeedback,
    submitDisabledReason
  }
}
