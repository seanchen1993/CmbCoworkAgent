import { IpcMain, BrowserWindow, dialog } from "electron"
import { existsSync } from "fs"
import Store from "electron-store"
import AdmZip from "adm-zip"
import { v4 as uuid } from "uuid"
import {
  getAllThreads,
  getThread,
  createThread as dbCreateThread,
  updateThread as dbUpdateThread,
  deleteThread as dbDeleteThread
} from "../db"
import { getCheckpointer, closeCheckpointer } from "../agent/runtime"
import { deleteThreadCheckpoint, getOpenworkDir } from "../storage"
import { deleteTaskMmdThread } from "../agent/task-mmd/storage"
import { generateTitle } from "../services/title-generator"
import { fireSessionEnd } from "../hooks/session-lifecycle"
import { makeHookResultCallback } from "../hooks/result-callback"
import { disposeAgentThreadState } from "./agent"
import type { Thread, ThreadUpdateParams } from "../types"

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
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
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
  const checkpointer = await getCheckpointer(threadId)
  const config = { configurable: { thread_id: threadId } }

  for await (const checkpoint of checkpointer.list(config, { limit: 1 })) {
    return checkpoint as ThreadCheckpoint
  }

  return null
}

function buildExportMessages(messages: CheckpointMessage[] | undefined): ExportMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.flatMap((msg, index): ExportMessage[] => {
    const role = getMessageRole(msg)
    if (!role) return []

    const rawContent = stringifyContent(msg.content)
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
      thread_values: row.thread_values ? JSON.parse(row.thread_values) : undefined,
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

  // Delete a thread
  ipcMain.handle("threads:delete", async (event, threadId: string) => {
    console.log("[Threads] Deleting thread:", threadId)

    // Fire SessionEnd before teardown so hooks can observe a valid thread record.
    // No-op if SessionStart never fired for this thread.
    const existingThread = getThread(threadId)
    let workspacePath: string | undefined
    if (existingThread?.metadata) {
      try {
        const metadata = JSON.parse(existingThread.metadata) as Record<string, unknown>
        workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
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

    // Delete from our metadata store
    dbDeleteThread(threadId)
    console.log("[Threads] Deleted from metadata store")

    // Close any open checkpointer for this thread
    try {
      await closeCheckpointer(threadId)
      console.log("[Threads] Closed checkpointer")
    } catch (e) {
      console.warn("[Threads] Failed to close checkpointer:", e)
    }

    // Delete the thread's checkpoint file
    try {
      deleteThreadCheckpoint(threadId)
      console.log("[Threads] Deleted checkpoint file")
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
      const checkpointer = await getCheckpointer(threadId)

      const history: unknown[] = []
      const config = { configurable: { thread_id: threadId } }

      for await (const checkpoint of checkpointer.list(config, { limit: 50 })) {
        history.push(checkpoint)
      }

      return history
    } catch (e) {
      console.warn("Failed to get thread history:", e)
      return []
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

  // Generate a title from a message
  ipcMain.handle("threads:generateTitle", async (_event, message: string) => {
    return generateTitle(message)
  })
}
