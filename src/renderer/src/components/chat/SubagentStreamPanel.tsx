import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Sparkles } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadStateSelector, useThreadStream } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import {
  buildVisibleMessageLayout,
  messageRendersNothing,
  messageVisibleReasoningLength
} from "@/lib/message-display-visibility"
import { buildToolResultAssociations } from "@/lib/worker-tool-result-key"
import {
  getSubagentTranscriptsFromThreadValues,
  mergeSubagentTranscriptPages,
  reconcileTranscriptToolCallsWithResults,
  SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY
} from "@/lib/subagent-transcripts"
import { createSubagentPanelTranscriptProjector } from "@/lib/subagent-panel-transcript"
import {
  buildStreamPanelMessageWindow,
  shiftStreamPanelMessageWindowEnd
} from "@/lib/stream-panel-message-window"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

type DeferredBlobField = "content" | "reasoning" | "tool_calls"

const EMPTY_SUBAGENT_PANEL_MESSAGES: readonly Message[] = []

function deferredBlobFieldLabel(field: DeferredBlobField): string {
  if (field === "content") return "正文"
  if (field === "reasoning") return "推理"
  return "工具调用"
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

export function SubagentStreamPanel(): React.JSX.Element {
  const subagentFocusView = useAppStore((state) => state.subagentFocusView)
  const closeSubagentFocusView = useAppStore((state) => state.closeSubagentFocusView)
  const focusedThreadId = subagentFocusView?.threadId ?? "__subagent_focus_none__"
  const focusedParentThreadId = subagentFocusView?.threadId ?? null
  const focusedSubagentId = subagentFocusView?.subagentId
  const focusedSubagentKey = `${focusedThreadId}\u0000${focusedSubagentId ?? "none"}`
  const baselineMessages =
    useThreadStateSelector(focusedParentThreadId, (state) =>
      focusedSubagentId
        ? (state.subagentTranscripts[focusedSubagentId] ?? EMPTY_SUBAGENT_PANEL_MESSAGES)
        : EMPTY_SUBAGENT_PANEL_MESSAGES
    ) ?? EMPTY_SUBAGENT_PANEL_MESSAGES
  const baselineContentVersion =
    useThreadStateSelector(focusedParentThreadId, (state) =>
      focusedSubagentId
        ? (state.subagentTranscriptContentVersions[focusedSubagentId] ?? 0)
        : 0
    ) ?? 0
  const subagents = useThreadStateSelector(focusedParentThreadId, (state) => state.subagents) ?? []
  const scheduledTaskLoading =
    useThreadStateSelector(focusedParentThreadId, (state) => state.scheduledTaskLoading) ?? false
  const focusedStream = useThreadStream(focusedThreadId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const pendingWindowAnchorRef = useRef<{ messageId: string; viewportTop: number } | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [messageWindowSelection, setMessageWindowSelection] = useState<{
    focusKey: string
    end: number | null
  }>({ focusKey: "", end: null })
  const messageWindowEnd =
    messageWindowSelection.focusKey === focusedSubagentKey
      ? messageWindowSelection.end
      : null
  const [exportingDeferredKey, setExportingDeferredKey] = useState<string | null>(null)
  const [deferredExportStatus, setDeferredExportStatus] = useState<string | null>(null)
  const [hydratedTranscript, setHydratedTranscript] = useState<{
    focusKey: string
    messages: Message[]
    deferredHydration: boolean
    deferredExports: Array<{
      messageIndex: number
      expectedMessageId: string
      fields: DeferredBlobField[]
    }>
    end: number
    start: number
    nextBefore?: number
    total: number
  } | null>(null)
  useEffect(() => {
    if (!focusedSubagentId || focusedThreadId === "__subagent_focus_none__") return
    const focus = { threadId: focusedThreadId, subagentId: focusedSubagentId }
    let cancelled = false
    setLoadingEarlier(false)
    pendingWindowAnchorRef.current = null
    setExportingDeferredKey(null)
    setDeferredExportStatus(null)
    void window.api.threads
      .getSubagentTranscript(focus.threadId, focus.subagentId)
      .then((page) => {
        if (cancelled) return
        const restored = getSubagentTranscriptsFromThreadValues({
          [SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]: {
            [focus.subagentId]: page.messages
          }
        })
        setHydratedTranscript({
          focusKey: `${focus.threadId}\u0000${focus.subagentId}`,
          messages: restored[focus.subagentId] ?? [],
          deferredHydration: page.deferredHydration,
          deferredExports: page.deferredExport ? [page.deferredExport] : [],
          end: page.end,
          start: page.start,
          nextBefore: page.nextBefore,
          total: page.total
        })
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[SubagentStreamPanel] Failed to hydrate full transcript:", error)
        }
      })
    return () => {
      cancelled = true
    }
  }, [focusedSubagentId, focusedThreadId])

  const currentSubagent = useMemo(
    () => subagents.find((subagent) => subagent.id === focusedSubagentId),
    [focusedSubagentId, subagents]
  )
  const parentIsRunning = focusedStream.isLoading || scheduledTaskLoading
  const effectiveStatus =
    currentSubagent?.status ??
    (parentIsRunning
      ? subagentFocusView?.status
      : subagentFocusView?.status === "running"
        ? "cancelled"
        : subagentFocusView?.status)
  const isRunning = effectiveStatus === "running" && parentIsRunning
  const [projectTranscript] = useState(createSubagentPanelTranscriptProjector)
  const persistedPage =
    hydratedTranscript?.focusKey === focusedSubagentKey
      ? hydratedTranscript.messages
      : EMPTY_SUBAGENT_PANEL_MESSAGES
  const transcriptProjection = useMemo(
    () => projectTranscript(persistedPage, baselineMessages, isRunning, baselineContentVersion),
    [baselineContentVersion, baselineMessages, isRunning, persistedPage, projectTranscript]
  )
  const fullMessages = transcriptProjection.messages
  const hiddenMessageCount = useMemo(() => {
    if (hydratedTranscript?.focusKey !== focusedSubagentKey) return 0
    const pageIds = new Set(hydratedTranscript.messages.map((message) => message.id))
    let pinnedPromptCount = 0
    for (const promptId of transcriptProjection.openingPromptIds) {
      if (!pageIds.has(promptId)) pinnedPromptCount += 1
    }
    return Math.max(0, (hydratedTranscript.nextBefore ?? 0) - pinnedPromptCount)
  }, [focusedSubagentKey, hydratedTranscript, transcriptProjection.structureVersion])
  const messageWindow = useMemo(
    () => buildStreamPanelMessageWindow(fullMessages, messageWindowEnd),
    [fullMessages, messageWindowEnd, transcriptProjection.contentVersion]
  )
  const isTailWindow = messageWindow.end >= fullMessages.length
  const messages = useMemo(
    () => reconcileTranscriptToolCallsWithResults(messageWindow.messages),
    [messageWindow.messages]
  )
  const loadEarlier = useCallback(async (): Promise<void> => {
    if (
      loadingEarlier ||
      !focusedSubagentId ||
      hydratedTranscript?.focusKey !== focusedSubagentKey ||
      hydratedTranscript.nextBefore === undefined
    ) {
      return
    }
    const before = hydratedTranscript.nextBefore
    setLoadingEarlier(true)
    try {
      const page = await window.api.threads.getSubagentTranscript(
        focusedThreadId,
        focusedSubagentId,
        before
      )
      const restored = getSubagentTranscriptsFromThreadValues({
        [SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]: {
          [focusedSubagentId]: page.messages
        }
      })
      setHydratedTranscript((current) => {
        if (current?.focusKey !== focusedSubagentKey || current.nextBefore !== before) {
          return current
        }
        return {
          ...current,
          messages: mergeSubagentTranscriptPages(
            restored[focusedSubagentId] ?? [],
            current.messages
          ),
          deferredHydration: current.deferredHydration || page.deferredHydration,
          deferredExports: page.deferredExport
            ? [
                ...current.deferredExports.filter(
                  (item) => item.messageIndex !== page.deferredExport?.messageIndex
                ),
                page.deferredExport
              ]
            : current.deferredExports,
          start: page.start,
          nextBefore: page.nextBefore,
          total: page.total
        }
      })
    } catch (error) {
      console.warn("[SubagentStreamPanel] Failed to hydrate earlier transcript page:", error)
    } finally {
      setLoadingEarlier(false)
    }
  }, [
    focusedSubagentId,
    focusedSubagentKey,
    focusedThreadId,
    hydratedTranscript,
    loadingEarlier
  ])
  const exportDeferredField = useCallback(
    async (
      deferred: {
        messageIndex: number
        expectedMessageId: string
      },
      field: DeferredBlobField
    ): Promise<void> => {
      if (!focusedSubagentId || focusedThreadId === "__subagent_focus_none__") return
      const key = `${deferred.messageIndex}:${field}`
      setExportingDeferredKey(key)
      setDeferredExportStatus(null)
      try {
        const result = await window.api.threads.exportSubagentTranscriptBlob(
          focusedThreadId,
          focusedSubagentId,
          deferred.messageIndex,
          deferred.expectedMessageId,
          field
        )
        if (result.success) {
          setDeferredExportStatus(`完整${deferredBlobFieldLabel(field)}已导出到 ${result.filePath}`)
        } else if (!result.canceled) {
          setDeferredExportStatus(result.error || `完整${deferredBlobFieldLabel(field)}导出失败`)
        }
      } catch (error) {
        setDeferredExportStatus(error instanceof Error ? error.message : String(error))
      } finally {
        setExportingDeferredKey(null)
      }
    },
    [focusedSubagentId, focusedThreadId]
  )
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
    // An older local page has later conversation outside the DOM window. Treat
    // that boundary conservatively as a later turn without scanning the suffix.
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
          viewport.querySelectorAll<HTMLElement>("[data-subagent-stream-message-id]")
        )
        const anchor = direction === "older" ? rows[0] : rows.at(-1)
        if (anchor?.dataset.subagentStreamMessageId) {
          pendingWindowAnchorRef.current = {
            messageId: anchor.dataset.subagentStreamMessageId,
            viewportTop: anchor.getBoundingClientRect().top
          }
        }
      }
      isAtBottomRef.current = false
      setMessageWindowSelection({
        focusKey: focusedSubagentKey,
        end: shiftStreamPanelMessageWindowEnd(
          messageWindow.end,
          fullMessages.length,
          direction
        )
      })
    },
    [focusedSubagentKey, fullMessages.length, getScrollViewport, messageWindow.end]
  )

  const showLatestMessageWindow = useCallback((): void => {
    pendingWindowAnchorRef.current = null
    setMessageWindowSelection({ focusKey: focusedSubagentKey, end: null })
    isAtBottomRef.current = true
    void window.requestAnimationFrame(() => {
      const viewport = getScrollViewport()
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
  }, [focusedSubagentKey, getScrollViewport])

  useLayoutEffect(() => {
    const pendingAnchor = pendingWindowAnchorRef.current
    if (!pendingAnchor) return
    const viewport = getScrollViewport()
    if (!viewport) return
    const target = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-subagent-stream-message-id]")
    ).find((row) => row.dataset.subagentStreamMessageId === pendingAnchor.messageId)
    pendingWindowAnchorRef.current = null
    if (!target) return
    viewport.scrollTop += target.getBoundingClientRect().top - pendingAnchor.viewportTop
  }, [getScrollViewport, messageWindow.end, messageWindow.start])

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
            {hiddenMessageCount > 0 && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={loadingEarlier}
                  onClick={() => void loadEarlier()}
                >
                  {loadingEarlier
                    ? "正在加载更早记录…"
                    : `加载更早记录（剩余 ${hiddenMessageCount} 条）`}
                </Button>
              </div>
            )}
            {hydratedTranscript?.focusKey === focusedSubagentKey &&
              hydratedTranscript.deferredHydration && (
                <div className="rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
                  <div>
                    单条记录超过安全加载上限，当前显示有界摘要；完整内容仍保存在本地 sidecar 中。
                  </div>
                  {hydratedTranscript.deferredExports.map((deferred) => (
                    <div
                      key={`${deferred.messageIndex}:${deferred.expectedMessageId}`}
                      className="mt-2 flex flex-wrap items-center gap-2"
                    >
                      <span>记录 #{deferred.messageIndex + 1}</span>
                      {deferred.fields.map((field) => {
                        const exportKey = `${deferred.messageIndex}:${field}`
                        return (
                          <Button
                            key={field}
                            variant="outline"
                            size="sm"
                            type="button"
                            className="h-7 bg-background/80 px-2 text-xs"
                            disabled={exportingDeferredKey !== null}
                            onClick={() => void exportDeferredField(deferred, field)}
                          >
                            {exportingDeferredKey === exportKey
                              ? "正在导出…"
                              : `导出完整${deferredBlobFieldLabel(field)}（JSON）`}
                          </Button>
                        )
                      })}
                    </div>
                  ))}
                  {deferredExportStatus && <div className="mt-2 break-all">{deferredExportStatus}</div>}
                </div>
              )}
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
                暂无可展示的子代理消息。新的子代理运行过程会实时显示在这里。
              </div>
            )}
            {messages.map((message, index) => {
              if (messageRendersNothing(message)) return null
              const previousMessage = visibleMessageLayout.previousVisibleMessageByIndex[index]
              const isLastMessage = index === visibleMessageLayout.lastVisibleMessageIndex

              return (
                <div key={message.id} data-subagent-stream-message-id={message.id}>
                  <MessageBubble
                    message={message}
                    previousMessage={previousMessage}
                    isStreaming={
                      isRunning && messageWindow.end >= fullMessages.length && isLastMessage
                    }
                    showAssistantMeta={showAssistantMetaByIndex[index] ?? true}
                    toolResults={toolResults}
                    threadId={subagentFocusView.threadId}
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
