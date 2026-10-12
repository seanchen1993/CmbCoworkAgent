import { botApi } from "@/lib/bot-api"
import { useEffect, useState } from "react"
import { CornerUpRight, Reply, X } from "lucide-react"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type { BotMessage } from "../../../../shared/bot-types"
import { replyQuoteLabel } from "./upstream/grok-reply-preview"
import { botViewAddress } from "@/lib/bot-thread-view"

function botReplyLabel(target: Pick<BotMessage, "text" | "sender" | "entityReferences">): string {
  return replyQuoteLabel({
    kind: target.sender === "bot" ? "assistant-text" : "user-text",
    text: [target.entityReferences?.map((reference) => `@${reference.name}`).join(" "), target.text]
      .filter(Boolean)
      .join(" · ")
  })
}

export function BotReplyQuote({ message, open }: { message: BotMessage; open(id: string): void }) {
  // Internal run output/form answers do not have an explicitly chosen preview.
  if (
    !message.replyTo ||
    (!(message.sender === "user" && !message.runId) && message.replyPreview === undefined)
  )
    return null
  return (
    <button
      type="button"
      className="bot-reply-quote"
      aria-label="定位回复的消息"
      disabled={!message.replyPreview}
      onClick={() => open(message.replyTo!)}
    >
      <CornerUpRight size={13} className="shrink-0" />
      <span className="truncate">
        {message.replyPreview ? botReplyLabel(message.replyPreview) : "原消息不可用"}
      </span>
    </button>
  )
}

export function BotComposerReply({
  conversationId,
  targetId,
  disabled
}: {
  conversationId: string
  targetId: string
  disabled: boolean
}) {
  const loaded = useBotWorkspaceStore((state) =>
    state.messages[conversationId]?.find((message) => message.id === targetId)
  )
  const [resolved, setResolved] = useState<{
    id: string
    conversationId: string
    message?: BotMessage
    error?: string
  } | null>(null)
  useEffect(() => {
    if (loaded) return
    let cancelled = false
    void botApi
      .message({ conversationId: botViewAddress(conversationId).conversationId, id: targetId })
      .then((message) => {
        if (!cancelled) setResolved({ id: targetId, conversationId, message })
      })
      .catch((error) => {
        if (!cancelled)
          setResolved({
            id: targetId,
            conversationId,
            error: error instanceof Error ? error.message : "无法加载原消息"
          })
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, targetId, loaded])
  const current =
    resolved?.id === targetId && resolved.conversationId === conversationId ? resolved : null
  const target = loaded ?? current?.message
  return (
    <div className="bot-composer-reply" role="region" aria-label="回复消息">
      <Reply size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <span className="mr-2 text-muted-foreground">回复</span>
        {target ? botReplyLabel(target) : (current?.error ?? "正在加载原消息…")}
      </span>
      <button
        type="button"
        aria-label="取消回复"
        disabled={disabled}
        onClick={() => useBotWorkspaceStore.getState().reply(conversationId, undefined)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
