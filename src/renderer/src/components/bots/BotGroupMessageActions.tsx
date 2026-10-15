import { useState } from "react"
import { Check, Copy, Reply } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Same hover/focus action pattern as Hermes group-chat-view; no transcript state. */
export function BotGroupMessageActions({
  author,
  text,
  onReply,
  onError
}: {
  author: string
  text: string
  onReply(): void
  onError(error: unknown): void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div
      className="bot-group-message-actions"
      role="toolbar"
      aria-label={`${author}的消息操作`}
      onMouseLeave={() => setCopied(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setCopied(false)
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="bot-icon-button"
            aria-label={`回复${author}的消息`}
            onClick={onReply}
          >
            <Reply size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent>回复</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="bot-icon-button"
            aria-label={copied ? "已复制消息" : "复制群消息"}
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => setCopied(true))
                .catch(onError)
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "已复制" : "复制"}</TooltipContent>
      </Tooltip>
    </div>
  )
}
