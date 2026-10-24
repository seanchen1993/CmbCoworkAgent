import { Users } from "lucide-react"
import type {
  BotDefinition,
  BotGroupMention,
  BotMessageMention
} from "../../../../shared/bots/contracts"
import { botAppearanceColor } from "@/lib/bot-chat-accent"
import { BotAvatar } from "./BotAvatar"

/** Display only: the persisted mention still owns the original label, range and recipient ID. */
export function BotMentionLabel({
  mention,
  bot
}: {
  mention: BotGroupMention | BotMessageMention
  bot?: BotDefinition
}) {
  return (
    <span
      className="bot-mention-identity"
      style={bot ? { color: botAppearanceColor(bot.color) } : undefined}
    >
      {bot ? (
        <BotAvatar color={bot.color} shape={bot.shape} size={17} animated={false} />
      ) : ("kind" in mention && mention.kind === "group") || mention.botId === null ? (
        <Users size={15} aria-hidden="true" />
      ) : null}
      <span>{mention.label}</span>
    </span>
  )
}
