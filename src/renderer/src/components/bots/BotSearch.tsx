import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  Search,
  Loader2,
  MessageSquare,
  Bot,
  Users,
  FileText,
  Link,
  Clock,
  ChevronLeft
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type { BotSearchInput, BotSearchKind, BotSearchMatch } from "../../../../shared/bot-search"

const kinds = [
  { id: "message", label: "消息", icon: MessageSquare },
  { id: "bot", label: "Bot", icon: Bot },
  { id: "group", label: "群聊", icon: Users },
  { id: "file", label: "文件", icon: FileText },
  { id: "link", label: "链接", icon: Link },
  { id: "routine", label: "例程", icon: Clock }
] as const
interface SearchState {
  key: string
  matches: BotSearchMatch[]
  cursor: string | null
  scanned: number
  busy: boolean
  paused: boolean
  error: string | null
  startCursor: string | null
  previousCursors: (string | null)[]
  page: number
}
const RESULTS_PER_PAGE = 50
const CURSOR_HISTORY_LIMIT = 128
/** Navigation belongs to one dialog instance and one set of search criteria.
 * The parent shares this signal with message loading so cancellation also
 * prevents a late target page from replacing the current reading window. */
export interface BotSearchOpenContext {
  signal: AbortSignal
  isCurrent(): boolean
}
const empty = (key: string, cursor: string | null = null): SearchState => ({
  key,
  matches: [],
  cursor,
  scanned: 0,
  busy: false,
  paused: false,
  error: null,
  startCursor: cursor,
  previousCursors: [],
  page: 1
})

export function BotSearchDialog({
  conversation,
  initialKind = "message",
  initialOnlyConversation = false,
  close,
  open
}: {
  conversation?: { id: string; name: string }
  initialKind?: BotSearchKind
  initialOnlyConversation?: boolean
  close(): void
  open(match: BotSearchMatch, context?: BotSearchOpenContext): Promise<void>
}) {
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState<BotSearchKind>(initialKind)
  const [onlyConversation, setOnlyConversation] = useState(
    initialOnlyConversation && !!conversation
  )
  const conversationId = onlyConversation ? conversation?.id : undefined
  const key = JSON.stringify([query.trim(), kind, conversationId])
  const [state, setState] = useState<SearchState>(() => empty(key))
  const [opening, setOpening] = useState(false)
  const generation = useRef({ value: 0 })
  const selection = useRef<{
    active: boolean
    generation: number
    controller: AbortController | null
  }>({ active: false, generation: 0, controller: null })
  const input = useRef<HTMLInputElement>(null)
  const navigating = useRef(false)
  const invalidateSelection = useCallback((resetOpening = true) => {
    const current = selection.current
    current.generation++
    current.controller?.abort()
    current.controller = null
    if (resetOpening && current.active) setOpening(false)
  }, [])
  useLayoutEffect(() => {
    const instance = selection.current
    instance.active = true
    const fence = generation.current
    return () => {
      instance.active = false
      fence.value++
      invalidateSelection(false)
    }
  }, [invalidateSelection])
  useLayoutEffect(() => {
    // Also covers a parent changing the conversation scope without remounting.
    invalidateSelection()
  }, [key, query, invalidateSelection])
  const changeCriteria = () => {
    // Revoke synchronously in the input event, before a queued Promise callback.
    generation.current.value++
    invalidateSelection()
  }
  const dismiss = () => {
    generation.current.value++
    invalidateSelection()
    close()
  }
  const perform = useCallback(
    async (initial: SearchState, request: BotSearchInput, token: number) => {
      if (!selection.current.active || token !== generation.current.value) return
      let next = { ...initial, busy: true, paused: false, error: null }
      setState(next)
      const target = RESULTS_PER_PAGE
      try {
        do {
          const page = await botApi.search({
            ...request,
            ...(next.cursor ? { cursor: next.cursor } : {})
          })
          if (token !== generation.current.value) return
          next = {
            ...next,
            matches: [...next.matches, ...page.matches],
            cursor: page.cursor,
            scanned: next.scanned + page.scanned
          }
          setState(next)
          // Each IPC call scans at most 32 records/512 KiB; yield and remain cancellable.
        } while (next.cursor && next.matches.length < target)
        if (token === generation.current.value) setState({ ...next, busy: false })
      } catch (error) {
        if (token === generation.current.value)
          setState({
            ...next,
            busy: false,
            error: error instanceof Error ? error.message : "搜索失败"
          })
      }
    },
    []
  )
  useEffect(() => {
    const fence = generation.current
    const token = ++fence.value
    if (!query.trim()) {
      setState(empty(key))
      return
    }
    setState({ ...empty(key), busy: true })
    const timer = setTimeout(
      () => void perform(empty(key), { query: query.trim(), kind, conversationId }, token),
      220
    )
    return () => {
      clearTimeout(timer)
      fence.value++
    }
  }, [key, query, kind, conversationId, perform])
  const visible = state.key === key ? state : empty(key)
  const continueSearch = () => {
    if (visible.busy) return
    invalidateSelection()
    const next =
      visible.cursor && visible.matches.length >= RESULTS_PER_PAGE
        ? {
            ...empty(key, visible.cursor),
            previousCursors: [...visible.previousCursors, visible.startCursor].slice(
              -CURSOR_HISTORY_LIMIT
            ),
            page: visible.page + 1
          }
        : visible
    void perform(next, { query: query.trim(), kind, conversationId }, ++generation.current.value)
  }
  const previousPage = () => {
    if (visible.busy || !visible.previousCursors.length) return
    invalidateSelection()
    const next = {
      ...empty(key, visible.previousCursors.at(-1) ?? null),
      previousCursors: visible.previousCursors.slice(0, -1),
      page: visible.page - 1
    }
    void perform(next, { query: query.trim(), kind, conversationId }, ++generation.current.value)
  }
  const results = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // One bounded result page is resident. Only cursors survive forward/backward
    // navigation; the original Task History uses the same refetch-on-return rule.
    if (results.current) results.current.scrollTop = 0
  }, [visible.key, visible.page])
  const select = async (match: BotSearchMatch) => {
    const instance = selection.current
    if (!instance.active || instance.controller) return
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
    try {
      await open(match, context)
      if (!context.isCurrent()) return
      navigating.current = true
      dismiss()
    } catch (error) {
      if (context.isCurrent())
        setState((current) =>
          current.key === key
            ? {
                ...current,
                error: error instanceof Error ? error.message : "无法打开结果"
              }
            : current
        )
    } finally {
      if (context.isCurrent()) {
        instance.controller = null
        controller.abort()
        setOpening(false)
      }
    }
  }
  const Icon = kinds.find((item) => item.id === kind)!.icon
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) dismiss()
      }}
    >
      <DialogContent
        className="flex h-[min(640px,85vh)] max-w-2xl flex-col gap-3 p-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          input.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (navigating.current) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>搜索 Bot 工作区</DialogTitle>
          <DialogDescription>查找消息、文件和例程，打开结果即可继续查看。</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-3 text-muted-foreground" />
          <Input
            ref={input}
            className="pl-9"
            aria-label="搜索内容"
            placeholder="输入关键词…"
            maxLength={256}
            value={query}
            onChange={(event) => {
              if (query === event.target.value) return
              changeCriteria()
              setQuery(event.target.value)
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="搜索类型">
          {kinds.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={kind === item.id ? "secondary" : "ghost"}
              aria-pressed={kind === item.id}
              onClick={() => {
                if (kind === item.id) return
                changeCriteria()
                setKind(item.id)
              }}
            >
              <item.icon size={14} />
              {item.label}
            </Button>
          ))}
        </div>
        {conversation && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyConversation}
              onChange={(event) => {
                changeCriteria()
                setOnlyConversation(event.target.checked)
              }}
            />
            仅搜索 {conversation.name}
          </label>
        )}
        <div
          ref={results}
          className="min-h-0 flex-1 overflow-y-auto"
          aria-label="搜索结果"
          aria-busy={visible.busy}
        >
          {visible.matches.map((match) => (
            <button
              key={`${match.kind}:${match.id}`}
              type="button"
              className="bot-search-result"
              disabled={opening}
              onClick={() => void select(match)}
            >
              <Icon size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{match.title}</span>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {new Date(match.createdAt).toLocaleDateString()}
                  </time>
                </span>
                <span className="bot-search-snippet mt-1 block break-words text-xs leading-5 text-muted-foreground">
                  {match.snippet}
                </span>
                {match.title !== match.conversationName && (
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {match.conversationName}
                  </span>
                )}
              </span>
            </button>
          ))}
          {!visible.matches.length && !visible.busy && !visible.error && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {visible.paused
                ? "搜索已暂停，可继续检查剩余记录"
                : query.trim()
                  ? "没有找到匹配内容"
                  : "输入关键词开始搜索"}
            </p>
          )}
        </div>
        {visible.error && (
          <p role="alert" className="text-sm text-destructive">
            {visible.error}
          </p>
        )}
        <footer
          className="flex min-h-8 items-center gap-2 border-t pt-3 text-xs text-muted-foreground"
          role="status"
        >
          {visible.busy && <Loader2 size={14} className="animate-spin" />}
          <span className="flex-1">
            {visible.busy
              ? `搜索中 · 已检查 ${visible.scanned} 条记录`
              : `第 ${visible.page} 页 · ${visible.matches.length} 条结果${visible.cursor ? " · 还有更早记录" : ""}`}
          </span>
          {!!visible.previousCursors.length && (
            <Button size="sm" variant="ghost" disabled={visible.busy} onClick={previousPage}>
              <ChevronLeft size={13} />
              上一页
            </Button>
          )}
          {visible.busy ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                generation.current.value++
                invalidateSelection()
                setState((current) => ({ ...current, busy: false, paused: true }))
              }}
            >
              暂停搜索
            </Button>
          ) : (
            (visible.cursor || visible.error || visible.paused) && (
              <Button size="sm" variant="ghost" onClick={continueSearch}>
                {visible.error ? "重试" : "继续搜索"}
              </Button>
            )
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
