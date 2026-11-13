import { useState } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { HtmlPreview } from "@/components/chat/previews/HtmlPreview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"

export function ProjectReportPreview({
  html,
  title,
  version
}: {
  html: string
  title: string
  version: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const path = `报告-v${version}.html`
  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <div
        className="h-[min(50vh,520px)] min-h-60 min-w-0 overflow-hidden [&_iframe]:!min-w-0 [&_iframe]:!w-full"
        aria-label="报告 HTML 预览"
      >
        <HtmlPreview
          content={html}
          path={path}
          fillHeight
          showModeToggle={false}
          headerActions={
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                aria-label="展开报告预览"
              >
                <Maximize2 className="size-3.5" />
                展开
              </Button>
            </DialogTrigger>
          }
        />
      </div>
      <DialogContent className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 p-0 [&>button]:hidden">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <DialogHeader className="min-w-0 flex-1 text-left">
            <DialogTitle className="text-base">报告预览</DialogTitle>
            <DialogDescription className="truncate text-xs" title={`${title} · v${version}`}>
              {title} · v{version}
            </DialogDescription>
          </DialogHeader>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              aria-label="收起报告预览"
            >
              <Minimize2 className="size-3.5" />
              收起
            </Button>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 [&_iframe]:!min-w-0 [&_iframe]:!w-full">
          <HtmlPreview content={html} path={path} fillHeight showHeader={false} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
