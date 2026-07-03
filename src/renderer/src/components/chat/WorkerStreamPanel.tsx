import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ArrowLeft, Loader2, Workflow } from "lucide-react"
import { MessageBubble } from "./MessageBubble"
import { HookLogChip, HookLogModal } from "./HookLogViews"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useThreadContext, useThreadState, type HookLogBucket } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import { getWorkerToolResultKey } from "@/lib/worker-tool-result-key"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

const MAX_WORKER_SIGNATURE_CHARS = 512
const MAX_WORKER_HISTORY_MESSAGES = 500
const EMPTY_WORKER_HOOK_LOG_BUCKETS: HookLogBucket[] = []

type SerializedCheckpointMessage = {
  id?: string | string[]
  _getType?: () => string
  type?: string
  content?: Message["content"]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
  status?: string
  is_error?: boolean
  additional_kwargs?: Record<string, unknown>
  kwargs?: {
    id?: string
    type?: string
    content?: Message["content"]
    tool_calls?: Message["tool_calls"]
    tool_call_id?: string
    name?: string
    status?: string
    is_error?: boolean
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

function createWorkerSnapshotFallbackMessageId(index: number): string {
  return `worker-snapshot-${index}`
}

function isWorkerSnapshotMessageId(id: string): boolean {
  return id.startsWith("worker-snapshot-")
}

function isWorkerNonSnapshotMessageId(id: string): boolean {
  return !isWorkerSnapshotMessageId(id)
}

function isWorkerSnapshotPair(a: Message, b: Message): boolean {
  return (
    (isWorkerSnapshotMessageId(a.id) && isWorkerNonSnapshotMessageId(b.id)) ||
    (isWorkerNonSnapshotMessageId(a.id) && isWorkerSnapshotMessageId(b.id))
  )
}

function isSameWorkerAssistantText(a: Message, b: Message): boolean {
  if (a.role !== "assistant" || b.role !== "assistant") return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (a.tool_calls?.length || b.tool_calls?.length) return false
  if (typeof a.content !== "string" || typeof b.content !== "string") return false
  const first = a.content.trim()
  const second = b.content.trim()
  if (!first || !second) return false
  return first.includes(second) || second.includes(first)
}

function findSameWorkerAssistantTextIndex(messages: Message[], message: Message): number | undefined {
  const index = messages.findIndex((item) => isSameWorkerAssistantText(item, message))
  return index >= 0 ? index : undefined
}

function incrementSignatureCount(map: Map<string, number>, signature: string | undefined): void {
  if (!signature) return
  map.set(signature, (map.get(signature) ?? 0) + 1)
}

function takeWindowedSignatureMatch(
  indexes: number[] | undefined,
  remainingBySignature: Map<string, number>,
  signature: string | undefined
): number | undefined {
  if (!indexes?.length || !signature) return undefined
  const remaining = remainingBySignature.get(signature) ?? 0
  if (remaining <= 0) return indexes.shift()

  // If the same text appears in multiple worker turns, live messages usually
  // belong to the most recent slice. Match the last N compatible snapshots
  // instead of blindly consuming the oldest one.
  const matchPosition = Math.max(0, indexes.length - remaining)
  const [index] = indexes.splice(matchPosition, 1)
  remainingBySignature.set(signature, remaining - 1)
  return index
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
  const toolStatus = message.status ?? message.kwargs?.status
  const isToolError =
    message.is_error === true ||
    message.kwargs?.is_error === true ||
    additionalKwargs?.is_error === true ||
    toolStatus === "error"
  const messageId =
    message.kwargs?.id ??
    (typeof message.id === "string" ? message.id : createWorkerSnapshotFallbackMessageId(index))

  return {
    id: messageId,
    role,
    content,
    tool_calls: toolCalls,
    ...(role === "tool" && toolCallId && { tool_call_id: toolCallId }),
    ...(role === "tool" && toolName && { name: toolName }),
    ...(role === "tool" && toolStatus && { status: toolStatus }),
    ...(role === "tool" && isToolError && { is_error: true }),
    created_at: new Date()
  }
}

function mergeMessages(baseMessages: Message[], liveMessages: Message[]): Message[] {
  if (baseMessages.length === 0) return liveMessages
  if (liveMessages.length === 0) return baseMessages

  const merged: Message[] = [...baseMessages]
  const indexById = new Map(merged.map((message, index) => [message.id, index]))
  const snapshotIndexesBySignature = new Map<string, number[]>()
  const liveIndexesBySignature = new Map<string, number[]>()
  const incomingLiveCountsBySignature = new Map<string, number>()
  const incomingSnapshotCountsBySignature = new Map<string, number>()
  for (const message of liveMessages) {
    const signature = workerFocusMessageSignature(message)
    if (isWorkerNonSnapshotMessageId(message.id)) {
      incrementSignatureCount(incomingLiveCountsBySignature, signature)
    }
    if (isWorkerSnapshotMessageId(message.id)) {
      incrementSignatureCount(incomingSnapshotCountsBySignature, signature)
    }
  }
  merged.forEach((message, index) => {
    const signature = workerFocusMessageSignature(message)
    if (signature && isWorkerSnapshotMessageId(message.id)) {
      const indexes = snapshotIndexesBySignature.get(signature) ?? []
      indexes.push(index)
      snapshotIndexesBySignature.set(signature, indexes)
    }
    if (signature && isWorkerNonSnapshotMessageId(message.id)) {
      const indexes = liveIndexesBySignature.get(signature) ?? []
      indexes.push(index)
      liveIndexesBySignature.set(signature, indexes)
    }
  })

  for (const live of liveMessages) {
    const signature = workerFocusMessageSignature(live)
    const index =
      indexById.get(live.id) ??
      (signature && isWorkerNonSnapshotMessageId(live.id)
        ? takeWindowedSignatureMatch(
            snapshotIndexesBySignature.get(signature),
            incomingLiveCountsBySignature,
            signature
          )
        : undefined) ??
      (signature && isWorkerSnapshotMessageId(live.id)
        ? takeWindowedSignatureMatch(
            liveIndexesBySignature.get(signature),
            incomingSnapshotCountsBySignature,
            signature
          )
        : undefined) ??
      findSameWorkerAssistantTextIndex(merged, live)
    if (index === undefined) {
      indexById.set(live.id, merged.length)
      if (signature && isWorkerSnapshotMessageId(live.id)) {
        const indexes = snapshotIndexesBySignature.get(signature) ?? []
        indexes.push(merged.length)
        snapshotIndexesBySignature.set(signature, indexes)
      }
      if (signature && isWorkerNonSnapshotMessageId(live.id)) {
        const indexes = liveIndexesBySignature.get(signature) ?? []
        indexes.push(merged.length)
        liveIndexesBySignature.set(signature, indexes)
      }
      merged.push(live)
      continue
    }

    const existing = merged[index]
    const id = existing.id
    merged[index] = {
      ...existing,
      ...live,
      id,
      content: resolveWorkerPanelContent(existing, live),
      tool_calls:
        live.tool_calls && live.tool_calls.length > 0 ? live.tool_calls : existing.tool_calls,
      status: live.status ?? existing.status,
      is_error: live.is_error ?? existing.is_error
    }
    indexById.set(id, index)
    indexById.set(live.id, index)
  }

  return merged
}

function buildToolResults(
  messages: Message[]
): Map<string, { content: string | unknown; is_error?: boolean }> {
  const results = new Map<string, { content: string | unknown; is_error?: boolean }>()
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      const resultKey = getWorkerToolResultKey(message.id, message.tool_call_id)
      if (!resultKey) continue
      results.set(resultKey, {
        content: message.content,
        is_error: message.is_error === true || message.status === "error"
      })
    }
  }
  return results
}

function workerMessagePreview(message: Message): string {
  const content = message.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              if (typeof block.text === "string") return block.text
              if (typeof block.content === "string") return block.content
              return ""
            })
            .join(" ")
        : ""
  return text.trim().slice(0, 120)
}

function buildWorkerHookLogBuckets(
  messages: Message[],
  hookLogBuckets: HookLogBucket[],
  workerThreadId: string | undefined
): {
  bucketById: Map<string, HookLogBucket>
  bucketByMessageId: Map<string, HookLogBucket>
  detachedBuckets: HookLogBucket[]
  totalEntryCount: number
} {
  const bucketById = new Map<string, HookLogBucket>()
  const bucketByMessageId = new Map<string, HookLogBucket>()
  const detachedBuckets: HookLogBucket[] = []
  if (!workerThreadId) {
    return { bucketById, bucketByMessageId, detachedBuckets, totalEntryCount: 0 }
  }

  const userMessages = messages.filter((message) => message.role === "user")
  const userMessageByTurn = new Map<number, Message>()
  userMessages.forEach((message, index) => userMessageByTurn.set(index + 1, message))

  const upsertBucket = (bucket: HookLogBucket): HookLogBucket => {
    const existing = bucketById.get(bucket.turnId)
    if (!existing) {
      bucketById.set(bucket.turnId, bucket)
      if (bucketByMessageId.has(bucket.turnId)) {
        bucketByMessageId.set(bucket.turnId, bucket)
      } else if (bucket.isPlaceholder) {
        detachedBuckets.push(bucket)
      }
      return bucket
    }
    const next = { ...existing, entries: [...existing.entries, ...bucket.entries] }
    bucketById.set(next.turnId, next)
    if (bucketByMessageId.has(next.turnId)) {
      bucketByMessageId.set(next.turnId, next)
    } else {
      const index = detachedBuckets.findIndex((item) => item.turnId === next.turnId)
      if (index >= 0) detachedBuckets[index] = next
    }
    return next
  }

  let totalEntryCount = 0
  for (const sourceBucket of hookLogBuckets) {
    for (const entry of sourceBucket.entries) {
      if (entry.workerThreadId !== workerThreadId) continue
      totalEntryCount += 1
      const workerTurn =
        typeof entry.workerTurn === "number" && Number.isFinite(entry.workerTurn)
          ? entry.workerTurn
          : undefined
      const targetMessage = workerTurn ? userMessageByTurn.get(workerTurn) : undefined
      if (targetMessage) {
        const existing = bucketByMessageId.get(targetMessage.id)
        const bucket: HookLogBucket = {
          turnId: targetMessage.id,
          turnPreview: workerMessagePreview(targetMessage),
          startedAt: existing?.startedAt ?? entry.timestamp,
          entries: [entry]
        }
        if (!existing) bucketByMessageId.set(targetMessage.id, bucket)
        upsertBucket(bucket)
        continue
      }

      const turnLabel = workerTurn ? `第 ${workerTurn} 轮` : "未匹配轮次"
      upsertBucket({
        turnId: `worker-hook:${workerThreadId}:${workerTurn ?? "unknown"}`,
        turnPreview: `(Worker ${turnLabel} Hook)`,
        isPlaceholder: true,
        startedAt: entry.timestamp,
        entries: [entry]
      })
    }
  }

  return { bucketById, bucketByMessageId, detachedBuckets, totalEntryCount }
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function boundedTextSignature(value: string): string {
  if (value.length <= MAX_WORKER_SIGNATURE_CHARS * 2) return value
  return [
    value.length,
    value.slice(0, MAX_WORKER_SIGNATURE_CHARS),
    value.slice(-MAX_WORKER_SIGNATURE_CHARS)
  ].join("\u001e")
}

function contentSignatureKey(content: Message["content"] | undefined): string {
  if (typeof content === "string") return boundedTextSignature(content)
  if (!Array.isArray(content)) return ""

  const text = content
    .map((block) => {
      if (typeof block.text === "string") return block.text
      if (typeof block.content === "string") return block.content
      return block.type ?? ""
    })
    .join("\n")
  return boundedTextSignature(text)
}

function toolCallsSignatureKey(toolCalls: Message["tool_calls"] | undefined): string {
  if (!toolCalls?.length) return ""
  return boundedTextSignature(
    toolCalls
      .map((toolCall, index) =>
        [
          toolCall.id ?? index,
          toolCall.name ?? "",
          toolCall.args ? boundedTextSignature(stableStringify(toolCall.args)) : ""
        ].join(":")
      )
      .join("|")
  )
}

function workerFocusMessageSignature(message: Message): string | undefined {
  const contentKey = contentSignatureKey(message.content)
  if (message.role === "assistant") {
    const toolCallKey = toolCallsSignatureKey(message.tool_calls)
    if (!contentKey && !toolCallKey) return undefined
    return ["assistant", contentKey, toolCallKey].join("\u001f")
  }
  if (message.role === "tool" && message.tool_call_id) {
    return ["tool", message.tool_call_id, message.name ?? "", contentKey].join("\u001f")
  }
  return undefined
}

function preferIncomingContent(
  existing: Message["content"] | undefined,
  incoming: Message["content"] | undefined
): Message["content"] {
  const existingLength = messageContentLength(existing)
  const incomingLength = messageContentLength(incoming)
  if (incomingLength === 0) return existing ?? ""
  if (existingLength > incomingLength) return existing ?? ""

  return incoming ?? ""
}

function resolveWorkerPanelContent(
  existingMessage: Message,
  incomingMessage: Message
): Message["content"] {
  if (isWorkerNonSnapshotMessageId(existingMessage.id) && existingMessage.id === incomingMessage.id) {
    return incomingMessage.content ?? existingMessage.content ?? ""
  }

  if (isWorkerSnapshotMessageId(incomingMessage.id)) {
    return preferIncomingContent(existingMessage.content, incomingMessage.content)
  }

  if (isWorkerSnapshotMessageId(existingMessage.id)) {
    return preferIncomingContent(incomingMessage.content, existingMessage.content)
  }

  return preferIncomingContent(existingMessage.content, incomingMessage.content)
}

export function WorkerStreamPanel(): React.JSX.Element {
  const workerFocusView = useAppStore((state) => state.workerFocusView)
  const workerFocusMessages = useAppStore((state) => state.workerFocusMessages)
  const closeWorkerFocusView = useAppStore((state) => state.closeWorkerFocusView)
  const threadContext = useThreadContext()
  const [historyMessages, setHistoryMessages] = useState<Message[]>([])
  const [truncatedHistoryCount, setTruncatedHistoryCount] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0)
  const [openHookLogBucketId, setOpenHookLogBucketId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const thinkingCycleRef = useRef(-1)
  const wasRunningRef = useRef(false)
  const runningMessageCountRef = useRef(0)
  const isAtBottomRef = useRef(true)
  const previousHistoryLoadRef = useRef<{
    workerThreadId: string
    turns?: number
  } | null>(null)
  const threadState = useThreadState(workerFocusView?.threadId ?? null)
  const currentWorker = threadState?.coordinatorWorkers.find(
    (worker) => worker.worker_id === workerFocusView?.workerId
  )
  const isRunning = currentWorker?.status === "running"
  const focusedParentThreadId = workerFocusView?.threadId ?? null
  const parentHookLogBuckets = useSyncExternalStore(
    useCallback(
      (callback) =>
        focusedParentThreadId
          ? threadContext.subscribeToHookLogs(focusedParentThreadId, callback)
          : () => undefined,
      [focusedParentThreadId, threadContext]
    ),
    useCallback(
      () =>
        focusedParentThreadId
          ? threadContext.getHookLogBuckets(focusedParentThreadId)
          : EMPTY_WORKER_HOOK_LOG_BUCKETS,
      [focusedParentThreadId, threadContext]
    )
  )

  useEffect(() => {
    const workerThreadId = workerFocusView?.workerThreadId
    if (!workerThreadId) return

    let cancelled = false
    const turns = currentWorker?.turns
    const previousLoad = previousHistoryLoadRef.current
    const shouldResetHistory =
      previousLoad?.workerThreadId !== workerThreadId || previousLoad?.turns !== turns
    previousHistoryLoadRef.current = { workerThreadId, turns }
    if (shouldResetHistory) {
      setHistoryMessages([])
      setTruncatedHistoryCount(0)
    }
    setLoadingHistory(true)
    void (async () => {
      try {
        const latestCheckpoint =
          (await window.api.threads.getLatestCheckpoint(workerThreadId)) as ThreadHistoryEntry | null
        if (cancelled) return
        const rawMessages = latestCheckpoint?.checkpoint?.channel_values?.messages
        if (!Array.isArray(rawMessages)) {
          setHistoryMessages([])
          setTruncatedHistoryCount(0)
          return
        }

        const startIndex = Math.max(0, rawMessages.length - MAX_WORKER_HISTORY_MESSAGES)
        const recentRawMessages =
          startIndex > 0 ? rawMessages.slice(startIndex) : rawMessages

        setTruncatedHistoryCount(startIndex)
        setHistoryMessages(
          recentRawMessages
            .map((message, index) =>
              messageFromCheckpoint(message as SerializedCheckpointMessage, startIndex + index)
            )
            .filter((message): message is Message => message !== null)
        )
      } catch (error) {
        console.error("[WorkerStreamPanel] Failed to load worker checkpoint:", error)
        if (!cancelled) {
          setHistoryMessages([])
          setTruncatedHistoryCount(0)
        }
      } finally {
        if (!cancelled) setLoadingHistory(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [currentWorker?.status, currentWorker?.turns, workerFocusView?.workerThreadId])

  const messages = useMemo(
    () => mergeMessages(historyMessages, workerFocusMessages),
    [historyMessages, workerFocusMessages]
  )
  const workerHookLogs = useMemo(
    () =>
      buildWorkerHookLogBuckets(
        messages,
        parentHookLogBuckets,
        workerFocusView?.workerThreadId
      ),
    [messages, parentHookLogBuckets, workerFocusView?.workerThreadId]
  )
  const openHookLogBucket = openHookLogBucketId
    ? (workerHookLogs.bucketById.get(openHookLogBucketId) ?? null)
    : null
  const showAssistantMetaByIndex = useMemo(() => {
    const result = new Array<boolean>(messages.length)
    let nextNonToolMessage: Message | null = null
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      result[index] =
        message.role !== "assistant" ||
        !nextNonToolMessage ||
        nextNonToolMessage.role !== "assistant"
      if (message.role !== "tool") {
        nextNonToolMessage = message
      }
    }
    return result
  }, [messages])

  const { assistantDurationMsById, userSendTimeLabelById } = useMemo(
    () => buildMessageBubbleTimingMeta(messages),
    [messages]
  )
  const toolResults = useMemo(() => buildToolResults(messages), [messages])
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
      workerFocusMessages.length,
      workerHookLogs.totalEntryCount,
      isRunning ? "running" : "idle"
    ].join(":")
  }, [
    messages,
    toolResults.size,
    workerFocusMessages.length,
    workerHookLogs.totalEntryCount,
    isRunning
  ])

  useEffect(() => {
    isAtBottomRef.current = true
    return scrollToBottom()
  }, [scrollToBottom, workerFocusView?.workerThreadId])

  useEffect(() => {
    setOpenHookLogBucketId(null)
  }, [workerFocusView?.workerThreadId])

  useEffect(() => {
    if (loadingHistory) return
    return scrollToBottom()
  }, [loadingHistory, scrollToBottom, workerFocusView?.workerThreadId])

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
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % WORKER_THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      runningMessageCountRef.current = messages.length
      wasRunningRef.current = true
      return
    }

    if (messages.length > runningMessageCountRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % WORKER_THINKING_MESSAGES.length
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
            onClick={() => closeWorkerFocusView()}
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
            {truncatedHistoryCount > 0 && (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                为控制性能，这里仅恢复最近 {MAX_WORKER_HISTORY_MESSAGES} 条 worker
                checkpoint 消息；更早的 {truncatedHistoryCount} 条历史未在面板加载。
              </div>
            )}
            {workerHookLogs.detachedBuckets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {workerHookLogs.detachedBuckets.map((bucket) => (
                  <HookLogChip
                    key={bucket.turnId}
                    bucket={bucket}
                    onClick={() => setOpenHookLogBucketId(bucket.turnId)}
                  />
                ))}
              </div>
            )}
            {messages.map((message, index) => {
              if (message.role === "tool") return null
              const previousMessage = index > 0 ? messages[index - 1] : null
              const isLastMessage = index === messages.length - 1
              const hasUserAfterHead = messages.slice(index + 1).some((m) => m.role === "user")
              const hookLogBucketForTurn =
                message.role === "user" ? workerHookLogs.bucketByMessageId.get(message.id) : null

              return (
                <div key={message.id}>
                  <MessageBubble
                    message={message}
                    previousMessage={previousMessage}
                    isStreaming={isRunning && isLastMessage}
                    showAssistantMeta={showAssistantMetaByIndex[index] ?? true}
                    toolResults={toolResults}
                    threadId={workerFocusView.threadId}
                    isLoading={isRunning}
                    hasUserAfterHead={hasUserAfterHead}
                    assistantDurationMs={assistantDurationMsById.get(message.id)}
                    userSendTimeLabel={userSendTimeLabelById.get(message.id) ?? null}
                  />
                  {hookLogBucketForTurn && hookLogBucketForTurn.entries.length > 0 && (
                    <div className="mt-1 flex justify-end pr-2">
                      <HookLogChip
                        bucket={hookLogBucketForTurn}
                        onClick={() => setOpenHookLogBucketId(hookLogBucketForTurn.turnId)}
                      />
                    </div>
                  )}
                </div>
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
      <HookLogModal
        bucket={openHookLogBucket}
        open={openHookLogBucketId !== null}
        previewLabel="Worker 指令"
        onOpenChange={(open) => {
          if (!open) setOpenHookLogBucketId(null)
        }}
      />
    </div>
  )
}
