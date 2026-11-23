import { lazy, Suspense, useState } from "react"
import type { ReactNode } from "react"
import { MoreHorizontal, Smile } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useBotMessageReactions } from "./bot-message-reactions-context"

const FullEmojiPicker = lazy(() => import("./BotEmojiPicker"))
const quickEmoji = ["👍", "👎", "❤️", "😂", "🎉"]
const actionClass =
  "inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 disabled:opacity-40"

/** Shared by real Bot thread rows and public group timeline rows. */
export function BotMessageActions({
  messageId,
  replyAction,
  moreActions,
  allowReaction = true,
  className,
  label = "消息操作"
}: {
  messageId: string
  replyAction?: ReactNode
  moreActions?: ReactNode
  allowReaction?: boolean
  className?: string
  label?: string
}) {
  const reactions = useBotMessageReactions()
  const state = reactions?.stateFor(messageId)
  const pending = reactions?.pending(messageId) ?? false
  const error = reactions?.errorFor(messageId)
  const disabled = !allowReaction || !state?.canReact || Boolean(reactions?.readOnly) || pending
  const pickerDisabled = !reactions || Boolean(reactions.readOnly) || pending
  const selected = new Set(state?.reactions.filter((item) => item.mine).map((item) => item.emoji))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [fullPicker, setFullPicker] = useState(false)
  const toggle = (emoji: string) => {
    if (disabled) return
    void reactions?.set(messageId, emoji, !selected.has(emoji))
    setPickerOpen(false)
    setFullPicker(false)
  }
  return (
    <>
      <div
        data-message-actions
        data-open={pickerOpen || moreOpen}
        role="toolbar"
        aria-label={label}
        className={cn("flex items-center gap-1", className)}
      >
        {allowReaction && (
          <Popover
            open={pickerOpen}
            onOpenChange={(open) => {
              if (open && !pickerDisabled && !state?.canReact) reactions?.retry()
              setPickerOpen(open)
              if (!open) setFullPicker(false)
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="添加表情回应"
                title={disabled ? "等待消息确认或当前只读" : "添加表情回应"}
                disabled={pickerDisabled}
                className={actionClass}
              >
                <Smile size={16} />
              </button>
            </PopoverTrigger>
            <PopoverContent data-bot-popup align="start" className="p-2" aria-label="选择表情回应">
              {fullPicker ? (
                <Suspense fallback={<p role="status">正在加载表情…</p>}>
                  <FullEmojiPicker selected={selected} disabled={disabled} onSelect={toggle} />
                </Suspense>
              ) : (
                <div className="flex items-center gap-1">
                  {quickEmoji.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`${selected.has(emoji) ? "取消" : "回应"} ${emoji}`}
                      aria-pressed={selected.has(emoji)}
                      disabled={disabled}
                      className="size-8 rounded text-xl hover:bg-accent aria-pressed:bg-accent"
                      onClick={() => toggle(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label="更多表情"
                    className={actionClass}
                    onClick={() => setFullPicker(true)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}
        {replyAction}
        {moreActions && (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="更多消息操作"
                title="更多消息操作"
                className={actionClass}
              >
                <MoreHorizontal size={16} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              data-bot-popup
              align="start"
              className="flex items-center gap-1 p-2"
              aria-label="更多消息操作"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button")) setMoreOpen(false)
              }}
            >
              {moreActions}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {Boolean(state?.reactions.length) && (
        <div
          className="bot-message-reactions"
          role="group"
          aria-label="消息表情回应"
          data-message-reactions
        >
          {state?.reactions.map((item) => (
            <button
              key={item.emoji}
              type="button"
              disabled={disabled}
              aria-label={`${item.mine ? "取消" : "添加"}回应 ${item.emoji}，${item.count} 人${item.actors?.length ? `；${item.actors.map((actor) => actor.name).join("、")} 用 ${item.emoji} 回应了` : ""}`}
              title={
                item.actors?.length
                  ? `${item.actors.map((actor) => actor.name).join("、")} 用 ${item.emoji} 回应了`
                  : undefined
              }
              aria-pressed={item.mine}
              onClick={() => toggle(item.emoji)}
              className="bot-message-reaction"
            >
              <span>{item.emoji}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          {error}
          <button type="button" className="underline" onClick={() => reactions?.retry()}>
            重新读取回应
          </button>
        </div>
      )}
    </>
  )
}
