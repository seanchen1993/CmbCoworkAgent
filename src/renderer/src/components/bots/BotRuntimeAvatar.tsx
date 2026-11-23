import { useCallback, useSyncExternalStore, type ComponentProps } from "react"
import { useThreadContext } from "@/lib/thread-context"
import { botAvatarMood, type BotAvatarMood } from "@/lib/bot-avatar-mood"
import { BotAvatar } from "./BotAvatar"

/** A scalar selector avoids rerendering avatars on every streamed token. No extra Runtime owner. */
export function useBotRuntimeMood(
  threadId: string,
  busy: boolean,
  waiting = false,
  taskCreatedAt?: number
): BotAvatarMood {
  const context = useThreadContext()
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!busy && !waiting) return () => {}
      const state = context.subscribeToThreadState(threadId, listener)
      const stream = context.subscribeToStream(threadId, listener)
      return () => {
        state()
        stream()
      }
    },
    [busy, waiting, context, threadId]
  )
  const snapshot = useCallback(() => {
    if (waiting) return "blocked"
    if (!busy) return "idle"
    const state = context.getThreadState(threadId)
    if (state.pendingApproval || state.pendingUserInput || state.pendingApprovals.length)
      return "blocked"
    if (
      state.workflowRun?.status === "running" ||
      state.coordinatorWorkers.some((worker) => worker.status === "running")
    )
      return "orbit"
    const stream = context.getStreamData(threadId)
    // Host admission precedes Runtime startup; retained tool state belongs to the previous turn.
    if (!stream.isLoading && !state.scheduledTaskLoading) return "work"
    return botAvatarMood(
      true,
      false,
      state.scheduledTaskLoading ? state.messages : stream.liveMessages,
      Math.max(state.activeTurnStartTime ?? 0, taskCreatedAt ?? 0) || null
    )
  }, [busy, waiting, context, threadId, taskCreatedAt])
  return useSyncExternalStore<BotAvatarMood>(subscribe, snapshot, () => "idle")
}

export function BotRuntimeAvatar({
  threadId,
  busy = false,
  waiting = false,
  taskCreatedAt,
  ...props
}: ComponentProps<typeof BotAvatar> & {
  threadId: string
  waiting?: boolean
  taskCreatedAt?: number
}) {
  const mood = useBotRuntimeMood(threadId, busy, waiting, taskCreatedAt)
  return <BotAvatar {...props} mood={mood} />
}
