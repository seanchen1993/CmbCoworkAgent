import { v4 as uuid } from "uuid"
import { BrowserWindow } from "electron"
import WebSocket from "ws"
import { HumanMessage } from "@langchain/core/messages"
import { getChatXConfig } from "../storage"
import {
  createAgentRuntime,
  closeCheckpointer,
  pinCheckpointer,
  retireThreadCheckpointers
} from "../agent/runtime"
import { purgeThreadCheckpointArtifacts } from "../storage"
import {
  createThread as dbCreateThread,
  deleteThread as dbDeleteThread,
  getAllThreads,
  getThread
} from "../db/index"
import { StreamConverter } from "../agent/stream-converter"
import { notifyAlways, stripThink } from "./notify"
import { trackEvent } from "./event-reporter"
import { showPetCompletedTaskNotice } from "../pet"
import type { ChatXRobotConfig } from "../types"
import { emitAppAttention } from "../app-attention-events"
import { getChatXUserMessageId, namespaceChatXStreamEventIds } from "./chatx-stream-ids"

// ── Constants ────────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 60_000
const PING_INTERVAL_MS = 30_000
const DEDUP_MAX_SIZE = 1000
const MAX_QUEUE_SIZE = 10
const MAX_MESSAGE_SIZE = 10 * 1024 // 10KB
const MAX_CONTENT_LENGTH = 1000 // 1000 chars

// ── State ────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempts = 0
let stopped = false
let lastPong = 0
type ChatXWsStatus = "disconnected" | "connecting" | "connected" | "reconnecting"

let currentStatus: ChatXWsStatus = "disconnected"

function setStatus(status: ChatXWsStatus): void {
  currentStatus = status
  broadcastToChannel("chatx:status", status)
}

export function getChatXStatus(): ChatXWsStatus {
  return currentStatus
}

const processedMsgIds = new Set<string>()

/** Abort reason used ONLY by stopChatX. The abort-intent must travel WITH the
 * signal, not via the global `stopped` flag: restartChatX() flips `stopped`
 * back to false synchronously, BEFORE the aborted handler's catch runs — a
 * flag check there would misread a restart-induced abort as a user cancel and
 * keep the dedup mark (silently swallowing the broker's redelivery). */
const CHATX_STOP_ABORT_REASON = "chatx-service-stop"

/** chatKey -> the msgId currently being processed. stopChatX() must release
 * the ACTIVE message's dedup mark SYNCHRONOUSLY at abort time: the handler's
 * own finally-release runs only after the abort unwinds, and a quick
 * reconnect's broker redelivery can arrive in that gap — the entry dedup
 * would bounce it, and if the broker doesn't try a third time the message is
 * lost. (Safe vs dual-writer: runningChats is NOT cleared on stop, so the
 * redelivered copy queues behind the old handler instead of re-entering.) */
const inFlightMsgIds = new Map<string, string>()

/** Kick the next queued message for this chat (fire-and-forget). Must run on
 * EVERY exit of a requeued invocation — not just the main finally: a requeued
 * message that exits before the main try/finally (robot config gone,
 * workspace missing, setup failure) would otherwise strand the rest of the
 * queue — and their receipt-dedup marks — until some future message for the
 * chat completes a full run. */
function drainNextQueued(chatKey: string): void {
  const queue = messageQueues.get(chatKey)
  if (queue && queue.length > 0) {
    const next = queue.shift()!
    if (queue.length === 0) messageQueues.delete(chatKey)
    handleInbound(next, true).catch((err) => {
      console.error("[ChatX] Queued message processing error:", err)
    })
  }
}
const runningChats = new Set<string>()
const activeAbortControllers = new Map<string, AbortController>()
const threadIdToChatKey = new Map<string, string>()
const messageQueues = new Map<string, ChatXInboundMessage[]>()
let shuttingDown = false

// ── Helpers ──────────────────────────────────────────────────────────────────

function notifyRenderer(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel)
  }
}

function broadcastToChannel(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

function dedup(msgId: string): boolean {
  if (processedMsgIds.has(msgId)) return true
  processedMsgIds.add(msgId)
  if (processedMsgIds.size > DEDUP_MAX_SIZE) {
    const first = processedMsgIds.values().next().value
    if (first !== undefined) processedMsgIds.delete(first)
  }
  return false
}

/**
 * Find an existing ChatX thread for a given robot chatId + sender.
 * Thread metadata stores `chatxChatId` and `chatxSender`.
 */
function findChatXThread(chatId: string, sender: string): string | null {
  const threads = getAllThreads()
  for (const t of threads) {
    if (!t.metadata) continue
    try {
      const meta = JSON.parse(t.metadata)
      if (meta.chatxChatId === chatId && meta.chatxSender === sender) {
        return t.thread_id
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

// ── HTTP Reply ───────────────────────────────────────────────────────────────

const HTTP_TIMEOUT_MS = 30_000

/** Returns whether the reply verifiably reached the HTTP endpoint (2xx).
 * false = not configured / non-2xx / timeout / network error. Callers that
 * report "回复完成" MUST consult this — a swallowed failure otherwise
 * masquerades as success while the remote got nothing. */
export async function sendChatXReply(robot: ChatXRobotConfig, content: string): Promise<boolean> {
  const cleanContent = stripThink(content).trim()
  if (!cleanContent) return true
  const httpUrl = (import.meta.env.VITE_CHATX_HTTP_URL as string) || robot.httpUrl
  const channel = (import.meta.env.VITE_CHATX_CHANNEL as string) || robot.channel || ""
  if (!httpUrl) {
    const msg = "HTTP 回复地址未配置，请检查 .env 中的 VITE_CHATX_HTTP_URL"
    console.error(`[ChatX] ${msg}`)
    notifyAlways("🤖 机器人回复失败", msg)
    return false
  }
  if (!channel) {
    console.warn("[ChatX] channel not configured, using empty string")
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        fromId: robot.fromId,
        clientId: robot.clientId,
        clientSecret: robot.clientSecret,
        channel,
        toUserList: robot.toUserList,
        content: cleanContent
      })
    })
    if (!res.ok) {
      console.error(`[ChatX] HTTP reply failed: ${res.status} ${res.statusText}`)
      return false
    }
    return true
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // NOTE: a timeout is only "unconfirmed" — the request may have reached
      // the remote. Callers must NOT auto-redeliver on false (double-reply
      // risk); report the failure and keep the dedup mark instead.
      console.error(`[ChatX] HTTP reply timed out after ${HTTP_TIMEOUT_MS / 1000}s`)
    } else {
      console.error("[ChatX] HTTP reply error:", err)
    }
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Look up robot config by chatId and send HTTP reply.
 * Shared by chatx.ts, agent.ts, and scheduler.ts.
 */
export function trySendChatXReply(chatId: string, content: string): void {
  const config = getChatXConfig()
  const robot = config.robots.find((r) => r.chatId === chatId)
  if (!robot) {
    console.warn(`[ChatX] trySendChatXReply: robot not found for chatId=${chatId}, reply dropped`)
    return
  }
  sendChatXReply(robot, content).catch((err) => {
    console.error("[ChatX] trySendChatXReply error:", err)
    notifyAlways("🤖 机器人回复发送失败", err instanceof Error ? err.message : String(err))
  })
}

// ── Inbound Handler ──────────────────────────────────────────────────────────

interface ChatXInboundMessage {
  msgId: string
  fromId: string
  content: string
  chatId: string
}

async function handleInbound(msg: ChatXInboundMessage, requeued = false): Promise<void> {
  const config = getChatXConfig()
  const robot = config.robots.find((r) => r.chatId === msg.chatId)
  if (!robot) {
    console.log(`[ChatX] No robot config for chatId: ${msg.chatId}, ignoring`)
    // A REQUEUED message was dedup-marked when it first arrived; dropping it
    // here (robot config removed/reloading) without releasing would swallow
    // every later redelivery — same accounting rule as the other drop sites.
    // First-arrival drops never marked anything, so nothing to release there.
    // Keep draining: if the whole chat's config is gone, this walks the queue
    // releasing each mark instead of stranding the backlog.
    if (requeued) {
      processedMsgIds.delete(msg.msgId)
      drainNextQueued(`${msg.chatId}:${msg.fromId}`)
    }
    return
  }

  // Dedup marks the id at RECEIPT — that intentionally also swallows broker
  // re-deliveries of a message that is still sitting in the busy queue. But a
  // drained queue entry re-enters through this same function, and its id was
  // marked when it was queued — re-checking here silently dropped EVERY queued
  // message. The drain path passes requeued=true to skip the check.
  if (!requeued && dedup(msg.msgId)) {
    console.log(`[ChatX] Duplicate message: ${msg.msgId}, ignoring`)
    return
  }

  const chatKey = `${msg.chatId}:${msg.fromId}`
  if (runningChats.has(chatKey)) {
    const queue = messageQueues.get(chatKey) || []
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`[ChatX] Queue full for ${chatKey}, dropping message: ${msg.msgId}`)
      // Dropped ≠ processed: release the receipt-dedup mark so a broker
      // redelivery of this message is not silently swallowed.
      processedMsgIds.delete(msg.msgId)
      return
    }
    queue.push(msg)
    messageQueues.set(chatKey, queue)
    console.log(
      `[ChatX] Chat ${chatKey} is busy, queued message: ${msg.msgId} (queue size: ${queue.length})`
    )
    return
  }

  runningChats.add(chatKey)
  const abortController = new AbortController()
  activeAbortControllers.set(chatKey, abortController)
  inFlightMsgIds.set(chatKey, msg.msgId)

  // Find or create thread. The whole pre-run setup is guarded: a throw here
  // (db lookup/create, renderer notify) lands BEFORE the main try/finally
  // takes ownership of cleanup — and stopChatX deliberately no longer clears
  // owner state (the dual-writer fix), so an unguarded throw would leave this
  // chatKey stuck in runningChats until process restart, silently queueing or
  // dropping every later message of the chat.
  let threadId = ""
  let threadCreated = false
  try {
    threadId = findChatXThread(msg.chatId, msg.fromId) || ""
    if (!threadId) {
      const workspacePath = robot.workDir
      if (!workspacePath) {
        console.error("[ChatX] No workspace directory configured for robot:", msg.chatId)
        runningChats.delete(chatKey)
        activeAbortControllers.delete(chatKey)
        inFlightMsgIds.delete(chatKey)
        // Not processed — release the dedup mark so the message can be
        // redelivered once the robot's workDir is configured.
        processedMsgIds.delete(msg.msgId)
        drainNextQueued(chatKey)
        return
      }
      threadId = uuid()
      const now = new Date()
      const timeTag = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
      dbCreateThread(threadId, {
        workspacePath,
        title: `[远端机器人] ${robot.chatId} · ${timeTag}`,
        chatxChatId: msg.chatId,
        chatxSender: msg.fromId,
        chatxRobotChatId: msg.chatId
      })
      threadCreated = true
      notifyRenderer("threads:changed")
    }
    threadIdToChatKey.set(threadId, chatKey)
  } catch (e) {
    runningChats.delete(chatKey)
    activeAbortControllers.delete(chatKey)
    inFlightMsgIds.delete(chatKey)
    if (threadId) threadIdToChatKey.delete(threadId)
    // Setup failed before the run — the message was never processed.
    processedMsgIds.delete(msg.msgId)
    drainNextQueued(chatKey)
    throw e
  }
  const channel = `scheduler:stream:${threadId}`
  let hasStreamedContent = false
  const releaseCheckpointerPin = pinCheckpointer(threadId)

  // Telemetry: ChatX runs its own runtime with no TraceCollector, so the only
  // record that a remote message was handled (and whether it got replied) is
  // this event. Defaults to "error" until a branch overwrites it.
  let processedOutcome: "replied" | "cancelled" | "error" = "error"
  let repliedWithContent = false

  try {
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string

    broadcastToChannel(channel, { type: "started" })

    const agent = await createAgentRuntime({
      threadId,
      workspacePath,
      modelId: robot.modelId || undefined,
      enableAgentsPrompt: false,
      abortSignal: abortController.signal
    })

    const converter = new StreamConverter()

    const stream = await agent.stream(
      {
        messages: [new HumanMessage({ id: getChatXUserMessageId(msg.msgId), content: msg.content })]
      },
      {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"],
        recursionLimit: 1000
      }
    )

    let lastAssistantText = ""
    for await (const chunk of stream) {
      if (abortController.signal.aborted) break
      const [mode, data] = chunk as [string, unknown]
      const serialized = JSON.parse(JSON.stringify(data))
      const events = converter.processChunk(mode, serialized)
      for (const evt of events) {
        const chatxEvent = namespaceChatXStreamEventIds(evt, msg.msgId)
        broadcastToChannel(channel, chatxEvent)
        if (chatxEvent.type === "full-messages") {
          // 只取最后一条没有 tool_calls 的 assistant 消息（即最终回复，不含中间工具推理）
          const finalMsgs = chatxEvent.messages.filter(
            (m) =>
              m.role === "assistant" &&
              (!m.tool_calls || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0)
          )
          const last = finalMsgs[finalMsgs.length - 1]
          if (last?.content?.trim()) lastAssistantText = last.content.trim()
        }
      }
      hasStreamedContent = true
    }

    if (!abortController.signal.aborted) {
      // SUCCESS-COMMIT POINT: from here on the message counts as answered —
      // remove it from the stop-releasable set BEFORE the HTTP reply goes
      // out. inFlightMsgIds means "unanswered; a stop must re-open it for
      // broker redelivery" — a stop landing between the reply and the
      // finally would otherwise release an ALREADY-ANSWERED msgId, and its
      // redelivery would re-run tools / reply twice. (If the send below
      // fails, that's a genuine processing error — same keep-the-mark policy
      // as every other error path.)
      inFlightMsgIds.delete(chatKey)
      broadcastToChannel(channel, { type: "done" })
      // Send final reply via HTTP — and VERIFY it before claiming success.
      const replySent = lastAssistantText ? await sendChatXReply(robot, lastAssistantText) : true
      if (replySent) {
        notifyAlways(`🤖 ${msg.fromId} 回复完成`, lastAssistantText || "处理完成")
        showPetCompletedTaskNotice(threadId, `${msg.fromId} 回复`)
        emitAppAttention({
          kind: "task-complete",
          threadId,
          key: `chatx:${msg.msgId}`
        })
        console.log(`[ChatX] Message processed: ${msg.msgId}`)
        processedOutcome = "replied"
        repliedWithContent = !!lastAssistantText
      } else {
        // Conservative failure semantics (deliberate): tell the user, keep
        // the dedup mark, do NOT auto-redeliver — a timed-out send may have
        // actually reached the remote, and a redelivered copy would reply
        // twice. The user resends explicitly if the remote truly got nothing.
        notifyAlways(
          "🤖 机器人回复发送失败",
          `${msg.fromId} 的回复未能确认送达远端(HTTP 发送失败/超时),请检查网络与配置后手动重试`
        )
        emitAppAttention({
          kind: "task-error",
          threadId,
          key: `chatx:${msg.msgId}`
        })
        console.error(`[ChatX] Reply send failed for message: ${msg.msgId}`)
        processedOutcome = "error"
      }
    } else {
      broadcastToChannel(channel, { type: "done" })
      console.log(`[ChatX] Message cancelled: ${msg.msgId}`)
      processedOutcome = "cancelled"
    }
  } catch (error) {
    const isAbortError =
      // Some layers reject with signal.reason ITSELF (our stop reason string),
      // not an Error — a service stop must never be reported as a failure.
      error === CHATX_STOP_ABORT_REASON ||
      (abortController.signal.aborted &&
        abortController.signal.reason === CHATX_STOP_ABORT_REASON) ||
      (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted")))
    const errMsg = isAbortError
      ? "Cancelled"
      : error instanceof Error
        ? error.message
        : String(error)

    if (isAbortError) {
      broadcastToChannel(channel, { type: "done" })
      processedOutcome = "cancelled"
    } else {
      broadcastToChannel(channel, { type: "error", error: errMsg })
      notifyAlways("🤖 机器人处理失败", errMsg)
      emitAppAttention({
        kind: "task-error",
        threadId,
        key: `chatx:${msg.msgId}`
      })
      console.error(`[ChatX] Error processing message:`, errMsg)
      processedOutcome = "error"
    }

    if (threadCreated && !hasStreamedContent) {
      // Deleting a thread means deleting its transcript (same semantics as
      // threads:delete): the runtime may already have created and flushed a
      // checkpointer for this discarded one-shot thread, and the finally's
      // reusable close below would flush it AGAIN — retire first (poisons +
      // makes that close a no-op), then purge the on-disk artifacts. Retire
      // and purge are INDEPENDENT best-effort (a retire fault must not leave
      // the orphan file behind), but both stay gated on the row delete
      // actually succeeding — retiring a SURVIVING thread would poison it.
      let rowDeleted = false
      try {
        dbDeleteThread(threadId)
        rowDeleted = true
      } catch {
        /* ignore */
      }
      if (rowDeleted) {
        try {
          await retireThreadCheckpointers(threadId)
        } catch {
          /* ignore */
        }
        try {
          purgeThreadCheckpointArtifacts(threadId)
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    try {
      trackEvent("chatx.message.processed", "chatx", {
        outcome: processedOutcome,
        replied: repliedWithContent,
        threadCreated
      })
    } catch (e) {
      console.warn("[event] failed to emit chatx.message.processed:", e)
    }
    activeAbortControllers.delete(chatKey)
    inFlightMsgIds.delete(chatKey)
    threadIdToChatKey.delete(threadId)
    releaseCheckpointerPin()
    // Close BEFORE dropping the runningChats gate (mirrors heartbeat's finally):
    // ChatX reuses one threadId per (chatId, sender), and an inbound landing in
    // this close window would pass the gate, pin first, and — pinned callers
    // skip the pending-close wait — create a second saver over the same sqlite
    // the old close is still flushing (dual writer). Keeping the gate up makes
    // the newcomer queue instead; the queue drain below runs after the gate
    // clears, so queued messages are not starved.
    await closeCheckpointer(threadId).catch(() => {})
    runningChats.delete(chatKey)
    notifyRenderer("threads:changed")

    // Process next queued message for this chat
    drainNextQueued(chatKey)
  }
}

// ── WebSocket Connection ─────────────────────────────────────────────────────

function connect(): void {
  const config = getChatXConfig()
  const envWsUrl = (import.meta.env.VITE_CHATX_WS_URL as string) || ""
  const baseWsUrl = envWsUrl || config.wsUrl
  if (!config.enabled) {
    console.log("[ChatX] Not enabled")
    stopped = true
    return
  }
  if (!baseWsUrl) {
    console.error("[ChatX] No wsUrl configured (check VITE_CHATX_WS_URL in .env or config)")
    return
  }
  setStatus("connecting")

  let wsUrl = baseWsUrl
  if (config.userIp) {
    const sep = wsUrl.includes("?") ? "&" : "?"
    wsUrl = `${wsUrl}${sep}userIp=${encodeURIComponent(config.userIp)}`
  }
  console.log(`[ChatX] Connecting to ${wsUrl}`)

  try {
    ws = new WebSocket(wsUrl)
  } catch (err) {
    console.error("[ChatX] WebSocket creation error:", err)
    setStatus("reconnecting")
    scheduleReconnect()
    return
  }

  ws.on("open", () => {
    console.log("[ChatX] WebSocket connected")
    reconnectAttempts = 0
    startPing()
    setStatus("connected")
  })

  ws.on("message", (raw: WebSocket.RawData) => {
    try {
      const rawStr = raw.toString()
      if (rawStr.length > MAX_MESSAGE_SIZE) {
        console.warn(`[ChatX] Message too large (${rawStr.length} bytes), ignoring`)
        return
      }
      const msg = JSON.parse(rawStr) as ChatXInboundMessage
      if (!msg.msgId || !msg.chatId || !msg.fromId) {
        console.warn(
          "[ChatX] Invalid message format (missing msgId/chatId/fromId):",
          rawStr.slice(0, 200)
        )
        return
      }
      if (!msg.content || !msg.content.trim()) {
        console.warn("[ChatX] Empty message content, ignoring:", msg.msgId)
        return
      }
      if (msg.content.length > MAX_CONTENT_LENGTH) {
        console.warn(
          `[ChatX] Content too long (${msg.content.length} chars), truncating to ${MAX_CONTENT_LENGTH}`
        )
        msg.content = msg.content.slice(0, MAX_CONTENT_LENGTH)
      }
      handleInbound(msg).catch((err) => {
        console.error("[ChatX] handleInbound error:", err)
      })
    } catch (err) {
      console.error("[ChatX] Failed to parse WS message:", err)
    }
  })

  ws.on("pong", () => {
    lastPong = Date.now()
  })

  ws.on("close", (code, reason) => {
    console.log(`[ChatX] WebSocket closed: ${code} ${reason}`)
    cleanup()
    if (!stopped) {
      setStatus("reconnecting")
      scheduleReconnect()
    } else {
      setStatus("disconnected")
    }
  })

  ws.on("error", (err) => {
    console.error("[ChatX] WebSocket error:", err.message)
  })
}

function startPing(): void {
  stopPing()
  lastPong = Date.now()
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      if (lastPong > 0 && Date.now() - lastPong > PING_INTERVAL_MS * 3) {
        console.warn("[ChatX] Pong timeout, terminating connection")
        ws.terminate()
        return
      }
      ws.ping()
    }
  }, PING_INTERVAL_MS)
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function cleanup(): void {
  stopPing()
  if (ws) {
    ws.removeAllListeners()
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
    ws = null
  }
}

function scheduleReconnect(): void {
  if (stopped) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS)
  reconnectAttempts++
  console.log(`[ChatX] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startChatX(): void {
  if (shuttingDown) {
    console.warn("[ChatX] Ignoring start request while the application is quitting")
    return
  }
  console.log("[ChatX] Starting ChatX service")
  stopped = false
  reconnectAttempts = 0
  connect()
}

export function hasActiveChatXRuns(): boolean {
  return runningChats.size > 0
}

export function stopChatX(): void {
  console.log("[ChatX] Stopping ChatX service")
  stopped = true
  setStatus("disconnected")
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  for (const [key, controller] of activeAbortControllers) {
    console.log(`[ChatX] Aborting running chat: ${key}`)
    controller.abort(CHATX_STOP_ABORT_REASON)
    // Release the ACTIVE message's dedup mark NOW — and ONLY here. This is
    // deliberately the single release point for stop-cancellations: a
    // finally-side release is not idempotent in effect, because a quick
    // redelivery can RE-MARK the same msgId (it queues behind runningChats)
    // before the old handler's finally runs — a second delete there would
    // strip the redelivered copy's mark, leaving the message unmarked after
    // it processes and re-runnable by a later delivery.
    const activeMsgId = inFlightMsgIds.get(key)
    if (activeMsgId) processedMsgIds.delete(activeMsgId)
  }
  // Owner-managed run state (runningChats / activeAbortControllers /
  // threadIdToChatKey) is NOT cleared here — each handler's finally removes
  // its own entries AFTER its checkpointer close settles. Clearing them at
  // stop reopens the exact window the finally ordering closed: stop → restart
  // → a message for the same chatKey passes the gate while the old handler is
  // still flushing, dual-writing the reused thread's sqlite (same family as
  // stopHeartbeat's abort-only fix). Queued messages carry no running state —
  // dropping them on stop is fine, but dropped ≠ processed: release their
  // receipt-dedup marks so broker redeliveries after a restart still land.
  for (const queue of messageQueues.values()) {
    for (const queued of queue) processedMsgIds.delete(queued.msgId)
  }
  messageQueues.clear()
  cleanup()
}

/** Stop accepting ChatX work and wait briefly for active handlers to close
 * their checkpointers. The owner-managed running set is intentionally retained
 * until each handler's finally block completes. */
export async function stopChatXAndWait(timeoutMs = 5_000): Promise<void> {
  shuttingDown = true
  stopChatX()
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (runningChats.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  if (runningChats.size > 0) {
    console.warn(`[ChatX] Timed out waiting for ${runningChats.size} active chat(s) to settle`)
  }
}

/** Cancel a running ChatX conversation by threadId. Returns true if found and cancelled. */
export function cancelChatXByThreadId(threadId: string): boolean {
  const chatKey = threadIdToChatKey.get(threadId)
  if (!chatKey) return false
  const controller = activeAbortControllers.get(chatKey)
  if (!controller) return false
  console.log(`[ChatX] Cancelling by threadId=${threadId}, chatKey=${chatKey}`)
  controller.abort()
  return true
}

export function restartChatX(): void {
  stopChatX()
  startChatX()
}
