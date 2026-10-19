import type { BotClient, BotDefinition } from "../../../shared/bots/contracts"
import { createBotAppearance } from "../../../shared/bots/appearance"

/** A staged name is a composer choice, never a Bot identity or authorization. */
export type BotChatRecipient = { kind: "bot"; id: string } | { kind: "new"; name: string }

export function botChatRecipientKey(recipient: BotChatRecipient): string {
  return recipient.kind === "bot"
    ? `bot:${recipient.id}`
    : `new:${recipient.name.trim().toLocaleLowerCase()}`
}

/** Called under the existing new-chat submission lock; retain successful partial creates. */
export async function materializeBotChatRecipients(
  client: Pick<BotClient, "hostId" | "create">,
  recipients: readonly BotChatRecipient[],
  bots: readonly BotDefinition[],
  created: Map<string, BotDefinition>,
  isCurrent: () => boolean
): Promise<BotDefinition[]> {
  if (!recipients.length || recipients.length > 8) throw new Error("请选择 1 至 8 个 Bot。")
  if (new Set(recipients.map(botChatRecipientKey)).size !== recipients.length)
    throw new Error("收件人不能重复。")
  // Validate every existing identity before creating any new profile.
  const existing = new Map(bots.map((bot) => [bot.id, bot]))
  for (const recipient of recipients) {
    if (recipient.kind !== "bot") continue
    const bot = existing.get(recipient.id)
    if (!bot || bot.hostId !== client.hostId || bot.archived || bot.deleting)
      throw new Error("所选 Bot 已不可用，请重新选择。")
  }
  const result: BotDefinition[] = []
  for (const recipient of recipients) {
    if (!isCurrent()) throw new Error("收件人已切换，请重新选择。")
    if (recipient.kind === "bot") {
      result.push(existing.get(recipient.id)!)
      continue
    }
    const key = botChatRecipientKey(recipient)
    let bot = created.get(key)
    if (!bot) {
      bot = await client.create({
        name: recipient.name,
        instructions: "",
        modelRef: null,
        ...createBotAppearance()
      })
      if (bot.hostId !== client.hostId) throw new Error("创建结果不属于当前主机，请核对后重试。")
      created.set(key, bot)
    }
    if (bot.hostId !== client.hostId) throw new Error("收件人主机已变化，请重新选择。")
    if (!isCurrent()) throw new Error("收件人已切换，请重新选择。")
    result.push(bot)
  }
  return result
}
