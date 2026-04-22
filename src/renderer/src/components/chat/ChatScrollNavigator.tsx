import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

interface ChatScrollNavigatorProps {
  onScrollToTop: () => void
  onScrollToPrevUserQuestion: () => void
  onScrollToNextUserQuestion: () => void
  onScrollToBottom: () => void
}

export function ChatScrollNavigator({
  onScrollToTop,
  onScrollToPrevUserQuestion,
  onScrollToNextUserQuestion,
  onScrollToBottom
}: ChatScrollNavigatorProps): React.JSX.Element {
  return (
    <div className="px-4 py-2">
      <div className="max-w-3xl mx-auto flex justify-end gap-1.5">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="滚动到顶部"
                onClick={onScrollToTop}
                className="flex items-center justify-center size-7 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronsUp className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              滚动到顶部
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="滚动到上一个用户问题"
                onClick={onScrollToPrevUserQuestion}
                className="flex items-center justify-center size-7 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronUp className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              滚动到上一个用户问题（无上一个时回到顶部）
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="滚动到下一个用户问题"
                onClick={onScrollToNextUserQuestion}
                className="flex items-center justify-center size-7 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronDown className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              滚动到下一个用户问题（无下一个时滚到底部）
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="滚动到底部"
                onClick={onScrollToBottom}
                className="flex items-center justify-center size-7 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronsDown className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              滚动到底部
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
