import { useCallback, useEffect, useRef, useState } from "react"
import type { BotClient, BotDefinition } from "../../../../shared/bots/contracts"
import type { BotImBinding } from "../../../../shared/bots/im-channel"
import type { BotMockFeedEntry } from "../../../../shared/bots/mock-channel"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { botErrorMessage } from "@/lib/bot-error-message"

const bindingLabels = {
  pending: "等待绑定",
  active: "已连接",
  revoked: "已撤销",
  expired: "指令已过期"
}
const states: Record<string, string> = {
  queued: "等待执行",
  running: "正在处理",
  waiting_user: "等待处理",
  completed: "已回复",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "执行已中断，请核对",
  pending: "等待网关接收",
  sending: "正在回传",
  accepted: "网关已接收",
  blocked: "回传已阻止",
  unknown: "结果待核对",
  outcome_unknown: "结果待核对"
}
const button = "rounded-xl border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"

export function BotImChannelDialog({
  client,
  bot,
  onClose,
  onOpenWork,
  onOpenMain,
  onOpenConversation,
  initialBindingId
}: {
  client: BotClient
  bot: BotDefinition
  onClose(): void
  onOpenWork(id: string): void
  onOpenMain?(): void
  onOpenConversation?(bindingId: string): void
  initialBindingId?: string | null
}) {
  const api = client.im!
  const [status, setStatus] = useState<{ connected: boolean; available: boolean } | null>(null)
  const [bindings, setBindings] = useState<BotImBinding[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [kind, setKind] = useState<"dm" | "group">("dm")
  const [selected, setSelected] = useState<string | null>(initialBindingId ?? null)
  const [entries, setEntries] = useState<BotMockFeedEntry[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyNotice, setHistoryNotice] = useState<string | null>(null)
  const historyWindow = useRef<{
    id: string
    items: BotMockFeedEntry[]
    before: string | null
  } | null>(null)
  const loadedBindingPages = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const loading = useRef(false)
  const selection = useRef(selected)
  selection.current = selected
  const merge = (values: BotImBinding[]) =>
    setBindings((old) =>
      [...new Map([...old, ...values].map((value) => [value.id, value])).values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      )
    )

  const refresh = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    try {
      const next = await api.status()
      if (!live.current) return
      setStatus(next)
      if (!next.available) return
      const page = await api.list(bot.id)
      if (!live.current) return
      merge(page.items)
      if (!loadedBindingPages.current) setCursor(page.before)
      const id = selection.current
      if (id) {
        const history = await api.history(bot.id, id)
        if (!live.current || selection.current !== id) return
        const old = historyWindow.current
        const gap =
          old?.id === id &&
          old.items.length > 0 &&
          history.items.length > 0 &&
          !history.items.some((entry) => old.items.some((previous) => previous.id === entry.id))
        const append = old?.id === id && old.items.length > 0 && !gap
        const next = {
          id,
          items: append
            ? [
                ...new Map(
                  [...old.items, ...history.items].map((entry) => [entry.id, entry])
                ).values()
              ]
            : history.items,
          before: append ? old.before : history.before
        }
        historyWindow.current = next
        setEntries(next.items)
        setHistoryCursor(next.before)
        if (gap) setHistoryNotice("新消息较多，已展示最近记录；可以继续查看更早记录。")
      }
      setError(null)
    } catch (e) {
      if (live.current) setError(botErrorMessage(e))
    } finally {
      loading.current = false
    }
  }, [api, bot.id])
  useEffect(() => {
    live.current = true
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 5000)
    return () => {
      live.current = false
      clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    historyWindow.current = null
    setEntries([])
    setHistoryCursor(null)
    setHistoryNotice(null)
    void refresh()
  }, [selected, refresh])
  const action = async (run: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (e) {
      if (live.current) setError(botErrorMessage(e))
    } finally {
      if (live.current) setBusy(false)
    }
  }
  const create = () =>
    action(async () => {
      // Retain the operation ID on an unknown transport outcome, including closing this dialog.
      const key = `bot-im-create:${client.hostId}:${bot.id}:${kind}`
      const operationId = localStorage.getItem(key) ?? crypto.randomUUID()
      localStorage.setItem(key, operationId)
      const binding = await api.create(bot.id, kind, operationId)
      localStorage.removeItem(key)
      if (live.current) {
        merge([binding])
        setSelected(binding.id)
      }
    })
  const chosen = bindings.find((binding) => binding.id === selected)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>IM 接入 · {bot.name}</DialogTitle>
          <DialogDescription>
            本人招乎私聊与 App 主对话共用历史和独立任务，App 的回复和任务结果也会同步到私聊。
            群聊各自保留独立会话，回复回到原群。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground">
            {status === null
              ? "正在检查连接…"
              : status.available
                ? "IM 网关已连接"
                : status.connected
                  ? "当前网关尚未开启 Bot 接入，请升级并启用后重试。"
                  : "请先在设置 → 内置机器人中登录并连接 IM 网关。"}
          </p>
          <button className={button} disabled={busy} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          接入后，本人或绑定群的成员可以与此 Bot
          交流、创建和继续文字任务。不会开放本机文件、电脑操作或私人记忆。
        </p>
        {kind === "dm" && (
          <p className="text-sm text-muted-foreground">
            请使用本人账号绑定。关联后开始同步新消息；之前的渠道记录仍可在下方查看，不会重复推送。
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="IM 绑定类型"
            className={button}
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value as "dm" | "group")}
          >
            <option value="dm">本人私聊</option>
            <option value="group">群聊</option>
          </select>
          <button
            className={button}
            disabled={busy || !status?.available || bot.archived}
            onClick={() => void create()}
          >
            生成绑定指令
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {bindings.length === 0 && status?.available && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            尚未接入 IM。生成指令后，发给 CMBDevCaw Bot 即可完成绑定。
          </p>
        )}
        <div className="space-y-2">
          {bindings.map((binding) => (
            <div
              key={binding.id}
              className={`rounded-xl border p-3 ${selected === binding.id ? "bg-muted" : ""}`}
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelected(binding.id)}
                >
                  <span className="text-sm font-medium">
                    {binding.peerLabel ?? (binding.kind === "dm" ? "本人私聊" : "群聊")} ·{" "}
                    {bindingLabels[binding.state]}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {new Date(binding.createdAt).toLocaleString()} · {binding.id.slice(0, 8)}
                  </span>
                </button>
                {["pending", "active"].includes(binding.state) && (
                  <button
                    className={button}
                    disabled={busy || !status?.available}
                    onClick={() =>
                      void action(async () => {
                        const value = await api.revoke(bot.id, binding.id, binding.version)
                        if (live.current) merge([value])
                      })
                    }
                  >
                    撤销
                  </button>
                )}
              </div>
              {binding.kind === "dm" && binding.state === "active" && (
                <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">已关联个人主对话 · 回复同步到招乎</span>
                  {onOpenMain && (
                    <button
                      className={button}
                      onClick={() => {
                        onOpenMain()
                        onClose()
                      }}
                    >
                      打开主对话
                    </button>
                  )}
                </div>
              )}
              {binding.instruction && (
                <div className="mt-3 space-y-2 text-sm">
                  <p>
                    {binding.kind === "group"
                      ? "用当前登录账号在目标群 @CMBDevCaw Bot，发送以下指令。"
                      : "用当前登录账号私聊 CMBDevCaw Bot，发送以下指令。"}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-muted p-2">
                      {binding.instruction}
                    </code>
                    <button
                      className={button}
                      onClick={() =>
                        void action(() => navigator.clipboard.writeText(binding.instruction!))
                      }
                    >
                      复制
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(binding.expiresAt).toLocaleTimeString()}{" "}
                    前有效。每个私聊或群聊只能绑定一个 Bot；变更时先撤销原绑定。
                    {binding.kind === "dm" &&
                      "绑定后，CMBDevCaw Bot 的私聊文字将交给此 Bot；原 CMBDevClaw 的项目和对话入口保持独立。"}
                  </p>
                </div>
              )}
            </div>
          ))}
          {cursor && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const page = await api.list(bot.id, cursor)
                  if (live.current) {
                    loadedBindingPages.current = true
                    merge(page.items)
                    setCursor(page.before)
                  }
                })
              }
            >
              更多绑定
            </button>
          )}
        </div>
        {chosen && (
          <section className="space-y-3 border-t pt-4">
            {chosen.kind === "group" &&
              ["active", "revoked"].includes(chosen.state) &&
              onOpenConversation && (
                <button
                  className={button}
                  onClick={() => {
                    onOpenConversation(chosen.id)
                    onClose()
                  }}
                >
                  打开群会话 →
                </button>
              )}
            <h3 className="text-sm font-medium">
              {chosen.kind === "group" ? "群聊" : "私聊"}接入记录
            </h3>
            <p className="text-xs text-muted-foreground">
              “网关已接收”表示回复已交给网关，实际送达以招乎会话为准。
            </p>
            {historyNotice && (
              <p role="status" className="text-xs text-muted-foreground">
                {historyNotice}
              </p>
            )}
            {historyCursor && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const id = chosen.id,
                      page = await api.history(bot.id, id, historyCursor)
                    const window = historyWindow.current
                    if (
                      live.current &&
                      selection.current === id &&
                      window?.id === id &&
                      window.before === historyCursor
                    ) {
                      window.items = [
                        ...new Map(
                          [...window.items, ...page.items].map((entry) => [entry.id, entry])
                        ).values()
                      ]
                      window.before = page.before
                      setEntries(window.items)
                      setHistoryCursor(window.before)
                    }
                  })
                }
              >
                更早记录
              </button>
            )}
            {entries.length === 0 && (
              <p className="py-3 text-sm text-muted-foreground">
                暂时没有本机接收记录。绑定完成后，请在招乎发送消息；群聊需要 @机器人。
              </p>
            )}
            {[...entries]
              .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
              .map((entry) => (
                <div key={entry.id} className="rounded-xl bg-muted/60 p-3 text-sm">
                  <div className="mb-2 flex justify-between text-xs text-muted-foreground">
                    <span>{entry.kind === "bot" ? bot.name : "IM 消息"}</span>
                    <span>{states[entry.state] ?? entry.state}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{entry.text}</p>
                  {entry.workId && (
                    <button
                      className="mt-2 text-sm underline"
                      onClick={() => {
                        onOpenWork(entry.workId!)
                        onClose()
                      }}
                    >
                      打开独立任务 →
                    </button>
                  )}
                </div>
              ))}
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}
