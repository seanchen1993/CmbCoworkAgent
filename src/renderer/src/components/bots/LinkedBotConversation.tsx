import { toast } from "sonner"
import { returnToBotTask } from "./ConversationTaskControls"
import { useMemo } from "react"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import { useBots } from "./use-bots"
import { BotConversation } from "./BotConversation"
import { botWorkClient } from "@/lib/bot-work-client"

/** Same managed ChatContainer as the Bot entrance, not another conversation or runtime. */
export function LinkedBotConversation({ link }: { link: BotWorkConversationResolution }) {
  const client = window.api.bots,
    { snapshot } = useBots(client)
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
          backgroundBusy={Boolean(snapshot?.backgroundThreads?.includes(link.work.threadId))}
          client={target}
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
