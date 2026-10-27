import { ArrowUpRight, ChevronRight, MessagesSquare } from "lucide-react"
import type { BotWorkHistoryPage } from "../../../../shared/bots/work-history"

export function BotHistorySources({
  page,
  onOpen
}: {
  page: BotWorkHistoryPage
  onOpen(href: string): void
}) {
  return (
    <details className="bot-history-sources" data-bot-history-sources>
      <summary>
        <MessagesSquare size={14} aria-hidden="true" />
        <span>会话来源</span>
        <span className="bot-source-count">{page.entries.length}</span>
        <ChevronRight size={14} className="bot-source-chevron" aria-hidden="true" />
      </summary>
      <div className="bot-history-source-list">
        <p className="bot-history-source-title">{page.work.title}</p>
        {page.entries.map((entry) => (
          <button
            type="button"
            key={entry.href}
            onClick={() => onOpen(entry.href)}
            title="打开原会话并定位这条消息"
          >
            <span className="bot-source-copy">
              <span className="bot-history-source-meta">
                {entry.role === "user" ? "你" : "Bot"}
                {Number.isFinite(entry.createdAt) && (
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
  )
}
