import type { CSSProperties } from "react"
import type { CoworkBot } from "../../../../shared/bot-types"
import { BotAvatar } from "./BotAvatar"
import { COLORS, resolvePersonaColor } from "./upstream/grok-persona-geometry"

/** The same identity and palette as the roster; opening a sender only navigates. */
export function BotMessageAuthor({
  bot,
  botId,
  group,
  conversationId,
  open
}: {
  bot?: CoworkBot
  botId: string
  group: boolean
  conversationId?: string
  open: (conversationId: string) => void
}) {
  const color = resolvePersonaColor(botId, bot?.avatarColor)
  const style = {
    "--bot-author-color": color === "black" ? "var(--foreground)" : COLORS[color].dark
  } as CSSProperties
  const content = (
    <>
      <BotAvatar agentId={botId} size="xs" isStatic />
      <span className="bot-message-author-name">{bot?.name ?? "Bot"}</span>
    </>
  )
  return group && bot && conversationId ? (
    <button
      type="button"
      className="bot-message-author"
      data-group-author
      style={style}
      aria-label={`打开 ${bot?.name ?? "Bot"} 的聊天`}
      title={bot?.name ?? "Bot"}
      onClick={() => open(conversationId)}
    >
      {content}
    </button>
  ) : (
    <span className="bot-message-author" data-group-author={group || undefined} style={style}>
      {content}
    </span>
  )
}
