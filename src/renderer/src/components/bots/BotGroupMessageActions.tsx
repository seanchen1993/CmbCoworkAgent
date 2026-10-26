import { useState } from "react"
import { Check, Copy, Reply } from "lucide-react"
import { BotMessageActions } from "./BotMessageActions"

/** Public group rows share host-bound actions with private Bot messages. */
export function BotGroupMessageActions({
  messageId,
  author,
  text,
  onReply,
  allowReaction = true,
  onError
}: {
  messageId?: string
  author: string
  text: string
  onReply?(): void
  allowReaction?: boolean
  onError(error: unknown): void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <BotMessageActions
      messageId={messageId ?? ""}
      allowReaction={allowReaction}
      label={`${author}的消息操作`}
      className="bot-group-message-actions"
      replyAction={
        onReply ? (
          <button
            type="button"
            className="bot-icon-button"
            aria-label={`回复${author}的消息`}
            title="回复"
            onClick={onReply}
          >
            <Reply size={16} />
          </button>
        ) : null
      }
      moreActions={
        text ? (
          <button
            type="button"
            className="bot-icon-button"
            aria-label={copied ? "已复制消息" : "复制群消息"}
            title={copied ? "已复制" : "复制群消息"}
            onFocus={() => setCopied(false)}
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => setCopied(true))
                .catch(onError)
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        ) : undefined
      }
    />
  )
}
