import { Users } from "lucide-react"
import type { BotDefinition, BotGroupMention } from "../../../../shared/bots/contracts"
import { botAppearanceColor } from "@/lib/bot-chat-accent"
import { BotAvatar } from "./BotAvatar"

/** Display only: the persisted mention still owns the original label, range and recipient ID. */
export function BotMentionLabel({
  mention,
  bot
}: {
  mention: BotGroupMention
  bot?: BotDefinition
}) {
  return (
    <span
      className="bot-mention-identity"
      style={bot ? { color: botAppearanceColor(bot.color) } : undefined}
    >
      {bot ? (
        <BotAvatar color={bot.color} shape={bot.shape} size={17} animated={false} />
      ) : mention.botId === null ? (
        <Users size={15} aria-hidden="true" />
      ) : null}
      <span>{mention.label}</span>
    </span>
  )
}
