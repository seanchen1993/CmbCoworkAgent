import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useThreadContext } from "@/lib/thread-context"
import { botGroupActiveTasks, botGroupQuestion } from "@/lib/bot-group-question"
import { LOCAL_BOT_HOST_ID, type BotTask } from "../../../../shared/bots/contracts"
import type { UserInputRequest } from "@/types"

export interface BotGroupPendingQuestion {
  task: BotTask
  request: UserInputRequest
}

/** A cached projection of the original inboxes; token-only updates do not rerender the room. */
export function useGroupQuestions(hostId: string, groupId: string, tasks: BotTask[]) {
  const context = useThreadContext()
  const active = useMemo(
    () =>
      hostId === LOCAL_BOT_HOST_ID
        ? botGroupActiveTasks(groupId, tasks).filter(
            (task) => task.state === "running" || task.state === "waiting_user"
          )
        : [],
    [hostId, groupId, tasks]
  )
  useEffect(() => {
    for (const task of active) context.initializeThread(task.threadId)
  }, [active, context])
  const cache = useRef<BotGroupPendingQuestion[]>([])
  const subscribe = useCallback(
    (listener: () => void) => {
      const dispose = [...new Set(active.map((task) => task.threadId))].map((id) =>
        context.subscribeToThreadState(id, listener)
      )
      return () => dispose.forEach((cleanup) => cleanup())
    },
    [active, context]
  )
  const snapshot = useCallback(() => {
    const next: BotGroupPendingQuestion[] = []
    for (const task of active) {
      const request = botGroupQuestion(
        groupId,
        task,
        context.getThreadState(task.threadId).pendingUserInput
      )
      if (request) next.push({ task, request })
    }
    if (
      cache.current.length !== next.length ||
      next.some(
        (item, i) =>
          item.task !== cache.current[i].task || item.request !== cache.current[i].request
      )
    )
      cache.current = next
    return cache.current
  }, [active, context, groupId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
