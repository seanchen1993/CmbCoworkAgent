import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Loader2, Workflow } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadState } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

type SerializedCheckpointMessage = {
  id?: string | string[]
  _getType?: () => string
  type?: string
  content?: Message["content"]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
  additional_kwargs?: Record<string, unknown>
  kwargs?: {
    id?: string
    type?: string
    content?: Message["content"]
    tool_calls?: Message["tool_calls"]
    tool_call_id?: string
    name?: string
    additional_kwargs?: Record<string, unknown>
  }
}

type ThreadHistoryEntry = {
  checkpoint?: {
    channel_values?: {
      messages?: unknown[]
    }
  }
}

const WORKER_THINKING_MESSAGES = [
  "我先想想...",
  "让我捋一捋...",
  "我去翻翻代码...",
  "我来找线索...",
  "先做个判断...",
  "我再核对一下...",
  "先把思路摊开...",
  "我来拼一下答案...",
  "我再压一遍细节...",
  "先看下上下文...",
  "我再过一遍日志...",
  "我来换个角度...",
  "先把重点抓出来...",
  "让我算一轮...",
  "我再确认一下...",
  "我先试条路...",
  "我去查个依据...",
  "我先把话说准...",
  "我再补一刀...",
  "我来收个尾...",
  "先别急，快到了...",
  "差最后一段了...",
  "我再润一润...",
  "再给我两秒...",
  "我来给你个稳妥版...",
  "我先把坑绕开...",
  "我再压压风险...",
  "先把答案打磨下...",
  "马上给你结果...",
  "就快好了..."
]

function messageRoleFromCheckpoint(message: SerializedCheckpointMessage): Message["role"] {
  if (typeof message._getType === "function") {
    const type = message._getType()
    if (type === "human") return "user"
    if (type === "tool") return "tool"
    if (type === "system") return "system"
    return "assistant"
  }

  const classId = Array.isArray(message.id) ? message.id : []
  const className = classId[classId.length - 1] || ""
  if (className.includes("HumanMessage")) return "user"
  if (className.includes("ToolMessage")) return "tool"
  if (className.includes("SystemMessage")) return "system"
  if (className.includes("AIMessage")) return "assistant"

  const type = message.type ?? message.kwargs?.type
  if (type === "human") return "user"
  if (type === "user") return "user"
  if (type === "tool") return "tool"
  if (type === "system") return "system"
  if (type === "ai" || type === "assistant") return "assistant"
  return "assistant"
}

function messageFromCheckpoint(
  message: SerializedCheckpointMessage,
  index: number
): Message | null {
  const additionalKwargs = message.additional_kwargs ?? message.kwargs?.additional_kwargs
  if (additionalKwargs?.cmb_internal_coordinator_notification === true) return null

  const role = messageRoleFromCheckpoint(message)
  if (role === "system") return null

  const rawContent = message.content ?? message.kwargs?.content
  const content: Message["content"] =
    typeof rawContent === "string" || Array.isArray(rawContent) ? rawContent : ""
  const toolCalls = message.tool_calls ?? message.kwargs?.tool_calls
  const toolCallId = message.tool_call_id ?? message.kwargs?.tool_call_id
  const toolName = message.name ?? message.kwargs?.name
  const messageId =
    message.kwargs?.id ?? (typeof message.id === "string" ? message.id : `worker-msg-${index}`)

  return {
    id: messageId,
    role,
    content,
    tool_calls: toolCalls,
    ...(role === "tool" && toolCallId && { tool_call_id: toolCallId }),
    ...(role === "tool" && toolName && { name: toolName }),
    created_at: new Date()
  }
}

function mergeMessages(baseMessages: Message[], liveMessages: Message[]): Message[] {
  const merged: Message[] = [...baseMessages]
  const indexById = new Map(merged.map((message, index) => [message.id, index]))

  for (const live of liveMessages) {
    const index = indexById.get(live.id)
    if (index === undefined) {
      indexById.set(live.id, merged.length)
      merged.push(live)
      continue
    }

    const existing = merged[index]
    merged[index] = {
      ...existing,
      ...live,
      content:
        live.content === "" || (Array.isArray(live.content) && live.content.length === 0)
          ? existing.content
          : live.content,
      tool_calls:
        live.tool_calls && live.tool_calls.length > 0 ? live.tool_calls : existing.tool_calls
    }
  }

  return merged
}

function buildToolResults(messages: Message[]): Map<string, { content: string | unknown; is_error?: boolean }> {
  const results = new Map<string, { content: string | unknown; is_error?: boolean }>()
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      results.set(message.tool_call_id, {
        content: message.content,
        is_error: false
      })
    }
  }
  return results
}

function messageContentLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0

  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
}

export function WorkerStreamPanel(): React.JSX.Element {
  const workerFocusView = useAppStore((state) => state.workerFocusView)
  const workerFocusMessages = useAppStore((state) => state.workerFocusMessages)
  const closeWorkerFocusView = useAppStore((state) => state.closeWorkerFocusView)
  const [historyMessages, setHistoryMessages] = useState<Message[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const thinkingCycleRef = useRef(-1)
  const wasRunningRef = useRef(false)
  const runningMessageCountRef = useRef(0)
  const isAtBottomRef = useRef(true)
  const threadState = useThreadState(workerFocusView?.threadId ?? null)
  const currentWorker = threadState?.coordinatorWorkers.find(
    (worker) => worker.worker_id === workerFocusView?.workerId
  )
  const isRunning = currentWorker?.status === "running"

  useEffect(() => {
    if (!workerFocusView?.workerThreadId) return

    let cancelled = false
    void (async () => {
      setLoadingHistory(true)
      try {
        const latestCheckpoint = (await window.api.threads.getLatestCheckpoint(
          workerFocusView.workerThreadId
        )) as ThreadHistoryEntry | null
        if (cancelled) return
        const rawMessages = latestCheckpoint?.checkpoint?.channel_values?.messages
        if (!Array.isArray(rawMessages)) {
          setHistoryMessages([])
          return
        }

        setHistoryMessages(
          rawMessages
            .map((message, index) =>
              messageFromCheckpoint(message as SerializedCheckpointMessage, index)
            )
            .filter((message): message is Message => message !== null)
        )
      } catch (error) {
        console.error("[WorkerStreamPanel] Failed to load worker checkpoint:", error)
        if (!cancelled) setHistoryMessages([])
      } finally {
        if (!cancelled) setLoadingHistory(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [workerFocusView?.workerThreadId])

  const messages = useMemo(
    () => mergeMessages(historyMessages, workerFocusMessages),
    [historyMessages, workerFocusMessages]
  )
  const toolResults = useMemo(() => buildToolResults(messages), [messages])
  const getScrollViewport = useCallback((): HTMLDivElement | null => {
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [])
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
      workerFocusMessages.length,
      isRunning ? "running" : "idle"
    ].join(":")
  }, [messages, toolResults.size, workerFocusMessages.length, isRunning])

  useEffect(() => {
    isAtBottomRef.current = true
  }, [workerFocusView?.workerThreadId])

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport) return

    viewport.addEventListener("scroll", updateIsAtBottom, { passive: true })
    updateIsAtBottom()

    return () => {
      viewport.removeEventListener("scroll", updateIsAtBottom)
    }
  }, [getScrollViewport, updateIsAtBottom, workerFocusView?.workerThreadId])

  useEffect(() => {
    if (!isRunning) {
      wasRunningRef.current = false
      runningMessageCountRef.current = 0
      return
    }

    if (!wasRunningRef.current) {
      thinkingCycleRef.current =
        (thinkingCycleRef.current + 1) % WORKER_THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      runningMessageCountRef.current = messages.length
      wasRunningRef.current = true
      return
    }

    if (messages.length > runningMessageCountRef.current) {
      thinkingCycleRef.current =
        (thinkingCycleRef.current + 1) % WORKER_THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      runningMessageCountRef.current = messages.length
    }
  }, [isRunning, messages.length])

  useEffect(() => {
    const viewport = getScrollViewport()
    if (!viewport || !isAtBottomRef.current) return

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
      updateIsAtBottom()
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [getScrollViewport, scrollSignature, updateIsAtBottom])

  if (!workerFocusView) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        未选择 worker
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
            onClick={closeWorkerFocusView}
            className="h-7 w-9 p-0"
            title="返回"
            aria-label="返回"
          >
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <Workflow className="size-3.5 shrink-0 text-stone-500" />
          <div className="min-w-0 truncate text-sm font-semibold text-foreground">
            Worker 工具流
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {workerFocusView.description || workerFocusView.workerId}
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
            {loadingHistory && messages.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在恢复 worker checkpoint...
              </div>
            )}
            {!loadingHistory && messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                暂无可展示的 worker 消息。运行中的后续工具流会实时显示在这里。
              </div>
            )}
            {messages.map((message, index) => {
              const previousMessage = index > 0 ? messages[index - 1] : null
              const isLastMessage = index === messages.length - 1
              const nextNonToolMessage =
                messages.slice(index + 1).find((candidate) => candidate.role !== "tool") ?? null
              const showAssistantMeta =
                message.role !== "assistant" ||
                !nextNonToolMessage ||
                nextNonToolMessage.role !== "assistant"

              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  previousMessage={previousMessage}
                  isStreaming={isRunning && isLastMessage}
                  showAssistantMeta={showAssistantMeta}
                  toolResults={toolResults}
                  threadId={workerFocusView.threadId}
                  isLoading={isRunning}
                />
              )
            })}
            {isRunning && (
              <div className="flex items-center gap-2 text-sm">
                <div className="rainbow-spinner" />
                <span
                  className="thinking-shimmer-text"
                  data-text={WORKER_THINKING_MESSAGES[thinkingMessageIndex]}
                >
                  {WORKER_THINKING_MESSAGES[thinkingMessageIndex]}
                </span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
