import { useCallback, useEffect, useMemo, useRef } from "react"
import { ArrowLeft, Sparkles } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadState } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import { ElectronIPCTransport } from "@/lib/electron-transport"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import { getWorkerToolResultKey } from "@/lib/worker-tool-result-key"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

/**
 * Live tool-stream of ONE dynamic-workflow subagent (display-only). Fed by the
 * best-effort main-process "values" tap → `agent:workflow-agent-stream` → the store's
 * per-agent raw-snapshot buffer (`workflowAgentRawSnapshots`), converted here lazily
 * for the focused agent. Renders identically to the coordinator/solo tool streams
 * (MessageBubble + rainbow-spinner). NOT persisted: after a reload, or for a
 * cached/replayed agent, there is no buffer and we show a note instead.
 */

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

function statusBadge(status: string | undefined): { label: string; className: string } {
  switch (status) {
    case "running":
      return {
        label: "运行中",
        className: "border-blue-300/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
      }
    case "completed":
      return {
        label: "已完成",
        className: "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      }
    case "error":
      return {
        label: "失败",
        className: "border-red-300/60 bg-red-500/10 text-red-700 dark:text-red-300"
      }
    case "cached":
      return {
        label: "缓存",
        className: "border-violet-300/60 bg-violet-500/10 text-violet-700 dark:text-violet-300"
      }
    default:
      return {
        label: "历史快照",
        className:
          "border-stone-300/80 bg-stone-100/70 text-stone-700 dark:border-stone-700 dark:bg-stone-900/45 dark:text-stone-300"
      }
  }
}

export function WorkflowAgentStreamPanel(): React.JSX.Element {
  const workflowAgentFocusView = useAppStore((state) => state.workflowAgentFocusView)
  // Read the focused agent's latest RAW snapshot atomically from state (buffered by
  // the run-level subscription for every agent), then convert lazily below.
  const rawSnapshot = useAppStore((state) => {
    const view = state.workflowAgentFocusView
    if (!view) return undefined
    return state.workflowAgentRawSnapshots.get(`${view.runId}:${view.agentIndex}`)
  })
  const closeWorkflowAgentFocusView = useAppStore((state) => state.closeWorkflowAgentFocusView)
  const transport = useMemo(() => new ElectronIPCTransport(), [])
  const threadState = useThreadState(workflowAgentFocusView?.threadId ?? null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  // Live status comes from the workflow run view (kept in ThreadState by the
  // workflow_progress events), falling back to the click-time status. CRITICAL:
  // threadState.workflowRun always holds the CURRENT run, so after a run
  // replacement/reload its same-index agent is a DIFFERENT agent — only trust it when
  // its runId matches the focused view's runId, else the panel would show another run's
  // status for the agent the user actually selected.
  const liveRun = threadState?.workflowRun
  const isFocusedRunLive =
    !!liveRun && !!workflowAgentFocusView && liveRun.runId === workflowAgentFocusView.runId
  const agentView = useMemo(() => {
    if (!isFocusedRunLive || !liveRun || !workflowAgentFocusView) return undefined
    return liveRun.agents.find((agent) => agent.agentIndex === workflowAgentFocusView.agentIndex)
  }, [isFocusedRunLive, liveRun, workflowAgentFocusView])
  const status = agentView?.status ?? workflowAgentFocusView?.status
  // The running UI (waiting note + rainbow-spinner) is gated on the focused run being
  // the current, still-running run — never on the frozen click-time status alone, so a
  // cleared/replaced/reloaded run can't strand a perpetual spinner (display-only).
  const isRunning = status === "running" && isFocusedRunLive && liveRun?.status === "running"
  const isCached = status === "cached"

  const messages = useMemo(
    () =>
      workflowAgentFocusView && rawSnapshot
        ? transport.convertWorkflowAgentValuesSnapshot(
            rawSnapshot,
            `wfagent:${workflowAgentFocusView.runId}:${workflowAgentFocusView.agentIndex}`
          )
        : [],
    [transport, rawSnapshot, workflowAgentFocusView]
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
    const scroll = (): void => {
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
  }, [scrollToBottom, workflowAgentFocusView?.runId, workflowAgentFocusView?.agentIndex])

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
    workflowAgentFocusView?.runId,
    workflowAgentFocusView?.agentIndex
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

  if (!workflowAgentFocusView) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        未选择子代理
      </div>
    )
  }

  // A frozen click-time "running" status on a run that is no longer the live one would
  // show a "运行中" pill above the neutral ended/reloaded body (isRunning is gated on
  // liveness) — downgrade that stale "running" to a neutral badge so pill and body agree.
  const badge = statusBadge(status === "running" && !isRunning ? undefined : status)

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-grid-subtle">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background/85 px-2.5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => closeWorkflowAgentFocusView()}
            className="h-7 w-9 p-0"
            title="返回"
            aria-label="返回"
          >
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <Sparkles className="size-3.5 shrink-0 text-violet-500" />
          <div className="min-w-0 truncate text-sm font-semibold text-foreground">
            子代理工具流
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {workflowAgentFocusView.label}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none",
            badge.className
          )}
        >
          {badge.label}
        </span>
      </div>

      <ScrollArea ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="mx-auto w-full min-w-0 max-w-3xl overflow-hidden px-4 py-6 pb-32">
          <div className="min-w-0 space-y-4 overflow-hidden">
            {messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                {isRunning
                  ? "正在等待子代理的工具调用……"
                  : isCached
                    ? "该子代理为缓存复用结果，没有实时工具流记录。"
                    : "该子代理本次运行没有可显示的实时工具流（可能已结束、未在运行时查看，或已重新加载）。可在「运行历史」中查看结果。"}
              </div>
            )}
            {messages.map((message, index) => {
              if (message.role === "tool") return null
              const previousMessage = index > 0 ? messages[index - 1] : null
              const isLastMessage = index >= lastNonToolMessageIndex
              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  previousMessage={previousMessage}
                  isStreaming={isRunning && isLastMessage}
                  showAssistantMeta={showAssistantMetaByIndex[index] ?? true}
                  toolResults={toolResults}
                  threadId={workflowAgentFocusView.threadId}
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
                <span className="thinking-shimmer-text" data-text="子代理工具调用进行中...">
                  子代理工具调用进行中...
                </span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
