import { useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronRight,
  Eye,
  EyeOff,
  MailOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Trash2,
  UsersRound
} from "lucide-react"
import type { BotDefinition, BotTask } from "../../../../shared/bots/contracts"
import type { BotImConversation } from "../../../../shared/bots/im-channel"
import { botSidebarTime, orderImConversations } from "@/lib/bot-sidebar-view"
import { botConversationState } from "@/lib/bot-task-view"
import type { ThreadStateSummary } from "@/lib/thread-context"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useHeldSidebarUnread, useStableSidebarOrder } from "./use-bot-sidebar-order"

export function BotImConversationRows({
  conversations,
  bots,
  tasks = [],
  backgroundThreads = [],
  threadSummaries = {},
  selectedId,
  pinnedIds = [],
  hiddenIds = [],
  historyCollapsed = true,
  query = "",
  showHidden = false,
  sortingPaused = false,
  hostId,
  onSelect,
  onPin,
  onRead,
  onVisibility,
  onDelete,
  onHistoryCollapsed,
  onMenuOpenChange
}: {
  conversations: BotImConversation[]
  bots: BotDefinition[]
  tasks?: BotTask[]
  backgroundThreads?: string[]
  threadSummaries?: Readonly<Record<string, ThreadStateSummary>>
  selectedId?: string | null
  pinnedIds?: string[]
  hiddenIds?: string[]
  historyCollapsed?: boolean
  query?: string
  showHidden?: boolean
  sortingPaused?: boolean
  hostId: string
  onSelect(id: string): void
  onPin(id: string): void
  onRead(group: BotImConversation): void
  onVisibility(id: string): void
  onDelete(group: BotImConversation): void
  onHistoryCollapsed(collapsed: boolean): void
  onMenuOpenChange(open: boolean): void
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const pendingDelete = useRef<BotImConversation | null>(null)
  const finishMenuClose = (event: Event, group: BotImConversation) => {
    if (pendingDelete.current?.id !== group.id) return
    // Let the menu release its native focus/pointer lock before mounting a modal.
    event.preventDefault()
    pendingDelete.current = null
    onDelete(group)
  }
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots])
  const tasksByGroup = useMemo(() => {
    const result = new Map<string, BotTask[]>()
    for (const task of tasks) {
      if (task.mockSource?.transport !== "im") continue
      const key = `${task.botId}:${task.mockSource.bindingId}`
      const group = result.get(key) ?? []
      group.push(task)
      result.set(key, group)
    }
    return result
  }, [tasks])
  const selected = conversations.find((item) => item.id === selectedId)
  const held = useHeldSidebarUnread(
    selectedId ? `${hostId}:im:${selectedId}` : null,
    Boolean(selected?.activity.unread)
  )
  const ordered = orderImConversations(conversations, pinnedIds, held?.slice(hostId.length + 1))
  const scope = `${hostId}:${query}:${showHidden}`
  const active = useStableSidebarOrder(ordered.active, (item) => item.id, sortingPaused, scope)
  const history = useStableSidebarOrder(ordered.history, (item) => item.id, sortingPaused, scope)
  const expanded = !historyCollapsed || Boolean(query.trim()) || showHidden
  const unread = active.filter((item) => item.activity.unread).length
  useEffect(() => {
    if (selected?.state === "revoked") onHistoryCollapsed(false)
    // Reveal the selected room on revocation/navigation, while still allowing an explicit collapse.
  }, [hostId, selectedId, selected?.state, onHistoryCollapsed])
  if (!conversations.length) return null

  const renderRow = (group: BotImConversation) => {
    const bot = botById.get(group.botId),
      pinned = group.state === "active" && pinnedIds.includes(group.id)
    const state = botConversationState(
      tasksByGroup.get(`${group.botId}:${group.id}`) ?? [],
      group.threadId ? threadSummaries[group.threadId] : undefined,
      Boolean(group.threadId && backgroundThreads.includes(group.threadId))
    )
    const status =
      group.state === "revoked"
        ? "已解绑"
        : bot?.deleting
          ? "Bot 删除中"
          : bot?.archived
            ? "Bot 已归档"
            : state === "waiting_user"
              ? "待你处理"
              : state === "running"
                ? "处理中"
                : state === "queued"
                  ? "等待处理"
                  : !group.connected
                    ? "离线"
                    : ""
    const actions: Array<{ label: string; Icon: typeof Pin; run(): void; destructive?: boolean }> =
      [
        ...(group.state === "active"
          ? [
              {
                label: pinned ? "取消置顶" : "置顶",
                Icon: pinned ? PinOff : Pin,
                run: () => onPin(group.id)
              }
            ]
          : []),
        ...(group.activity.unread
          ? [{ label: "标为已读", Icon: MailOpen, run: () => onRead(group) }]
          : []),
        ...(group.state === "revoked" || hiddenIds.includes(group.id)
          ? [
              {
                label: hiddenIds.includes(group.id) ? "显示在侧边栏" : "从侧边栏隐藏",
                Icon: hiddenIds.includes(group.id) ? Eye : EyeOff,
                run: () => onVisibility(group.id)
              }
            ]
          : []),
        ...(group.state === "revoked"
          ? [
              {
                label: "删除会话",
                Icon: Trash2,
                destructive: true,
                run: () => {
                  pendingDelete.current = group
                }
              }
            ]
          : [])
      ]
    return (
      <ContextMenu key={group.id} onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div className="bot-im-sidebar-row" data-revoked={group.state === "revoked"}>
            <button
              className="bot-list-item"
              data-selected={selectedId === group.id}
              aria-label={`招乎群聊：${group.title}`}
              data-bot-row-key={`im:${group.id}`}
              data-bot-unread-count={group.activity.unread ? 1 : 0}
              onClick={() => onSelect(group.id)}
              title={`${group.title} · ${bot?.name ?? "Bot 不可用"}${status ? ` · ${status}` : ""}`}
            >
              <span className="bot-im-avatar" data-small="true">
                <UsersRound size={19} strokeWidth={1.6} />
              </span>
              <span className="bot-im-row-copy">
                <span className="bot-list-heading">
                  <span className="bot-im-row-title">{group.title}</span>
                  <SidebarTime value={group.activity.updatedAt} />
                </span>
                <span className="bot-list-preview">{group.activity.preview || "尚无群消息"}</span>
                <span className="bot-im-row-caption">
                  {pinned && <Pin size={10} aria-label="已置顶" />}
                  {bot?.name ?? "Bot 不可用"}
                  {status ? ` · ${status}` : ""}
                </span>
              </span>
              {group.activity.unread && (
                <span className="bot-unread-dot" aria-label="群聊有未读消息" />
              )}
            </button>
            <Popover
              open={openMenu === group.id}
              onOpenChange={(open) => {
                setOpenMenu(open ? group.id : null)
                onMenuOpenChange(open)
              }}
            >
              <PopoverTrigger asChild>
                <button
                  className="bot-im-row-more"
                  aria-label={`${group.title} 的操作`}
                  title="更多操作"
                >
                  <MoreHorizontal size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                data-bot-popup
                className="bot-workspace-menu w-40 rounded-xl p-1.5"
                role="menu"
                onCloseAutoFocus={(event) => finishMenuClose(event, group)}
                onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
                  event.preventDefault()
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")
                  )
                  const index = items.indexOf(document.activeElement as HTMLButtonElement)
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                          items.length
                  items[next]?.focus()
                }}
                align="end"
              >
                {actions.map(({ label, Icon, run, destructive }) => (
                  <button
                    key={label}
                    role="menuitem"
                    className="bot-im-menu-action"
                    data-destructive={destructive || undefined}
                    onClick={() => {
                      setOpenMenu(null)
                      onMenuOpenChange(false)
                      run()
                    }}
                  >
                    <Icon />
                    {label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          data-bot-popup
          className="bot-workspace-menu rounded-xl"
          onCloseAutoFocus={(event) => finishMenuClose(event, group)}
        >
          {actions.map(({ label, Icon, run, destructive }) => (
            <ContextMenuItem
              key={label}
              onSelect={run}
              variant={destructive ? "destructive" : "default"}
            >
              <Icon />
              {label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    )
  }
  return (
    <section className="bot-im-list" aria-label="招乎群聊">
      <h3>
        招乎群聊
        {unread > 0 && (
          <span className="bot-im-unread-total" aria-label={`${unread} 个群聊未读`}>
            {unread}
          </span>
        )}
      </h3>
      {active.map(renderRow)}
      {history.length > 0 && (
        <section className="bot-im-history">
          <button
            className="bot-im-history-toggle"
            aria-label={`已解绑 · ${history.length}`}
            aria-expanded={expanded}
            onClick={() => onHistoryCollapsed(expanded)}
            disabled={Boolean(query.trim()) || showHidden}
            data-bot-row-key="im:history"
            data-bot-expand-unread={!expanded || undefined}
            data-bot-unread-count={
              !expanded ? history.filter((item) => item.activity.unread).length : undefined
            }
            title="已解绑的群聊，保留历史记录"
          >
            <ChevronRight size={13} data-expanded={expanded} />
            <span>已解绑 · {history.length}</span>
          </button>
          {expanded && history.map(renderRow)}
        </section>
      )}
    </section>
  )
}

export function SidebarTime({ value }: { value?: number }) {
  const text = botSidebarTime(value)
  return text ? (
    <time
      className="bot-sidebar-time"
      dateTime={new Date(value!).toISOString()}
      title={new Date(value!).toLocaleString()}
    >
      {text}
    </time>
  ) : null
}
