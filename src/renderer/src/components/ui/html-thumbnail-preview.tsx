import { useEffect, useState } from "react"
import { Eye, Loader2 } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { openResourcePanelOverlay } from "@/lib/resource-panel-overlay-events"
import { resolveHtmlPreviewBrowserUrl } from "@/lib/html-preview-browser-url"

export function HtmlThumbnailPreview({
  html,
  title,
  browserUrl,
  browserWorkspacePath,
  onSelect,
  fit = "thumbnail",
  className
}: {
  html: string
  title: string
  browserUrl: string
  browserWorkspacePath?: string | null
  onSelect?: () => void
  fit?: "thumbnail" | "fill"
  className?: string
}): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [showLoading, setShowLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    setShowLoading(false)
    const showTimer = window.setTimeout(() => setShowLoading(true), 120)
    const settleTimer = window.setTimeout(() => setLoading(false), 800)
    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(settleTimer)
    }
  }, [html])

  const openInBrowser = (): void => {
    openResourcePanelOverlay("browser", {
      browserUrl: resolveHtmlPreviewBrowserUrl(browserUrl, browserWorkspacePath)
    })
  }

  return (
    <div className={cn("relative overflow-hidden bg-white", className)}>
      <iframe
        title={title}
        srcDoc={html}
        sandbox={fit === "fill" ? "allow-scripts" : ""}
        loading="lazy"
        tabIndex={-1}
        onLoad={() => setLoading(false)}
        onError={() => setLoading(false)}
        className={cn(
          "block border-0 bg-white",
          fit === "fill"
            ? "pointer-events-auto h-full w-full overflow-y-auto"
            : "pointer-events-none h-[500%] w-[500%] origin-top-left scale-[0.2]"
        )}
      />
      {loading && showLoading ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/90 text-primary backdrop-blur-[1px]">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Loader2 className="size-4 animate-spin" />
            正在加载预览
          </div>
        </div>
      ) : null}
      {onSelect ? (
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`选择${title}`}
          onClick={onSelect}
        />
      ) : null}
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`放大查看${title}`}
              onClick={openInBrowser}
              className="absolute right-0 top-2 z-20 inline-flex h-8 w-10 cursor-pointer items-center justify-center rounded-l-full border border-r-0 border-primary/70 bg-primary text-primary-foreground shadow-md transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
            >
              <Eye className="size-4" strokeWidth={2.2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">点击可以放大预览完整页面效果</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
