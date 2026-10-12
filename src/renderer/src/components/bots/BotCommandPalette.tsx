import { useCallback, useId, useLayoutEffect, useRef, useState } from "react"
import {
  Search,
  Bot,
  Users,
  MessageSquare,
  FileText,
  Link,
  Clock,
  Command,
  ChevronRight,
  ArrowLeft,
  EyeOff,
  Loader2,
  ListFilter,
  Settings2,
  ShieldCheck,
  Plus,
  PanelLeft,
  ArrowRight,
  Wrench,
  Brain,
  Monitor,
  Archive,
  History,
  Download,
  Gauge,
  RotateCcw,
  CircleHelp,
  Keyboard,
  type LucideIcon
} from "lucide-react"
import { Dialog, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { Button } from "@/components/ui/button"
import { BotAvatar } from "./BotAvatar"
import { cn } from "@/lib/utils"
import {
  botPaletteRows,
  type BotPaletteCommand,
  type BotPaletteConversation,
  type BotPaletteRow,
  type BotPaletteTab
} from "@/lib/bot-command-palette"
import { useBotPaletteSearch } from "@/lib/use-bot-palette-search"
import {
  commandPaletteVirtualWindow,
  commandPaletteScrollTopForRow,
  movePaletteHighlight,
  paletteIndexedShortcutIndex
} from "./upstream/grok-palette-primitives"
import type { BotSearchMatch } from "../../../../shared/bot-search"
import type { BotSearchOpenContext } from "./BotSearch"

const tabs: { id: BotPaletteTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "message", label: "消息" },
  { id: "bot", label: "Bot" },
  { id: "group", label: "群聊" },
  { id: "file", label: "文件" },
  { id: "link", label: "链接" },
  { id: "routine", label: "例程" },
  { id: "action", label: "操作" }
]
const icons = {
  bot: Bot,
  group: Users,
  message: MessageSquare,
  file: FileText,
  link: Link,
  routine: Clock,
  action: Command
}
/** Icons describe the existing injected commands; their callbacks still own all effects. */
const commandIcons: Readonly<Record<string, LucideIcon>> = {
  "filter-sidebar": ListFilter,
  "search-content": Search,
  "local-tool-permission": ShieldCheck,
  sidebar: PanelLeft,
  "history-back": ArrowLeft,
  "history-forward": ArrowRight,
  "new-bot": Plus,
  "new-group": Users,
  "chat-settings": Settings2,
  "app-settings": Settings2,
  "bot-tools": Wrench,
  skills: Wrench,
  memory: Brain,
  routines: Clock,
  browser: Monitor,
  "computer-checkpoints": History,
  backups: Archive,
  downloads: Download,
  "usage-budget": Gauge,
  "recovery-records": RotateCcw,
  help: CircleHelp,
  keyboard: Keyboard
}
const ROW = 51,
  INSET = 8

export function BotCommandPalette({
  conversations,
  commands,
  searchEnabled,
  openConversation,
  openMatch,
  close
}: {
  conversations: BotPaletteConversation[]
  commands: BotPaletteCommand[]
  searchEnabled: boolean
  openConversation(id: string): void
  openMatch(match: BotSearchMatch, context?: BotSearchOpenContext): Promise<void>
  close(): void
}) {
  const [query, setQuery] = useState(""),
    [tab, setTab] = useState<BotPaletteTab>("all")
  const [trail, setTrail] = useState<string[]>([]),
    [highlight, setHighlight] = useState<string | null>(null)
  const [opening, setOpening] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [modifier, setModifier] = useState(false)
  const [geometry, setGeometry] = useState({ top: 0, height: 350 })
  const input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null)
  const activated = useRef(false)
  const action = useRef<{
    active: boolean
    generation: number
    controller: AbortController | null
  }>({ active: false, generation: 0, controller: null })
  const invalidateAction = useCallback((resetOpening = true) => {
    const current = action.current
    current.generation++
    current.controller?.abort()
    current.controller = null
    if (resetOpening && current.active) setOpening(false)
  }, [])
  const id = useId()
  const mac = window.electron?.process.platform === "darwin"
  let currentCommands = commands
  const parents: BotPaletteCommand[] = []
  for (const key of trail) {
    const parent = currentCommands.find((command) => command.id === key && command.children)
    if (!parent) break
    parents.push(parent)
    currentCommands = parent.children!
  }
  const nested = parents.length > 0
  const search = useBotPaletteSearch(query, nested ? "action" : tab, searchEnabled)
  const entries = botPaletteRows(
    nested ? [] : conversations,
    currentCommands,
    nested ? [] : search.matches,
    query,
    nested ? "action" : tab
  )
  // Search pages and workspace polling can insert/reorder rows while a user is
  // choosing. Keep their choice attached to its identity, never its old index.
  const selected = Math.max(
    0,
    entries.findIndex((entry) => entry.id === highlight)
  )
  const windowed = commandPaletteVirtualWindow({
    rowCount: entries.length,
    rowPitchPx: ROW,
    leadingOffsetPx: INSET,
    scrollTopPx: geometry.top,
    viewportPx: geometry.height,
    overscanRows: 6
  })
  const selectedId = entries[selected]?.id
  useLayoutEffect(() => {
    const instance = action.current
    instance.active = true
    return () => {
      instance.active = false
      invalidateAction(false)
    }
  }, [invalidateAction])
  useLayoutEffect(() => {
    invalidateAction()
  }, [query, tab, trail, searchEnabled, invalidateAction])
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
    if (!element || !selectedId) return
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
  function resetSelection() {
    // Revoke in the input event, before a pending navigation can settle.
    invalidateAction()
    setHighlight(null)
    setError(null)
    if (list.current) list.current.scrollTop = 0
  }
  function changeTab(value: BotPaletteTab) {
    if (value === tab) return
    setTab(value)
    resetSelection()
    input.current?.focus()
  }
  function cycle(delta: number) {
    changeTab(
      tabs[(tabs.findIndex((value) => value.id === tab) + delta + tabs.length) % tabs.length].id
    )
  }
  function back() {
    setTrail(parents.slice(0, -1).map((parent) => parent.id))
    setQuery("")
    resetSelection()
    input.current?.focus()
  }
  function dismiss() {
    invalidateAction()
    close()
  }
  async function activate(row: BotPaletteRow) {
    const instance = action.current
    if (!instance.active || instance.controller) return
    if (row.command?.children) {
      setTrail([...parents.map((parent) => parent.id), row.command.id])
      setQuery("")
      resetSelection()
      input.current?.focus()
      return
    }
    const controller = new AbortController()
    const token = ++instance.generation
    instance.controller = controller
    const context: BotSearchOpenContext = {
      signal: controller.signal,
      isCurrent: () =>
        instance.active &&
        instance.generation === token &&
        instance.controller === controller &&
        !controller.signal.aborted
    }
    setOpening(true)
    setError(null)
    try {
      if (row.match) await openMatch(row.match, context)
      else if (row.conversationId) openConversation(row.conversationId)
      else row.command?.run()
      if (!context.isCurrent()) return
      activated.current = true
      dismiss()
    } catch (cause) {
      if (context.isCurrent()) setError(cause instanceof Error ? cause.message : "无法打开，请重试")
    } finally {
      // A late completion must not unlock or overwrite a newer activation.
      if (context.isCurrent()) {
        instance.controller = null
        controller.abort()
        setOpening(false)
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent
        className="bot-command-palette flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[640px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          input.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (activated.current) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) {
            event.preventDefault()
            return
          }
          if (nested) {
            event.preventDefault()
            back()
          }
        }}
      >
        <DialogTitle className="sr-only">快速查找与操作</DialogTitle>
        <DialogDescription className="sr-only">
          切换 Bot、搜索内容或打开常用操作。上下选择，回车打开，Tab 切换分类。
        </DialogDescription>
        <div className="flex h-16 shrink-0 items-center gap-3 border-b px-5 pr-12">
          {nested ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label="返回上一级"
              onClick={back}
            >
              <ArrowLeft size={16} />
            </Button>
          ) : (
            <Search size={19} className="shrink-0 text-muted-foreground" />
          )}
          <input
            ref={input}
            value={query}
            maxLength={256}
            placeholder={nested ? parents.at(-1)!.label : "查找 Bot、内容或操作…"}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-label="快速查找"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-expanded
            aria-activedescendant={selectedId ? `${id}-row-${selected}` : undefined}
            onChange={(event) => {
              if (event.target.value === query) return
              setQuery(event.target.value)
              resetSelection()
            }}
            onBlur={() => setModifier(false)}
            onKeyUp={(event) => {
              if (event.key === "Meta" || event.key === "Control") setModifier(false)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process")
                return
              if (event.key === "Meta" || event.key === "Control") setModifier(true)
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault()
                dismiss()
                return
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                setHighlight(
                  entries[
                    movePaletteHighlight(
                      selected,
                      entries.length,
                      event.key === "ArrowDown" ? 1 : -1
                    )
                  ]?.id ?? null
                )
                return
              }
              if (
                !nested &&
                (event.key === "Tab" ||
                  (!query && (event.key === "ArrowLeft" || event.key === "ArrowRight")))
              ) {
                event.preventDefault()
                cycle(event.shiftKey || event.key === "ArrowLeft" ? -1 : 1)
                return
              }
              if (
                nested &&
                !query &&
                event.key === "Backspace" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey
              ) {
                event.preventDefault()
                back()
                return
              }
              if (event.key === "Enter" && entries[selected]) {
                event.preventDefault()
                void activate(entries[selected])
                return
              }
              if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
                const index = paletteIndexedShortcutIndex(event.key, nested, entries.length)
                if (index !== null) {
                  event.preventDefault()
                  void activate(entries[index])
                }
              }
            }}
          />
        </div>
        {!nested ? (
          <div
            className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2"
            role="tablist"
            aria-label="快速查找类型"
          >
            {tabs.map((item) => (
              <Button
                role="tab"
                aria-selected={tab === item.id}
                key={item.id}
                size="sm"
                variant={tab === item.id ? "secondary" : "ghost"}
                className="h-7 shrink-0 rounded-md px-2.5 text-xs"
                onClick={() => changeTab(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        ) : (
          <div className="px-5 py-2 text-xs text-muted-foreground">
            {parents.map((parent) => parent.label).join(" / ")}
          </div>
        )}
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label="快速查找结果"
          aria-busy={search.busy || opening}
          className="relative min-h-24 h-[350px] overflow-y-auto"
          onScroll={(event) =>
            setGeometry({
              top: event.currentTarget.scrollTop,
              height: event.currentTarget.clientHeight
            })
          }
        >
          {entries.length ? (
            <div style={{ height: entries.length * ROW + INSET * 2 }}>
              {entries.slice(windowed.start, windowed.end).map((row, offset) => {
                const index = windowed.start + offset,
                  Icon =
                    row.command && Object.hasOwn(commandIcons, row.command.id)
                      ? commandIcons[row.command.id]
                      : icons[row.kind]
                return (
                  <button
                    key={row.id}
                    id={`${id}-row-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected === index}
                    aria-setsize={entries.length}
                    aria-posinset={index + 1}
                    tabIndex={-1}
                    disabled={opening}
                    onMouseMove={() => setHighlight(row.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void activate(row)}
                    className={cn(
                      "absolute left-2 right-2 flex items-center gap-3 rounded-lg px-3 text-left transition-colors motion-reduce:transition-none",
                      selected === index
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-muted/50"
                    )}
                    style={{ top: INSET + index * ROW, height: ROW - 2 }}
                  >
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-lg",
                        row.kind === "action" && "bg-muted text-muted-foreground"
                      )}
                    >
                      {row.conversationId &&
                      row.memberIds &&
                      (row.kind === "group" || row.memberIds[0]) ? (
                        <BotAvatar
                          agentId={row.kind === "group" ? row.conversationId : row.memberIds[0]}
                          kind={row.kind === "group" ? "group" : "agent"}
                          memberIds={row.memberIds}
                          size="md"
                          isStatic
                        />
                      ) : (
                        <Icon size={17} className="text-muted-foreground" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{row.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {row.detail}
                      </span>
                    </span>
                    {row.hidden && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <EyeOff size={12} />
                        隐藏
                      </span>
                    )}
                    {row.command?.children ? (
                      <ChevronRight size={14} className="text-muted-foreground" />
                    ) : modifier && index < 9 && !nested ? (
                      <kbd className="text-[11px] text-muted-foreground">
                        {mac ? "⌘" : "Ctrl"}
                        {index + 1}
                      </kbd>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Search size={24} className="opacity-40" />
              <span>
                {search.busy
                  ? "正在查找…"
                  : query.trim()
                    ? "没有找到匹配内容"
                    : "输入关键词查找内容"}
              </span>
            </div>
          )}
        </div>
        {(error ||
          search.error ||
          (!searchEnabled && ["message", "file", "link", "routine"].includes(tab))) && (
          <p role="alert" className="px-5 py-2 text-xs text-destructive">
            {error ?? search.error ?? "当前后台不支持内容搜索，请更新后台后再试"}
          </p>
        )}
        <footer
          className="flex min-h-10 shrink-0 items-center gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground"
          role="status"
        >
          {search.busy || opening ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              <span className="flex-1">
                {opening ? "正在打开…" : `已检查 ${search.scanned} 条记录`}
              </span>
            </>
          ) : (
            <span className="flex-1">
              ↑↓ 选择 · ↵ 打开 · {nested ? "Esc 返回" : "Tab 切换分类"}
            </span>
          )}
          {search.busy ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => {
                invalidateAction()
                setError(null)
                search.pause()
              }}
            >
              暂停
            </Button>
          ) : search.more || search.error ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => {
                invalidateAction()
                setError(null)
                search.retry()
              }}
            >
              {search.error ? "重试" : "继续搜索"}
            </Button>
          ) : (
            <span>{entries.length} 项</span>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
