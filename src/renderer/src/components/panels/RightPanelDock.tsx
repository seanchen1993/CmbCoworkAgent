import type { CSSProperties, ReactNode, Ref } from "react"
import { ResizeHandle } from "@/components/ui/resizable"

/** Shared geometry and drag target for every chat sidebar, including persistent Mod panes. */
export function RightPanelDock({
  hidden,
  resizable,
  panelRef,
  className,
  style,
  onResizeStart,
  onResize,
  onResizeEnd,
  children
}: {
  hidden: boolean
  resizable: boolean
  panelRef: Ref<HTMLDivElement>
  className: string
  style?: CSSProperties
  onResizeStart: () => void
  onResize: (delta: number) => void
  onResizeEnd: () => void
  children: ReactNode
}) {
  return (
    <>
      {!hidden && resizable && (
        <ResizeHandle onDragStart={onResizeStart} onDrag={onResize} onDragEnd={onResizeEnd} />
      )}
      <div
        data-right-panel-dock
        hidden={hidden}
        inert={hidden}
        ref={panelRef}
        className={className}
        style={{ ...style, ...(hidden ? { display: "none" } : {}) }}
      >
        {children}
      </div>
    </>
  )
}
