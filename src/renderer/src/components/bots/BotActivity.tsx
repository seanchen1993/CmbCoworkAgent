import type { BotDefinition } from "../../../../shared/bots/contracts"
import { useThreadStateSelector } from "@/lib/thread-context"
import type { BotAvatarMood } from "@/lib/bot-avatar-mood"
import { BotAvatar } from "./BotAvatar"
import { useBotRuntimeMood } from "./BotRuntimeAvatar"

const labels: Record<BotAvatarMood, string> = {
  idle: "正在准备",
  think: "正在思考",
  work: "正在处理",
  read: "处理阅读请求",
  write: "处理写入请求",
  run: "处理命令请求",
  search: "正在查看资料",
  send: "正在更新",
  orbit: "正在协作",
  stream: "正在回复",
  blocked: "等待你确认"
}

/** Mounted only for a live turn. Reuses the avatar clock and original Runtime state. */
export function BotActivity({
  bot,
  threadId,
  taskCreatedAt,
  waiting = false
}: {
  bot: Pick<BotDefinition, "color" | "shape">
  threadId: string
  taskCreatedAt?: number
  waiting?: boolean
}) {
  const mood = useBotRuntimeMood(threadId, true, waiting, taskCreatedAt)
  const pendingLabel = useThreadStateSelector(threadId, (state) =>
    state.pendingApproval || state.pendingApprovals.length
      ? "等待你确认"
      : state.pendingUserInput
        ? "等待你回复"
        : null
  )
  return (
    <div className="bot-activity" role="status" aria-live="polite" aria-atomic="true">
      <BotAvatar color={bot.color} shape={bot.shape} mood={mood} size={28} />
      <span>{pendingLabel ?? labels[mood]}</span>
    </div>
  )
}
