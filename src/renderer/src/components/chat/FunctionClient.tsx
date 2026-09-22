import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type {
  FunctionClientSnapshot,
  FunctionClientAction,
  FunctionUiAction,
  FunctionUiElement
} from "../../../../shared/mods/v2/ui"
import type { ModJson, ModObject } from "../../../../shared/mods/types"

type Control = (
  node: FunctionUiElement | undefined,
  kind: FunctionUiAction["kind"],
  value?: string
) => Promise<void>

/** The renderer interprets data only. Client JavaScript stays in the utility process. */
export function FunctionClient({
  threadId,
  pane,
  node,
  snapshot,
  refresh,
  render
}: {
  threadId: string
  pane: string
  node: FunctionUiElement
  snapshot: FunctionClientSnapshot
  refresh(): void
  render(tree: FunctionUiElement, busy: boolean, act: Control): ReactNode
}) {
  const region = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const previousFocus = useRef<HTMLElement | null>(null)
  const moveFrame = useRef(0)
  const moveValue = useRef<ModObject | undefined>(undefined)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelAnimationFrame(moveFrame.current)
    }
  }, [])
  const send = useCallback(
    async (kind: FunctionClientAction["kind"], value?: ModJson, handle?: number) => {
      await window.api.mods.clientAct(threadId, {
        pane,
        instance: snapshot.id,
        intentId: crypto.randomUUID(),
        kind,
        ...(value === undefined ? {} : { value }),
        ...(handle === undefined ? {} : { handle })
      })
      if (mounted.current && ["press", "submit", "select"].includes(kind)) refreshRef.current()
    },
    [threadId, pane, snapshot.id]
  )
  useEffect(() => {
    const element = region.current
    if (!element || snapshot.error) return
    let frame = 0,
      last = ""
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        const size = {
          columns: Math.min(10000, Math.max(0, Math.floor(rect.width / 8))),
          rows: Math.min(10000, Math.max(0, Math.floor(rect.height / 24)))
        }
        const key = JSON.stringify(size)
        if (key === last) return
        last = key
        void send("resize", size).catch(() => {})
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [send, snapshot.error])
  const control: Control = async (control, kind, value) => {
    if (kind === "close" || !control?.press) return
    if (kind !== "change") setBusy(true)
    setError("")
    try {
      await send(kind, value, control.press.handle)
    } catch {
      if (mounted.current) setError("组件已更新或停止，请在当前画面重试。")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const pointer = (event: React.PointerEvent<HTMLDivElement>, type: string): void => {
    if (
      snapshot.error ||
      (event.target instanceof HTMLElement && event.target.closest("button,input,select,a"))
    )
      return
    if (type === "down") {
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const value: ModObject = {
      type,
      x: Math.floor((event.clientX - rect.left) / 8),
      y: Math.floor((event.clientY - rect.top) / 24),
      ...(event.shiftKey ? { shift: true } : {}),
      ...(event.altKey ? { alt: true } : {}),
      ...(event.ctrlKey ? { ctrl: true } : {})
    }
    if (type === "down" || type === "up" || event.buttons)
      value.button = event.button === 1 ? "middle" : event.button === 2 ? "right" : "left"
    if (type === "move") {
      moveValue.current = value
      if (!moveFrame.current)
        moveFrame.current = requestAnimationFrame(() => {
          moveFrame.current = 0
          const latest = moveValue.current
          if (latest) void send("pointer", latest).catch(() => {})
        })
    } else {
      cancelAnimationFrame(moveFrame.current)
      moveFrame.current = 0
      moveValue.current = undefined
      void send("pointer", value).catch(() => {})
    }
    if (type === "up" && event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const dimension = (value: ModJson | undefined, unit: string): string | undefined =>
    typeof value === "number" ? `${value}${unit}` : typeof value === "string" ? value : undefined
  return (
    <div
      ref={region}
      data-function-client={snapshot.element}
      tabIndex={0}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return
        if (
          event.relatedTarget instanceof HTMLElement &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          previousFocus.current = event.relatedTarget
        void send("focus", { focused: true }).catch(() => {})
      }}
      onBlur={(event) => {
        if (event.target !== event.currentTarget) return
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return
        void send("focus", { focused: false }).catch(() => {})
      }}
      className="min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{
        width: dimension(node.props.width, "ch"),
        height: dimension(node.props.height, "lh"),
        flexGrow: typeof node.props.flexGrow === "number" ? node.props.flexGrow : undefined
      }}
      onPointerDown={(e) => pointer(e, "down")}
      onPointerMove={(e) => pointer(e, "move")}
      onPointerUp={(e) => pointer(e, "up")}
      onPointerEnter={(e) => pointer(e, "enter")}
      onPointerLeave={(e) => pointer(e, "leave")}
      onWheel={(event) => {
        if (snapshot.error) return
        const clamp = (value: number): number =>
          Number.isFinite(value) ? Math.max(-100000, Math.min(100000, value)) : 0
        void send("scroll", {
          deltaX: clamp(event.deltaX),
          deltaY: clamp(event.deltaY),
          top: clamp(event.currentTarget.scrollTop),
          left: clamp(event.currentTarget.scrollLeft)
        }).catch(() => {})
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          if (event.target instanceof HTMLElement) event.target.blur()
          event.currentTarget.blur()
          if (previousFocus.current?.isConnected) previousFocus.current.focus()
          return
        }
        if (event.target !== event.currentTarget || snapshot.error) return
        const names: Record<string, string> = {
          ArrowUp: "up",
          ArrowDown: "down",
          ArrowLeft: "left",
          ArrowRight: "right",
          Enter: "return",
          Tab: "tab",
          Backspace: "backspace",
          Delete: "delete",
          PageUp: "pageup",
          PageDown: "pagedown",
          Home: "home",
          End: "end"
        }
        const key = names[event.key] ?? event.key
        if (key.length > 32) return
        if (event.key !== "Tab") event.preventDefault()
        event.stopPropagation()
        void send("key", {
          key,
          ...(event.ctrlKey ? { ctrl: true } : {}),
          ...(event.shiftKey ? { shift: true } : {}),
          ...(event.metaKey ? { meta: true } : {})
        }).catch(() => {})
      }}
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {render(snapshot.tree, busy, control)}
    </div>
  )
}
