import { BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
import {
  getHeartbeatConfig,
  getHeartbeatContent,
  saveHeartbeatConfig,
  getGlobalRoutingMode
} from "../storage"
import { resolveModel } from "../routing"
import {
  createAgentRuntime,
  getCheckpointer,
  closeCheckpointer,
  pinCheckpointer,
  reviveRetiredThread
} from "../agent/runtime"
import { reviveWorkflowThread } from "../agent/workflow/run-store"
import {
  createThread as dbCreateThread,
  getThread as dbGetThread,
  updateThread as dbUpdateThread
} from "../db"
import { StreamConverter } from "../agent/stream-converter"
import { notifyIfBackground } from "./notify"
import { emitAppAttention } from "../app-attention-events"
import { trackEvent } from "./event-reporter"
import { v4 as uuid } from "uuid"
import {
  assertLocalThreadRunLease,
  claimLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"
import { HEARTBEAT_THREAD_ID } from "./heartbeat-session"
import { getAgentGraphRecursionLimit } from "../../shared/agent-runtime-limits"

let tickTimer: ReturnType<typeof setTimeout> | null = null
// A cleared timeout may already have a callback queued in the event loop. Each
// scheduled callback captures this generation so stop/restart can invalidate it
// permanently instead of relying on clearTimeout alone.
let tickTimerGeneration = 0
let running = false
let abortController: AbortController | null = null
let shuttingDown = false
let workspaceResetInProgress = false

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
function stripHeartbeatToken(raw: string): {
  shouldSkip: boolean
  text: string
  didStrip: boolean
} {
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
  shuttingDown = false
  scheduleNext(true)
}

export function stopHeartbeat(): void {
  tickTimerGeneration += 1
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  // Abort only — do NOT drop `running` or null the shared controller here.
  // The owning executeHeartbeat is still unwinding after this abort (model
  // call, checkpoint close): `running` is runNow's re-entry gate, and
  // releasing it early lets a new run start while the old close is mid-flush
  // — the new run pins first, skips the pending-close wait, and dual-writes
  // the same sqlite file. The run's own finally clears both (identity-checked)
  // after its close settles.
  abortController?.abort()
  console.log("[Heartbeat] Stopped heartbeat service")
}

/** Restart the timer without aborting a running execution */
export function restartHeartbeat(): void {
  tickTimerGeneration += 1
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  scheduleNext(false)
}

function scheduleNext(compensate = false): void {
  if (shuttingDown || workspaceResetInProgress) return
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
  const scheduledGeneration = ++tickTimerGeneration
  tickTimer = setTimeout(() => {
    if (scheduledGeneration !== tickTimerGeneration) return
    tickTimer = null
    tick()
  }, delay)
  const delaySec = Math.round(delay / 1000)
  console.log(`[Heartbeat] Next run in ${delaySec}s (interval ${config.intervalMinutes}m)`)
}

function tick(): void {
  // A timeout callback may already be queued when stopHeartbeat clears its
  // handle. The service-level gate closes that last race with workspace reset.
  if (workspaceResetInProgress) return
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
  assertHeartbeatCanStart()
  await executeHeartbeat()
}

/** Synchronous preflight for fire-and-forget heartbeat entry points. */
export function assertHeartbeatCanStart(): void {
  if (shuttingDown) throw new Error("The application is quitting; heartbeat cannot start.")
  if (workspaceResetInProgress) {
    throw new Error("Heartbeat workspace is being changed; heartbeat cannot start.")
  }
  if (running) throw new Error("Heartbeat is already running")
}

/**
 * Reserve the fixed heartbeat id while its previous workspace incarnation is
 * removed. The returned release must be called after cleanup and config persist
 * finish; direct scheduler-tool wakeups are rejected for the whole interval.
 */
export function beginHeartbeatWorkspaceReset(): () => void {
  if (running) {
    throw new Error("Heartbeat 正在运行，无法切换工作目录。请等待运行结束或先取消运行。")
  }
  if (workspaceResetInProgress) {
    throw new Error("Heartbeat 工作目录正在切换，请稍后重试。")
  }
  workspaceResetInProgress = true
  stopHeartbeat()
  return () => {
    workspaceResetInProgress = false
  }
}

export function cancelHeartbeat(): void {
  if (abortController) {
    abortController.abort()
  }
}

export function isHeartbeatRunning(): boolean {
  return running
}

export async function stopHeartbeatAndWait(timeoutMs = 5_000): Promise<void> {
  shuttingDown = true
  stopHeartbeat()
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  if (running) {
    console.warn("[Heartbeat] Timed out waiting for the active run to settle")
  }
}

async function executeHeartbeat(): Promise<void> {
  // Re-entry gate set SYNCHRONOUSLY, before the first await: runNow and the
  // scheduler wake fire-and-forget this function, so a gate set after
  // resolveModel() let a second trigger pass isHeartbeatRunning() during
  // routing — two concurrent beats then race getCheckpointer's
  // create-then-cache window and can put TWO savers on the same fixed-id
  // sqlite. Every exit below (including the pre-run gates) flows through the
  // finally, which restores the gate.
  running = true
  // Local ownership: every signal read below uses THIS controller, so a stop
  // racing the run can never null-deref the shared slot mid-loop; the finally
  // clears the shared slot identity-checked.
  const controller = new AbortController()
  abortController = controller
  notifyRenderer("heartbeat:changed")

  const threadId = HEARTBEAT_THREAD_ID
  const channel = `heartbeat:stream:${threadId}`
  // Baseline for telemetry; only outcomes past the gates emit run events, so
  // setting it before the gates adds no phantom "real run" metrics.
  const runStartedAt = Date.now()
  // Pinned only after the pre-run gates pass; the finally must not close a
  // checkpointer this run never opened.
  let releaseCheckpointerPin: (() => void) | null = null
  const heartbeatRunId = uuid()
  let leaseAcquired = false

  try {
    const config = getHeartbeatConfig()
    if (!config.workDir) {
      saveHeartbeatConfig({
        lastRunStatus: "error",
        lastRunError: "No workspace configured",
        lastRunAt: new Date().toISOString()
      })
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
      saveHeartbeatConfig({
        lastRunStatus: "error",
        lastRunError: "No model configured",
        lastRunAt: new Date().toISOString()
      })
      notifyRenderer("heartbeat:changed")
      return
    }

    const content = getHeartbeatContent()
    if (!content || isContentEmpty(content)) {
      console.log("[Heartbeat] HEARTBEAT.md is empty, skipping")
      saveHeartbeatConfig({
        lastRunStatus: "skipped",
        lastRunError: null,
        lastRunAt: new Date().toISOString()
      })
      notifyRenderer("heartbeat:changed")
      return
    }

    const leaseClaim = claimLocalThreadRunLease({
      threadId,
      owner: "scheduler",
      runId: heartbeatRunId
    })
    if (!leaseClaim.acquired) {
      console.log(
        `[Heartbeat] Thread is busy with ${leaseClaim.conflict.owner}; skipping this beat`
      )
      saveHeartbeatConfig({
        lastRunStatus: "skipped",
        lastRunError: "Heartbeat thread is busy",
        lastRunAt: new Date().toISOString()
      })
      notifyRenderer("heartbeat:changed")
      return
    }
    leaseAcquired = true
    releaseCheckpointerPin = pinCheckpointer(threadId)

    // Assert the fixed heartbeat id alive on EVERY beat, not only when the DB
    // row is missing. Thread deletion tombstones the id (runtime checkpointer +
    // workflow run-store); a beat racing that deletion can recreate the row
    // BEFORE the deletion's late retire lands, which re-tombstones the new
    // incarnation — and with the row now present, a row-missing-only revive
    // would never run again (stuck until restart). Re-asserting here makes any
    // such re-kill converge within one beat cycle. Inside try/finally so an
    // ensure failure still restores `running` and the pin.
    reviveRetiredThread(threadId)
    reviveWorkflowThread(threadId)

    // Ensure thread exists in DB and metadata stays current. `model` mirrors the
    // heartbeat's selected model into the thread metadata so ModelSwitcher shows
    // it on idle open (hydration reads metadata.model); without it currentModel
    // hydrates empty and the footer falls back to models[0]. The live routing_result
    // event above covers the running case; this covers the idle case. effectiveModelId
    // is guaranteed non-empty here by the gate above.
    const existing = dbGetThread(threadId)
    if (!existing) {
      dbCreateThread(threadId, {
        workspacePath: config.workDir,
        title: "[Heartbeat] 心跳检查",
        isHeartbeat: true,
        model: effectiveModelId
      })
      notifyRenderer("threads:changed")
    } else {
      const meta = existing.metadata ? JSON.parse(existing.metadata) : {}
      if (meta.workspacePath !== config.workDir || meta.model !== effectiveModelId) {
        dbUpdateThread(threadId, {
          metadata: JSON.stringify({
            ...meta,
            workspacePath: config.workDir,
            model: effectiveModelId
          })
        })
      }
    }

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
    assertLocalThreadRunLease(threadId, "scheduler", heartbeatRunId)
    const agent = await createAgentRuntime({
      threadId,
      workspacePath: config.workDir,
      modelId: effectiveModelId,
      extraSystemPrompt: heartbeatContext,
      enableAgentsPrompt: false,
      noSchedulerTool: true,
      abortSignal: controller.signal
    })

    const converter = new StreamConverter()
    const stream = await agent.stream(
      { messages: [new HumanMessage(config.prompt)] },
      {
        configurable: { thread_id: threadId },
        signal: controller.signal,
        streamMode: ["messages", "values"],
        recursionLimit: getAgentGraphRecursionLimit()
      }
    )

    let fullReply = ""
    broadcastToChannel(channel, { type: "started" })

    // Surface the actually-used model to the renderer. The heartbeat thread never
    // persists a model to its metadata (its selection lives in heartbeat-config),
    // and this stream — unlike the chat agent path — otherwise emits no
    // routing_result, so the footer's currentModel stays empty and ModelSwitcher
    // falls back to models[0] (always "first model"). This mirrors the chat path's
    // custom/routing_result envelope; handleCustomEvent syncs currentModel from it
    // (in-memory only, not written back to metadata).
    if (effectiveModelId) {
      broadcastToChannel(channel, {
        type: "custom",
        data: {
          type: "routing_result",
          resolvedModelId: effectiveModelId,
          resolvedTier: routingResult?.resolvedTier ?? "premium",
          routeReason: routingResult?.routeReason ?? "heartbeat-config"
        }
      })
    }

    for await (const chunk of stream) {
      if (controller.signal.aborted) break
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
        await checkpointer.deleteThread(threadId)
        if (preHeartbeatSnapshot?.metadata) {
          await checkpointer.put(
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
      try {
        trackEvent("heartbeat.run.completed", "heartbeat", {
          outcome: "silent",
          durationMs: Date.now() - runStartedAt,
          replyChars: fullReply.length
        })
      } catch (e) {
        console.warn("[event] failed to emit heartbeat.run.completed:", e)
      }
    } else {
      saveHeartbeatConfig({
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "ok",
        lastRunError: null
      })
      notifyIfBackground("💓 Heartbeat", stripped.text.trim() || "检查完成，有需要关注的内容")
      emitAppAttention({
        kind: "interaction",
        threadId
      })
      console.log("[Heartbeat] Completed with actionable output")
      try {
        trackEvent("heartbeat.run.completed", "heartbeat", {
          outcome: "actionable",
          durationMs: Date.now() - runStartedAt,
          replyChars: fullReply.length
        })
      } catch (e) {
        console.warn("[event] failed to emit heartbeat.run.completed:", e)
      }
    }
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
    const message = isAbort ? "Cancelled" : error instanceof Error ? error.message : String(error)
    broadcastToChannel(channel, { type: "done" })
    saveHeartbeatConfig({
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "error",
      lastRunError: message
    })
    if (!isAbort) {
      notifyIfBackground("❌ Heartbeat", message)
      emitAppAttention({
        kind: "task-error",
        threadId
      })
    }
    console.error("[Heartbeat] Error:", message)
    try {
      trackEvent("heartbeat.run.completed", "heartbeat", {
        outcome: isAbort ? "cancelled" : "error",
        durationMs: Date.now() - runStartedAt
      })
    } catch (e) {
      console.warn("[event] failed to emit heartbeat.run.completed:", e)
    }
  } finally {
    // Identity-checked: never clobber a NEWER run's controller (defense in
    // depth — the `running` gate should already prevent overlap).
    if (abortController === controller) abortController = null
    releaseCheckpointerPin?.()
    // Close BEFORE dropping `running`: runHeartbeatNow gates on that flag, and
    // a manual run landing inside this close window would pin first — pinned
    // threads skip the pending-close wait in getCheckpointer — creating a
    // second saver instance that writes the same file the old close is still
    // flushing (dual writer). Keeping the flag up until the close settles makes
    // re-entry wait it out instead. Skipped when the pre-run gates bailed —
    // this run never opened a checkpointer, so there is nothing to close.
    if (releaseCheckpointerPin) {
      await closeCheckpointer(HEARTBEAT_THREAD_ID).catch(() => {})
    }
    if (leaseAcquired) {
      releaseLocalThreadRunLease(threadId, "scheduler", heartbeatRunId)
    }
    running = false
    notifyRenderer("heartbeat:changed")
    notifyRenderer("threads:changed")
  }
}
