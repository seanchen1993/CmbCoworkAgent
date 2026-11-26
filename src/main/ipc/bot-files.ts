import { BotImageImportBatch, readBotAttachmentImages, readBotImageSelection, withBotImagePreview } from "../bots/image-import"
import { decodeChatImage } from "../chat-image-decoder"
import { assertChatAttachmentWindow } from "./chat-attachment-window"
import { botImageMime } from "../../shared/bots/input-files"
import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { isSupportedFile } from "../file-parser"
import { getFileAttachmentParserClient } from "../file-attachment-parser/client"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  isVisualDocumentPath,
  MAX_ATTACHMENT_PICKER_FILES,
  MAX_ATTACHMENT_FILE_NAME_LENGTH,
  type DraftAttachmentImage,
  type FileAttachment
} from "../../shared/file-attachment"
import { basename, dirname, join, relative } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { botDirectory } from "../bots/paths"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import type { LocalBotHost } from "../bots/host"
import { BotError } from "../../shared/bots/contracts"
import { botIdentifier } from "../../shared/bots/validation"
import { getThreadCore } from "../db"
import { verifyWorkConversationThread } from "../bots/conversation-link-authority"
import { prepareBotThread } from "../bots/runtime-adapter"
import { resolveBotWorkspaceFile } from "../bots/workspace-file"
import {
  botImportDestination, copyBotFile, copyBotFileBytes, exportBotFile, hashBotFile,
  MAX_BOT_IMPORT_FILE_BYTES, publishStagedBotDeliveryFile, publishStagedBotImport, snapshotBotDeliveryFile,
  withBotDeliverySnapshotBatch
} from "../bots/file-copy"
import { usesManagedWorkAttachmentStorage, withStagedWorkAttachments, workAttachmentStorage } from "../bots/attachment-storage"
import { parseBotDeliveredFileSource, readDesktopBotDelivery, revalidateDesktopBotDelivery } from "../bots/delivery-receipt"
import { EXTERNAL_FILE_READ_GRANT_TTL_MS, issueExternalFileReadGrant, revokeExternalFileReadGrantsForOwner } from "../services/external-file-read-tokens"
import { requireThreadMutationLease, withThreadMutationLeaseLock, type ThreadMutationLease } from "./thread-run-mutation-lock"
import { getWorkspaceFilePreviewClient } from "../workspace-file-preview/client"
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

function retainedAttachmentReference(path: string, managed = false): string {
  return managed
    ? `Original file retained at ${JSON.stringify(path)}.`
    : `Original file retained in your workspace: ${JSON.stringify(path)}.`
}

type AttachmentBatch = { storage: string; staging: string; managed: boolean }
type StagedAttachment = {
  index: number
  attachment: FileAttachment
  editablePath?: string
  snapshotPath?: string
  snapshotReference?: boolean
}

function finalSnapshotReference(attachment: FileAttachment, filePath: string, managed: boolean) {
  if (filePath === attachment.filePath) return attachment
  const reference = retainedAttachmentReference(attachment.filePath, managed)
  const actual = retainedAttachmentReference(filePath, managed)
  const content = attachment.content.startsWith(reference)
    ? actual + attachment.content.slice(reference.length) : actual.slice(0, attachment.content.length)
  return { ...attachment, filePath, content }
}

// Existing composer formats reject an oversized picker copy before publication.
function hasLegacyParserCopyLimit(filename: string): boolean {
  return /\.(?:txt|md|csv|docx|xlsx?)$/i.test(filename)
}

type AttachmentText = Pick<FileAttachment, "content" | "mimeType" | "truncated" |
  "embeddedImageCount" | "visualNotice">

function visualOnlyBudgetError() {
  return new BotError("INVALID_INPUT", "附件正文字数已达上限，可添加图片或含图文档。")
}

function assertCanAttachWithoutText(maxChars: number, names: readonly string[], desktopImages: boolean) {
  if (maxChars > 0) return
  if (!desktopImages || names.some(name => {
    const filename = name.replace(/[. ]+$/, "")
    return !botImageMime(filename, 1) && !isVisualDocumentPath(filename)
  })) throw visualOnlyBudgetError()
}

/** Picker, drop and workspace selection use the same reference and text budget. */
async function retainedAttachment(input: {
  target: { id: string; path: string }
  filename: string
  size: number
  maxChars: number
  owner: number
  managed?: boolean
  assertVisualInput?: () => void
  visualOnly?: boolean
} & ({ readBytes: () => Promise<ArrayBuffer> } | { readText: (maxChars: number) => Promise<AttachmentText> })): Promise<FileAttachment> {
  const reference = retainedAttachmentReference(input.target.id, input.managed)
  const imageMime = botImageMime(input.filename, input.size)
  let attachment: FileAttachment = {
    filename: input.filename,
    filePath: input.target.id,
    content: reference,
    mimeType: imageMime ?? "application/octet-stream",
    size: input.size,
    truncated: false
  }
  const budget = Math.max(0, input.maxChars - reference.length - 2)
  const canParse = input.size <= MAX_ATTACHMENT_FILE_BYTES && isSupportedFile(input.filename)
  const discoverVisual = Boolean(input.assertVisualInput && canParse && isVisualDocumentPath(input.filename))
  if (!imageMime && (discoverVisual || (budget > 0 && ("readText" in input || canParse)))) {
    let parsed: AttachmentText
    if ("readText" in input) parsed = await input.readText(budget)
    else {
      const client = getFileAttachmentParserClient()
      const source = { kind: "bytes" as const, fileName: input.filename, bytes: await input.readBytes() }
      const lane = "bot-attachment:" + input.owner
      // Exhausting the text excerpt does not remove this file's visual sidecar.
      const { documentImages, ...document } = discoverVisual
        ? await client.parse(source, Math.max(1, budget), lane, true)
        : await client.parse(source, budget, lane)
      if (discoverVisual && (document.embeddedImageCount ?? 0) !== (documentImages?.length ?? 0))
        throw new Error("文档内嵌图片读取不完整，请重新添加。")
      if (documentImages?.length) {
        input.assertVisualInput?.()
        for (const image of documentImages) {
          try {
            await decodeChatImage("embedded" + image.extension, image.bytes)
          } catch (cause) {
            throw new Error(input.filename + " 的内嵌图片无法解码，请检查原文件后重新添加。", { cause })
          }
        }
      }
      parsed = document
    }
    attachment = {
      ...parsed,
      filename: input.filename,
      filePath: input.target.id,
      size: input.size,
      content: budget ? reference + "\n\n" + parsed.content : reference
    }
  }
  if (input.visualOnly && !imageMime && !attachment.embeddedImageCount) throw visualOnlyBudgetError()
  if (attachment.content.length > input.maxChars) {
    attachment.content = attachment.content.slice(0, input.maxChars)
    attachment.truncated = true
  }
  return attachment
}

async function stageSelectedAttachment(input: {
  batch: AttachmentBatch
  index: number
  name: string
  maxChars: number
  visualOnly: boolean
  owner: number
  group: boolean
  retain: boolean
  snapshotReference: boolean
  assertCurrent: () => void
  assertVisualInput?: () => void
  source: { path: string } | { bytes: ArrayBuffer }
}): Promise<StagedAttachment> {
  const { batch, name, source } = input
  const target = await botImportDestination(batch.staging, name)
  input.assertCurrent()
  const filename = "path" in source ? basename(name) : basename(target.path)
  const referencePath = input.snapshotReference
    ? join(batch.storage, ".bot-deliveries", "0".repeat(64), basename(target.path)) : target.id
  if ("path" in source) {
    const parsesContent = input.visualOnly || (hasLegacyParserCopyLimit(name) &&
      input.maxChars > retainedAttachmentReference(referencePath, batch.managed).length + 2)
    if (parsesContent)
      await copyBotFile(dirname(source.path), source.path, target.path, undefined, MAX_ATTACHMENT_FILE_BYTES)
    else await copyBotFile(dirname(source.path), source.path, target.path)
  } else await copyBotFileBytes(target.path, source.bytes)

  const signal = new AbortController().signal
  const retainSnapshot = () => snapshotBotDeliveryFile(batch.staging, target.path, signal)
  let snapshot = input.retain ? await retainSnapshot() : undefined
  const path = input.snapshotReference && snapshot
    ? join(batch.storage, relative(batch.staging, snapshot.attachmentPath)) : target.id
  const opened = await openStableFileHandle(batch.staging, snapshot?.attachmentPath ?? target.path)
  let attachment: FileAttachment
  try {
    attachment = await retainedAttachment({
      target: { id: path, path }, filename, size: opened.size, maxChars: input.maxChars,
      owner: input.owner, managed: batch.managed, visualOnly: input.visualOnly,
      assertVisualInput: input.assertVisualInput,
      readBytes: async () => Uint8Array.from(await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)).buffer
    })
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
  input.assertCurrent()
  if (input.group && attachment.embeddedImageCount) snapshot = await retainSnapshot()
  return {
    index: input.index, attachment, snapshotReference: input.snapshotReference,
    editablePath: batch.managed ? undefined : target.path, snapshotPath: snapshot?.attachmentPath
  }
}

async function readRetainedWorkspaceText(
  threadId: string, root: string, path: string, budget: number, signal: AbortSignal
): Promise<AttachmentText> {
  const client = getWorkspaceFilePreviewClient()
  const key = `bot-workspace-attachment:${randomUUID()}`
  const source = { threadId, filePath: path, workspacePathKind: "absolute" as const }
  const cancel = () => client.cancelLatest(key)
  let content = "", offset = 0
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (let i = 0; i < 64; i++) {
      signal.throwIfAborted()
      const { result } = await client.readText(source, root, offset, key)
      signal.throwIfAborted()
      const remaining = budget - content.length
      content += result.content.slice(0, remaining)
      if (!result.hasMore || content.length >= budget)
        return { content, mimeType: "text/plain", truncated: result.hasMore || result.content.length > remaining }
      if (result.nextOffset === null || result.nextOffset <= offset) throw new Error("无法读取原文件的保存版本。")
      offset = result.nextOffset
    }
    return { content, mimeType: "text/plain", truncated: true }
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

export function registerBotFileHandlers(
  ipcMain: IpcMain,
  hostFor: (id: unknown) => LocalBotHost,
  getMainWindow?: () => BrowserWindow | null
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
        host.assertWorkNotDeleting?.(current)
        if (current.source && current.source.transport !== "im")
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
    return { host, bot, workspace, group, work, validate }
  }
  const cleanupOwners = new Set<number>()
  const withAttachmentStorage = <T>(
    work: Parameters<typeof workAttachmentStorage>[1],
    workspace: string,
    validate: () => unknown,
    operation: (batch: AttachmentBatch) => Promise<T>,
    lease?: ThreadMutationLease
  ): Promise<T> => {
    const managed = usesManagedWorkAttachmentStorage(work)
    const run = () => {
      validate()
      const storage = managed ? workAttachmentStorage(workspace, work)! : workspace
      return withStagedWorkAttachments(storage, staging => operation({ storage, staging, managed }))
    }
    const lock = lease ?? (managed ? requireThreadMutationLease(work.threadId) : undefined)
    return lock ? withThreadMutationLeaseLock(lock, run) : run()
  }

  const publishSelection = async (
    batch: AttachmentBatch, staged: readonly StagedAttachment[], images: BotImageImportBatch,
    validate: () => { archived: boolean },
    retain: (inputs: Parameters<LocalBotHost["retainImageSelection"]>[3]) => FileAttachment[]
  ) => {
    const undoEditableCopies: Array<() => Promise<void>> = []
    const attachments: FileAttachment[] = []
    const signal = new AbortController().signal
    try {
      if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
      for (const item of staged) {
        if (item.editablePath)
          undoEditableCopies.push(await publishStagedBotImport(batch.storage, batch.staging, item.editablePath))
      }
      return await withBotDeliverySnapshotBatch(batch.storage, async publication => {
        for (const { index, attachment, snapshotPath, snapshotReference } of staged) {
          if (!snapshotPath) {
            attachments.push(attachment)
            continue
          }
          const path = await publishStagedBotDeliveryFile(publication, batch.staging, snapshotPath, signal)
          const published = snapshotReference ? finalSnapshotReference(attachment, path, batch.managed) : attachment
          images.addRetained(index, published, path)
        }
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
        return images.commit(attachments, retain)
      })
    } catch (error) {
      await Promise.allSettled(undoEditableCopies.map(undo => undo()))
      throw error
    }
  }
  const attachCleanup = (event: IpcMainInvokeEvent) => {
    const owner = event.sender.id
    if (cleanupOwners.has(owner)) return
    cleanupOwners.add(owner)
    event.sender.once("destroyed", () => {
      cleanupOwners.delete(owner)
      revokeExternalFileReadGrantsForOwner(owner)
      void cancelWorkspaceFileScansForOwner(owner)
      getFileAttachmentParserClient().cancelLatest(`bot-attachment:${owner}`)
    })
  }
  const listFiles = async (
    event: IpcMainInvokeEvent,
    workspace: string,
    next: unknown,
    validate: () => unknown = () => undefined
  ) => {
    const owner = event.sender.id
    attachCleanup(event)
    const scan = next == null ? await openWorkspaceFileScan(owner, workspace) : cursor(next)
    try {
      validate()
      const page = await readWorkspaceFileScanPage(
        owner,
        scan.scanId,
        "continuation" in scan ? scan.continuation : undefined
      )
      validate()
      if (page.workspacePath !== workspace) {
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
    } catch (error) {
      await cancelWorkspaceFileScan(owner, scan.scanId)
      throw error
    }
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
      return listFiles(event, workspace, next)
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
      maxChars < 0 ||
      maxChars > 24_000
    )
      throw new BotError("INVALID_INPUT", "附件字符预算无效")
    const { host, bot, workspace, group, work, validate } = context(hostId, botId, groupId, workId)
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
    if (asAttachments) assertCanAttachWithoutText(maxChars, selected.filePaths, !work?.source)
    const assertCurrent = () => {
      if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
    }
    attachCleanup(event)
    if (!asAttachments) {
      const imported: string[] = []
      for (const source of selected.filePaths) {
        assertCurrent()
        const target = await botImportDestination(workspace, source)
        assertCurrent()
        await copyBotFile(dirname(source), source, target.path)
        imported.push(target.id)
      }
      return imported
    }
    let remainingChars = maxChars
    const retain = group === undefined && !work?.source
    const images = new BotImageImportBatch()
    try {
      return await withAttachmentStorage(retain ? work : undefined, workspace, validate, async batch => {
        const staged: StagedAttachment[] = []
        for (const [index, source] of selected.filePaths.entries()) {
          if (!work?.source && botImageMime(source, 1)) {
            imageWindow(event)
            await images.add(index, basename(source), await readBotImageSelection(dirname(source), source))
            continue
          }
          assertCurrent()
          const item = await stageSelectedAttachment({
            batch, index, name: source, maxChars: remainingChars, visualOnly: maxChars === 0,
            owner: event.sender.id, group: Boolean(group), retain, snapshotReference: Boolean(work && retain),
            assertCurrent, assertVisualInput: work?.source ? undefined : () => imageWindow(event),
            source: { path: source }
          })
          staged.push(item)
          remainingChars -= item.attachment.content.length
        }
        return publishSelection(batch, staged, images, validate, inputs => {
          if (inputs.some(({ attachment }) => attachment.embeddedImageCount ||
              botImageMime(attachment.filename, attachment.size))) imageWindow(event)
          return host.retainImageSelection(bot.id, group, work?.id, inputs)
        })
      })
    } finally { await images.close() }
  }
  ipcMain.handle("bots:files:import", (event, hostId, botId, groupId, maxFiles, workId) =>
    importFiles(event, hostId, botId, groupId, maxFiles, false, 24_000, workId)
  )
  ipcMain.handle("bots:files:attach", (event, hostId, botId, maxFiles, maxChars, groupId, workId) =>
    importFiles(event, hostId, botId, groupId, maxFiles, true, maxChars, workId)
  )
  ipcMain.handle("bots:files:attach-workspace", async (event, hostId: unknown, botId: unknown,
    threadId: unknown, value: unknown, maxChars: unknown, workId: unknown) => {
    desktopWindow(event)
    const id = fileId(value)
    if (botImageMime(id, 1)) imageWindow(event)
    if (id.startsWith("/") || id.includes("\\") || /^[a-z]:/i.test(id) ||
        id.split("/").some(part => !part || part === "." || part === "..") ||
        typeof maxChars !== "number" || !Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 24_000)
      throw new BotError("INVALID_INPUT", "工作区文件引用或附件字符预算无效")
    const host = hostFor(hostId)
    const owner = host.getBot(botIdentifier(botId))
    const selectedWork = workId === undefined ? undefined : host.getWork(owner.id, botIdentifier(workId))
    if (typeof threadId !== "string" || threadId !== (selectedWork?.threadId ?? owner.threadId) || owner.archived ||
        (selectedWork && (selectedWork.source || selectedWork.audienceKey !== "desktop")))
      throw new BotError("CONFLICT", "文件不属于当前桌面 Bot 会话")
    assertCanAttachWithoutText(maxChars, [id], true)
    const lease = requireThreadMutationLease(threadId)
    const { bot, workspace, work, validate } = context(hostId, botId, undefined, workId)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
    event.sender.once("destroyed", cancel)
    try {
      return await withAttachmentStorage(work, workspace, validate, async batch => {
        signal.throwIfAborted()
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
        const source = await resolveBotWorkspaceFile(workspace, id)
        if (botImageMime(id, 1)) {
          const images = new BotImageImportBatch()
          try {
            await images.add(0, basename(id), await readBotImageSelection(workspace, source))
            return images.commit([], inputs => {
              signal.throwIfAborted()
              imageWindow(event)
              if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
              return host.retainImageSelection(bot.id, undefined, work?.id, inputs)
            })[0]
          } finally { await images.close() }
        }
        const root = batch.staging
        const snapshot = await snapshotBotDeliveryFile(root, source, signal, workspace,
          maxChars === 0 ? MAX_ATTACHMENT_FILE_BYTES : MAX_BOT_IMPORT_FILE_BYTES)
        const path = work ? join(batch.storage, relative(batch.staging, snapshot.attachmentPath)) : join(workspace, id)
        const attachment = await retainedAttachment({
          target: { id: path, path }, filename: basename(id), size: snapshot.size, maxChars,
          owner: event.sender.id, managed: batch.managed,
          assertVisualInput: () => imageWindow(event), visualOnly: maxChars === 0,
          ...(isVisualDocumentPath(id) && snapshot.size <= MAX_ATTACHMENT_FILE_BYTES ? {
            readBytes: async () => {
              const opened = await openStableFileHandle(root, snapshot.attachmentPath)
              try {
                return Uint8Array.from(await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)).buffer
              } finally {
                await opened.handle.close()
              }
            }
          } : {
            readText: budget => readRetainedWorkspaceText(threadId, root, snapshot.attachmentPath, budget, signal)
          })
        })
        if (attachment.embeddedImageCount) imageWindow(event)
        signal.throwIfAborted()
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
        return withBotDeliverySnapshotBatch(batch.storage, async publication => {
          signal.throwIfAborted()
          if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
          const published = await publishStagedBotDeliveryFile(publication, batch.staging, snapshot.attachmentPath, signal)
          signal.throwIfAborted()
          if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
          return host.retainInputFile(bot.id,
            work ? finalSnapshotReference(attachment, published, batch.managed) : attachment, published, work?.id)
        })
      }, lease)
    } finally {
      event.sender.removeListener("destroyed", cancel)
    }
  })
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
        maxChars < 0 ||
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
      const { host, bot, workspace, group, work, validate } = context(hostId, botId, groupId, workId)
      if (bot.archived) throw new BotError("CONFLICT", "请先恢复 Bot")
      assertCanAttachWithoutText(maxChars, files.map(file => file.fileName), !work?.source)
      if (!work?.source && files.some(file => botImageMime(file.fileName, file.bytes.byteLength)))
        imageWindow(event)
      attachCleanup(event)
      let remainingChars = maxChars
      const retain = group === undefined && !work?.source
      const assertCurrent = () => {
        if (validate().archived) throw new BotError("CONFLICT", "Bot 已归档")
      }
      const images = new BotImageImportBatch()
      try {
        return await withAttachmentStorage(retain ? work : undefined, workspace, validate, async batch => {
          const staged: StagedAttachment[] = []
          for (const [index, { fileName, bytes }] of files.entries()) {
            const imageName = fileName.replace(/[. ]+$/, "")
            if (!work?.source && botImageMime(imageName, 1)) {
              imageWindow(event)
              await images.add(index, imageName, bytes)
              continue
            }
            assertCurrent()
            const item = await stageSelectedAttachment({
              batch, index, name: fileName, maxChars: remainingChars, visualOnly: maxChars === 0,
              owner: event.sender.id, group: Boolean(group), retain, snapshotReference: Boolean(work && retain),
              assertCurrent, assertVisualInput: work?.source ? undefined : () => imageWindow(event),
              source: { bytes }
            })
            staged.push(item)
            remainingChars -= item.attachment.content.length
          }
          return publishSelection(batch, staged, images, validate, inputs => {
            if (inputs.some(({ attachment }) => attachment.embeddedImageCount ||
                botImageMime(attachment.filename, attachment.size))) imageWindow(event)
            return host.retainImageSelection(bot.id, group, work?.id, inputs)
          })
        })
      } finally { await images.close() }
    }
  )
  const exportFile = async (
    event: IpcMainInvokeEvent,
    workspace: string,
    id: unknown,
    validate: () => unknown,
    suggestedName?: unknown
  ) => {
    if (suggestedName !== undefined &&
        (typeof suggestedName !== "string" || !suggestedName ||
          suggestedName.length > MAX_ATTACHMENT_FILE_NAME_LENGTH ||
          suggestedName === "." || suggestedName === ".." || /[\0/\\]/.test(suggestedName)))
      throw new BotError("INVALID_INPUT", "保存文件名无效")
    const source = await resolveBotWorkspaceFile(workspace, fileId(id), { allowAbsolute: true })
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("操作窗口已关闭")
    const destination = await dialog.showSaveDialog(window, {
      title: "保存工作成果",
      defaultPath: typeof suggestedName === "string" ? suggestedName : basename(source)
    })
    if (destination.canceled || !destination.filePath) return false
    validate()
    await exportBotFile(workspace, source, destination.filePath)
    return true
  }
  const desktopWindow = (event: IpcMainInvokeEvent) => {
    const window = event.senderFrame && event.senderFrame === event.sender.mainFrame
      ? BrowserWindow.fromWebContents(event.sender) : null
    if (!window) throw new BotError("CONFLICT", "此操作仅支持本机桌面窗口")
    return window
  }
  const imageWindow = (event: IpcMainInvokeEvent) =>
    getMainWindow ? assertChatAttachmentWindow(event, getMainWindow) : desktopWindow(event)
  const readImagePreview = (event: IpcMainInvokeEvent, read: () => Promise<DraftAttachmentImage[]>) => {
    imageWindow(event)
    return withBotImagePreview(async () => {
      imageWindow(event)
      const images = await read()
      imageWindow(event)
      return images
    })
  }
  ipcMain.handle("bots:files:read-group-message-images", async (
    event, hostId: unknown, group: unknown, message: unknown
  ) => readImagePreview(event, async () => {
    const host = hostFor(hostId)
    const groupId = botIdentifier(group), messageId = botIdentifier(message)
    const lookup = () => host.groupMessageImageInputs(groupId, messageId)
    const files = lookup()
    const images: DraftAttachmentImage[] = []
    for (const file of files)
      images.push(...await readBotAttachmentImages(file, "bot-group-preview:" + file.id))
    const current = lookup()
    if (current.length !== files.length || current.some((file, i) =>
      file.id !== files[i].id || file.file.filePath !== files[i].file.filePath))
      throw new BotError("CONFLICT", "群消息附件已变更")
    return images
  }))
  ipcMain.handle("bots:files:read-attachment-images", async (
    event, hostId: unknown, botId: unknown, input: unknown, groupId?: unknown, workId?: unknown, messageId?: unknown
  ) => readImagePreview(event, async () => {
    const host = hostFor(hostId)
    const bot = botIdentifier(botId), inputId = botIdentifier(input)
    const group = groupId === undefined ? undefined : botIdentifier(groupId)
    const work = workId === undefined ? undefined : botIdentifier(workId)
    if (group && work) throw new BotError("INVALID_INPUT", "工作与群会话不能混用")
    const message = messageId === undefined ? undefined : botIdentifier(messageId)
    if (group && message) throw new BotError("INVALID_INPUT", "请通过群消息预览群图片")
    const lookup = () => host.desktopAttachmentPreviewInput(bot, inputId, group, work, message)
    const file = lookup()
    const images = await readBotAttachmentImages(file, "bot-attachment-preview:" + inputId)
    if (lookup().file.filePath !== file.file.filePath)
      throw new BotError("CONFLICT", "附件已变更，请重新添加")
    return images
  }))
  ipcMain.handle("bots:files:authorize-delivery", async (event, hostId: unknown, input: unknown) => {
    desktopWindow(event)
    const host = hostFor(hostId)
    const source = parseBotDeliveredFileSource(input)
    const receipt = readDesktopBotDelivery(host, source)
    if (receipt.file.attachmentRoot) {
      const opened = await openStableFileHandle(receipt.root, receipt.path)
      try {
        if (opened.filePath !== receipt.path || opened.size !== receipt.file.size)
          throw new BotError("CONFLICT", "原交付附件的字节已变化。")
      } finally {
        await opened.handle.close()
      }
    }
    // Managed snapshots are writable by the local user too. Authorize the same
    // bytes that formal export validates, not merely the same path and length.
    if (await hashBotFile(receipt.root, receipt.path, new AbortController().signal) !== receipt.digest) {
      throw new BotError("CONFLICT", "原交付附件的字节已变化。")
    }
    desktopWindow(event)
    const current = revalidateDesktopBotDelivery(host, source, receipt)
    attachCleanup(event)
    const scope = createHash("sha256").update(JSON.stringify([receipt.receiptKey, source])).digest("hex")
    const issuedAt = Date.now()
    const authorization = issueExternalFileReadGrant(receipt.root, event.sender.id,
      [relative(receipt.root, receipt.path)], `bot-delivery:${scope}`)
    if ("error" in authorization) throw new BotError("CONFLICT", authorization.error)
    return {
      filePath: receipt.path,
      grant: authorization.grant,
      expiresAt: issuedAt + EXTERNAL_FILE_READ_GRANT_TTL_MS,
      ...(current.markdownWorkspace ? { markdownBasePath: current.file.filePath } : {})
    }
  })
  ipcMain.handle("bots:files:export-delivery", async (event, hostId: unknown, input: unknown) => {
    const window = desktopWindow(event)
    const host = hostFor(hostId)
    const source = parseBotDeliveredFileSource(input)
    const receipt = readDesktopBotDelivery(host, source)
    const destination = await dialog.showSaveDialog(window, {
      title: "保存工作成果",
      defaultPath: basename(receipt.path)
    })
    if (destination.canceled || !destination.filePath) return false
    const beforeCommit = () => {
      desktopWindow(event)
      revalidateDesktopBotDelivery(host, source, receipt)
    }
    beforeCommit()
    await exportBotFile(receipt.root, receipt.path, destination.filePath, undefined, {
      digest: receipt.digest, size: receipt.file.size, beforeCommit
    })
    return true
  })
  const groupContext = (hostId: unknown, groupId: unknown) => {
    const host = hostFor(hostId),
      group = botIdentifier(groupId)
    const validate = () => host.getGroup(group)
    validate()
    const workspace = botDirectory(
      join(getCmbCoworkAgentDataRoot(), "bots"),
      "workspaces",
      `group-${group}`
    )
    return { workspace, validate }
  }
  ipcMain.handle(
    "bots:files:group-workspace",
    (_event, hostId: unknown, groupId: unknown) => groupContext(hostId, groupId).workspace
  )
  ipcMain.handle(
    "bots:files:list-group",
    (event, hostId: unknown, groupId: unknown, next: unknown) => {
      const { workspace, validate } = groupContext(hostId, groupId)
      return listFiles(event, workspace, next, validate)
    }
  )
  ipcMain.handle(
    "bots:files:export-group",
    async (event, hostId: unknown, groupId: unknown, id: unknown, suggestedName?: unknown) => {
      const { workspace, validate } = groupContext(hostId, groupId)
      return exportFile(event, workspace, id, validate, suggestedName)
    }
  )
  ipcMain.handle(
    "bots:files:export-im",
    async (
      event,
      hostId: unknown,
      botId: unknown,
      conversationId: unknown,
      id: unknown,
      workId?: unknown,
      suggestedName?: unknown
    ) => {
      const host = hostFor(hostId),
        bot = botIdentifier(botId),
        bindingId = botIdentifier(conversationId)
      const workKey = workId === undefined ? undefined : botIdentifier(workId)
      const defaultWorkspace = botDirectory(
        join(getCmbCoworkAgentDataRoot(), "bots"),
        "workspaces",
        `mock-${bindingId}`
      )
      const validate = () => {
        host.getBot(bot)
        const route = host.imGateway.binding(bindingId)
        if (!route || route.binding.botId !== bot || route.binding.kind !== "group")
          throw new BotError("NOT_FOUND", "招乎群会话不存在")
        if (workKey) {
          const work = host.getWork(bot, workKey)
          if (
            work.botId !== bot ||
            work.source?.transport !== "im" ||
            work.source.bindingId !== bindingId ||
            work.source.personal
          )
            throw new BotError("NOT_FOUND", "任务不属于当前 Bot 和招乎群")
          // Read the host-pinned directory, never a workspace supplied by the renderer.
          return work.workspace?.path ?? defaultWorkspace
        }
        return defaultWorkspace
      }
      // Local retained history remains readable after revoke; this grants no IM execution.
      const workspace = validate()
      return exportFile(event, workspace, id, () => {
        if (validate() !== workspace)
          throw new BotError("CONFLICT", "任务工作目录已变化，请重新打开附件")
      }, suggestedName)
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
      workId: unknown,
      suggestedName?: unknown
    ) => {
      const { workspace, validate } = context(hostId, botId, groupId, workId)
      return exportFile(event, workspace, id, validate, suggestedName)
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
