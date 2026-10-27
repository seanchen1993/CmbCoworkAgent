import { useEffect, useState } from "react"
import { ArrowUpRight, ChevronRight, Link2 } from "lucide-react"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkAssociation } from "../../../../shared/bots/work-history"

/** Durable bindings are the source, so retries/restarts never manufacture duplicate notices. */
export function BotAssociationNotices({
  client,
  botId,
  onOpenWork
}: {
  client: BotClient
  botId: string
  onOpenWork(id: string): void
}) {
  const [page, setPage] = useState<{
    botId: string
    items: BotWorkAssociation[]
    hasMore: boolean
  } | null>(null)
  useEffect(() => {
    let disposed = false,
      requested = false,
      running = false
    const refresh = async () => {
      requested = true
      if (running || !client.works?.associations) return
      running = true
      try {
        while (requested && !disposed) {
          requested = false
          const result = await client.works.associations(botId)
          if (!disposed) setPage({ ...result, botId })
        }
      } catch {
        if (!disposed) setPage(null)
      } finally {
        running = false
      }
    }
    void refresh()
    const unsubscribe = client.subscribe(() => {
      void refresh()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [client, botId])
  if (page?.botId !== botId || !page.items.length) return null
  return (
    <details className="bot-association-notices" data-bot-association-notice>
      <summary>
        <Link2 size={14} aria-hidden="true" />
        <span>已关联会话</span>
        <span className="bot-association-preview">{page.items[0].title}</span>
        {page.items.length > 1 && (
          <span className="bot-source-count">
            {page.items.length}
            {page.hasMore ? "+" : ""}
          </span>
        )}
        <ChevronRight size={14} className="bot-source-chevron" aria-hidden="true" />
      </summary>
      <p>在这里回顾历史，或打开原会话继续讨论。</p>
      <div className="bot-association-list">
        {page.items.map((item) => (
          <button
            type="button"
            key={item.workId}
            onClick={() => onOpenWork(item.workId)}
            title={item.goal}
          >
            <span className="bot-source-copy">
              <span className="bot-association-title">{item.title}</span>
              <span className="bot-association-goal">{item.goal}</span>
            </span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
      {page.hasMore && <p>更多关联会话见右侧独立任务。</p>}
    </details>
  )
}
