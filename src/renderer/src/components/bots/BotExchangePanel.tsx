import { useEffect, useRef } from "react"
import { ArrowLeftRight, Loader2 } from "lucide-react"
import { StreamingMarkdown } from "../chat/StreamingMarkdown"
import { BotAvatar } from "./BotAvatar"
import { formatMessageTimeLabel } from "@/lib/message-bubble-timing"
import { Virtuoso } from "react-virtuoso"
import { useBotExchange } from "./use-bot-exchange"
import type { BotClient } from "../../../../shared/bots/contracts"

/** Reads the existing dispatch/outbox records only while open; no transcript copy or polling. */
export function BotExchangePanel({
  client,
  botId,
  taskId,
  groupId,
  onClose
}: {
  client: BotClient
  botId: string
  taskId: string
  groupId?: string
  onClose(): void
}) {
  const history = useBotExchange(client, botId, taskId, groupId)
  const exchange = history.anchor
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  const active = exchange && ["queued", "running", "waiting_user"].includes(exchange.state)
  return (
    <section
      className="bot-exchange-panel"
      aria-label="Bot 交流"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="bot-exchange-header">
        <h2 className="bot-title-pill">
          {exchange ? (
            <>
              <BotAvatar color={exchange.sender.color} shape={exchange.sender.shape} size={28} />
              <span>{exchange.sender.name}</span>
              <ArrowLeftRight size={14} className="shrink-0 text-muted-foreground" />
              <BotAvatar
                color={exchange.recipient.color}
                shape={exchange.recipient.shape}
                size={28}
              />
              <span>{exchange.recipient.name}</span>
            </>
          ) : (
            "Bot 交流"
          )}
        </h2>
      </header>
      <div className="bot-exchange-messages" role="log" aria-label="Bot 交流记录">
        {history.error && (
          <div className="bot-notice" role="alert">
            <span>{history.error}</span>
            <button onClick={history.refresh}>重试</button>
          </div>
        )}
        {!exchange && !history.error && (
          <div className="bot-empty">
            <Loader2 className="size-5 animate-spin" aria-label="正在读取交流记录" />
          </div>
        )}
        {exchange && (
          <>
            {history.before && (
              <button
                className="bot-exchange-older"
                disabled={history.loading}
                onClick={history.loadOlder}
              >
                {history.loading ? "正在读取…" : "查看更早的交流"}
              </button>
            )}
            <Virtuoso
              className="bot-exchange-timeline"
              data={history.messages}
              firstItemIndex={history.firstIndex}
              initialTopMostItemIndex={Math.max(0, history.messages.length - 1)}
              computeItemKey={(_, item) => item.id}
              followOutput={true}
              itemContent={(index, item) => {
                const previous = history.messages[index - history.firstIndex - 1]
                const showDate =
                  !previous ||
                  item.at - previous.at >= 30 * 60_000 ||
                  new Date(item.at).toDateString() !== new Date(previous.at).toDateString()
                return (
                  <>
                    {showDate && (
                      <time className="bot-message-date" dateTime={new Date(item.at).toISOString()}>
                        {formatMessageTimeLabel(item.at)}
                      </time>
                    )}
                    <article className="bot-exchange-message">
                      <BotAvatar color={item.author.color} shape={item.author.shape} size={24} />
                      <div className="bot-exchange-message-content">
                        <div className="bot-exchange-author" style={{ color: item.author.color }}>
                          <span>{item.author.name}</span>
                        </div>
                        <div
                          className="bot-exchange-bubble"
                          title={new Date(item.at).toLocaleString()}
                        >
                          <StreamingMarkdown isStreaming={false}>{item.message}</StreamingMarkdown>
                        </div>
                      </div>
                    </article>
                  </>
                )
              }}
            />
            {!exchange.reply && (
              <p className="bot-exchange-status">
                {active
                  ? exchange.state === "waiting_user"
                    ? "等待人工处理，处理后继续协作"
                    : "任务已交办，回复会自动显示在这里"
                  : "此次协作没有可显示的回执"}
              </p>
            )}
            {exchange.reply && !exchange.reply.delivered && (
              <p className="bot-exchange-status">回复已生成，正在等待投递</p>
            )}
          </>
        )}
      </div>
      <footer className="bot-exchange-footer">
        <button ref={closeRef} onClick={onClose}>
          关闭聊天
        </button>
      </footer>
    </section>
  )
}
