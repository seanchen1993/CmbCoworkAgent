import { botMemoryScopeLabel, type BotMemoryScope } from "../../../../shared/bots/memory-scope"
import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useId, useRef, useState } from "react"
import { Check, Loader2, Pencil, Plus, Share2, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import type {
  BotClient,
  BotDefinition,
  BotMemory,
  BotMemoryMode
} from "../../../../shared/bots/contracts"

const memoryDescriptions: Record<BotMemoryMode, string> = {
  inherit: "跟随设置中的记忆开关，仅用于此 Bot。",
  enabled: "在对话中读取和保存记忆，优先于全局设置。",
  disabled: "暂停读取和自动保存，已有记忆仍可管理。"
}

export function BotMemoryPanel({
  bot,
  client,
  peers,
  groupId
}: {
  bot: BotDefinition
  client: BotClient
  peers: BotDefinition[]
  groupId?: string
}) {
  const botId = bot.id
  const memoryMode = bot.memoryMode ?? "inherit"
  const memoryDescriptionId = useId()
  const [entries, setEntries] = useState<BotMemory[] | null>(null)
  const [editing, setEditing] = useState<BotMemory | "new" | null>(null)
  const [scopeKind, setScopeKind] = useState<BotMemoryScope["kind"]>(groupId ? "group" : "private")
  const [name, setName] = useState("")
  const [content, setContent] = useState("")
  const [deleting, setDeleting] = useState<string | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [recipient, setRecipient] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const lock = useRef(false)
  const mounted = useRef(true)
  const recipients = peers.filter((bot) => bot.id !== botId && !bot.archived)
  const recipientAvailable = recipients.some((bot) => bot.id === recipient)
  useEffect(() => {
    mounted.current = true
    let disposed = false
    let pending = false,
      dirty = false
    const refresh = async () => {
      dirty = true
      if (pending) return
      pending = true
      try {
        while (dirty && !disposed) {
          dirty = false
          const result = await client.listMemory(botId, groupId)
          if (!disposed) {
            setEntries(result)
            setReadError(null)
          }
        }
      } catch (cause) {
        if (!disposed) setReadError(botErrorMessage(cause))
      } finally {
        pending = false
      }
    }
    const onFocus = () => {
      void refresh()
    }
    refreshRef.current = onFocus
    const unsubscribe = client.subscribe((event) => {
      if (event.hostId === client.hostId && event.memoryBotId === botId) void refresh()
    })
    window.addEventListener("focus", onFocus)
    void refresh()
    return () => {
      disposed = true
      mounted.current = false
      refreshRef.current = () => {}
      unsubscribe()
      window.removeEventListener("focus", onFocus)
    }
  }, [botId, client, groupId])
  const edit = (entry: BotMemory | "new") => {
    setScopeKind(
      entry === "new" ? (groupId ? "group" : "private") : (entry.scope?.kind ?? "private")
    )
    setEditing(entry)
    setError(null)
    setDeleting(null)
    setSharing(null)
    setName(entry === "new" ? "" : entry.name)
    setContent(entry === "new" ? "" : entry.content)
  }
  const mutate = async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      const result = await client.listMemory(botId, groupId)
      if (mounted.current) {
        setEntries(result)
        setEditing(null)
        setDeleting(null)
        setSharing(null)
      }
    } catch (cause) {
      if (mounted.current) setError(botErrorMessage(cause, "保存失败"))
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const changeMemoryMode = async (memoryMode: BotMemoryMode) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await client.update({ ...bot, memoryMode, expectedVersion: bot.version })
    } catch (cause) {
      if (mounted.current) setError(botErrorMessage(cause, "设置保存失败"))
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="bot-detail-section">
      <div className="bot-memory-config">
        <div className="bot-memory-config-row">
          <span className="font-medium">记忆配置</span>
          <Select
            value={memoryMode}
            disabled={busy}
            onValueChange={(value) => void changeMemoryMode(value as BotMemoryMode)}
          >
            <SelectTrigger
              aria-label="记忆配置"
              aria-describedby={memoryDescriptionId}
              className="bot-memory-config-trigger h-8 w-auto gap-2 rounded-lg border-0 px-2 py-1 text-xs shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" showScrollButtons={false}>
              <SelectItem value="inherit">跟随全局</SelectItem>
              <SelectItem value="enabled">开启</SelectItem>
              <SelectItem value="disabled">关闭</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p id={memoryDescriptionId} className="bot-memory-config-description">
          {memoryDescriptions[memoryMode]}
        </p>
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="!mb-0">记忆</h3>
        <button
          className="bot-icon-button"
          aria-label="添加记忆"
          disabled={busy}
          onClick={() => edit("new")}
        >
          <Plus size={16} />
        </button>
      </div>
      {(error || readError) && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error || readError}
          {readError && (
            <button className="ml-2 underline" onClick={() => refreshRef.current()}>
              重新读取
            </button>
          )}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void mutate(() =>
              client.writeMemory(botId, {
                name,
                content,
                scope:
                  scopeKind === "group"
                    ? { kind: "group", groupId: groupId! }
                    : { kind: scopeKind },
                ...(editing === "new" ? {} : { id: editing.id, expectedVersion: editing.version })
              })
            )
          }}
        >
          <div className="bot-memory-scope-field">
            <span>使用范围</span>
            <Select
              value={scopeKind}
              onValueChange={(value) => setScopeKind(value as BotMemoryScope["kind"])}
              disabled={busy}
            >
              <SelectTrigger
                aria-label="记忆使用范围"
                className="h-8 w-auto gap-2 rounded-lg border-0 px-2 text-xs shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="shared">Bot 共享</SelectItem>
                {groupId ? (
                  <SelectItem value="group">群内</SelectItem>
                ) : (
                  <SelectItem value="private">仅私聊</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {scopeKind === "shared"
              ? "此 Bot 的私聊和各群均可使用。"
              : scopeKind === "group"
                ? "仅当前群及其任务使用。"
                : "仅私聊及其任务使用。"}
          </p>
          <label className="bot-field">
            名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="bot-field">
            内容
            <textarea
              required
              rows={6}
              maxLength={12_000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(null)
                setError(null)
              }}
            >
              取消
            </Button>
            <Button size="sm" disabled={busy || !name.trim() || !content.trim()}>
              保存
            </Button>
          </div>
        </form>
      ) : entries ? (
        entries.length ? (
          entries.map((entry) => (
            <article className="bot-task-item" key={entry.id}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="truncate font-medium">{entry.name}</h4>
                <div className="flex shrink-0">
                  {recipients.length > 0 && (
                    <button
                      className="bot-icon-button"
                      aria-label={`分享 ${entry.name}`}
                      disabled={busy}
                      onClick={() => {
                        setSharing(entry.id)
                        setRecipient("")
                        setDeleting(null)
                        setNotice(null)
                      }}
                    >
                      <Share2 size={13} />
                    </button>
                  )}
                  <button
                    className="bot-icon-button"
                    aria-label={`编辑 ${entry.name}`}
                    disabled={busy}
                    onClick={() => edit(entry)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="bot-icon-button"
                    aria-label={`删除 ${entry.name}`}
                    disabled={busy}
                    onClick={() => {
                      setDeleting(entry.id)
                      setSharing(null)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <span className="bot-memory-scope-label">{botMemoryScopeLabel(entry.scope)}</span>
              <p>{entry.content}</p>
              {sharing === entry.id && (
                <div className="mt-3 space-y-3">
                  <div className="bot-field">
                    <span>分享给</span>
                    <Select
                      value={recipientAvailable ? recipient : ""}
                      onValueChange={setRecipient}
                      disabled={busy || !recipients.length}
                    >
                      <SelectTrigger
                        aria-label="分享记忆给 Bot"
                        className="h-11 rounded-xl shadow-none"
                      >
                        <SelectValue placeholder="选择 Bot" />
                      </SelectTrigger>
                      <SelectContent
                        data-bot-popup
                        className="bot-memory-recipient-menu max-h-[min(20rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] rounded-xl"
                        collisionPadding={8}
                      >
                        {recipients.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id} className="rounded-lg">
                            {bot.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    仅复制这条记忆，后续修改互不影响。
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setSharing(null)}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !recipientAvailable}
                      onClick={() =>
                        void mutate(async () => {
                          await client.shareMemory(botId, entry.id, entry.version, recipient)
                          if (mounted.current) setNotice("已将这条记忆分享给所选 Bot。")
                        })
                      }
                    >
                      分享
                    </Button>
                  </div>
                </div>
              )}
              {deleting === entry.id && (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className="flex-1">删除这条记忆？</span>
                  <button
                    className="bot-icon-button"
                    disabled={busy}
                    aria-label="确认删除记忆"
                    onClick={() =>
                      void mutate(() => client.removeMemory(botId, entry.id, entry.version))
                    }
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="bot-icon-button"
                    disabled={busy}
                    aria-label="取消删除"
                    onClick={() => setDeleting(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            </article>
          ))
        ) : (
          <div className="bot-memory-empty">
            <p>暂无记忆</p>
            <p className="mt-1 text-xs">保存的偏好和经验会显示在这里，可随时编辑。</p>
          </div>
        )
      ) : (
        !error && !readError && <Loader2 className="size-4 animate-spin" />
      )}
    </section>
  )
}
