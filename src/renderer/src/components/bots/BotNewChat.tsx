import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react"
import { Loader2, Plus, Users, X, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BotAvatar } from "./BotAvatar"
import { cn } from "@/lib/utils"
import { botPaletteRows, type BotPaletteConversation } from "@/lib/bot-command-palette"
import {
  commandPaletteVirtualWindow,
  commandPaletteScrollTopForRow,
  movePaletteHighlight,
  normalizePaletteSearch
} from "./upstream/grok-palette-primitives"

const ROW = 56,
  INSET = 8

/** Local chooser only; the Workspace callbacks keep the original creation receipts. */
export function BotNewChat({
  conversations,
  busy,
  covered,
  canGroup,
  inputRef,
  choose,
  create,
  group,
  close,
  composer,
  groupPane,
  listHidden = false
}: {
  conversations: BotPaletteConversation[]
  busy: boolean
  covered: boolean
  canGroup: boolean
  inputRef: RefObject<HTMLInputElement | null>
  choose(conversationId: string): void
  create(nameHint?: string): void
  group(): void
  close(): void
  composer?: ReactNode
  groupPane?: ReactNode
  listHidden?: boolean
}) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState<string | null>("action:new-bot")
  const [geometry, setGeometry] = useState({ top: 0, height: 350 })
  const list = useRef<HTMLDivElement>(null)
  const groupMode = Boolean(groupPane)
  // Grok 0.68 GLe/JB: a nonempty recipient query names a new Bot only
  // after that row is explicitly chosen. Existing exact names suppress Create.
  const recipientEntries = (value: string) => {
    const queryName = value.trim().replace(/\s+/g, " ")
    const normalized = normalizePaletteSearch(value)
    const nameHint = queryName.slice(0, 72).replace(/[\uD800-\uDBFF]$/, "")
    const namedCreate =
      normalized &&
      nameHint &&
      !nameHint.includes("\0") &&
      !conversations.some((item) => normalizePaletteSearch(item.name) === normalized)
    const actions = !normalized
      ? [
          { id: "new-bot", label: "创建新 Bot", keywords: [], run: () => create() },
          { id: "new-group", label: "创建群聊", keywords: [], run: group }
        ]
      : namedCreate
        ? [{ id: "new-bot", label: `创建 ${nameHint}`, keywords: [], run: () => create(nameHint) }]
        : []
    return [
      ...botPaletteRows([], actions, [], "", "action"),
      ...botPaletteRows(conversations, [], [], value, "bot")
    ]
  }
  const entries = recipientEntries(query)
  // Keep an existing choice by identity. A removed row never falls back to Create.
  const selected = entries.findIndex((entry) => entry.id === highlight)
  const selectedId = entries[selected]?.id
  const unavailable = (row: (typeof entries)[number]) =>
    row.command?.id === "new-group" && !canGroup
  const windowed = commandPaletteVirtualWindow({
    rowCount: entries.length,
    rowPitchPx: ROW,
    leadingOffsetPx: INSET,
    scrollTopPx: geometry.top,
    viewportPx: geometry.height,
    overscanRows: 6
  })
  useEffect(() => {
    if (covered || busy || groupMode) return
    // The previously expanded Inspector's existing focus scope first releases
    // its trap. One cancellable frame then focuses this local recipient field.
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [covered, busy, groupMode, inputRef])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const resize = new ResizeObserver(() =>
      setGeometry({ top: element.scrollTop, height: element.clientHeight })
    )
    resize.observe(element)
    return () => resize.disconnect()
  }, [groupMode])
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
  const activate = (row: (typeof entries)[number]) => {
    if (busy || covered || unavailable(row)) return
    if (row.conversationId) choose(row.conversationId)
    else row.command?.run()
  }
  const move = (delta: -1 | 1) => {
    let next =
      selected < 0
        ? delta === 1
          ? 0
          : entries.length - 1
        : movePaletteHighlight(selected, entries.length, delta)
    while (next >= 0 && next < entries.length && unavailable(entries[next])) next += delta
    if (next >= 0 && next < entries.length) setHighlight(entries[next].id)
  }
  return (
    <section
      className="bot-new-chat-stage"
      aria-label="新建聊天"
      aria-busy={busy}
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
        if (!busy && !covered) close()
      }}
    >
      {groupPane ? (
        groupPane
      ) : (
        <>
          <header className="bot-new-chat-header">
            <label id={`${id}-recipient-label`} htmlFor={`${id}-recipient`}>
              收件人：
            </label>
            <div className="bot-new-chat-recipient">
              <input
                id={`${id}-recipient`}
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label="选择聊天收件人"
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                aria-expanded={!listHidden}
                aria-activedescendant={
                  !listHidden && selectedId ? `${id}-row-${selected}` : undefined
                }
                placeholder="选择 Bot 开始聊天…"
                value={query}
                maxLength={256}
                disabled={busy}
                onChange={(event) => {
                  const nextQuery = event.target.value
                  const rows = recipientEntries(nextQuery)
                  const first = normalizePaletteSearch(nextQuery)
                    ? rows.find((row) => row.conversationId && !unavailable(row))
                    : undefined
                  setQuery(nextQuery)
                  setHighlight((first ?? rows.find((row) => !unavailable(row)))?.id ?? null)
                  if (list.current) list.current.scrollTop = 0
                  setGeometry((current) => ({ ...current, top: 0 }))
                }}
                onKeyDown={(event) => {
                  if (
                    busy ||
                    covered ||
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
                    if (selected >= 0) activate(entries[selected])
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
              disabled={busy}
              onClick={close}
            >
              <X size={18} />
            </Button>
          </header>
          <div className="bot-new-chat-card" hidden={listHidden}>
            <div
              ref={list}
              id={`${id}-list`}
              role="listbox"
              aria-labelledby={`${id}-recipient-label`}
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
                      aria-disabled={unavailable(row) || undefined}
                      disabled={busy || unavailable(row)}
                      className={cn("bot-new-chat-option", selected === index && "is-selected")}
                      style={{ top: INSET + index * ROW, height: ROW - 2 }}
                      onMouseMove={() => {
                        if (!unavailable(row)) setHighlight(row.id)
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => activate(row)}
                    >
                      <span className="bot-new-chat-option-avatar">
                        {row.memberIds?.[0] ? (
                          <BotAvatar agentId={row.memberIds[0]} size="sm" isStatic />
                        ) : row.command?.id === "new-group" ? (
                          <Users size={19} />
                        ) : (
                          <Plus size={20} />
                        )}
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
            {busy && (
              <p className="bot-new-chat-hint" role="status">
                <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                正在确认创建结果…
              </p>
            )}
          </div>
        </>
      )}
      {composer}
    </section>
  )
}
