import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  MessageCircle,
  RefreshCw,
  Users
} from "lucide-react"
import "./bot-im-channel-dialog.css"
import type { BotClient, BotDefinition } from "../../../../shared/bots/contracts"
import type { BotImBinding, BotImReplacement } from "../../../../shared/bots/im-channel"
import type { BotMockFeedEntry } from "../../../../shared/bots/mock-channel"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { botErrorMessage } from "@/lib/bot-error-message"

const bindingLabels = {
  pending: "等待绑定",
  active: "已绑定",
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
const button = "bot-im-connect-button"

export function BotImChannelDialog({
  client,
  bot,
  onClose,
  onOpenWork,
  onOpenMain,
  onOpenConversation,
  onOpenSettings,
  initialBindingId
}: {
  client: BotClient
  bot: BotDefinition
  onClose(): void
  onOpenWork(id: string): void
  onOpenMain?(): void
  onOpenConversation?(bindingId: string): void
  onOpenSettings?(): void
  initialBindingId?: string | null
}) {
  const api = client.im!
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [status, setStatus] = useState<{
    connected: boolean
    available: boolean
    scope?: string
  } | null>(null)
  const [targets, setTargets] = useState<BotImBinding[]>([])
  const [targetId, setTargetId] = useState("")
  const [targetLoading, setTargetLoading] = useState(false)
  const targetGeneration = useRef(0)
  const [targetError, setTargetError] = useState<string | null>(null)
  const [retryOperation, setRetryOperation] = useState<{
    operationId: string
    replace?: BotImReplacement
    label?: string
  } | null>(null)
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
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
  const removedBindings = useRef(new Set<string>())
  const loadedBindingPages = useRef(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const loading = useRef(false)
  const connectionScope = useRef<string | null>(null)
  const selection = useRef(selected)
  selection.current = selected
  const merge = (values: BotImBinding[]) =>
    setBindings((old) =>
      [...new Map([...old, ...values].map((value) => [value.id, value])).values()]
        .filter(
          (value) =>
            !["revoked", "expired"].includes(value.state) || !removedBindings.current.has(value.id)
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    )

  const refresh = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    setRefreshing(true)
    try {
      const next = await api.status()
      if (!live.current) return
      setStatus(next)
      if (!next.available) return
      const scope = next.scope ?? "default"
      if (connectionScope.current !== null && connectionScope.current !== scope) {
        setBindings([])
        setCursor(null)
        loadedBindingPages.current = false
        removedBindings.current.clear()
        historyWindow.current = null
        selection.current = null
        setSelected(null)
        setEntries([])
        setHistoryCursor(null)
      }
      connectionScope.current = scope
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
      if (live.current) setRefreshing(false)
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
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1800)
    return () => clearTimeout(timer)
  }, [copied])
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
  const createKey = `bot-im-create:${client.hostId}:${status?.scope ?? "default"}:${bot.id}:${kind}`
  const target = targets.find((binding) => binding.id === targetId)
  const loadTargets = useCallback(async () => {
    const generation = ++targetGeneration.current
    if (!status?.available || !api.replacementTargets) {
      setTargetLoading(false)
      return
    }
    setTargetLoading(true)
    setTargetError(null)
    try {
      const values = await api.replacementTargets(kind)
      if (!live.current || generation !== targetGeneration.current) return
      setTargets(values)
      setTargetId((id) =>
        values.some((binding) => binding.id === id)
          ? id
          : kind === "dm" && values.length === 1
            ? values[0].id
            : ""
      )
    } catch (cause) {
      if (live.current && generation === targetGeneration.current)
        setTargetError(botErrorMessage(cause))
    } finally {
      if (live.current && generation === targetGeneration.current) setTargetLoading(false)
    }
  }, [api, kind, status?.available, status?.scope])
  useEffect(() => {
    setTargets([])
    setTargetId("")
    setSwitchNotice(null)
    setRetryOperation(null)
    const saved = localStorage.getItem(createKey)
    if (saved) {
      try {
        setRetryOperation(JSON.parse(saved))
      } catch {
        localStorage.removeItem(createKey)
      }
    }
    void loadTargets()
  }, [createKey, loadTargets])
  const create = () =>
    action(async () => {
      let replacement = target
      if (!retryOperation && kind === "dm" && api.replacementTargets) {
        // Resolve the current private route at the click, not from a stale dialog
        // snapshot. The usual generate-and-send flow replaces it automatically.
        const current = await api.replacementTargets("dm")
        if (current.length > 1)
          throw new Error("当前有多个私聊接入，无法确定要替换哪一个。请先检查并撤销多余接入。")
        replacement = current[0]
      }
      const operation = retryOperation ?? {
        operationId: crypto.randomUUID(),
        ...(replacement
          ? {
              replace: {
                botId: replacement.botId,
                bindingId: replacement.id,
                version: replacement.version
              },
              label: replacement.label
            }
          : {})
      }
      // Keep the exact replacement across a lost response or dialog reopen.
      localStorage.setItem(createKey, JSON.stringify(operation))
      setRetryOperation(operation)
      const binding = await api.create(bot.id, kind, operation.operationId, operation.replace)
      localStorage.removeItem(createKey)
      if (live.current) {
        setRetryOperation(null)
        setTargets((items) => items.filter((item) => item.id !== operation.replace?.bindingId))
        setTargetId("")
        if (operation.replace)
          setSwitchNotice(
            kind === "dm"
              ? "原私聊绑定已解除。发送下方指令后连接此 Bot，历史消息与任务保留。"
              : "原接入已解除。发送下方指令后完成换绑，原会话记录会保留。"
          )
        merge([binding])
        setSelected(binding.id)
        void refresh()
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
      <DialogContent
        className="bot-im-connect"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
      >
        <header className="bot-im-connect-header">
          <DialogTitle ref={titleRef} tabIndex={-1}>
            IM 接入 · {bot.name}
          </DialogTitle>
          <DialogDescription>将此 Bot 连接到招乎私聊或群聊。</DialogDescription>
        </header>
        <div className="bot-im-connect-body">
          <div className="bot-im-connect-status" aria-live="polite">
            <span className="bot-im-connect-dot" data-online={Boolean(status?.available)} />
            <div className="bot-im-connect-status-copy">
              <strong>
                {status === null
                  ? "正在检查连接…"
                  : status.available
                    ? "招乎已连接"
                    : status.connected
                      ? "需要启用 Bot 接入"
                      : "尚未连接招乎"}
              </strong>
              {!status?.available && status !== null && (
                <p>
                  {status.connected
                    ? "当前网关尚未开启 Bot 接入，请升级并启用后重试。"
                    : "在设置的「机器人管理」中登录并连接 IM 网关。"}
                </p>
              )}
              {status !== null && !status.available && onOpenSettings && (
                <button
                  className="bot-im-connect-link"
                  onClick={() => {
                    onOpenSettings()
                    onClose()
                  }}
                >
                  去设置 <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            <button
              className="bot-im-connect-icon"
              aria-label="刷新"
              title="刷新连接状态"
              disabled={busy || refreshing}
              onClick={() => {
                void refresh()
                void loadTargets()
              }}
            >
              <RefreshCw
                size={15}
                className={refreshing ? "animate-spin" : undefined}
                aria-hidden="true"
              />
            </button>
          </div>

          <section className="bot-im-connect-setup" aria-label="新增 IM 接入">
            <h3>接入方式</h3>
            <div className="bot-im-connect-choices" role="radiogroup" aria-label="IM 绑定类型">
              {(["dm", "group"] as const).map((value) => (
                <label key={value} className="bot-im-connect-choice" data-selected={kind === value}>
                  <input
                    type="radio"
                    name="bot-im-kind"
                    value={value}
                    checked={kind === value}
                    disabled={busy}
                    onChange={() => setKind(value)}
                    aria-label={value === "dm" ? "本人私聊" : "群聊"}
                  />
                  <span className="bot-im-connect-choice-top">
                    {value === "dm" ? (
                      <MessageCircle size={20} aria-hidden="true" />
                    ) : (
                      <Users size={20} aria-hidden="true" />
                    )}
                    <span className="bot-im-connect-choice-check">
                      {kind === value && <Check size={11} strokeWidth={2.5} aria-hidden="true" />}
                    </span>
                  </span>
                  <strong>{value === "dm" ? "本人私聊" : "招乎群聊"}</strong>
                  <span>
                    {value === "dm"
                      ? "与 App 主对话共用消息和任务"
                      : "每个群独立交流，回复留在原群"}
                  </span>
                </label>
              ))}
            </div>
            {targets.length > 0 && !retryOperation && (
              <div className="bot-im-connect-replacement">
                {kind === "dm" ? (
                  <p className="bot-im-connect-hint">
                    生成新指令会自动解除原私聊绑定；发送后连接此 Bot，历史消息与任务保留。
                  </p>
                ) : (
                  <label>
                    <span>绑定目标</span>
                    <select
                      aria-label="换绑目标"
                      value={targetId}
                      disabled={busy || targetLoading}
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      <option value="">接入新的群聊</option>
                      {targets.map((binding) => (
                        <option key={binding.id} value={binding.id}>
                          {binding.peerLabel ?? (binding.kind === "dm" ? "本人私聊" : "群聊")} ·{" "}
                          {binding.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {kind === "group" && target && (
                  <p className="bot-im-connect-hint">
                    先解除所选接入，再发送新指令完成换绑。原消息与任务保留。
                  </p>
                )}
              </div>
            )}
            {retryOperation?.replace && (
              <p className="bot-im-connect-hint">上次操作尚未完成，重试会继续处理。</p>
            )}
            {targetError && (
              <p role="alert" className="bot-im-connect-error">
                {targetError}
              </p>
            )}
            {switchNotice && (
              <p role="status" className="bot-im-connect-hint">
                {switchNotice}
              </p>
            )}
            <div className="bot-im-connect-create">
              <p>
                {bot.archived
                  ? "恢复此 Bot 后，可新增接入。"
                  : kind === "dm"
                    ? "用本人账号，在招乎私聊机器人发送指令。"
                    : "用本人账号，在目标群 @机器人发送指令。"}
              </p>
              <button
                className={`${button} bot-im-connect-primary`}
                disabled={
                  busy ||
                  targetLoading ||
                  Boolean(targetError) ||
                  !status?.available ||
                  bot.archived
                }
                onClick={() => void create()}
              >
                {kind === "dm"
                  ? "生成绑定指令"
                  : retryOperation?.replace
                    ? "重试换绑"
                    : target
                      ? "换绑并生成指令"
                      : "生成绑定指令"}{" "}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
            {retryOperation && (
              <button
                className="bot-im-connect-link"
                disabled={busy}
                onClick={() => {
                  localStorage.removeItem(createKey)
                  setRetryOperation(null)
                  setError(null)
                  void loadTargets()
                }}
              >
                重新选择接入
              </button>
            )}
          </section>
          {error && (
            <p role="alert" className="bot-im-connect-error">
              {error}
            </p>
          )}

          {(bindings.length > 0 || cursor) && (
            <section className="bot-im-connect-bindings" aria-label="已有接入">
              <h3>
                已有接入 <span>{bindings.length}</span>
              </h3>
              {bindings.map((binding) => {
                const expanded = selected === binding.id
                return (
                  <div key={binding.id} className="bot-im-connect-binding" data-selected={expanded}>
                    <div className="bot-im-connect-binding-row">
                      <button
                        className="bot-im-connect-binding-select"
                        aria-expanded={expanded}
                        onClick={() => setSelected(expanded ? null : binding.id)}
                      >
                        <span className="bot-im-connect-binding-icon">
                          {binding.kind === "dm" ? (
                            <MessageCircle size={17} aria-hidden="true" />
                          ) : (
                            <Users size={17} aria-hidden="true" />
                          )}
                        </span>
                        <span className="bot-im-connect-binding-name">
                          <strong>
                            {binding.peerLabel ?? (binding.kind === "dm" ? "本人私聊" : "群聊")}
                          </strong>
                          <time dateTime={binding.createdAt}>
                            {new Date(binding.createdAt).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit"
                            })}
                          </time>
                        </span>
                        <span className="bot-im-connect-binding-state" data-state={binding.state}>
                          {bindingLabels[binding.state]}
                        </span>
                        <ChevronDown
                          size={14}
                          className="bot-im-connect-chevron"
                          aria-hidden="true"
                        />
                      </button>
                      {["revoked", "expired"].includes(binding.state) && (
                        <button
                          className="bot-im-connect-revoke"
                          disabled={busy || !status?.available}
                          title="从本机接入列表删除，保留会话和任务历史"
                          aria-label={`删除${binding.peerLabel ?? (binding.kind === "dm" ? "本人私聊" : "群聊")}接入记录`}
                          onClick={() =>
                            void action(async () => {
                              await api.remove(bot.id, binding.id)
                              removedBindings.current.add(binding.id)
                              if (live.current) {
                                setBindings((old) => old.filter((item) => item.id !== binding.id))
                                if (selection.current === binding.id) {
                                  selection.current = null
                                  setSelected(null)
                                }
                              }
                            })
                          }
                        >
                          删除
                        </button>
                      )}
                      {["pending", "active"].includes(binding.state) && (
                        <button
                          className="bot-im-connect-revoke"
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
                    {expanded && (
                      <div className="bot-im-connect-binding-detail">
                        {binding.instruction && (
                          <>
                            <p>
                              {binding.kind === "group"
                                ? "在目标招乎群 @机器人，粘贴并发送这条指令。"
                                : "在招乎私聊机器人，粘贴并发送这条指令。"}
                            </p>
                            <div className="bot-im-connect-code">
                              <code>{binding.instruction}</code>
                              <button
                                className="bot-im-connect-icon"
                                aria-label={copied === binding.id ? "已复制" : "复制绑定指令"}
                                title={copied === binding.id ? "已复制" : "复制绑定指令"}
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    await navigator.clipboard.writeText(binding.instruction!)
                                    if (live.current) setCopied(binding.id)
                                  })
                                }
                              >
                                {copied === binding.id ? (
                                  <Check size={16} aria-hidden="true" />
                                ) : (
                                  <Copy size={16} aria-hidden="true" />
                                )}
                              </button>
                            </div>
                            <div className="bot-im-connect-code-meta">
                              <span>
                                {new Date(binding.expiresAt).toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit"
                                })}{" "}
                                前有效
                              </span>
                              <span role="status">
                                {copied === binding.id ? "已复制" : "发送后将自动更新绑定状态"}
                              </span>
                            </div>
                          </>
                        )}
                        {binding.localError && (
                          <p role="alert" className="bot-im-connect-error">
                            {binding.localError} 可撤销此接入后重新绑定。
                          </p>
                        )}
                        {binding.kind === "dm" &&
                          binding.state === "active" &&
                          !binding.localError && (
                            <div className="bot-im-connect-binding-action">
                              <p>已关联个人主对话 · 回复同步到招乎</p>
                              {onOpenMain && (
                                <button
                                  className="bot-im-connect-link"
                                  onClick={() => {
                                    onOpenMain()
                                    onClose()
                                  }}
                                >
                                  打开主对话 <ArrowUpRight size={14} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          )}
                        {binding.kind === "group" &&
                          ["active", "revoked"].includes(binding.state) &&
                          onOpenConversation && (
                            <button
                              className="bot-im-connect-link"
                              onClick={() => {
                                onOpenConversation(binding.id)
                                onClose()
                              }}
                            >
                              打开群会话 <ArrowUpRight size={14} aria-hidden="true" />
                            </button>
                          )}
                        {binding.state === "expired" && <p>这条指令已过期，可以重新生成。</p>}
                        {binding.state === "revoked" && <p>已停止接收新消息，已有记录仍可查看。</p>}
                      </div>
                    )}
                  </div>
                )
              })}
              {cursor && (
                <button
                  className="bot-im-connect-link"
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
                  更多绑定 <ChevronDown size={14} aria-hidden="true" />
                </button>
              )}
            </section>
          )}

          {chosen && (
            <details key={chosen.id} className="bot-im-connect-history">
              <summary>
                接入记录 <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="bot-im-connect-history-content">
                <p className="bot-im-connect-hint">
                  “网关已接收”表示回复已交给网关，实际送达以招乎会话为准。
                </p>
                {historyNotice && (
                  <p role="status" className="bot-im-connect-hint">
                    {historyNotice}
                  </p>
                )}
                {historyCursor && (
                  <button
                    className="bot-im-connect-link"
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
                  <p className="bot-im-connect-hint">
                    暂无接入记录。绑定后在招乎发送消息，群聊请 @机器人。
                  </p>
                )}
                {[...entries]
                  .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
                  .map((entry) => (
                    <article key={entry.id} className="bot-im-connect-record">
                      <header>
                        <span>{entry.kind === "bot" ? bot.name : "IM 消息"}</span>
                        <span>{states[entry.state] ?? entry.state}</span>
                      </header>
                      <p>{entry.text}</p>
                      {entry.workId && (
                        <button
                          className="bot-im-connect-link"
                          onClick={() => {
                            onOpenWork(entry.workId!)
                            onClose()
                          }}
                        >
                          打开独立任务 <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      )}
                    </article>
                  ))}
              </div>
            </details>
          )}
          <details className="bot-im-connect-help">
            <summary>
              接入说明 <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div>
              <p>每个私聊或群聊可绑定一个 Bot，更换时先撤销原绑定。</p>
              <p>本人私聊与 App 主对话共用历史和任务，绑定后开始同步新消息。</p>
              <p>私聊和群聊可使用 Bot 的本机执行能力；群聊使用 Bot 共享与本群记忆。</p>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  )
}
