import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  Check,
  Copy,
  Globe2,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  X
} from "lucide-react"
import { toast } from "sonner"
import type {
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserState
} from "../../../../shared/browser-types"

interface BrowserPanelProps {
  threadId?: string | null
  workspacePath?: string | null
  initialUrl?: string | null
  reloadToken?: number
  onFullscreenChange?: (isFullscreen: boolean) => void
}

const EMPTY_STATE: BrowserState = {
  sessionId: "",
  url: "",
  title: "",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  visible: false,
  created: false,
  consoleEntries: []
}

function getSessionId(threadId?: string | null): string {
  return `thread-${threadId || "unbound"}`
}

function isSameBounds(a: BrowserBounds | null, b: BrowserBounds): boolean {
  return Boolean(a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

export function BrowserPanel({
  threadId,
  workspacePath,
  initialUrl,
  reloadToken,
  onFullscreenChange
}: BrowserPanelProps): React.JSX.Element {
  const sessionId = useMemo(() => getSessionId(threadId), [threadId])
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<BrowserBounds | null>(null)
  const isUrlFocusedRef = useRef(false)
  const lastInitialNavigationRef = useRef<string | null>(null)
  const consoleScrollerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>({ ...EMPTY_STATE, sessionId })
  const [urlInput, setUrlInput] = useState("")
  const [isUrlFocused, setIsUrlFocused] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [copiedConsole, setCopiedConsole] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    setState({ ...EMPTY_STATE, sessionId })
    setUrlInput("")
    lastBoundsRef.current = null
    lastInitialNavigationRef.current = null
    setCopiedConsole(false)
    setConsoleOpen(false)
    setIsFullscreen(false)
  }, [sessionId])

  useEffect(() => {
    return window.api.browser.onState(sessionId, (nextState) => {
      setState(nextState)
      if (!isUrlFocusedRef.current) {
        setUrlInput(nextState.url)
      }
    })
  }, [sessionId])

  const syncBounds = useCallback(
    (force = false) => {
      const element = viewportRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      const bounds: BrowserBounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
      const visible = rect.width >= 8 && rect.height >= 8
      if (!force && isSameBounds(lastBoundsRef.current, bounds)) return
      lastBoundsRef.current = bounds
      void window.api.browser
        .setBounds(sessionId, bounds, visible)
        .then(setState)
        .catch((error) => {
          console.error("[BrowserPanel] Failed to sync bounds:", error)
        })
    },
    [sessionId]
  )

  useEffect(() => {
    let cancelled = false
    let frame: number | null = null

    const scheduleSync = (force = false): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (!cancelled) syncBounds(force)
      })
    }

    window.api.browser
      .attach(sessionId, { workspacePath })
      .then((nextState) => {
        if (cancelled) return
        setState(nextState)
        if (!isUrlFocusedRef.current) setUrlInput(nextState.url)
        scheduleSync(true)
      })
      .catch((error) => {
        console.error("[BrowserPanel] Failed to attach browser:", error)
        toast.error("内置浏览器启动失败")
      })

    const observer = new ResizeObserver(() => scheduleSync())
    const handleResize = (): void => scheduleSync()
    const handleScroll = (): void => scheduleSync()
    if (viewportRef.current) observer.observe(viewportRef.current)
    window.addEventListener("resize", handleResize)
    window.addEventListener("scroll", handleScroll, true)

    return () => {
      cancelled = true
      observer.disconnect()
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("scroll", handleScroll, true)
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      void window.api.browser.detach(sessionId).catch((error) => {
        console.error("[BrowserPanel] Failed to detach browser:", error)
      })
    }
  }, [sessionId, syncBounds, workspacePath])

  useEffect(() => {
    if (!isUrlFocused) {
      setUrlInput(state.url)
    }
  }, [isUrlFocused, state.url])

  useEffect(() => {
    const scroller = consoleScrollerRef.current
    if (!scroller || !consoleOpen) return
    scroller.scrollTop = scroller.scrollHeight
  }, [consoleOpen, state.consoleEntries])

  useEffect(() => {
    if (!isFullscreen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsFullscreen(false)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [isFullscreen])

  useEffect(() => {
    onFullscreenChange?.(isFullscreen)
  }, [isFullscreen, onFullscreenChange])

  useEffect(() => {
    return () => {
      onFullscreenChange?.(false)
    }
  }, [onFullscreenChange])

  useEffect(() => {
    const target = initialUrl?.trim()
    if (!target) return

    const key = `${target}:${reloadToken ?? 0}:${workspacePath ?? ""}`
    if (lastInitialNavigationRef.current === key) return
    lastInitialNavigationRef.current = key

    window.api.browser
      .navigate(sessionId, target, { workspacePath })
      .then((nextState) => {
        setState(nextState)
        if (nextState.error) {
          setUrlInput(target)
          toast.error(nextState.error)
          return
        }
        if (!isUrlFocusedRef.current) {
          setUrlInput(nextState.url || target)
        }
      })
      .catch((error) => {
        console.error("[BrowserPanel] Failed to open preview URL:", error)
        toast.error("HTML 预览加载失败")
      })
  }, [initialUrl, reloadToken, sessionId, workspacePath])

  const navigate = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault()
      const target = urlInput.trim()
      if (!target) return
      try {
        const nextState = await window.api.browser.navigate(sessionId, target, { workspacePath })
        setState(nextState)
        if (nextState.error) {
          setUrlInput(target)
          toast.error(nextState.error)
          return
        }
        setUrlInput(nextState.url || target)
      } catch (error) {
        console.error("[BrowserPanel] Navigate failed:", error)
        toast.error("页面加载失败")
      }
    },
    [sessionId, urlInput, workspacePath]
  )

  const captureScreenshot = useCallback(async () => {
    setIsCapturing(true)
    try {
      const result = await window.api.browser.captureScreenshot(sessionId)
      if (!result.success || !result.dataUrl) {
        toast.error(result.error || "截图失败")
        return
      }
      const link = document.createElement("a")
      link.href = result.dataUrl
      link.download = `cmbdevclaw-browser-${Date.now()}.png`
      link.click()
      toast.success("截图已生成")
    } catch (error) {
      console.error("[BrowserPanel] Screenshot failed:", error)
      toast.error("截图失败")
    } finally {
      setIsCapturing(false)
    }
  }, [sessionId])

  const copyConsole = useCallback(async () => {
    if (state.consoleEntries.length === 0) return
    try {
      const payload = state.consoleEntries
        .map((entry) => {
          const source = entry.sourceId ? ` ${entry.sourceId}${entry.line ? `:${entry.line}` : ""}` : ""
          return `[${formatConsoleTime(entry.timestamp)}] ${entry.level.toUpperCase()}${source} ${entry.message}`
        })
        .join("\n")
      await navigator.clipboard.writeText(payload)
      setCopiedConsole(true)
      window.setTimeout(() => {
        setCopiedConsole(false)
      }, 1500)
      toast.success("Console 内容已复制")
    } catch (error) {
      console.error("[BrowserPanel] Copy console failed:", error)
      toast.error("复制 Console 内容失败")
    }
  }, [state.consoleEntries])

  const clearConsole = useCallback(() => {
    void window.api.browser
      .clearConsole(sessionId)
      .then(setState)
      .catch((error) => {
        console.error("[BrowserPanel] Clear console failed:", error)
        toast.error("清空控制台失败")
      })
  }, [sessionId])

  const consoleCount = state.consoleEntries.length
  const latestConsoleEntry = consoleCount > 0 ? state.consoleEntries[consoleCount - 1] : null
  const consoleToggleTitle = latestConsoleEntry ? `控制台 (${consoleCount})` : "控制台"
  const toggleFullscreen = (): void => {
    setIsFullscreen((prev) => !prev)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-sm border border-border bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background-elevated px-2">
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          title="后退"
          aria-label="后退"
          disabled={!state.canGoBack}
          onClick={() => void window.api.browser.goBack(sessionId).then(setState)}
        >
          <ArrowLeft className="size-4" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          title="前进"
          aria-label="前进"
          disabled={!state.canGoForward}
          onClick={() => void window.api.browser.goForward(sessionId).then(setState)}
        >
          <ArrowRight className="size-4" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={state.isLoading ? "停止" : "刷新"}
          aria-label={state.isLoading ? "停止" : "刷新"}
          onClick={() =>
            void (
              state.isLoading
                ? window.api.browser.stop(sessionId)
                : window.api.browser.reload(sessionId)
            ).then(setState)
          }
        >
          {state.isLoading ? (
            <Square className="size-3.5" strokeWidth={2} />
          ) : (
            <RotateCcw className="size-4" strokeWidth={1.8} />
          )}
        </button>
        <form onSubmit={navigate} className="flex min-w-0 flex-1 items-center">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Globe2 className="pointer-events-none absolute left-2 size-4 text-muted-foreground/70" />
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onFocus={() => {
                isUrlFocusedRef.current = true
                setIsUrlFocused(true)
              }}
              onBlur={() => {
                isUrlFocusedRef.current = false
                setIsUrlFocused(false)
              }}
              placeholder="localhost:5173"
              className="h-8 w-full rounded-md border border-border bg-background px-8 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-status-warning/70"
            />
            {urlInput && (
              <button
                type="button"
                className="absolute right-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="清空"
                aria-label="清空"
                onClick={() => setUrlInput("")}
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            )}
          </div>
        </form>
        <button
          type="button"
          className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={consoleToggleTitle}
          aria-label={consoleToggleTitle}
          aria-pressed={consoleOpen}
          onClick={() => setConsoleOpen((open) => !open)}
        >
          <Terminal className="size-4" strokeWidth={1.8} />
          {consoleCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[9px] leading-4 text-background">
              {consoleCount > 99 ? "99+" : consoleCount}
            </span>
          )}
        </button>
        {/* 暂时隐藏“读取页面状态”动作，后续可能恢复。
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title="读取页面状态"
          aria-label="读取页面状态"
          disabled={!state.created}
          onClick={copyRenderedState}
        >
          <Code2 className="size-4" strokeWidth={1.8} />
        </button>
        */}
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title="截图"
          aria-label="截图"
          disabled={isCapturing || !state.created}
          onClick={captureScreenshot}
        >
          {isCapturing ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
          ) : (
            <Camera className="size-4" strokeWidth={1.8} />
          )}
        </button>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={isFullscreen ? "缩小全屏" : "全屏预览"}
          aria-label={isFullscreen ? "缩小全屏" : "全屏预览"}
          aria-pressed={isFullscreen}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="size-4" strokeWidth={1.8} />
          ) : (
            <Maximize2 className="size-4" strokeWidth={1.8} />
          )}
        </button>
      </div>

      {state.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <ShieldAlert className="size-4 shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 truncate">{state.error}</span>
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        {state.isLoading && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center rounded-md border border-border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            <Loader2 className="mr-1.5 size-3 animate-spin" />
            加载中
          </div>
        )}
        <div ref={viewportRef} className="absolute inset-0" />
      </div>

      {consoleOpen && (
        <div className="shrink-0 border-t border-border bg-background">
          <div className="flex h-9 items-center justify-between gap-2 px-3 text-[11px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              <Terminal className="size-3.5 shrink-0" strokeWidth={1.8} />
              <span className="font-medium text-foreground">Console</span>
              <span className="tabular-nums">{consoleCount}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                title="复制 Console 内容"
                aria-label="复制 Console 内容"
                disabled={consoleCount === 0}
                onClick={() => void copyConsole()}
              >
                {copiedConsole ? (
                  <Check className="size-3.5" strokeWidth={1.8} />
                ) : (
                  <Copy className="size-3.5" strokeWidth={1.8} />
                )}
              </button>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                title="清空控制台"
                aria-label="清空控制台"
                disabled={consoleCount === 0}
                onClick={clearConsole}
              >
                <Trash2 className="size-3.5" strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="收起控制台"
                aria-label="收起控制台"
                onClick={() => setConsoleOpen(false)}
              >
                <span>收起</span>
                <ChevronDown className="size-3.5" strokeWidth={1.8} />
              </button>
            </div>
          </div>
          <div
            ref={consoleScrollerRef}
            className="h-44 overflow-auto border-t border-border/70 bg-[#0b0f14] px-3 py-2 font-mono text-[11px] leading-5 text-slate-100"
          >
            {consoleCount === 0 ? (
              <div className="flex h-full items-center justify-center text-slate-400">
                暂无 console 输出
              </div>
            ) : (
              state.consoleEntries.map((entry) => <ConsoleRow key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatConsoleTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "--:--:--"
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
}

function getConsoleLevelClass(level: BrowserConsoleEntry["level"]): string {
  switch (level) {
    case "error":
      return "text-rose-300"
    case "warn":
      return "text-amber-300"
    case "info":
      return "text-sky-300"
    case "debug":
      return "text-violet-300"
    default:
      return "text-slate-300"
  }
}

function ConsoleRow({ entry }: { entry: BrowserConsoleEntry }): React.JSX.Element {
  const sourceLabel =
    entry.sourceId && entry.line ? `${entry.sourceId}:${entry.line}` : entry.sourceId || ""

  return (
    <div className="grid grid-cols-[64px_48px_minmax(0,1fr)] gap-3 py-1">
      <span className="text-slate-500">{formatConsoleTime(entry.timestamp)}</span>
      <span className={getConsoleLevelClass(entry.level)}>{entry.level.toUpperCase()}</span>
      <div className="min-w-0 whitespace-pre-wrap break-words text-slate-100">
        {sourceLabel && <span className="mr-2 text-slate-500">{sourceLabel}</span>}
        {entry.message}
      </div>
    </div>
  )
}

export default BrowserPanel
