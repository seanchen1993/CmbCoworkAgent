import { useLayoutEffect, useRef, useState } from "react"
import { ChevronRight, Loader2, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { inspectPendingGroup } from "@/lib/bot-group-pending"
import { useBotGroupSave, type GroupSaveFields } from "@/lib/use-bot-group-save"
import { BotGroupSaveStatus } from "./BotGroupSaveStatus"
import type { BotConversation, CoworkBot } from "../../../../shared/bot-types"
import { BotAvatar } from "./BotAvatar"
import { BotDialogContent } from "./BotDialog"

/** Grok's member rows and searchable picker, over Cmb's versioned group save.
 * The existing editor and this pane share one durable acknowledgement identity. */
export function BotGroupMembers({
  group,
  bots,
  openBot
}: {
  group: BotConversation
  bots: CoworkBot[]
  openBot(id: string): void
}) {
  const epoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("group-member-controls") ?? false
  )
  const session = useBotGroupSave(group.id, async () => {
    await useBotWorkspaceStore.getState().refresh()
  })
  const editingEpoch = session.epoch
  const [failure, setFailure] = useState<string | null>(null)
  const busy = session.busy
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [removing, setRemoving] = useState<{
    id: string
    name: string
    revision: number
  } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const removalTrigger = useRef<HTMLButtonElement | null>(null)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const currentEpoch = () => useBotWorkspaceStore.getState().snapshot?.dataEpoch === editingEpoch
  const live = () => mounted.current && currentEpoch()
  const restored = editingEpoch !== epoch
  const disabled = session.fieldsDisabled || !supported
  const candidates = bots.filter((bot) => !group.members.includes(bot.id))
  const matches = candidates.filter((bot) =>
    `${bot.name}\n${bot.instructions}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )

  const submit = async (fields: GroupSaveFields) => {
    const confirmed = await session.save(fields)
    if (confirmed && live()) {
      setOpen(false)
      setRemoving(null)
    }
  }

  const change = async (members: string[], revision: number) => {
    if (disabled || session.isSaving() || !live()) return
    // Another editor may have submitted while this pane remained mounted.
    const unresolved = inspectPendingGroup(group.id, editingEpoch)
    if (unresolved.kind !== "empty") {
      session.refreshRecord()
      setOpen(false)
      setRemoving(null)
      return
    }
    const latest = useBotWorkspaceStore
      .getState()
      .snapshot?.conversations.find((item) => item.id === group.id)
    if (!latest || latest.revision !== revision) {
      setFailure("群聊已更新，请重新选择要调整的成员。")
      setRemoving(null)
      return
    }
    await submit({
      id: group.id,
      revision,
      name: latest.name,
      description: latest.description ?? "",
      members
    })
  }

  return (
    <div
      ref={panel}
      role="group"
      tabIndex={-1}
      className="space-y-3 px-5 py-4 outline-none"
      aria-label="群聊成员操作"
      aria-busy={busy}
    >
      {restored ? (
        <p role="alert" className="text-xs text-destructive">
          工作区数据已恢复，请重新打开群聊详情。
        </p>
      ) : !supported ? (
        <p role="status" className="text-xs text-muted-foreground">
          请先在设置中重启后台，再调整成员。
        </p>
      ) : null}
      {failure && (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          {failure}
        </p>
      )}
      {!removing && <BotGroupSaveStatus session={session} retry />}
      <ul className="space-y-1" aria-label="群聊成员">
        {group.members.map((id) => {
          const bot = bots.find((item) => item.id === id)
          return (
            <li
              key={id}
              className="group/member flex items-center gap-1 rounded-xl pr-2 hover:bg-muted/60 focus-within:bg-muted/60"
            >
              <button
                type="button"
                disabled={!bot}
                aria-label={bot ? `打开 ${bot.name} 的聊天` : "此 Bot 已不可用"}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onClick={() => openBot(id)}
              >
                <BotAvatar agentId={id} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {bot?.name || "已不可用的 Bot"}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {bot?.instructions || "尚未指定职责"}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
              </button>
              {group.members.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity group-hover/member:opacity-100 group-focus-within/member:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={`移除 ${bot?.name || "不可用的 Bot"}`}
                  title="移出群聊"
                  disabled={disabled}
                  onClick={(event) => {
                    removalTrigger.current = event.currentTarget
                    setRemoving({
                      id,
                      name: bot?.name || "不可用的 Bot",
                      revision: group.revision
                    })
                  }}
                >
                  <X size={14} />
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {group.members.length < 6 && (
        <Popover
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (!value) setQuery("")
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={addTrigger}
              type="button"
              disabled={disabled || !candidates.length}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground">
                {busy ? (
                  <Loader2 size={17} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Plus size={17} />
                )}
              </span>
              添加成员
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="bot-member-picker w-72 max-w-[calc(100vw-2rem)] rounded-2xl p-1.5"
            aria-label="添加群聊成员"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (addTrigger.current && !addTrigger.current.disabled) addTrigger.current.focus()
              else panel.current?.focus()
            }}
          >
            <div className="relative m-1 mb-2">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="搜索可添加的 Bot"
                placeholder="搜索 Bot…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 rounded-xl border-0 bg-muted/50 pl-9 text-sm"
              />
            </div>
            <div className="max-h-64 overflow-y-auto overscroll-contain">
              {matches.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  disabled={disabled}
                  aria-label={`添加 ${bot.name}`}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50"
                  onClick={() => void change([...group.members, bot.id], group.revision)}
                >
                  <BotAvatar agentId={bot.id} size="sm" isStatic />
                  <span className="truncate">{bot.name}</span>
                </button>
              ))}
              {!matches.length && (
                <p role="status" className="px-3 py-5 text-center text-xs text-muted-foreground">
                  没有匹配的 Bot
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
      <p className="px-3 text-xs leading-relaxed text-muted-foreground">
        {group.members.length >= 6
          ? "最多可添加 6 个 Bot。"
          : !candidates.length
            ? "创建更多 Bot 后，可在这里添加。"
            : "调整成员会结束群内进行中的讨论。"}
      </p>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!value && !session.isSaving()) setRemoving(null)
        }}
      >
        <BotDialogContent
          className="max-w-sm"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const trigger = removalTrigger.current
            if (trigger?.isConnected && !trigger.disabled) trigger.focus()
            else panel.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>将「{removing?.name}」移出群聊？</DialogTitle>
            <DialogDescription>
              群内进行中的讨论将结束，历史消息会保留。之后可重新添加此 Bot。
            </DialogDescription>
          </DialogHeader>
          <BotGroupSaveStatus session={session} retry />
          {removing && removing.revision !== group.revision && (
            <p role="status" className="text-xs text-muted-foreground">
              群聊已更新，请关闭后重新选择。
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={disabled || !removing || removing.revision !== group.revision}
              onClick={() => {
                if (removing)
                  void change(
                    group.members.filter((id) => id !== removing.id),
                    removing.revision
                  )
              }}
            >
              {busy ? "正在移除…" : "移出群聊"}
            </Button>
          </div>
        </BotDialogContent>
      </Dialog>
    </div>
  )
}
