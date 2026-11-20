import { tool } from "langchain"
import { z } from "zod"
import { BrowserWindow } from "electron"
import {
  getScheduledTasks,
  upsertScheduledTask,
  deleteScheduledTask,
  setScheduledTaskEnabled,
  getHeartbeatConfig,
  getTaskRunHistory
} from "../../storage"
import { runTaskNow, isTaskRunning } from "../../services/scheduler"
import {
  runHeartbeatNow,
  isHeartbeatRunning,
  assertHeartbeatCanStart
} from "../../services/heartbeat"
import { getCheckpointer } from "../runtime"
import type { ScheduledTask, ScheduledTaskImDeliveryContext } from "../../types"

function notifyRenderer(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel)
  }
}

const ACTIONS = [
  "list",
  "create",
  "update",
  "delete",
  "enable",
  "disable",
  "run",
  "runs",
  "status",
  "wake"
] as const

const FREQUENCIES = ["once", "manual", "hourly", "daily", "weekdays", "weekly", "interval"] as const

const TASK_TYPES = ["action", "reminder"] as const

const CONTEXT_MESSAGES_MAX = 10
const CONTEXT_PER_MSG_MAX = 220
const CONTEXT_TOTAL_MAX = 700

const schedulerSchema = z.object({
  action: z
    .enum(ACTIONS)
    .describe("Action to perform: list/create/update/delete/enable/disable/run/runs/status/wake"),
  taskId: z
    .string()
    .optional()
    .describe("Task ID, required for update/delete/enable/disable/run/runs"),
  name: z.string().optional().describe("Task name (create/update)"),
  description: z.string().optional().describe("Task description (create/update)"),
  taskType: z
    .enum(TASK_TYPES)
    .optional()
    .describe(
      "REQUIRED for create. Task type: " +
        "'action' = agent executes real work (fix code, scan files, run commands); " +
        "'reminder' = warm reminder message (prompt is just the reminder content, system auto-wraps with template). " +
        "DEFAULT RULE: if user wants something DONE (fix/check/scan/build/deploy/review), use 'action'; " +
        "if user just wants to be REMINDED, use 'reminder'."
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      "Prompt text sent to the agent when the task fires (create/update). " +
        "For taskType='action': write a detailed, self-contained instruction (include workspace path, specific operations). " +
        "For taskType='reminder': just write the reminder content (e.g. '该喝水了'), system auto-wraps with warm template."
    ),
  frequency: z
    .enum(FREQUENCIES)
    .optional()
    .describe(
      "Schedule frequency (create/update). " +
        "Use 'once' with runAt for one-shot tasks, 'interval' with intervalMinutes for minute-level recurring, " +
        "or hourly/daily/weekdays/weekly for standard recurring tasks."
    ),
  intervalMinutes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Interval in minutes for 'interval' frequency (e.g. 5 = every 5 minutes). Required when frequency='interval'."
    ),
  runAt: z
    .string()
    .optional()
    .describe(
      "ISO-8601 timestamp with timezone offset for one-shot 'once' tasks (e.g. '2026-03-08T23:30:00+08:00'). " +
        "IMPORTANT: Always include the local timezone offset (like +08:00), NEVER use 'Z' (UTC). " +
        "Compute from the current local time shown in the system prompt."
    ),
  runAtTime: z
    .string()
    .optional()
    .describe("Time of day in HH:mm format for recurring tasks (e.g. '09:00')"),
  weekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe("Day of week 0-6 (Sun-Sat), only for 'weekly' frequency"),
  enabled: z.boolean().optional().describe("Whether the task is enabled (update)"),
  contextMessages: z
    .number()
    .optional()
    .describe(
      "Number of recent conversation messages (0-10) to append as context to the task prompt. " +
        "Use when creating reminders so the triggered task knows what was being discussed."
    ),
  limit: z
    .number()
    .optional()
    .describe("Max number of run records to return (runs action, default 10)")
})

interface SchedulerToolContext {
  workspacePath: string
  modelId?: string
  threadId?: string
  imDeliveryContext?: ScheduledTaskImDeliveryContext | null
}

function sameImDeliveryContext(
  left: ScheduledTaskImDeliveryContext | null | undefined,
  right: ScheduledTaskImDeliveryContext | null | undefined
): boolean {
  if (!left || !right) return left == null && right == null
  return (
    left.provider === right.provider &&
    left.principalId === right.principalId &&
    left.conversationKey === right.conversationKey &&
    left.inboxThreadId === right.inboxThreadId
  )
}

function tasksVisibleToContext(
  tasks: ScheduledTask[],
  context: SchedulerToolContext
): ScheduledTask[] {
  if (!context.imDeliveryContext) return tasks
  return tasks.filter((task) =>
    sameImDeliveryContext(task.imDeliveryContext, context.imDeliveryContext)
  )
}

/**
 * If LLM sends a UTC timestamp (ending with Z), treat it as if
 * the local time was intended and re-tag with the system timezone offset.
 * e.g. "2026-03-08T23:32:00.000Z" in +08:00 → "2026-03-08T23:32:00+08:00"
 */
function fixRunAtTimezone(runAt: string): string {
  if (!runAt.endsWith("Z") && !runAt.endsWith("z")) return runAt
  const offsetMin = -new Date().getTimezoneOffset()
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  const oh = String(Math.floor(abs / 60)).padStart(2, "0")
  const om = String(abs % 60).padStart(2, "0")
  return runAt.slice(0, -1) + `${sign}${oh}:${om}`
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + "..."
}

async function buildContextSuffix(threadId: string | undefined, count: number): Promise<string> {
  if (!threadId || count <= 0) return ""
  const n = Math.min(CONTEXT_MESSAGES_MAX, Math.max(0, Math.floor(count)))
  if (n === 0) return ""

  try {
    const checkpointer = await getCheckpointer(threadId)
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } })
    if (!tuple?.checkpoint) return ""

    const values = tuple.checkpoint.channel_values as Record<string, unknown> | undefined
    const messages = Array.isArray(values?.messages) ? values.messages : []

    const recent = messages.slice(-n * 3)
    if (recent.length === 0) return ""

    const lines: string[] = []
    let total = 0
    let collected = 0
    for (const msg of recent) {
      const role = (msg as { _getType?: () => string })?._getType?.() ?? "unknown"
      if (role !== "human" && role !== "ai") continue
      const label = role === "human" ? "User" : "Assistant"
      const content =
        typeof (msg as { content?: unknown }).content === "string"
          ? (msg as { content: string }).content
          : ""
      if (!content) continue
      const line = `- ${label}: ${truncateText(content, CONTEXT_PER_MSG_MAX)}`
      total += line.length
      if (total > CONTEXT_TOTAL_MAX) break
      lines.push(line)
      collected++
      if (collected >= n) break
    }
    if (lines.length === 0) return ""
    return "\n\nRecent context:\n" + lines.join("\n")
  } catch (e) {
    console.warn("[SchedulerTool] Failed to build context:", e)
    return ""
  }
}

export function createSchedulerTool(context: SchedulerToolContext) {
  const isRemoteInbox = Boolean(context.imDeliveryContext)
  return tool(
    async (input) => {
      switch (input.action) {
        case "status": {
          const tasks = tasksVisibleToContext(getScheduledTasks(), context)
          const running = tasks.filter((t) => isTaskRunning(t.id))
          const enabled = tasks.filter((t) => t.enabled)
          if (isRemoteInbox) {
            return JSON.stringify(
              {
                scheduler: {
                  totalTasks: tasks.length,
                  enabledTasks: enabled.length,
                  runningTasks: running.map((t) => ({ id: t.id, name: t.name }))
                }
              },
              null,
              2
            )
          }
          const hbConfig = getHeartbeatConfig()
          return JSON.stringify(
            {
              scheduler: {
                totalTasks: tasks.length,
                enabledTasks: enabled.length,
                runningTasks: running.map((t) => ({ id: t.id, name: t.name }))
              },
              heartbeat: {
                enabled: hbConfig.enabled,
                intervalMinutes: hbConfig.intervalMinutes,
                running: isHeartbeatRunning(),
                lastRunAt: hbConfig.lastRunAt,
                lastRunStatus: hbConfig.lastRunStatus
              }
            },
            null,
            2
          )
        }

        case "list": {
          const tasks = tasksVisibleToContext(getScheduledTasks(), context)
          const summary = tasks.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            taskType: t.taskType ?? "action",
            frequency: t.frequency,
            intervalMinutes: t.intervalMinutes,
            enabled: t.enabled,
            running: isTaskRunning(t.id),
            nextRunAt: t.nextRunAt,
            lastRunAt: t.lastRunAt,
            lastRunStatus: t.lastRunStatus
          }))
          return JSON.stringify(summary, null, 2)
        }

        case "create": {
          if (!input.name) return "Error: name is required for create"
          if (!input.prompt) return "Error: prompt is required for create"
          const freq = input.frequency ?? "manual"
          if (freq === "once" && !input.runAt) {
            return "Error: runAt (ISO timestamp) is required for once frequency"
          }
          if (freq === "interval" && (!input.intervalMinutes || input.intervalMinutes < 1)) {
            return "Error: intervalMinutes (>= 1) is required for interval frequency"
          }
          const taskType = input.taskType ?? (isRemoteInbox ? "reminder" : "action")
          if (isRemoteInbox && taskType !== "reminder") {
            return "Error: remote inbox only supports reminder tasks"
          }
          // 存储原始 prompt，执行时再根据 taskType 动态包装
          let prompt = input.prompt
          let contextAttached = false
          if (input.contextMessages && input.contextMessages > 0) {
            const suffix = await buildContextSuffix(context.threadId, input.contextMessages)
            if (suffix) {
              prompt += suffix
              contextAttached = true
            }
          }
          const runAt = input.runAt ? fixRunAtTimezone(input.runAt) : null
          const id = upsertScheduledTask({
            name: input.name,
            description: input.description ?? input.name,
            prompt,
            taskType,
            modelId: context.modelId ?? null,
            workDir: context.workspacePath,
            imDeliveryContext: context.imDeliveryContext ?? null,
            frequency: freq,
            intervalMinutes: input.intervalMinutes ?? null,
            runAt,
            runAtTime: input.runAtTime ?? null,
            weekday: input.weekday ?? null,
            enabled: input.enabled ?? true
          })
          notifyRenderer("scheduledTasks:changed")
          const task = getScheduledTasks().find((t) => t.id === id)
          return JSON.stringify({
            success: true,
            id,
            name: input.name,
            taskType,
            frequency: freq,
            nextRunAt: task?.nextRunAt ?? null,
            contextAttached
          })
        }

        case "update": {
          if (!input.taskId) return "Error: taskId is required for update"
          const tasks = tasksVisibleToContext(getScheduledTasks(), context)
          const existing = tasks.find((t) => t.id === input.taskId)
          if (!existing) return `Error: task not found: ${input.taskId}`
          const taskType = input.taskType ?? existing.taskType
          if (isRemoteInbox && taskType !== "reminder") {
            return "Error: remote inbox only supports reminder tasks"
          }
          // 存储原始 prompt，执行时再根据 taskType 动态包装
          let prompt = input.prompt ?? existing.prompt
          let contextAttached = false
          if (input.prompt && input.contextMessages && input.contextMessages > 0) {
            const suffix = await buildContextSuffix(context.threadId, input.contextMessages)
            if (suffix) {
              prompt += suffix
              contextAttached = true
            }
          }
          const id = upsertScheduledTask({
            id: input.taskId,
            name: input.name ?? existing.name,
            description: input.description ?? existing.description,
            prompt,
            taskType,
            modelId: existing.modelId,
            workDir: existing.workDir,
            imDeliveryContext: existing.imDeliveryContext ?? null,
            frequency: input.frequency ?? existing.frequency,
            intervalMinutes: input.intervalMinutes ?? existing.intervalMinutes,
            runAt: input.runAt ? fixRunAtTimezone(input.runAt) : existing.runAt,
            runAtTime: input.runAtTime ?? existing.runAtTime,
            weekday: input.weekday ?? existing.weekday,
            enabled: input.enabled ?? existing.enabled
          })
          notifyRenderer("scheduledTasks:changed")
          const updated = getScheduledTasks().find((t) => t.id === id)
          return JSON.stringify({
            success: true,
            id,
            name: updated?.name,
            taskType,
            nextRunAt: updated?.nextRunAt,
            contextAttached
          })
        }

        case "delete": {
          if (!input.taskId) return "Error: taskId is required for delete"
          const tasks = tasksVisibleToContext(getScheduledTasks(), context)
          if (!tasks.find((t) => t.id === input.taskId)) {
            return `Error: task not found: ${input.taskId}`
          }
          deleteScheduledTask(input.taskId)
          notifyRenderer("scheduledTasks:changed")
          return JSON.stringify({ success: true, deleted: input.taskId })
        }

        case "enable":
        case "disable": {
          if (!input.taskId) return `Error: taskId is required for ${input.action}`
          const tasks = tasksVisibleToContext(getScheduledTasks(), context)
          if (!tasks.find((t) => t.id === input.taskId)) {
            return `Error: task not found: ${input.taskId}`
          }
          setScheduledTaskEnabled(input.taskId, input.action === "enable")
          notifyRenderer("scheduledTasks:changed")
          return JSON.stringify({
            success: true,
            id: input.taskId,
            enabled: input.action === "enable"
          })
        }

        case "run": {
          if (!input.taskId) return "Error: taskId is required for run"
          const tasks = tasksVisibleToContext(getScheduledTasks(), context)
          const task = tasks.find((t) => t.id === input.taskId)
          if (!task) return `Error: task not found: ${input.taskId}`
          if (isTaskRunning(input.taskId)) {
            return "Error: task is already running"
          }
          if (!task.workDir) return "Error: task has no workspace directory configured"
          runTaskNow(input.taskId).catch((err) => {
            console.error(`[SchedulerTool] runNow error:`, err)
          })
          return JSON.stringify({
            success: true,
            id: input.taskId,
            message: "Task execution started (runs asynchronously)"
          })
        }

        case "runs": {
          if (!input.taskId) return "Error: taskId is required for runs"
          const task = tasksVisibleToContext(getScheduledTasks(), context).find(
            (candidate) => candidate.id === input.taskId
          )
          if (!task) return `Error: task not found: ${input.taskId}`
          const records = getTaskRunHistory(input.taskId, input.limit ?? 10)
          if (records.length === 0) {
            return JSON.stringify({
              taskId: input.taskId,
              runs: [],
              message: "No run history found"
            })
          }
          return JSON.stringify(
            {
              taskId: input.taskId,
              total: records.length,
              runs: records.map((r) => ({
                id: r.id,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt,
                status: r.status,
                error: r.error,
                durationMs: r.durationMs
              }))
            },
            null,
            2
          )
        }

        case "wake": {
          if (isRemoteInbox) return "Error: heartbeat is unavailable from the remote inbox"
          try {
            assertHeartbeatCanStart()
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`
          }
          const hbConfig = getHeartbeatConfig()
          if (!hbConfig.enabled) {
            return "Error: heartbeat is not enabled. Enable it in the Heartbeat settings panel first."
          }
          runHeartbeatNow().catch((err) => {
            console.error("[SchedulerTool] wake/heartbeat error:", err)
          })
          return JSON.stringify({
            success: true,
            message: "Heartbeat triggered (runs asynchronously)"
          })
        }

        default:
          return `Error: unknown action: ${input.action}`
      }
    },
    {
      name: "manage_scheduler",
      description: isRemoteInbox
        ? "Manage reminders that belong only to this managed remote inbox. " +
          "Only taskType='reminder' is allowed; action tasks and heartbeat are unavailable. " +
          "Use list/create/update/delete/enable/disable/run/runs/status. " +
          "For one-shot reminders use frequency='once' with an ISO-8601 runAt including the local timezone offset. " +
          "For recurring reminders use hourly/daily/weekdays/weekly or interval. " +
          "The reminder will run in this same managed inbox and will be delivered proactively to the same IM conversation."
        : "Manage scheduled tasks and heartbeat wake events. Use for reminders and recurring automated tasks.\n\n" +
          "IMPORTANT: When a scheduled task fires, a separate agent executes the prompt in an independent thread. " +
          "The agent has full tool access (file read/write, execute commands, etc.) and can perform real work. " +
          "After completion, a desktop notification is sent with the agent's output. " +
          "Do NOT write the prompt as 'remind the user' or 'notify the user' — the agent cannot push notifications directly.\n\n" +
          "CRITICAL — taskType FIELD (REQUIRED for create):\n" +
          "You MUST set taskType when creating a task. This determines how the prompt is processed:\n" +
          "- taskType='action': The prompt is sent AS-IS to the agent as an operational instruction. " +
          "Use when user wants something DONE (fix/check/scan/build/deploy/review/refactor). " +
          "Write detailed instructions with workspace path and specific operations.\n" +
          "- taskType='reminder': The prompt is just the reminder CONTENT (e.g. '该喝水了'). " +
          "System auto-wraps it with a warm-reminder template. Use only when user wants to be REMINDED.\n" +
          "DEFAULT RULE: If in doubt, use 'action'. Only use 'reminder' when the user explicitly says '提醒我' without requesting actual work.\n\n" +
          "ACTIONS: list | create | update | delete | enable | disable | run | runs | status | wake\n\n" +
          "USAGE GUIDE:\n" +
          "- The prompt field is sent to a separate agent as its sole input. Write it as a self-contained instruction or message.\n" +
          '- For "remind me in N minutes/hours" requests, use frequency="once" with runAt set to an ISO-8601 timestamp with timezone offset (e.g. 2026-03-08T23:32:00+08:00). NEVER use Z suffix.\n' +
          '- For recurring tasks (e.g. "every day at 9am"), use frequency="daily"/"hourly"/"weekdays"/"weekly" with runAtTime="HH:mm".\n' +
          '- For minute-level recurring (e.g. "every 5 minutes"), use frequency="interval" with intervalMinutes.\n' +
          "- For weekly tasks, set weekday (0=Sun, 1=Mon, ..., 6=Sat).\n" +
          "- Use the wake action to immediately trigger a heartbeat check.\n" +
          '- Use "list" to show existing tasks, "status" to check scheduler and heartbeat state.\n' +
          '- Use "runs" with a taskId to view execution history for a specific task.\n' +
          "- Use contextMessages (1-10) when creating/updating tasks to automatically attach recent conversation messages as context to the prompt. If the response contains contextAttached=false but you passed contextMessages, inform the user that context retrieval failed and the task was created without conversation context.\n" +
          "- Before creating or managing scheduled tasks for the first time in a conversation, read the scheduler-assistant skill for detailed guidance.",
      schema: schedulerSchema
    }
  )
}
