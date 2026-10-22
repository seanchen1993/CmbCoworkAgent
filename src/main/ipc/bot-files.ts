import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { isSupportedFile } from "../file-parser"
import { getFileAttachmentParserClient } from "../file-attachment-parser/client"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_PICKER_FILES,
  MAX_ATTACHMENT_FILE_NAME_LENGTH,
  type FileAttachment
} from "../../shared/file-attachment"
import { basename, dirname } from "node:path"
import type { LocalBotHost } from "../bots/host"
import { BotError } from "../../shared/bots/contracts"
import { botIdentifier } from "../../shared/bots/validation"
import { getThreadCore } from "../db"
import { verifyWorkConversationThread } from "../bots/conversation-link-authority"
import { prepareBotThread } from "../bots/runtime-adapter"
import { resolveBotWorkspaceFile } from "../bots/workspace-file"
import { botImportDestination, copyBotFile, copyBotFileBytes } from "../bots/file-copy"
import {
  cancelWorkspaceFileScan,
  cancelWorkspaceFileScansForOwner,
  openWorkspaceFileScan,
  readWorkspaceFileScanPage
} from "../workspace-file-scan/manager"

function fileId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0"))
    throw new BotError("INVALID_INPUT", "文件标识无效")
  return value
}
function cursor(value: unknown): { scanId: string; continuation?: string } {
  if (typeof value !== "string" || value.length > 6000 || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new BotError("INVALID_INPUT", "资料分页标识无效")
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >
  const scanId = botIdentifier(parsed.scanId)
  if (
    parsed.continuation !== undefined &&
    (typeof parsed.continuation !== "string" || parsed.continuation.length > 4096)
  )
    throw new BotError("INVALID_INPUT", "资料分页标识无效")
  return { scanId, continuation: parsed.continuation as string | undefined }
}

/** Both picker and drag imports share the original parser and the same text budget. */
async function retainedAttachment(input: {
  target: { id: string; path: string }
  filename: string
  size: number
  maxChars: number
  owner: number
  readBytes: () => Promise<ArrayBuffer>
}): Promise<FileAttachment> {
  const reference = `Original file retained in your workspace: ${JSON.stringify(input.target.id)}.`
  let attachment: FileAttachment = {
    filename: input.filename,
    filePath: input.target.id,
    content: reference,
    mimeType: "application/octet-stream",
    size: input.size,
    truncated: false
  }
  if (isSupportedFile(input.filename) && input.maxChars > reference.length + 2) {
    const parsed = await getFileAttachmentParserClient().parse(
      { kind: "bytes", fileName: input.filename, bytes: await input.readBytes() },
      input.maxChars - reference.length - 2,
      `bot-attachment:${input.owner}`
    )
    attachment = {
      ...parsed,
      filename: input.filename,
      filePath: input.target.id,
      size: input.size,
      content: `${reference}\n\n${parsed.content}`
    }
  }
  if (attachment.content.length > input.maxChars) {
    attachment.content = attachment.content.slice(0, input.maxChars)
    attachment.truncated = true
  }
  return attachment
}

export function registerBotFileHandlers(
  ipcMain: IpcMain,
  hostFor: (id: unknown) => LocalBotHost
): void {
  const context = (hostId: unknown, botId: unknown, groupId: unknown, workId?: unknown) => {
    const host = hostFor(hostId),
      id = botIdentifier(botId)
    const group = groupId === undefined ? undefined : botIdentifier(groupId)
    const workKey = workId === undefined ? undefined : botIdentifier(workId)
    if (group && workKey) throw new BotError("INVALID_INPUT", "工作与群会话不能混用")
    const work = workKey ? host.getWork(id, workKey) : undefined
    const validate = () => {
      if (workKey) {
        const current = host.getWork(id, workKey)
        if (current.source)
          throw new BotError("CONFLICT", "模拟渠道仅支持文字，尚不开放本机文件和附件")
        if (current.conversation) {
          const row = getThreadCore(current.threadId)
          if (!row || current.conversation.state !== "bound")
            throw new BotError("CONFLICT", "任务会话关联已变化，请重新打开资料库。")
          verifyWorkConversationThread(current, row, JSON.parse(row.metadata || "{}"))
        }
      }
      return group ? host.getGroupMember(group, id) : host.getBot(id)
    }
    const bot = validate()
    const workspace = prepareBotThread(
      bot,
      group
        ? {
            threadId: `group-${group}-${bot.id}`,
            origin: { kind: "group", groupId: group, messageId: "files" }
          }
        : work
          ? { threadId: work.threadId, origin: { kind: "user" } }
          : undefined,
      work
    )
    if (work) host.initializeWorkThread(id, work.id)
    return { host, bot, workspace, group, validate }
  }
  const cleanupOwners = new Set<number>()
  const attachCleanup = (event: IpcMainInvokeEvent) => {
    const owner = event.sender.id
    if (cleanupOwners.has(owner)) return
    cleanupOwners.add(owner)
    event.sender.once("destroyed", () => {
      cleanupOwners.delete(owner)
      void cancelWorkspaceFileScansForOwner(owner)
      getFileAttachmentParserClient().cancelLatest(`bot-attachment:${owner}`)
    })
  }
  ipcMain.handle(
    "bots:files:list",
    async (
      event,
      hostId: unknown,
      botId: unknown,
      next: unknown,
      groupId: unknown,
      workId: unknown
    ) => {
      const { workspace } = context(hostId, botId, groupId, workId)
      const owner = event.sender.id
      attachCleanup(event)
      const scan = next == null ? await openWorkspaceFileScan(owner, workspace) : cursor(next)
      const page = await readWorkspaceFileScanPage(
        owner,
        scan.scanId,
        "continuation" in scan ? scan.continuation : undefined
      )
      if (page.workspacePath !== workspace) {
        await cancelWorkspaceFileScan(owner, scan.scanId)
        throw new BotError("CONFLICT", "资料分页不属于此 Bot")
      }
      return {
        files: page.files,
        cursor: page.done
          ? null
          : Buffer.from(
              JSON.stringify({ scanId: scan.scanId, continuation: page.continuation })
            ).toString("base64url")
      }
    }
  )
  ipcMain.handle("bots:files:cancel", async (event, hostId: unknown, value: unknown) => {
    hostFor(hostId)
    await cancelWorkspaceFileScan(event.sender.id, cursor(value).scanId)
  })
  const importFiles = async (
    event: IpcMainInvokeEvent,
    hostId: unknown,
    botId: unknown,
    groupId: unknown,
    maxFiles: unknown,
    asAttachments: boolean,
    maxChars: unknown = 24_000,
    workId?: unknown
  ): Promise<string[] | FileAttachment[]> => {
    const limit = maxFiles === undefined ? 20 : maxFiles
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new BotError("INVALID_INPUT", "文件数量限制必须为 1 到 20")
    if (
      typeof maxChars !== "number" ||
      !Number.isSafeInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > 24_000
    )
      throw new BotError("INVALID_INPUT", "附件字符预算无效")
    const { bot, workspace, validate } = context(hostId, botId, groupId, workId)
    if (bot.archived) throw new BotError("CONFLICT", "请先恢复 Bot")
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("操作窗口已关闭")
    const selected = await dialog.showOpenDialog(window, {
      title: `添加工作资料（最多 ${limit} 个文件）`,
      properties: ["openFile", "multiSelections"]
    })
    if (selected.canceled) return []
    if (selected.filePaths.length > limit)
      throw new BotError("INVALID_INPUT", `一次最多添加 ${limit} 个文件`)
    const current = validate()
    if (current.archived) throw new BotError("CONFLICT", "Bot 已归档")
    const imported: string[] = []
    const attachments: FileAttachment[] = []
    let remainingChars = maxChars
    attachCleanup(event)
    for (const source of selected.filePaths) {
      if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
      const target = await botImportDestination(workspace, source)
      if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
      await copyBotFile(dirname(source), source, target.path)
      imported.push(target.id)
      if (asAttachments) {
        const opened = await openStableFileHandle(workspace, target.path)
        try {
          const attachment = await retainedAttachment({
            target,
            filename: basename(source),
            size: opened.size,
            maxChars: remainingChars,
            owner: event.sender.id,
            readBytes: async () =>
              Uint8Array.from(await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES))
                .buffer
          })
          if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
          remainingChars -= attachment.content.length
          attachments.push(attachment)
        } finally {
          await opened.handle.close().catch(() => undefined)
        }
      }
    }
    return asAttachments ? attachments : imported
  }
  ipcMain.handle("bots:files:import", (event, hostId, botId, groupId, maxFiles, workId) =>
    importFiles(event, hostId, botId, groupId, maxFiles, false, 24_000, workId)
  )
  ipcMain.handle("bots:files:attach", (event, hostId, botId, maxFiles, maxChars, groupId, workId) =>
    importFiles(event, hostId, botId, groupId, maxFiles, true, maxChars, workId)
  )
  ipcMain.handle(
    "bots:files:attach-bytes",
    async (
      event,
      hostId: unknown,
      botId: unknown,
      values: unknown,
      maxChars: unknown,
      groupId: unknown,
      workId: unknown
    ) => {
      if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > MAX_ATTACHMENT_PICKER_FILES
      )
        throw new BotError("INVALID_INPUT", `一次最多添加 ${MAX_ATTACHMENT_PICKER_FILES} 个文件`)
      if (
        typeof maxChars !== "number" ||
        !Number.isSafeInteger(maxChars) ||
        maxChars < 1 ||
        maxChars > 24_000
      )
        throw new BotError("INVALID_INPUT", "附件字符预算无效")
      const files = values.map((value) => {
        if (!value || typeof value !== "object") throw new BotError("INVALID_INPUT", "拖入文件无效")
        const { fileName, bytes } = value as { fileName?: unknown; bytes?: unknown }
        if (
          typeof fileName !== "string" ||
          !fileName ||
          fileName.length > MAX_ATTACHMENT_FILE_NAME_LENGTH ||
          /[\0/\\]/.test(fileName) ||
          !(bytes instanceof ArrayBuffer) ||
          bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES
        )
          throw new BotError("INVALID_INPUT", "拖入文件无效或超过 5 MiB")
        return { fileName, bytes }
      })
      const { bot, workspace, validate } = context(hostId, botId, groupId, workId)
      if (bot.archived) throw new BotError("CONFLICT", "请先恢复 Bot")
      attachCleanup(event)
      const attachments: FileAttachment[] = []
      let remainingChars = maxChars
      for (const { fileName, bytes } of files) {
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
        const target = await botImportDestination(workspace, fileName)
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
        await copyBotFileBytes(target.path, bytes)
        const attachment = await retainedAttachment({
          target,
          filename: basename(target.path),
          size: bytes.byteLength,
          maxChars: remainingChars,
          owner: event.sender.id,
          readBytes: async () => bytes.slice(0)
        })
        remainingChars -= attachment.content.length
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
        attachments.push(attachment)
      }
      return attachments
    }
  )
  ipcMain.handle(
    "bots:files:export",
    async (
      event,
      hostId: unknown,
      botId: unknown,
      id: unknown,
      groupId: unknown,
      workId: unknown
    ) => {
      const { workspace, validate } = context(hostId, botId, groupId, workId)
      // Transcript previews carry absolute Runtime paths; the same workspace and
      // realpath checks still apply before showing a native destination dialog.
      const source = await resolveBotWorkspaceFile(workspace, fileId(id), { allowAbsolute: true })
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error("操作窗口已关闭")
      const destination = await dialog.showSaveDialog(window, {
        title: "保存工作成果",
        defaultPath: basename(source)
      })
      if (destination.canceled || !destination.filePath) return false
      validate()
      await copyBotFile(workspace, source, destination.filePath)
      return true
    }
  )
  ipcMain.handle(
    "bots:files:share",
    async (
      _event,
      hostId: unknown,
      botId: unknown,
      id: unknown,
      targetId: unknown,
      groupId: unknown,
      workId: unknown
    ) => {
      const {
        host,
        bot: sourceBot,
        workspace,
        group,
        validate
      } = context(hostId, botId, groupId, workId)
      const targetBot = host.getBot(botIdentifier(targetId))
      if (targetBot.archived || (!group && sourceBot.id === targetBot.id))
        throw new BotError("CONFLICT", "请选择另一个未归档的 Bot")
      const source = await resolveBotWorkspaceFile(workspace, fileId(id))
      const target = await botImportDestination(prepareBotThread(targetBot), source)
      validate()
      if (host.getBot(targetBot.id).archived) throw new BotError("CONFLICT", "目标 Bot 已归档")
      await copyBotFile(workspace, source, target.path)
      return target.id
    }
  )
}
