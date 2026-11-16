import { createHash } from "node:crypto"
import { BotError } from "../../shared/bots/contracts"
import { botThreadHistoryHref, type BotOrdinaryThreadsPort, type BotOrdinaryThreadRef,
  type BotThreadSummary, type BotThreadHistoryPage } from "../../shared/bots/thread-history"
import { getThreadCore, getLegacyCheckpointMigrationStatus, searchThreadMessages, updateThread } from "../db"
import { requireThreadMutationLease, withThreadMutationLeaseLock } from "../ipc/thread-run-mutation-lock"
import { broadcastToRenderers } from "../agent/renderer-stream-mirror"
import { readThreadSummaryPageInWorker } from "../thread-metadata-hydration/client"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { isOrdinaryBotConversation } from "./ordinary-thread-policy"
import { localWorkConversationRef } from "./conversation-link-validation"
import { botHistoryMessageBody, hasUnmigratedConversationHistory } from "./work-history"
import { botHistoricalMessageReader, botHistoryHidesTitle, renamedBotHistoryTitleMetadata } from "./history-input-projection"
import type { LocalBotHost } from "./host"

const unavailable = () => new BotError("CONFLICT", "原会话已变化或不属于普通本机会话，请重新查询。")
function decodeCursor(cursor: string | undefined, scope: string): [number, string] | undefined {
  if (cursor === undefined) return undefined
  try {
    if (typeof cursor !== "string" || cursor.length > 2048) throw 0
    const [saved, ordinal, id] = JSON.parse(Buffer.from(cursor, "base64url").toString())
    if (saved !== scope || !Number.isSafeInteger(ordinal) || ordinal < 0 ||
        typeof id !== "string" || !id || id.length > 512) throw 0
    return [ordinal, id]
  } catch { throw new BotError("INVALID_INPUT", "历史分页已失效，请重新查询。") }
}
function encodeCursor(scope: string, ordinal: number | null, id: string | null, more: boolean) {
  return more && ordinal !== null && id
    ? Buffer.from(JSON.stringify([scope, ordinal, id])).toString("base64url") : null
}
function boundedText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BotError("INVALID_INPUT", "查询条件无效")
  return value.trim()
}
const stamp = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Bounded ordinary desktop history. This never links, creates or executes a task. */
export function createBotOrdinaryThreads(getHost: () => LocalBotHost): BotOrdinaryThreadsPort {
  function target(threadId: string, expected?: BotOrdinaryThreadRef, view: "model" | "native" = "model"): BotThreadSummary {
    const row = getThreadCore(threadId)
    if (!row || threadId === "heartbeat" || threadId.startsWith("heartbeat-") ||
        getHost().conversationLinks.forThread(threadId)) throw unavailable()
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(row.metadata || "{}")
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw 0
    } catch { throw unavailable() }
    if (!isOrdinaryBotConversation(metadata) || (expected && !matchesThreadIncarnation(row, expected.incarnation)))
      throw unavailable()
    return {
      conversation: { kind: "local_thread", threadId, incarnation: captureThreadIncarnation(row) },
      title: view === "model" && botHistoryHidesTitle(threadId, row) ? "原任务" : row.title || "未命名会话",
      workspacePath: typeof metadata.workspacePath === "string" ? metadata.workspacePath : null,
      updatedAt: Number(row.updated_at)
    }
  }
  return {
    async rename(input, commit) {
      const ref = localWorkConversationRef(input.conversation)
      const title = boundedText(input.title, 160)
      if (!title || typeof input.expectedTitle !== "string" || !input.expectedTitle || input.expectedTitle.length > 4096)
        throw new BotError("INVALID_INPUT", "会话名称无效")
      target(ref.threadId, ref, "native")
      const lease = requireThreadMutationLease(ref.threadId)
      return withThreadMutationLeaseLock(lease, row => {
        const current = target(ref.threadId, ref, "native")
        // The host rechecks the live caller and owns the durable operation receipt.
        // A replay never overwrites a later rename or starts a task.
        let written = false
        let receipt: BotThreadSummary
        try { receipt = commit(() => {
          if (current.title !== input.expectedTitle)
            throw new BotError("CONFLICT", botHistoryHidesTitle(ref.threadId, row)
              ? "无法用隐藏的历史标题确认会话，请在原工作台打开会话并改名。"
              : "会话名称已变化，请重新查询后再改名")
          if (current.title !== title) {
            const metadata = renamedBotHistoryTitleMetadata(row, title) ?? row.metadata
            if (!updateThread(ref.threadId, { title, metadata: JSON.stringify({ ...JSON.parse(metadata || "{}"), title }) }))
              throw unavailable()
            written = true
            broadcastToRenderers("threads:changed", undefined)
          }
          return target(ref.threadId, ref, "native")
        }) } catch (error) {
          if (written) throw new BotError("CONFLICT", "会话名称已写入，但操作回执未确认；请先查询当前名称，不要盲目重试。")
          throw error
        }
        const latest = target(ref.threadId, ref, "native")
        if (latest.title !== receipt.title)
          throw new BotError("CONFLICT", "原改名已处理，会话后来又被改名；不会覆盖后续修改")
        return latest
      })
    },
    async list(input) {
      const query = boundedText(input.query, 160), workspacePath = boundedText(input.workspacePath, 4096)
      const scope = stamp(["list", query ?? null, workspacePath ?? null])
      const cursor = decodeCursor(input.cursor, scope)
      const page = await readThreadSummaryPageInWorker({
        limit: 32, byteBudget: 128 * 1024,
        ...(cursor ? { beforeUpdatedAt: cursor[0], beforeThreadId: cursor[1] } : {})
      })
      const items: BotThreadSummary[] = []
      for (const entry of page.threads) {
        let thread: BotThreadSummary
        // Validate the authoritative row, not the renderer's reduced metadata projection.
        try { thread = target(entry.thread_id) } catch (error) {
          if (error instanceof BotError && error.code === "CONFLICT") continue
          throw error
        }
        if (query && !thread.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
        if (workspacePath && thread.workspacePath !== workspacePath) continue
        items.push(thread)
      }
      return { items, scanned: page.threads.length,
        nextCursor: encodeCursor(scope, page.beforeUpdatedAt, page.beforeThreadId, page.hasMore) }
    },
    async read(input) {
      const ref = localWorkConversationRef(input.conversation)
      const thread = target(ref.threadId, ref)
      const query = boundedText(input.query, 256), messageId = boundedText(input.messageId, 512)
      if (messageId && (query || input.cursor)) throw new BotError("INVALID_INPUT", "消息定位不能与搜索或分页混用")
      const scope = stamp(["read", ref, query ?? null]), cursor = decodeCursor(input.cursor, scope)
      const before = cursor ? { beforeOrdinal: cursor[0], beforeMessageId: cursor[1] } : {}
      const source = (id: string) => ({ conversation: ref, messageId: id })
      const row = getThreadCore(ref.threadId)
      if (!row || !matchesThreadIncarnation(row, ref.incarnation)) throw unavailable()
      const projections = (ids: readonly string[]) => getHost().ordinaryThreadInputProjections(ref.threadId, ids, row)
      const origins = botHistoricalMessageReader(ref.threadId, () => row)
      const replies = origins ? (ids: string[]) => new Map([...origins(ids)].flatMap(([id, origin]) =>
        origin.replyTo ? [[id, origin.replyTo] as const] : [])) : undefined
      let entries: BotThreadHistoryPage["entries"], scanned: number, truncated: boolean, more: boolean
      let ordinal: number | null, nextId: string | null
      const migrationStatus = getLegacyCheckpointMigrationStatus(ref.threadId)
      let incomplete = migrationStatus === "migrating"
      if (query) {
        const page = searchThreadMessages(ref.threadId, query, { ...before, limit: 12, bodyOnly: true }, replies, projections)
        entries = page.matches.filter(m => m.role === "user" || m.role === "assistant").map(m => ({
          source: source(m.messageId), href: botThreadHistoryHref(source(m.messageId)),
          role: m.role as "user" | "assistant", ordinal: m.ordinal, text: m.preview, truncated: true
        }))
        scanned = page.scanned; truncated = page.truncated; more = page.hasMore
        ordinal = page.beforeOrdinal; nextId = page.beforeMessageId
      } else {
        const page = await readThreadMessagesPageInWorker(ref.threadId, {
          ...before, ...(messageId ? { targetMessageId: messageId } : {}), limit: 12, byteBudget: 96 * 1024
        })
        const after = messageId ? await readThreadMessagesPageInWorker(ref.threadId, {
          anchorMessageId: messageId, limit: 5, byteBudget: 64 * 1024
        }) : null
        const rows = [...new Map([...page.messages, ...(after?.messages ?? [])].map(m => [m.id, m])).values()]
        const prepared = projections(rows.filter(m => m.role === "user").map(m => m.id))
        const replyOrigins = replies?.(rows.filter(m => m.role === "user").map(m => m.id))
        const omitted = new Set([...(page.truncatedMessageIds ?? []), ...(after?.truncatedMessageIds ?? [])])
        entries = rows.flatMap(message => {
          const accepted = message.role === "user" ? prepared.get(message.id) : undefined
          if (accepted === null || accepted === "") return []
          const body = botHistoryMessageBody(typeof accepted === "string" ? { ...message, content: accepted } : message,
            replyOrigins?.get(message.id))
          if (!body || !Number.isSafeInteger(message.ordinal)) return []
          return [{ source: source(message.id), href: botThreadHistoryHref(source(message.id)),
            role: message.role as "user" | "assistant", ordinal: message.ordinal!, ...body,
            truncated: body.truncated || omitted.has(message.id) }]
        })
        if (messageId && !entries.some(entry => entry.source.messageId === messageId)) throw unavailable()
        scanned = rows.length; truncated = omitted.size > 0 || entries.some(e => e.truncated)
        more = page.hasMore; ordinal = page.beforeOrdinal; nextId = page.beforeMessageId
        incomplete ||= Boolean(after?.hasMore)
      }
      if (!messageId && !more && !truncated && migrationStatus === null)
        incomplete = await hasUnmigratedConversationHistory(ref.threadId)
      target(ref.threadId, ref)
      return { thread, entries, scanned,
        coverage: more ? "more" : truncated || incomplete ? "incomplete" : "exhausted",
        nextCursor: encodeCursor(scope, ordinal, nextId, more) }
    },
    async resolve(source) {
      const page = await this.read({ conversation: source.conversation, messageId: source.messageId })
      const entry = page.entries.find(e => e.source.messageId === source.messageId)
      if (!entry) throw unavailable()
      return { threadId: page.thread.conversation.threadId, messageId: entry.source.messageId, ordinal: entry.ordinal }
    }
  }
}
