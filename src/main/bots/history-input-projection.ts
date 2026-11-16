import type { BotWorkItem } from "../../shared/bots/work"
import { captureThreadIncarnation, matchesThreadIncarnation, type ThreadIncarnationRow } from "../services/thread-incarnation"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { BotTask } from "../../shared/bots/contracts"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, join, sep } from "node:path"
import { canonicalBotMessageInput } from "../../shared/bots/message-mentions"
import type { Message } from "../types"
import { verifyWorkDeletionThread } from "./conversation-link-authority"
import { parseBotMessageReply, type BotHistoryInputOrigin } from "../../shared/bots/message-reply"

export type BotHistoryOwner = Pick<BotWorkItem, "id" | "botId" | "threadId" | "source" | "audienceKey" | "conversation"> & {
  workspace?: { path: string }
  omitResultTitle?: true
  threadInitialized?: boolean
  title?: string
  titleExplicitlyRenamed?: true
}

type Projection = (ids: readonly string[], purpose?: "reply") => ReadonlyMap<string, string | null>
type HistorySource = {
  forkInputs?(threadId: string, ids: readonly string[]): ReadonlyMap<string, string | null>
  origins?(threadId: string, incarnation: ReturnType<typeof captureThreadIncarnation>, ids: readonly string[], row?: ThreadIncarnationRow): import("../../shared/bots/contracts").BotMessageOrigin[]
  legacyRequests?(threadId: string, owners: readonly BotHistoryOwner[], ids: readonly string[]): readonly string[]
  works(threadId: string): readonly BotHistoryOwner[]
  inputs(botId: string, threadId: string, ids: readonly string[], workIds?: readonly string[], purpose?: "reply"): ReadonlyMap<string, string | null>
}
let source: HistorySource | undefined

/** Only private user inputs use the existing Hook admission receipt. */
export function tracksBotInputPreparation(task: Pick<BotTask, "origin" | "mockSource">): boolean {
  const personal = task.mockSource?.transport === "im" && task.mockSource.personal === true
  return (!task.mockSource || personal) &&
    (task.origin.kind === "user" || task.origin.kind === "work" || (personal && task.origin.kind === "mock"))
}

/** Installed only by the existing Bot Host. This grants no execution or reading capability. */
export function setBotHistoryInputSource(value: HistorySource | undefined): void { source = value }

/** Reading ordinary history must not start the Bot Host or recover any tasks. */
export function botHistoricalMessageReader(threadId: string, readRow: () => ThreadIncarnationRow | null | undefined) {
  const history = source
  if (!history?.origins) return undefined
  // Indexed existence lookup first: ordinary chats never query per-message Bot origins.
  const owners = history.works(threadId)
  if (!owners.length) return undefined
  const row = readRow()
  if (!row || !matchingBotHistoryOwners({ ...history, works: () => owners }, threadId, row).length) return undefined
  const incarnation = captureThreadIncarnation(row)
  return (ids: readonly string[]) => {
    const origins = new Map<string, NonNullable<Message["botHistoryInputOrigin"]>>()
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const entry of history.origins!(threadId, incarnation, ids.slice(offset, offset + 100), row)) {
        const origin = entry.origin
        if (origin.kind === "user") origins.set(entry.requestId, {
          ...(origin.replyTo ? { replyTo: {
            id: origin.replyTo.id, ordinal: origin.replyTo.ordinal, role: origin.replyTo.role
          } } : {}),
          ...(origin.explicitSkill ? { explicitSkill: origin.explicitSkill } : {})
        })
      }
    }
    return origins
  }
}

export const BOT_FORK_DELIVERY_BOUNDARY = "cmb_bot_fork_delivery_boundary"

export function isInheritedLegacyDelivery(metadata: Record<string, unknown>, ordinal?: number): boolean {
  if (typeof metadata.forkedFromThreadId !== "string") return false
  const boundary = metadata[BOT_FORK_DELIVERY_BOUNDARY]
  return typeof boundary !== "number" || !Number.isSafeInteger(ordinal) || ordinal! < boundary
}

type DeliveryScope = NonNullable<Message["botHistoryDeliveryScope"]>
type HistoricalDeliveryAuthority = DeliveryScope & { legacyWorkspace?: string, metadata: Record<string, unknown> }

/** Scope for display and quotes. Opening a file still uses the exact receipt IPC. */
export function botHistoryDeliveryScope(
  threadId: string, readRow: () => ThreadIncarnationRow | null | undefined
): HistoricalDeliveryAuthority | undefined {
  const candidates = source?.works(threadId) ?? []
  const row = candidates.length ? readRow() : undefined
  if (!row) return
  try {
    const metadata = JSON.parse(row.metadata || "{}")
    const owners = candidates.filter(owner => {
      if (owner.threadId !== threadId || owner.source || owner.audienceKey !== "desktop") return false
      const link = owner.conversation
      if (link?.state === "detached") return link.ref.kind === "local_thread" &&
        link.ref.threadId === threadId && matchesThreadIncarnation(row, link.ref.incarnation)
      try { verifyWorkDeletionThread(owner, row, metadata); return true } catch { return false }
    })
    if (!owners.length) return
    // Unmarked receipts use the first matching owner, as in file preview and save.
    const workspace = owners[0].workspace?.path ?? metadata.workspacePath
    return {
      receiptThread: `thread-${createHash("sha256").update(JSON.stringify([threadId, captureThreadIncarnation(row)])).digest("hex")}`,
      workIds: owners.map(owner => owner.id),
      ...(typeof workspace === "string" && isAbsolute(workspace) ? { legacyWorkspace: workspace } : {}), metadata
    }
  } catch { return undefined }
}

export function deliveryScopeAtOrdinal(authority: HistoricalDeliveryAuthority, ordinal?: number,
  workspace = authority.legacyWorkspace): DeliveryScope {
  const { receiptThread, workIds, metadata } = authority
  return { receiptThread, workIds,
    ...(workspace && !isInheritedLegacyDelivery(metadata, ordinal)
      ? { legacySnapshotPrefix: join(workspace, ".bot-deliveries") + sep } : {}) }
}

/** Decorates a bounded UI page only. Original text and all execution paths stay unchanged. */
export async function decorateBotHistoryPage<T extends { messages: Message[] }>(
  threadId: string, page: T, readRow: () => ThreadIncarnationRow | null | undefined,
  readForkReplies?: (threadId: string, ids: readonly string[]) => ReadonlyMap<string, NonNullable<BotHistoryInputOrigin["replyTo"]>>
): Promise<T> {
  const ids = page.messages.filter(message => message.role === "user").map(message => message.id)
  const read = ids.length ? botHistoricalMessageReader(threadId, readRow) : undefined
  const origins = read?.(ids) ?? new Map<string, BotHistoryInputOrigin>()
  if (readForkReplies) {
    const forkIds = page.messages.flatMap(message => message.role === "user" && !origins.get(message.id)?.replyTo &&
      typeof message.content === "string" && parseBotMessageReply(message.content) ? [message.id] : [])
    if (forkIds.length) for (const [id, replyTo] of readForkReplies(threadId, forkIds))
      origins.set(id, { ...origins.get(id), replyTo })
  }
  const delivery = page.messages.some(message => message.role === "assistant" &&
    message.tool_calls?.some(call => call.name === "bot_deliver_files")) ? botHistoryDeliveryScope(threadId, readRow) : undefined
  if (!origins.size && !delivery) return page
  const workspace = delivery?.legacyWorkspace
  const canonical = workspace ? await realpath(workspace).catch(() => workspace) : undefined
  return { ...page, messages: page.messages.map(message => message.role === "user" && origins.has(message.id)
    ? { ...message, botHistoryInputOrigin: origins.get(message.id) }
    : delivery && message.role === "assistant" && message.tool_calls?.some(call => call.name === "bot_deliver_files")
      ? { ...message, botHistoryDeliveryScope: deliveryScopeAtOrdinal(delivery, message.ordinal, canonical) } : message) }
}

function matchingBotHistoryOwners(history: HistorySource, threadId: string, row: ThreadIncarnationRow) {
  return history.works(threadId).filter(work => {
    if (work.source || work.audienceKey !== "desktop" || work.threadId !== threadId) return false
    const link = work.conversation
    if (link) return link.ref.kind === "local_thread" && link.ref.threadId === threadId &&
      matchesThreadIncarnation(row, link.ref.incarnation)
    if (!work.threadInitialized) return false
    try { verifyWorkDeletionThread(work, row, JSON.parse(row.metadata || "{}")); return true } catch { return false }
  })
}

export function botLegacyHistoryRequests(
  threadId: string, row: ThreadIncarnationRow, ids: readonly string[]
): ReadonlySet<string> {
  if (!source || !ids.length) return new Set()
  const owners = matchingBotHistoryOwners(source, threadId, row)
  // A native work still under its original ownership has no ordinary prefix.
  if (owners.some(owner => threadId === `bot-work-${owner.id}` && (!owner.conversation ||
    (owner.conversation.origin === "created" && owner.conversation.state === "bound"))))
    return new Set(ids)
  // Linking a pre-existing conversation does not change its earlier inputs.
  return new Set(owners.length ? source.legacyRequests?.(threadId, owners, ids) : undefined)
}

const FORK_TITLE_PROJECTION = "cmb_bot_fork_title_hash"

/** Only the unchanged derived title is hidden; an explicit new title remains usable. */
export function protectedBotHistoryTitle(title: string | null): Record<string, string | null> {
  return { [FORK_TITLE_PROJECTION]: title === null ? null : createHash("sha256").update(title).digest("hex") }
}

/** A real ordinary rename supersedes its inherited title decision; a no-op does not. */
export function renamedBotHistoryTitleMetadata(
  row: { title?: string | null; metadata?: string | null }, title: unknown
): string | undefined {
  if (typeof title !== "string" || title === row.title) return undefined
  try {
    const metadata = JSON.parse(row.metadata || "{}")
    if (typeof metadata?.[FORK_TITLE_PROJECTION] !== "string") return undefined
    return JSON.stringify({ ...metadata, ...protectedBotHistoryTitle(null) })
  } catch { return undefined }
}

export function botHistoryHidesTitle(threadId: string, row: ThreadIncarnationRow & { title?: string | null }): boolean {
  if (typeof row.title === "string") {
    try {
      const saved = JSON.parse(row.metadata || "{}")?.[FORK_TITLE_PROJECTION]
      if (saved === null) return false // A successful explicit rename cleared this derived title.
      if (typeof saved === "string") return saved === protectedBotHistoryTitle(row.title)[FORK_TITLE_PROJECTION]
    } catch { /* Legacy malformed metadata does not introduce a title projection. */ }
  }
  if (!source) return false
  return source.works(threadId).some(owner => {
    if (!owner.omitResultTitle || owner.source || owner.audienceKey !== "desktop" || owner.threadId !== threadId)
      return false
    const link = owner.conversation
    if (link) {
      if (link.origin !== "created" || link.ref.kind !== "local_thread" || link.ref.threadId !== threadId ||
          !matchesThreadIncarnation(row, link.ref.incarnation)) return false
    } else {
      // A native task appears in the sidebar before its first detail view creates a link.
      if (!owner.threadInitialized) return false
      try { verifyWorkDeletionThread(owner, row, JSON.parse(row.metadata || "{}")) } catch { return false }
    }
    // Keep the old title protected if its explicit replacement has not reached native storage.
    if (typeof owner.title === "string" && typeof row.title === "string")
      return owner.titleExplicitlyRenamed ? row.title !== owner.title : row.title === owner.title
    return true // Legacy history has no trustworthy title version.
  })
}

/** Input decisions belong to the original thread incarnation even after unlink/mode changes. */
export function botHistoryInputProjection(
  threadId: string, row: ThreadIncarnationRow, current?: { botId: string; workId?: string }
): Projection | undefined {
  const history = source
  if (!history) return undefined
  const owners = matchingBotHistoryOwners(history, threadId, row)
  const workIds = new Map<string, Set<string>>()
  for (const owner of owners) {
    if (!workIds.has(owner.botId)) workIds.set(owner.botId, new Set())
    workIds.get(owner.botId)!.add(owner.id)
  }
  // Native Bot runs may have no association yet. They still own their exact transcript.
  if (current?.workId) {
    if (!workIds.has(current.botId)) workIds.set(current.botId, new Set())
    workIds.get(current.botId)!.add(current.workId)
  }
  if (!workIds.size && !current && !history.forkInputs) return undefined
  return (ids, purpose) => {
    const result = new Map<string, string | null>(history.forkInputs?.(threadId, ids))
    for (const [botId, workIdsForBot] of workIds)
      for (const [id, text] of history.inputs(botId, threadId, ids, [...workIdsForBot], purpose)) result.set(id, text)
    if (current && !current.workId)
      for (const [id, text] of history.inputs(current.botId, threadId, ids, undefined, purpose)) result.set(id, text)
    return result
  }
}

/** Called only after confirmed native deletion, inside the caller's Bot transaction. */
export function clearBotWorkInputHistory(
  db: NativeSqliteAdapter, owner: { botId: string; workId: string; threadId: string }, hasLegacyRequests = true
): void {
  const identity = [owner.botId, owner.workId, owner.threadId]
  const warm = db.prepare(`SELECT * FROM bot_tasks WHERE bot_id=? AND work_id=? AND thread_id=?
    AND state IN ('completed','failed','cancelled','interrupted','superseded','outcome_unknown')
    AND (mock_source_json IS NULL OR (json_extract(mock_source_json,'$.transport')='im'
      AND json_extract(mock_source_json,'$.personal')=1))
    AND json_extract(origin_json,'$.kind') IN ('user','work')`)
  try {
    warm.bind(identity)
    while (warm.step()) {
      const row = warm.getAsObject()
      const origin = JSON.parse(String(row.origin_json)) as BotTask["origin"]
      // Keep the original scope and hash before erasing text. A retry must never
      // recreate the deleted work, including a personal-IM continuation.
      db.run(`INSERT OR IGNORE INTO bot_task_receipts
        (request_id,bot_id,group_id,message_hash,finished_at,work_id,mock_source_json) VALUES (?,?,NULL,?,?,?,?)`,
        [row.request_id, row.bot_id, createHash("sha256").update(canonicalBotMessageInput(String(row.message),
          origin.kind === "user" ? origin.mentions : undefined,
          origin.kind === "user" ? origin.inputFileIds : undefined,
          origin.kind === "user" ? origin.explicitSkill : undefined)).digest("hex"), row.updated_at, row.work_id,
          row.mock_source_json])
      db.run(`UPDATE bot_tasks SET message='',prepared_input=NULL,input_preparation_required=0,error=NULL,
        origin_json=json_remove(origin_json,'$.replyTo','$.explicitSkill','$.mentions','$.inputFileIds','$.allowedInputFileIds')
        WHERE id=?`, [row.id])
    }
  } finally { warm.free() }
  db.run(`DELETE FROM bot_exchange_archive WHERE bot_id=? AND work_id=? AND thread_id=?
    AND json_extract(origin_json,'$.kind') IN ('user','work')`, identity)
  if (hasLegacyRequests) db.run("DELETE FROM bot_legacy_work_requests WHERE work_id=?", [owner.workId])
  // Create/send receipts contain a second copy of the dispatched input. Keep
  // their fingerprints and identities; do not alter main-chat publications.
  for (const path of ["$", "$.task"]) {
    db.run(`UPDATE bot_work_commands SET receipt=json_remove(
      json_set(receipt,'${path}.message','','${path}.error',NULL),
      '${path}.origin.replyTo','${path}.origin.explicitSkill','${path}.origin.mentions',
      '${path}.origin.inputFileIds','${path}.origin.allowedInputFileIds')
      WHERE json_extract(receipt,'${path}.botId')=? AND json_extract(receipt,'${path}.workId')=?
        AND json_extract(receipt,'${path}.threadId')=?
        AND json_extract(receipt,'${path}.origin.kind') IN ('user','work')`, identity)
  }
  for (const path of ["$", "$.work"]) {
    db.run(`UPDATE bot_work_commands SET receipt=json_set(receipt,'${path}.goal','')
      WHERE json_extract(receipt,'${path}.botId')=? AND json_extract(receipt,'${path}.id')=?
        AND json_extract(receipt,'${path}.threadId')=?`, identity)
    db.run(`UPDATE bot_work_commands SET receipt=json_set(receipt,'${path}.activity.preview','')
      WHERE json_extract(receipt,'${path}.botId')=? AND json_extract(receipt,'${path}.id')=?
        AND json_extract(receipt,'${path}.threadId')=?
        AND json_type(receipt,'${path}.activity')='object'`, identity)
  }
  // The aggregate clock may already belong to another work. Preserve that
  // preview and all read/attention versions when clearing this work's copy.
  db.run(`UPDATE bot_activity SET preview='' WHERE kind='work-bot' AND id=?
    AND version=(SELECT version FROM bot_activity WHERE kind='work' AND id=?)`,
    [owner.botId, owner.workId])
  db.run("UPDATE bot_activity SET preview='' WHERE kind='work' AND id=?", [owner.workId])
}

/** Run inside the existing post-commit native thread cleanup transaction. */
export function deleteBotThreadHistory(db: NativeSqliteAdapter, ids: readonly string[]): boolean {
  if (!ids.length) return false
  const hasLegacyRequests = Boolean(db.exec(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_legacy_work_requests'"
  )[0]?.values.length)
  const targets = ids.map(() => "?").join(",")
  const detached = `thread_id IN (${targets}) AND detached=1 AND json_extract(conversation_json,'$.state')='detached'
    AND NOT EXISTS (SELECT 1 FROM bot_work_commands d WHERE d.command_id='work-delete:'||bot_work_items.id)`
  const owners = db.prepare(`SELECT bot_id,id,thread_id FROM bot_thread_history_owners WHERE thread_id IN (${targets})
    UNION SELECT bot_id,id,thread_id FROM bot_work_items WHERE ${detached}`)
  let changed = false
  try {
    owners.bind([...ids, ...ids])
    while (owners.step()) {
      const row = owners.getAsObject()
      clearBotWorkInputHistory(db, { botId: String(row.bot_id), workId: String(row.id), threadId: String(row.thread_id) },
        hasLegacyRequests)
      changed = true
    }
  } finally { owners.free() }
  db.run(`DELETE FROM bot_thread_history_owners WHERE thread_id IN (${targets})`, ids)
  // A single-work delete still owns its row until the Host confirms physical cleanup.
  // Its exact input cleanup runs in advanceWorkDeletion("deleted") instead.
  db.run(`DELETE FROM bot_input_files WHERE (bot_id, json_extract(payload,'$.workId')) IN (
    SELECT bot_id,id FROM bot_work_items WHERE ${detached})`, ids)
  db.run(`DELETE FROM bot_work_items WHERE ${detached}`, ids)
  return db.getRowsModified() > 0 || changed
}
