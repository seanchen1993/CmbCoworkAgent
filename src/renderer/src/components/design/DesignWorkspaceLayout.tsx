import { useEffect, useRef, useState, type ReactNode } from "react"
import { ResizeHandle } from "@/components/ui/resizable"

const WIDTH_KEY = "design_conversation_width_v1"
const DEFAULT_WIDTH = 420
const HANDLE_WIDTH = 6

const workspaceStyles = `
.design-workspace { position:relative; display:flex; flex:1; min-height:0; min-width:0; overflow:hidden; background:var(--background,#fff); }
.design-workspace * { box-sizing:border-box; }
.design-chat-pane { display:flex; flex-shrink:0; min-width:0; min-height:0; }
.design-workspace[data-layout="conversation"] .design-chat-pane { flex:1; }
.design-canvas-pane { position:relative; display:flex; flex:1; min-width:0; min-height:0; overflow:hidden; }
.design-workspace > [role="separator"] { position:relative; z-index:2; outline:none; background:var(--background-secondary,#f0efeb); box-shadow:inset 1px 0 var(--border,#e8e6e0); touch-action:none; }
.design-workspace > [role="separator"]::after { content:""; width:2px; height:32px; position:absolute; top:50%; left:2px; border-radius:2px; background:var(--border-emphasis,#d0cec8); transition:height .15s,background .15s; }
.design-workspace > [role="separator"]:hover::after,.design-workspace > [role="separator"]:focus-visible::after { height:48px; background:var(--primary,#cc785c); }
.design-workspace[data-stacked="true"] { flex-direction:column; }
.design-workspace[data-stacked="true"] .design-chat-pane { flex:0 0 42%; width:100%; border-bottom:1px solid var(--border,#e8e6e0); }
.design-resize-shield { position:absolute; inset:0; z-index:40; cursor:col-resize; }
.design-conversation { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; background:var(--background,#fff); }
.design-conversation-body { width:100%; min-height:0; position:relative; }
.design-workspace[data-layout="conversation"] .design-conversation-body { max-width:840px; margin-inline:auto; }
.design-conversation[data-welcome="true"] { justify-content:center; overflow-y:auto; padding:32px 28px 56px; }
.design-welcome-header { padding:8px 0 0; text-align:center; }
.design-welcome-icon { display:inline-flex; align-items:center; justify-content:center; width:46px; height:46px; margin-bottom:22px; border:1px solid var(--border,#e8e6e0); border-radius:15px; color:var(--primary,#cc785c); background:var(--background-secondary,#fafaf8); }
.design-welcome-header h2 { margin:0; font-size:32px; line-height:1.35; letter-spacing:-.7px; font-weight:600; color:var(--foreground,#1a1a1a); }
.design-welcome-header p { margin:12px 0 0; font-size:14px; line-height:1.8; color:var(--muted-foreground,#8a8a8a); }
.design-composer-area { width:100%; padding:12px 16px 16px; border-top:1px solid var(--border,#e8e6e0); flex-shrink:0; position:relative; }
.design-workspace[data-layout="conversation"] .design-composer-area { max-width:840px; margin-inline:auto; }
.design-conversation[data-welcome="true"] .design-composer-area { padding:28px 0 0; border:0; }
.design-composer-box { border:1px solid var(--border,#e0ded8); border-radius:14px; background:var(--background-secondary,#fafaf8); padding:10px 12px; }
.design-conversation[data-welcome="true"] .design-composer-box { border-radius:20px; padding:18px 18px 14px; box-shadow:0 4px 24px rgba(0,0,0,.035); }
.design-composer-box:focus-within { border-color:var(--border-emphasis,#c2bdb3); box-shadow:0 0 0 3px color-mix(in srgb,var(--primary,#cc785c) 7%,transparent); }
.design-start-actions { display:flex; justify-content:center; flex-wrap:wrap; gap:10px; width:100%; max-width:840px; margin:18px auto 0; }
.design-start-action { display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:9px 13px; border:1px solid var(--border,#e8e6e0); border-radius:10px; background:transparent; color:var(--muted-foreground,#6a6a6a); font-family:inherit; font-size:12px; font-weight:500; line-height:1.4; cursor:pointer; transition:background .15s,color .15s,border-color .15s; }
.design-start-action:hover:not(:disabled) { background:var(--background-secondary,#f5f4f0); border-color:var(--border-emphasis,#d0cec8); color:var(--foreground,#1a1a1a); }
.design-start-action:disabled { opacity:.5; cursor:not-allowed; }
.design-start-action:focus-visible { outline:2px solid var(--primary,#cc785c); outline-offset:3px; }
.design-conversation-messages { width:100%; }
@media(max-width:600px) { .design-conversation[data-welcome="true"] { padding:24px 18px 36px; } .design-welcome-header h2 { font-size:27px; } .design-start-actions { gap:8px; } .design-start-action { padding:8px 10px; } }
@media(prefers-reduced-motion:reduce) { .design-start-action,.design-workspace > [role="separator"]::after { transition:none; } }
`

function loadPreferredWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(value) && value >= 320 && value <= 2000) return value
  } catch {
    /* A private window can still resize without saving its preference. */
  }
  return DEFAULT_WIDTH
}

/** The conversation stays mounted as the generation panel opens beside it. */
export function DesignWorkspaceLayout({
  showPreview,
  children
}: {
  showPreview: boolean
  children: [ReactNode, ReactNode]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [preferredWidth, setPreferredWidth] = useState(loadPreferredWidth)
  const preferredWidthRef = useRef(preferredWidth)
  const dragStartRef = useRef(DEFAULT_WIDTH)
  const [dragging, setDragging] = useState(false)
  const stacked = showPreview && containerWidth > 0 && containerWidth < 760
  const available = Math.max(0, (containerWidth || 1440) - HANDLE_WIDTH)
  const min = Math.min(320, available / 2)
  const max = Math.max(min, available - 360)
  const width = Math.round(Math.min(max, Math.max(min, preferredWidth)))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const changeWidth = (next: number, persist = false) => {
    const clamped = Math.round(Math.min(max, Math.max(min, next)))
    preferredWidthRef.current = clamped
    setPreferredWidth(clamped)
    if (persist) {
      try {
        localStorage.setItem(WIDTH_KEY, String(clamped))
      } catch {
        /* Optional preference. */
      }
    }
  }
  const finishDrag = () => {
    setDragging(false)
    changeWidth(preferredWidthRef.current, true)
  }

  return (
    <div
      ref={containerRef}
      className="design-workspace"
      data-testid="design-workspace"
      data-layout={showPreview ? "split" : "conversation"}
      data-stacked={stacked}
    >
      <style>{workspaceStyles}</style>
      <section
        className="design-chat-pane"
        aria-label="设计对话"
        style={{ width: showPreview && !stacked ? width : "100%" }}
      >
        {children[0]}
      </section>
      {showPreview && !stacked && (
        <ResizeHandle
          label="调整对话与页面宽度"
          value={width}
          min={min}
          max={max}
          onDragStart={() => {
            dragStartRef.current = width
            setDragging(true)
          }}
          onDrag={(delta) => changeWidth(dragStartRef.current + delta)}
          onDragEnd={finishDrag}
          onReset={() => changeWidth(DEFAULT_WIDTH, true)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowLeft"
                ? width - 24
                : event.key === "ArrowRight"
                  ? width + 24
                  : event.key === "Home"
                    ? min
                    : event.key === "End"
                      ? max
                      : event.key === "Enter"
                        ? DEFAULT_WIDTH
                        : null
            if (next === null) return
            event.preventDefault()
            changeWidth(next, true)
          }}
        />
      )}
      {showPreview && (
        <section className="design-canvas-pane" aria-label="设计页面">
          {children[1]}
        </section>
      )}
      {dragging && showPreview && !stacked && (
        <div className="design-resize-shield" data-testid="design-resize-shield" />
      )}
    </div>
  )
}
