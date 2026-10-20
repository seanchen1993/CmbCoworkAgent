import { useCallback, useEffect, useRef, useState } from "react"
import type { BotClient, BotDefinition } from "../../../../shared/bots/contracts"
import type {
  BotMockBinding,
  BotMockEvent,
  BotMockFeedEntry
} from "../../../../shared/bots/mock-channel"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { botErrorMessage } from "@/lib/bot-error-message"

const LABELS: Record<string, string> = {
  queued: "等待执行",
  running: "正在处理",
  waiting_user: "等待处理",
  completed: "已回复",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "执行已中断，请核对",
  outcome_unknown: "执行结果待核对",
  pending: "等待送达",
  sending: "正在送达",
  sent: "已送达模拟渠道",
  unknown: "送达结果待核对，不会自动重发",
  blocked: "回传已阻止",
  ignored: "群消息未触发 Bot"
}
const merge = <T extends { id: string }>(older: T[], latest: T[]) => [
  ...new Map([...older, ...latest].map((v) => [v.id, v])).values()
]
const mergeBindings = (older: BotMockBinding[], latest: BotMockBinding[]) =>
  merge(older, latest).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
const mergeHistory = (older: BotMockFeedEntry[], latest: BotMockFeedEntry[]) =>
  merge(older, latest).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

/** Explicit local simulation. It uses the original Bot runtime and never connects to an IM service. */
export function BotMockChannelDialog({
  client,
  bot,
  revision,
  onClose,
  onOpenWork
}: {
  client: BotClient
  bot: BotDefinition
  revision: number
  onClose(): void
  onOpenWork(id: string): void
}) {
  const api = client.mock!
  const [bindings, setBindings] = useState<BotMockBinding[]>([]),
    [bindingCursor, setBindingCursor] = useState<string | null>(null)
  const [id, setId] = useState(""),
    [binding, setBinding] = useState<BotMockBinding | null>(null)
  const [entries, setEntries] = useState<BotMockFeedEntry[]>([]),
    [cursor, setCursor] = useState<string | null>(null)
  const [creating, setCreating] = useState(false),
    [kind, setKind] = useState<"dm" | "group">("dm"),
    [key, setKey] = useState(""),
    [label, setLabel] = useState(""),
    [senders, setSenders] = useState("")
  const [sender, setSender] = useState(""),
    [text, setText] = useState(""),
    [mention, setMention] = useState(false),
    [reply, setReply] = useState("")
  const [historyNotice, setHistoryNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const current = useRef({ id, epoch: 0 })
  current.current.id = id
  const createCommand = useRef<{ fingerprint: string; id: string } | null>(null)
  const pendingKey = `bot-mock-pending:${client.hostId}:${bot.id}`
  const retainedKey = `${pendingKey}:retained`
  const [retained, setRetained] = useState<BotMockEvent[]>(() => {
    try {
      const records = JSON.parse(localStorage.getItem(retainedKey) ?? "[]")
      return Array.isArray(records) ? records : []
    } catch {
      return []
    }
  })
  const [retainedPage, setRetainedPage] = useState(0)
  const [pending, setPending] = useState<BotMockEvent | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(pendingKey) ?? "null")
      return v?.simulation === true && typeof v.eventId === "string" ? v : null
    } catch {
      return null
    }
  })
  const persist = (v: BotMockEvent | null) => {
    if (v) localStorage.setItem(pendingKey, JSON.stringify(v))
    else localStorage.removeItem(pendingKey)
    setPending(v)
  }
  const list = useCallback(async () => {
    const p = await api.bindings(bot.id)
    setBindings((old) => mergeBindings(old, p.items))
    setBindingCursor(p.before)
    setId((old) => old || p.items[0]?.id || "")
  }, [api, bot.id])
  useEffect(() => {
    let live = true
    void list().catch((e) => {
      if (live) setError(botErrorMessage(e))
    })
    return () => {
      live = false
      current.current.epoch++
    }
  }, [list])
  const historyWindow = useRef<{
    items: BotMockFeedEntry[]
    before: string | null | undefined
    generation: number
  }>({ items: [], before: undefined, generation: 0 })
  const refresh = useRef<{ running: Promise<void> | null; requested: boolean }>({
    running: null,
    requested: false
  })
  const reload = useCallback((): Promise<void> => {
    refresh.current.requested = true
    if (refresh.current.running) return refresh.current.running
    const run = async () => {
      while (refresh.current.requested) {
        refresh.current.requested = false
        const selected = current.current.id,
          epoch = current.current.epoch
        if (!selected) continue
        try {
          const [b, p] = await Promise.all([
            api.binding(bot.id, selected),
            api.history(bot.id, selected)
          ])
          if (current.current.id !== selected || current.current.epoch !== epoch) continue
          const previous = historyWindow.current
          const overlaps = p.items.some((item) => previous.items.some((old) => old.id === item.id))
          // A disjoint latest page cannot be joined with the old cursor without skipping history.
          // Reset only this bounded window; the new cursor exposes every omitted older row.
          if (previous.before === undefined || (p.items.length > 0 && !overlaps)) {
            historyWindow.current = {
              items: mergeHistory([], p.items),
              before: p.before,
              generation: previous.generation + 1
            }
            setCursor(p.before)
            if (previous.items.length)
              setHistoryNotice("新增消息较多，已显示最近消息；可加载更早消息继续查看。")
          } else {
            historyWindow.current = { ...previous, items: mergeHistory(previous.items, p.items) }
          }
          setEntries(historyWindow.current.items)
          setBinding(b)
          setBindings((old) => mergeBindings(old, [b]))
          setSender((old) => (b.allowedSenderIds.includes(old) ? old : b.allowedSenderIds[0]))
          setError(null)
        } catch (e) {
          if (current.current.id === selected && current.current.epoch === epoch)
            setError(botErrorMessage(e))
        }
      }
    }
    refresh.current.running = run().finally(() => {
      refresh.current.running = null
    })
    return refresh.current.running
  }, [api, bot.id])
  useEffect(() => {
    current.current.epoch++
    historyWindow.current = {
      items: [],
      before: undefined,
      generation: historyWindow.current.generation + 1
    }
    setBinding(null)
    setEntries([])
    setCursor(null)
    setReply("")
    setText("")
    setError(null)
    setHistoryNotice(null)
  }, [id])
  useEffect(() => {
    void reload()
  }, [id, revision, reload])
  const action = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(botErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const create = () =>
    action(async () => {
      const input = {
        simulation: true as const,
        botId: bot.id,
        kind,
        channelKey: key.trim(),
        label: label.trim(),
        allowedSenderIds: senders.split(/[,，\s]+/).filter(Boolean)
      }
      const fingerprint = JSON.stringify(input)
      if (createCommand.current?.fingerprint !== fingerprint)
        createCommand.current = { fingerprint, id: crypto.randomUUID() }
      const b = await api.create({ ...input, operationId: createCommand.current.id })
      createCommand.current = null
      setBindings((old) => mergeBindings(old, [b]))
      setId(b.id)
      setCreating(false)
    })
  const inject = () =>
    action(async () => {
      if (!binding) return
      const bId = binding.id
      const event =
        pending?.bindingId === bId
          ? pending
          : {
              simulation: true as const,
              bindingId: bId,
              eventId: crypto.randomUUID(),
              messageId: crypto.randomUUID(),
              senderId: sender,
              text,
              mentionsBotIds: mention ? [bot.id] : [],
              ...(reply ? { replyToMessageId: reply } : {})
            }
      persist(event) // Store the original event before IPC; a lost reply must never create a new event.
      await api.inject(event)
      persist(null)
      if (current.current.id !== bId) return
      setText("")
      setReply("")
      await reload()
    })
  const endCheck = () =>
    action(async () => {
      if (!pending || pending.bindingId !== id) return
      const records = [...retained.filter((v) => v.eventId !== pending.eventId), pending]
      // Save first. A quota/storage failure must keep the original pending event intact.
      localStorage.setItem(retainedKey, JSON.stringify(records))
      setRetained(records)
      setRetainedPage(Math.floor((records.length - 1) / 5))
      persist(null)
      setText("")
    })
  const more = () =>
    action(async () => {
      if (!cursor) return
      const selected = id,
        epoch = current.current.epoch,
        generation = historyWindow.current.generation
      const p = await api.history(bot.id, selected, cursor)
      if (
        current.current.id !== selected ||
        current.current.epoch !== epoch ||
        historyWindow.current.generation !== generation
      )
        return
      const items = mergeHistory(p.items, historyWindow.current.items)
      historyWindow.current = { items, before: p.before, generation }
      setEntries(items)
      setCursor(p.before)
    })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="bot-mock-dialog" data-bot-mock-dialog>
        <DialogHeader>
          <DialogTitle>模拟 IM 接入 · {bot.name}</DialogTitle>
          <DialogDescription>
            仅本地模拟，不连接真实
            IM。外部受众仅支持文字和同受众工作；不会获得本机文件、浏览器、技能或私人记忆。
          </DialogDescription>
        </DialogHeader>
        <div className="bot-mock-toolbar">
          <select aria-label="模拟渠道" value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">选择模拟渠道</option>
            {bindings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} · {b.kind === "dm" ? "个人" : "群"}
                {b.revoked ? "（已撤销）" : ""}
              </option>
            ))}
          </select>
          <button onClick={() => setCreating(!creating)}>新建绑定</button>
          {bindingCursor && (
            <button
              onClick={() =>
                void action(async () => {
                  const p = await api.bindings(bot.id, bindingCursor)
                  setBindings((old) => mergeBindings(old, p.items))
                  setBindingCursor(p.before)
                })
              }
            >
              更多绑定
            </button>
          )}
        </div>
        {creating && (
          <form
            className="bot-mock-create"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <label>
              受众类型
              <select
                aria-label="受众类型"
                value={kind}
                onChange={(e) => setKind(e.target.value as "dm" | "group")}
              >
                <option value="dm">个人</option>
                <option value="group">群</option>
              </select>
            </label>
            <label>
              渠道标识
              <input
                required
                value={key}
                maxLength={160}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <label>
              显示名称
              <input
                required
                value={label}
                maxLength={100}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label>
              允许的模拟用户 ID
              <input
                required
                value={senders}
                onChange={(e) => setSenders(e.target.value)}
                placeholder={kind === "dm" ? "例如 alice（仅一人）" : "例如 alice, bob"}
              />
            </label>
            <p>受众与身份创建后固定；改变用途请撤销后新建绑定。</p>
            <button disabled={busy || bot.archived || bot.deleting} type="submit">
              创建模拟绑定
            </button>
          </form>
        )}
        {binding && (
          <>
            <div className="bot-mock-toolbar">
              <span>
                {binding.revoked
                  ? "已撤销"
                  : binding.online
                    ? "模拟设备在线"
                    : "模拟设备离线 · 仅排队"}
              </span>
              <button
                disabled={busy || binding.revoked}
                onClick={() =>
                  void action(async () => {
                    const b = await api.online(bot.id, binding.id, !binding.online)
                    if (current.current.id === b.id) setBinding(b)
                  })
                }
              >
                {binding.online ? "模拟离线" : "恢复在线"}
              </button>
              <button
                disabled={busy || binding.revoked}
                onClick={() =>
                  void action(async () => {
                    if (
                      !window.confirm(
                        "撤销此模拟绑定？新的消息、未开始的执行和待回传将被阻止，历史保留。"
                      )
                    )
                      return
                    const b = await api.revoke(bot.id, binding.id, binding.grantVersion)
                    if (current.current.id === b.id) {
                      setBinding(b)
                      await reload()
                    }
                  })
                }
              >
                撤销绑定
              </button>
            </div>
            {historyNotice && <p role="status">{historyNotice}</p>}
            <div className="bot-mock-history" aria-label="模拟渠道消息">
              {cursor && (
                <button disabled={busy} onClick={() => void more()}>
                  更早消息
                </button>
              )}
              {entries.map((v) => (
                <article key={v.id} data-mock-message={v.id} data-mock-kind={v.kind}>
                  <small>
                    {v.kind === "user" ? v.senderId : bot.name} · {LABELS[v.state] ?? "状态待核对"}
                  </small>
                  <p>{v.text}</p>
                  {v.workId && (
                    <button
                      onClick={() => {
                        onOpenWork(v.workId!)
                        onClose()
                      }}
                    >
                      打开独立任务
                    </button>
                  )}
                </article>
              ))}
              {!entries.length && (
                <p>尚无消息。普通问答保持在此渠道；明确交办后才会创建独立任务。</p>
              )}
            </div>
            <form
              className="bot-mock-compose"
              onSubmit={(e) => {
                e.preventDefault()
                void inject()
              }}
            >
              <div className="bot-mock-toolbar">
                <label>
                  模拟发送者
                  <select
                    aria-label="模拟发送者"
                    value={sender}
                    disabled={Boolean(pending)}
                    onChange={(e) => setSender(e.target.value)}
                  >
                    {binding.allowedSenderIds.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                {binding.kind === "group" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={mention}
                      disabled={Boolean(pending)}
                      onChange={(e) => setMention(e.target.checked)}
                    />
                    @ 此 Bot
                  </label>
                )}
                <select
                  aria-label="引用渠道消息"
                  value={reply}
                  disabled={Boolean(pending)}
                  onChange={(e) => setReply(e.target.value)}
                >
                  <option value="">不引用</option>
                  {entries
                    .filter((v) => v.kind === "bot" && v.state === "sent")
                    .map((v) => (
                      <option value={v.id} key={v.id}>
                        回复：{v.text.slice(0, 36)}
                      </option>
                    ))}
                </select>
              </div>
              {pending && (
                <p>
                  有一条发送尚未确认。将使用原事件 ID 核对，不会创建第二次执行。
                  {pending.bindingId !== id && (
                    <button type="button" onClick={() => setId(pending.bindingId)}>
                      返回原渠道核对
                    </button>
                  )}
                  {pending.bindingId === id && (binding.revoked || bot.archived) && (
                    <button type="button" disabled={busy} onClick={() => void endCheck()}>
                      保留记录并结束核对
                    </button>
                  )}
                </p>
              )}
              <textarea
                aria-label="模拟消息"
                placeholder="只输入文字；群消息需 @ 或引用该渠道 Bot 回复才触发"
                value={pending?.bindingId === id ? pending.text : text}
                disabled={Boolean(pending) || binding.revoked}
                maxLength={30000}
                onPaste={(event) => {
                  if (!event.clipboardData.files.length) return
                  event.preventDefault()
                  setError("模拟渠道仅支持文字，尚不支持图片或附件。")
                }}
                onDrop={(event) => {
                  if (!event.dataTransfer.files.length) return
                  event.preventDefault()
                  setError("模拟渠道仅支持文字，尚不支持图片或附件。")
                }}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                type="submit"
                disabled={
                  busy ||
                  ((!pending || pending.bindingId !== id) && (binding.revoked || bot.archived)) ||
                  bot.deleting ||
                  Boolean(pending && pending.bindingId !== id) ||
                  (!pending && !text.trim())
                }
              >
                {pending ? "核对原事件" : "发送模拟消息"}
              </button>
            </form>
          </>
        )}
        {retained.length > 0 && (
          <details>
            <summary>已结束核对的本机记录（{retained.length}）</summary>
            <p>仅保留原事件供查看，不代表已接纳或已送达，不会再次发送。</p>
            {retained.slice(retainedPage * 5, retainedPage * 5 + 5).map((v) => (
              <article key={v.eventId}>
                <small>
                  {v.bindingId} · {v.eventId} · {v.messageId}
                </small>
                <p>{v.text}</p>
              </article>
            ))}
            <button disabled={retainedPage === 0} onClick={() => setRetainedPage((v) => v - 1)}>
              上一页记录
            </button>
            <button
              disabled={(retainedPage + 1) * 5 >= retained.length}
              onClick={() => setRetainedPage((v) => v + 1)}
            >
              下一页记录
            </button>
          </details>
        )}
        {error && (
          <p role="alert">
            {error} <button onClick={() => void action(reload)}>刷新</button>
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
