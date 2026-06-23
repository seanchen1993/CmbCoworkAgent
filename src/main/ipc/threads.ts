import { IpcMain, BrowserWindow, dialog } from "electron"
import { existsSync } from "fs"
import Store from "electron-store"
import AdmZip from "adm-zip"
import { v4 as uuid } from "uuid"
import {
  getAllThreads,
  getThread,
  getThreadGoalEvents,
  getThreadGoalEventsForRestore,
  createThread as dbCreateThread,
  updateThread as dbUpdateThread,
  mergeThreadValues as dbMergeThreadValues,
  deleteThread as dbDeleteThread
} from "../db"
import {
  withCheckpointer,
  closeCheckpointer,
  closeWorkerCheckpointersForThread,
  clearToolConcurrencyLocksForThread
} from "../agent/runtime"
import { forgetCoordinatorThreadState } from "./agent"
import {
  deleteThreadCheckpoint,
  deleteThreadWorkerCheckpoints,
  deleteThreadWorkflowCheckpoints,
  getOpenworkDir
} from "../storage"
import { workflowRunManager } from "../agent/workflow/run-manager"
import { deleteWorkflowRunsForThread } from "../agent/workflow/run-store"
import {
  WORKFLOW_NOTIFICATION_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../agent/workflow/notification"

/**
 * Workflow notification plumbing messages (the completion trigger and the
 * expanded notification) are hidden in the chat UI; they must not leak into an
 * exported session either. The model's user-facing summary does NOT start with
 * these markers, so it is still exported.
 *
 * NOTE: this intentionally does NOT filter coordinator plumbing ([[CMB_COORDINATOR_
 * ...]]). Coordinator export keeps its HEAD behavior verbatim (those messages stay
 * in the export, as they always have) so this feature does not alter the existing
 * coordinator mode. Only the new workflow markers are dropped.
 */
function isWorkflowPlumbingContent(content: string): boolean {
  const trimmed = content.trimStart()
  return (
    // FULL-match the turn prompt (mirrors the main process's full-match fix) so a
    // user who pastes text merely STARTING with the trigger isn't dropped on export.
    trimmed === WORKFLOW_NOTIFICATION_TURN_PROMPT ||
    // The expanded notification carries a runId suffix, so it stays a prefix match.
    trimmed.startsWith(WORKFLOW_NOTIFICATION_MARKER_PREFIX)
  )
}
import {
  coordinatorWorkerManager,
  deleteCoordinatorWorkerArtifacts
} from "../agent/coordinator-worker-manager"
import { deleteTaskMmdThread } from "../agent/task-mmd/storage"
import { generateTitle } from "../services/title-generator"
import { fireSessionEnd } from "../hooks/session-lifecycle"
import { makeHookResultCallback } from "../hooks/result-callback"
import { disposeAgentThreadState } from "./agent"
import { getDefaultModel } from "./models"
import type { Thread, ThreadUpdateParams, ThreadValuesMergeParams } from "../types"
import { SqlGoalStore } from "../agent/goals/goal-store"
import type { ThreadGoal } from "../agent/goals/types"
import { GOAL_UI_EVENT_LIMIT } from "../../shared/goal-events"

type ExportMessageRole = "user" | "assistant" | "system" | "tool"

interface ExportAttachment {
  filename: string
}

interface ExportToolCall {
  id?: string
  name: string
  args: string
  truncated: boolean
}

interface ExportMessage {
  id: string
  role: ExportMessageRole
  content: string
  truncated?: boolean
  attachments: ExportAttachment[]
  toolCalls?: ExportToolCall[]
  toolCallNames?: string[]
  toolCallId?: string
  name?: string
  createdAt?: string
}

interface ExportPayload {
  version: 1
  exportedAt: string
  thread: {
    threadId: string
    title: string
    createdAt: string
    updatedAt: string
    workspacePath: string | null
  }
  messages: ExportMessage[]
}

interface CheckpointMessage {
  id?: string
  _getType?: () => string
  type?: string
  content?: string | Array<unknown>
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>
  tool_call_id?: string
  name?: string
}

interface ThreadCheckpoint {
  checkpoint?: {
    channel_values?: {
      messages?: CheckpointMessage[]
    }
  }
}

// 复用主进程 settings 存储，用于读取“最近一次选择的工作区”。
// 这里不存敏感信息，只读写路径类配置。
const settingsStore = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const CHECKPOINT_THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/

function assertValidCheckpointThreadId(threadId: string): string {
  const normalized = threadId.trim()
  if (!CHECKPOINT_THREAD_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid checkpoint threadId: ${threadId}`)
  }
  return normalized
}

async function assertCanPersistExplicitNormalMode(
  threadId: string,
  currentMetadata: Record<string, unknown>,
  nextMetadata: Record<string, unknown>
): Promise<void> {
  // Block a workspace switch WHILE staying in workflow mode: run files live under
  // the OLD workspace's .cmbdevclaw, but hydrate / completion notification / history
  // all look runs up by the thread's CURRENT workspacePath — switching orphans an
  // active or pending run. The leave guard below doesn't fire here (the mode is
  // unchanged), so cover it explicitly with the same active/pending condition. (#2)
  if (
    currentMetadata.agentMode === "workflow" &&
    nextMetadata.agentMode === "workflow" &&
    typeof currentMetadata.workspacePath === "string" &&
    typeof nextMetadata.workspacePath === "string" &&
    nextMetadata.workspacePath !== currentMetadata.workspacePath &&
    workflowRunManager.isBusyForThread(threadId, currentMetadata.workspacePath)
  ) {
    throw new Error("仍有动态工作流在运行或结果待汇报，请先等待其完成或取消后再切换工作目录。")
  }
  // Leaving workflow mode (to ANY non-workflow mode — normal OR coordinator) must
  // be blocked while a run is active or its result is still pending, or the
  // background run is orphaned (the renderer only schedules the completion turn in
  // workflow mode). Checked BEFORE the normal-only guard below so coordinator
  // targets are covered too. (Despite the function name, this also guards exits
  // from workflow mode.)
  if (currentMetadata.agentMode === "workflow" && nextMetadata.agentMode !== "workflow") {
    const wsp =
      typeof nextMetadata.workspacePath === "string"
        ? nextMetadata.workspacePath
        : typeof currentMetadata.workspacePath === "string"
          ? currentMetadata.workspacePath
          : undefined
    const active = workflowRunManager.isActive(threadId)
    const pendingRun = wsp ? workflowRunManager.findPendingNotification(wsp, threadId) : null
    // Escape hatch: don't block on a pending run whose auto-re-report has been
    // exhausted this process (wedged report turn / API outage) — else the user is
    // locked in workflow mode with no exit but deleting the thread. HONEST CAVEAT
    // (#5): leaving does NOT keep the pending result on the auto-report path. The
    // renderer only hydrates / schedules the notification turn for workflow-mode
    // threads, so a restart re-reports ONLY while the thread is still in workflow
    // mode. After leaving — and especially after a later workspace switch, which
    // makes list/hydrate look under the NEW path — the result is stranded under the
    // ORIGINAL workspace: NOT lost (it's on disk, visible in that workspace's
    // history panel), just off the auto-report path until the user returns to
    // workflow mode there. (So this is "leave but you'll have to come back for it",
    // not "leave and it follows you".)
    const pending = pendingRun !== null && !workflowRunManager.isRenotifyExhausted(pendingRun.runId)
    if (active || pending) {
      throw new Error("仍有动态工作流在运行或结果待汇报，请先等待其完成或取消后再切换模式。")
    }
    if (pendingRun) {
      console.warn(
        `[Workflow] Leaving workflow mode with a renotify-exhausted pending run ${pendingRun.runId}: its result stays under the original workspace and won't auto-report until you return to workflow mode there. (#5)`
      )
    }
    return
  }

  if (nextMetadata.agentMode !== "normal" || currentMetadata.agentMode === "normal") {
    return
  }

  const workspacePath =
    typeof nextMetadata.workspacePath === "string"
      ? nextMetadata.workspacePath
      : typeof currentMetadata.workspacePath === "string"
        ? currentMetadata.workspacePath
        : undefined

  if (!workspacePath) {
    const workers = coordinatorWorkerManager.readWorkers(threadId)
    const hasPendingNotifications = coordinatorWorkerManager.hasNotifications(threadId)
    const unresolvedWorkers = workers.filter(
      (worker) => worker.status === "running" || worker.notification_acknowledged === false
    )
    if (unresolvedWorkers.length === 0 && !hasPendingNotifications) {
      return
    }
    throw new Error("该线程缺少工作区路径，无法安全切回 Solo Agent。请先重新选择工作区后再切换。")
  }

  await coordinatorWorkerManager.restoreWorkersForThread({
    parentThreadId: threadId,
    workspacePath,
    mode: "active"
  })

  const workers = coordinatorWorkerManager.readWorkers(threadId)
  const hasPendingNotifications = coordinatorWorkerManager.hasNotifications(threadId)
  const unresolvedWorkers = workers.filter(
    (worker) => worker.status === "running" || worker.notification_acknowledged === false
  )
  if (unresolvedWorkers.length === 0 && !hasPendingNotifications) return

  const workerList = unresolvedWorkers
    .map((worker) => `${worker.worker_id}: ${worker.description}`)
    .join("; ")
  throw new Error(
    "仍有 Agent Team worker 在运行或结果待处理，请先处理完成后再切回 Solo Agent。" +
      (workerList ? `相关 worker：${workerList}` : "请先切回 Agent Team 处理这些结果。")
  )
}

const TOOL_CALL_ARGS_LIMIT = 1200
const TOOL_RESULT_CONTENT_LIMIT = 4000

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function toIsoString(value: number | Date): string {
  return new Date(value).toISOString()
}

function getMessageRole(msg: CheckpointMessage): ExportMessageRole | null {
  let type = msg.type
  if (!type && typeof msg._getType === "function") {
    type = msg._getType()
  }

  if (type === "human") return "user"
  if (type === "ai") return "assistant"
  if (type === "system") return "system"
  if (type === "tool") return "tool"
  return null
}

function stringifyContent(content: CheckpointMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const record = block as Record<string, unknown>
      if (typeof record.text === "string") return record.text
      if (typeof record.content === "string") return record.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function sanitizeAttachmentContent(content: string): {
  content: string
  attachments: ExportAttachment[]
} {
  const attachments: ExportAttachment[] = []
  const cleaned = content
    .replace(
      /<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g,
      (_match, encodedName: string) => {
        attachments.push({ filename: decodeXmlAttribute(encodedName) })
        return ""
      }
    )
    .trim()

  return { content: cleaned, attachments }
}

function safeFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .trim()

  return cleaned || "chat-session"
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
}

function stringifyToolArgs(args: unknown): string {
  if (args === undefined) return ""
  if (typeof args === "string") return args

  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      args,
      (_key, value) => {
        if (typeof value === "bigint") return value.toString()
        if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
        if (typeof value === "symbol") return value.toString()
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[Circular]"
          seen.add(value)
        }
        return value
      },
      2
    )
  } catch {
    return String(args)
  }
}

function truncateValue(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false }
  return { value: `${value.slice(0, limit)}\n...[truncated]`, truncated: true }
}

function buildExportToolCalls(toolCalls: CheckpointMessage["tool_calls"]): ExportToolCall[] {
  if (!Array.isArray(toolCalls)) return []

  return toolCalls.flatMap((toolCall): ExportToolCall[] => {
    const name = typeof toolCall?.name === "string" ? toolCall.name.trim() : ""
    if (!name) return []

    const serializedArgs = stringifyToolArgs(toolCall.args)
    const truncated = truncateValue(serializedArgs, TOOL_CALL_ARGS_LIMIT)

    return [
      {
        ...(typeof toolCall.id === "string" && toolCall.id ? { id: toolCall.id } : {}),
        name,
        args: truncated.value,
        truncated: truncated.truncated
      }
    ]
  })
}

function formatMarkdown(payload: ExportPayload): string {
  const lines: string[] = [
    `# ${escapeMarkdown(payload.thread.title)}`,
    "",
    `- Thread ID: \`${payload.thread.threadId}\``,
    `- Workspace: ${payload.thread.workspacePath ? escapeMarkdown(payload.thread.workspacePath) : "未关联工作区"}`,
    `- Created: ${payload.thread.createdAt}`,
    `- Updated: ${payload.thread.updatedAt}`,
    `- Exported: ${payload.exportedAt}`,
    ""
  ]

  const roleLabel: Record<ExportMessageRole, string> = {
    user: "User",
    assistant: "Assistant",
    system: "System",
    tool: "Tool Result"
  }

  for (const message of payload.messages) {
    if (
      !message.content.trim() &&
      message.attachments.length === 0 &&
      (!message.toolCalls || message.toolCalls.length === 0)
    ) {
      continue
    }

    lines.push(`## ${roleLabel[message.role]}`, "")
    if (message.role === "tool") {
      const toolMeta = [
        message.name ? `name: \`${escapeMarkdown(message.name)}\`` : null,
        message.toolCallId ? `tool_call_id: \`${escapeMarkdown(message.toolCallId)}\`` : null,
        message.truncated ? "content truncated" : null
      ].filter(Boolean)
      if (toolMeta.length > 0) {
        lines.push(`_${toolMeta.join(", ")}_`, "")
      }
    }
    if (message.attachments.length > 0) {
      lines.push(
        ...message.attachments.map(
          (attachment) => `- Attachment: ${escapeMarkdown(attachment.filename)}`
        ),
        ""
      )
    }
    if (message.content.trim()) {
      lines.push(message.content.trim(), "")
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      lines.push("### Tool Calls", "")
      for (const toolCall of message.toolCalls) {
        lines.push(
          `- ${escapeMarkdown(toolCall.name)}${toolCall.truncated ? " (args truncated)" : ""}`
        )
        if (toolCall.args.trim()) {
          lines.push("", "```json", toolCall.args, "```", "")
        }
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`
}

async function getLatestCheckpoint(threadId: string): Promise<ThreadCheckpoint | null> {
  return withCheckpointer(threadId, async (checkpointer) => {
    const config = { configurable: { thread_id: threadId } }
    for await (const checkpoint of checkpointer.list(config, { limit: 1 })) {
      return checkpoint as ThreadCheckpoint
    }
    return null
  })
}

function buildExportMessages(messages: CheckpointMessage[] | undefined): ExportMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.flatMap((msg, index): ExportMessage[] => {
    const role = getMessageRole(msg)
    if (!role) return []

    const rawContent = stringifyContent(msg.content)
    // Drop the new workflow notification plumbing from the export. Coordinator
    // plumbing is intentionally left as-is (HEAD behavior) — see helper note.
    if (isWorkflowPlumbingContent(rawContent)) return []
    const { content, attachments } = sanitizeAttachmentContent(rawContent)
    const exportedContent =
      role === "tool"
        ? truncateValue(content, TOOL_RESULT_CONTENT_LIMIT)
        : { value: content, truncated: false }
    const toolCalls = buildExportToolCalls(msg.tool_calls)
    const toolCallNames = toolCalls.map((toolCall) => toolCall.name)

    if (!exportedContent.value.trim() && attachments.length === 0 && toolCalls.length === 0) {
      return []
    }

    return [
      {
        id: msg.id || `msg-${index}`,
        role,
        content: exportedContent.value,
        ...(exportedContent.truncated ? { truncated: true } : {}),
        attachments,
        ...(toolCalls.length > 0 ? { toolCalls, toolCallNames } : {}),
        ...(role === "tool" && msg.tool_call_id ? { toolCallId: msg.tool_call_id } : {}),
        ...(role === "tool" && msg.name ? { name: msg.name } : {})
      }
    ]
  })
}

function serializeGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal
    ? {
        ...goal,
        ledger: {
          progress: [...goal.ledger.progress],
          evidence: [...goal.ledger.evidence],
          blockers: [...goal.ledger.blockers]
        },
        context: { ...goal.context }
      }
    : null
}

export function registerThreadHandlers(ipcMain: IpcMain): void {
  // List all threads
  ipcMain.handle("threads:list", async () => {
    const threads = getAllThreads()
    return threads.map((row) => ({
      thread_id: row.thread_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Thread["status"],
      title: row.title
    }))
  })

  // Get a single thread
  ipcMain.handle("threads:get", async (_event, threadId: string) => {
    const row = getThread(threadId)
    if (!row) return null
    return {
      thread_id: row.thread_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Thread["status"],
      thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
      title: row.title
    }
  })

  // Create a new thread
  ipcMain.handle("threads:create", async (_event, metadata?: Record<string, unknown>) => {
    const threadId = uuid()
    // 先拷贝一份，避免直接修改调用方传入的 metadata 对象。
    const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) }

    // 仅当调用方没有显式传 workspacePath 时，才自动继承最近工作区。
    // 这样可以兼容两种场景：
    // 1) 用户手动点“新任务” -> 自动带上最近目录；
    // 2) 业务方显式指定 workspacePath -> 保持调用方优先。
    const hasWorkspacePath = Object.prototype.hasOwnProperty.call(nextMetadata, "workspacePath")
    if (!hasWorkspacePath) {
      const lastWorkspacePath = settingsStore.get("workspacePath", null)
      // 仅在路径存在时回填，避免写入无效目录导致后续报错。
      if (
        typeof lastWorkspacePath === "string" &&
        lastWorkspacePath &&
        existsSync(lastWorkspacePath)
      ) {
        nextMetadata.workspacePath = lastWorkspacePath
      }
    }

    const hasModel = Object.prototype.hasOwnProperty.call(nextMetadata, "model")
    if (!hasModel) {
      const defaultModelId = getDefaultModel()
      if (defaultModelId) {
        nextMetadata.model = defaultModelId
      }
    }

    // title 仍保持原有规则：优先使用调用方传入，否则使用日期默认值。
    const title = (nextMetadata.title as string) || `Thread ${new Date().toLocaleDateString()}`
    nextMetadata.title = title

    const thread = dbCreateThread(threadId, nextMetadata)

    return {
      thread_id: thread.thread_id,
      created_at: new Date(thread.created_at),
      updated_at: new Date(thread.updated_at),
      metadata: thread.metadata ? JSON.parse(thread.metadata) : undefined,
      status: thread.status as Thread["status"],
      thread_values: thread.thread_values ? JSON.parse(thread.thread_values) : undefined,
      title
    } as Thread
  })

  // Update a thread
  ipcMain.handle("threads:update", async (_event, { threadId, updates }: ThreadUpdateParams) => {
    const updateData: Parameters<typeof dbUpdateThread>[1] = {}

    if (updates.metadata !== undefined) {
      const currentThread = getThread(threadId)
      const currentMetadata = currentThread?.metadata
        ? (JSON.parse(currentThread.metadata) as Record<string, unknown>)
        : {}
      await assertCanPersistExplicitNormalMode(
        threadId,
        currentMetadata,
        updates.metadata as Record<string, unknown>
      )
    }

    if (updates.title !== undefined) updateData.title = updates.title
    if (updates.status !== undefined) updateData.status = updates.status
    if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata)
    if (updates.thread_values !== undefined)
      updateData.thread_values = JSON.stringify(updates.thread_values)

    const row = dbUpdateThread(threadId, updateData)
    if (!row) throw new Error("Thread not found")

    return {
      thread_id: row.thread_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status as Thread["status"],
      thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
      title: row.title
    }
  })

  ipcMain.handle(
    "threads:mergeThreadValues",
    async (_event, { threadId, patch }: ThreadValuesMergeParams) => {
      const row = dbMergeThreadValues(threadId, patch)
      if (!row) throw new Error("Thread not found")

      return {
        thread_id: row.thread_id,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        status: row.status as Thread["status"],
        thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
        title: row.title
      }
    }
  )

  // Delete a thread
  ipcMain.handle("threads:delete", async (event, threadId: string) => {
    console.log("[Threads] Deleting thread:", threadId)

    // A background dynamic workflow must not outlive its thread. Cancel and wait
    // (bounded) for it to settle — best-effort, so a slow subagent can't hang
    // this IPC. The orphan-directory race is closed regardless of the timeout:
    // deleteWorkflowRunsForThread (below) marks the dir disposed, so any late
    // flush from a still-settling run becomes a no-op and can't recreate it.
    try {
      await workflowRunManager.cancelAndWait(threadId)
    } catch (error) {
      console.warn("[Threads] Workflow cancel on delete failed:", error)
    }
    // Drop the thread's tool-concurrency locks so the module-level map doesn't
    // keep one idle lock per deleted thread for the process lifetime.
    clearToolConcurrencyLocksForThread(threadId)
    // Drop any in-memory flush-failed workflow snapshots for this thread (each holds
    // a full journal). A run whose persist failed lives only in memory; cancelAndWait
    // above aborts the active run but never clears this table, so without this the
    // journal leaks in the main process until restart even after the thread is gone. (#3)
    workflowRunManager.forgetThread(threadId)

    // Fire SessionEnd before teardown so hooks can observe a valid thread record.
    // No-op if SessionStart never fired for this thread.
    const existingThread = getThread(threadId)
    let workspacePath: string | undefined
    if (existingThread?.metadata) {
      try {
        const metadata = JSON.parse(existingThread.metadata) as Record<string, unknown>
        workspacePath =
          typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
      } catch {
        workspacePath = undefined
      }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const hookChannel = `agent:stream:${threadId}`
    await fireSessionEnd(
      threadId,
      workspacePath,
      window ? makeHookResultCallback(window, hookChannel) : undefined
    )
    disposeAgentThreadState(threadId)

    const cancelledWorkers = coordinatorWorkerManager.cancelWorkersForThread(
      threadId,
      "Thread was deleted."
    )
    const waitForCleanupBestEffort = async (workerIds?: string[]) => {
      try {
        await coordinatorWorkerManager.waitForWorkerCleanup(threadId, workerIds)
      } catch (error) {
        console.warn("[Threads] Timed out waiting for coordinator worker cleanup:", error)
      }
    }
    if (cancelledWorkers.length > 0) {
      await waitForCleanupBestEffort(cancelledWorkers.map((worker) => worker.worker_id))
    }
    await waitForCleanupBestEffort()

    // Delete from our metadata store
    dbDeleteThread(threadId)
    console.log("[Threads] Deleted from metadata store")

    // Close any open checkpointer for this thread
    try {
      await closeCheckpointer(threadId)
      await closeWorkerCheckpointersForThread(threadId)
      console.log("[Threads] Closed checkpointer")
    } catch (e) {
      console.warn("[Threads] Failed to close checkpointer:", e)
    }

    coordinatorWorkerManager.forgetThread(threadId)
    forgetCoordinatorThreadState(threadId)
    if (workspacePath) {
      try {
        await deleteCoordinatorWorkerArtifacts(threadId, workspacePath)
        console.log("[Threads] Deleted coordinator worker artifacts")
      } catch (e) {
        console.warn("[Threads] Failed to delete coordinator worker artifacts:", e)
      }
      // Remove the thread's workflow run artifacts (the active run, if any, was
      // already settled above) so they don't linger as disk litter.
      deleteWorkflowRunsForThread(workspacePath, threadId)
    }

    // Delete the thread's checkpoint file
    try {
      deleteThreadCheckpoint(threadId)
      const deletedWorkerCheckpoints = deleteThreadWorkerCheckpoints(threadId)
      // Workflow subagents self-clean their checkpoints in their finally; this
      // sweeps the rare crash / failed-cleanup leftovers, mirroring the worker
      // sweep (which only covers __worker__, not __wf_). (#3)
      const deletedWorkflowCheckpoints = deleteThreadWorkflowCheckpoints(threadId)
      console.log("[Threads] Deleted checkpoint file", {
        deletedWorkerCheckpoints,
        deletedWorkflowCheckpoints
      })
    } catch (e) {
      console.warn("[Threads] Failed to delete checkpoint file:", e)
    }

    try {
      deleteTaskMmdThread(threadId)
      console.log("[Threads] Deleted task-mmd files")
    } catch (e) {
      console.warn("[Threads] Failed to delete task-mmd files:", e)
    }
  })

  // Get thread history (checkpoints)
  ipcMain.handle("threads:history", async (_event, threadId: string) => {
    try {
      return await withCheckpointer(threadId, async (checkpointer) => {
        const history: unknown[] = []
        const config = { configurable: { thread_id: threadId } }
        for await (const checkpoint of checkpointer.list(config, { limit: 50 })) {
          history.push(checkpoint)
        }
        return history
      })
    } catch (e) {
      console.warn("Failed to get thread history:", e)
      return []
    }
  })

  // Get the latest checkpoint only. Worker tool-flow restore uses this to avoid
  // materializing a long checkpoint history in the renderer process.
  ipcMain.handle("threads:latest-checkpoint", async (_event, threadId: string) => {
    try {
      const normalizedThreadId = assertValidCheckpointThreadId(threadId)
      return await withCheckpointer(normalizedThreadId, async (checkpointer) => {
        const config = { configurable: { thread_id: normalizedThreadId } }
        for await (const checkpoint of checkpointer.list(config, { limit: 1 })) {
          return checkpoint
        }
        return null
      })
    } catch (e) {
      console.warn("Failed to get latest thread checkpoint:", e)
      return null
    }
  })

  ipcMain.handle("threads:exportSession", async (event, threadId: string) => {
    try {
      const row = getThread(threadId)
      if (!row) return { success: false, error: "Thread not found" }

      const latestCheckpoint = await getLatestCheckpoint(threadId)
      const messages = buildExportMessages(latestCheckpoint?.checkpoint?.channel_values?.messages)

      if (messages.length === 0) {
        return { success: false, error: "暂无可导出的消息" }
      }

      const metadata = parseJsonObject(row.metadata)
      const workspacePath =
        typeof metadata?.workspacePath === "string" && metadata.workspacePath.trim()
          ? metadata.workspacePath
          : null
      const title =
        row.title || (typeof metadata?.title === "string" ? metadata.title : "") || row.thread_id
      const exportedAt = new Date().toISOString()
      const payload: ExportPayload = {
        version: 1,
        exportedAt,
        thread: {
          threadId,
          title,
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
          workspacePath
        },
        messages
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const date = exportedAt.slice(0, 10)
      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
        title: "导出会话",
        defaultPath: `${safeFileName(title)}-session-${date}.zip`,
        filters: [{ name: "Zip Archive", extensions: ["zip"] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      const zip = new AdmZip()
      zip.addFile("session.md", Buffer.from(formatMarkdown(payload), "utf-8"))
      zip.addFile("session.json", Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf-8"))
      zip.writeZip(result.filePath)

      return { success: true, filePath: result.filePath }
    } catch (e) {
      console.error("[Threads] exportSession error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    "threads:goalEvents",
    async (_event, threadId: string, options?: { restore?: boolean; limit?: number }) => {
      const events = options?.restore
        ? getThreadGoalEventsForRestore(threadId, { recentLimit: GOAL_UI_EVENT_LIMIT })
        : getThreadGoalEvents(threadId, { limit: options?.limit ?? GOAL_UI_EVENT_LIMIT })
      return events.map((event) => ({
        ...event,
        created_at: new Date(event.created_at)
      }))
    }
  )

  ipcMain.handle(
    "threads:goalState",
    async (_event, threadId: string, options?: { includeEvents?: boolean }) => {
      const goalStore = new SqlGoalStore()
      const includeEvents = options?.includeEvents !== false
      return {
        goal: serializeGoal(goalStore.get(threadId)),
        events: includeEvents
          ? getThreadGoalEvents(threadId, { limit: GOAL_UI_EVENT_LIMIT }).map((event) => ({
              ...event,
              created_at: new Date(event.created_at)
            }))
          : []
      }
    }
  )

  // Generate a title from a message
  ipcMain.handle("threads:generateTitle", async (_event, message: string) => {
    return generateTitle(message)
  })
}
