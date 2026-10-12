import { ChevronDown, EyeOff } from "lucide-react"

export function BotHiddenConversations({
  count,
  expanded,
  toggle
}: {
  count: number
  expanded: boolean
  toggle(): void
}) {
  return (
    <button
      type="button"
      className="bot-hidden-conversations"
      aria-label={`已隐藏的 Bot ${count}`}
      aria-expanded={expanded}
      title={expanded ? "收起隐藏的 Bot" : "显示隐藏的 Bot"}
      onClick={toggle}
    >
      <ChevronDown size={14} className="bot-hidden-chevron" aria-hidden />
      <EyeOff size={17} className="bot-hidden-compact-icon" aria-hidden />
      <span className="bot-hidden-label">已隐藏的 Bot</span>
      <span className="bot-hidden-count" aria-hidden>
        {count}
      </span>
    </button>
  )
}
