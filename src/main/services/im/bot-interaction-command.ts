import type { BotImEvent } from "../../../shared/bots/im-channel"
import { imRemoteUserInputService } from "./remote-user-input-service"
import { imRemoteApprovalService } from "./remote-approval-service"
import { imConversationStateStore } from "./conversation-state"
import { imEventStore } from "./event-store"
import { buildImProactiveReplies } from "./reply-segmentation"

/** Only interaction controls; legacy project selection commands never enter a Bot run. */
export async function handleBotImInteractionCommand(
  payload: BotImEvent,
  principalId: string,
  localEventId: string
): Promise<void> {
  const { event, route } = payload
  const match = event.message.text.trim().match(/^\/(回答|批准|拒绝|文字模式)(?:\s+([\s\S]*))?$/u)
  if (!match) return
  const [, command, argument = ""] = match
  const context = { principalId, conversationKey: event.conversationKey }
  let text: string
  if (command === "回答") {
    text = await imRemoteUserInputService.resolveAnswer({
      ...context,
      argument,
      botSenderId: route.senderId
    })
  } else if (command === "批准" || command === "拒绝") {
    text =
      route.kind === "group"
        ? "群聊不支持批准本机操作，请回到桌面确认。"
        : await imRemoteApprovalService.resolveCode({
            ...context,
            code: argument,
            decision: command === "批准" ? "approve" : "reject"
          })
  } else if (!["", "开", "关"].includes(argument)) {
    text = "用法：/文字模式 开 或 /文字模式 关。"
  } else {
    await imConversationStateStore.ensureConversation(context)
    const current = imConversationStateStore.getReplyMode(event.conversationKey)
    const mode =
      argument === "开" ? "text" : argument === "关" ? "card" : current === "text" ? "card" : "text"
    await imConversationStateStore.setReplyMode(event.conversationKey, mode)
    const results =
      mode === "text"
        ? await Promise.all([
            imRemoteUserInputService.resendPendingAsText(event.conversationKey),
            imRemoteApprovalService.resendPendingAsText(event.conversationKey)
          ])
        : []
    text = mode === "text" ? "已切到文字模式，可用短码回答待处理的问题。" : "已切回卡片模式。"
    if (results.some((result) => result.failed > 0))
      text += " 部分提示未能补发，请再次发送 /文字模式 开。"
  }
  // Existing reply drainer delivers this durable control receipt, never the model.
  await imEventStore.enqueueProactiveReplies(
    buildImProactiveReplies({
      deliveryId: `bot-interaction-command:${localEventId}`,
      conversationKey: event.conversationKey,
      text
    })
  )
}
