import { createHash } from "node:crypto"
import { mkdirSync, realpathSync } from "node:fs"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BotInputFile } from "../../shared/bots/input-files"
import type { BotWorkItem } from "../../shared/bots/work"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { getThreadCore } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation, type ThreadIncarnationRow } from "../services/thread-incarnation"
import { getProjectThreadDataDirectorySync } from "../agent/context-history-path"
import { botDirectory } from "./paths"
import { verifyWorkConversationThread } from "./conversation-link-authority"
import { workInputPinKey } from "./input-files"
import { verifiedWorkResultThread } from "./work-result-thread"

export const botAttachmentReceiptKey = (threadId: string, row: NonNullable<ReturnType<typeof getThreadCore>>) =>
  `thread-${createHash("sha256").update(JSON.stringify([threadId, captureThreadIncarnation(row)])).digest("hex")}`

/** Only project/directory work and existing linked work move system copies outside the project. */
export function usesManagedWorkAttachmentStorage(work?: BotWorkItem): work is BotWorkItem {
  return Boolean(work && !work.source && work.audienceKey === "desktop" &&
    (work.workspace?.kind === "directory" || work.workspace?.kind === "project" ||
      work.conversation?.origin === "existing"))
}

export function workAttachmentStorage(workspace: string, work?: BotWorkItem): string | undefined {
  if (!usesManagedWorkAttachmentStorage(work)) return undefined
  const row = getThreadCore(work.threadId)
  if (!row) throw new Error("原任务会话不存在，无法保存资料。")
  return createWorkAttachmentStorage(workspace, work.threadId, botAttachmentReceiptKey(work.threadId, row))
}

export type BotInputHistoryResolver = () => {
  pickerRoot?: string
  defaultPickerRoot?: string
  pinRoot: string
} | undefined

/** Every desktop work can own transferred pins, independently of where it publishes results. */
export function createBotInputHistoryResolver(
  work: BotWorkItem,
  thread: ThreadIncarnationRow | null | undefined,
  workspace: string,
  readWork: () => BotWorkItem,
  pickerRoot?: string
): BotInputHistoryResolver | undefined {
  if (!thread || work.source || work.audienceKey !== "desktop") return
  const incarnation = captureThreadIncarnation(thread)
  return () => {
    const row = getThreadCore(work.threadId)
    if (!row || !matchesThreadIncarnation(row, incarnation) ||
        (pickerRoot && botAttachmentReceiptKey(work.threadId, row) !== basename(pickerRoot))) return
    const current = readWork()
    if (current.id !== work.id || current.botId !== work.botId || current.threadId !== work.threadId ||
        verifiedWorkResultThread(current).workspacePath !== workspace) return
    const pinKey = workInputPinKey(work.id)
    if (pickerRoot) return { pickerRoot, pinRoot: join(dirname(pickerRoot), pinKey) }
    const appRoot = realpathSync(getCmbCoworkAgentDataRoot())
    const defaultWorkspace = join(appRoot, "bots", "workspaces", work.botId)
    const threadRoot = getProjectThreadDataDirectorySync(workspace, work.threadId, appRoot)
    return {
      // The default picker uses the Bot's own workspace, shared by its main
      // conversation and native work. The Store still requires this work's input receipt.
      defaultPickerRoot: workspace === defaultWorkspace && !usesManagedWorkAttachmentStorage(current)
        ? workspace : undefined,
      pinRoot: join(threadRoot, "attachments", pinKey)
    }
  }
}

function createWorkAttachmentStorage(workspace: string, threadId: string, key: string): string {
  const appRoot = getCmbCoworkAgentDataRoot()
  mkdirSync(appRoot, { recursive: true })
  const root = realpathSync(appRoot)
  const threadRoot = getProjectThreadDataDirectorySync(workspace, threadId, root)
  let current = root
  for (const segment of relative(root, threadRoot).split(sep)) {
    current = join(current, segment)
    mkdirSync(current, { recursive: true })
    if (realpathSync(current) !== current) throw new Error("任务资料目录不能是符号链接")
  }
  return botDirectory(threadRoot, "attachments", key)
}

/** Only this picker operation owns the staging directory. Committed snapshots can be shared. */
export async function withStagedWorkAttachments<T>(storage: string, use: (staging: string) => Promise<T>): Promise<T> {
  const staging = await mkdtemp(join(storage, ".input-batch-"))
  try {
    return await use(staging)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(error => {
      console.warn("[Bots] Could not remove attachment staging directory", error)
    })
  }
}

function workInputPinWorkspace(work: BotWorkItem): string {
  if (work.conversation) {
    const row = getThreadCore(work.threadId)
    if (!row || work.conversation.state !== "bound") throw new Error("原任务会话不存在，无法保存资料。")
    const metadata = JSON.parse(row.metadata || "{}")
    verifyWorkConversationThread(work, row, metadata)
    return metadata.workspacePath
  }
  return work.workspace?.path ?? join(getCmbCoworkAgentDataRoot(), "bots", "workspaces", work.botId)
}

/** The original work already owns this directory even before its native thread is initialized. */
export function workInputPinStorage(work: BotWorkItem): string {
  const workspace = !work.conversation && !work.workspace
    ? botDirectory(join(getCmbCoworkAgentDataRoot(), "bots"), "workspaces", work.botId)
    : workInputPinWorkspace(work)
  return createWorkAttachmentStorage(workspace, work.threadId, workInputPinKey(work.id))
}

/** An uninitialized work has no native thread deletion to clear its managed data. */
export async function removeUninitializedWorkInputPins(work: BotWorkItem): Promise<void> {
  const canonical = (path: string) => realpath(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  const appRoot = await canonical(getCmbCoworkAgentDataRoot())
  if (!appRoot) return
  const root = getProjectThreadDataDirectorySync(workInputPinWorkspace(work), work.threadId, appRoot)
  const storage = join(root, "attachments", workInputPinKey(work.id))
  const actual = await canonical(storage)
  if (!actual) return
  if (actual !== storage) throw new Error("任务资料目录不能是符号链接")
  await rm(storage, { recursive: true, force: true })
}

/** An input stored under a different work cannot survive that work's deletion. */
export function botInputNeedsLifetimePin(file: BotInputFile, targetWorkId: string): boolean {
  if (file.workId === targetWorkId) return false
  const attachmentPath = file.file.filePath
  const attachmentRoot = dirname(dirname(dirname(attachmentPath)))
  if (basename(dirname(attachmentRoot)) !== "attachments") return false
  const key = basename(attachmentRoot)
  if (/^thread-[a-f0-9]{64}$/.test(key) || (file.workId && key === workInputPinKey(file.workId))) {
    validateManagedSnapshotRoot(attachmentPath, attachmentRoot)
    return true
  }
  return false
}

/** The path is an already trusted receipt, never an arbitrary renderer or model path. */
export function botSnapshotSourceRoot(
  file: Pick<BotDeliveredFile, "attachmentPath" | "attachmentRoot">, workspace?: string
): string {
  const path = file.attachmentPath
  if (!path || !isAbsolute(path)) throw new Error("原交付没有已保存的副本。")
  if (!file.attachmentRoot) {
    if (!workspace) throw new Error("原交付工作目录已不可用。")
    return workspace
  }
  const root = resolve(file.attachmentRoot)
  if (!/^thread-[a-f0-9]{64}$/.test(basename(root)))
    throw new Error("已保存附件的原始存放位置无效。")
  validateManagedSnapshotRoot(path, root)
  return root
}

function validateManagedSnapshotRoot(path: string, root: string): void {
  const base = join(realpathSync(getCmbCoworkAgentDataRoot()), "projects")
  const parts = relative(base, root).split(sep)
  if (parts.length !== 4 || parts[0] === ".." || isAbsolute(relative(base, root)) ||
      parts[2] !== "attachments" ||
      realpathSync(root) !== root || dirname(dirname(dirname(path))) !== root ||
      basename(dirname(dirname(path))) !== ".bot-deliveries" ||
      !/^[a-f0-9]{64}$/.test(basename(dirname(path))) || relative(root, path).startsWith(".."))
    throw new Error("已保存附件的原始存放位置无效。")
}
