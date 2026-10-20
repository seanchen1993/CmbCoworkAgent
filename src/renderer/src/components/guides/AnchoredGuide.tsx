import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react"
import { BookOpen, X } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import type { UiGuideConfig } from "../../../../shared/ui-guides"

export interface AnchoredGuideStep {
  id: string
  title: string
  description: string
  selectors: readonly string[]
}

const dismissed = new Set<string>()

/** View navigation only: opening a guide never clicks or authorizes a business action. */
interface AnchoredGuideProps {
  active: boolean
  config: UiGuideConfig
  rootRef: RefObject<HTMLElement | null>
  steps: readonly AnchoredGuideStep[]
  request?: number
}

export function AnchoredGuide(props: AnchoredGuideProps) {
  return <ScopedAnchoredGuide key={`${props.config.guideId}:${props.config.revision}`} {...props} />
}

function ScopedAnchoredGuide({ active, config, rootRef, steps, request = 0 }: AnchoredGuideProps) {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [available, setAvailable] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const manual = useRef(false),
    claim = useRef<Promise<boolean> | null>(null),
    handledRequest = useRef(0)
  const openedDetails = useRef(new Set<HTMLDetailsElement>())
  const key = `${config.guideId}:${config.revision}`
  const titleId = useId(),
    descriptionId = useId()
  const step = steps[index]
  const api = window.api.uiGuides

  useEffect(() => {
    const root = rootRef.current
    if (!active || !root) {
      setAvailable(false)
      return
    }
    const check = () =>
      setAvailable(
        root.getClientRects().length > 0 &&
          !root.closest('[inert], [hidden], [aria-hidden="true"]') &&
          document.visibilityState !== "hidden"
      )
    const observer = new MutationObserver(check)
    for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement)
      observer.observe(parent, {
        attributes: true,
        attributeFilter: ["inert", "hidden", "aria-hidden", "class", "style"]
      })
    document.addEventListener("visibilitychange", check)
    check()
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", check)
    }
  }, [active, rootRef])

  const start = () => {
    manual.current = true
    setIndex(0)
    setOpen(true)
  }
  const close = () => {
    dismissed.add(key)
    setOpen(false)
    // Closing must work even if persistence is unavailable. Ensure the record exists first.
    if (api)
      void api
        .getState(config)
        .then(() => api.acknowledge(config))
        .catch(() => {})
  }

  useEffect(() => {
    if (!active || !available) {
      setOpen(false)
      return
    }
    if (!api || dismissed.has(key)) return
    let cancelled = false
    void api
      .getState(config)
      .then((state) => {
        if (!cancelled && state.shouldShow && !dismissed.has(key) && !manual.current) {
          setIndex(0)
          setOpen(true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [active, available, api, key, config])

  useEffect(() => {
    if (!active || !available || !request || request === handledRequest.current) return
    handledRequest.current = request
    manual.current = true
    setIndex(0)
    setOpen(true)
  }, [active, available, request])

  useEffect(() => {
    if (!open || !api) return
    claim.current ??= api.recordDisplay(config)
    let cancelled = false
    void claim.current
      .then((claimed) => {
        if (!cancelled && !claimed && !manual.current) setOpen(false)
      })
      .catch(() => {
        if (!cancelled && !manual.current) setOpen(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, api, config])

  useEffect(() => {
    if (!open || !active || !available || !step) return
    const root = rootRef.current
    if (!root) return
    let frame = 0,
      previous: HTMLElement | null = null
    const locate = () => {
      frame = 0
      const next =
        step.selectors
          .map((selector) => root.querySelector<HTMLElement>(selector))
          .find((element) => element?.isConnected) ?? root
      for (
        let parent: HTMLElement | null = next;
        parent && root.contains(parent);
        parent = parent.parentElement
      ) {
        if (parent instanceof HTMLDetailsElement && !parent.open) {
          openedDetails.current.add(parent)
          parent.open = true
        }
      }
      if (next !== previous) {
        previous?.removeAttribute("data-ui-guide-current")
        next.setAttribute("data-ui-guide-current", step.id)
        next.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
        previous = next
        setTarget(next)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(locate)
    }
    locate()
    // A lazily mounted stage panel may replace the initial, real advanced-settings anchor.
    const observer = new MutationObserver(schedule)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      previous?.removeAttribute("data-ui-guide-current")
    }
  }, [active, available, open, step, rootRef])

  useEffect(() => {
    if (open) return
    for (const details of openedDetails.current) if (details.isConnected) details.open = false
    openedDetails.current.clear()
    setTarget(null)
  }, [open])

  useEffect(
    () => () => {
      for (const details of openedDetails.current) if (details.isConnected) details.open = false
      openedDetails.current.clear()
    },
    []
  )

  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => target?.getBoundingClientRect() ?? new DOMRect(),
        contextElement: target ?? undefined
      }
    }),
    [target]
  )
  if (!active) return null
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={start}
        title="查看制作、试用、验收、阶段调试与保存的分步说明"
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BookOpen className="size-3.5" aria-hidden="true" />
        使用指引
      </button>
      <Popover
        open={open && available && !!target}
        onOpenChange={(value) => {
          if (!value) close()
        }}
      >
        <PopoverAnchor virtualRef={anchor} />
        <PopoverContent
          role="dialog"
          aria-label="插件创作使用指引"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          side="bottom"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          className="overflow-y-auto p-4"
          style={{
            zIndex: 70,
            width: "min(23rem, calc(100vw - 2rem))",
            maxHeight: "calc(100dvh - 2rem)"
          }}
          onFocusOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            close()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (active && trigger.current?.isConnected)
              trigger.current.focus({ preventScroll: true })
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                第 {index + 1} / {steps.length} 步
              </p>
              <h3 id={titleId} className="mt-1 font-semibold">
                {step?.title}
              </h3>
            </div>
            <button
              type="button"
              aria-label="关闭使用指引"
              onClick={close}
              className="shrink-0 rounded p-1 hover:bg-muted"
            >
              <X className="size-4" />
            </button>
          </div>
          <p id={descriptionId} className="mt-3 text-sm leading-6 text-muted-foreground">
            {step?.description}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">可随时关闭，再从“使用指引”重新打开。</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded px-2 py-1.5 text-xs hover:bg-muted"
            >
              跳过指引
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!index}
                onClick={() => setIndex((current) => current - 1)}
                className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
              >
                上一步
              </button>
              <button
                type="button"
                onClick={() =>
                  index === steps.length - 1 ? close() : setIndex((current) => current + 1)
                }
                className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground"
              >
                {index === steps.length - 1 ? "完成指引" : "下一步"}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {open && (
        <style>{`[data-ui-guide-current] { outline: 2px solid var(--primary, #c4956a); outline-offset: 3px; }`}</style>
      )}
    </>
  )
}
