import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  ChevronDown,
  Check,
  Copy,
  EyeOff,
  Globe2,
  House,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Terminal,
  Trash2,
  X
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { hasOpenModalDialog, MODAL_DIALOG_CHANGE_EVENT } from "@/lib/modal-dialog"
import { BrowserCdpConfigCard } from "./BrowserCdpConfigCard"
import {
  BROWSER_SESSION_ID,
  type BrowserBounds,
  type BrowserConsoleEntry,
  type BrowserProfileImportSkippedWebsite,
  type BrowserState
} from "../../../../shared/browser-types"

interface BrowserPanelProps {
  workspacePath?: string | null
  initialUrl?: string | null
  reloadToken?: number
  onFullscreenChange?: (isFullscreen: boolean) => void
}

const EMPTY_STATE: BrowserState = {
  sessionId: BROWSER_SESSION_ID,
  url: "",
  title: "",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  visible: false,
  created: false,
  consoleEntries: []
}
const BOUNDS_POSITION_POLL_MS = 1000
const BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME =
  "size-8 shrink-0 rounded-md transition-colors hover:bg-muted"
const BROWSER_INPUT_ICON_BUTTON_CLASSNAME = "absolute right-1 size-6 rounded"
const BROWSER_CONSOLE_ICON_BUTTON_CLASSNAME = "size-7 rounded transition-colors hover:bg-muted"

function isInitialBrowserPage(url: string): boolean {
  return !url || url === "about:blank"
}

function getBrowserAddressValue(url: string): string {
  return isInitialBrowserPage(url) ? "" : url
}

function isSameBounds(a: BrowserBounds | null, b: BrowserBounds): boolean {
  return Boolean(a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBounds(bounds: BrowserBounds | null | undefined): string {
  if (!bounds) return "(none)"
  return `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
}

function formatRect(rect: DOMRect | null | undefined): string {
  if (!rect) return "(none)"
  return `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
}

function describeBrowserState(state: BrowserState | null | undefined): string {
  if (!state) return "(none)"
  return `created=${state.created} visible=${state.visible} loading=${state.isLoading} url=${state.url || "(empty)"} title=${state.title || "(empty)"}`
}

function detectRendererZoomLevel(): number {
  const widthRatio = window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1
  const heightRatio = window.innerHeight > 0 ? window.outerHeight / window.innerHeight : 1
  const candidate = [widthRatio, heightRatio].find(
    (value) => Number.isFinite(value) && value > 0.5 && value < 3
  )
  return candidate ? Math.round(candidate * 100) / 100 : 1
}

function getLastConsoleEntryId(entries: BrowserConsoleEntry[]): string | undefined {
  return entries.length > 0 ? entries[entries.length - 1]?.id : undefined
}

function browserStatesEqual(a: BrowserState, b: BrowserState): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.url === b.url &&
    a.title === b.title &&
    a.isLoading === b.isLoading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.visible === b.visible &&
    a.created === b.created &&
    (a.error ?? "") === (b.error ?? "") &&
    a.consoleEntries.length === b.consoleEntries.length &&
    getLastConsoleEntryId(a.consoleEntries) === getLastConsoleEntryId(b.consoleEntries)
  )
}

function skippedWebsiteReasonLabel(reason: string): string {
  switch (reason) {
    case "browser_rejected":
      return "浏览器拒绝"
    case "encrypted":
      return "加密不可解"
    case "invalid":
      return "格式不合法"
    case "partitioned":
      return "分区 Cookie"
    case "too_large":
      return "内容过大"
    default:
      return reason
  }
}

function formatSkippedWebsite(site: BrowserProfileImportSkippedWebsite): string {
  const url = site.url || site.domain
  const reasons = site.reasons.map(skippedWebsiteReasonLabel).join("、")
  return `${url}（${site.skippedCookies} 条，${reasons}）`
}

function BrowserProfileImportResultPanel({
  disabled,
  importing,
  onCopy,
  onImport,
  sites,
  skippedCookieCount,
  onDismiss
}: {
  disabled: boolean
  importing: boolean
  onCopy: () => void
  onImport: () => void
  sites: BrowserProfileImportSkippedWebsite[]
  skippedCookieCount: number
  onDismiss: () => void
}): React.JSX.Element {
  const partitionedSites = sites.filter((s) => s.reasons.includes("partitioned"))
  const rejectedSites = sites.filter((s) => s.reasons.includes("browser_rejected"))
  const partitionedCount = partitionedSites.reduce((t, s) => t + s.skippedCookies, 0)
  const rejectedCount = rejectedSites.reduce((t, s) => t + s.skippedCookies, 0)

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <div className="space-y-0.5">
          <p className="text-xs font-medium text-foreground">导入结果</p>
          <p className="text-[11px] text-muted-foreground">
            跳过 Cookie {skippedCookieCount} 条，其余已成功导入
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
            复制列表
          </Button>
          <Button type="button" size="sm" disabled={disabled} onClick={onImport}>
            {importing ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <KeyRound className="size-3.5" strokeWidth={1.8} />
            )}
            重新导入
          </Button>
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onDismiss}
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="flex divide-x divide-border/70">
        {partitionedSites.length > 0 && (
          <div className="flex-1 space-y-1 px-3 py-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-foreground">跳过 · 分区 Cookie</span>
              <span className="tabular-nums text-muted-foreground">
                {partitionedSites.length} 站 {partitionedCount} 条
              </span>
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              第三方追踪类 Cookie，脱离原站点上下文无法使用。
            </p>
            <div className="max-h-32 space-y-0.5 overflow-auto rounded-sm border border-border/70 bg-muted/20 p-1.5">
              {partitionedSites.map((site) => (
                <div
                  key={`part-${site.domain}`}
                  className="flex items-center justify-between rounded-sm px-1.5 py-0.5 text-[11px] leading-4 hover:bg-background"
                >
                  <span className="min-w-0 truncate text-foreground" title={site.url || site.domain}>
                    {site.url || site.domain}
                  </span>
                  <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
                    {site.skippedCookies}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {rejectedSites.length > 0 && (
          <div className="flex-1 space-y-1 px-3 py-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-medium text-foreground">跳过 · 浏览器拒绝</span>
              <span className="tabular-nums text-muted-foreground">
                {rejectedSites.length} 站 {rejectedCount} 条
              </span>
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              Electron 内核因安全策略或格式校验不通过而拒绝写入。
            </p>
            <div className="max-h-32 space-y-0.5 overflow-auto rounded-sm border border-border/70 bg-muted/20 p-1.5">
              {rejectedSites.map((site) => (
                <div
                  key={`rej-${site.domain}`}
                  className="flex items-center justify-between rounded-sm px-1.5 py-0.5 text-[11px] leading-4 hover:bg-background"
                >
                  <span className="min-w-0 truncate text-foreground" title={site.url || site.domain}>
                    {site.url || site.domain}
                  </span>
                  <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
                    {site.skippedCookies}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function BrowserWelcomePanel(): React.JSX.Element {
  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-[radial-gradient(circle_at_12%_0%,rgba(234,179,8,0.11),transparent_34%),radial-gradient(circle_at_100%_100%,rgba(14,116,144,0.08),transparent_42%),#fcfcfb]">
      <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-6 py-8">
        <div className="mb-2">
          <div className="mb-3 flex size-12 items-center justify-center rounded-xl border border-stone-200/80 bg-white text-stone-700 shadow-[0_8px_24px_rgba(41,37,36,0.08)]">
            <Globe2 className="size-8 animate-[spin_12s_linear_infinite]" strokeWidth={1.7} />
          </div>
          <p className="text-[10px] font-semibold tracking-[0.18em] text-stone-500">
            IN-APP BROWSER
          </p>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-stone-900">
            从一个链接开始
          </h2>
          <p className="mt-2  text-xs leading-5 text-stone-600">
            在上方地址栏输入：Web Url、本地服务地址、工作区中的 HTML 文件路径，按 Enter。
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200/90 bg-white/90 shadow-[0_14px_38px_rgba(41,37,36,0.06)]">
          <div className="border-b border-stone-100 px-4 py-3">
            <p className="text-xs font-semibold text-stone-800">浏览器使用提示</p>
            <p className="mt-0.5 text-[11px] text-stone-500">
              把页面、登录态和测试流程集中到同一处。
            </p>
          </div>

          <div className="divide-y divide-stone-100">
            <div className="flex gap-3 px-4 py-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700">
                <Terminal className="size-3.5" strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-stone-800">本地开发即时预览</p>
                <p className="mt-1 text-[11px] leading-4 text-stone-500">
                  修改代码后运行{" "}
                  <code className="font-mono text-[10px] text-stone-700">npm run dev</code>
                  ，即可直接访问{" "}
                  <code className="font-mono text-[10px] text-stone-700">比如 localhost:8080</code>
                  ，AI 边写，你边看 UI 效果，无需切换到 Chrome。
                </p>
              </div>
            </div>

            <div className="flex gap-3 px-4 py-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                <Settings2 className="size-3.5" strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-stone-800">让大模型协助操作页面</p>
                <p className="mt-1 text-[11px] leading-4 text-stone-500">
                  在配置页面开启内置浏览器后，大模型即可在任务中浏览、输入、点击并验证页面结果。
                </p>
              </div>
            </div>

            <div className="flex gap-3 px-4 py-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                <KeyRound className="size-3.5" strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-stone-800">导入Chrome 数据，复用登录态</p>
                <p className="mt-1 text-[11px] leading-4 text-stone-500">
                  点击右上角钥匙图标即可导入 Chrome 登录数据。首次使用需要安装浏览器插件，
                  插件请联系开发人员获取。
                </p>
              </div>
            </div>

            <div className="flex gap-3 px-4 py-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                <Bot className="size-3.5" strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-stone-800">沉淀可复用的测试案例</p>
                <p className="mt-1 text-[11px] leading-4 text-stone-500">
                  支持 [ AI 自动录制 + 人工录制 ]
                  测试案例，方便将高频操作沉淀为后续可复用的验证流程。
                </p>
              </div>
            </div>
          </div>
        </div>

        <BrowserCdpConfigCard
          className="mt-4"
          title="内置浏览器配置"
          description="在这里手动开启内置浏览器。"
        />

        <div className="mt-4 flex items-center gap-2 text-[11px] text-stone-500">
          <span>让我们开始吧～</span>
          <span>🤪</span>
        </div>
      </div>
    </div>
  )
}

export function BrowserPanel({
  workspacePath,
  initialUrl,
  reloadToken,
  onFullscreenChange
}: BrowserPanelProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<BrowserBounds | null>(null)
  const lastBrowserViewVisibleRef = useRef<boolean | null>(null)
  const hasVisibleBoundsRef = useRef(false)
  const isSessionCreatedRef = useRef(false)
  const isInitialBrowserPageRef = useRef(true)
  const isUrlFocusedRef = useRef(false)
  const lastInitialNavigationRef = useRef<string | null>(null)
  const pendingSyncReasonRef = useRef<string | null>(null)
  const lastObservedStateRef = useRef<BrowserState | null>(null)
  const consoleScrollerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [urlInput, setUrlInput] = useState("")
  const [isUrlFocused, setIsUrlFocused] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [isResettingHome, setIsResettingHome] = useState(false)
  const [isImportingBrowserProfile, setIsImportingBrowserProfile] = useState(false)
  const [browserProfileImportSkippedWebsites, setBrowserProfileImportSkippedWebsites] = useState<
    BrowserProfileImportSkippedWebsite[]
  >([])
  const [copiedConsole, setCopiedConsole] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isHiddenByModalDialog, setIsHiddenByModalDialog] = useState(false)
  const showBrowserWelcome = isInitialBrowserPage(state.url)

  const applyBrowserState = useCallback((nextState: BrowserState) => {
    isSessionCreatedRef.current = nextState.created
    isInitialBrowserPageRef.current = isInitialBrowserPage(nextState.url)
    setState((current) => (browserStatesEqual(current, nextState) ? current : nextState))
  }, [])

  useEffect(() => {
    console.info(`[BrowserPanel] Subscribing to Browser state channel for ${BROWSER_SESSION_ID}.`)
    const unsubscribe = window.api.browser.onState((nextState) => {
      const previousState = lastObservedStateRef.current
      if (!previousState || !browserStatesEqual(previousState, nextState)) {
        console.info(
          `[BrowserPanel] State update for ${BROWSER_SESSION_ID}: prev={${describeBrowserState(previousState)}} next={${describeBrowserState(nextState)}}.`
        )
      }
      lastObservedStateRef.current = nextState
      applyBrowserState(nextState)
      if (!isUrlFocusedRef.current) {
        setUrlInput(getBrowserAddressValue(nextState.url))
      }
    })
    return () => {
      console.info(`[BrowserPanel] Unsubscribing Browser state channel for ${BROWSER_SESSION_ID}.`)
      unsubscribe()
    }
  }, [applyBrowserState])

  const syncBounds = useCallback(
    (reason: string) => {
      if (!isSessionCreatedRef.current) {
        console.info(
          `[BrowserPanel] Skip bounds sync for ${BROWSER_SESSION_ID}; reason=${reason}; session not created.`
        )
        return
      }
      const element = viewportRef.current
      if (!element) {
        console.info(
          `[BrowserPanel] Skip bounds sync for ${BROWSER_SESSION_ID}; reason=${reason}; viewport missing.`
        )
        return
      }
      const rect = element.getBoundingClientRect()
      const zoomLevel = detectRendererZoomLevel()
      const bounds: BrowserBounds = {
        x: Math.round(rect.left * zoomLevel),
        y: Math.round(rect.top * zoomLevel),
        width: Math.round(rect.width * zoomLevel),
        height: Math.round(rect.height * zoomLevel)
      }
      const layoutVisible = rect.width >= 8 && rect.height >= 8
      const modalDialogOpen = hasOpenModalDialog()
      const initialBrowserPage = isInitialBrowserPageRef.current
      const visible = layoutVisible && !modalDialogOpen && !initialBrowserPage
      if (!layoutVisible && hasVisibleBoundsRef.current) {
        console.info(
          `[BrowserPanel] Skip bounds sync for ${BROWSER_SESSION_ID}; reason=${reason}; viewport hidden after first visible; rect=${formatRect(rect)} zoom=${zoomLevel} lastBounds=${formatBounds(lastBoundsRef.current)}.`
        )
        return
      }
      if (
        isSameBounds(lastBoundsRef.current, bounds) &&
        lastBrowserViewVisibleRef.current === visible
      ) {
        return
      }
      const previousBounds = lastBoundsRef.current
      const previousVisible = lastBrowserViewVisibleRef.current
      lastBoundsRef.current = bounds
      lastBrowserViewVisibleRef.current = visible
      if (layoutVisible) hasVisibleBoundsRef.current = true
      console.info(
        `[BrowserPanel] Syncing bounds for ${BROWSER_SESSION_ID}; reason=${reason}; rect=${formatRect(rect)} zoom=${zoomLevel} nextBounds=${formatBounds(bounds)} nextVisible=${visible} modalDialogOpen=${modalDialogOpen} initialBrowserPage=${initialBrowserPage} prevBounds=${formatBounds(previousBounds)} prevVisible=${previousVisible ?? "(none)"} hasVisibleOnce=${hasVisibleBoundsRef.current}.`
      )
      void window.api.browser
        .setBounds(bounds, visible)
        .then(applyBrowserState)
        .catch((error) => {
          console.error(`[BrowserPanel] Bounds sync failed: ${formatError(error)}`)
        })
    },
    [applyBrowserState]
  )

  useEffect(() => {
    let cancelled = false
    let frame: number | null = null
    const timers: number[] = []

    const scheduleSync = (reason: string): void => {
      pendingSyncReasonRef.current = pendingSyncReasonRef.current
        ? `${pendingSyncReasonRef.current},${reason}`
        : reason
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        const nextReason = pendingSyncReasonRef.current || "raf"
        pendingSyncReasonRef.current = null
        if (!cancelled) syncBounds(nextReason)
      })
    }

    const scheduleStabilizedSync = (): void => {
      scheduleSync("attach:raf")
      for (const delay of [50, 150, 300, 600, 1000]) {
        timers.push(window.setTimeout(() => scheduleSync(`attach:${delay}ms`), delay))
      }
    }

    console.info(
      `[BrowserPanel] Mounting BrowserPanel for ${BROWSER_SESSION_ID}; workspacePath=${workspacePath || "(none)"} initialUrl=${initialUrl || "(none)"} reloadToken=${reloadToken ?? "(none)"}.`
    )
    console.info(`[BrowserPanel] Attaching Browser session ${BROWSER_SESSION_ID}.`)
    window.api.browser
      .attach({ workspacePath, visible: false })
      .then((nextState) => {
        if (cancelled) return
        applyBrowserState(nextState)
        if (!isUrlFocusedRef.current) setUrlInput(getBrowserAddressValue(nextState.url))
        scheduleStabilizedSync()
        console.info(
          `[BrowserPanel] Browser session ${BROWSER_SESSION_ID} attached with state={${describeBrowserState(nextState)}}.`
        )
      })
      .catch((error) => {
        console.error(`[BrowserPanel] Browser attach failed: ${formatError(error)}`)
        toast.error("内置浏览器启动失败")
      })

    const observer = new ResizeObserver(() => scheduleSync("resize-observer"))
    const handleResize = (): void => scheduleSync("window-resize")
    const handleScroll = (): void => scheduleSync("window-scroll")
    if (viewportRef.current) observer.observe(viewportRef.current)
    window.addEventListener("resize", handleResize)
    window.addEventListener("scroll", handleScroll, true)

    return () => {
      console.info(
        `[BrowserPanel] Unmounting BrowserPanel for ${BROWSER_SESSION_ID}; lastBounds=${formatBounds(lastBoundsRef.current)} lastVisible=${lastBrowserViewVisibleRef.current ?? "(none)"} localState={${describeBrowserState(lastObservedStateRef.current)}}.`
      )
      cancelled = true
      for (const timer of timers) window.clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("scroll", handleScroll, true)
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [applyBrowserState, initialUrl, reloadToken, syncBounds, workspacePath])

  useEffect(() => {
    if (!state.created) return
    const frame = window.requestAnimationFrame(() => syncBounds("state-change:raf"))
    const timer = window.setTimeout(() => syncBounds("state-change:120ms"), 120)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [consoleOpen, isFullscreen, state.created, state.isLoading, state.url, syncBounds])

  useEffect(() => {
    if (!state.created) return
    // ResizeObserver misses pure position shifts, but BrowserView bounds are window-relative.
    const interval = window.setInterval(() => syncBounds("position-poll"), BOUNDS_POSITION_POLL_MS)
    return () => {
      window.clearInterval(interval)
    }
  }, [state.created, syncBounds])

  useEffect(() => {
    const handleModalDialogChange = (): void => {
      setIsHiddenByModalDialog(hasOpenModalDialog())
      syncBounds("modal-dialog-change")
    }
    handleModalDialogChange()
    window.addEventListener(MODAL_DIALOG_CHANGE_EVENT, handleModalDialogChange)
    return () => {
      window.removeEventListener(MODAL_DIALOG_CHANGE_EVENT, handleModalDialogChange)
    }
  }, [syncBounds])

  useEffect(() => {
    if (!isUrlFocused) {
      setUrlInput(getBrowserAddressValue(state.url))
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

    console.info(`[BrowserPanel] Opening initial URL ${target}.`)
    window.api.browser
      .navigate(target, { workspacePath })
      .then((nextState) => {
        applyBrowserState(nextState)
        if (nextState.error) {
          setUrlInput(target)
          toast.error(nextState.error)
          return
        }
        if (!isUrlFocusedRef.current) {
          setUrlInput(nextState.url || target)
        }
        console.info(`[BrowserPanel] Initial URL opened as ${nextState.url || target}.`)
      })
      .catch((error) => {
        console.error(`[BrowserPanel] Initial URL open failed: ${formatError(error)}`)
        toast.error("HTML 预览加载失败")
      })
  }, [applyBrowserState, initialUrl, reloadToken, workspacePath])

  const navigate = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault()
      const target = urlInput.trim()
      if (!target) return
      try {
        const nextState = await window.api.browser.navigate(target, { workspacePath })
        applyBrowserState(nextState)
        if (nextState.error) {
          setUrlInput(target)
          toast.error(nextState.error)
          return
        }
        setUrlInput(nextState.url || target)
        console.info(`[BrowserPanel] Navigated to ${nextState.url || target}.`)
      } catch (error) {
        console.error(`[BrowserPanel] Navigation failed: ${formatError(error)}`)
        toast.error("页面加载失败")
      }
    },
    [applyBrowserState, urlInput, workspacePath]
  )

  const resetToHome = useCallback(async () => {
    setIsResettingHome(true)
    try {
      await window.api.browser.detach()
      const nextState = await window.api.browser.attach({ workspacePath, visible: false })
      applyBrowserState(nextState)
      setUrlInput("")
      setBrowserProfileImportSkippedWebsites([])
      setCopiedConsole(false)
      setConsoleOpen(false)
    } catch (error) {
      console.error(`[BrowserPanel] Return home failed: ${formatError(error)}`)
      toast.error("返回欢迎页失败")
    } finally {
      setIsResettingHome(false)
    }
  }, [applyBrowserState, workspacePath])

  const captureScreenshot = useCallback(async () => {
    setIsCapturing(true)
    try {
      const result = await window.api.browser.captureScreenshot()
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
      console.error(`[BrowserPanel] Screenshot failed: ${formatError(error)}`)
      toast.error("截图失败")
    } finally {
      setIsCapturing(false)
    }
  }, [])

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
      console.error(`[BrowserPanel] Copy console failed: ${formatError(error)}`)
      toast.error("复制 Console 内容失败")
    }
  }, [state.consoleEntries])

  const clearConsole = useCallback(() => {
    void window.api.browser
      .clearConsole()
      .then(applyBrowserState)
      .catch((error) => {
        console.error(`[BrowserPanel] Clear console failed: ${formatError(error)}`)
        toast.error("清空控制台失败")
      })
  }, [applyBrowserState])

  const importBrowserProfileData = useCallback(async () => {
    if (!state.created) return

    setIsImportingBrowserProfile(true)
    try {
      const result = await window.api.browser.importProfileData({
        sourceBrowser: "chrome",
        importCookies: true
      })
      if (!result.success) {
        setBrowserProfileImportSkippedWebsites([])
        if (result.cancelled) return
        if (result.errorCode === "native_host_not_registered") {
          toast.error(result.error || "Chrome Native Messaging Host 尚未注册，请重启应用", {
            duration: 15_000
          })
        } else if (result.errorCode === "extension_not_connected") {
          const extensionIdHint = result.extensionId ? `；预期扩展 ID：${result.extensionId}` : ""
          toast.error(
            `Chrome 扩展未连接，请确认扩展已安装并启用，且 Chrome 正在运行${extensionIdHint}`,
            { duration: 15_000 }
          )
        } else if (result.errorCode === "permission_required") {
          toast.error("请在 CmbCoworkAgent Chrome 扩展中授权网站 Cookie 访问", {
            duration: 15_000
          })
        } else {
          toast.error(result.error || "浏览器数据导入失败", { duration: 15_000 })
        }
        return
      }

      applyBrowserState(await window.api.browser.getState())
      const skippedWebsites = result.skippedWebsites ?? []
      setBrowserProfileImportSkippedWebsites(skippedWebsites)
      const importedCookies = result.importedCookies ?? 0
      const importedLocalStorage = result.importedLocalStorage ?? 0
      const skipped = (result.skippedCookies ?? 0) + (result.skippedLocalStorage ?? 0)
      const summary = `导入 Cookie ${importedCookies} 条，localStorage ${importedLocalStorage} 条`
      const profileLabel = result.profileDirectory ? `（${result.profileDirectory}）` : ""
      const message = skipped > 0 ? `${summary}${profileLabel}，跳过 ${skipped} 条` : `${summary}${profileLabel}`
      if (skippedWebsites.length > 0) {
        const fullList = skippedWebsites.map(formatSkippedWebsite).join("\n")
        console.info(`[BrowserPanel] Browser profile import skipped websites:\n${fullList}`)
      }
      if (result.warning) {
        toast.warning(`${result.warning}（${message}）`, { duration: 12_000 })
      } else {
        toast.success(message, { duration: 10_000 })
      }
    } catch (error) {
      console.error(`[BrowserPanel] Browser profile import failed: ${formatError(error)}`)
      toast.error("浏览器数据导入失败", { duration: 15_000 })
    } finally {
      setIsImportingBrowserProfile(false)
    }
  }, [applyBrowserState, state.created])

  const consoleCount = state.consoleEntries.length
  const latestConsoleEntry = consoleCount > 0 ? state.consoleEntries[consoleCount - 1] : null
  const consoleToggleTitle = latestConsoleEntry ? `控制台 (${consoleCount})` : "控制台"
  const browserProfileImportDisabled = isImportingBrowserProfile || !state.created
  const hasBrowserProfileImportSkippedWebsites = browserProfileImportSkippedWebsites.length > 0
  const browserProfileImportSkippedCookieCount = browserProfileImportSkippedWebsites.reduce(
    (total, site) => total + site.skippedCookies,
    0
  )
  const copyBrowserProfileImportSkippedWebsites = useCallback(() => {
    if (browserProfileImportSkippedWebsites.length === 0) return
    const text = browserProfileImportSkippedWebsites.map(formatSkippedWebsite).join("\n")
    void navigator.clipboard.writeText(text).then(() => {
      toast.success("失败站点列表已复制")
    })
  }, [browserProfileImportSkippedWebsites])
  const toggleFullscreen = (): void => {
    setIsFullscreen((prev) => !prev)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background-elevated px-2">
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          icon={<ArrowLeft className="size-4" strokeWidth={1.8} />}
          popoverContent="后退"
          aria-label="后退"
          disabled={!state.canGoBack}
          onClick={() => void window.api.browser.goBack().then(applyBrowserState)}
        />
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          icon={<ArrowRight className="size-4" strokeWidth={1.8} />}
          popoverContent="前进"
          aria-label="前进"
          disabled={!state.canGoForward}
          onClick={() => void window.api.browser.goForward().then(applyBrowserState)}
        />
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          icon={
            state.isLoading ? (
              <RotateCcw className="size-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <RotateCcw className="size-4" strokeWidth={1.8} />
            )
          }
          popoverContent={state.isLoading ? "停止" : "刷新"}
          aria-label={state.isLoading ? "停止" : "刷新"}
          onClick={() =>
            void (state.isLoading ? window.api.browser.stop() : window.api.browser.reload()).then(
              applyBrowserState
            )
          }
        />
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
              <IconPopoverButton
                className={BROWSER_INPUT_ICON_BUTTON_CLASSNAME}
                icon={<X className="size-3.5" strokeWidth={2} />}
                popoverContent="清空"
                aria-label="清空"
                onClick={() => setUrlInput("")}
              />
            )}
          </div>
        </form>
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
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          icon={
            isImportingBrowserProfile ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <KeyRound className="size-4" strokeWidth={1.8} />
            )
          }
          popoverContent="导入浏览器数据"
          aria-label="导入浏览器数据"
          disabled={browserProfileImportDisabled}
          onClick={() => void importBrowserProfileData()}
        />
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          icon={
            isFullscreen ? (
              <Minimize2 className="size-4" strokeWidth={1.8} />
            ) : (
              <Maximize2 className="size-4" strokeWidth={1.8} />
            )
          }
          popoverContent={isFullscreen ? "缩小全屏" : "全屏预览"}
          aria-label={isFullscreen ? "缩小全屏" : "全屏预览"}
          aria-pressed={isFullscreen}
          onClick={toggleFullscreen}
        />
      </div>

      {state.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <ShieldAlert className="size-4 shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 truncate">{state.error}</span>
        </div>
      )}

      {hasBrowserProfileImportSkippedWebsites && (
        <BrowserProfileImportResultPanel
          disabled={browserProfileImportDisabled}
          importing={isImportingBrowserProfile}
          onCopy={copyBrowserProfileImportSkippedWebsites}
          onImport={() => void importBrowserProfileData()}
          sites={browserProfileImportSkippedWebsites}
          skippedCookieCount={browserProfileImportSkippedCookieCount}
          onDismiss={() => setBrowserProfileImportSkippedWebsites([])}
        />
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        {/* Keep the welcome panel mounted so any dialogs launched from it are not
            immediately unmounted by the BrowserView modal-hide guard. */}
        {showBrowserWelcome && <BrowserWelcomePanel />}
        {isHiddenByModalDialog && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[radial-gradient(circle_at_top,#f5f5f4,transparent_58%),linear-gradient(135deg,#fafaf9,#f5f5f4)] p-6">
            <div className="max-w-xs text-center">
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm">
                <EyeOff className="size-4" strokeWidth={1.8} />
              </div>
              <p className="text-sm font-medium text-stone-800">浏览器已暂时隐藏</p>
              <p className="mt-1.5 text-xs leading-5 text-stone-500">
                为确保当前弹窗完整显示，内置浏览器会在关闭弹窗后自动恢复。
              </p>
            </div>
          </div>
        )}
        {state.isLoading && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center rounded-md border border-border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            <Loader2 className="mr-1.5 size-3 animate-spin" />
            加载中
          </div>
        )}
        <div ref={viewportRef} className="pointer-events-none absolute inset-0" />
      </div>

      <div className="flex shrink-0 items-center justify-start gap-2 border-t border-border bg-background-elevated px-2 py-2">
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          side="left"
          icon={
            isResettingHome ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <House className="size-4" strokeWidth={1.8} />
            )
          }
          popoverContent="回到首页"
          aria-label="Home"
          disabled={isResettingHome}
          onClick={() => void resetToHome()}
        />
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          side="left"
          icon={
            <div className="relative">
              <Terminal className="size-4" strokeWidth={1.8} />
              {consoleCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[9px] leading-4 text-background">
                  {consoleCount > 99 ? "99+" : consoleCount}
                </span>
              )}
            </div>
          }
          popoverContent={consoleToggleTitle}
          aria-label={consoleToggleTitle}
          aria-pressed={consoleOpen}
          onClick={() => setConsoleOpen((open) => !open)}
        />
        <IconPopoverButton
          className={BROWSER_TOOLBAR_ICON_BUTTON_CLASSNAME}
          side="left"
          icon={
            isCapturing ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <Camera className="size-4" strokeWidth={1.8} />
            )
          }
          popoverContent="截图"
          aria-label="截图"
          disabled={isCapturing || !state.created}
          onClick={captureScreenshot}
        />
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
              <IconPopoverButton
                className={BROWSER_CONSOLE_ICON_BUTTON_CLASSNAME}
                side="bottom"
                icon={
                  copiedConsole ? (
                    <Check className="size-3.5" strokeWidth={1.8} />
                  ) : (
                    <Copy className="size-3.5" strokeWidth={1.8} />
                  )
                }
                popoverContent="复制 Console 内容"
                aria-label="复制 Console 内容"
                disabled={consoleCount === 0}
                onClick={() => void copyConsole()}
              />
              <IconPopoverButton
                className={BROWSER_CONSOLE_ICON_BUTTON_CLASSNAME}
                side="bottom"
                icon={<Trash2 className="size-3.5" strokeWidth={1.8} />}
                popoverContent="清空控制台"
                aria-label="清空控制台"
                disabled={consoleCount === 0}
                onClick={clearConsole}
              />
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
