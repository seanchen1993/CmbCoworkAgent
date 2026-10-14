import type { ReactNode, Ref } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ChatScrollToBottomButton } from "./ChatScrollToBottomButton"

export function ChatMessageScrollArea({
  children,
  scrollRef,
  showScrollToBottom,
  hasUnread,
  unreadCount,
  onScrollToBottom
}: {
  children: ReactNode
  scrollRef?: Ref<HTMLDivElement>
  showScrollToBottom: boolean
  hasUnread: boolean
  unreadCount: number
  onScrollToBottom: () => void
}): React.JSX.Element {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" data-chat-message-scroll-area>
      <ScrollArea className="h-full" ref={scrollRef}>
        {children}
      </ScrollArea>
      <ChatScrollToBottomButton
        visible={showScrollToBottom}
        hasUnread={hasUnread}
        unreadCount={unreadCount}
        onScrollToBottom={onScrollToBottom}
      />
    </div>
  )
}
