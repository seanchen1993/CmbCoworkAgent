import type { BotTeachArm } from "../../../../shared/bot-teach"
import { FocusScope } from "@radix-ui/react-focus-scope"
import { hideOthers } from "aria-hidden"
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react"
import { Maximize2, Minimize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GrokPanelResizeHandle } from "./upstream/grok-panel-resize-handle"

const panelWidthKey = "cmb-bot-computer-width"
function savedPanelWidth(): number {
  try {
    const value = Number(localStorage.getItem(panelWidthKey))
    if (Number.isFinite(value) && value >= 360 && value <= 1400) return value
  } catch {
    /* Layout remains usable without local storage. */
  }
  return 520
}

/** Shared geometry for Bot and group details, including the existing computer layout preference. */
export function BotInspectorPanel({
  name,
  tab,
  close,
  expandRequest,
  initialExpanded = false,
  covered = false,
  subview = false,
  onExitAutoFocus,
  onFullScreenExitAutoFocus,
  children
}: {
  name: string
  tab: string
  close(): void
  expandRequest?: BotTeachArm | null
  initialExpanded?: boolean
  covered?: boolean
  subview?: boolean
  onExitAutoFocus?(): void
  onFullScreenExitAutoFocus?(): void
  children(expanded: boolean, expand: () => void): ReactNode
}) {
  const panel = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(savedPanelWidth)
  const widthRef = useRef(width)
  const [maxWidth, setMaxWidth] = useState(820)
  const [presentation, setPresentation] = useState(() => ({
    expanded: initialExpanded || Boolean(expandRequest && tab === "computer"),
    request: expandRequest
  }))
  const { expanded } = presentation
  // Keep the existing presentation state while acknowledging a new preparation.
  // Clearing an accepted arm leaves fullscreen unchanged; exiting it is explicit.
  if (presentation.request !== expandRequest) {
    setPresentation({
      request: expandRequest,
      expanded: expandRequest && tab === "computer" ? true : expanded
    })
  }
  const setExpanded = (value: boolean): void => {
    setPresentation((current) => ({ ...current, expanded: value }))
  }
  const titleId = useId()
  const exit = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const fullScreenExitFocus = useRef(onFullScreenExitAutoFocus)
  useLayoutEffect(() => {
    fullScreenExitFocus.current = onFullScreenExitAutoFocus
  })
  const presentedExpanded = expanded && !subview
  const fullScreen = tab === "computer" && presentedExpanded && !covered
  // Keep the viewer and Teach DOM mounted: only its presentation becomes modal.
  // Radix shares the focus-scope stack with nested transfer dialogs/popovers.
  useLayoutEffect(() => {
    const surface = panel.current
    if (!fullScreen || !surface) return
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    return hideOthers(surface)
  }, [fullScreen])
  useEffect(() => {
    // The inner Radix trap must observe this first focus so a later outside
    // focus has a valid in-scope return target, including before any frame.
    if (!fullScreen) return
    const exitButton = exit.current
    exitButton?.focus({ preventScroll: true })
    const surface = panel.current
    const trigger = returnFocus.current
    const fallback = fullScreenExitFocus.current
    return () => {
      // Restore only after the inner focus trap has removed its listeners.
      // A separate popup/window may already own focus; do not steal it.
      const focused = document.activeElement
      if (focused !== document.body && !surface?.contains(focused)) return
      if (trigger?.isConnected && trigger.getClientRects().length)
        trigger.focus({ preventScroll: true })
      else if (fallback) fallback()
      else exitButton?.focus({ preventScroll: true })
    }
  }, [fullScreen])
  useEffect(() => {
    const container = panel.current?.parentElement
    if (!container) return
    const observer = new ResizeObserver(([entry]) => {
      const sidebar = container.querySelector(".bot-sidebar")?.getBoundingClientRect().width ?? 264
      setMaxWidth(Math.max(360, Math.min(1400, entry.contentRect.width - sidebar - 360)))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  const computer = tab === "computer"
  const kind = tab === "routine" ? "例程详情" : computer ? "电脑" : "详情"
  return (
    <FocusScope
      asChild
      trapped={fullScreen}
      loop={fullScreen}
      onMountAutoFocus={(event) => event.preventDefault()}
      onUnmountAutoFocus={(event) => {
        event.preventDefault()
        onExitAutoFocus?.()
      }}
    >
      <section
        ref={panel}
        className="bot-computer-panel bot-inspector-panel flex h-full min-h-0 flex-col border-l"
        style={
          {
            "--bot-computer-width": `${Math.min(width, maxWidth)}px`
          } as CSSProperties
        }
        data-expanded={presentedExpanded || undefined}
        data-fullscreen={fullScreen || undefined}
        role={fullScreen ? "dialog" : "complementary"}
        aria-modal={fullScreen || undefined}
        aria-labelledby={fullScreen ? titleId : undefined}
        data-tab={tab}
        aria-label={`${name} 的${kind}`}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            presentedExpanded &&
            !event.defaultPrevented &&
            (!(event.target instanceof Element) ||
              !event.target.closest('[role="dialog"]') ||
              event.target.closest('[role="dialog"]') === panel.current)
          ) {
            event.preventDefault()
            event.stopPropagation()
            setExpanded(false)
          }
        }}
      >
        {!presentedExpanded && (
          <GrokPanelResizeHandle
            width={Math.min(width, maxWidth)}
            min={360}
            max={maxWidth}
            onResize={(value) => {
              widthRef.current = value
              setWidth(value)
            }}
            onResizeEnd={() => {
              try {
                localStorage.setItem(panelWidthKey, String(widthRef.current))
              } catch {
                /* Keep live layout. */
              }
            }}
          />
        )}
        {!subview && (
          <header className="flex shrink-0 items-center gap-2 px-4">
            <span id={titleId} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {fullScreen ? `${name} 的电脑` : computer ? "电脑" : "对话详情"}
            </span>
            <Button
              size="icon"
              variant="ghost"
              ref={exit}
              aria-label={fullScreen ? "退出电脑全屏" : `${expanded ? "还原" : "展开"}${kind}面板`}
              title={fullScreen ? "退出全屏" : expanded ? "还原面板" : "展开面板"}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </Button>
            {!fullScreen && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={`关闭${kind}面板`}
                title="关闭面板"
                onClick={close}
              >
                <X size={16} />
              </Button>
            )}
          </header>
        )}
        {children(expanded, () => setExpanded(true))}
      </section>
    </FocusScope>
  )
}
