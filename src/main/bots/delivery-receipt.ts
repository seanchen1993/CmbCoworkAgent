import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { BotError } from "../../shared/bots/contracts"
import { parseBotFileDelivery, type BotDeliveredFile, type BotDeliveredFileSource } from "../../shared/bots/file-delivery"
import { getProjectThreadDataDirectorySync } from "../agent/context-history-path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { getDb, getThreadCore, getThreadMessagesAfterAnyId, getThreadMessagesByIds } from "../db"
import { imRemoteGrantStore } from "../services/im/remote-grant-store"
import type { StableFileHandle } from "../services/stable-file-handle"
import { matchesThreadIncarnation } from "../services/thread-incarnation"
import type { Message } from "../types"
import { botAttachmentReceiptKey, botSnapshotSourceRoot } from "./attachment-storage"
import { verifyWorkDeletionThread } from "./conversation-link-authority"
import { isInheritedLegacyDelivery, type BotHistoryOwner } from "./history-input-projection"
import type { LocalBotHost } from "./host"
import { isUnredirectedBotFileReference } from "./workspace-file"

const unavailable = () => new BotError("CONFLICT", "原交付附件已不可用，请查看原任务。")

type DeliveryReceiptIdentity = { receiptThread?: unknown; receiptWorkId?: unknown }
type DeliveryReceiptMetadata = DeliveryReceiptIdentity & {
  fileAliases?: unknown
  markdownSources?: unknown
}

export type BotDeliveryMarkdownSource = Omit<BotDeliveredFileSource, "threadId"> & { resultId: string }

export const isBotDeliveryMarkdown = (path: string) => /^\.(?:md|markdown|mdx)$/i.test(extname(path))

function readDeliverySnapshot(
  file: BotDeliveredFile | undefined, workspace: string | undefined,
  receiptKey: string, receipt: DeliveryReceiptIdentity
) {
  const path = file?.attachmentPath
  if (!file || !path || !isAbsolute(path) ||
      (file.attachmentRoot && (basename(file.attachmentRoot) !== receiptKey ||
        receipt.receiptThread !== receiptKey || typeof receipt.receiptWorkId !== "string")))
    throw unavailable()
  let root = botSnapshotSourceRoot(file, workspace)
  if (!file.attachmentRoot && !isWorkspaceFilePath(root, path)) {
    try { root = realpathSync(root) } catch { throw unavailable() }
  }
  const parts = relative(root, path).split(sep)
  if (parts.length !== 3 || parts[0] !== ".bot-deliveries" || !/^[a-f0-9]{64}$/.test(parts[1]))
    throw unavailable()
  return { root, path, digest: basename(dirname(path)), file }
}

function isWorkspaceFilePath(workspace: string, filePath: string): boolean {
  if (!isAbsolute(filePath)) return false
  const logicalPath = relative(workspace, filePath)
  return Boolean(logicalPath && logicalPath !== ".." && !logicalPath.startsWith(`..${sep}`) &&
    !isAbsolute(logicalPath))
}

/** Recover the storage key of a missing workspace from its deepest existing ancestor. */
function missingWorkspaceIdentity(workspace: string): string {
  const suffix: string[] = []
  let current = resolve(workspace)
  for (;;) {
    const parent = dirname(current)
    if (parent === current) throw unavailable()
    suffix.unshift(basename(current))
    current = parent
    try {
      return resolve(realpathSync(current), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

/** An unlinked thread may expose only its original delivery receipt. This
 * check does not authorize execution, deletion, or current workspace files. */
export function assertDetachedWorkDeliveryThread(
  work: BotHistoryOwner,
  row: NonNullable<ReturnType<typeof getThreadCore>>
): void {
  const link = work.conversation
  if (work.source || work.audienceKey !== "desktop" ||
      link?.state !== "detached" || link.ref.kind !== "local_thread" ||
      row.thread_id !== work.threadId || link.ref.threadId !== row.thread_id ||
      !matchesThreadIncarnation(row, link.ref.incarnation))
    throw unavailable()
}

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 1024 && !id.includes("\0")

export function parseBotDeliveredFileSource(value: unknown): BotDeliveredFileSource {
  const source = value as Partial<BotDeliveredFileSource> | undefined
  if (!validId(source?.threadId) || !validId(source.assistantMessageId) || !validId(source.callId) ||
      typeof source.fileIndex !== "number" || !Number.isSafeInteger(source.fileIndex) ||
      source.fileIndex < 0 || source.fileIndex >= 8)
    throw new BotError("INVALID_INPUT", "原交付附件标识无效。")
  return { threadId: source.threadId, assistantMessageId: source.assistantMessageId,
    callId: source.callId, fileIndex: source.fileIndex }
}

function readDeliveryBatch(threadId: string, assistantMessageId: string, callId: string) {
  const message = getThreadMessagesByIds(threadId, [assistantMessageId])[0]
  if (message?.role !== "assistant" || !message.tool_calls?.some(call =>
    call.id === callId && call.name === "bot_deliver_files")) throw unavailable()
  const results = getThreadMessagesAfterAnyId(threadId, [assistantMessageId], message.tool_calls.length)
  const matches: Message[] = []
  for (const result of results) {
    if (result.role !== "tool") break
    if (result.tool_call_id === callId) matches.push(result)
  }
  const [result] = matches
  if (matches.length !== 1 || !result || result.is_error || result.name !== "bot_deliver_files")
    throw unavailable()
  const files = parseBotFileDelivery(result.content)
  if (!files) throw unavailable()
  return { result, files, receipt: JSON.parse(result.content as string) as DeliveryReceiptMetadata }
}

function markdownSource(
  receipt: DeliveryReceiptMetadata,
  fileIndex: number,
  fileCount: number
): BotDeliveryMarkdownSource | undefined {
  const sources = receipt.markdownSources
  if (sources === undefined) return
  if (!sources || typeof sources !== "object" || Array.isArray(sources) ||
      Object.keys(sources).some(key => !/^[0-7]$/.test(key) || Number(key) >= fileCount))
    throw unavailable()
  if (!Object.hasOwn(sources, fileIndex)) return
  const source = (sources as Record<number, Partial<BotDeliveryMarkdownSource> | null>)[fileIndex]
  if (!validId(source?.assistantMessageId) || !validId(source.callId) || !validId(source.resultId) ||
      typeof source.fileIndex !== "number" || !Number.isInteger(source.fileIndex) ||
      source.fileIndex < 0 || source.fileIndex >= 8)
    throw unavailable()
  const { assistantMessageId, callId, resultId } = source
  return { assistantMessageId, callId, resultId, fileIndex: source.fileIndex }
}

function markdownImageIndex(
  { files, receipt }: ReturnType<typeof readDeliveryBatch>,
  workspace: string | undefined,
  filePath: string,
  allowCurrentAliases: boolean
): number | undefined {
  const matches = new Set<number>()
  files.forEach((file, index) => {
    if (isAbsolute(file.filePath) && relative(file.filePath, filePath) === "") matches.add(index)
  })
  if (workspace && receipt.fileAliases !== undefined) {
    if (!Array.isArray(receipt.fileAliases) || receipt.fileAliases.length > 8) throw unavailable()
    const requested = relative(workspace, filePath)
    for (const alias of receipt.fileAliases) {
      if (!Array.isArray(alias) || alias.length !== 2) throw unavailable()
      const [path, index] = alias
      if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") ||
          !Number.isInteger(index) || !files[index] || !isWorkspaceFilePath(workspace, files[index].filePath))
        throw unavailable()
      const absolute = resolve(workspace, path)
      if (!isWorkspaceFilePath(workspace, absolute) || relative(workspace, absolute) !== path)
        throw unavailable()
      if (path === requested) matches.add(index)
    }
  }
  // The current filesystem can identify an unrecorded spelling or link. It
  // may only select a file already in this batch, whose snapshot supplies the bytes.
  if (workspace && !matches.size && allowCurrentAliases) {
    const actual = realpathSync.native(filePath)
    const nativeWorkspace = realpathSync.native(workspace)
    if (!isWorkspaceFilePath(nativeWorkspace, actual)) throw unavailable()
    if (!lstatSync(actual).isFile()) throw unavailable()
    files.forEach((file, index) => {
      if (isWorkspaceFilePath(workspace, file.filePath) &&
          isUnredirectedBotFileReference(workspace, file.filePath, actual))
        matches.add(index)
    })
  }
  if (matches.size > 1) throw unavailable()
  return matches.values().next().value
}

/** The persisted assistant batch and its tool result choose the bytes, never a supplied path. */
export function readDesktopBotDelivery(
  host: Pick<LocalBotHost, "desktopDeliveryWorks">,
  { threadId, assistantMessageId, callId, fileIndex }: BotDeliveredFileSource,
  approvedRequestIds?: readonly string[]
) {
  const row = getThreadCore(threadId)
  if (!row) throw unavailable()
  const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>
  const batch = readDeliveryBatch(threadId, assistantMessageId, callId)
  const { result, files, receipt } = batch
  const file = files[fileIndex]
  if (!file?.attachmentPath || !isAbsolute(file.attachmentPath)) throw unavailable()
  const receiptKey = botAttachmentReceiptKey(threadId, row)
  if (receipt.receiptThread !== undefined && receipt.receiptThread !== receiptKey) throw unavailable()
  if (receipt.receiptThread === undefined && receipt.receiptWorkId === undefined &&
      isInheritedLegacyDelivery(metadata, result.ordinal)) throw unavailable()
  const owners = host.desktopDeliveryWorks(threadId)
  const owner = owners.find(work => {
    if (work.threadId !== threadId || (receipt.receiptWorkId !== undefined && receipt.receiptWorkId !== work.id))
      return false
    try {
      if (work.conversation?.state === "detached") assertDetachedWorkDeliveryThread(work, row)
      else verifyWorkDeletionThread(work, row, metadata)
      return true
    } catch {
      return false
    }
  })
  if (!owner) throw unavailable()
  const workspace = owner.workspace?.path ?? (typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined)
  const snapshot = readDeliverySnapshot(file, workspace, receiptKey, receipt)
  let markdownScope: { workspace: string; foreign: boolean; workspaceAvailable: boolean } | undefined
  const detached = owner.conversation?.state === "detached"
  const exactWorkReceipt = receipt.receiptWorkId === owner.id
  const exactReceipt = exactWorkReceipt && receipt.receiptThread === receiptKey
  const legacyReceipt = receipt.receiptWorkId === undefined && receipt.receiptThread === undefined &&
    !file.attachmentRoot && owners.length === 1
  const historicalReceipt = exactReceipt || (legacyReceipt && threadId === `bot-work-${owner.id}`)
  if (approvedRequestIds && (!historicalReceipt || !Number.isSafeInteger(result.ordinal) ||
      !getDb().exec(`SELECT 1 FROM thread_messages WHERE thread_id=? AND role='user'
        AND message_id IN (SELECT value FROM json_each(?)) AND ordinal>? LIMIT 1`,
        [threadId, JSON.stringify(approvedRequestIds), result.ordinal!])[0]?.values.length))
    throw unavailable()
  // Preserve the original preview of a native work's workspace snapshots. An
  // old receipt without an incarnation is usable only by the sole live owner
  // of the original generated work thread, whose metadata was checked above.
  const nativeOwner = !owner.conversation && metadata.botLocalConversation == null && historicalReceipt
  const canResolveMarkdown = detached
    ? historicalReceipt
    : (owner.conversation?.state === "bound" || nativeOwner) && (exactWorkReceipt || legacyReceipt)
  if (
    canResolveMarkdown &&
    workspace && isAbsolute(workspace) && isAbsolute(file.filePath) &&
    isBotDeliveryMarkdown(file.filePath) &&
    ["remoteState", "remoteReadOnly", "remoteThread", "remoteImContext", "imDeliveryContext", "targetKind"]
      .every(key => metadata[key] == null)
  ) {
    try {
      // A missing project can still identify its exact managed receipt by the saved path.
      let canonical: string
      let workspaceAvailable = true
      try {
        canonical = realpathSync(workspace)
      } catch (error) {
        const missingManaged = exactReceipt && file.attachmentRoot && (error as NodeJS.ErrnoException).code === "ENOENT"
        if (!detached && !missingManaged) throw error
        canonical = missingManaged ? missingWorkspaceIdentity(workspace) : resolve(workspace)
        workspaceAvailable = false
      }
      const originalRoot = file.attachmentRoot
        ? join(getProjectThreadDataDirectorySync(canonical, threadId, realpathSync(getCmbCoworkAgentDataRoot())),
            "attachments", receiptKey)
        : canonical
      if ((detached || imRemoteGrantStore.getThreadGrant(threadId)?.state !== "active") &&
          dirname(dirname(dirname(file.attachmentPath))) === originalRoot) {
        const localPath = isWorkspaceFilePath(canonical, file.filePath)
        // Forwarded files retain the peer's logical paths in the receiving work's
        // storage. Use those paths only to select exact batch snapshots.
        if (localPath || exactReceipt)
          markdownScope = { workspace: canonical, foreign: !localPath, workspaceAvailable }
      }
    } catch { /* The snapshot can still be previewed when the workspace is unavailable. */ }
  }
  const verified = { ...snapshot, receiptKey, workId: owner.id, resultId: result.id }
  if (!markdownScope) return { ...verified, markdownWorkspace: undefined }
  const { workspace: originalWorkspace, foreign, workspaceAvailable } = markdownScope
  const logicalWorkspace = foreign ? undefined : originalWorkspace
  // Persisted same-batch aliases do not require the original directory to exist.
  const aliasWorkspace = logicalWorkspace
  const allowMarkdownWorkspaceFallback = !detached && !foreign && workspaceAvailable
  const originalBatch = () => {
    const source = markdownSource(receipt, fileIndex, files.length)
    if (!source) return { batch, source: { assistantMessageId, callId, fileIndex, resultId: result.id } }
    if (!exactReceipt) throw unavailable()
    const origin = readDeliveryBatch(threadId, source.assistantMessageId, source.callId)
    if (origin.result.id !== source.resultId || !Number.isSafeInteger(origin.result.ordinal) ||
        !Number.isSafeInteger(result.ordinal) || origin.result.ordinal! >= result.ordinal! ||
        markdownSource(origin.receipt, source.fileIndex, origin.files.length))
      throw unavailable()
    const original = origin.files[source.fileIndex]
    const sameOwner = origin.receipt.receiptThread === receiptKey && origin.receipt.receiptWorkId === owner.id
    const nativeLegacy = origin.receipt.receiptThread === undefined && origin.receipt.receiptWorkId === undefined &&
      !original?.attachmentRoot && owners.length === 1 && threadId === `bot-work-${owner.id}` &&
      !isInheritedLegacyDelivery(metadata, origin.result.ordinal)
    if (!sameOwner && !nativeLegacy) throw unavailable()
    const saved = readDeliverySnapshot(original, workspace, receiptKey, origin.receipt)
    if (saved.path !== snapshot.path || saved.root !== snapshot.root ||
        saved.file.filePath !== file.filePath || saved.file.name !== file.name || saved.file.size !== file.size)
      throw unavailable()
    return { batch: origin, source }
  }
  return {
    ...verified, markdownWorkspace: originalWorkspace, allowMarkdownWorkspaceFallback,
    // Resolve once per operation. An invalid dependency does not revoke the user's
    // ability to read the Markdown bytes, but cannot authorize a workspace fallback.
    get markdownSource() { return originalBatch().source },
    markdownImageSnapshot(filePath: string) {
      if (!isAbsolute(filePath) || (logicalWorkspace && !isWorkspaceFilePath(logicalWorkspace, filePath))) return
      const { batch: original } = originalBatch()
      if (aliasWorkspace && original.receipt.fileAliases !== undefined &&
          (original.receipt.receiptThread !== receiptKey || original.receipt.receiptWorkId !== owner.id))
        throw unavailable()
      const index = markdownImageIndex(original, aliasWorkspace, filePath, allowMarkdownWorkspaceFallback)
      if (index === undefined) return
      const image = readDeliverySnapshot(original.files[index], workspace, receiptKey, original.receipt)
      if (image.root !== snapshot.root) throw unavailable()
      return image
    }
  }
}

/** Verify the exact open handle that will serve the Markdown image. */
export async function verifyDesktopBotDeliveryImage(
  opened: StableFileHandle,
  snapshot: ReturnType<typeof readDeliverySnapshot>,
  assertActive: () => void
): Promise<void> {
  if (opened.filePath !== snapshot.path || opened.size !== snapshot.file.size) throw unavailable()
  const digest = createHash("sha256")
  let bytes = 0
  for await (const chunk of opened.handle.createReadStream({ start: 0, end: opened.size, autoClose: false })) {
    assertActive()
    bytes += chunk.length
    digest.update(chunk)
  }
  await opened.assertPathIdentity()
  const after = await opened.handle.stat({ bigint: true })
  if (bytes !== opened.size || after.size !== opened.identity.size ||
      after.mtimeNs !== opened.identity.modifiedNs || after.ctimeNs !== opened.identity.changedNs ||
      digest.digest("hex") !== snapshot.digest)
    throw unavailable()
  assertActive()
}

type BotHistoricalDeliverySelection = { attachmentPath: string; filePath: string; source?: BotDeliveredFileSource }
export type BotHistoricalDeliveryReference = string | BotHistoricalDeliverySelection
export type BotHistoricalDeliveryUse = "deliver" | "upload"

const MAX_DELIVERY_CHOICES = 8

export class BotHistoricalDeliveryAmbiguity extends BotError {
  constructor(
    readonly choices: Array<{ selection: BotHistoricalDeliverySelection; deliveredAt: number }>,
    readonly more: boolean
  ) {
    super("CONFLICT", "此副本对应多条交付记录。请按原交付选择，不能用相同路径猜测版本。")
  }
}

export function isBotDeliverySnapshotPath(path: string, root: string): boolean {
  return isAbsolute(path) && dirname(dirname(path)) === join(root, ".bot-deliveries") &&
    /^[a-f0-9]{64}$/.test(basename(dirname(path)))
}

/** The stored tool result is a JSON string containing the tool's JSON object.
 * Only persisted user rows from the live run's approved inputs advance the
 * boundary; queued input or a later unrelated transcript row grants nothing. */
function deliveryReceiptCandidates(
  work: BotHistoryOwner, userMessageIds: readonly string[], receiptKey: string, attachmentPath: string,
  filePath: string | null, bytesOnly: boolean
) {
  const { threadId } = work
  const markdown = !bytesOnly && isBotDeliveryMarkdown(filePath ?? attachmentPath)
  const pathNeedle = JSON.stringify(`"attachmentPath":${JSON.stringify(attachmentPath)}`).slice(1, -1)
  // Collapse repeat sends by their flattened original receipt before applying
  // the limit. An original with no formal images has the same preview as other
  // image-free originals of the same Markdown bytes and logical path.
  const markdownCandidates = `, origins AS (
      SELECT matching.*, COALESCE(original.created_at, matching.created_at) AS delivered_at,
        COALESCE(original.ordinal, matching.ordinal) AS delivered_ordinal,
        CASE WHEN json_valid(original.content_json) THEN CASE WHEN json_valid(json_extract(original.content_json,'$'))
          THEN json_extract(original.content_json,'$') END END AS original_receipt
      FROM matching LEFT JOIN thread_messages AS original
        ON original.thread_id=? AND original.message_id=matching.origin_id
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY file_path,
        CASE WHEN json_type(original_receipt,'$.files')='array' AND
          json_type(original_receipt,'$.fileAliases') IS NULL AND NOT EXISTS (
          SELECT 1 FROM json_each(original_receipt,'$.files') AS sibling,
            json_each('[".png",".jpg",".jpeg",".gif",".webp",".bmp",".ico",".avif"]') AS extension
          WHERE lower(json_extract(original_receipt,sibling.fullkey||'.filePath')) GLOB '*' || extension.value
        ) THEN NULL ELSE json_array(origin_id,origin_index) END
        ORDER BY ordinal DESC,created_at DESC,message_id DESC) AS repeat_rank
      FROM origins
    )`
  const rows = getDb().exec(`WITH receipts AS (
      SELECT message_id, ordinal, created_at, tool_call_id,
        CASE WHEN json_valid(content_json) THEN CASE WHEN json_valid(json_extract(content_json,'$'))
          THEN json_extract(content_json,'$') END END AS receipt
      FROM thread_messages
      WHERE thread_id=? AND role='tool' AND name='bot_deliver_files' AND COALESCE(is_error,0)=0
        AND ordinal<(SELECT MAX(ordinal) FROM thread_messages WHERE thread_id=?
          AND message_id IN (SELECT value FROM json_each(?)) AND role='user')
        AND length(content_json)<=160000 AND instr(content_json,?)>0
    ), entries AS (
      SELECT message_id, ordinal, created_at, tool_call_id, file.key AS file_index,
        json_extract(receipt,file.fullkey||'.filePath') AS file_path
        ${markdown ? `, COALESCE(json_extract(receipt,'$.markdownSources."'||file.key||'".resultId'),message_id) AS origin_id,
        COALESCE(json_extract(receipt,'$.markdownSources."'||file.key||'".fileIndex'),file.key) AS origin_index` : ""}
      FROM receipts, json_each(receipt,'$.files') AS file
      WHERE json_extract(receipt,file.fullkey||'.attachmentPath')=?
        AND json_extract(receipt,'$.kind')='bot-file-delivery'
        AND json_type(receipt,'$.files')='array'
        AND ((json_extract(receipt,'$.receiptThread')=? AND json_extract(receipt,'$.receiptWorkId')=?)
          OR (? AND json_extract(receipt,'$.receiptThread') IS NULL
            AND json_extract(receipt,'$.receiptWorkId') IS NULL AND json_extract(receipt,file.fullkey||'.attachmentRoot') IS NULL))
    ), matching AS (
      SELECT * FROM entries WHERE (? IS NULL OR file_path=?)
    )${markdown ? markdownCandidates : ""}, candidates AS (
      ${markdown
        ? `SELECT * FROM ranked WHERE repeat_rank=1
          ORDER BY delivered_ordinal DESC,ordinal DESC,message_id DESC LIMIT ${MAX_DELIVERY_CHOICES + 1}`
        : `SELECT *, created_at AS delivered_at, ordinal AS delivered_ordinal FROM matching
          ORDER BY ordinal DESC,created_at DESC,message_id DESC LIMIT ${MAX_DELIVERY_CHOICES}`}
    ) SELECT message_id, tool_call_id, file_index, (
      SELECT message_id FROM thread_messages AS previous
      WHERE previous.thread_id=? AND previous.ordinal<candidates.ordinal AND previous.role!='tool'
      ORDER BY previous.ordinal DESC,previous.created_at DESC,previous.message_id DESC LIMIT 1
    ) AS assistant_id, delivered_at, CASE WHEN ? THEN EXISTS (
      SELECT 1 FROM entries AS other WHERE other.file_path<>candidates.file_path
    ) ELSE 0 END AS ambiguous
    FROM candidates ORDER BY delivered_ordinal DESC,ordinal DESC,created_at DESC,message_id DESC`,
    [threadId, threadId, JSON.stringify(userMessageIds), pathNeedle, attachmentPath, receiptKey, work.id,
      Number(threadId === `bot-work-${work.id}`), filePath, filePath, ...(markdown ? [threadId] : []), threadId,
      Number(filePath === null && !bytesOnly)])[0]?.values ?? []
  const candidates = rows.flatMap(([resultId, callId, fileIndex, assistantMessageId, deliveredAt, ambiguous]) =>
    typeof resultId === "string" && typeof callId === "string" && typeof assistantMessageId === "string" &&
    typeof fileIndex === "number" && Number.isSafeInteger(fileIndex) && fileIndex >= 0 && fileIndex < 8 &&
    typeof deliveredAt === "number"
      ? [{ resultId, callId, fileIndex, assistantMessageId, deliveredAt, ambiguous: Boolean(ambiguous) }] : [])
  return { candidates, more: markdown && rows.length > MAX_DELIVERY_CHOICES }
}

/** Reverse lookup only in the current work's transcript and attachment storage. */
export function findHistoricalBotWorkDelivery(
  work: BotHistoryOwner, requestIds: readonly string[], storageRoot: string, reference: BotHistoricalDeliveryReference,
  use: BotHistoricalDeliveryUse
) {
  const path = typeof reference === "string" ? reference : reference.attachmentPath
  const filePath = typeof reference === "string" ? null : reference.filePath
  if (!isBotDeliverySnapshotPath(path, storageRoot)) return undefined
  const { threadId } = work
  const row = getThreadCore(threadId)
  if (!row) return undefined
  const owner = { desktopDeliveryWorks: () => [work] }
  if (typeof reference !== "string" && reference.source) {
    const source = parseBotDeliveredFileSource(reference.source)
    if (source.threadId !== threadId) throw unavailable()
    const receipt = readDesktopBotDelivery(owner, source, requestIds)
    if (receipt.path !== path || receipt.root !== storageRoot || receipt.file.filePath !== filePath)
      throw unavailable()
    return { source, receipt }
  }
  const { candidates, more } = deliveryReceiptCandidates(
    work, requestIds, botAttachmentReceiptKey(threadId, row), path, filePath, use === "upload"
  )
  const markdown = use === "deliver" && isBotDeliveryMarkdown(filePath ?? path)
  const matches: Array<{ source: BotDeliveredFileSource; receipt: ReturnType<typeof readDesktopBotDelivery>;
    deliveredAt: number; ambiguous: boolean }> = []
  for (const { resultId, assistantMessageId, callId, fileIndex, deliveredAt, ambiguous } of candidates) {
    const source = { threadId, assistantMessageId, callId, fileIndex }
    let receipt: ReturnType<typeof readDesktopBotDelivery>
    try {
      receipt = readDesktopBotDelivery(owner, source)
    } catch (cause) {
      if (!(cause instanceof BotError) || cause.code !== "CONFLICT") throw cause
      continue
    }
    if (receipt.resultId !== resultId || receipt.path !== path || receipt.root !== storageRoot ||
        (filePath !== null && receipt.file.filePath !== filePath)) continue
    if (ambiguous && !markdown)
      throw new BotError("CONFLICT", "此副本对应多条交付记录。请同时提供原回执中的 attachmentPath 和 filePath。")
    if (!markdown) return { source, receipt }
    matches.push({ source, receipt, deliveredAt, ambiguous })
  }
  if (matches.length > 1 || matches[0]?.ambiguous || more) {
    const choices = matches.slice(0, MAX_DELIVERY_CHOICES).reverse().map(({ source, receipt, deliveredAt }) => {
      const original = "markdownSource" in receipt ? receipt.markdownSource : undefined
      return {
        selection: { attachmentPath: path, filePath: receipt.file.filePath,
          source: original
            ? { threadId, assistantMessageId: original.assistantMessageId, callId: original.callId,
                fileIndex: original.fileIndex }
            : source },
        deliveredAt
      }
    })
    throw new BotHistoricalDeliveryAmbiguity(choices, more)
  }
  if (matches[0]) return { source: matches[0].source, receipt: matches[0].receipt }
  return undefined
}

export function revalidateDesktopBotDelivery(
  host: Pick<LocalBotHost, "desktopDeliveryWorks">,
  source: BotDeliveredFileSource,
  previous: ReturnType<typeof readDesktopBotDelivery>
) {
  const current = readDesktopBotDelivery(host, source)
  if (current.receiptKey !== previous.receiptKey || current.root !== previous.root ||
      current.path !== previous.path || current.workId !== previous.workId || current.file.size !== previous.file.size ||
      current.file.filePath !== previous.file.filePath || current.file.name !== previous.file.name)
    throw unavailable()
  return current
}
