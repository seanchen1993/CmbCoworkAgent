import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useState } from "react"

export interface ChatScrollQuestion {
  id: string
  preview: string
}

interface ChatScrollNavigatorProps {
  questions: ChatScrollQuestion[]
  activeQuestionIndex: number
  onScrollToQuestion: (index: number) => void
}

export function ChatScrollNavigator({
  questions,
  activeQuestionIndex,
  onScrollToQuestion
}: ChatScrollNavigatorProps): React.JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (questions.length === 0) return <></>

  const density =
    questions.length <= 8
      ? "loose"
      : questions.length <= 18
        ? "normal"
        : questions.length <= 36
          ? "compact"
          : "dense"

  const keyHeight = {
    loose: 24,
    normal: 24,
    compact: 24,
    dense: 24
  }[density]

  const getRidgeDistance = (index: number): number | null => {
    if (hoveredIndex === null) return null
    const distance = Math.abs(index - hoveredIndex)
    return distance <= 5 ? distance : null
  }

  const getLineWidth = (distance: number | null, isActive: boolean): number => {
    const base = 14
    const active = base
    const ridge = [34, 29, 24, 19, 16, base]

    if (distance !== null) return ridge[distance]
    return isActive ? active : base
  }

  const getLineHeight = (distance: number | null): number => {
    if (distance === 0) return 4
    if (distance === 1) return 3
    return 3
  }

  return (
    <div className="pointer-events-none absolute right-2 top-[46%] z-20 hidden -translate-y-1/2 md:block">
      <TooltipProvider delayDuration={120}>
        <div
          onMouseLeave={() => setHoveredIndex(null)}
          className={cn(
            "pointer-events-auto relative flex max-h-[62vh] w-12 flex-col items-end gap-1 overflow-y-auto p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          )}
        >
          {questions.map((question, index) => {
            const isActive = index === activeQuestionIndex
            const ridgeDistance = getRidgeDistance(index)
            const lineWidth = getLineWidth(ridgeDistance, isActive)
            const lineHeight = getLineHeight(ridgeDistance)
            return (
              <Tooltip key={question.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`滚动到第 ${index + 1} 次提问`}
                    onClick={() => onScrollToQuestion(index)}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onFocus={() => setHoveredIndex(index)}
                    onBlur={() => setHoveredIndex(null)}
                    style={{ height: keyHeight }}
                    className={cn(
                      "group relative flex w-full items-center justify-end rounded-lg pr-1 transition-colors duration-200 hover:bg-foreground/6 focus-visible:bg-foreground/10 focus-visible:outline-none dark:hover:bg-white/8",
                      isActive &&
                        "before:absolute before:right-0 before:top-1/2 before:-translate-y-1/2 before:rounded-full before:bg-[#D97757]",
                      isActive && "before:size-1.5"
                    )}
                  >
                    <span
                      style={{ width: lineWidth, height: lineHeight }}
                      className={cn(
                        "relative z-10 rounded-full transition-all duration-200 ease-out",
                        ridgeDistance !== null
                          ? "bg-foreground/80 dark:bg-white/85"
                          : "bg-foreground/35 dark:bg-white/35",
                        isActive && "bg-[#D97757] dark:bg-[#E58A68]"
                      )}
                    />
                    <span className="sr-only">{question.preview}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  sideOffset={10}
                  className="max-w-72 whitespace-pre-wrap break-words rounded-lg border-border/70 bg-background/95 px-3 py-2 leading-relaxed shadow-lg shadow-black/5 backdrop-blur-sm"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="font-medium text-[#B85F42] dark:text-[#F0A17E]">
                      第 {index + 1} 次
                    </span>
                    {isActive && <span>当前</span>}
                  </div>
                  <div className="text-xs leading-5 text-foreground/90">{question.preview}</div>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </TooltipProvider>
    </div>
  )
}
