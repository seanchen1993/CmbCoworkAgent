import { ArrowUpRight, ChevronRight, MessagesSquare } from "lucide-react"
import type { BotHistoryPage } from "@/lib/bot-history-receipt"

export function BotHistorySources({
  page,
  messageId,
  onOpen
}: {
  page: BotHistoryPage
  messageId?: string
  onOpen(href: string): void
}) {
  const ordinary = "thread" in page
  const title = ordinary ? page.thread.title : page.work.title
  const selected = (ordinary && messageId ? page.entries.find(entry => entry.source.messageId === messageId) : undefined) ??
    page.entries.reduce<(typeof page.entries)[number] | undefined>(
    (found, entry) => !found || entry.ordinal > found.ordinal ? entry : found, undefined
  )
  return (
    <>
    {ordinary && selected && (
      <button type="button" className="bot-exchange-link max-w-full" style={{ color: "var(--bot-text)" }} title={title}
        aria-label={`打开原会话：${title}`} onClick={() => onOpen(selected.href)}>
        <MessagesSquare size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{title}</span>
        <ArrowUpRight size={14} className="shrink-0" aria-hidden="true" />
      </button>
    )}
    <details className="bot-history-sources" data-bot-history-sources>
      <summary>
        <MessagesSquare size={14} aria-hidden="true" />
        <span>会话来源</span>
        <span className="bot-source-count">{page.entries.length}</span>
        <ChevronRight size={14} className="bot-source-chevron" aria-hidden="true" />
      </summary>
      <div className="bot-history-source-list">
        <p className="bot-history-source-title">{title}</p>
        {page.entries.map((entry) => (
          <button
            type="button"
            key={entry.href}
            onClick={() => onOpen(entry.href)}
            title="打开原会话并定位这条消息"
          >
            <span className="bot-source-copy">
              <span className="bot-history-source-meta">
                {entry.role === "user" ? "你" : ordinary ? "助手" : "Bot"}
                {"createdAt" in entry && Number.isFinite(entry.createdAt) && (
                  <time dateTime={new Date(entry.createdAt).toISOString()}>
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </time>
                )}
              </span>
              <span className="bot-history-source-text">{entry.text}</span>
            </span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
      {page.coverage !== "exhausted" && (
        <small>
          {page.coverage === "more" ? "本页记录 · 还有更早的历史" : "部分内容未完整读取"}
        </small>
      )}
    </details>
    </>
  )
}
