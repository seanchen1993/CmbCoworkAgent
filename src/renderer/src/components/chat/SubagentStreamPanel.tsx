import { useCallback, useEffect, useMemo, useRef } from "react"
import { ArrowLeft, Sparkles } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadState, useThreadStream } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import { getWorkerToolResultKey } from "@/lib/worker-tool-result-key"
import { reconcileTranscriptToolCallsWithResults } from "@/lib/subagent-transcripts"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

function messageContentLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
}

function buildToolResults(
  messages: Message[]
): Map<string, { content: string | unknown; is_error?: boolean }> {
  const results = new Map<string, { content: string | unknown; is_error?: boolean }>()
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue
    const resultKey = getWorkerToolResultKey(message.id, message.tool_call_id)
    if (!resultKey) continue
    results.set(resultKey, {
      content: message.content,
      is_error: message.is_error === true || message.status === "error"
    })
  }
  return results
}

export function SubagentStreamPanel(): React.JSX.Element {
  const subagentFocusView = useAppStore((state) => state.subagentFocusView)
  const closeSubagentFocusView = useAppStore((state) => state.closeSubagentFocusView)
  const focusedThreadId = subagentFocusView?.threadId ?? "__subagent_focus_none__"
  const threadState = useThreadState(subagentFocusView?.threadId ?? null)
  const focusedStream = useThreadStream(focusedThreadId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  const currentSubagent = threadState?.subagents.find(
    (subagent) => subagent.id === subagentFocusView?.subagentId
  )
  const parentIsRunning = focusedStream.isLoading || threadState?.scheduledTaskLoading === true
  const effectiveStatus =
    currentSubagent?.status ??
    (parentIsRunning
      ? subagentFocusView?.status
      : subagentFocusView?.status === "running"
        ? "cancelled"
        : subagentFocusView?.status)
  const isRunning = effectiveStatus === "running" && parentIsRunning
  const rawMessages = useMemo(() => {
    if (!subagentFocusView) return []
    return threadState?.subagentTranscripts[subagentFocusView.subagentId] ?? []
  }, [subagentFocusView, threadState?.subagentTranscripts])
  const messages = useMemo(
    () => reconcileTranscriptToolCallsWithResults(rawMessages),
    [rawMessages]
  )
  const toolResults = useMemo(() => buildToolResults(messages), [messages])
  const { assistantDurationMsById, userSendTimeLabelById } = useMemo(
    () => buildMessageBubbleTimingMeta(messages),
    [messages]
  )
  const showAssistantMetaByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let nextNonToolMessage: Message | null = null
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      result[index] =
        message.role !== "assistant" ||
        !nextNonToolMessage ||
        nextNonToolMessage.role !== "assistant"
      if (message.role !== "tool") nextNonToolMessage = message
    }
    return result
  }, [messages])
  const hasUserAfterHeadByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let hasUserAfterHead = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      result[index] = hasUserAfterHead
      if (messages[index].role === "user") hasUserAfterHead = true
    }
    return result
  }, [messages])
  // Index of the last non-tool message. An assistant at/after it has only tool
  // messages following, so it is still the last "visible" message and should
  // stream. Precomputed once (O(n)) instead of an O(n²) slice().every() per row.
  const lastNonToolMessageIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== "tool") return index
    }
    return -1
  }, [messages])

  const getScrollViewport = useCallback((): HTMLDivElement | null => {
    const root = scrollRef.current
    if (!root) return null
    if (root.matches("[data-radix-scroll-area-viewport]")) return root
    return root.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null
  }, [])

  const scrollToBottom = useCallback(() => {
    const scroll = () => {
      const viewport = getScrollViewport()
      if (!viewport) return
      viewport.scrollTop = viewport.scrollHeight
      isAtBottomRef.current = true
    }

    let innerFrame: number | undefined
    let timeout: number | undefined
    const frame = window.requestAnimationFrame(() => {
      scroll()
      innerFrame = window.requestAnimationFrame(scroll)
      timeout = window.setTimeout(scroll, 80)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (innerFrame !== undefined) window.cancelAnimationFrame(innerFrame)
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [getScrollViewport])

  const updateIsAtBottom = useCallback(() => {
    const viewport = getScrollViewport()
    if (!viewport) return

    const bottomDistance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    isAtBottomRef.current = bottomDistance < 50
  }, [getScrollViewport])

  const scrollSignature = useMemo(() => {
    const lastMessage = messages[messages.length - 1]
    return [
      messages.length,
      lastMessage?.id ?? "",
      lastMessage?.role ?? "",
      messageContentLength(lastMessage?.content),
      lastMessage?.tool_calls?.length ?? 0,
      toolResults.size,
      isRunning ? "running" : "idle"
    ].join(":")
  }, [isRunning, messages, toolResults.size])

  useEffect(() => {
    isAtBottomRef.current = true
    return scrollToBottom()
  }, [scrollToBottom, subagentFocusView?.subagentId, subagentFocusView?.threadId])

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport) return

    viewport.addEventListener("scroll", updateIsAtBottom, { passive: true })
    updateIsAtBottom()

    return () => {
      viewport.removeEventListener("scroll", updateIsAtBottom)
    }
  }, [
    getScrollViewport,
    updateIsAtBottom,
    subagentFocusView?.subagentId,
    subagentFocusView?.threadId
  ])

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport || !isAtBottomRef.current) return

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
      updateIsAtBottom()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [getScrollViewport, scrollSignature, updateIsAtBottom])

  if (!subagentFocusView) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        未选择子代理
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-grid-subtle">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background/85 px-2.5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => closeSubagentFocusView()}
            className="h-7 w-9 p-0"
            title="返回"
            aria-label="返回"
          >
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <Sparkles className="size-3.5 shrink-0 text-sky-500" />
          <div className="min-w-0 truncate text-sm font-semibold text-foreground">
            子代理完整记录
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {subagentFocusView.description || subagentFocusView.name}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none",
            isRunning
              ? "border-blue-300/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
              : "border-stone-300/80 bg-stone-100/70 text-stone-700 dark:border-stone-700 dark:bg-stone-900/45 dark:text-stone-300"
          )}
        >
          {isRunning ? "实时运行中" : "历史快照"}
        </span>
      </div>

      <ScrollArea ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="mx-auto w-full min-w-0 max-w-3xl overflow-hidden px-4 py-6 pb-32">
          <div className="min-w-0 space-y-4 overflow-hidden">
            {messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                暂无可展示的子代理消息。新的子代理运行过程会实时显示在这里。
              </div>
            )}
            {messages.map((message, index) => {
              if (message.role === "tool") return null
              const previousMessage = index > 0 ? messages[index - 1] : null
              // An assistant message followed only by tool messages is still the
              // last "visible" message; showing its tool calls as "interrupted"
              // instead of "running" while the parent is active is wrong.
              const isLastMessage = index >= lastNonToolMessageIndex

              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  previousMessage={previousMessage}
                  isStreaming={isRunning && isLastMessage}
                  showAssistantMeta={showAssistantMetaByIndex[index] ?? true}
                  toolResults={toolResults}
                  threadId={subagentFocusView.threadId}
                  isLoading={isRunning}
                  hasUserAfterHead={hasUserAfterHeadByIndex[index] ?? false}
                  assistantDurationMs={assistantDurationMsById.get(message.id)}
                  userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
                />
              )
            })}
            {isRunning && (
              <div className="flex items-center gap-2 text-sm">
                <div className="rainbow-spinner" />
                <span className="thinking-shimmer-text" data-text="子代理继续处理中...">
                  子代理继续处理中...
                </span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
