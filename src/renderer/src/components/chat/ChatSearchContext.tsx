import { memo } from "react"
import {
  chatSearchLocationKey,
  type ChatSearchLocation
} from "../../../../shared/chat-search-types"

/** Search-only presentation: never changes the message or its copy/edit/model payload. */
export const ChatSearchContext = memo(function ChatSearchContext({
  location
}: {
  location?: ChatSearchLocation
}): React.JSX.Element | null {
  if (!location) return null
  return (
    <aside className="my-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <div data-chat-search-ignore className="mb-1 text-xs text-muted-foreground">
        匹配内容上下文
      </div>
      <div
        data-chat-search-text
        data-chat-search-context-key={chatSearchLocationKey(location)}
        className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      >
        {location.context.slice(0, location.contextStart)}
        <span data-chat-search-context-hit>
          {location.context.slice(location.contextStart, location.contextEnd)}
        </span>
        {location.context.slice(location.contextEnd)}
      </div>
    </aside>
  )
})
