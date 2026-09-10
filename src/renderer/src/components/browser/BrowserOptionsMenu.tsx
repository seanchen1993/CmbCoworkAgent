import { Minus, MoreVertical, Plus, RotateCcw } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface BrowserOptionsMenuProps {
  browserCreated: boolean
  zoomFactor: number
  onZoomChange: (zoomFactor: number) => void
}

export const BROWSER_ZOOM_STEP = 0.25
export const MIN_BROWSER_ZOOM_FACTOR = 0.25
export const MAX_BROWSER_ZOOM_FACTOR = 5

export function BrowserOptionsMenu({
  browserCreated,
  zoomFactor,
  onZoomChange
}: BrowserOptionsMenuProps): React.JSX.Element {
  const currentZoomFactor = zoomFactor || 1
  const browserZoomPercent = Math.round(currentZoomFactor * 100)
  const canZoomOut = browserCreated && currentZoomFactor > MIN_BROWSER_ZOOM_FACTOR
  const canZoomIn = browserCreated && currentZoomFactor < MAX_BROWSER_ZOOM_FACTOR

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          aria-label="浏览器选项"
          title="浏览器选项"
        >
          <MoreVertical className="size-4" strokeWidth={1.8} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="left"
        sideOffset={8}
        avoidCollisions={false}
        className="w-64 rounded-lg border-border bg-background-elevated p-3 shadow-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">缩放</span>
          <div className="inline-flex h-8 overflow-hidden rounded-md border border-border bg-muted/40">
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              aria-label="缩小"
              disabled={!canZoomOut}
              onClick={() => onZoomChange(currentZoomFactor - BROWSER_ZOOM_STEP)}
            >
              <Minus className="size-3.5" strokeWidth={1.8} />
            </button>
            <div className="flex min-w-14 items-center justify-center border-x border-border px-2 text-sm tabular-nums text-foreground">
              {browserZoomPercent}%
            </div>
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              aria-label="放大"
              disabled={!canZoomIn}
              onClick={() => onZoomChange(currentZoomFactor + BROWSER_ZOOM_STEP)}
            >
              <Plus className="size-3.5" strokeWidth={1.8} />
            </button>
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label="恢复默认缩放"
            title="恢复默认缩放"
            disabled={!browserCreated || browserZoomPercent === 100}
            onClick={() => onZoomChange(1)}
          >
            <RotateCcw className="size-4" strokeWidth={1.8} />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
