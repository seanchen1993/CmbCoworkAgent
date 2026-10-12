import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { Check, ChevronDown, ChevronLeft, EyeOff, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { BotAvatar } from "./BotAvatar"
import { BotGroupSaveStatus } from "./BotGroupSaveStatus"
import { cn } from "@/lib/utils"
import { botPaletteRows } from "@/lib/bot-command-palette"
import { useBotGroupSave, type BotGroupSaveRequest } from "@/lib/use-bot-group-save"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BOT_SINGLE_BOT_ROOM_CAPABILITY } from "../../../../shared/bot-groups"
import type { BotConversation, CoworkBot } from "../../../../shared/bot-types"
import {
  commandPaletteScrollTopForRow,
  commandPaletteVirtualWindow,
  movePaletteHighlight,
  normalizePaletteSearch
} from "./upstream/grok-palette-primitives"

const ROW = 56,
  INSET = 8

export interface BotNewChatGroupOwner {
  isCurrent(): boolean
  prepared(input: BotGroupSaveRequest): void
  saved(saved: BotConversation, input: BotGroupSaveRequest): Promise<void>
  /** Same local session only; the parent must not unlock a replacement intent. */
  setResolving?(busy: boolean): void
}
export interface BotNewChatGroupProps {
  bots: CoworkBot[]
  covered: boolean
  inputRef: RefObject<HTMLInputElement | null>
  close(): void
  back(): void
  owner: BotNewChatGroupOwner
}

/** Recipient selection stays local. Only the original protected save hook creates a group. */
export function BotNewChatGroup({
  bots,
  covered,
  inputRef,
  close,
  back,
  owner
}: BotNewChatGroupProps) {
  const id = useId()
  const minimumMembers = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes(BOT_SINGLE_BOT_ROOM_CAPABILITY) ? 1 : 2
  )
  const latestOwner = useRef(owner)
  useLayoutEffect(() => {
    latestOwner.current = owner
  }, [owner])
  const session = useBotGroupSave(undefined, owner.saved, {
    isCurrent: owner.isCurrent,
    prepared: owner.prepared
  })
  useLayoutEffect(() => {
    latestOwner.current.setResolving?.(session.busy)
  }, [session.busy])
  const [draftMembers, setDraftMembers] = useState<string[]>([])
  const [draftName, setDraftName] = useState<string | null>(null)
  const [draftDescription, setDraftDescription] = useState("")
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState<string | null>(null)
  const [informationOpen, setInformationOpen] = useState(false)
  const [geometry, setGeometry] = useState({ top: 0, height: 350 })
  const list = useRef<HTMLDivElement>(null)
  // A newly discovered other pane's request must replace the visible fields
  // before a second explicit click can retry its original nonce.
  const members = session.pending?.members ?? draftMembers
  const defaultName = members
    .map((member) => bots.find((bot) => bot.id === member)?.name ?? "不可用 Bot")
    .join("、")
    .slice(0, 100)
    .replace(/[\uD800-\uDBFF]$/, "")
  const name = session.pending?.name ?? draftName ?? (defaultName || "协作群聊")
  const description = session.pending?.description ?? draftDescription
  const informationShown = informationOpen || Boolean(session.pending || session.acknowledged)
  const fieldsDisabled = covered || session.fieldsDisabled
  const missingMembers = members.filter((member) => !bots.some((bot) => bot.id === member))
  const candidates = bots
    .filter((bot) => !members.includes(bot.id))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      detail: bot.instructions.slice(0, 400),
      group: false,
      hidden: Boolean(bot.hidden),
      memberIds: [bot.id]
    }))
  const entries = botPaletteRows(candidates, [], [], query, "bot")
  const selected = entries.findIndex((row) => row.id === highlight)
  const selectedId = entries[selected]?.id
  const windowed = commandPaletteVirtualWindow({
    rowCount: entries.length,
    rowPitchPx: ROW,
    leadingOffsetPx: INSET,
    scrollTopPx: geometry.top,
    viewportPx: geometry.height,
    overscanRows: 6
  })
  const cannotSave =
    covered ||
    session.saveDisabled ||
    (!session.pending &&
      !session.acknowledged &&
      (members.length < minimumMembers ||
        members.length > 6 ||
        !name.trim() ||
        missingMembers.length > 0))
  const current = () => !covered && owner.isCurrent()
  const canEdit = () => current() && !session.fieldsDisabled && !session.isSaving()

  useEffect(() => {
    if (covered || session.busy) return
    const frame = requestAnimationFrame(() => {
      if (latestOwner.current.isCurrent()) inputRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [covered, session.busy, inputRef])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const resize = new ResizeObserver(() =>
      setGeometry({ top: element.scrollTop, height: element.clientHeight })
    )
    resize.observe(element)
    return () => resize.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = list.current
    if (!element || selected < 0 || !selectedId) return
    const top = commandPaletteScrollTopForRow({
      rowIndex: selected,
      rowPitchPx: ROW,
      rowGapPx: 2,
      leadingOffsetPx: INSET,
      scrollTopPx: element.scrollTop,
      viewportPx: element.clientHeight,
      edgeInsetPx: INSET
    })
    if (top !== null) element.scrollTop = top
    setGeometry({ top: element.scrollTop, height: element.clientHeight })
  }, [selected, selectedId])

  const add = (member: string) => {
    if (!canEdit() || members.length >= 6 || !bots.some((bot) => bot.id === member)) return
    setDraftMembers((previous) =>
      previous.length >= 6 || previous.includes(member) ? previous : [...previous, member]
    )
    setQuery("")
    setHighlight(null)
    if (list.current) list.current.scrollTop = 0
    setGeometry((previous) => ({ ...previous, top: 0 }))
    inputRef.current?.focus({ preventScroll: true })
  }
  const remove = (member: string) => {
    if (!canEdit()) return
    setDraftMembers((previous) => previous.filter((value) => value !== member))
    inputRef.current?.focus({ preventScroll: true })
  }
  const save = () => {
    if (cannotSave || !current()) return
    void session.save({ name: name.trim(), description, members: [...members] })
  }
  const move = (delta: -1 | 1) => {
    const next =
      selected < 0
        ? delta === 1
          ? 0
          : entries.length - 1
        : movePaletteHighlight(selected, entries.length, delta)
    if (entries[next]) setHighlight(entries[next].id)
  }

  return (
    <div
      className="bot-new-chat-group flex min-h-0 flex-1 flex-col"
      role="region"
      aria-label="选择群聊成员"
      aria-busy={session.busy}
      aria-hidden={covered || undefined}
      inert={covered}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return
        event.preventDefault()
        event.stopPropagation()
        if (current() && !session.isSaving()) close()
      }}
    >
      <header className="bot-new-chat-header">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          aria-label="返回选择 Bot"
          disabled={covered || session.busy}
          onClick={() => {
            if (current() && !session.isSaving()) back()
          }}
        >
          <ChevronLeft size={18} />
        </Button>
        <label htmlFor={`${id}-recipient`}>收件人：</label>
        <div className="bot-new-chat-recipient flex flex-wrap items-center gap-1.5">
          {members.map((member) => {
            const bot = bots.find((value) => value.id === member)
            const label = bot?.name ?? "不可用 Bot"
            return (
              <span
                key={member}
                className="inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-full border bg-muted/60 py-1 pl-1.5 pr-1"
              >
                <BotAvatar agentId={member} size="xs" isStatic />
                <span className="truncate text-xs">{label}</span>
                <button
                  type="button"
                  aria-label={`移除 ${label}`}
                  title={bot ? label : `成员已不可用：${member}`}
                  disabled={fieldsDisabled}
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => remove(member)}
                >
                  <X size={12} />
                </button>
              </span>
            )
          })}
          <input
            id={`${id}-recipient`}
            ref={inputRef}
            role="combobox"
            type="text"
            aria-label="选择群聊收件人"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-expanded
            aria-activedescendant={selectedId ? `${id}-row-${selected}` : undefined}
            placeholder={members.length >= 6 ? "最多选择 6 个 Bot" : "继续选择 Bot…"}
            disabled={fieldsDisabled}
            maxLength={256}
            value={query}
            onChange={(event) => {
              if (!canEdit()) return
              const value = event.target.value
              setQuery(value)
              // Query edits choose the first ranked match; polling never retargets Enter.
              setHighlight(botPaletteRows(candidates, [], [], value, "bot")[0]?.id ?? null)
              if (list.current) list.current.scrollTop = 0
              setGeometry((previous) => ({ ...previous, top: 0 }))
            }}
            onKeyDown={(event) => {
              if (
                !canEdit() ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                event.key === "Process" ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
              )
                return
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                event.stopPropagation()
                move(event.key === "ArrowDown" ? 1 : -1)
              } else if (event.key === "Enter") {
                event.preventDefault()
                event.stopPropagation()
                if (!normalizePaletteSearch(query) && members.length >= minimumMembers) save()
                else {
                  const member = entries[selected]?.conversationId
                  if (member) add(member)
                }
              } else if (event.key === "Backspace" && !query && members.length > 0) {
                event.preventDefault()
                event.stopPropagation()
                remove(members[members.length - 1])
              }
            }}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          aria-label="关闭新建聊天"
          disabled={covered || session.busy}
          onClick={() => {
            if (current() && !session.isSaving()) close()
          }}
        >
          <X size={18} />
        </Button>
      </header>
      <div className="bot-new-chat-card overflow-y-auto">
        <div className="flex items-center justify-between gap-3 px-3 pb-2 text-xs text-muted-foreground">
          <span role="status">
            已选 {members.length}/6 · 选择 {minimumMembers}～6 个 Bot
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            aria-expanded={informationShown}
            aria-controls={`${id}-information`}
            disabled={covered || Boolean(session.pending || session.acknowledged)}
            onClick={() => {
              if (current()) setInformationOpen((value) => !value)
            }}
          >
            群聊资料
            <ChevronDown size={13} />
          </Button>
        </div>
        <div className="space-y-3 px-3 pb-3">
          <BotGroupSaveStatus session={session} />
          {session.restored && (
            <p role="alert" className="text-xs text-destructive">
              工作区数据已恢复，请重新打开并核对原群聊保存记录。
            </p>
          )}
          {missingMembers.length > 0 && !session.pending && (
            <p role="alert" className="text-xs text-destructive">
              部分成员已不可用，请移除后重新选择。
            </p>
          )}
          {informationShown && (
            <div id={`${id}-information`} className="space-y-3">
              <label className="block space-y-1.5 text-xs font-medium">
                <span>群聊名称</span>
                <Input
                  aria-label="群聊名称"
                  maxLength={100}
                  disabled={fieldsDisabled}
                  value={name}
                  onChange={(event) => {
                    if (canEdit()) setDraftName(event.target.value)
                  }}
                />
              </label>
              <label className="block space-y-1.5 text-xs font-medium">
                <span>协作目标</span>
                <textarea
                  aria-label="群聊描述"
                  className="min-h-20 w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  placeholder="这个群聊负责什么工作"
                  maxLength={2000}
                  disabled={fieldsDisabled}
                  value={description}
                  onChange={(event) => {
                    if (canEdit()) setDraftDescription(event.target.value)
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label="可添加的 Bot"
          className="bot-new-chat-list"
          onScroll={(event) =>
            setGeometry({
              top: event.currentTarget.scrollTop,
              height: event.currentTarget.clientHeight
            })
          }
        >
          <div style={{ height: entries.length * ROW + INSET * 2 }}>
            {entries.slice(windowed.start, windowed.end).map((row, offset) => {
              const index = windowed.start + offset
              const member = row.conversationId
              if (!member) return null
              return (
                <button
                  key={row.id}
                  id={`${id}-row-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected === index}
                  aria-setsize={entries.length}
                  aria-posinset={index + 1}
                  disabled={fieldsDisabled || members.length >= 6}
                  className={cn("bot-new-chat-option", selected === index && "is-selected")}
                  style={{ top: INSET + index * ROW, height: ROW - 2 }}
                  onMouseMove={() => {
                    if (canEdit() && members.length < 6) setHighlight(row.id)
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    add(member)
                  }}
                >
                  <span className="bot-new-chat-option-avatar">
                    <BotAvatar agentId={member} size="sm" isStatic />
                  </span>
                  <span className="bot-new-chat-option-copy">
                    <span>{row.label}</span>
                  </span>
                  {row.hidden && <EyeOff size={13} className="text-muted-foreground" />}
                </button>
              )
            })}
          </div>
        </div>
        {entries.length === 0 && (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            {query ? "没有匹配的 Bot" : "没有更多可添加的 Bot"}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t px-3 py-3">
          {session.pending && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={covered || session.busy}
              onClick={() => {
                if (current() && !session.isSaving()) close()
              }}
            >
              稍后核对
            </Button>
          )}
          <Button type="button" size="sm" disabled={cannotSave} onClick={save}>
            {session.busy ? (
              <>
                <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                保存中…
              </>
            ) : session.acknowledged ? (
              "核对已完成操作记录"
            ) : session.pending ? (
              "重试核对保存"
            ) : (
              <>
                <Check size={14} />
                创建群聊
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
