import type { BotDefinition } from "../../../../shared/bots/contracts"
import { useThreadStateSelector } from "@/lib/thread-context"
import type { BotAvatarMood } from "@/lib/bot-avatar-mood"
import { BotAvatar } from "./BotAvatar"
import { useBotRuntimeMood } from "./BotRuntimeAvatar"

const labels: Record<BotAvatarMood, string> = {
  idle: "正在准备",
  think: "正在思考",
  work: "正在处理",
  read: "正在阅读",
  write: "正在编写",
  run: "正在运行命令",
  search: "正在查看资料",
  send: "正在更新",
  orbit: "正在协作",
  stream: "正在回复",
  blocked: "等待你确认"
}

/** Mounted only for a live turn. Reuses the avatar clock and original Runtime state. */
export function BotActivity({
  bot,
  threadId
}: {
  bot: Pick<BotDefinition, "color" | "shape">
  threadId: string
}) {
  const mood = useBotRuntimeMood(threadId, true)
  const waiting = useThreadStateSelector(threadId, (state) =>
    state.pendingApproval || state.pendingApprovals.length
      ? "等待你确认"
      : state.pendingUserInput
        ? "等待你回复"
        : null
  )
  return (
    <div className="bot-activity" role="status" aria-live="polite" aria-atomic="true">
      <BotAvatar color={bot.color} shape={bot.shape} mood={mood} size={28} />
      <span>{waiting ?? labels[mood]}</span>
    </div>
  )
}
