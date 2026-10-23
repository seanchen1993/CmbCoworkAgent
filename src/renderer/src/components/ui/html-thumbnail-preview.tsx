import { Eye } from "lucide-react"

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
        sandbox="allow-scripts"
        tabIndex={-1}
        className={cn(
          "block border-0 bg-white",
          fit === "fill"
            ? "pointer-events-auto h-full w-full overflow-y-auto"
            : "pointer-events-none h-[500%] w-[500%] origin-top-left scale-[0.2]"
        )}
      />
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
              className="absolute right-2 top-2 z-20 inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Eye className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">点击可以放大预览完整页面效果</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
