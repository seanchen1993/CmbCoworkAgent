import { createHash } from "node:crypto"
import { BotError } from "../../shared/bots/contracts"
import type { BotWorkItem } from "../../shared/bots/work"
import {
  botWorkHistoryHref,
  type BotWorkHistoryEntry,
  type BotWorkHistoryInput,
  type BotWorkHistoryPort
} from "../../shared/bots/work-history"
import { getThreadCore, searchThreadMessages, getLegacyCheckpointMigrationStatus } from "../db"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { verifyWorkConversationThread } from "./conversation-link-authority"
import { createBotThreadReplyResolver } from "./thread-message-replies"
import type { LocalBotHost } from "./host"
import type { Message } from "../types"
import { isVisibleTranscriptMessage } from "../../shared/checkpoint-transcript"
import { cleanUserAttachmentContentForDisplay } from "../../shared/user-attachment-display"
import { projectCoordinatorTranscriptNoise } from "../../shared/internal-notification-turn"
import { parseBotMessageReply } from "../../shared/bots/message-reply"
import { createChatSearchPlan } from "../../shared/chat-search-plan"
import { projectChatSearchPlan } from "../../shared/chat-search-index"

const invalid = () => new BotError("CONFLICT", "历史来源已失效或不属于当前任务，请重新查询。")

/** Resolves only the current Host-owned local transcript. No checkpoint or filesystem scans. */
export function createLocalBotWorkHistory(getHost: () => LocalBotHost): BotWorkHistoryPort {
  function target(work: BotWorkItem) {
    const current = getHost().getWork(work.botId, work.id)
    const row = getThreadCore(current.threadId)
    if (
      !row ||
      (current.source && current.source.transport !== "im") ||
      (!current.source && current.audienceKey !== "desktop") ||
      current.audienceKey !== work.audienceKey ||
      current.threadId !== work.threadId
    )
      throw invalid()
    const metadata = JSON.parse(row.metadata || "{}")
    if (current.conversation) {
      if (current.conversation.state !== "bound") throw invalid()
      verifyWorkConversationThread(current, row, metadata)
    } else if (
      metadata.botId !== work.botId ||
      metadata.botWorkId !== work.id ||
      metadata.botHostId !== "local" ||
      metadata.botGroupId != null ||
      (metadata.botMockBindingId ?? null) !== (current.source?.bindingId ?? null) ||
      (current.source &&
        (metadata.botMockConversationId !== current.source.conversationId ||
          metadata.botMockGrantVersion !== current.source.grantVersion ||
          metadata.botAudienceKey !== current.audienceKey))
    )
      throw invalid()
    const incarnation = createHash("sha256")
      .update(JSON.stringify(captureThreadIncarnation(row)))
      .digest("hex")
    return { current, row, metadata, incarnation }
  }
  function body(message: Message, reply?: { id: string; ordinal: number; role: string }) {
    if (
      !["user", "assistant"].includes(message.role) ||
      !isVisibleTranscriptMessage(message.role, message.content)
    )
      return null
    let content =
      message.role === "user" && typeof message.content === "string"
        ? cleanUserAttachmentContentForDisplay(message.content)
        : message.content
    const parsed =
      message.role === "user" && reply && typeof content === "string"
        ? parseBotMessageReply(content)
        : null
    if (
      parsed &&
      parsed.reply.id === reply?.id &&
      parsed.reply.ordinal === reply.ordinal &&
      parsed.reply.role === reply.role
    )
      content = parsed.message
    const projection = projectCoordinatorTranscriptNoise(message.role, content, message.tool_calls)
    if (projection.hidden) return null
    const plan = createChatSearchPlan(
      message.role,
      projection.contentChanged ? projection.contentText : content,
      { stripThink: message.role === "assistant" }
    )
    const text = projectChatSearchPlan(plan)
      .map((segment) => segment.text)
      .join("\n")
      .trim()
    if (!text) return null
    return { text: text.slice(0, 6000), truncated: plan.truncated || text.length > 6000 }
  }
  function cursor(input: BotWorkHistoryInput, incarnation: string) {
    if (!input.cursor) return {}
    try {
      if (input.cursor.length > 2048) throw invalid()
      const [workId, query, stamp, ordinal, messageId] = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString()
      )
      if (
        workId !== input.workId ||
        query !== (input.query ?? null) ||
        stamp !== incarnation ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        typeof messageId !== "string" ||
        !messageId ||
        messageId.length > 512 ||
        input.messageId
      )
        throw invalid()
      return { beforeOrdinal: ordinal as number, beforeMessageId: messageId as string }
    } catch {
      throw invalid()
    }
  }
  return {
    async query(work, input) {
      const resolved = target(work)
      const before = cursor(input, resolved.incarnation)
      const resolver = createBotThreadReplyResolver(
        work.threadId,
        resolved.row,
        resolved.metadata,
        getHost()
      )
      const source = (messageId: string) => ({
        workId: work.id,
        messageId,
        incarnation: resolved.incarnation
      })
      let entries: BotWorkHistoryEntry[], scanned: number, truncated: boolean, more: boolean
      let nextOrdinal: number | null, nextMessageId: string | null
      let incomplete = getLegacyCheckpointMigrationStatus(work.threadId) === "migrating"
      if (input.query !== undefined) {
        if (!input.query.trim() || input.query.length > 256 || input.messageId)
          throw new BotError("INVALID_INPUT", "搜索条件无效")
        const page = searchThreadMessages(
          work.threadId,
          input.query,
          { ...before, limit: 12, bodyOnly: true },
          resolver
        )
        entries = page.matches
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            source: source(m.messageId),
            href: botWorkHistoryHref(source(m.messageId)),
            role: m.role as "user" | "assistant",
            createdAt: m.createdAt,
            ordinal: m.ordinal,
            text: m.preview,
            truncated: true
          }))
        scanned = page.scanned
        truncated = page.truncated
        more = page.hasMore
        nextOrdinal = page.beforeOrdinal
        nextMessageId = page.beforeMessageId
      } else {
        const options = {
          ...before,
          ...(input.messageId ? { targetMessageId: input.messageId } : {}),
          limit: 12,
          byteBudget: 96 * 1024
        }
        const page = await readThreadMessagesPageInWorker(work.threadId, options)
        // For an exact hit, include bounded following context as well as the backward window.
        const after = input.messageId
          ? await readThreadMessagesPageInWorker(work.threadId, {
              anchorMessageId: input.messageId,
              limit: 5,
              byteBudget: 64 * 1024
            })
          : null
        const rows = [
          ...new Map([...page.messages, ...(after?.messages ?? [])].map((m) => [m.id, m])).values()
        ]
        const replies = resolver?.(rows.filter((m) => m.role === "user").map((m) => m.id))
        const omitted = new Set([
          ...(page.truncatedMessageIds ?? []),
          ...(after?.truncatedMessageIds ?? [])
        ])
        entries = rows.flatMap((message) => {
          const projected = body(message, replies?.get(message.id))
          if (!projected) return []
          return [
            {
              source: source(message.id),
              href: botWorkHistoryHref(source(message.id)),
              role: message.role as "user" | "assistant",
              createdAt: new Date(message.created_at).getTime(),
              ordinal: message.ordinal!,
              ...projected,
              truncated: projected.truncated || omitted.has(message.id)
            }
          ]
        })
        if (input.messageId && !entries.some((entry) => entry.source.messageId === input.messageId))
          throw invalid()
        scanned = rows.length
        truncated = omitted.size > 0 || entries.some((e) => e.truncated)
        more = page.hasMore
        nextOrdinal = page.beforeOrdinal
        nextMessageId = page.beforeMessageId
        incomplete ||= Boolean(after?.hasMore)
      }
      if (target(work).incarnation !== resolved.incarnation) throw invalid()
      return {
        work: { id: work.id, title: work.title, goal: work.goal.slice(0, 2000) },
        entries,
        scanned,
        truncated,
        nextCursor:
          more && nextOrdinal !== null && nextMessageId
            ? Buffer.from(
                JSON.stringify([
                  work.id,
                  input.query ?? null,
                  resolved.incarnation,
                  nextOrdinal,
                  nextMessageId
                ])
              ).toString("base64url")
            : null,
        coverage: more ? "more" : truncated || incomplete ? "incomplete" : "exhausted"
      }
    },
    async resolve(work, source) {
      if (source.workId !== work.id || target(work).incarnation !== source.incarnation)
        throw invalid()
      const page = await this.query(work, { workId: work.id, messageId: source.messageId })
      if (target(work).incarnation !== source.incarnation) throw invalid()
      const entry = page.entries.find((e) => e.source.messageId === source.messageId)
      if (!entry) throw invalid()
      return { threadId: work.threadId, messageId: source.messageId, ordinal: entry.ordinal }
    }
  }
}
