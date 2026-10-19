import { useCallback, useRef, useSyncExternalStore, type ComponentProps } from "react"
import { useThreadContext } from "@/lib/thread-context"
import { botAvatarMood, botIsSpeaking, type BotAvatarMood } from "@/lib/bot-avatar-mood"
import { BotAvatar } from "./BotAvatar"

/** A scalar selector avoids rerendering avatars on every streamed token. No extra Runtime owner. */
export function useBotRuntimeMood(threadId: string, busy: boolean, waiting = false): BotAvatarMood {
  const context = useThreadContext()
  const cache = useRef<{
    tools: object
    start: number | null
    speaking: boolean
    mood: BotAvatarMood
  } | null>(null)
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
    if (!stream.isLoading) return "work"
    const speaking = botIsSpeaking(stream.isLoading, stream.liveMessages, state.activeTurnStartTime)
    if (
      cache.current?.tools !== state.toolCallStates ||
      cache.current.start !== state.activeTurnStartTime ||
      cache.current.speaking !== speaking
    ) {
      cache.current = {
        tools: state.toolCallStates,
        start: state.activeTurnStartTime,
        speaking,
        mood: botAvatarMood(true, false, state.toolCallStates, state.activeTurnStartTime, speaking)
      }
    }
    return cache.current.mood
  }, [busy, waiting, context, threadId])
  return useSyncExternalStore<BotAvatarMood>(subscribe, snapshot, () => "idle")
}

export function BotRuntimeAvatar({
  threadId,
  busy = false,
  waiting = false,
  ...props
}: ComponentProps<typeof BotAvatar> & { threadId: string; waiting?: boolean }) {
  const mood = useBotRuntimeMood(threadId, busy, waiting)
  return <BotAvatar {...props} mood={mood} />
}
