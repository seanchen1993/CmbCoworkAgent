import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "./app-data-root"
import { getDb, getThreadCore } from "./db"
import { captureThreadIncarnation, type ThreadIncarnationRow } from "./services/thread-incarnation"
import type { AgentInvokeParams } from "./types"
import { chatImageMarker } from "../shared/attachment-message-parts"
import { normalizeGitWorkspacePathKey } from "../shared/workspace-path"
import { chatImageExtensions, type SubmittedChatImage, MAX_ATTACHMENT_FILE_BYTES, type ChatImageRef,
  type FileAttachment } from "../shared/file-attachment"

const validId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
let decoding = 0

function imageDirectoryName(threadId: string, row: ThreadIncarnationRow) {
  return createHash("sha256").update(JSON.stringify([threadId, captureThreadIncarnation(row)]))
    .digest("hex")
}

function scope(threadId: string) {
  if (typeof threadId !== "string" || !threadId) throw new Error("请先选择会话")
  const row = getThreadCore(threadId)
  if (!row) throw new Error("会话已关闭")
  return join(getCmbCoworkAgentDataRoot(), "chat-images", imageDirectoryName(threadId, row))
}

export async function stageChatImage(threadId: string, name: string, bytes: ArrayBuffer,
  options?: { deduplicationKey?: string; beforePublish?: () => void; draftWorkspace?: string }):
Promise<FileAttachment> {
  const root = scope(threadId)
  const extension = extname(name).toLowerCase()
  if (!chatImageExtensions.includes(extension) || bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES)
    throw new Error("图片格式或大小超限")
  if (decoding >= 3) throw new Error("其他图片正在处理，请稍后重试")
  const digest = options?.deduplicationKey &&
    createHash("sha256").update(options.deduplicationKey).digest("hex")
  const id = digest
    ? [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
      digest.slice(16, 20), digest.slice(20, 32)].join("-")
    : randomUUID()
  const tempPath = join(root, randomUUID() + ".tmp")
  const size = bytes.byteLength
  decoding++
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const { default: launch } = await import("./chat-image-worker?nodeWorker")
    const worker = launch({ workerData: { bytes, extension, tempPath }, transferList: [bytes],
      resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const timer = setTimeout(() => void worker.terminate(), 15_000)
    try {
      const result = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("exit", () => reject(new Error("图片解析任务已结束或超时")))
        worker.once("message", value => value.error ? reject(new Error(value.error)) : resolve(value))
      })
      if (scope(threadId) !== root) throw new Error("会话已变更")
      options?.beforePublish?.()
      await rename(tempPath, join(root, id + ".webp"))
      if (options?.draftWorkspace !== undefined) {
        try {
          options.beforePublish?.()
          getDb().run("INSERT INTO chat_image_input_owners VALUES (?, '', ?, ?)",
            [threadId, id, options.draftWorkspace])
        } catch (error) {
          await rm(join(root, id + ".webp"), { force: true })
          throw error
        }
      }
      const image: ChatImageRef = { id, filename: basename(name), ...result }
      return { image, filename: image.filename, filePath: "", content: "",
        size, mimeType: "image/webp", truncated: false }
    } finally {
      clearTimeout(timer)
      await worker.terminate()
    }
  } finally {
    decoding--
    await rm(tempPath, { force: true })
  }
}

export async function readChatImage(threadId: string, id: string) {
  if (typeof id !== "string" || !validId.test(id)) throw new Error("图片引用无效")
  const data = await readFile(join(scope(threadId), id + ".webp"))
  if (data.length > 2 * 1024 * 1024) throw new Error("图片内容超过预算")
  return { type: "image_url" as const, image_url: { url: "data:image/webp;base64," + data.toString("base64") } }
}


/** Match only the selected sidecar entries still present once after submit hooks. */
export async function approveChatImages(threadId: string, initial: string, prepared: string,
  images: SubmittedChatImage[] | undefined, messageId?: string): Promise<SubmittedChatImage[]> {
  if (!images?.length) return []
  if (!Array.isArray(images) || images.length > 3) throw new Error("图片数量超限")
  const ids = new Set<string>()
  const slots = new Set<number>()
  const approved: SubmittedChatImage[] = []
  const root = scope(threadId)
  for (const image of images) {
    if (!image || typeof image.id !== "string" || !validId.test(image.id) || ids.has(image.id) || slots.has(image.slot) ||
      !Number.isInteger(image.slot) || image.slot < 0 || image.slot >= 3 ||
      typeof image.filename !== "string" || image.filename.length > 512) throw new Error("图片引用无效")
    ids.add(image.id)
    slots.add(image.slot)
    const marker = chatImageMarker(image)
    if (initial.split(marker).length !== 2 || prepared.split(marker).length !== 2) continue
    if (!(await stat(join(root, image.id + ".webp"))).isFile()) throw new Error("图片已失效，请重新添加")
    assertImageInputOwner(threadId, image.id, messageId)
    approved.push({ id: image.id, slot: image.slot, filename: image.filename })
  }
  return approved
}

export interface ChatImageReceipt {
  images: SubmittedChatImage[]
  preparedText?: string
  source?: "bot"
  submissionId?: string
}

function submissionDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

function storedImageSubmission(threadId: string, messageId: string, bySubmissionId = false) {
  // A display-ID rename moves the message binding. The original request still owns its receipt.
  const byRequest = bySubmissionId && getDb().exec(
    "SELECT request_digest, images_json FROM chat_image_messages WHERE thread_id=? AND json_extract(images_json, '$.submissionId')=?",
    [threadId, messageId]
  )[0]?.values[0]
  const row = byRequest || getDb().exec(
    "SELECT request_digest, images_json FROM chat_image_messages WHERE thread_id=? AND message_id=?",
    [threadId, messageId]
  )[0]?.values[0]
  if (!row) return
  const saved = JSON.parse(String(row[1])) as SubmittedChatImage[] | ChatImageReceipt
  return { digest: String(row[0]), receipt: Array.isArray(saved) ? { images: saved } : saved }
}

function writeImageReceipt(threadId: string, messageId: string, digest: string, receipt: ChatImageReceipt) {
  const prior = storedImageSubmission(threadId, messageId)
  if (prior) {
    if (prior.digest !== digest) throw new Error("同一消息已提交不同内容或图片")
    return prior.receipt
  }
  getDb().run(
    "INSERT INTO chat_image_messages (thread_id, message_id, request_digest, images_json) VALUES (?, ?, ?, ?)",
    [threadId, messageId, digest, JSON.stringify(receipt)]
  )
  return receipt
}

export function bindChatImages(threadId: string, messageId: string, original: string,
  requested: SubmittedChatImage[], approved: SubmittedChatImage[]) {
  return writeImageReceipt(threadId, messageId, submissionDigest([original, requested]), {
    images: approved, preparedText: original
  })
}

type PendingImageSubmission = {
  digest: string
  assetIds: string[]
  threadId: string
  outcome: Promise<ChatImageReceipt | undefined>
}
const pendingImageSubmissions = new Map<string, PendingImageSubmission>()

function assertImageInputOwner(threadId: string, id: string, messageId?: string) {
  const row = getThreadCore(threadId)
  if (!row) throw new Error("会话已关闭")
  const workspace = (JSON.parse(row.metadata || "{}") as { workspacePath?: string }).workspacePath
  const owner = getDb().exec(
    "SELECT 1 FROM chat_image_input_owners WHERE thread_id=? AND asset_id=? AND workspace_key=? AND (message_id='' OR message_id=?) LIMIT 1",
    [threadId, id, normalizeGitWorkspacePathKey(workspace ?? ""), messageId ?? ""])[0]?.values.length
  if (!owner) throw new Error("图片已失效或不属于当前草稿，请重新添加")
}

export function pinQueuedChatImages(threadId: string, workspace: string | null, messageId: string, ids: string[]) {
  if (!validId.test(messageId) || !Array.isArray(ids) || !ids.length || ids.length > 3 ||
      new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !validId.test(id)))
    throw new Error("图片队列引用无效")
  const db = getDb(), key = normalizeGitWorkspacePathKey(workspace ?? "")
  const args = [threadId, key, JSON.stringify(ids)]
  const source = "FROM chat_image_input_owners WHERE thread_id=? AND workspace_key=? AND message_id='' AND asset_id IN (SELECT value FROM json_each(?))"
  if (db.exec("SELECT count(*) " + source, args)[0]?.values[0][0] !== ids.length)
    throw new Error("图片已失效，请重新添加")
  db.run("INSERT OR IGNORE INTO chat_image_input_owners SELECT thread_id, ?, asset_id, workspace_key " +
    source, [messageId, ...args])
}

export async function unpinQueuedChatImages(threadId: string, messageId: string, workspace: string | null) {
  if (!validId.test(messageId)) throw new Error("图片队列引用无效")
  const db = getDb(), root = scope(threadId)
  const args = [threadId, messageId, normalizeGitWorkspacePathKey(workspace ?? "")]
  const where = "FROM chat_image_input_owners WHERE thread_id=? AND message_id=? AND workspace_key=?"
  const ids = db.exec("SELECT asset_id " + where, args)[0]?.values ?? []
  db.run("DELETE " + where, args)
  await Promise.all(ids.map(([id]) => removeUnownedImage(threadId, root, String(id))))
}

async function removeUnownedImage(threadId: string, root: string, id: string) {
  const db = getDb()
  const owners = db.exec("SELECT 1 FROM chat_image_input_owners WHERE thread_id=? AND asset_id=? LIMIT 1",
    [threadId, id])[0]?.values.length
  if (owners || [...pendingImageSubmissions.values()].some(item =>
    item.threadId === threadId && item.assetIds.includes(id))) return
  const bound = db.exec(`SELECT 1 FROM chat_image_messages, json_each(
    CASE WHEN json_type(images_json) = 'array' THEN images_json ELSE json_extract(images_json, '$.images') END
  ) AS image WHERE thread_id=? AND json_extract(image.value, '$.id')=? LIMIT 1`, [threadId, id])[0]?.values.length
  if (!bound) await rm(join(root, id + ".webp"), { force: true })
}

export async function discardChatDraftImage(threadId: string, workspace: string | null, id: string) {
  if (typeof id !== "string" || !validId.test(id)) throw new Error("图片引用无效")
  const db = getDb(), root = scope(threadId)
  db.run("DELETE FROM chat_image_input_owners WHERE thread_id=? AND asset_id=? AND workspace_key=? AND message_id=''",
    [threadId, id, normalizeGitWorkspacePathKey(workspace ?? "")])
  if (db.getRowsModified()) await removeUnownedImage(threadId, root, id)
}

export interface ChatImageAdmission {
  accept(preparedText: string, images: SubmittedChatImage[]): void
  release(): void
}

/** Claim before hooks or replacing an active physical run. Each subscriber has its own stream. */
export function beginChatImageSubmission(request: AgentInvokeParams):
  | { owner: ChatImageAdmission }
  | { replay: Promise<ChatImageReceipt | undefined> }
  | undefined {
  const { threadId, userMessageId, message, chatImages = [] } = request
  if (!Array.isArray(chatImages) || chatImages.length > 3) throw new Error("图片数量超限")
  if (!userMessageId?.trim()) {
    if (chatImages.length) throw new Error("图片消息缺少提交标识")
    return
  }
  const stored = storedImageSubmission(threadId, userMessageId, true)
  const key = JSON.stringify([threadId, userMessageId])
  const pending = pendingImageSubmissions.get(key)
  if (!chatImages.length && !stored && !pending) return
  const refs = chatImages.map(ref => {
    if (!ref || typeof ref.id !== "string" || !validId.test(ref.id) ||
      typeof ref.filename !== "string" || ref.filename.length > 512 ||
      !Number.isInteger(ref.slot) || ref.slot < 0 || ref.slot >= 3) throw new Error("图片引用无效")
    return [ref.id, ref.slot, ref.filename]
  })
  const digest = "v2:" + submissionDigest([message, refs, request.modelId ?? null,
    request.agentMode ?? null, Boolean(request.managedExecution), Boolean(request.coordinatorInternalNotification)])
  if (stored) {
    const expected = stored.digest.startsWith("v2:") ? digest : submissionDigest([message, chatImages])
    if (stored.digest !== expected) throw new Error("同一消息已提交不同内容或图片")
    return { replay: Promise.resolve(stored.receipt) }
  }
  if (pending) {
    if (pending.digest !== digest) throw new Error("同一消息已提交不同内容或图片")
    return { replay: pending.outcome }
  }
  const root = scope(threadId)
  for (const ref of chatImages) assertImageInputOwner(threadId, ref.id, userMessageId)
  let settle!: (receipt?: ChatImageReceipt) => void
  const outcome = new Promise<ChatImageReceipt | undefined>(resolve => { settle = resolve })
  pendingImageSubmissions.set(key, { digest, outcome, threadId, assetIds: chatImages.map(ref => ref.id) })
  const release = () => {
    if (pendingImageSubmissions.get(key)?.outcome === outcome) {
      pendingImageSubmissions.delete(key)
      for (const ref of chatImages) {
        void removeUnownedImage(threadId, root, ref.id).catch(error =>
          console.warn("[ChatImages] Unable to release staged image", error?.code))
      }
    }
    settle()
  }
  return { owner: {
    accept(preparedText, images) {
      if (scope(threadId) !== root || pendingImageSubmissions.get(key)?.outcome !== outcome)
        throw new Error("图片消息所属会话已变更")
      for (const image of images) assertImageInputOwner(threadId, image.id, userMessageId)
      const db = getDb()
      let receipt: ChatImageReceipt
      db.run("SAVEPOINT accept_chat_image_submission")
      try {
        receipt = writeImageReceipt(threadId, userMessageId, digest, {
          submissionId: userMessageId, preparedText, images
        })
        db.run("DELETE FROM chat_image_input_owners WHERE thread_id=? AND message_id=?", [threadId, userMessageId])
        db.run("DELETE FROM chat_image_input_owners WHERE thread_id=? AND message_id='' AND asset_id IN (SELECT value FROM json_each(?))",
          [threadId, JSON.stringify(chatImages.map(ref => ref.id))])
        db.run("RELEASE accept_chat_image_submission")
      } catch (error) {
        db.run("ROLLBACK TO accept_chat_image_submission")
        db.run("RELEASE accept_chat_image_submission")
        throw error
      }
      settle(receipt)
      release()
    },
    release
  } }
}

export function boundChatImages(threadId: string, messageId: string): SubmittedChatImage[] {
  return storedImageSubmission(threadId, messageId)?.receipt.images ?? []
}

export function boundChatImageReceipt(threadId: string, messageId: string): ChatImageReceipt | undefined {
  return storedImageSubmission(threadId, messageId)?.receipt
}

export function bindBotChatImages(threadId: string, messageId: string, original: string,
  preparedText: string, images: SubmittedChatImage[]) {
  const fingerprint = submissionDigest([messageId, original, images.map(item => [item.id, item.slot, item.filename])])
  return writeImageReceipt(threadId, messageId, "bot:" + fingerprint, {
    images, preparedText, source: "bot"
  })
}

export async function copyBoundChatImages(source: string, target: string, messageId: string) {
  const receipt = boundChatImageReceipt(source, messageId)
  if (!receipt?.images.length || receipt.source === "bot") return
  const refs = receipt.images
  const root = scope(target)
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const ref of refs) {
    if (!validId.test(ref.id)) throw new Error("图片引用无效")
    await copyFile(join(scope(source), ref.id + ".webp"), join(root, ref.id + ".webp"))
  }
  writeImageReceipt(target, messageId, "fork:" + submissionDigest([source, messageId, refs]), {
    preparedText: receipt.preparedText, images: refs
  })
}

export function captureImageScopeCleanup(threadId: string) {
  const root = scope(threadId)
  return () => rm(root, { recursive: true, force: true })
}

/** Recover interrupted removal and decoder writes under the private image root. */
export async function sweepChatImageStorage() {
  const root = join(getCmbCoworkAgentDataRoot(), "chat-images")
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const folders = entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
  if (!folders.length) return
  const rows = getDb().exec("SELECT thread_id, created_at, metadata FROM threads")[0]?.values ?? []
  const live = new Set(rows.map(([id, created, metadata]) => imageDirectoryName(String(id), {
    created_at: Number(created), metadata: typeof metadata === "string" ? metadata : null
  })))
  for (const folder of folders) {
    const path = join(root, folder.name)
    if (!live.has(folder.name)) {
      await rm(path, { recursive: true, force: true })
      continue
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp") || !validId.test(entry.name.slice(0, -4))) continue
      const file = join(path, entry.name)
      const info = await stat(file).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > 60 * 60 * 1000) await rm(file, { force: true })
    }
  }
}
