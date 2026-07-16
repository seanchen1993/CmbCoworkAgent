import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import type { SubagentTranscriptRunSummary } from "../../../../shared/subagent-transcript"

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
  const [durableSummary, setDurableSummary] = useState<SubagentTranscriptRunSummary | null>(null)

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
  const transcriptPreview = subagentFocusView
    ? threadState?.subagentTranscriptPreviews[subagentFocusView.subagentId]
    : undefined
  const visibleDurableSummary =
    durableSummary &&
    durableSummary.threadId === subagentFocusView?.threadId &&
    durableSummary.subagentId === subagentFocusView?.subagentId
      ? durableSummary
      : null
  const rawMessages = useMemo(() => {
    if (!subagentFocusView) return []
    return threadState?.subagentTranscripts[subagentFocusView.subagentId] ?? []
  }, [subagentFocusView, threadState?.subagentTranscripts])
  const messages = useMemo(
    () => reconcileTranscriptToolCallsWithResults(rawMessages),
    [rawMessages]
  )

  useEffect(() => {
    const threadId = subagentFocusView?.threadId
    const subagentId = subagentFocusView?.subagentId
    if (!threadId || !subagentId) return
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const summary = await window.api.agent.getSubagentTranscriptSummary(threadId, subagentId)
        if (!disposed) setDurableSummary(summary)
      } catch (error) {
        if (!disposed) {
          setDurableSummary(null)
          console.warn("[SubagentStreamPanel] Failed to read transcript summary:", error)
        }
      }
    }
    void load()
    let completedPolls = 0
    const timer = window.setInterval(
      () => {
        void load()
        if (!isRunning) {
          completedPolls += 1
          if (completedPolls >= 10) window.clearInterval(timer)
        }
      },
      isRunning ? 2_000 : 500
    )
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [isRunning, subagentFocusView?.subagentId, subagentFocusView?.threadId])

  const statusLabel =
    visibleDurableSummary?.completeness === "storage_error"
      ? "记录保存失败"
      : visibleDurableSummary?.completeness === "partial"
        ? "部分记录"
        : isRunning
          ? "实时运行中"
          : visibleDurableSummary?.completeness === "complete"
            ? "完整记录已保存"
            : "历史快照"
  const statusTone =
    visibleDurableSummary?.completeness === "storage_error"
      ? "border-red-300/70 bg-red-500/10 text-red-700 dark:text-red-300"
      : visibleDurableSummary?.completeness === "partial"
        ? "border-amber-300/70 bg-amber-500/10 text-amber-800 dark:text-amber-300"
        : isRunning
          ? "border-blue-300/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : visibleDurableSummary?.completeness === "complete"
            ? "border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-stone-300/80 bg-stone-100/70 text-stone-700 dark:border-stone-700 dark:bg-stone-900/45 dark:text-stone-300"
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
            {isRunning ? "子代理实时预览" : "子代理历史快照"}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {subagentFocusView.description || subagentFocusView.name}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none",
            statusTone
          )}
        >
          {statusLabel}
        </span>
      </div>

      <ScrollArea ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="mx-auto w-full min-w-0 max-w-3xl overflow-hidden px-4 py-6 pb-32">
          <div className="min-w-0 space-y-4 overflow-hidden">
            {!isRunning && visibleDurableSummary?.completeness === "complete" && (
              <div className="rounded-lg border border-emerald-300/70 bg-emerald-50/80 px-3 py-2 text-xs leading-relaxed text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                主进程已保存完整记录：{visibleDurableSummary.totalMessages.toLocaleString()} 条消息，
                {visibleDurableSummary.totalChars.toLocaleString()} 字。当前面板仍显示有界快照。
              </div>
            )}
            {visibleDurableSummary?.completeness === "partial" && (
              <div className="rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
                主进程只保存了部分记录：
                {visibleDurableSummary.storageError || "已达到记录存储限制"}。当前内容不完整。
              </div>
            )}
            {visibleDurableSummary?.completeness === "storage_error" && (
              <div className="rounded-lg border border-red-300/70 bg-red-50/80 px-3 py-2 text-xs leading-relaxed text-red-900 dark:border-red-700/60 dark:bg-red-950/30 dark:text-red-200">
                完整记录保存失败：{visibleDurableSummary.storageError || "未知存储错误"}
                。当前内容可能不完整。
              </div>
            )}
            {transcriptPreview?.truncated && (
              <div
                className="rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
                role="status"
              >
                当前消息预览已接收 {transcriptPreview.totalChars.toLocaleString()}{" "}
                字，保留开头和最新内容，中间省略了{" "}
                {transcriptPreview.omittedChars.toLocaleString()} 字；
                {isRunning ? "输出仍在继续。" : "该视图是有界历史快照。"}
              </div>
            )}
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
