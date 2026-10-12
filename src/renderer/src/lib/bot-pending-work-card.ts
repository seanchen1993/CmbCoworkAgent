import type { BotPendingCard, BotPendingWork } from "../../../shared/bot-work-pages"
/** A summary row supplies an address, never prompt/secret/action authority. */
export function assertBotPendingWorkCard(
  card: BotPendingCard,
  descriptor: BotPendingWork,
  owner: { hostId: string; dataEpoch: string }
): BotPendingCard {
  if (
    card.hostId !== owner.hostId ||
    card.dataEpoch !== owner.dataEpoch ||
    card.interaction.id !== descriptor.id ||
    card.interaction.revision !== descriptor.revision ||
    card.interaction.kind !== descriptor.kind ||
    card.interaction.status !== "pending" ||
    card.interaction.promptTruncated ||
    card.interaction.runId !== descriptor.address.runId ||
    card.run.id !== descriptor.address.runId ||
    card.run.botId !== descriptor.botId ||
    card.run.conversationId !== descriptor.address.conversationId ||
    card.run.threadRootId !== descriptor.address.threadRootId ||
    card.run.revision < descriptor.runRevision ||
    card.run.fence !== descriptor.runFence
  )
    throw new Error("待处理事项已变化，请刷新")
  return card
}
