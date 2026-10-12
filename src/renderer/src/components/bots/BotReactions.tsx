import { botApi } from "@/lib/bot-api"
import { useRef, useState } from "react"
import { SmilePlus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { isBotReactionEmoji } from "../../../../shared/bot-reactions"
import {
  QUICK_REACTION_EMOJIS,
  projectReactionCounts,
  projectTranscriptReactions
} from "../../../../shared/upstream/grok-reactions"
import type { BotMessage } from "../../../../shared/bot-types"

export function BotReactions({ message }: { message: BotMessage }) {
  const [open, setOpen] = useState(false),
    [custom, setCustom] = useState(""),
    [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const bots = useBotWorkspaceStore((state) => state.snapshot?.bots)
  const supported = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("message-reactions")
  )
  const projected = projectTranscriptReactions(message.reactionState?.reactions)
  const groups = projectReactionCounts(projected.reactions)
  const react = async (emoji: string) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const next = await botApi.react({
        conversationId: message.conversationId,
        messageId: message.id,
        emoji,
        revision: message.reactionState?.revision ?? 0,
        active: !projected.myReactions.has(emoji)
      })
      useBotWorkspaceStore.getState().updateReactions(message.conversationId, [next])
      setOpen(false)
      setCustom("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "回应未保存，请重试")
      await useBotWorkspaceStore
        .getState()
        .refresh()
        .catch(() => {})
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  if (!supported || message.sender === "system") return null
  return (
    <div className="bot-message-reactions mt-1 flex min-h-6 items-center gap-1.5">
      {groups.map((group) => (
        <button
          key={group.emoji}
          type="button"
          disabled={busy}
          className={cn(
            "rounded-full border px-2 py-0.5 text-sm transition-colors hover:bg-muted disabled:opacity-50",
            group.isMine ? "border-primary/30 bg-primary/10" : "border-border/70 bg-background"
          )}
          aria-label={`${group.isMine ? "移除" : "添加"} ${group.emoji} 回应`}
          aria-pressed={group.isMine}
          title={group.reactors
            .map((actor) =>
              actor === "me" ? "你" : (bots?.find((bot) => bot.id === actor)?.name ?? "Bot")
            )
            .join("、")}
          onClick={() => void react(group.emoji)}
        >
          <span aria-hidden="true">{group.emoji}</span>
          {group.count > 1 && <span className="ml-1 text-xs tabular-nums">{group.count}</span>}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label="添加表情回应"
            className="bot-reaction-trigger size-6 rounded-full text-muted-foreground"
          >
            <SmilePlus size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-64 space-y-3 p-3"
          align="start"
          side="top"
          aria-label="表情回应"
        >
          <div className="flex justify-between" role="group" aria-label="快捷表情">
            {QUICK_REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                disabled={busy}
                aria-label={`回应 ${emoji}`}
                aria-pressed={projected.myReactions.has(emoji)}
                className={cn(
                  "size-8 rounded-md text-xl transition-transform hover:scale-110 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  projected.myReactions.has(emoji) && "bg-primary/10"
                )}
                onClick={() => void react(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (isBotReactionEmoji(custom)) void react(custom)
            }}
          >
            <Input
              value={custom}
              disabled={busy}
              maxLength={16}
              onChange={(event) => setCustom(event.target.value)}
              aria-label="其他表情"
              placeholder="粘贴一个表情"
              className="h-8"
            />
            <Button type="submit" size="sm" disabled={busy || !isBotReactionEmoji(custom)}>
              发送
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  )
}
