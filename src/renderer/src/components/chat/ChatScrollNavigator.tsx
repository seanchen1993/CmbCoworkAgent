import type { Message } from "@/types"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react"

type MessageRefSetter = (
  messageId: string,
  role: Message["role"]
) => (node: HTMLDivElement | null) => void

export interface ChatScrollQuestion {
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
  virtualRangeRef: ChatScrollVirtualRangeRef
}

interface ChatScrollNavigatorProps {
  messages: Message[]
  questionStructureRevision: number
  historyGapBeforeMessageId: string | null
  canLoadReleasedHistory: boolean
  onLoadReleasedHistoryWindow: () => void
  onRevealMessage: (messageId: string) => void
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  rightPanelCollapsed: boolean
  onScrollToQuestion?: () => void
  scrollToMessageById?: (messageId: string) => void
  children: (props: ChatScrollNavigatorRenderProps) => React.ReactNode
}

export interface ChatScrollVirtualRangeSnapshot {
  firstMessageIndex: number
  firstMessageIdentity: string
  lastMessageIndex: number
}

export interface ChatScrollVirtualRangeRef {
  current: ChatScrollVirtualRangeSnapshot | null
}

export interface ChatScrollQuestionRevisionInput {
  scopeKey: string
  messages: readonly Message[]
  structureVersion: number
  changedMessages: readonly Message[]
}

type RelevantMessageSignature = string | Message["content"]

function messageStructureIdentity(message: Message | undefined): string {
  if (!message) return ""
  return `${message.role}:${message.id}:${message.tool_call_id ?? ""}:${
    message.provider_source_id ?? ""
  }:${message.provider_occurrence ?? ""}`
}

function relevantMessageKey(message: Message): string {
  return `${message.role}:${message.id}:${message.tool_call_id ?? ""}`
}

function getRequestUserInputSignature(message: Message): string | null {
  if (message.role !== "assistant") return null
  let signature = ""
  for (const toolCall of message.tool_calls ?? []) {
    if (toolCall.name !== "request_user_input") continue
    signature += `${toolCall.id.length}:${toolCall.id}|`
    const questions = Array.isArray(toolCall.args.questions) ? toolCall.args.questions : []
    for (const value of questions) {
      if (!isRecord(value)) continue
      const id = typeof value.id === "string" ? value.id : ""
      const header = typeof value.header === "string" ? value.header : ""
      const question = typeof value.question === "string" ? value.question : ""
      signature += `${id.length}:${id}${header.length}:${header}${question.length}:${question}|`
    }
  }
  return signature || null
}

/**
 * Produces a revision for the question rail without walking historical messages on ordinary
 * append/token frames. A verified tail append examines only its new suffix. Prepend, reorder,
 * truncation, or a changed structural sentinel takes the conservative full-rebuild path.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function createChatScrollQuestionRevisionProjector(): (
  input: ChatScrollQuestionRevisionInput
) => number {
  const signatures = new Map<string, RelevantMessageSignature>()
  const knownRequestToolCallIds = new Set<string>()
  let previousScopeKey: string | null = null
  let previousMessages: readonly Message[] | null = null
  let previousStructureVersion = -1
  let previousLength = 0
  let previousFirstIdentity = ""
  let previousTailIdentity = ""
  let previousMiddleIndex = -1
  let previousMiddleIdentity = ""
  let revision = 0

  const registerRequestIds = (message: Message): string | null => {
    const signature = getRequestUserInputSignature(message)
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.name === "request_user_input") knownRequestToolCallIds.add(toolCall.id)
      }
    }
    return signature
  }

  const captureSignature = (message: Message): RelevantMessageSignature | null => {
    if (message.role === "user") return message.content
    if (message.role === "assistant") return registerRequestIds(message)
    if (
      message.role === "tool" &&
      message.tool_call_id &&
      knownRequestToolCallIds.has(message.tool_call_id)
    ) {
      return message.content
    }
    return null
  }

  const rebuildRelevantState = (messages: readonly Message[]): void => {
    signatures.clear()
    knownRequestToolCallIds.clear()
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const signature = registerRequestIds(message)
      if (signature !== null) signatures.set(relevantMessageKey(message), signature)
    }
    for (const message of messages) {
      if (message.role === "user") {
        signatures.set(relevantMessageKey(message), message.content)
      } else if (
        message.role === "tool" &&
        message.tool_call_id &&
        knownRequestToolCallIds.has(message.tool_call_id)
      ) {
        // Ordinary tool bodies are intentionally never read.
        signatures.set(relevantMessageKey(message), message.content)
      }
    }
  }

  const updateStructureSnapshot = (
    scopeKey: string,
    messages: readonly Message[],
    structureVersion: number
  ): void => {
    previousScopeKey = scopeKey
    previousMessages = messages
    previousStructureVersion = structureVersion
    previousLength = messages.length
    previousFirstIdentity = messageStructureIdentity(messages[0])
    previousTailIdentity = messageStructureIdentity(messages.at(-1))
    previousMiddleIndex = messages.length > 0 ? Math.floor((messages.length - 1) / 2) : -1
    previousMiddleIdentity = messageStructureIdentity(messages[previousMiddleIndex])
  }

  const isTrustedTailAppend = (messages: readonly Message[]): boolean =>
    previousMessages !== null &&
    previousLength > 0 &&
    messages.length > previousLength &&
    messageStructureIdentity(messages[0]) === previousFirstIdentity &&
    messageStructureIdentity(messages[previousLength - 1]) === previousTailIdentity &&
    (previousMiddleIndex < 0 ||
      messageStructureIdentity(messages[previousMiddleIndex]) === previousMiddleIdentity)

  const hasStableStructureSentinels = (messages: readonly Message[]): boolean =>
    messages.length === previousLength &&
    messageStructureIdentity(messages[0]) === previousFirstIdentity &&
    messageStructureIdentity(messages.at(-1)) === previousTailIdentity &&
    (previousMiddleIndex < 0 ||
      messageStructureIdentity(messages[previousMiddleIndex]) === previousMiddleIdentity)

  const isTrustedSameTailStructuralUpdate = (
    messages: readonly Message[],
    changedMessages: readonly Message[]
  ): boolean =>
    messages === previousMessages &&
    hasStableStructureSentinels(messages) &&
    changedMessages.length > 0 &&
    changedMessages.length <= 64 &&
    changedMessages.every((message) => messageStructureIdentity(message) === previousTailIdentity)

  const captureAppendedSuffix = (messages: readonly Message[]): boolean => {
    let relevantChange = false
    // Register request ids before inspecting tool responses in the same appended batch.
    for (let index = previousLength; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role !== "assistant") continue
      const signature = registerRequestIds(message)
      if (signature === null) continue
      signatures.set(relevantMessageKey(message), signature)
      relevantChange = true
    }
    for (let index = previousLength; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role === "assistant") continue
      const signature = captureSignature(message)
      if (signature === null) continue
      signatures.set(relevantMessageKey(message), signature)
      relevantChange = true
    }
    return relevantChange
  }

  const captureContentChanges = (changedMessages: readonly Message[]): boolean => {
    let relevantChange = false
    // Content-only projections normally contain one live row. Keep the work bounded even if an
    // upstream producer accidentally reports the whole transcript as content-changed.
    const start = Math.max(0, changedMessages.length - 64)
    for (let index = start; index < changedMessages.length; index += 1) {
      const message = changedMessages[index]
      const key = relevantMessageKey(message)
      const nextSignature = captureSignature(message)
      const hadSignature = signatures.has(key)
      const previousSignature = signatures.get(key)
      if (nextSignature === null) {
        if (hadSignature) {
          signatures.delete(key)
          relevantChange = true
        }
        continue
      }
      signatures.set(key, nextSignature)
      if (!hadSignature || previousSignature !== nextSignature) relevantChange = true
    }
    return relevantChange
  }

  return ({ scopeKey, messages, structureVersion, changedMessages }) => {
    const scopeChanged = scopeKey !== previousScopeKey
    const structureChanged =
      scopeChanged ||
      messages !== previousMessages ||
      messages.length !== previousLength ||
      structureVersion !== previousStructureVersion

    if (structureChanged) {
      if (!scopeChanged && isTrustedTailAppend(messages)) {
        if (captureAppendedSuffix(messages)) revision += 1
      } else if (!scopeChanged && isTrustedSameTailStructuralUpdate(messages, changedMessages)) {
        if (captureContentChanges(changedMessages)) revision += 1
      } else {
        rebuildRelevantState(messages)
        revision += 1
      }
      updateStructureSnapshot(scopeKey, messages, structureVersion)
      return revision
    }

    if (captureContentChanges(changedMessages)) revision += 1
    return revision
  }
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

function getChatScrollQuestions(messages: Message[]): {
  questions: ChatScrollQuestion[]
  userMessageIndexes: number[]
} {
  const questions: ChatScrollQuestion[] = []
  const userMessageIndexes: number[] = []
  const userInputResponses = new Map<
    string,
    { answers: Record<string, string>; status: ChatScrollUserInputRequest["status"] }
  >()
  const requestUserInputToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.name === "request_user_input") requestUserInputToolCallIds.add(toolCall.id)
    }
  }
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      !message.tool_call_id ||
      !requestUserInputToolCallIds.has(message.tool_call_id)
    ) {
      continue
    }
    const response = parseUserInputRequestResponse(message.content)
    if (response) userInputResponses.set(message.tool_call_id, response)
  }

  let activeQuestionIndex = -1
  let activeRequestToolCallIds = new Set<string>()

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "user") {
      activeQuestionIndex = questions.length
      activeRequestToolCallIds = new Set()
      userMessageIndexes.push(messageIndex)
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

  return { questions, userMessageIndexes }
}

interface ChatScrollQuestionProjection {
  questions: ChatScrollQuestion[]
  userMessageIds: string[]
  userMessageIndexes: number[]
  questionIndexByMessageId: Map<string, number>
  gapBeforeQuestionIndex: number | null
}

// eslint-disable-next-line react-refresh/only-export-components
export function createChatScrollQuestionProjector(): (
  messages: Message[],
  revision: number,
  gapBeforeMessageId?: string | null
) => ChatScrollQuestionProjection {
  let previousRevision = -1
  let previousGapBeforeMessageId: string | null = null
  let projection: ChatScrollQuestionProjection | null = null

  return (messages, revision, gapBeforeMessageId = null) => {
    if (
      projection &&
      previousRevision === revision &&
      previousGapBeforeMessageId === gapBeforeMessageId
    ) {
      return projection
    }
    const { questions, userMessageIndexes } = getChatScrollQuestions(messages)
    const userMessageIds = questions.map((question) => question.id)
    const questionIndexByMessageId = new Map(
      userMessageIds.map((messageId, index) => [messageId, index])
    )
    const gapMessageIndex = gapBeforeMessageId
      ? messages.findIndex((message) => message.id === gapBeforeMessageId)
      : -1
    let gapBeforeQuestionIndex: number | null = null
    if (gapMessageIndex >= 0) {
      gapBeforeQuestionIndex = userMessageIndexes.findIndex(
        (messageIndex) => messageIndex >= gapMessageIndex
      )
      if (gapBeforeQuestionIndex < 0) gapBeforeQuestionIndex = questions.length
    }
    projection = {
      questions,
      userMessageIds,
      userMessageIndexes,
      questionIndexByMessageId,
      gapBeforeQuestionIndex
    }
    previousRevision = revision
    previousGapBeforeMessageId = gapBeforeMessageId
    return projection
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function findChatScrollQuestionIndexForMessageIndex(
  userMessageIndexes: readonly number[],
  messageIndex: number | undefined
): number {
  if (messageIndex === undefined || messageIndex < 0) return -1
  let low = 0
  let high = userMessageIndexes.length - 1
  let result = -1
  while (low <= high) {
    const questionIndex = Math.floor((low + high) / 2)
    if (userMessageIndexes[questionIndex] <= messageIndex) {
      result = questionIndex
      low = questionIndex + 1
    } else {
      high = questionIndex - 1
    }
  }
  return result
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

interface ChatScrollMarkerRailProps {
  questions: ChatScrollQuestion[]
  activeQuestionIndex: number
  onScrollToQuestionIndex: (index: number) => void
  gapBeforeQuestionIndex?: number | null
  canLoadReleasedHistory?: boolean
  onLoadReleasedHistoryWindow?: () => void
}

// eslint-disable-next-line react-refresh/only-export-components
export function areChatScrollMarkerRailPropsEqual(
  previous: Readonly<ChatScrollMarkerRailProps>,
  next: Readonly<ChatScrollMarkerRailProps>
): boolean {
  return (
    previous.questions === next.questions &&
    previous.activeQuestionIndex === next.activeQuestionIndex &&
    previous.onScrollToQuestionIndex === next.onScrollToQuestionIndex &&
    previous.gapBeforeQuestionIndex === next.gapBeforeQuestionIndex &&
    previous.canLoadReleasedHistory === next.canLoadReleasedHistory &&
    previous.onLoadReleasedHistoryWindow === next.onLoadReleasedHistoryWindow
  )
}

const POPOVER_OPEN_DELAY_MS = 120
const POPOVER_CLOSE_GRACE_MS = 150
const CHAT_SCROLL_MARKER_WINDOW_SIZE = 120

/** Isolated from transcript rendering: stable question props make ordinary token renders bail out. */
const ChatScrollMarkerRail = memo(function ChatScrollMarkerRail({
  questions,
  activeQuestionIndex,
  onScrollToQuestionIndex,
  gapBeforeQuestionIndex = null,
  canLoadReleasedHistory = false,
  onLoadReleasedHistoryWindow
}: ChatScrollMarkerRailProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
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
  const markerCenterIndex =
    hoveredIndex ?? (activeQuestionIndex >= 0 ? activeQuestionIndex : questions.length - 1)
  const markerWindowStart = Math.max(
    0,
    Math.min(
      questions.length - CHAT_SCROLL_MARKER_WINDOW_SIZE,
      markerCenterIndex - Math.floor(CHAT_SCROLL_MARKER_WINDOW_SIZE / 2)
    )
  )
  const markerWindowEnd = Math.min(
    questions.length,
    markerWindowStart + CHAT_SCROLL_MARKER_WINDOW_SIZE
  )
  const markerQuestions = questions.slice(markerWindowStart, markerWindowEnd)

  const renderReleasedHistoryMarker = (): ReactNode => (
    <button
      type="button"
      data-chat-scroll-marker="released-history"
      aria-label={
        canLoadReleasedHistory
          ? "中间提问尚未加载，继续读取"
          : "中间提问尚未加载"
      }
      title={
        canLoadReleasedHistory
          ? "中间提问尚未加载，点击继续读取"
          : "中间提问尚未加载，可返回最新消息"
      }
      disabled={!canLoadReleasedHistory || !onLoadReleasedHistoryWindow}
      onClick={onLoadReleasedHistoryWindow}
      className="flex h-5 w-full items-center justify-start rounded-lg pl-1 text-[#D97757] transition-colors hover:bg-foreground/6 disabled:cursor-default disabled:opacity-70"
    >
      <span className="w-[18px] border-t-2 border-dashed border-current" />
    </button>
  )

  const getRidgeDistance = (index: number): number | null => {
    if (hoveredIndex === null) return null
    const distance = Math.abs(index - hoveredIndex)
    return distance <= 5 ? distance : null
  }

  const getLineWidth = (distance: number | null): number => {
    const base = 11
    const ridge = [26, 22, 18, 15, 12, base]
    if (distance !== null) return ridge[distance]
    return base
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
          className="pointer-events-auto relative flex max-h-[62vh] w-9 flex-col items-start gap-px overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {markerWindowStart > 0 && (
            <button
              type="button"
              aria-label="加载更早的提问导航"
              onClick={() => onScrollToQuestionIndex(markerWindowStart - 1)}
              className="flex h-5 w-full items-center justify-center text-[10px] text-muted-foreground hover:text-foreground"
            >
              ···
            </button>
          )}
          {gapBeforeQuestionIndex !== null && gapBeforeQuestionIndex <= markerWindowStart
            ? renderReleasedHistoryMarker()
            : null}
          {markerQuestions.map((question, markerIndex) => {
            const index = markerWindowStart + markerIndex
            const isActive = index === activeQuestionIndex
            const hasRequestedUserInput = question.userInputRequests.length > 0
            const ridgeDistance = getRidgeDistance(index)
            const lineWidth = getLineWidth(ridgeDistance)
            const lineHeight = ridgeDistance === 0 ? 3 : 2
            return (
              <div key={question.id} className="contents">
                {gapBeforeQuestionIndex === index && index > markerWindowStart
                  ? renderReleasedHistoryMarker()
                  : null}
                <button
                  type="button"
                  data-chat-scroll-marker=""
                  ref={(node) => {
                    if (node) buttonRefs.current.set(index, node)
                    else buttonRefs.current.delete(index)
                  }}
                  aria-label={`滚动到第 ${index + 1} 次提问${
                    hasRequestedUserInput ? "，已触发请求用户输入" : ""
                  }`}
                  onClick={() => onScrollToQuestionIndex(index)}
                  onMouseEnter={() => openPopoverFor(index)}
                  onFocus={() => handleButtonFocus(index)}
                  onBlur={handleClose}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") handleClose()
                  }}
                  style={{ height: keyHeight }}
                  className="group relative flex w-full items-center justify-start rounded-lg pl-1 transition-colors duration-200 hover:bg-foreground/6 focus-visible:bg-foreground/10 focus-visible:outline-none dark:hover:bg-white/8"
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
              </div>
            )
          })}
          {gapBeforeQuestionIndex !== null &&
          gapBeforeQuestionIndex >= markerWindowEnd &&
          gapBeforeQuestionIndex > markerWindowStart
            ? renderReleasedHistoryMarker()
            : null}
          {markerWindowEnd < questions.length && (
            <button
              type="button"
              aria-label="加载更新的提问导航"
              onClick={() => onScrollToQuestionIndex(markerWindowEnd)}
              className="flex h-5 w-full items-center justify-center text-[10px] text-muted-foreground hover:text-foreground"
            >
              ···
            </button>
          )}
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
  )
}, areChatScrollMarkerRailPropsEqual)

export function ChatScrollNavigator({
  messages,
  questionStructureRevision,
  historyGapBeforeMessageId,
  canLoadReleasedHistory,
  onLoadReleasedHistoryWindow,
  onRevealMessage,
  scrollContainerRef,
  rightPanelCollapsed,
  onScrollToQuestion,
  scrollToMessageById,
  children
}: ChatScrollNavigatorProps): React.JSX.Element {
  const userMessageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const virtualRangeRef = useRef<ChatScrollVirtualRangeSnapshot | null>(null)
  const requestedUserQuestionIndexRef = useRef<number | null>(null)
  const requestedUserQuestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRevealFrameRef = useRef<number | null>(null)
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(-1)

  const [projectChatScrollQuestions] = useState(createChatScrollQuestionProjector)
  const questionProjection = projectChatScrollQuestions(
    messages,
    questionStructureRevision,
    historyGapBeforeMessageId
  )
  const {
    questions,
    questionIndexByMessageId,
    userMessageIds,
    userMessageIndexes,
    gapBeforeQuestionIndex
  } = questionProjection
  const userMessageIdsRef = useRef(userMessageIds)
  const onRevealMessageRef = useRef(onRevealMessage)
  const onScrollToQuestionRef = useRef(onScrollToQuestion)
  const scrollToMessageByIdRef = useRef(scrollToMessageById)
  useLayoutEffect(() => {
    userMessageIdsRef.current = userMessageIds
    onRevealMessageRef.current = onRevealMessage
    onScrollToQuestionRef.current = onScrollToQuestion
    scrollToMessageByIdRef.current = scrollToMessageById
  }, [onRevealMessage, onScrollToQuestion, scrollToMessageById, userMessageIds])

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
    if (!viewport) return -1

    const renderedQuestionIndexes: number[] = []
    for (const messageId of userMessageRefs.current.keys()) {
      const index = questionIndexByMessageId.get(messageId)
      if (index !== undefined) renderedQuestionIndexes.push(index)
    }
    renderedQuestionIndexes.sort((left, right) => left - right)

    // A tall assistant/tool row can occupy the whole viewport while its owning user row is
    // already outside Virtuoso's overscan window. rangeChanged records the underlying transcript
    // index without causing React state updates, so the navigator can still resolve that turn.
    const rangeQuestionIndex = findChatScrollQuestionIndexForMessageIndex(
      userMessageIndexes,
      virtualRangeRef.current &&
        messageStructureIdentity(messages[virtualRangeRef.current.firstMessageIndex]) ===
          virtualRangeRef.current.firstMessageIdentity
        ? virtualRangeRef.current.firstMessageIndex
        : undefined
    )
    if (renderedQuestionIndexes.length === 0) return rangeQuestionIndex

    const { scrollTop, scrollHeight, clientHeight } = viewport
    const nearBottom = scrollHeight - scrollTop - clientHeight < 80
    const viewportAnchor = scrollTop + 24
    const viewportBottomAnchor = scrollTop + clientHeight - 80
    // User rows are in transcript order, so their top positions are monotonic.
    // Binary search avoids forcing layout for every historical question on each
    // scroll frame. With the 240-row transcript window this needs at most about
    // eight rect reads, regardless of total history length.
    const viewportTop = viewport.getBoundingClientRect().top
    const topOf = (element: HTMLElement): number =>
      element.getBoundingClientRect().top - viewportTop + scrollTop
    const findLastQuestionAtOrBefore = (anchor: number): number => {
      let low = 0
      let high = renderedQuestionIndexes.length - 1
      let result = -1
      while (low <= high) {
        const renderedIndex = Math.floor((low + high) / 2)
        const index = renderedQuestionIndexes[renderedIndex]
        const targetElement = userMessageRefs.current.get(userMessageIds[index])
        if (!targetElement) {
          // The transcript window contains at most a few hundred rows. Restrict
          // the fallback to that bounded set instead of scanning full history.
          for (const fallbackIndex of renderedQuestionIndexes) {
            const fallbackElement = userMessageRefs.current.get(userMessageIds[fallbackIndex])
            if (!fallbackElement) continue
            if (topOf(fallbackElement) <= anchor) result = fallbackIndex
            else break
          }
          return result
        }
        if (topOf(targetElement) <= anchor) {
          result = index
          low = renderedIndex + 1
        } else {
          high = renderedIndex - 1
        }
      }
      return result
    }

    const measuredQuestionIndex = findLastQuestionAtOrBefore(
      nearBottom ? viewportBottomAnchor : viewportAnchor
    )
    return measuredQuestionIndex >= 0 ? measuredQuestionIndex : rangeQuestionIndex
  }, [messages, questionIndexByMessageId, scrollContainerRef, userMessageIds, userMessageIndexes])

  const scrollToUserQuestionByIndex = useCallback(
    (index: number): void => {
      const currentUserMessageIds = userMessageIdsRef.current
      if (index < 0 || index >= currentUserMessageIds.length) return

      const messageId = currentUserMessageIds[index]
      requestedUserQuestionIndexRef.current = index
      if (requestedUserQuestionTimerRef.current) {
        clearTimeout(requestedUserQuestionTimerRef.current)
      }
      requestedUserQuestionTimerRef.current = setTimeout(() => {
        requestedUserQuestionIndexRef.current = null
      }, 700)
      setActiveQuestionIndex(index)

      const mountedTarget = userMessageRefs.current.get(messageId)
      if (!mountedTarget && scrollToMessageByIdRef.current) {
        scrollToMessageByIdRef.current(messageId)
        onScrollToQuestionRef.current?.()
        return
      }

      const scrollWhenMounted = (attempt: number): void => {
        const nextViewport = getViewport(scrollContainerRef.current)
        const targetElement = userMessageRefs.current.get(messageId)
        if (nextViewport && targetElement) {
          pendingRevealFrameRef.current = null
          const targetTop = Math.max(0, getElementTopInViewport(targetElement, nextViewport) - 8)
          nextViewport.scrollTo({ top: targetTop, behavior: "smooth" })
          onScrollToQuestionRef.current?.()
          return
        }
        if (attempt >= 8) {
          pendingRevealFrameRef.current = null
          return
        }
        pendingRevealFrameRef.current = requestAnimationFrame(() => scrollWhenMounted(attempt + 1))
      }

      const targetElement = userMessageRefs.current.get(messageId)
      if (!targetElement) onRevealMessageRef.current(messageId)
      if (pendingRevealFrameRef.current !== null) {
        cancelAnimationFrame(pendingRevealFrameRef.current)
      }
      scrollWhenMounted(0)
    },
    [scrollContainerRef]
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
      if (pendingRevealFrameRef.current !== null) {
        cancelAnimationFrame(pendingRevealFrameRef.current)
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
  const hasNavigationMarkers = hasQuestions || gapBeforeQuestionIndex !== null
  const reserveLeftSpace = hasNavigationMarkers && !rightPanelCollapsed

  return (
    <>
      {children({ hasQuestions, reserveLeftSpace, setMessageRef, virtualRangeRef })}
      {hasNavigationMarkers && (
        <ChatScrollMarkerRail
          questions={questions}
          activeQuestionIndex={activeQuestionIndex}
          onScrollToQuestionIndex={scrollToUserQuestionByIndex}
          gapBeforeQuestionIndex={gapBeforeQuestionIndex}
          canLoadReleasedHistory={canLoadReleasedHistory}
          onLoadReleasedHistoryWindow={onLoadReleasedHistoryWindow}
        />
      )}
    </>
  )
}
