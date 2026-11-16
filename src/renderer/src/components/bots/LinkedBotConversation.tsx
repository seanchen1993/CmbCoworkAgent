import { toast } from "sonner"
import { returnToBotMain, returnToBotTask } from "./ConversationTaskControls"
import { useCallback, useMemo, useState } from "react"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import { useBots } from "./use-bots"
import { useBotReadState } from "./use-bot-read-state"
import { BotConversation } from "./BotConversation"
import { botWorkClient } from "@/lib/bot-work-client"
import { useAppStore } from "@/lib/store"
import { useThreadStateSelector, useThreadStateSummaries } from "@/lib/thread-context"

/** Same managed ChatContainer as the Bot entrance, not another conversation or runtime. */
export function LinkedBotConversation({ link }: { link: BotWorkConversationResolution }) {
  const client = window.api.bots,
    { snapshot } = useBots(client)
  const { id: workId, threadId, activity } = link.work
  const [presentedWorkId, setPresentedWorkId] = useState<string | null>(null)
  const onReadyChange = useCallback((ready: boolean) => {
    setPresentedWorkId(ready ? workId : null)
  }, [workId])
  const isForeground = useAppStore(state => state.mainView === "thread" &&
    state.currentThreadId === threadId && !state.showCustomizeView)
  const historyReady = useThreadStateSelector(threadId, state =>
    !state.historyLoading && state.historyConversationPresence !== "unknown")
  useBotReadState(client, isForeground && historyReady && presentedWorkId === workId &&
    !link.work.deletionPending && !link.work.deletionCommitted &&
    link.work.botId === link.bot.id && activity?.kind === "work" && activity.id === workId
    ? activity : undefined)
  const threadSummaries = useThreadStateSummaries()
  const target = useMemo(
    () => botWorkClient(client, link.work),
    [client, link.work.id, link.work.threadId]
  )
  const tasks = snapshot?.tasks.filter((task) => task.threadId === link.work.threadId) ?? []
  return (
    <div className="bots-workspace" data-linked-bot-thread>
      <div className="bots-conversation">
        <BotConversation
          key={workId}
          bot={link.bot}
          work={link.work}
          onReadyChange={onReadyChange}
          bots={snapshot?.bots ?? [link.bot]}
          schedules={snapshot?.schedules ?? []}
          tasks={tasks}
          collaborationPending={Boolean(snapshot?.collaborationThreads?.includes(link.work.threadId))}
          backgroundBusy={Boolean(
            link.work.backgroundBusy ||
            snapshot?.backgroundThreads?.includes(link.work.threadId) ||
            threadSummaries[link.work.threadId]?.workflowRunning ||
            threadSummaries[link.work.threadId]?.hasRunningCoordinatorWorker
          )}
          client={target}
          onOpenBot={returnToBotMain}
          onOpenWork={(workId) => {
            void client
              .works!.get(link.bot.id, workId)
              .then((work) => {
                if (work.source) throw new Error("渠道任务不能改为本机私有会话。")
                returnToBotTask({ ...link, work })
              })
              .catch((error) =>
                toast.error(error instanceof Error ? error.message : "无法打开原任务。")
              )
          }}
        />
      </div>
    </div>
  )
}
