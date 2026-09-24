import { useEffect, useRef, useState, type ReactNode } from "react"
import type { ModJson, ModObject } from "../../../../shared/mods/types"
import {
  functionQuestionPresentation,
  validateFunctionSiteTree,
  type FunctionUiSite
} from "../../../../shared/mods/v2/sites"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionUiElement
} from "../../../../shared/mods/v2/ui"
import { Element } from "./FunctionPanes"
import { paneFocusElement } from "../../lib/function-pane-focus"
import { functionFocusTargets } from "../../../../shared/mods/v2/focus"
import { FunctionSiteLifetime, type FunctionSiteTicket } from "../../lib/function-site-lifecycle"
import { functionSiteQueue } from "../../lib/function-site-queue"

type Act = (
  node: FunctionUiElement | undefined,
  kind: FunctionUiAction["kind"],
  value?: ModJson
) => Promise<void>

export function FunctionSiteContent({
  snapshot,
  fallback,
  busy,
  act
}: {
  snapshot: FunctionPaneSnapshot | null
  fallback: ReactNode
  busy: boolean
  act: Act
}): ReactNode {
  if (!snapshot || snapshot.nativeFallback) return fallback
  validateFunctionSiteTree(snapshot.tree)
  return <Element node={snapshot.tree} busy={busy} act={act} />
}

/** A mounted desktop slot. The main process issues its drawing owner token. */
export function FunctionSite({
  threadId,
  component,
  facts,
  fallback,
  onHint,
  onCustom,
  onExpansion,
  onQuestions,
  className
}: {
  threadId: string
  component: FunctionUiSite
  facts: ModObject
  fallback?: ReactNode
  onHint?(text: string | null): void
  onCustom?(custom: boolean): void
  onExpansion?(expanded: boolean): void
  onQuestions?(questions: FunctionPaneSnapshot["nativeQuestions"] | null): void
  className?: string
}): React.JSX.Element {
  const [frame, setFrame] = useState<{
    snapshot: FunctionPaneSnapshot
    ticket: FunctionSiteTicket
  } | null>(null)
  const snapshot = frame?.snapshot ?? null
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [geometry, setGeometry] = useState({ bodyColumns: 80, maxRows: 8, offset: 0 })
  const section = useRef<HTMLElement>(null)
  const ownerRef = useRef<string | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const input = component === "AbovePrompt" ? { ...facts, ...geometry } : facts
  const inputKey = JSON.stringify(input)
  const inputRef = useRef(input)
  inputRef.current = input
  const refreshRef = useRef<() => void>(() => {})
  const live = useRef(false)
  const lifetimeRef = useRef<FunctionSiteLifetime | null>(null)
  const applyingFocus = useRef(false)
  const pending = useRef(0)
  const hint =
    component === "PromptHint" &&
    snapshot?.tree.type === "Text" &&
    snapshot.tree.children?.every((child) => typeof child === "string")
      ? snapshot.tree.children.join("")
      : null
  useEffect(() => {
    let questions: FunctionPaneSnapshot["nativeQuestions"] | null = null
    if (
      frame?.ticket.current() &&
      frame.snapshot.nativeFallback &&
      frame.snapshot.nativeQuestions
    ) {
      try {
        questions = functionQuestionPresentation(
          inputRef.current.questions,
          frame.snapshot.nativeQuestions
        )
      } catch {
        /* Invalid or obsolete presentation cannot change the native dialog. */
      }
    }
    onQuestions?.(questions)
    return () => onQuestions?.(null)
  }, [onQuestions, frame, inputKey])
  useEffect(() => {
    onExpansion?.(
      Boolean(
        frame?.ticket.current() && frame.snapshot.nativeFallback && frame.snapshot.nativeExpansion
      )
    )
    return () => onExpansion?.(false)
  }, [onExpansion, frame])
  useEffect(() => {
    onCustom?.(Boolean(frame?.ticket.current() && !frame.snapshot.nativeFallback))
    return () => onCustom?.(false)
  }, [onCustom, frame])
  useEffect(() => {
    onHint?.(frame?.ticket.current() ? hint : null)
    return () => onHint?.(null)
  }, [hint, onHint, frame?.ticket])

  useEffect(() => {
    const node = section.current
    if (component !== "AbovePrompt" || !node) return
    const measure = (): void => {
      const bodyColumns = Math.max(1, Math.min(1000, Math.floor(node.clientWidth / 8)))
      const maxRows = Math.max(1, Math.min(12, Math.floor(window.innerHeight / 48)))
      setGeometry((old) =>
        old.bodyColumns === bodyColumns && old.maxRows === maxRows
          ? old
          : { ...old, bodyColumns, maxRows }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    window.addEventListener("resize", measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [component])

  useEffect(() => {
    live.current = true
    const lifetime = new FunctionSiteLifetime()
    lifetimeRef.current = lifetime
    let stopped = false
    let owner: string | null = null
    let queued = false
    let running = false
    const refresh = async (): Promise<void> => {
      if (stopped) return
      if (running) {
        queued = true
        return
      }
      running = true
      const ticket = lifetime.capture()
      try {
        if (!owner) {
          owner = await functionSiteQueue.run(ticket.current, () =>
            window.api.mods.siteMount(threadId, component)
          )
          if (!ticket.current()) {
            if (owner) void window.api.mods.siteUnmount(threadId, owner).catch(() => {})
            owner = null
            return
          }
          ownerRef.current = owner
        }
        const result = owner
          ? await functionSiteQueue.run(ticket.current, () =>
              window.api.mods.siteRender(threadId, owner!, inputRef.current)
            )
          : null
        if (!ticket.current()) return
        if (result) validateFunctionSiteTree(result.tree)
        else {
          owner = null
          ownerRef.current = null
        }
        ticket.commit(() => {
          setFrame(result ? { snapshot: result, ticket } : null)
          setError("")
        })
      } catch (cause) {
        if (ticket.current()) {
          setFrame(null)
          if (
            String(cause).includes("MODS_UI_SITE_CLOSED") ||
            String(cause).includes("MODS_SESSION_CLOSED")
          ) {
            owner = null
            ownerRef.current = null
            queued = true
          } else
            setError(
              String(cause).includes("MODS_UI_SITE_CLIENT_UNSUPPORTED")
                ? "此位置暂不支持 Client 组件。"
                : "插件界面未能绘制，已恢复默认内容。"
            )
        }
      } finally {
        running = false
        if (queued && !stopped) {
          queued = false
          void refresh()
        }
      }
    }
    const update = (): void => {
      void refresh()
    }
    const reset = (): void => {
      lifetime.invalidate()
      setFrame(null)
      setError("")
      if (owner) void window.api.mods.siteUnmount(threadId, owner).catch(() => {})
      owner = null
      ownerRef.current = null
      update()
    }
    refreshRef.current = update
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && event.scope !== "panes") {
        lifetime.invalidate()
        update()
      }
    })
    const stopConfiguration = window.api.mods.onConfigurationChanged(reset)
    window.addEventListener("mods:configuration-changed", reset)
    update()
    return () => {
      stopped = true
      live.current = false
      lifetime.close()
      ownerRef.current = null
      refreshRef.current = () => {}
      if (owner) void window.api.mods.siteUnmount(threadId, owner).catch(() => {})
      stop()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", reset)
    }
  }, [threadId, component])
  useEffect(() => {
    lifetimeRef.current?.invalidate()
    setFrame(null)
    refreshRef.current()
  }, [inputKey])

  const act: Act = async (node, kind, value) => {
    const pane = snapshotRef.current
    const owner = ownerRef.current
    if (!pane || !owner) return
    const ticket = lifetimeRef.current?.capture()
    if (!ticket) return
    pending.current++
    if (!["change", "focus", "scroll"].includes(kind)) setBusy(true)
    try {
      const result = await window.api.mods.siteAct(threadId, owner, {
        pane: pane.key,
        generation: pane.generation,
        plugin: node?.press?.plugin ?? pane.plugin,
        handle: node?.press?.handle ?? 0,
        intentId: crypto.randomUUID(),
        kind,
        ...(value === undefined ? {} : { value })
      })
      if (!ticket.current() || ownerRef.current !== owner) return
      if (
        kind === "focus" &&
        result?.focused &&
        section.current &&
        document.activeElement === section.current &&
        snapshotRef.current?.generation === pane.generation
      ) {
        const control = paneFocusElement(section.current, result.target)
        if (control && !control.matches(":disabled")) {
          applyingFocus.current = true
          try {
            control.focus({ preventScroll: true })
          } finally {
            applyingFocus.current = false
          }
        }
      }
      if (kind !== "change") refreshRef.current()
    } catch {
      if (ticket.current()) {
        setError("界面已更新或操作未完成，请在当前界面重试。")
        refreshRef.current()
      }
    } finally {
      pending.current--
      if (live.current && pending.current === 0) setBusy(false)
    }
  }

  return (
    <section
      ref={section}
      data-function-site={component}
      tabIndex={
        component === "AbovePrompt" && snapshot && functionFocusTargets(snapshot).length
          ? 0
          : undefined
      }
      className={
        className ?? "mx-auto w-full max-w-3xl overflow-auto text-xs text-muted-foreground"
      }
      style={component === "AbovePrompt" ? { maxHeight: geometry.maxRows * 24 } : undefined}
      onFocus={(event) => {
        if (
          component === "AbovePrompt" &&
          event.target === event.currentTarget &&
          !applyingFocus.current
        )
          void act(undefined, "focus", { focused: true })
      }}
      onBlur={(event) => {
        if (
          component !== "AbovePrompt" ||
          (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        )
          return
        void act(undefined, "focus", { focused: false })
      }}
      onScroll={(event) => {
        if (component !== "AbovePrompt") return
        const offset = Math.max(0, Math.min(100000, Math.floor(event.currentTarget.scrollTop / 24)))
        setGeometry((old) => (old.offset === offset ? old : { ...old, offset }))
      }}
      onWheel={(event) => {
        if (component !== "AbovePrompt") return
        const clamp = (n: number): number => Math.max(-100000, Math.min(100000, n))
        void act(undefined, "scroll", {
          deltaX: clamp(event.deltaX),
          deltaY: clamp(event.deltaY),
          top: clamp(event.currentTarget.scrollTop),
          left: clamp(event.currentTarget.scrollLeft)
        })
      }}
    >
      {!(onHint && hint !== null) && (
        <FunctionSiteContent snapshot={snapshot} fallback={fallback} busy={busy} act={act} />
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
