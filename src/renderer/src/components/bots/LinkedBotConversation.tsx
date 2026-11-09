import { toast } from "sonner"
import { returnToBotTask } from "./ConversationTaskControls"
import { useMemo } from "react"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import { useBots } from "./use-bots"
import { BotConversation } from "./BotConversation"
import { botWorkClient } from "@/lib/bot-work-client"
import { useThreadStateSummaries } from "@/lib/thread-context"

/** Same managed ChatContainer as the Bot entrance, not another conversation or runtime. */
export function LinkedBotConversation({ link }: { link: BotWorkConversationResolution }) {
  const client = window.api.bots,
    { snapshot } = useBots(client)
  const threadSummaries = useThreadStateSummaries()
  const target = useMemo(
    () => botWorkClient(client, link.work),
    [client, link.work.id, link.work.threadId]
  )
  const tasks = snapshot?.tasks.filter((task) => task.threadId === link.work.threadId) ?? []
  return (
    <div className="bots-workspace">
      <div className="bots-conversation">
        <BotConversation
          bot={link.bot}
          work={link.work}
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
          onOpenWork={(workId) => {
            void client
              .works!.get(link.bot.id, workId)
              .then(async (work) => {
                if (work.audienceKey !== link.work.audienceKey)
                  throw new Error("此任务不属于当前会话。")
                const resolved = await client.conversations!.resolve(work.threadId)
                if (!resolved) throw new Error("原任务会话不可用。")
                returnToBotTask(resolved)
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
