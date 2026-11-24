import { botMemoryScopeLabel, type BotMemoryScope } from "../../../../shared/bots/memory-scope"
import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useId, useRef, useState } from "react"
import { ArrowLeft, Check, Loader2, MoreHorizontal, Pencil, Plus, Share2, Trash2, X } from "lucide-react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { BotDetailCard } from "./BotDetailsPane"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
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

export function BotMemoryNavigation({ onBack, disabled }: { onBack(): void; disabled?: boolean }) {
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus() }, [])
  return (
    <div className="bot-memory-navigation">
      <button ref={back} type="button" disabled={disabled} onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> 返回详情
      </button>
      <span>记忆管理</span>
    </div>
  )
}

export function BotMemoryPanel({
  bot,
  client,
  peers,
  groupId,
  groupLabels,
  onBack
}: {
  bot: BotDefinition
  client: BotClient
  peers: BotDefinition[]
  groupId?: string
  groupLabels?: ReadonlyMap<string, string>
  onBack?(): void
}) {
  const botId = bot.id
  const memoryEnabled = bot.memoryMode !== "disabled"
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
  const groupLabel = (id: string) => groupLabels?.get(id) ?? "原群聊（记录不可用）"
  const scopeLabel = (scope?: BotMemoryScope) =>
    scope?.kind === "group" ? `群内 · ${groupLabel(scope.groupId)}` : botMemoryScopeLabel(scope)
  const editingGroupId =
    groupId ??
    (editing && editing !== "new" && editing.scope?.kind === "group"
      ? editing.scope.groupId
      : undefined)
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
  const configuration = (
    <BotDetailCard title="Bot 长期记忆" actions={
      <Switch
        aria-label="Bot 长期记忆"
        aria-describedby={memoryDescriptionId}
        checked={memoryEnabled}
        disabled={busy}
        onCheckedChange={(checked) => void changeMemoryMode(checked ? "enabled" : "disabled")}
      />
    }>
      <p id={memoryDescriptionId} className="bot-detail-empty">
        {memoryEnabled
          ? "在对话中读取和保存长期记忆。"
          : "已暂停读取和保存，已有记忆仍可管理。"}
        {groupId && `此开关适用于「${bot.name}」的私聊和所有群聊。`}
      </p>
    </BotDetailCard>
  )
  const memories = (
    <BotDetailCard title={groupId ? "群聊可用记忆" : "全部记忆"} actions={
      <button
        className="bot-icon-button"
        aria-label="添加记忆"
        disabled={busy}
        onClick={() => edit("new")}
      >
        <Plus size={16} />
      </button>
    }>
      {!groupId && !editing && (
        <p role="note" aria-label="记忆使用范围说明" className="mb-3 text-xs leading-relaxed text-muted-foreground">
          <span className="whitespace-nowrap">「仅私聊」</span>限私聊，
          <span className="whitespace-nowrap">「Bot 共享」</span>适用于此 Bot 的所有对话，
          <span className="whitespace-nowrap">「群内」</span>限所属群。
        </p>
      )}
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
            const previous = editing === "new" ? undefined : (editing.scope ?? { kind: "private" })
            const scope: BotMemoryScope =
              scopeKind === "group"
                ? {
                    kind: "group",
                    groupId: groupId ?? (previous?.kind === "group" ? previous.groupId : "")
                  }
                : { kind: scopeKind }
            const unchanged =
              previous?.kind === scope.kind &&
              (scope.kind !== "group" ||
                (previous.kind === "group" && previous.groupId === scope.groupId))
            void mutate(() =>
              client.writeMemory(botId, {
                name,
                content,
                // Omit unchanged scope: the service preserves it under the version
                // check, including memories whose original group no longer exists.
                ...(unchanged ? {} : { scope }),
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
                {(groupId || (editing !== "new" && editing.scope?.kind === "group")) && (
                  <SelectItem value="group">{groupId ? "群内" : "原群内"}</SelectItem>
                )}
                {!groupId && <SelectItem value="private">仅私聊</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {scopeKind === "shared"
              ? "此 Bot 的私聊和各群均可使用。"
              : scopeKind === "group"
                ? `所属群：${editingGroupId ? groupLabel(editingGroupId) : "原群聊"}。仅用于该群及其任务。`
                : "仅私聊及其任务使用。"}
          </p>
          <label className="bot-field">
            名称
            <input
              autoFocus
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
              <div className="bot-memory-entry-heading">
                <button type="button" className="bot-memory-edit" disabled={busy} title={entry.name}
                  aria-label={`编辑 ${entry.name}`} onClick={() => edit(entry)}>{entry.name}</button>
                <Menu.Root>
                  <Menu.Trigger asChild>
                    <button type="button" className="bot-icon-button" disabled={busy}
                      aria-label={`${entry.name}的更多操作`}><MoreHorizontal size={16} /></button>
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content align="end" sideOffset={4} collisionPadding={8}
                      data-bot-popup className="bot-workspace-menu bot-memory-menu">
                      <Menu.Item onSelect={() => edit(entry)}>
                        <Pencil size={14} /> 编辑记忆
                      </Menu.Item>
                      {recipients.length > 0 && (
                        <Menu.Item onSelect={() => {
                          setSharing(entry.id)
                          setRecipient("")
                          setDeleting(null)
                          setNotice(null)
                        }}><Share2 size={14} /> 分享给 Bot</Menu.Item>
                      )}
                      <Menu.Item className="text-destructive" onSelect={() => {
                        setDeleting(entry.id)
                        setSharing(null)
                      }}><Trash2 size={14} /> 删除记忆</Menu.Item>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu.Root>
              </div>
              <span className="bot-memory-scope-label" title={scopeLabel(entry.scope)}>
                {scopeLabel(entry.scope)}
              </span>
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
          <p className="bot-detail-empty">暂无记忆</p>
        )
      ) : (
        !error && !readError && <Loader2 className="size-4 animate-spin" />
      )}
    </BotDetailCard>
  )
  return (
    <>
      {onBack && <BotMemoryNavigation onBack={onBack} disabled={busy} />}
      <div className="bot-detail-cards bot-memory-panel">
        {configuration}
        {memories}
      </div>
    </>
  )
}
