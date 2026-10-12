import type { BotWorkspaceSnapshot } from "../../../shared/bot-types"
import { botViewAddress } from "./bot-thread-view"

export function botSteeringTarget(
  snapshot: BotWorkspaceSnapshot | null,
  viewId: string
): string | undefined {
  const address = botViewAddress(viewId)
  const conversation = snapshot?.conversations.find((item) => item.id === address.conversationId)
  if (conversation?.kind !== "direct") return undefined
  if (snapshot?.work?.projection === "paged") {
    const selected = snapshot.work.selected
    return selected?.view.conversationId === address.conversationId &&
      selected.view.threadRootId === address.threadRootId
      ? selected.steeringRunId
      : undefined
  }
  return snapshot?.runs.find(
    (run) =>
      run.conversationId === address.conversationId &&
      run.threadRootId === address.threadRootId &&
      run.botId === conversation.members[0] &&
      ["user", "skill-trial"].includes(run.source) &&
      ["running", "waiting_input"].includes(run.status)
  )?.id
}

export const botSteeringLabels = {
  pending: "等待采纳",
  accepted: "已采纳",
  not_applied: "任务已结束，这条要求尚未采纳",
  queued: "已转入下一项任务"
} as const
