import { IpcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron"
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
  clearToolConcurrencyLocksForThread,
  retireThreadCheckpointers,
  pendingApprovals
} from "../agent/runtime"
import { forgetCoordinatorThreadState, hasActiveAgentRun } from "./agent"
import {
  deleteThreadCheckpoint,
  deleteThreadWorkerCheckpoints,
  deleteThreadWorkflowCheckpoints,
  getThreadCheckpointPath,
  getOpenworkDir,
  purgeThreadCheckpointArtifacts
} from "../storage"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { workflowRunManager } from "../agent/workflow/run-manager"
import {
  commitWorkflowThreadDisposal,
  deleteWorkflowRunsForThread,
  isWorkflowThreadMarkedDisposed,
  markWorkflowThreadDisposed,
  rollbackWorkflowThreadDisposal
} from "../agent/workflow/run-store"
import {
  coordinatorWorkerManager,
  deleteCoordinatorWorkerArtifacts
} from "../agent/coordinator-worker-manager"
import { getAgentModeFromMetadata } from "../agent/coordinator-mode"
import { deleteTaskMmdThread } from "../agent/task-mmd/storage"
import { generateTitle } from "../services/title-generator"
import { fireSessionEnd } from "../hooks/session-lifecycle"
import { makeHookResultCallback } from "../hooks/result-callback"
import { disposeAgentThreadState } from "./agent"
import { getDefaultModel } from "./models"
import type {
  ForkableCheckpoint,
  Thread,
  ThreadForkCheckpointForMessageParams,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadUpdateParams,
  ThreadValuesMergeParams
} from "../types"
import { SqlGoalStore } from "../agent/goals/goal-store"
import type { ThreadGoal } from "../agent/goals/types"
import { GOAL_UI_EVENT_LIMIT } from "../../shared/goal-events"
import {
  buildFilteredThreadValues,
  describeCheckpointMessageForkTarget,
  deriveCheckpointTranscriptIndex,
  isWorkflowPlumbingTranscriptContent,
  truncateCheckpointMessagesAfter
} from "../../shared/checkpoint-transcript"
import {
  buildForkableCheckpointSummary,
  buildVisibleForkableCheckpointList,
  describeCheckpointForkability,
  getCheckpointId,
  getCheckpointThreadId,
  isForkableCheckpointForMessage,
  toForkabilityError
} from "../../shared/checkpoint-forkability"
import { withThreadRunMutationLock } from "./thread-run-mutation-lock"
import {
  copyCheckpoint,
  type CheckpointMetadata,
  type CheckpointTuple
} from "@langchain/langgraph-checkpoint"

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
    // Look the pending run up in the CURRENT (old) workspace — that's where its files live (it was
    // launched there). A combined update that ALSO switches workspacePath must NOT use the NEW path:
    // the run isn't there → findPendingNotification returns null → the leave would be allowed and
    // orphan the run. Mirrors the workspace-switch guard above, which also checks currentMetadata.
    const wsp =
      typeof currentMetadata.workspacePath === "string"
        ? currentMetadata.workspacePath
        : typeof nextMetadata.workspacePath === "string"
          ? nextMetadata.workspacePath
          : undefined
    const active = workflowRunManager.isActive(threadId)
    const pendingRun = wsp ? workflowRunManager.findPendingNotification(wsp, threadId) : null
    // Scan ALL pending runs, not just the first candidate: an exhausted newest
    // run must not unlock the exit while an older, still-deliverable run waits.
    const deliverablePending = wsp
      ? workflowRunManager.hasDeliverablePendingNotification(wsp, threadId)
      : false
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
    const pending = deliverablePending
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

function parseThreadValues(raw: string | null | undefined): Record<string, unknown> {
  return parseJsonObject(raw) ?? {}
}

function serializeThreadRow(row: NonNullable<ReturnType<typeof getThread>>): Thread {
  return {
    thread_id: row.thread_id,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    status: row.status as Thread["status"],
    thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
    title: row.title ?? undefined
  }
}

function isAgentMode(value: unknown): value is "normal" | "coordinator" | "workflow" {
  return value === "normal" || value === "coordinator" || value === "workflow"
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasPendingApprovalForThread(threadId: string): boolean {
  for (const approval of pendingApprovals.values()) {
    if (approval.threadId === threadId || approval.runtimeThreadId === threadId) return true
  }
  return false
}

interface ThreadForkBusyInput {
  threadId: string
  workspacePath?: string | null
  agentMode?: "normal" | "coordinator" | "workflow"
}

async function isThreadForkBusy(input: ThreadForkBusyInput): Promise<boolean> {
  const { threadId, workspacePath, agentMode } = input
  if (hasActiveAgentRun(threadId)) return true
  if (hasPendingApprovalForThread(threadId)) return true

  if (workflowRunManager.isActive(threadId)) return true
  if (workspacePath) {
    if (workflowRunManager.isBusyForThread(threadId, workspacePath)) return true
  } else if (agentMode === "workflow") {
    return true
  }

  if (workspacePath) {
    try {
      await coordinatorWorkerManager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath,
        mode: "active"
      })
    } catch (error) {
      if (agentMode === "coordinator") {
        console.warn("[Threads] Failed to hydrate coordinator workers before fork:", error)
        return true
      }
    }
  } else if (agentMode === "coordinator") {
    return true
  }

  const workers = coordinatorWorkerManager.readWorkers(threadId)
  if (coordinatorWorkerManager.hasNotifications(threadId)) return true
  return workers.some(
    (worker) => worker.status === "running" || worker.notification_acknowledged === false
  )
}

function assertForkableTuple(
  tuple: CheckpointTuple,
  options: { allowLegacyLatestFallback: boolean }
): void {
  const threadId = getCheckpointThreadId(tuple)
  const forkability = describeCheckpointForkability(tuple, {
    allowLegacyLatestFallback: options.allowLegacyLatestFallback,
    pendingApproval: hasPendingApprovalForThread(threadId)
  })
  if (!forkability.isStableTurnBoundary)
    throw new Error(toForkabilityError(forkability.unstableReason))
}

function buildForkMetadata(input: {
  sourceThreadId: string
  sourceTitle: string
  sourceMetadata: Record<string, unknown>
  checkpointId: string
  messageId?: string
  title?: string
  overrides?: ThreadForkParams["overrides"]
}): Record<string, unknown> {
  const { sourceThreadId, sourceTitle, sourceMetadata, checkpointId, messageId, title, overrides } =
    input
  const next: Record<string, unknown> = {}

  const hasWorkspacePathOverride = overrides ? hasOwnProperty(overrides, "workspacePath") : false
  const workspacePath = hasWorkspacePathOverride
    ? overrides?.workspacePath
    : sourceMetadata.workspacePath
  if (typeof workspacePath === "string" || workspacePath === null)
    next.workspacePath = workspacePath

  const model = overrides?.model ?? sourceMetadata.model
  if (typeof model === "string" && model.trim()) next.model = model

  const agentMode = isAgentMode(overrides?.agentMode)
    ? overrides.agentMode
    : getAgentModeFromMetadata(sourceMetadata)
  if (isAgentMode(agentMode)) next.agentMode = agentMode

  const memoryEnabled = overrides?.memoryEnabled ?? sourceMetadata.memoryEnabled
  if (typeof memoryEnabled === "boolean") next.memoryEnabled = memoryEnabled

  const nextTitle = overrides?.title?.trim() || title?.trim() || sourceTitle || sourceThreadId
  next.title = nextTitle
  next.forkedFromThreadId = sourceThreadId
  next.forkedFromCheckpointId = checkpointId
  next.forkedFromCheckpointNs = ""
  if (messageId) next.forkedFromMessageId = messageId
  next.forkedAt = new Date().toISOString()

  return next
}

async function cleanupFailedFork(
  targetThreadId: string,
  options: { rowCreated: boolean }
): Promise<void> {
  try {
    deleteThreadCheckpoint(targetThreadId)
  } catch (error) {
    console.warn("[Threads] Failed to cleanup fork checkpoint:", error)
  }
  if (options.rowCreated) {
    try {
      dbDeleteThread(targetThreadId)
    } catch (error) {
      console.warn("[Threads] Failed to cleanup fork thread row:", error)
    }
  }
}

async function forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
  const sourceThreadId = assertValidCheckpointThreadId(params.sourceThreadId)
  const explicitCheckpointId = params.checkpointId?.trim()
  if (explicitCheckpointId) assertValidCheckpointThreadId(explicitCheckpointId)
  const explicitMessageId = params.messageId?.trim()

  return withThreadRunMutationLock(sourceThreadId, async () => {
    const sourceRow = getThread(sourceThreadId)
    if (!sourceRow) throw new Error("源会话不存在。")

    const sourceMetadata = parseJsonObject(sourceRow.metadata) ?? {}
    const workspacePath =
      typeof sourceMetadata.workspacePath === "string" ? sourceMetadata.workspacePath : null
    const agentMode = getAgentModeFromMetadata(sourceMetadata)
    if (await isThreadForkBusy({ threadId: sourceThreadId, workspacePath, agentMode })) {
      throw new Error("当前会话仍在运行，请停止或等待完成后再 fork。")
    }

    const tuple = await withCheckpointer(sourceThreadId, async (sourceSaver) =>
      sourceSaver.getTuple({
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          ...(explicitCheckpointId ? { checkpoint_id: explicitCheckpointId } : {})
        }
      })
    )
    if (!tuple) throw new Error("当前会话还没有可 fork 的 checkpoint。")
    assertForkableTuple(tuple, { allowLegacyLatestFallback: !explicitCheckpointId })

    const checkpointId = getCheckpointId(tuple)
    if (explicitMessageId) {
      const messageTarget = describeCheckpointMessageForkTarget(tuple.checkpoint, explicitMessageId)
      if (
        !messageTarget.isForkableMessageBoundary ||
        !isForkableCheckpointForMessage(tuple, explicitMessageId)
      ) {
        throw new Error("该消息不是稳定完成边界上的 assistant 回复，无法从这里 fork。")
      }
    }
    const forkCheckpoint = explicitMessageId ? copyCheckpoint(tuple.checkpoint) : tuple.checkpoint
    if (explicitMessageId && !truncateCheckpointMessagesAfter(forkCheckpoint, explicitMessageId)) {
      throw new Error("该消息不在目标 checkpoint 中，无法从这里 fork。")
    }
    const sourceTitle =
      sourceRow.title || (typeof sourceMetadata.title === "string" ? sourceMetadata.title : "")
    const targetThreadId = uuid()
    const targetMetadata = buildForkMetadata({
      sourceThreadId,
      sourceTitle,
      sourceMetadata,
      checkpointId,
      messageId: explicitMessageId,
      title: params.title,
      overrides: params.overrides
    })
    const transcriptIndex = deriveCheckpointTranscriptIndex(forkCheckpoint)
    const filteredThreadValues = buildFilteredThreadValues(
      parseThreadValues(sourceRow.thread_values),
      transcriptIndex
    )

    let targetSaver: SqlJsSaver | null = null
    let rowCreated = false
    try {
      const checkpointMetadata =
        tuple.metadata ??
        ({
          source: "fork",
          step: -1,
          writes: {},
          parents: {}
        } as CheckpointMetadata)
      targetSaver = new SqlJsSaver(getThreadCheckpointPath(targetThreadId))
      await targetSaver.put(
        { configurable: { thread_id: targetThreadId, checkpoint_ns: "" } },
        forkCheckpoint,
        checkpointMetadata
      )
      await targetSaver.close()
      targetSaver = null

      dbCreateThread(targetThreadId, targetMetadata)
      rowCreated = true

      const row = dbUpdateThread(targetThreadId, {
        thread_values: JSON.stringify(filteredThreadValues)
      })
      if (!row) throw new Error("Forked thread row was not created.")
      return {
        thread: serializeThreadRow(row),
        sourceThreadId,
        sourceCheckpointId: checkpointId,
        sourceCheckpointNs: ""
      }
    } catch (error) {
      if (targetSaver) {
        try {
          await targetSaver.close()
        } catch (closeError) {
          console.warn("[Threads] Failed to close fork target saver:", closeError)
        }
      }
      await cleanupFailedFork(targetThreadId, { rowCreated })
      throw error
    }
  })
}

async function listForkableCheckpoints(threadId: string): Promise<ForkableCheckpoint[]> {
  const sourceThreadId = assertValidCheckpointThreadId(threadId)
  return withThreadRunMutationLock(sourceThreadId, async () => {
    const sourceRow = getThread(sourceThreadId)
    if (!sourceRow) throw new Error("源会话不存在。")

    const activeRun = hasActiveAgentRun(sourceThreadId)
    const pendingApproval = hasPendingApprovalForThread(sourceThreadId)
    return withCheckpointer(sourceThreadId, async (sourceSaver) => {
      const tuples: CheckpointTuple[] = []
      for await (const tuple of sourceSaver.list({
        configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
      })) {
        tuples.push(tuple)
      }
      return buildVisibleForkableCheckpointList(tuples, { activeRun, pendingApproval })
    })
  })
}

async function resolveForkCheckpointForMessage(
  params: ThreadForkCheckpointForMessageParams
): Promise<ForkableCheckpoint | null> {
  const sourceThreadId = assertValidCheckpointThreadId(params.threadId)
  const messageId = params.messageId.trim()
  if (!messageId) return null

  return withThreadRunMutationLock(sourceThreadId, async () => {
    const sourceRow = getThread(sourceThreadId)
    if (!sourceRow) throw new Error("源会话不存在。")

    const activeRun = hasActiveAgentRun(sourceThreadId)
    const pendingApproval = hasPendingApprovalForThread(sourceThreadId)
    return withCheckpointer(sourceThreadId, async (sourceSaver) => {
      for await (const tuple of sourceSaver.list({
        configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
      })) {
        const transcript = deriveCheckpointTranscriptIndex(tuple.checkpoint)
        if (!isForkableCheckpointForMessage(tuple, messageId)) continue

        const summary = buildForkableCheckpointSummary(tuple, {
          activeRun,
          pendingApproval,
          transcript
        })
        if (summary.isStableTurnBoundary) {
          return summary
        }
      }
      return null
    })
  })
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
    if (isWorkflowPlumbingTranscriptContent(rawContent)) return []
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

  ipcMain.handle("threads:fork", async (_event, params: ThreadForkParams) => {
    return forkThread(params)
  })

  ipcMain.handle("threads:list-forkable-checkpoints", async (_event, threadId: string) => {
    return listForkableCheckpoints(threadId)
  })

  ipcMain.handle(
    "threads:resolve-fork-checkpoint-for-message",
    async (_event, params: ThreadForkCheckpointForMessageParams) => {
      return resolveForkCheckpointForMessage(params)
    }
  )

  // Update a thread
  ipcMain.handle("threads:update", async (_event, { threadId, updates }: ThreadUpdateParams) => {
    return withThreadRunMutationLock(threadId, async () => {
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

      return serializeThreadRow(row)
    })
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
  // Serialize same-thread deletions: two overlapping attempts would interleave
  // their tombstone mark/rollback — attempt A failing before dbDeleteThread
  // rolls back the mark attempt B still depends on; if B then succeeds without
  // a workspacePath, the no-sweep late-writer window the tombstone closes
  // would silently reopen. ThreadIds are uuids, so the map stays tiny.
  const deletingThreads = new Map<string, Promise<void>>()

  const performThreadDeletion = async (
    event: IpcMainInvokeEvent,
    threadId: string
  ): Promise<void> => {
    console.log("[Threads] Deleting thread:", threadId)

    // ThreadId-keyed run-store tombstone FIRST, before any await: launches and
    // flush-failed write-backs landing during the (multi-await) teardown below
    // would otherwise recreate `.cmbdevclaw/workflows/<threadId>` — and when the
    // thread's metadata lost its workspacePath, there is no directory sweep to
    // clean that up afterwards. This only gates NEW work; live stores keep
    // flushing until commitWorkflowThreadDisposal after the DB delete (the
    // point of no return), so a failed attempt never eats a terminal flush.
    // Prior membership is captured so the failure rollback RESTORES it — an
    // earlier COMPLETED deletion's tombstone must survive our failed attempt.
    const priorDisposalMark = isWorkflowThreadMarkedDisposed(threadId)
    markWorkflowThreadDisposed(threadId)

    // Everything from here up to (and including) the DB delete can still fail
    // with the thread intact — the catch below rolls the workflow tombstone
    // back so the SURVIVING thread isn't left with poisoned stores/launches
    // until restart. The guard starts IMMEDIATELY after the mark: even the
    // metadata reads above the hook dispatch are DB reads that can throw.
    // After dbDeleteThread succeeds the thread is gone for good and the
    // tombstone must stay, whatever the later best-effort cleanups do.
    let workspacePath: string | undefined
    try {
      // Fallback workspace capture BEFORE cancelAndWait (which settles and
      // removes the active entry): if the thread's metadata lost its
      // workspacePath, the active run still knows where its artifacts live —
      // without this, the row gets deleted but `.cmbdevclaw/workflows/<id>`
      // survives in a workspace the sweep can no longer locate.
      const activeWorkspaceFallback = workflowRunManager.activeWorkspaceForThread(threadId)
      // A background dynamic workflow must not outlive its thread. Cancel and
      // wait (bounded) for it to settle — best-effort, so a slow subagent
      // can't hang this IPC. The orphan-directory race is closed regardless of
      // the timeout: the tombstone above and deleteWorkflowRunsForThread
      // (below) make any late flush from a still-settling run a no-op.
      try {
        await workflowRunManager.cancelAndWait(threadId)
      } catch (error) {
        console.warn("[Threads] Workflow cancel on delete failed:", error)
      }
      // Drop the thread's tool-concurrency locks so the module-level map
      // doesn't keep one idle lock per deleted thread for the process lifetime.
      clearToolConcurrencyLocksForThread(threadId)
      // Fire SessionEnd before teardown so hooks can observe a valid thread
      // record. No-op if SessionStart never fired for this thread.
      const existingThread = getThread(threadId)
      if (existingThread?.metadata) {
        try {
          const metadata = JSON.parse(existingThread.metadata) as Record<string, unknown>
          workspacePath =
            typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
        } catch {
          workspacePath = undefined
        }
      }
      workspacePath = workspacePath ?? activeWorkspaceFallback
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

      // Delete from our metadata store — the point of no return.
      dbDeleteThread(threadId)
      // Incarnation boundary crossed: permanently silence every store/snapshot
      // born before this deletion (revive-immune epoch bump).
      commitWorkflowThreadDisposal(threadId)
      console.log("[Threads] Deleted from metadata store")
    } catch (e) {
      // Rollback restores ONLY the workflow tombstone. The other pre-DB-delete
      // effects (workflow cancelAndWait, session-end hooks, turn-state dispose,
      // worker cancellation) are deliberately NOT rolled back — an abort cannot
      // be un-aborted, and the user's intent WAS deletion: a failed attempt
      // leaves a surviving thread whose background work has been stopped, which
      // is visible, recoverable state (re-run / re-delete both work). Only the
      // tombstone must roll back, because it alone would silently poison future
      // workflow use of the surviving thread until restart.
      rollbackWorkflowThreadDisposal(threadId, priorDisposalMark)
      throw e
    }
    // Drop the in-memory flush-failed snapshots only AFTER the point of no
    // return: dropped earlier, a deletion failing pre-DB-delete would have
    // already lost the surviving thread's only copy of a terminal state whose
    // disk persist had failed. (Their retries are already no-ops during the
    // attempt: persistRecoveredRun keeps the snapshot on a bare-set hit.)
    workflowRunManager.forgetThread(threadId)

    // Permanently retire every checkpointer of this thread (parent + all
    // __worker__/__wf_ sub-threads): tombstone + poison, BEFORE the disk sweeps
    // below — a writer that outlived its cancellation (hung subagent past
    // cancelAndWait's timeout, or an LRU-evicted instance still held by a run)
    // could otherwise flush a late snapshot and resurrect the just-deleted files.
    try {
      await retireThreadCheckpointers(threadId)
      console.log("[Threads] Retired thread checkpointers")
    } catch (e) {
      console.warn("[Threads] Failed to retire thread checkpointers:", e)
    }

    // Checkpoint disk sweeps IMMEDIATELY after retire, with NO await in
    // between: a revived fixed-id beat (heartbeat) resumes on the same
    // retiring-promise settlement this handler does — any await here would let
    // it initialize and flush a FRESH checkpoint that these sweeps (belonging
    // to the OLD deletion) would then eat. Single-threaded JS makes
    // retire-settle → sync sweeps an atomic segment; the awaited workspace
    // cleanups run after.
    //
    // Deep clean: durable sidecars AND quarantine archives — "delete thread"
    // means the transcript is gone. Each cleanup is independently best-effort:
    // one stubborn file (e.g. EPERM on a quarantine archive) must not block
    // the other sweeps from removing sub-thread transcripts.
    try {
      purgeThreadCheckpointArtifacts(threadId)
      console.log("[Threads] Purged thread checkpoint artifacts")
    } catch (e) {
      console.warn("[Threads] Failed to purge thread checkpoint artifacts:", e)
    }
    try {
      const deletedWorkerCheckpoints = deleteThreadWorkerCheckpoints(threadId)
      console.log("[Threads] Deleted worker checkpoints", { deletedWorkerCheckpoints })
    } catch (e) {
      console.warn("[Threads] Failed to delete worker checkpoints:", e)
    }
    // Workflow subagents self-clean their checkpoints in their finally; this
    // sweeps the rare crash / failed-cleanup leftovers, mirroring the worker
    // sweep (which only covers __worker__, not __wf_). (#3)
    try {
      const deletedWorkflowCheckpoints = deleteThreadWorkflowCheckpoints(threadId)
      console.log("[Threads] Deleted workflow checkpoints", { deletedWorkflowCheckpoints })
    } catch (e) {
      console.warn("[Threads] Failed to delete workflow checkpoints:", e)
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

    try {
      deleteTaskMmdThread(threadId)
      console.log("[Threads] Deleted task-mmd files")
    } catch (e) {
      console.warn("[Threads] Failed to delete task-mmd files:", e)
    }
  }

  ipcMain.handle("threads:delete", async (event, threadId: string) => {
    return withThreadRunMutationLock(threadId, async () => {
      while (deletingThreads.has(threadId)) {
        await deletingThreads.get(threadId)?.catch(() => undefined)
      }
      const deletion = performThreadDeletion(event, threadId)
      deletingThreads.set(threadId, deletion)
      try {
        await deletion
      } finally {
        if (deletingThreads.get(threadId) === deletion) deletingThreads.delete(threadId)
      }
    })
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
