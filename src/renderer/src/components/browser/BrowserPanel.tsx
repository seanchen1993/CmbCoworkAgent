import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Code2,
  Globe2,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Square,
  X
} from "lucide-react"
import { toast } from "sonner"
import type { BrowserBounds, BrowserState } from "../../../../shared/browser-types"

interface BrowserPanelProps {
  threadId?: string | null
  workspacePath?: string | null
  initialUrl?: string | null
  reloadToken?: number
}

const EMPTY_STATE: BrowserState = {
  sessionId: "",
  url: "",
  title: "",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  visible: false,
  created: false
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
  reloadToken
}: BrowserPanelProps): React.JSX.Element {
  const sessionId = useMemo(() => getSessionId(threadId), [threadId])
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<BrowserBounds | null>(null)
  const isUrlFocusedRef = useRef(false)
  const lastInitialNavigationRef = useRef<string | null>(null)
  const [state, setState] = useState<BrowserState>({ ...EMPTY_STATE, sessionId })
  const [urlInput, setUrlInput] = useState("")
  const [isUrlFocused, setIsUrlFocused] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [isReading, setIsReading] = useState(false)

  useEffect(() => {
    setState({ ...EMPTY_STATE, sessionId })
    setUrlInput("")
    lastBoundsRef.current = null
    lastInitialNavigationRef.current = null
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
    const target = initialUrl?.trim()
    if (!target) return

    const key = `${target}:${reloadToken ?? 0}:${workspacePath ?? ""}`
    if (lastInitialNavigationRef.current === key) return
    lastInitialNavigationRef.current = key

    window.api.browser
      .navigate(sessionId, target, { workspacePath })
      .then((nextState) => {
        setState(nextState)
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

  const copyRenderedState = useCallback(async () => {
    setIsReading(true)
    try {
      const result = await window.api.browser.readRenderedState(sessionId, false)
      if (!result.success || !result.state) {
        toast.error(result.error || "读取页面状态失败")
        return
      }
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            url: result.state.url,
            title: result.state.title,
            text: result.state.text,
            truncated: result.state.truncated
          },
          null,
          2
        )
      )
      toast.success("页面状态已复制")
    } catch (error) {
      console.error("[BrowserPanel] Read rendered state failed:", error)
      toast.error("读取页面状态失败")
    } finally {
      setIsReading(false)
    }
  }, [sessionId])

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
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title="读取页面状态"
          aria-label="读取页面状态"
          disabled={isReading || !state.created}
          onClick={copyRenderedState}
        >
          {isReading ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
          ) : (
            <Code2 className="size-4" strokeWidth={1.8} />
          )}
        </button>
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
    </div>
  )
}

export default BrowserPanel
