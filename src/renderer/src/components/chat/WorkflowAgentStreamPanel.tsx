import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Sparkles } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadState } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import { ElectronIPCTransport } from "@/lib/electron-transport"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import {
  buildVisibleMessageLayout,
  messageRendersNothing,
  messageVisibleReasoningLength
} from "@/lib/message-display-visibility"
import { buildToolResultAssociations } from "@/lib/worker-tool-result-key"
import {
  buildStreamPanelMessageWindow,
  createStreamPanelMessageProjector,
  shiftStreamPanelMessageWindowEnd
} from "@/lib/stream-panel-message-window"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

/**
 * Tool-stream of ONE dynamic-workflow subagent (display-only), loaded ON DEMAND for the
 * focused agent and released on switch/close — so only the agent you're viewing costs
 * memory. A RUNNING agent streams live (per-agent interest → `agent:workflow-agent-stream`
 * → `workflowAgentFocusSnapshot`); a FINISHED agent's complete flow is read lazily from
 * its persisted sidecar via `workflows.getAgentToolStream`. Renders identically to the
 * coordinator/solo tool streams (MessageBubble + rainbow-spinner). A cached/instant agent
 * (no captured flow) shows a neutral note.
 */

// Short retries when a finished agent's sidecar read returns null, to cover the window
// before its fire-and-forget write has flushed (see the fallback effect below).
const WORKFLOW_AGENT_TOOLSTREAM_RETRY_MS = 300
const WORKFLOW_AGENT_TOOLSTREAM_MAX_RETRIES = 5

function messageContentLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
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
  // The CURRENTLY-focused agent's raw snapshot (a single agent), loaded on demand by the
  // effects below — live frames while it runs, or its persisted sidecar when finished —
  // and released on switch/close. THREE states: `undefined` = loading / not yet loaded,
  // `null` = loaded but empty (no flow), an array = the flow. Converted lazily further down.
  const focusSnapshot = useAppStore((state) => state.workflowAgentFocusSnapshot)
  const closeWorkflowAgentFocusView = useAppStore((state) => state.closeWorkflowAgentFocusView)
  const transport = useMemo(() => new ElectronIPCTransport(), [])
  const threadState = useThreadState(workflowAgentFocusView?.threadId ?? null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const pendingWindowAnchorRef = useRef<{ messageId: string; viewportTop: number } | null>(null)
  const [messageWindowSelection, setMessageWindowSelection] = useState<{
    focusKey: string
    end: number | null
  }>({ focusKey: "", end: null })

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

  // Load THIS agent's tool stream on demand and release it on switch/close — only the
  // agent you're viewing ever streams or holds memory. Two effects keyed on identity +
  // isRunning, so a running→finished transition is handled WITHOUT a flash:
  //  (1) Live: subscribe ONLY while the agent is the current, running one; on teardown we
  //      KEEP the last live frame (cumulative = the complete flow).
  //  (2) Fallback: when NOT running and no live frame arrived (finished/historical agent,
  //      OR you clicked right at completion), read the persisted sidecar once.
  // Destructured to primitives so the effect deps don't depend on the view object identity.
  const focusThreadId = workflowAgentFocusView?.threadId
  const focusRunId = workflowAgentFocusView?.runId
  const focusAgentIndex = workflowAgentFocusView?.agentIndex
  const messageWindowFocusKey = `${focusThreadId ?? ""}\u0000${focusRunId ?? ""}\u0000${focusAgentIndex ?? -1}`
  const messageWindowEnd =
    messageWindowSelection.focusKey === messageWindowFocusKey
      ? messageWindowSelection.end
      : null
  useEffect(() => {
    if (focusThreadId == null || focusRunId == null || focusAgentIndex == null) return
    if (!isRunning) return
    void window.api.workflows.setAgentStreamInterest(
      focusThreadId,
      focusRunId,
      focusAgentIndex,
      true
    )
    const unsubscribe = window.api.workflows.onWorkflowAgentStream(focusThreadId, (payload) => {
      const data = payload as { runId?: string; agentIndex?: number; snapshotMessages?: unknown }
      if (data.runId !== focusRunId || data.agentIndex !== focusAgentIndex) return
      // A live frame can land AFTER a focus switch but BEFORE this listener unsubscribes; the
      // snapshot is GLOBAL, so re-check THIS agent is still the focus before writing — otherwise a
      // stale frame from the previous agent overwrites the new panel. (Effect 2 only fills an
      // `undefined` snapshot, so a finished / no-sidecar agent would then keep showing the wrong flow.)
      const cur = useAppStore.getState().workflowAgentFocusView
      if (
        cur?.threadId !== focusThreadId ||
        cur?.runId !== focusRunId ||
        cur?.agentIndex !== focusAgentIndex
      )
        return
      useAppStore.getState().setWorkflowAgentFocusSnapshot(data.snapshotMessages)
    })
    return () => {
      void window.api.workflows.setAgentStreamInterest(
        focusThreadId,
        focusRunId,
        focusAgentIndex,
        false
      )
      unsubscribe()
      // Keep the last live frame; effect (2) decides whether a sidecar reload is needed.
    }
  }, [focusThreadId, focusRunId, focusAgentIndex, isRunning])

  useEffect(() => {
    if (focusThreadId == null || focusRunId == null || focusAgentIndex == null) return
    if (isRunning) return
    // The agent is finished → load its AUTHORITATIVE sidecar (the complete flow). This runs
    // on focus-switch and on the running→finished transition, replacing any (possibly
    // incomplete) last live frame. Deps are identity+isRunning only, so it never loops; a
    // re-click of the same agent is a store no-op, so we don't need to react to that here.
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    // `cancelled` only catches frames that resolve AFTER React runs this effect's PASSIVE cleanup.
    // A focus switch A→B updates the store synchronously but DEFERS the cleanup to the passive phase,
    // so a sidecar promise (or a fired retry) resolving in that gap still sees cancelled=false. Re-check
    // the LIVE focus identity (same guard as the live callback) before writing the GLOBAL snapshot —
    // else A's complete flow lands on B's panel and, since B's empty load won't overwrite a non-undefined
    // snapshot, sticks until the user reopens.
    const isStillFocused = (): boolean => {
      const cur = useAppStore.getState().workflowAgentFocusView
      return (
        cur?.threadId === focusThreadId &&
        cur?.runId === focusRunId &&
        cur?.agentIndex === focusAgentIndex
      )
    }
    const load = (): void => {
      void window.api.workflows
        .getAgentToolStream(focusThreadId, focusRunId, focusAgentIndex)
        .then((loaded) => {
          if (cancelled || !isStillFocused()) return
          if (loaded != null) {
            // Authoritative complete flow — overwrite whatever (live frame / loading) we had.
            useAppStore.getState().setWorkflowAgentFocusSnapshot(loaded)
            return
          }
          // null: the sidecar is written fire-and-forget; retry with backoff before
          // concluding there is no flow (and never clobber a live frame with an empty).
          // The backoff window (~7s) covers even a slow disk, so the user rarely needs to
          // reopen; a write slower than that is disk-failure territory.
          if (attempts < WORKFLOW_AGENT_TOOLSTREAM_MAX_RETRIES) {
            const delay = Math.min(WORKFLOW_AGENT_TOOLSTREAM_RETRY_MS * 2 ** attempts, 2400)
            attempts += 1
            retryTimer = setTimeout(load, delay)
            return
          }
          if (useAppStore.getState().workflowAgentFocusSnapshot === undefined) {
            useAppStore.getState().setWorkflowAgentFocusSnapshot(null)
          }
        })
        .catch(() => {
          if (cancelled || !isStillFocused()) return
          if (useAppStore.getState().workflowAgentFocusSnapshot === undefined) {
            useAppStore.getState().setWorkflowAgentFocusSnapshot(null)
          }
        })
    }
    load()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [focusThreadId, focusRunId, focusAgentIndex, isRunning])

  // Release the focused snapshot on unmount (thread/view switch). Switching agents within
  // the panel already clears it via openWorkflowAgentFocusView; this covers the unmount.
  useEffect(() => {
    return () => {
      useAppStore.getState().setWorkflowAgentFocusSnapshot(undefined)
    }
  }, [])

  const convertedMessages = useMemo(
    () =>
      workflowAgentFocusView && focusSnapshot
        ? transport.convertWorkflowAgentValuesSnapshot(
            focusSnapshot,
            `wfagent:${workflowAgentFocusView.runId}:${workflowAgentFocusView.agentIndex}`
          )
        : [],
    [transport, focusSnapshot, workflowAgentFocusView]
  )
  const [projectMessages] = useState(createStreamPanelMessageProjector)
  const messageProjection = useMemo(
    () => projectMessages(convertedMessages, isRunning),
    [convertedMessages, isRunning, projectMessages]
  )
  const fullMessages = messageProjection.messages
  const messageWindow = useMemo(
    () => buildStreamPanelMessageWindow(fullMessages, messageWindowEnd),
    [fullMessages, messageProjection.contentVersion, messageWindowEnd]
  )
  const isTailWindow = messageWindow.end >= fullMessages.length
  const messages = messageWindow.messages
  const toolResults = useMemo(() => buildToolResultAssociations(messages), [messages])
  const { assistantDurationMsById, userSendTimeLabelById } = useMemo(
    () => buildMessageBubbleTimingMeta(messages),
    [messages]
  )
  const showAssistantMetaByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let nextVisibleMessage: Message | null = null
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (messageRendersNothing(message)) {
        result[index] = false
        continue
      }
      result[index] =
        message.role !== "assistant" ||
        !nextVisibleMessage ||
        nextVisibleMessage.role !== "assistant"
      nextVisibleMessage = message
    }
    return result
  }, [messages])
  const hasUserAfterHeadByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let hasUserAfterHead = messageWindow.end < fullMessages.length
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      result[index] = hasUserAfterHead
      if (!messageRendersNothing(messages[index]) && messages[index].role === "user") {
        hasUserAfterHead = true
      }
    }
    return result
  }, [fullMessages.length, messageWindow.end, messages])
  const visibleMessageLayout = useMemo(
    () => buildVisibleMessageLayout(messages, (message) => !messageRendersNothing(message)),
    [messages]
  )

  const getScrollViewport = useCallback((): HTMLDivElement | null => {
    const root = scrollRef.current
    if (!root) return null
    if (root.matches("[data-radix-scroll-area-viewport]")) return root
    return root.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null
  }, [])

  const shiftMessageWindow = useCallback(
    (direction: "older" | "newer"): void => {
      const viewport = getScrollViewport()
      if (viewport) {
        const rows = Array.from(
          viewport.querySelectorAll<HTMLElement>("[data-workflow-agent-stream-message-id]")
        )
        const anchor = direction === "older" ? rows[0] : rows.at(-1)
        if (anchor?.dataset.workflowAgentStreamMessageId) {
          pendingWindowAnchorRef.current = {
            messageId: anchor.dataset.workflowAgentStreamMessageId,
            viewportTop: anchor.getBoundingClientRect().top
          }
        }
      }
      isAtBottomRef.current = false
      setMessageWindowSelection({
        focusKey: messageWindowFocusKey,
        end: shiftStreamPanelMessageWindowEnd(
          messageWindow.end,
          fullMessages.length,
          direction
        )
      })
    },
    [fullMessages.length, getScrollViewport, messageWindow.end, messageWindowFocusKey]
  )

  const showLatestMessageWindow = useCallback((): void => {
    pendingWindowAnchorRef.current = null
    setMessageWindowSelection({ focusKey: messageWindowFocusKey, end: null })
    isAtBottomRef.current = true
    void window.requestAnimationFrame(() => {
      const viewport = getScrollViewport()
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
  }, [getScrollViewport, messageWindowFocusKey])

  useLayoutEffect(() => {
    const pendingAnchor = pendingWindowAnchorRef.current
    if (!pendingAnchor) return
    const viewport = getScrollViewport()
    if (!viewport) return
    const target = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-workflow-agent-stream-message-id]")
    ).find((row) => row.dataset.workflowAgentStreamMessageId === pendingAnchor.messageId)
    pendingWindowAnchorRef.current = null
    if (!target) return
    viewport.scrollTop += target.getBoundingClientRect().top - pendingAnchor.viewportTop
  }, [getScrollViewport, messageWindow.end, messageWindow.start])

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
    isAtBottomRef.current = isTailWindow && bottomDistance < 50
  }, [getScrollViewport, isTailWindow])

  const scrollSignature = useMemo(() => {
    const lastMessage = messages[visibleMessageLayout.lastVisibleMessageIndex]
    return [
      fullMessages.length,
      messageWindow.start,
      messageWindow.end,
      lastMessage?.id ?? "",
      lastMessage?.role ?? "",
      messageContentLength(lastMessage?.content),
      messageVisibleReasoningLength(lastMessage),
      lastMessage?.tool_calls?.length ?? 0,
      toolResults.size,
      isRunning ? "running" : "idle"
    ].join(":")
  }, [
    fullMessages.length,
    isRunning,
    messageWindow.end,
    messageWindow.start,
    messages,
    toolResults.size,
    visibleMessageLayout.lastVisibleMessageIndex
  ])

  useEffect(() => {
    pendingWindowAnchorRef.current = null
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
            {(messageWindow.start > 0 || messageWindow.end < fullMessages.length) && (
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-border/60 bg-background/75 px-2 py-1.5 text-[11px] text-muted-foreground">
                <span>
                  当前显示 {messageWindow.start + 1}–{messageWindow.end} / {fullMessages.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="h-7 px-2 text-xs"
                  disabled={messageWindow.start === 0}
                  onClick={() => shiftMessageWindow("older")}
                >
                  前一页
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="h-7 px-2 text-xs"
                  disabled={messageWindow.end >= fullMessages.length}
                  onClick={() => shiftMessageWindow("newer")}
                >
                  后一页
                </Button>
                {messageWindow.end < fullMessages.length && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className="h-7 px-2 text-xs"
                    onClick={showLatestMessageWindow}
                  >
                    最新
                  </Button>
                )}
              </div>
            )}
            {fullMessages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                {isRunning
                  ? "正在等待子代理的工具调用……"
                  : isCached
                    ? "该子代理为缓存复用结果，没有实时工具流记录。"
                    : focusSnapshot === undefined
                      ? "正在加载该子代理的工具流……"
                      : "该子代理本次运行没有捕获到工具流（缓存复用、未产生工具调用，或运行记录已被清理）。"}
              </div>
            )}
            {messages.map((message, index) => {
              if (messageRendersNothing(message)) return null
              const previousMessage = visibleMessageLayout.previousVisibleMessageByIndex[index]
              const isLastMessage = index === visibleMessageLayout.lastVisibleMessageIndex
              return (
                <div key={message.id} data-workflow-agent-stream-message-id={message.id}>
                  <MessageBubble
                    message={message}
                    previousMessage={previousMessage}
                    isStreaming={
                      isRunning && messageWindow.end >= fullMessages.length && isLastMessage
                    }
                    showAssistantMeta={showAssistantMetaByIndex[index] ?? true}
                    toolResults={toolResults}
                    threadId={workflowAgentFocusView.threadId}
                    isLoading={isRunning}
                    hasUserAfterHead={hasUserAfterHeadByIndex[index] ?? false}
                    assistantDurationMs={assistantDurationMsById.get(message.id)}
                    userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
                  />
                </div>
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
