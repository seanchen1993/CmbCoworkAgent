import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  isGeneratedImageId,
  parseGeneratedImageReceipt,
  type GeneratedImageLookup,
  type GeneratedImageReceipt,
  type GeneratedImageVariant,
  type GeneratedThreadImageSource
} from "../shared/generated-image"
import { threadIncarnationKey } from "../shared/thread-incarnation"
import { normalizeGitWorkspacePathKey } from "../shared/workspace-path"
import { getCmbCoworkAgentDataRoot } from "./app-data-root"
import { getDb, getThreadCore } from "./db"
import { ImageGenerationError, getImageGenerationDeployment } from "./models/image-generation"
import { captureThreadIncarnation } from "./services/thread-incarnation"
import { openStableFileHandle, readStableFileHandleBounded } from "./services/stable-file-handle"
import { findBotWorkThreadOwner, isDesktopBotHome } from "./bots/conversation-link-authority"
import { verifiedWorkResultThread } from "./bots/work-result-thread"
import { hasOrdinaryBotConversationShape } from "./bots/ordinary-thread-policy"

export interface GeneratedImageContext {
  threadId: string
  userMessageId: string
  callId: string
  signal?: AbortSignal
  assertCurrent: () => void
  group?: { instanceKey: string; messageId: string }
  forkable?: boolean
}

interface ImageAction {
  action_id: string
  deployment_id: string
  public_message_id: string
  displayed_user_id?: string
  state: string
  width: number
  height: number
  image_sha: string
  preview_sha: string
}

const pending = new Map<string, Promise<GeneratedImageReceipt>>()
const previewRepairs = new Map<string, Promise<Buffer>>()
const MAX_BYTES = 12 * 1024 * 1024
const denied = () => new Error("生成图片所属会话或消息已变更")
const unknown = () => new Error("生图结果待确认，请勿重复提交")
const stopped = () => new Error("已停止等待生成结果")
const lost = () => new Error("生成图片结果无法取回")
const directory = () => join(getCmbCoworkAgentDataRoot(), "generated-images")
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")

function one<T>(sql: string, args: readonly unknown[]): T | undefined {
  const statement = getDb().prepare(sql)
  try {
    statement.bind(args)
    if (statement.step()) return statement.getAsObject() as T
    return undefined
  } finally {
    statement.free()
  }
}

function threadInstance(threadId: string) {
  const row = getThreadCore(threadId)
  if (!row) throw denied()
  const metadata = JSON.parse(row.metadata || "{}")
  return {
    token: threadIncarnationKey(captureThreadIncarnation(row)),
    workspace: normalizeGitWorkspacePathKey(metadata.workspacePath ?? "")
  }
}

function incarnation(threadId: string): string {
  return JSON.stringify(threadInstance(threadId))
}

function userExists(threadId: string, userId: string): boolean {
  return !!one("SELECT 1 FROM thread_messages WHERE thread_id=? AND message_id=? AND role='user'", [
    threadId,
    userId
  ])
}

function originUser(ctx: GeneratedImageContext, identity: string) {
  const grant = one<{ user_id: string; original_user_id: string; incarnation: string }>(
    `SELECT user_id,original_user_id,incarnation FROM generated_image_grants
     WHERE thread_id=? AND (user_id=? OR original_user_id=?) LIMIT 1`,
    [ctx.threadId, ctx.userMessageId, ctx.userMessageId]
  )
  if (
    grant &&
    (grant.incarnation !== identity ||
      (grant.user_id !== ctx.userMessageId && userExists(ctx.threadId, ctx.userMessageId)))
  )
    throw denied()
  return grant ?? { user_id: ctx.userMessageId, original_user_id: ctx.userMessageId }
}

function requireOrigin(context: GeneratedImageContext, identity: string) {
  if (context.signal?.aborted) throw stopped()
  context.assertCurrent()
  if (
    incarnation(context.threadId) !== identity ||
    !userExists(context.threadId, originUser(context, identity).user_id)
  )
    throw denied()
  if (!context.group) {
    const audience = assertDesktopThread(context.threadId)
    if (context.forkable && (audience !== "desktop" || findBotWorkThreadOwner(context.threadId)))
      throw denied()
  }
}

function receipt(row: ImageAction): GeneratedImageReceipt {
  const userMessageId = row.displayed_user_id ?? row.public_message_id
  return {
    kind: "generated-image",
    actionId: row.action_id,
    width: row.width,
    height: row.height,
    mimeType: "image/png",
    ...(userMessageId && { userMessageId })
  }
}

function action(id: string): ImageAction {
  const row = one<ImageAction>("SELECT * FROM generated_image_actions WHERE action_id=?", [id])
  if (!row) throw denied()
  return row
}

function requireCompleted(row: ImageAction) {
  if (row.state === "cancelled") throw stopped()
  if (row.state === "rejected") throw new Error("生图服务已拒绝此次请求")
  if (row.state === "unrecoverable") throw lost()
  if (row.state !== "ready" && row.state !== "received") throw unknown()
}

function mediaPath(id: string, variant: GeneratedImageVariant) {
  if (!isGeneratedImageId(id)) throw denied()
  return join(directory(), id + (variant === "original" ? ".png" : ".webp"))
}

async function checkedMediaDirectory(create = false) {
  const dataRoot = getCmbCoworkAgentDataRoot()
  const root = directory()
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const [base, actual, info] = await Promise.all([realpath(dataRoot), realpath(root), lstat(root)])
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    normalizeGitWorkspacePathKey(actual) !==
      normalizeGitWorkspacePathKey(join(base, "generated-images"))
  ) {
    throw new Error("生成图片私有目录无效")
  }
  return actual
}

async function writeMedia(id: string, variant: GeneratedImageVariant, bytes: Buffer) {
  const destination = mediaPath(id, variant)
  const temp = destination + ".tmp"
  await checkedMediaDirectory(true)
  const file = await open(temp, "wx", 0o600)
  try {
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await checkedMediaDirectory()
    await rename(temp, destination)
  } finally {
    await rm(temp, { force: true })
  }
}

async function readMedia(
  row: ImageAction,
  variant: GeneratedImageVariant,
  fromTemp = false
): Promise<Buffer> {
  const root = await checkedMediaDirectory()
  const opened = await openStableFileHandle(
    root,
    mediaPath(row.action_id, variant) + (fromTemp ? ".tmp" : "")
  )
  try {
    const bytes = await readStableFileHandleBounded(opened, MAX_BYTES)
    if (sha(bytes) !== (variant === "original" ? row.image_sha : row.preview_sha)) throw lost()
    return bytes
  } finally {
    await opened.handle.close()
  }
}

// If the app closed between installing the original file and acknowledging it, recover the
// checked local copy. The synchronous provider offers no remote lookup or safe replay.
async function completeLocal(row: ImageAction, assertCurrent: () => void) {
  requireCompleted(row)
  if (row.state === "received") {
    try {
      await readMedia(row, "original")
    } catch {
      try {
        await readMedia(row, "original", true)
        assertCurrent()
        const destination = mediaPath(row.action_id, "original")
        await rename(destination + ".tmp", destination)
      } catch {
        // Another reader can finish installing the same verified copy during this operation.
        try {
          await readMedia(row, "original")
        } catch {
          throw lost()
        }
      }
    }
    assertCurrent()
    getDb().run(
      "UPDATE generated_image_actions SET state='ready' WHERE action_id=? AND state='received'",
      [row.action_id]
    )
  }
  assertCurrent()
  requireCompleted(action(row.action_id))
  return receipt(row)
}

async function writeResult(
  ctx: GeneratedImageContext,
  identity: string,
  id: string,
  prompt: string,
  deployment: NonNullable<ReturnType<typeof getImageGenerationDeployment>>
) {
  const current = () => requireOrigin(ctx, identity)
  const db = getDb()
  const cancel = () =>
    db.run(
      "UPDATE generated_image_actions SET state='cancelled' WHERE action_id=? AND state IN ('submitted','received')",
      [id]
    )
  ctx.signal?.addEventListener("abort", cancel, { once: true })
  try {
    current()
    const result = await deployment.generate(prompt, ctx.signal)
    current()
    db.run(
      `UPDATE generated_image_actions SET state='received', request_id=?, width=?,height=?,
      image_sha=?,preview_sha=? WHERE action_id=? AND state='submitted'`,
      [result.requestId, result.width, result.height, sha(result.bytes), sha(result.preview), id]
    )
    if (!db.getRowsModified()) throw stopped()
    await writeMedia(id, "original", result.bytes)
    await writeMedia(id, "thumbnail", result.preview)
    current()
    db.run(
      "UPDATE generated_image_actions SET state='ready' WHERE action_id=? AND state='received'",
      [id]
    )
    if (!db.getRowsModified()) throw stopped()
    return receipt(action(id))
  } catch (error) {
    // A renderer cancellation or a revoked owner always wins over a late image.
    try {
      current()
    } catch (revoked) {
      cancel()
      throw revoked
    }
    if (error instanceof ImageGenerationError) {
      if (error.outcome === "not-submitted") {
        db.withImmediateWriteTransaction(() => {
          db.run("DELETE FROM generated_image_grants WHERE action_id=?", [id])
          db.run("DELETE FROM generated_image_actions WHERE action_id=?", [id])
        })
      } else {
        db.run(
          "UPDATE generated_image_actions SET state=? WHERE action_id=? AND state='submitted'",
          [error.outcome, id]
        )
      }
      throw error
    }
    if (action(id).state === "received") return completeLocal(action(id), current)
    throw unknown()
  } finally {
    ctx.signal?.removeEventListener("abort", cancel)
    if (readActionState(id) === "cancelled") await removeMedia(id)
  }
}

function readActionState(id: string): string | undefined {
  return one<{ state: string }>("SELECT state FROM generated_image_actions WHERE action_id=?", [id])
    ?.state
}

async function removeMedia(id: string) {
  try {
    await checkedMediaDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  for (const variant of ["original", "thumbnail"] as const) {
    const file = mediaPath(id, variant)
    await Promise.all([rm(file, { force: true }), rm(file + ".tmp", { force: true })])
  }
}

function actionKey(ctx: GeneratedImageContext, identity: string) {
  return sha(
    JSON.stringify(
      ctx.group
        ? ["group", ctx.group.instanceKey, ctx.group.messageId]
        : [
            "thread",
            ctx.threadId,
            threadInstance(ctx.threadId).token,
            originUser(ctx, identity).original_user_id
          ]
    )
  )
}

function ownedAction(ctx: GeneratedImageContext, identity: string) {
  const key = actionKey(ctx, identity)
  const row = one<ImageAction>("SELECT * FROM generated_image_actions WHERE scope_key=?", [key])
  if (!row) return
  const userId = originUser(ctx, identity).user_id
  if (
    !one(
      "SELECT 1 FROM generated_image_grants WHERE action_id=? AND thread_id=? AND incarnation=? AND user_id=?",
      [row.action_id, ctx.threadId, identity, userId]
    )
  )
    throw denied()
  if (!ctx.group) row.displayed_user_id = userId
  else if (!row.public_message_id) {
    // The private group grant and the original public action key were both checked above.
    getDb().run("UPDATE generated_image_actions SET public_message_id=? WHERE action_id=?", [
      ctx.group.messageId,
      row.action_id
    ])
    row.public_message_id = ctx.group.messageId
  }
  return row
}

/** Replaying the original group's delivery only recovers committed local bytes. */
export async function resumeGeneratedGroupImage(
  ctx: GeneratedImageContext
): Promise<GeneratedImageReceipt> {
  if (!ctx.group) throw denied()
  const identity = incarnation(ctx.threadId)
  const current = () => requireOrigin(ctx, identity)
  current()
  const row = ownedAction(ctx, identity)
  if (!row) throw new Error("没有可恢复的群生图记录")
  await loadMedia(row, "original", current)
  return receipt(row)
}

export async function runGeneratedImage(
  ctx: GeneratedImageContext,
  prompt: string
): Promise<GeneratedImageReceipt> {
  const identity = incarnation(ctx.threadId)
  const current = () => requireOrigin(ctx, identity)
  current()
  const db = getDb()
  const claim = db.withImmediateWriteTransaction(() => {
    const existing = ownedAction(ctx, identity)
    if (existing) return { row: existing }
    const deployment = getImageGenerationDeployment()
    if (!deployment) throw new Error("尚未配置生图服务")
    const id = randomUUID()
    db.run(
      `INSERT INTO generated_image_actions(action_id,scope_key,deployment_id,public_message_id,state)
      VALUES(?,?,?,?,'submitted')`,
      [id, actionKey(ctx, identity), deployment.id, ctx.group?.messageId ?? ctx.userMessageId]
    )
    const audience = ctx.group
      ? "group"
      : ctx.forkable
        ? "ordinary"
        : assertDesktopThread(ctx.threadId)
    db.run(
      `INSERT INTO generated_image_grants
      (thread_id,incarnation,action_id,user_id,original_user_id,call_id,audience) VALUES(?,?,?,?,?,?,?)`,
      [ctx.threadId, identity, id, ctx.userMessageId, ctx.userMessageId, ctx.callId, audience]
    )
    return { row: action(id), deployment }
  })
  const id = claim.row.action_id
  if (!claim.deployment) {
    const ongoing = pending.get(id)
    const result = ongoing ? await ongoing : await completeLocal(claim.row, current)
    current()
    db.run("INSERT OR IGNORE INTO generated_image_replay_calls VALUES(?,?)", [id, ctx.callId])
    return result
  }
  const task = writeResult(ctx, identity, id, prompt, claim.deployment)
  pending.set(id, task)
  try {
    return await task
  } finally {
    pending.delete(id)
  }
}

function assertDesktopThread(threadId: string) {
  const row = getThreadCore(threadId)
  if (!row) throw denied()
  const metadata = JSON.parse(row.metadata || "{}")
  const owner = findBotWorkThreadOwner(threadId)
  if (owner) {
    if (owner.source || owner.audienceKey !== "desktop" || owner.threadId !== threadId)
      throw denied()
    verifiedWorkResultThread(owner)
  } else if (!hasOrdinaryBotConversationShape(metadata)) {
    if (!isDesktopBotHome(threadId, metadata)) throw denied()
    return "home:" + metadata.botId
  }
  return "desktop"
}

// A call ID can recur in a later turn. Only the assistant rows after this user's message and
// before the next user message can present its receipt, including verified replay aliases.
const nextUserOrdinal = `COALESCE((SELECT MIN(other.ordinal) FROM thread_messages other
  WHERE other.thread_id=g.thread_id AND other.role='user' AND other.ordinal>u.ordinal),9223372036854775807)`
const transcriptImageCalls = `
  FROM generated_image_actions a JOIN generated_image_grants g USING(action_id)
  JOIN thread_messages u ON u.thread_id=g.thread_id AND u.message_id=g.user_id AND u.role='user'
  JOIN thread_messages m ON m.thread_id=g.thread_id AND m.role='assistant' AND m.ordinal>u.ordinal
  JOIN json_each(m.tool_calls_json) call
  WHERE g.thread_id=? AND g.incarnation=? AND g.audience IN ('desktop','ordinary',?)
    AND json_extract(call.value,'$.name')='generate_image'
    AND (json_extract(call.value,'$.id')=g.call_id OR EXISTS (SELECT 1 FROM generated_image_replay_calls alias
      WHERE alias.action_id=g.action_id AND alias.call_id=json_extract(call.value,'$.id')))
    AND m.ordinal < ${nextUserOrdinal}`

function readTranscriptAction(
  source: Omit<GeneratedThreadImageSource, "actionId">,
  selector: { actionId: string } | { callId: string }
): ImageAction | undefined {
  const audience = assertDesktopThread(source.threadId)
  const filter = "actionId" in selector ? "a.action_id=?" : "json_extract(call.value,'$.id')=?"
  return one<ImageAction>(
    `SELECT a.*,g.user_id AS displayed_user_id ${transcriptImageCalls}
    AND m.message_id=? AND ${filter}`,
    [
      source.threadId,
      incarnation(source.threadId),
      audience,
      source.messageId,
      "actionId" in selector ? selector.actionId : selector.callId
    ]
  )
}

export async function lookupGeneratedImage(
  source: GeneratedImageLookup,
  assertCurrent: () => void
) {
  assertCurrent()
  const row = readTranscriptAction(source, { callId: source.callId })
  if (!row || pending.has(row.action_id)) return null
  // On a graph retry several tool calls can survive with no ToolMessage. Restore the image
  // once at the first remaining assistant call in this user turn, even if its ID changed.
  const candidates =
    getDb().exec(
      `SELECT m.message_id, json_extract(call.value,'$.id'), (
    SELECT t.content_json FROM thread_messages t WHERE t.thread_id=g.thread_id AND t.role='tool'
      AND t.tool_call_id=json_extract(call.value,'$.id') AND t.ordinal>m.ordinal AND t.ordinal<${nextUserOrdinal}
      AND COALESCE(t.is_error,0)=0 AND length(t.content_json)<4096 ORDER BY t.ordinal LIMIT 1)
    ${transcriptImageCalls} AND g.action_id=? ORDER BY m.ordinal, call.key`,
      [
        source.threadId,
        incarnation(source.threadId),
        assertDesktopThread(source.threadId),
        row.action_id
      ]
    )[0]?.values ?? []
  const canonical =
    candidates.find(([, , stored]) => {
      if (typeof stored !== "string") return false
      try {
        return parseGeneratedImageReceipt(JSON.parse(stored))?.actionId === row.action_id
      } catch {
        return false
      }
    }) ?? candidates[0]
  if (canonical?.[0] !== source.messageId || canonical[1] !== source.callId) return null
  return completeLocal(row, () => {
    assertCurrent()
    if (readTranscriptAction(source, { callId: source.callId })?.action_id !== row.action_id)
      throw denied()
  })
}

async function rebuildPreview(row: ImageAction) {
  const original = await readMedia(row, "original")
  const { default: sharp } = await import("sharp")
  const bytes = await sharp(original, { limitInputPixels: 16_000_000 })
    .timeout({ seconds: 15 })
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer()
  requireCompleted(action(row.action_id))
  // A previous crash can leave a partial thumbnail. No other repair or generation owns it.
  await rm(mediaPath(row.action_id, "thumbnail") + ".tmp", { force: true })
  try {
    await writeMedia(row.action_id, "thumbnail", bytes)
    getDb().run(
      "UPDATE generated_image_actions SET preview_sha=? WHERE action_id=? AND state='ready'",
      [sha(bytes), row.action_id]
    )
    if (!getDb().getRowsModified()) await rm(mediaPath(row.action_id, "thumbnail"), { force: true })
  } catch {
    // The authorized in-memory preview remains usable if the disk is full.
  }
  return bytes
}

async function loadMedia(
  row: ImageAction,
  variant: GeneratedImageVariant,
  assertCurrent: () => void
) {
  await completeLocal(row, assertCurrent)
  let bytes: Buffer
  try {
    bytes = await readMedia(row, variant)
  } catch {
    if (variant === "original") throw lost()
    assertCurrent()
    const id = row.action_id
    if (!previewRepairs.has(id)) {
      previewRepairs.set(
        id,
        rebuildPreview(row).finally(() => previewRepairs.delete(id))
      )
    }
    bytes = await previewRepairs.get(id)!
  }
  assertCurrent()
  return { bytes, mimeType: variant === "original" ? "image/png" : "image/webp" }
}

export async function readGeneratedImage(
  source: GeneratedThreadImageSource,
  variant: GeneratedImageVariant,
  assertCurrent: () => void
) {
  const getCurrent = () => {
    assertCurrent()
    const row = readTranscriptAction(source, { actionId: source.actionId })
    if (!row) throw denied()
    return row
  }
  const media = await loadMedia(getCurrent(), variant, getCurrent)
  return { ...media, assertCurrent: () => requireCompleted(getCurrent()) }
}

export async function readGeneratedImageForDelivery(
  threadId: string,
  actionId: string,
  assertCurrent: () => void,
  userMessageId: string
) {
  const identity = incarnation(threadId)
  const getCurrent = () => {
    assertCurrent()
    if (
      incarnation(threadId) !== identity ||
      !one(
        `SELECT 1 FROM generated_image_grants g
      JOIN thread_messages u ON u.thread_id=g.thread_id AND u.message_id=g.user_id AND u.role='user'
      WHERE g.thread_id=? AND g.incarnation=? AND g.action_id=? AND (g.user_id=? OR g.original_user_id=?)
      AND g.audience='group'`,
        [threadId, identity, actionId, userMessageId, userMessageId]
      )
    )
      throw denied()
    return action(actionId)
  }
  const row = getCurrent()
  const { bytes } = await loadMedia(row, "original", getCurrent)
  return { bytes, name: "generated-" + actionId + ".png", receipt: receipt(row) }
}

export function copyGeneratedImageGrants(
  sourceId: string,
  targetId: string,
  messages: readonly {
    id: string
    role: string
    tool_calls?: ReadonlyArray<{ id: string; name: string }>
  }[]
) {
  if (
    !one(
      "SELECT 1 FROM generated_image_grants WHERE thread_id=? AND incarnation=? AND audience='ordinary'",
      [sourceId, incarnation(sourceId)]
    )
  )
    return
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const call of message.tool_calls ?? []) {
      if (call.name !== "generate_image") continue
      // Fork only a copied, live assistant call. The receiving thread must have copied its
      // originating user row too. Receiving a grant never authorizes another generation.
      const origin = readTranscriptAction(
        { threadId: sourceId, messageId: message.id },
        { callId: call.id }
      )
      if (!origin || origin.state !== "ready" || !userExists(targetId, origin.displayed_user_id!))
        continue
      getDb().run(
        `INSERT OR IGNORE INTO generated_image_grants
        (thread_id,incarnation,action_id,user_id,original_user_id,call_id,audience)
        SELECT ?,?,action_id,user_id,user_id,?,audience FROM generated_image_grants
        WHERE thread_id=? AND incarnation=? AND audience='ordinary' AND action_id=?`,
        [
          targetId,
          incarnation(targetId),
          call.id,
          sourceId,
          incarnation(sourceId),
          origin.action_id
        ]
      )
    }
  }
}

/** Keep the claim when a thread disappears, including group actions owned by a deleted worker. */
export async function sweepGeneratedImageStorage() {
  const db = getDb()
  for (const [id] of db.exec(
    "SELECT action_id FROM generated_image_actions WHERE state='cancelled'"
  )[0]?.values ?? []) {
    if (isGeneratedImageId(id) && !pending.has(id)) await removeMedia(id)
  }
  const orphanIds =
    db.exec(`SELECT a.action_id FROM generated_image_actions a
    WHERE a.state!='purged' AND NOT EXISTS
      (SELECT 1 FROM generated_image_grants g WHERE g.action_id=a.action_id)`)[0]?.values ?? []
  for (const [value] of orphanIds) {
    if (!isGeneratedImageId(value) || pending.has(value)) continue
    db.run(
      `UPDATE generated_image_actions SET state='revoked' WHERE action_id=? AND NOT EXISTS
      (SELECT 1 FROM generated_image_grants WHERE action_id=?)`,
      [value, value]
    )
    if (!db.getRowsModified()) continue
    await removeMedia(value)
    db.run(
      "UPDATE generated_image_actions SET state='purged' WHERE action_id=? AND state='revoked'",
      [value]
    )
    db.run("DELETE FROM generated_image_replay_calls WHERE action_id=?", [value])
  }
}
