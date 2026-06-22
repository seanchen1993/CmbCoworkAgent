import type { Message } from "@/types"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

type MessageRefSetter = (messageId: string, role: Message["role"]) => (node: HTMLDivElement | null) => void

interface ChatScrollQuestion {
  id: string
  preview: string
}

export interface ChatScrollNavigatorRenderProps {
  hasQuestions: boolean
  reserveRightSpace: boolean
  setMessageRef: MessageRefSetter
}

interface ChatScrollNavigatorProps {
  messages: Message[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  rightPanelCollapsed: boolean
  onScrollToQuestion?: () => void
  children: (props: ChatScrollNavigatorRenderProps) => React.ReactNode
}

function getMessageText(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? ""
      if (typeof block.content === "string") return block.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function getQuestionPreview(content: Message["content"]): string {
  const text = getMessageText(content)
    .replace(/<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g, "📎 $1")
    .replace(/<CMBDEVCLAW-SKILL-USE-V1>[\s\S]*?<\/CMBDEVCLAW-SKILL-USE-V1>/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!text) return "（空提问）"
  return text.length > 120 ? `${text.slice(0, 120)}...` : text
}

function getViewport(scrollContainer: HTMLDivElement | null): HTMLDivElement | null {
  return scrollContainer?.querySelector(
    "[data-radix-scroll-area-viewport]"
  ) as HTMLDivElement | null
}

function getElementTopInViewport(element: HTMLElement, viewport: HTMLElement): number {
  const elementRect = element.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  return elementRect.top - viewportRect.top + viewport.scrollTop
}

export function ChatScrollNavigator({
  messages,
  scrollContainerRef,
  rightPanelCollapsed,
  onScrollToQuestion,
  children
}: ChatScrollNavigatorProps): React.JSX.Element {
  const userMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const requestedUserQuestionIndexRef = useRef<number | null>(null)
  const requestedUserQuestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(-1)

  const questions = useMemo<ChatScrollQuestion[]>(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          id: message.id,
          preview: getQuestionPreview(message.content)
        })),
    [messages]
  )

  const userMessageIds = useMemo(() => questions.map((question) => question.id), [questions])

  const setMessageRef = useCallback<MessageRefSetter>(
    (messageId: string, role: Message["role"]) =>
      (node: HTMLDivElement | null): void => {
        if (node && role === "user") {
          userMessageRefs.current.set(messageId, node)
        } else {
          userMessageRefs.current.delete(messageId)
        }
      },
    []
  )

  const getCurrentUserQuestionIndex = useCallback((): number => {
    const viewport = getViewport(scrollContainerRef.current)
    if (!viewport || userMessageIds.length === 0) return -1

    const { scrollTop, scrollHeight, clientHeight } = viewport
    const nearBottom = scrollHeight - scrollTop - clientHeight < 80
    const viewportAnchor = scrollTop + 24
    const viewportBottomAnchor = scrollTop + clientHeight - 80
    // Read the viewport rect once instead of once per message.
    const viewportTop = viewport.getBoundingClientRect().top
    const topOf = (element: HTMLElement): number =>
      element.getBoundingClientRect().top - viewportTop + scrollTop
    let currentIndex = -1

    for (let index = 0; index < userMessageIds.length; index += 1) {
      const messageId = userMessageIds[index]
      const targetElement = userMessageRefs.current.get(messageId)
      if (!targetElement) continue

      const top = topOf(targetElement)
      if (top <= viewportAnchor) {
        currentIndex = index
      } else {
        break
      }
    }

    if (nearBottom) {
      for (let index = userMessageIds.length - 1; index >= 0; index -= 1) {
        const messageId = userMessageIds[index]
        const targetElement = userMessageRefs.current.get(messageId)
        if (!targetElement) continue

        const top = topOf(targetElement)
        if (top <= viewportBottomAnchor) return index
      }
    }

    return currentIndex
  }, [scrollContainerRef, userMessageIds])

  const scrollToUserQuestionByIndex = useCallback(
    (index: number): void => {
      if (index < 0 || index >= userMessageIds.length) return

      const viewport = getViewport(scrollContainerRef.current)
      if (!viewport) return

      const messageId = userMessageIds[index]
      const targetElement = userMessageRefs.current.get(messageId)
      if (!targetElement) return

      const targetTop = Math.max(0, getElementTopInViewport(targetElement, viewport) - 8)
      requestedUserQuestionIndexRef.current = index
      if (requestedUserQuestionTimerRef.current) {
        clearTimeout(requestedUserQuestionTimerRef.current)
      }
      requestedUserQuestionTimerRef.current = setTimeout(() => {
        requestedUserQuestionIndexRef.current = null
      }, 700)
      viewport.scrollTo({ top: targetTop, behavior: "smooth" })
      onScrollToQuestion?.()
      setActiveQuestionIndex(index)
    },
    [onScrollToQuestion, scrollContainerRef, userMessageIds]
  )

  useEffect(() => {
    const viewport = getViewport(scrollContainerRef.current)
    if (!viewport) return

    // Coalesce scroll events to one measurement per frame. The measurement
    // walks user messages with getBoundingClientRect, so running it on every
    // raw scroll event is an O(n) layout hotspot on long conversations.
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      if (requestedUserQuestionIndexRef.current !== null) {
        setActiveQuestionIndex(requestedUserQuestionIndexRef.current)
        return
      }
      setActiveQuestionIndex(getCurrentUserQuestionIndex())
    }
    const handleScroll = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(measure)
    }

    viewport.addEventListener("scroll", handleScroll)
    return () => {
      viewport.removeEventListener("scroll", handleScroll)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [getCurrentUserQuestionIndex, scrollContainerRef])

  useEffect(() => {
    return () => {
      if (requestedUserQuestionTimerRef.current) {
        clearTimeout(requestedUserQuestionTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setActiveQuestionIndex(getCurrentUserQuestionIndex())
    })
    return () => cancelAnimationFrame(frame)
  }, [getCurrentUserQuestionIndex, userMessageIds.length])

  const hasQuestions = questions.length > 0
  const reserveRightSpace = hasQuestions && !rightPanelCollapsed

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
    <>
      {children({ hasQuestions, reserveRightSpace, setMessageRef })}
      {hasQuestions && (
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
                        onClick={() => scrollToUserQuestionByIndex(index)}
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
      )}
    </>
  )
}
