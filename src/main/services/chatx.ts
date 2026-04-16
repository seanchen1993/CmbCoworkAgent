import { v4 as uuid } from "uuid"
import { BrowserWindow } from "electron"
import WebSocket from "ws"
import { HumanMessage } from "@langchain/core/messages"
import { getChatXConfig } from "../storage"
import { createAgentRuntime, closeCheckpointer } from "../agent/runtime"
import { createThread as dbCreateThread, deleteThread as dbDeleteThread, getAllThreads, getThread } from "../db/index"
import { StreamConverter } from "../agent/stream-converter"
import { notifyAlways, stripThink } from "./notify"
import type { ChatXRobotConfig } from "../types"

// ── Constants ────────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 60_000
const PING_INTERVAL_MS = 30_000
const DEDUP_MAX_SIZE = 1000
const MAX_QUEUE_SIZE = 10
const MAX_MESSAGE_SIZE = 10 * 1024     // 10KB
const MAX_CONTENT_LENGTH = 1000       // 1000 chars

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
const runningChats = new Set<string>()
const activeAbortControllers = new Map<string, AbortController>()
const threadIdToChatKey = new Map<string, string>()
const messageQueues = new Map<string, ChatXInboundMessage[]>()

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
    } catch { /* ignore */ }
  }
  return null
}

// ── HTTP Reply ───────────────────────────────────────────────────────────────

const HTTP_TIMEOUT_MS = 30_000

export async function sendChatXReply(robot: ChatXRobotConfig, content: string): Promise<void> {
  const cleanContent = stripThink(content).trim()
  if (!cleanContent) return
  const httpUrl = (import.meta.env.VITE_CHATX_HTTP_URL as string) || robot.httpUrl
  const channel = (import.meta.env.VITE_CHATX_CHANNEL as string) || robot.channel || ""
  if (!httpUrl) {
    const msg = "HTTP 回复地址未配置，请检查 .env 中的 VITE_CHATX_HTTP_URL"
    console.error(`[ChatX] ${msg}`)
    notifyAlways("🤖 机器人回复失败", msg)
    return
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
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[ChatX] HTTP reply timed out after ${HTTP_TIMEOUT_MS / 1000}s`)
    } else {
      console.error("[ChatX] HTTP reply error:", err)
    }
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

async function handleInbound(msg: ChatXInboundMessage): Promise<void> {
  const config = getChatXConfig()
  const robot = config.robots.find((r) => r.chatId === msg.chatId)
  if (!robot) {
    console.log(`[ChatX] No robot config for chatId: ${msg.chatId}, ignoring`)
    return
  }

  if (dedup(msg.msgId)) {
    console.log(`[ChatX] Duplicate message: ${msg.msgId}, ignoring`)
    return
  }

  const chatKey = `${msg.chatId}:${msg.fromId}`
  if (runningChats.has(chatKey)) {
    const queue = messageQueues.get(chatKey) || []
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`[ChatX] Queue full for ${chatKey}, dropping message: ${msg.msgId}`)
      return
    }
    queue.push(msg)
    messageQueues.set(chatKey, queue)
    console.log(`[ChatX] Chat ${chatKey} is busy, queued message: ${msg.msgId} (queue size: ${queue.length})`)
    return
  }

  runningChats.add(chatKey)
  const abortController = new AbortController()
  activeAbortControllers.set(chatKey, abortController)

  // Find or create thread
  let threadId = findChatXThread(msg.chatId, msg.fromId)
  let threadCreated = false

  if (!threadId) {
    threadId = uuid()
    const workspacePath = robot.workDir
    if (!workspacePath) {
      console.error("[ChatX] No workspace directory configured for robot:", msg.chatId)
      runningChats.delete(chatKey)
      activeAbortControllers.delete(chatKey)
      return
    }
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
  const channel = `scheduler:stream:${threadId}`
  let hasStreamedContent = false

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
      { messages: [new HumanMessage(msg.content)] },
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
        broadcastToChannel(channel, evt)
        if (evt.type === "full-messages") {
          // 只取最后一条没有 tool_calls 的 assistant 消息（即最终回复，不含中间工具推理）
          const finalMsgs = evt.messages.filter(
            (m) => m.role === "assistant" && (!m.tool_calls || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0)
          )
          const last = finalMsgs[finalMsgs.length - 1]
          if (last?.content?.trim()) lastAssistantText = last.content.trim()
        }
      }
      hasStreamedContent = true
    }

    if (!abortController.signal.aborted) {
      broadcastToChannel(channel, { type: "done" })
      // Send final reply via HTTP
      if (lastAssistantText) {
        await sendChatXReply(robot, lastAssistantText)
      }
      notifyAlways(`🤖 ${msg.fromId} 回复完成`, lastAssistantText || "处理完成")
      console.log(`[ChatX] Message processed: ${msg.msgId}`)
    } else {
      broadcastToChannel(channel, { type: "done" })
      console.log(`[ChatX] Message cancelled: ${msg.msgId}`)
    }
  } catch (error) {
    const isAbortError =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"))
    const errMsg = isAbortError ? "Cancelled" : (error instanceof Error ? error.message : String(error))

    if (isAbortError) {
      broadcastToChannel(channel, { type: "done" })
    } else {
      broadcastToChannel(channel, { type: "error", error: errMsg })
      notifyAlways("🤖 机器人处理失败", errMsg)
      console.error(`[ChatX] Error processing message:`, errMsg)
    }

    if (threadCreated && !hasStreamedContent) {
      try { dbDeleteThread(threadId) } catch { /* ignore */ }
    }
  } finally {
    runningChats.delete(chatKey)
    activeAbortControllers.delete(chatKey)
    threadIdToChatKey.delete(threadId)
    closeCheckpointer(threadId).catch(() => {})
    notifyRenderer("threads:changed")

    // Process next queued message for this chat
    const queue = messageQueues.get(chatKey)
    if (queue && queue.length > 0) {
      const next = queue.shift()!
      if (queue.length === 0) messageQueues.delete(chatKey)
      handleInbound(next).catch((err) => {
        console.error("[ChatX] Queued message processing error:", err)
      })
    }
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
        console.warn("[ChatX] Invalid message format (missing msgId/chatId/fromId):", rawStr.slice(0, 200))
        return
      }
      if (!msg.content || !msg.content.trim()) {
        console.warn("[ChatX] Empty message content, ignoring:", msg.msgId)
        return
      }
      if (msg.content.length > MAX_CONTENT_LENGTH) {
        console.warn(`[ChatX] Content too long (${msg.content.length} chars), truncating to ${MAX_CONTENT_LENGTH}`)
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
    try { ws.terminate() } catch { /* ignore */ }
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
  console.log("[ChatX] Starting ChatX service")
  stopped = false
  reconnectAttempts = 0
  connect()
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
    controller.abort()
  }
  activeAbortControllers.clear()
  threadIdToChatKey.clear()
  runningChats.clear()
  messageQueues.clear()
  cleanup()
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
