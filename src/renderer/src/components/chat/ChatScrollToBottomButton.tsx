import { ChevronDown } from "lucide-react"

interface ChatScrollToBottomButtonProps {
  visible: boolean
  hasUnread: boolean
  unreadCount: number
  onScrollToBottom: () => void
}

export function ChatScrollToBottomButton({
  visible,
  hasUnread,
  unreadCount,
  onScrollToBottom
}: ChatScrollToBottomButtonProps): React.JSX.Element | null {
  if (!visible) return null

  return (
    <button
      type="button"
      onClick={() => {
        onScrollToBottom()
      }}
      className="absolute bottom-full left-1/2 z-30 mb-3 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="回到会话底部"
      title="回到会话底部"
    >
      <ChevronDown className="size-4" />
      {hasUnread && (
        <span
          className="absolute -right-2 -top-2 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-5 text-primary-foreground"
          aria-label={unreadCount > 0 ? `${unreadCount} 条未读消息` : "有未读更新"}
        >
          {unreadCount > 99 ? "99+" : unreadCount > 0 ? unreadCount : "•"}
        </span>
      )}
    </button>
  )
}
