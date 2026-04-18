import { v4 as uuid } from "uuid"
import { BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
import { getScheduledTasks, getCustomModelConfigs, updateScheduledTaskRunResult, setScheduledTaskEnabled, addTaskRunRecord, getGlobalRoutingMode } from "../storage"
import { resolveModel, rememberRoutingDecision, rememberRoutingFeedback } from "../routing"
import { TraceCollector } from "../agent/trace/collector"
import { trySendChatXReply } from "./chatx"
import { createAgentRuntime, closeCheckpointer } from "../agent/runtime"
import { createThread as dbCreateThread, deleteThread as dbDeleteThread } from "../db"
import { StreamConverter } from "../agent/stream-converter"
import { notifyAlways, stripThink } from "./notify"

const TICK_INTERVAL_MS = 60_000
const ONCE_EXPIRE_MS = 30 * 60_000 // once tasks older than 30 min are auto-disabled instead of executed
let tickTimer: ReturnType<typeof setTimeout> | null = null
const runningTasks = new Set<string>()
const activeAbortControllers = new Map<string, AbortController>()

function recordRun(
  taskId: string, taskName: string, startedAt: Date,
  status: "ok" | "error", error: string | null
): void {
  const finishedAt = new Date()
  addTaskRunRecord({
    id: uuid(), taskId, taskName,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    status, error, durationMs: finishedAt.getTime() - startedAt.getTime()
  })
}

function notifyRenderer(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel)
  }
}

function showTaskNotification(taskName: string, status: "ok" | "error", body?: string): void {
  const title = status === "ok" ? `✅ ${taskName}` : `❌ ${taskName}`
  const text = status === "ok"
    ? stripThink(body || "任务已完成").trim() || "任务已完成"
    : (body || "任务执行失败")
  notifyAlways(title, text)
}

export function startScheduler(): void {
  console.log("[Scheduler] Starting scheduler service")
  tick()
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  for (const [id, controller] of activeAbortControllers) {
    console.log(`[Scheduler] Aborting running task on shutdown: ${id}`)
    controller.abort()
  }
  activeAbortControllers.clear()
  runningTasks.clear()
  console.log("[Scheduler] Stopped scheduler service")
}

function armTimer(): void {
  tickTimer = setTimeout(tick, TICK_INTERVAL_MS)
}

function tick(): void {
  tickTimer = null
  try {
    const now = new Date()
    const tasks = getScheduledTasks()

    for (const task of tasks) {
      if (!task.enabled || task.frequency === "manual") continue
      if (runningTasks.has(task.id)) continue
      if (!task.nextRunAt) continue

      const nextRun = new Date(task.nextRunAt)
      if (now >= nextRun) {
        if (task.frequency === "once" && now.getTime() - nextRun.getTime() > ONCE_EXPIRE_MS) {
          console.log(`[Scheduler] Once task expired (>${ONCE_EXPIRE_MS / 60_000}min late), auto-disabling: ${task.name}`)
          setScheduledTaskEnabled(task.id, false)
          notifyRenderer("scheduledTasks:changed")
          continue
        }
        executeTask(task.id).catch((err) => {
          console.error(`[Scheduler] Task ${task.id} failed:`, err)
        })
      }
    }
  } catch (err) {
    console.error("[Scheduler] tick error:", err)
  } finally {
    armTimer()
  }
}

function broadcastToChannel(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

async function executeTask(taskId: string): Promise<void> {
  const tasks = getScheduledTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (!task.enabled) return

  runningTasks.add(taskId)
  const abortController = new AbortController()
  activeAbortControllers.set(taskId, abortController)
  notifyRenderer("scheduledTasks:changed")
  console.log(`[Scheduler] Executing task: ${task.name} (${taskId})`)
  const startedAt = new Date()

  const threadId = uuid()
  const channel = `scheduler:stream:${threadId}`

  let threadCreated = false
  let hasStreamedContent = false
  let taskError: unknown = null

  // Hoisted so catch/finally blocks can access for routing feedback & trace
  let routingResult: Awaited<ReturnType<typeof resolveModel>> | null = null
  let toolCallCount = 0
  let toolErrorCount = 0
  let highWaterInputTokens = 0

  // reminder 类型：执行时动态包装暖心模板；action 类型：原样发送
  const finalPrompt = task.taskType === "reminder"
    ? `你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：${task.prompt}\n要求：\n(1) 不要解释你是谁\n(2) 直接输出一条暖心的提醒消息\n(3) 可以加一句简短的鸡汤或关怀的话\n(4) 控制在2-3句话以内\n(5) 用emoji点缀`
    : task.prompt

  const tracer = new TraceCollector(threadId, finalPrompt, task.modelId ?? "unknown")

  try {
    const workspacePath = task.workDir
    if (!workspacePath) {
      await tracer.finish("error", "No workspace directory")
      throw new Error("No workspace directory configured for this task")
    }

    const now = new Date()
    const timeTag = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    const title = `[定时] ${task.name} · ${timeTag}`
    dbCreateThread(threadId, { workspacePath, title, scheduledTaskId: task.id })
    threadCreated = true
    notifyRenderer("threads:changed")

    broadcastToChannel(channel, { type: "started" })

    const globalRoutingMode = getGlobalRoutingMode()
    const schedulerSource = task.taskType === "reminder" ? "scheduler_reminder" : "scheduler_action"
    routingResult = await resolveModel({
      taskSource: schedulerSource,
      message: task.prompt,
      threadId,
      requestedModelId: task.modelId || undefined,
      routingMode: globalRoutingMode
    }).catch(() => null)
    const effectiveModelId = routingResult?.resolvedModelId ?? task.modelId ?? undefined

    // Persist routing decision for thread continuity
    if (routingResult) rememberRoutingDecision(threadId, routingResult)

    // Attach routing trace
    if (routingResult?.routingTrace) {
      tracer.setRoutingTrace(routingResult.routingTrace)
    }

    // Update tracer with resolved model info
    if (effectiveModelId) {
      tracer.setModelId(effectiveModelId)
      const cfgId = effectiveModelId.startsWith("custom:") ? effectiveModelId.slice("custom:".length) : effectiveModelId
      const cfg = getCustomModelConfigs().find((c) => c.id === cfgId)
      if (cfg?.model) tracer.setModelName(cfg.model)
    }

    const agent = await createAgentRuntime({
      threadId,
      workspacePath,
      modelId: effectiveModelId,
      enableAgentsPrompt: false,
      noSchedulerTool: true,
      abortSignal: abortController.signal
    })

    const converter = new StreamConverter()

    const stream = await agent.stream(
      { messages: [new HumanMessage(finalPrompt)] },
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

        // Track token usage from stream events
        if (evt.type === "custom") {
          const customData = evt.data as Record<string, unknown>
          if (customData.type === "token_usage") {
            const usage = customData.usage as { inputTokens?: number } | undefined
            if (usage?.inputTokens && usage.inputTokens > highWaterInputTokens) {
              highWaterInputTokens = usage.inputTokens
            }
          }
        }

        // Track tool calls
        if (evt.type === "message-delta" && evt.toolCalls && Array.isArray(evt.toolCalls)) {
          toolCallCount += evt.toolCalls.length
        }

        // Track tool errors
        if (evt.type === "tool-message") {
          const content = typeof evt.content === "string" ? evt.content : ""
          if (/error|exception|failed/i.test(content)) {
            toolErrorCount++
          }
        }

        // Capture last assistant text for notification
        if (evt.type === "full-messages") {
          // 只取最后一条没有 tool_calls 的 assistant 消息（最终回复）
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
      updateScheduledTaskRunResult(taskId, "ok", null)
      recordRun(taskId, task.name, startedAt, "ok", null)

      await tracer.finish("success")

      // Write routing feedback
      if (routingResult) {
        rememberRoutingFeedback(threadId, {
          resolvedTier: routingResult.resolvedTier,
          resolvedModelId: routingResult.resolvedModelId,
          outcome: "success",
          toolCallCount,
          toolErrorCount,
          lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
        })
      }

      if (task.frequency === "once") {
        setScheduledTaskEnabled(taskId, false)
        console.log(`[Scheduler] Once task auto-disabled: ${task.name}`)
      }
      showTaskNotification(task.name, "ok", lastAssistantText)
      // If task is linked to a ChatX robot, send reply via HTTP
      if (task.chatxRobotChatId && lastAssistantText) {
        trySendChatXReply(task.chatxRobotChatId, lastAssistantText)
      }
      console.log(`[Scheduler] Task completed: ${task.name}`)
    } else {
      updateScheduledTaskRunResult(taskId, "error", "Cancelled by user")
      recordRun(taskId, task.name, startedAt, "error", "Cancelled by user")

      tracer.finish("cancelled").catch(() => {})

      if (routingResult) {
        rememberRoutingFeedback(threadId, {
          resolvedTier: routingResult.resolvedTier,
          resolvedModelId: routingResult.resolvedModelId,
          outcome: "cancelled",
          toolCallCount,
          toolErrorCount,
          lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
        })
      }

      console.log(`[Scheduler] Task cancelled: ${task.name}`)
    }
  } catch (error) {
    taskError = error
    const isAbortError =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"))
    const errMsg = isAbortError ? "Cancelled by user" : (error instanceof Error ? error.message : String(error))
    if (isAbortError) {
      updateScheduledTaskRunResult(taskId, "error", errMsg)
      tracer.finish("cancelled").catch(() => {})
      console.log(`[Scheduler] Task cancelled: ${task.name}`)
    } else {
      updateScheduledTaskRunResult(taskId, "error", errMsg)
      tracer.finish("error", errMsg).catch(() => {})
      showTaskNotification(task.name, "error", errMsg)
      console.error(`[Scheduler] Task error: ${task.name}:`, errMsg)
    }
    recordRun(taskId, task.name, startedAt, "error", errMsg)

    // Write routing feedback for error/cancel
    if (routingResult) {
      rememberRoutingFeedback(threadId, {
        resolvedTier: routingResult.resolvedTier,
        resolvedModelId: routingResult.resolvedModelId,
        outcome: isAbortError ? "cancelled" : "error",
        toolCallCount,
        toolErrorCount,
        lastInputTokens: highWaterInputTokens > 0 ? highWaterInputTokens : undefined
      })
    }
    // Clean up empty thread if runtime failed before any content was streamed
    if (threadCreated && !hasStreamedContent) {
      try {
        dbDeleteThread(threadId)
      } catch {
        // ignore cleanup errors
      }
    }
  } finally {
    // IMPORTANT: delete from runningTasks BEFORE broadcasting done/error to the
    // renderer, otherwise the renderer's loadThreadHistory → isRunning check will
    // see the task as still running and re-set scheduledTaskLoading = true (race).
    runningTasks.delete(taskId)
    activeAbortControllers.delete(taskId)
    closeCheckpointer(threadId).catch(() => {})

    // Now broadcast lifecycle event — renderer can safely call isRunning() = false
    if (taskError) {
      const isAbortError =
        taskError instanceof Error &&
        (taskError.name === "AbortError" || taskError.message.includes("aborted"))
      if (isAbortError) {
        broadcastToChannel(channel, { type: "done" })
      } else {
        const errMsg = taskError instanceof Error ? taskError.message : String(taskError)
        broadcastToChannel(channel, { type: "error", error: errMsg })
      }
    } else {
      broadcastToChannel(channel, { type: "done" })
    }

    notifyRenderer("scheduledTasks:changed")
    notifyRenderer("threads:changed")
  }
}

export async function runTaskNow(taskId: string): Promise<void> {
  if (runningTasks.has(taskId)) {
    throw new Error("Task is already running")
  }
  await executeTask(taskId)
}

export function cancelTask(taskId: string): void {
  const controller = activeAbortControllers.get(taskId)
  if (controller) {
    controller.abort()
  }
}

export function isTaskRunning(taskId: string): boolean {
  return runningTasks.has(taskId)
}
