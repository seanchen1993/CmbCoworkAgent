import { BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
import { getHeartbeatConfig, getHeartbeatContent, saveHeartbeatConfig, getGlobalRoutingMode } from "../storage"
import { resolveModel } from "../routing"
import { createAgentRuntime, getCheckpointer, closeCheckpointer } from "../agent/runtime"
import {
  createThread as dbCreateThread,
  getThread as dbGetThread,
  updateThread as dbUpdateThread
} from "../db"
import { StreamConverter } from "../agent/stream-converter"
import { notifyIfBackground } from "./notify"

/** Fixed thread ID for heartbeat (aligns with Nanobot session_key="heartbeat"). Resets won't orphan it. */
const HEARTBEAT_THREAD_ID = "heartbeat"

let tickTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let abortController: AbortController | null = null

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

/**
 * Ported from Moltbot's isHeartbeatContentEffectivelyEmpty.
 * Returns true when HEARTBEAT.md has no actionable tasks.
 */
function isContentEmpty(content: string): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#+(\s|$)/.test(trimmed)) continue
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue
    return false
  }
  return true
}

const HEARTBEAT_TOKEN = "HEARTBEAT_OK"
const ACK_MAX_CHARS = 300

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Strip markup wrappers so HEARTBEAT_OK inside HTML/Markdown still matches.
 */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "")
}

/**
 * Strip HEARTBEAT_OK from the start/end of text.
 * Ported from Moltbot's stripTokenAtEdges.
 */
function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim()
  if (!text) return { text: "", didStrip: false }

  const endPattern = new RegExp(`${escapeRegExp(HEARTBEAT_TOKEN)}[^\\w]{0,4}$`)
  if (!text.includes(HEARTBEAT_TOKEN)) return { text, didStrip: false }

  let didStrip = false
  let changed = true
  while (changed) {
    changed = false
    const next = text.trim()
    if (next.startsWith(HEARTBEAT_TOKEN)) {
      text = next.slice(HEARTBEAT_TOKEN.length).trimStart()
      didStrip = true
      changed = true
      continue
    }
    if (endPattern.test(next)) {
      const idx = next.lastIndexOf(HEARTBEAT_TOKEN)
      const before = next.slice(0, idx).trimEnd()
      if (!before) {
        text = ""
      } else {
        const after = next.slice(idx + HEARTBEAT_TOKEN.length).trimStart()
        text = `${before}${after}`.trimEnd()
      }
      didStrip = true
      changed = true
    }
  }

  return { text: text.replace(/\s+/g, " ").trim(), didStrip }
}

/**
 * Ported from Moltbot's stripHeartbeatToken.
 * Returns shouldSkip=true when the reply is just an ack with no real content.
 */
function stripHeartbeatToken(raw: string): { shouldSkip: boolean; text: string; didStrip: boolean } {
  const trimmed = raw.trim()
  if (!trimmed) return { shouldSkip: true, text: "", didStrip: false }

  const normalized = stripMarkup(trimmed)
  if (!trimmed.includes(HEARTBEAT_TOKEN) && !normalized.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false, text: trimmed, didStrip: false }
  }

  const fromOriginal = stripTokenAtEdges(trimmed)
  const fromNormalized = stripTokenAtEdges(normalized)
  const picked = fromOriginal.didStrip && fromOriginal.text ? fromOriginal : fromNormalized
  if (!picked.didStrip) return { shouldSkip: false, text: trimmed, didStrip: false }
  if (!picked.text) return { shouldSkip: true, text: "", didStrip: true }

  const rest = picked.text.trim()
  if (rest.length <= ACK_MAX_CHARS) return { shouldSkip: true, text: "", didStrip: true }

  return { shouldSkip: false, text: rest, didStrip: true }
}

export function startHeartbeat(): void {
  console.log("[Heartbeat] Starting heartbeat service")
  scheduleNext(true)
}

export function stopHeartbeat(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  running = false
  console.log("[Heartbeat] Stopped heartbeat service")
}

/** Restart the timer without aborting a running execution */
export function restartHeartbeat(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  scheduleNext(false)
}

function scheduleNext(compensate = false): void {
  const config = getHeartbeatConfig()
  if (!config.enabled) {
    console.log("[Heartbeat] Disabled, not scheduling")
    return
  }
  const fullMs = Math.max(1, config.intervalMinutes) * 60_000
  let delay = fullMs
  if (compensate && config.lastRunAt) {
    const elapsed = Date.now() - new Date(config.lastRunAt).getTime()
    delay = Math.max(0, fullMs - elapsed)
  }
  tickTimer = setTimeout(() => {
    tickTimer = null
    tick()
  }, delay)
  const delaySec = Math.round(delay / 1000)
  console.log(`[Heartbeat] Next run in ${delaySec}s (interval ${config.intervalMinutes}m)`)
}

function tick(): void {
  if (running) {
    console.log("[Heartbeat] Already running, skipping this tick")
    scheduleNext()
    return
  }
  executeHeartbeat()
    .catch((err) => console.error("[Heartbeat] Execution error:", err))
    .finally(() => scheduleNext())
}

export async function runHeartbeatNow(): Promise<void> {
  if (running) throw new Error("Heartbeat is already running")
  await executeHeartbeat()
}

export function cancelHeartbeat(): void {
  if (abortController) {
    abortController.abort()
  }
}

export function isHeartbeatRunning(): boolean {
  return running
}

async function executeHeartbeat(): Promise<void> {
  const config = getHeartbeatConfig()
  if (!config.workDir) {
    saveHeartbeatConfig({ lastRunStatus: "error", lastRunError: "No workspace configured", lastRunAt: new Date().toISOString() })
    notifyRenderer("heartbeat:changed")
    return
  }
  const globalRoutingMode = getGlobalRoutingMode()
  const routingResult = await resolveModel({
    taskSource: "heartbeat",
    threadId: HEARTBEAT_THREAD_ID,
    requestedModelId: config.modelId || undefined,
    routingMode: globalRoutingMode
  }).catch(() => null)

  const effectiveModelId = routingResult?.resolvedModelId ?? config.modelId ?? undefined

  if (!effectiveModelId) {
    saveHeartbeatConfig({ lastRunStatus: "error", lastRunError: "No model configured", lastRunAt: new Date().toISOString() })
    notifyRenderer("heartbeat:changed")
    return
  }

  const content = getHeartbeatContent()
  if (!content || isContentEmpty(content)) {
    console.log("[Heartbeat] HEARTBEAT.md is empty, skipping")
    saveHeartbeatConfig({ lastRunStatus: "skipped", lastRunError: null, lastRunAt: new Date().toISOString() })
    notifyRenderer("heartbeat:changed")
    return
  }

  running = true
  abortController = new AbortController()
  notifyRenderer("heartbeat:changed")

  const threadId = HEARTBEAT_THREAD_ID

  // Ensure thread exists in DB and metadata stays current
  const existing = dbGetThread(threadId)
  if (!existing) {
    dbCreateThread(threadId, {
      workspacePath: config.workDir,
      title: "[Heartbeat] 心跳检查",
      isHeartbeat: true
    })
    notifyRenderer("threads:changed")
  } else {
    const meta = existing.metadata ? JSON.parse(existing.metadata) : {}
    if (meta.workspacePath !== config.workDir) {
      dbUpdateThread(threadId, {
        metadata: JSON.stringify({ ...meta, workspacePath: config.workDir })
      })
    }
  }

  const channel = `heartbeat:stream:${threadId}`

  try {
    // Snapshot pre-heartbeat checkpoint so we can restore if HEARTBEAT_OK
    const checkpointer = await getCheckpointer(threadId)
    const preHeartbeatSnapshot = await checkpointer.getTuple({
      configurable: { thread_id: threadId }
    })

    const heartbeatGuidelines = [
      "## Heartbeat 行为准则",
      "- 不执行破坏性命令（优先 trash 而非 rm），不泄露隐私数据",
      "- 重要信息必须写入文件，不要依赖「记住」",
      "- 如果没有需要处理的事项，回复 HEARTBEAT_OK，不要编造任务",
      "- 不要重复之前已经完成的工作",
      "- 主动但不打扰：有事做事，无事安静"
    ].join("\n")
    const heartbeatContext = `${heartbeatGuidelines}\n\n# Project Context\n\n## HEARTBEAT.md\n\n${content}`
    const agent = await createAgentRuntime({
      threadId,
      workspacePath: config.workDir,
      modelId: effectiveModelId,
      extraSystemPrompt: heartbeatContext,
      enableAgentsPrompt: false,
      noSchedulerTool: true,
      abortSignal: abortController.signal
    })

    const converter = new StreamConverter()
    const stream = await agent.stream(
      { messages: [new HumanMessage(config.prompt)] },
      {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"],
        recursionLimit: 1000
      }
    )

    let fullReply = ""
    broadcastToChannel(channel, { type: "started" })

    for await (const chunk of stream) {
      if (abortController.signal.aborted) break
      const [mode, data] = chunk as [string, unknown]
      const serialized = JSON.parse(JSON.stringify(data))
      const events = converter.processChunk(mode, serialized)
      for (const evt of events) {
        broadcastToChannel(channel, evt)
        if ("content" in evt && typeof evt.content === "string") {
          fullReply += evt.content
        }
      }
    }

    broadcastToChannel(channel, { type: "done" })

    const stripped = stripHeartbeatToken(fullReply)
    if (stripped.shouldSkip) {
      // Restore pre-heartbeat checkpoint: only prune this HEARTBEAT_OK round,
      // preserving any previous actionable history. Aligns with Moltbot's pruneHeartbeatTranscript.
      try {
        const cp = await getCheckpointer(threadId)
        await cp.deleteThread(threadId)
        if (preHeartbeatSnapshot?.metadata) {
          await cp.put(
            preHeartbeatSnapshot.config,
            preHeartbeatSnapshot.checkpoint,
            preHeartbeatSnapshot.metadata
          )
        }
        console.log("[Heartbeat] Pruned HEARTBEAT_OK round, previous history preserved")
      } catch (e) {
        console.warn("[Heartbeat] Failed to prune checkpoint:", e)
      }
      saveHeartbeatConfig({
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "ok_silent",
        lastRunError: null
      })
      console.log("[Heartbeat] Completed, HEARTBEAT_OK (silent, no action needed)")
    } else {
      saveHeartbeatConfig({
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "ok",
        lastRunError: null
      })
      notifyIfBackground("💓 Heartbeat", stripped.text.trim() || "检查完成，有需要关注的内容")
      console.log("[Heartbeat] Completed with actionable output")
    }
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
    const message = isAbort ? "Cancelled" : (error instanceof Error ? error.message : String(error))
    broadcastToChannel(channel, { type: "done" })
    saveHeartbeatConfig({
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "error",
      lastRunError: message
    })
    if (!isAbort) notifyIfBackground("❌ Heartbeat", message)
    console.error("[Heartbeat] Error:", message)
  } finally {
    running = false
    abortController = null
    closeCheckpointer(HEARTBEAT_THREAD_ID).catch(() => {})
    notifyRenderer("heartbeat:changed")
    notifyRenderer("threads:changed")
  }
}
