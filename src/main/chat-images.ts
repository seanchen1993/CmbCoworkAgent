import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "./app-data-root"
import { getDb, getThreadCore } from "./db"
import { captureThreadIncarnation, type ThreadIncarnationRow } from "./services/thread-incarnation"
import type { AgentInvokeParams } from "./types"
import { chatImageMarker } from "../shared/attachment-message-parts"
import { normalizeGitWorkspacePathKey } from "../shared/workspace-path"
import { threadIncarnationKey } from "../shared/thread-incarnation"
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

export function chatImageIdForKey(key: string) {
  const digest = createHash("sha256").update(key).digest("hex")
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32)].join("-")
}

const publishingImages = new Set<string>()
const heldImageFiles = new Map<string, number>()

export function holdBotImageStage(threadId: string, deduplicationKey: string) {
  return holdImageFile(threadId, scope(threadId), chatImageIdForKey(deduplicationKey))
}

function holdImageFile(threadId: string, root: string, id: string) {
  const path = join(root, id + ".webp")
  heldImageFiles.set(path, (heldImageFiles.get(path) ?? 0) + 1)
  let released = false
  return async () => {
    if (released) return
    released = true
    const remaining = (heldImageFiles.get(path) ?? 1) - 1
    if (remaining) heldImageFiles.set(path, remaining)
    else {
      heldImageFiles.delete(path)
      await removeUnownedImage(threadId, root, id)
    }
  }
}

export async function stageChatImage(threadId: string, name: string, bytes: ArrayBuffer,
  options?: { deduplicationKey?: string; beforePublish?: () => void; draftWorkspace?: string }):
Promise<FileAttachment> {
  const root = scope(threadId)
  const extension = extname(name).toLowerCase()
  if (!chatImageExtensions.includes(extension) || bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES)
    throw new Error("图片格式或大小超限")
  if (decoding >= 3) throw new Error("其他图片正在处理，请稍后重试")
  const id = options?.deduplicationKey ? chatImageIdForKey(options.deduplicationKey) : randomUUID()
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
      publishingImages.add(join(root, id + ".webp"))
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
    publishingImages.delete(join(root, id + ".webp"))
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

type SubmissionScope = { workspace: string; incarnation: string }

function currentSubmissionScope(threadId: string): SubmissionScope | undefined {
  const row = getThreadCore(threadId)
  if (!row) return
  const metadata = JSON.parse(row.metadata || "{}") as { workspacePath?: string }
  return {
    workspace: normalizeGitWorkspacePathKey(metadata.workspacePath ?? ""),
    incarnation: threadIncarnationKey(captureThreadIncarnation(row))
  }
}

function matchesSubmissionScope(saved?: SubmissionScope, current?: SubmissionScope): boolean {
  return Boolean(saved && current && saved.workspace === current.workspace && saved.incarnation === current.incarnation)
}

/** The transport may replay an encoded body after backoff, without running middleware again. */
export function captureDesktopImageAccess(threadId: string) {
  const source = currentSubmissionScope(threadId)
  return () => {
    if (!matchesSubmissionScope(source, currentSubmissionScope(threadId)))
      throw new Error("图片消息所属工作区或会话已变更")
  }
}

function parseStoredReceipt(json: unknown) {
  const value = JSON.parse(String(json)) as (ChatImageReceipt & { phase?: SubmissionPhase; scope?: SubmissionScope }) | SubmittedChatImage[]
  if (Array.isArray(value)) return { receipt: { images: value } as ChatImageReceipt, phase: undefined, scope: undefined }
  const { phase, scope, ...receipt } = value
  return { receipt, phase, scope }
}

function approvedHistory(record: ReturnType<typeof parseStoredReceipt>, current: SubmissionScope | undefined) {
  if ((record.phase || record.scope) && !matchesSubmissionScope(record.scope, current)) return null
  return record.phase === "reserved" || record.phase === "rejected" ? null : record.receipt
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
  return { digest: String(row[0]), ...parseStoredReceipt(row[1]) }
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

type SubmissionPhase = "reserved" | "accepted" | "running" | "succeeded" | "failed" | "rejected"
export type ChatImageSubmissionStatus = Exclude<SubmissionPhase, "reserved"> | "pending" | "unknown" | "missing"

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

export function pinQueuedChatImages(threadId: string, workspace: string | null, messageId: string, ids: string[], previousMessageId = "") {
  if (!validId.test(messageId) || !Array.isArray(ids) || !ids.length || ids.length > 3 ||
      new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !validId.test(id)))
    throw new Error("图片队列引用无效")
  const db = getDb(), key = normalizeGitWorkspacePathKey(workspace ?? "")
  const existing = db.exec("SELECT asset_id FROM chat_image_input_owners WHERE thread_id=? AND workspace_key=? AND message_id=?",
    [threadId, key, messageId])[0]?.values ?? []
  if (existing.length) {
    if (existing.length === ids.length && existing.every(([id]) => ids.includes(String(id)))) return
    throw new Error("队列消息图片已变更")
  }
  const args = [threadId, key, previousMessageId, JSON.stringify(ids)]
  const source = "FROM chat_image_input_owners WHERE thread_id=? AND workspace_key=? AND message_id=? AND asset_id IN (SELECT value FROM json_each(?))"
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
  if (owners || publishingImages.has(join(root, id + ".webp")) || heldImageFiles.has(join(root, id + ".webp")) || [...pendingImageSubmissions.values()].some(item =>
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

export function getChatImageSubmissionStatus(threadId: string, messageId: string): ChatImageSubmissionStatus {
  const record = storedImageSubmission(threadId, messageId, true)
  if (!record) return "missing"
  if (record.phase && !matchesSubmissionScope(record.scope, currentSubmissionScope(threadId))) return "unknown"
  const active = pendingImageSubmissions.has(JSON.stringify([threadId, record.receipt.submissionId ?? messageId]))
  if (record.phase === "reserved") return active ? "pending" : "unknown"
  if (record.phase === "running") return active ? "running" : "unknown"
  return record.phase ?? "unknown"
}

/** A continuation already owns the thread lease and proved this exact user ID in its checkpoint. */
export function settleContinuedChatImageSubmission(threadId: string, messageId: string,
  outcome: "success" | "error") {
  const record = storedImageSubmission(threadId, messageId, true)
  if (record?.phase !== "running" || !record.receipt.submissionId ||
      !matchesSubmissionScope(record.scope, currentSubmissionScope(threadId))) return
  getDb().run(`UPDATE chat_image_messages SET images_json=json_set(images_json, '$.phase', ?)
    WHERE thread_id=? AND json_extract(images_json, '$.submissionId')=?
    AND json_extract(images_json, '$.phase')='running'`,
    [outcome === "success" ? "succeeded" : "failed", threadId, record.receipt.submissionId])
}

export interface ChatImageAdmission {
  recovered?: ChatImageReceipt
  beginHook(): void
  reject(): void
  accept(preparedText: string, images: SubmittedChatImage[]): void
  start(): void
  finish(outcome: "success" | "error" | "unknown"): void
  release(): void
}

/** A persisted reservation precedes Hook execution. An abandoned reservation cannot rerun a Hook. */
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
  const sourceScope = currentSubmissionScope(threadId)
  if (!sourceScope) throw new Error("图片消息所属会话已关闭")
  const fingerprint = [message, refs, request.modelId ?? null, request.agentMode ?? null,
    Boolean(request.managedExecution), Boolean(request.coordinatorInternalNotification)]
  const digest = "v3:" + submissionDigest([...fingerprint, sourceScope.workspace, sourceScope.incarnation])
  if (stored) {
    if (stored.scope && !matchesSubmissionScope(stored.scope, sourceScope))
      throw new Error("图片消息所属工作区或会话已变更，请回到原工作区核对")
    const expected = stored.digest.startsWith("v3:") ? digest : stored.digest.startsWith("v2:")
      ? "v2:" + submissionDigest(fingerprint) : submissionDigest([message, chatImages])
    if (stored.digest !== expected) throw new Error("同一消息已提交不同内容或图片")
  }
  if (pending) {
    if (pending.digest !== digest) throw new Error("同一消息已提交不同内容或图片")
    return { replay: pending.outcome }
  }
  if (stored && (stored.phase !== "accepted" || !matchesSubmissionScope(stored.scope, sourceScope))) {
    return { replay: Promise.resolve(stored.receipt) }
  }

  const root = scope(threadId)
  const db = getDb()
  const recovered = stored?.receipt
  if (!stored) {
    for (const ref of chatImages) assertImageInputOwner(threadId, ref.id, userMessageId)
    db.run("INSERT INTO chat_image_messages (thread_id, message_id, request_digest, images_json) VALUES (?, ?, ?, ?)",
      [threadId, userMessageId, digest, JSON.stringify({ submissionId: userMessageId, phase: "reserved", scope: sourceScope, images: [] })])
  }
  let settle!: (receipt?: ChatImageReceipt) => void
  const outcome = new Promise<ChatImageReceipt | undefined>(resolve => { settle = resolve })
  pendingImageSubmissions.set(key, { digest, outcome, threadId, assetIds: chatImages.map(ref => ref.id) })
  let phase: SubmissionPhase = recovered ? "accepted" : "reserved"
  let approved = recovered
  let hookStarted = false
  function transition(next: SubmissionPhase, receipt?: ChatImageReceipt) {
    if (pendingImageSubmissions.get(key)?.outcome !== outcome ||
        !matchesSubmissionScope(sourceScope, currentSubmissionScope(threadId)))
      throw new Error("图片消息所属工作区或会话已变更")
    const payload = { ...(receipt ?? approved ?? { submissionId: userMessageId, images: [] }), scope: sourceScope, phase: next }
    db.run(`UPDATE chat_image_messages SET images_json=? WHERE thread_id=? AND request_digest=?
      AND json_extract(images_json, '$.submissionId')=? AND json_extract(images_json, '$.phase')=?`,
      [JSON.stringify(payload), threadId, digest, userMessageId!, phase])
    if (db.getRowsModified() !== 1) throw new Error("图片消息接纳状态已变更，请刷新会话")
    phase = next
  }
  return { owner: {
    recovered,
    beginHook() {
      if (!matchesSubmissionScope(sourceScope, currentSubmissionScope(threadId)))
        throw new Error("图片消息所属工作区或会话已变更")
      hookStarted = true
    },
    reject() { if (phase === "reserved") transition("rejected") },
    accept(preparedText, images) {
      if (recovered) {
        if (!matchesSubmissionScope(sourceScope, currentSubmissionScope(threadId)))
          throw new Error("图片消息所属工作区或会话已变更")
        return
      }
      if (phase !== "reserved") throw new Error("图片消息所属会话已变更")
      for (const image of images) assertImageInputOwner(threadId, image.id, userMessageId)
      const receipt = { submissionId: userMessageId, preparedText, images }
      db.run("SAVEPOINT accept_chat_image_submission")
      try {
        transition("accepted", receipt)
        db.run("DELETE FROM chat_image_input_owners WHERE thread_id=? AND message_id=?", [threadId, userMessageId])
        db.run("DELETE FROM chat_image_input_owners WHERE thread_id=? AND message_id='' AND asset_id IN (SELECT value FROM json_each(?))",
          [threadId, JSON.stringify(chatImages.map(ref => ref.id))])
        db.run("RELEASE accept_chat_image_submission")
        approved = receipt
      } catch (error) {
        db.run("ROLLBACK TO accept_chat_image_submission")
        db.run("RELEASE accept_chat_image_submission")
        phase = "reserved"
        throw error
      }
    },
    start() {
      if (!matchesSubmissionScope(sourceScope, currentSubmissionScope(threadId)))
        throw new Error("图片消息所属工作区或会话已变更")
      if (phase === "running") return
      if (phase !== "accepted") throw new Error("图片尚未接纳，无法启动")
      transition("running")
    },
    finish(outcome) {
      if (outcome === "unknown" || !matchesSubmissionScope(sourceScope, currentSubmissionScope(threadId))) return
      if (phase === "reserved" && outcome === "error") transition("rejected")
      if (phase === "running" || (phase === "accepted" && outcome === "error"))
        transition(outcome === "success" ? "succeeded" : "failed")
    },
    release() {
      if (pendingImageSubmissions.get(key)?.outcome !== outcome) return
      try {
        if (phase === "reserved" && !hookStarted && matchesSubmissionScope(sourceScope, currentSubmissionScope(threadId)))
          transition("rejected")
      } finally {
        pendingImageSubmissions.delete(key)
        settle(approved)
        for (const ref of chatImages) {
          void removeUnownedImage(threadId, root, ref.id).catch(error =>
            console.warn("[ChatImages] Unable to release staged image", error?.code))
        }
      }
    }
  } }
}

export function boundChatImages(threadId: string, messageId: string): SubmittedChatImage[] {
  return boundChatImageReceipt(threadId, messageId)?.images ?? []
}

/** null denotes a durable reservation with no approved input. */
export function chatImageHistoryProjection(threadId: string, messageId: string): ChatImageReceipt | null | undefined {
  const record = storedImageSubmission(threadId, messageId)
  return record && approvedHistory(record, currentSubmissionScope(threadId))
}

export function getChatImageHistoryProjections(threadId: string, ids: readonly string[]) {
  const results = new Map<string, ChatImageReceipt | null>()
  if (!ids.length) return results
  const rows = getDb().exec(`SELECT message_id, images_json FROM chat_image_messages
    WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))`, [threadId, JSON.stringify(ids)])[0]?.values ?? []
  const current = rows.length ? currentSubmissionScope(threadId) : undefined
  for (const [id, json] of rows) {
    results.set(String(id), approvedHistory(parseStoredReceipt(json), current))
  }
  return results
}

export function boundChatImageReceipt(threadId: string, messageId: string): ChatImageReceipt | undefined {
  return chatImageHistoryProjection(threadId, messageId) ?? undefined
}

export function bindBotChatImages(threadId: string, messageId: string, original: string,
  preparedText: string, images: SubmittedChatImage[]) {
  const fingerprint = submissionDigest([messageId, original, images.map(item => [item.id, item.slot, item.filename])])
  return writeImageReceipt(threadId, messageId, "bot:" + fingerprint, {
    images, preparedText, source: "bot"
  })
}

export async function copyBoundChatImages(source: string, target: string, messageId: string) {
  const receipt = chatImageHistoryProjection(source, messageId)
  if (receipt === undefined || receipt?.source === "bot") return
  if (receipt === null) {
    const digest = "omitted:" + submissionDigest([source, messageId])
    const json = JSON.stringify({ phase: "rejected", images: [] })
    getDb().run("INSERT OR IGNORE INTO chat_image_messages VALUES (?, ?, ?, ?)", [target, messageId, digest, json])
    return
  }
  const refs = receipt.images
  if (refs.some(ref => !validId.test(ref.id))) throw new Error("图片引用无效")
  const root = scope(target)
  const sourceRoot = scope(source)
  // A startup sweep may run between the first copy and committing the fork's receipt.
  const release = refs.map(ref => holdImageFile(target, root, ref.id))
  try {
    if (refs.length) await mkdir(root, { recursive: true, mode: 0o700 })
    for (const ref of refs) {
      await copyFile(join(sourceRoot, ref.id + ".webp"), join(root, ref.id + ".webp"))
    }
    if (scope(target) !== root || scope(source) !== sourceRoot) throw new Error("分叉会话已变更")
    writeImageReceipt(target, messageId, "fork:" + submissionDigest([source, messageId, refs]), {
      preparedText: receipt.preparedText, images: refs
    })
  } finally {
    await Promise.all(release.map(finish => finish()))
  }
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
  const live = new Map(rows.map(([id, created, metadata]) => [imageDirectoryName(String(id), {
    created_at: Number(created), metadata: typeof metadata === "string" ? metadata : null
  }), String(id)] as const))
  for (const folder of folders) {
    const path = join(root, folder.name)
    if (!live.has(folder.name)) {
      await rm(path, { recursive: true, force: true })
      continue
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".webp") && validId.test(entry.name.slice(0, -5))) {
        const id = entry.name.slice(0, -5)
        await removeUnownedImage(live.get(folder.name)!, path, id)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".tmp") || !validId.test(entry.name.slice(0, -4))) continue
      const file = join(path, entry.name)
      const info = await stat(file).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > 60 * 60 * 1000) await rm(file, { force: true })
    }
  }
}
