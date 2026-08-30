import type { Message } from "@/types"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

type MessageRefSetter = (
  messageId: string,
  role: Message["role"]
) => (node: HTMLDivElement | null) => void

interface ChatScrollQuestion {
  id: string
  preview: string
  userInputRequests: ChatScrollUserInputRequest[]
}

interface ChatScrollUserInputRequest {
  questions: ChatScrollUserInputQuestion[]
  status: "pending" | "submitted" | "ignored" | "unavailable"
}

interface ChatScrollUserInputQuestion {
  id: string
  header: string
  question: string
  answer?: string
}

export interface ChatScrollNavigatorRenderProps {
  hasQuestions: boolean
  reserveLeftSpace: boolean
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getUserInputRequestQuestions(
  args: Record<string, unknown>
): ChatScrollUserInputQuestion[] {
  if (!Array.isArray(args.questions)) return []

  return args.questions.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") {
      return []
    }

    return [
      {
        id: value.id,
        header: typeof value.header === "string" ? value.header : "",
        question: value.question
      }
    ]
  })
}

function parseUserInputRequestResponse(
  content: Message["content"]
): { answers: Record<string, string>; status: ChatScrollUserInputRequest["status"] } | null {
  try {
    const value = JSON.parse(getMessageText(content)) as unknown
    if (!isRecord(value)) return null

    const status =
      value.status === "submitted"
        ? "submitted"
        : value.status === "ignored"
          ? "ignored"
          : value.status === "cancelled" || value.status === "rejected"
            ? "unavailable"
            : "pending"
    const answers = Object.fromEntries(
      Object.entries(isRecord(value.answers) ? value.answers : {}).flatMap(
        ([questionId, answer]) => {
          if (!isRecord(answer)) return []
          if (answer.type === "other" && typeof answer.text === "string") {
            return [[questionId, answer.text]]
          }
          if (answer.type === "option" && typeof answer.label === "string") {
            return [[questionId, answer.label]]
          }
          return []
        }
      )
    )

    return { answers, status }
  } catch {
    return null
  }
}

function getChatScrollQuestions(messages: Message[]): ChatScrollQuestion[] {
  const questions: ChatScrollQuestion[] = []
  const userInputResponses = new Map<
    string,
    { answers: Record<string, string>; status: ChatScrollUserInputRequest["status"] }
  >()

  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue
    const response = parseUserInputRequestResponse(message.content)
    if (response) userInputResponses.set(message.tool_call_id, response)
  }

  let activeQuestionIndex = -1
  let activeRequestToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role === "user") {
      activeQuestionIndex = questions.length
      activeRequestToolCallIds = new Set()
      questions.push({
        id: message.id,
        preview: getQuestionPreview(message.content),
        userInputRequests: []
      })
      continue
    }

    if (message.role !== "assistant" || activeQuestionIndex < 0) continue

    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.name !== "request_user_input" || activeRequestToolCallIds.has(toolCall.id)) {
        continue
      }

      activeRequestToolCallIds.add(toolCall.id)
      const response = userInputResponses.get(toolCall.id)
      const userInputRequest: ChatScrollUserInputRequest = {
        status: response?.status ?? "pending",
        questions: getUserInputRequestQuestions(toolCall.args).map((question) => ({
          ...question,
          answer: response?.answers[question.id]
        }))
      }
      questions[activeQuestionIndex] = {
        ...questions[activeQuestionIndex],
        userInputRequests: [...questions[activeQuestionIndex].userInputRequests, userInputRequest]
      }
    }
  }

  return questions
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
    () => getChatScrollQuestions(messages),
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

  // --- Hover preview popover ------------------------------------------------
  // A single shared Popover (instead of one Tooltip per line) whose open state is
  // driven purely by hoveredIndex. This avoids the stale-content / flicker races
  // that come from many independent tooltip roots fighting over open state.
  const POPOVER_OPEN_DELAY_MS = 120
  const POPOVER_CLOSE_GRACE_MS = 150

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 })
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const handleClose = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setHoveredIndex(null)
    setPopoverOpen(false)
  }, [clearCloseTimer, clearOpenTimer])

  const updatePopoverPosition = useCallback((index: number) => {
    const button = buttonRefs.current.get(index)
    const wrapper = wrapperRef.current
    if (!button || !wrapper) return
    const buttonRect = button.getBoundingClientRect()
    const wrapperRect = wrapper.getBoundingClientRect()
    setPopoverPosition({
      top: buttonRect.top - wrapperRect.top,
      left: buttonRect.left - wrapperRect.left
    })
  }, [])

  const openPopoverFor = useCallback(
    (index: number) => {
      clearCloseTimer()
      setHoveredIndex(index)
      updatePopoverPosition(index)
      clearOpenTimer()
      openTimerRef.current = setTimeout(() => setPopoverOpen(true), POPOVER_OPEN_DELAY_MS)
    },
    [clearCloseTimer, clearOpenTimer, updatePopoverPosition]
  )

  // Keyboard focus opens the preview immediately (no hover delay).
  const handleButtonFocus = useCallback(
    (index: number) => {
      clearCloseTimer()
      setHoveredIndex(index)
      updatePopoverPosition(index)
      clearOpenTimer()
      setPopoverOpen(true)
    },
    [clearCloseTimer, clearOpenTimer, updatePopoverPosition]
  )

  // Leaving the line column (or the preview itself) arms a short grace timer so the
  // preview stays open while the pointer is travelling into the popover content.
  const armClose = useCallback(() => {
    clearOpenTimer()
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      handleClose()
    }, POPOVER_CLOSE_GRACE_MS)
  }, [clearOpenTimer, handleClose])

  useEffect(() => {
    return () => {
      clearOpenTimer()
      clearCloseTimer()
    }
  }, [clearCloseTimer, clearOpenTimer])

  const hasQuestions = questions.length > 0
  const reserveLeftSpace = hasQuestions && !rightPanelCollapsed

  const density =
    questions.length <= 8
      ? "loose"
      : questions.length <= 18
        ? "normal"
        : questions.length <= 36
          ? "compact"
          : "dense"

  const keyHeight = {
    loose: 12,
    normal: 11,
    compact: 10,
    dense: 8
  }[density]

  const getRidgeDistance = (index: number): number | null => {
    if (hoveredIndex === null) return null
    const distance = Math.abs(index - hoveredIndex)
    return distance <= 5 ? distance : null
  }

  const getLineWidth = (distance: number | null, isActive: boolean): number => {
    const base = 11
    const active = base
    const ridge = [26, 22, 18, 15, 12, base]

    if (distance !== null) return ridge[distance]
    return isActive ? active : base
  }

  const getLineHeight = (distance: number | null): number => {
    return distance === 0 ? 3 : 2
  }

  const renderPopoverContent = (question: ChatScrollQuestion, index: number): ReactNode => {
    const isActive = index === activeQuestionIndex
    return (
      <>
        <div className="mb-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-medium text-[#B85F42] dark:text-[#F0A17E]">第 {index + 1} 次</span>
          {isActive && <span>当前</span>}
        </div>
        <div className="text-xs leading-5 text-foreground/90">{question.preview}</div>
        {question.userInputRequests.map((request, requestIndex) => {
          const questionNumberOffset = question.userInputRequests
            .slice(0, requestIndex)
            .reduce((total, previousRequest) => total + previousRequest.questions.length, 0)

          return (
            <div
              key={`${question.id}-user-input-${requestIndex}`}
              className="mt-2 border-t border-border/70 pt-2"
            >
              {request.questions.map((userInputQuestion, userInputQuestionIndex) => {
                const answerText =
                  userInputQuestion.answer ??
                  (request.status === "pending"
                    ? "等待回答"
                    : request.status === "ignored"
                      ? "已忽略"
                      : "未提供")
                const isFallbackAnswer = !userInputQuestion.answer

                return (
                  <div key={userInputQuestion.id} className="mb-4 last:mb-0">
                    <div className="flex items-start gap-1.5">
                      <span className="mt-[3px] inline-flex h-4 shrink-0 items-center rounded-sm bg-[#0F766E]/10 px-1 text-[9px] font-semibold leading-none text-[#0F766E] dark:bg-[#2DD4BF]/15 dark:text-[#2DD4BF]">
                        问
                      </span>
                      <div className="min-w-0 text-xs leading-5 text-foreground/90">
                        {questionNumberOffset + userInputQuestionIndex + 1}.{" "}
                        {userInputQuestion.header && (
                          <span className="font-medium text-foreground">
                            {userInputQuestion.header}：
                          </span>
                        )}
                        {userInputQuestion.question}
                      </div>
                    </div>
                    <div className="mt-1 flex items-start gap-1.5 rounded-md bg-black/[0.03] px-1.5 py-1 dark:bg-white/[0.06]">
                      <div
                        className={cn(
                          "min-w-0 break-words text-xs leading-5",
                          isFallbackAnswer ? "italic text-muted-foreground" : "text-foreground/90"
                        )}
                      >
                        {answerText}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <>
      {children({ hasQuestions, reserveLeftSpace, setMessageRef })}
      {hasQuestions && (
        <div
          ref={wrapperRef}
          className="pointer-events-none absolute left-0 top-[46%] z-20 hidden -translate-y-1/2 md:block"
        >
          <Popover
            open={popoverOpen}
            onOpenChange={(open) => {
              if (!open) handleClose()
            }}
            modal={false}
          >
            <div
              onMouseLeave={armClose}
              onScroll={() => {
                if (popoverOpen && hoveredIndex !== null) updatePopoverPosition(hoveredIndex)
              }}
              className={cn(
                "pointer-events-auto relative flex max-h-[62vh] w-9 flex-col items-start gap-px overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              )}
            >
              {questions.map((question, index) => {
                const isActive = index === activeQuestionIndex
                const hasRequestedUserInput = question.userInputRequests.length > 0
                const ridgeDistance = getRidgeDistance(index)
                const lineWidth = getLineWidth(ridgeDistance, isActive)
                const lineHeight = getLineHeight(ridgeDistance)
                return (
                  <button
                    key={question.id}
                    type="button"
                    ref={(node) => {
                      if (node) buttonRefs.current.set(index, node)
                      else buttonRefs.current.delete(index)
                    }}
                    aria-label={`滚动到第 ${index + 1} 次提问${
                      hasRequestedUserInput ? "，已触发请求用户输入" : ""
                    }`}
                    onClick={() => scrollToUserQuestionByIndex(index)}
                    onMouseEnter={() => openPopoverFor(index)}
                    onFocus={() => handleButtonFocus(index)}
                    onBlur={handleClose}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") handleClose()
                    }}
                    style={{ height: keyHeight }}
                    className={cn(
                      "group relative flex w-full items-center justify-start rounded-lg pl-1 transition-colors duration-200 hover:bg-foreground/6 focus-visible:bg-foreground/10 focus-visible:outline-none dark:hover:bg-white/8"
                    )}
                  >
                    <span
                      style={{ width: lineWidth, height: lineHeight }}
                      className={cn(
                        "relative z-10 rounded-full transition-all duration-200 ease-out",
                        ridgeDistance !== null
                          ? "bg-foreground/80 dark:bg-white/85"
                          : "bg-foreground/20 dark:bg-white/25",
                        hasRequestedUserInput && "bg-[#eb31ba] dark:bg-[#2DD4BF]",
                        isActive && "bg-[#D97757] dark:bg-[#E58A68]"
                      )}
                    />
                  </button>
                )
              })}
            </div>
            {hoveredIndex !== null && (
              <PopoverAnchor asChild>
                <span
                  className="pointer-events-none absolute"
                  style={{
                    top: popoverPosition.top,
                    left: popoverPosition.left,
                    width: 1,
                    height: 1
                  }}
                />
              </PopoverAnchor>
            )}
            <PopoverContent
              side="right"
              align="start"
              sideOffset={30}
              onMouseEnter={clearCloseTimer}
              onMouseLeave={armClose}
              className="max-h-[70vh] mb-10 max-w-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-border/70 bg-white px-3 py-2 leading-relaxed shadow-lg shadow-black/5 backdrop-blur-sm"
            >
              {hoveredIndex !== null && renderPopoverContent(questions[hoveredIndex], hoveredIndex)}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </>
  )
}
