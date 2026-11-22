import { getDb, getThreadCore, getThreadMessageIdentityContext } from "../db"
import type { Message } from "../types"
import { getMessageProviderOccurrenceIdentity } from "../../shared/message-role-collision"
import { botHistoricalMessageReader } from "./history-input-projection"
import { isBotThreadMessageId, projectBotReplyInput, verifiedBotMessageReply, type BotHistoryInputOrigin } from "../../shared/bots/message-reply"

type Identity = Pick<Message, "id" | "role" | "provider_source_id" | "provider_occurrence">
type ReplyOrigin = NonNullable<BotHistoryInputOrigin["replyTo"]>

/** Model-only metadata; the ordinary transcript and renderer write protocol do not expose it. */
export function readForkInputProjections(threadId: string, ids: readonly string[]): Map<string, string | null> {
  const result = new Map<string, string | null>()
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    const rows = getDb().exec(`SELECT message_id, bot_input_projection FROM thread_messages
      WHERE thread_id=? AND role='user' AND message_id IN (${batch.map(() => "?").join(",")})
        AND bot_input_projection IS NOT NULL`, [threadId, ...batch])[0]?.values ?? []
    for (const [id, text] of rows) result.set(String(id), typeof text === "string" && text ? text : null)
  }
  return result
}

/** Static display identity of a copied quote. It grants no source navigation or execution authority. */
export function readForkReplyOrigins(threadId: string, ids: readonly string[]): Map<string, ReplyOrigin> {
  const result = new Map<string, ReplyOrigin>()
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    const rows = getDb().exec(`SELECT message_id, bot_fork_reply_origin FROM thread_messages
      WHERE thread_id=? AND role='user' AND message_id IN (${batch.map(() => "?").join(",")})
        AND bot_fork_reply_origin IS NOT NULL`, [threadId, ...batch])[0]?.values ?? []
    for (const [id, stored] of rows) {
      if (typeof stored !== "string") continue
      try {
        const reply = JSON.parse(stored) as ReplyOrigin
        if (isBotThreadMessageId(reply.id) && Number.isSafeInteger(reply.ordinal) && reply.ordinal >= 0 &&
            (reply.role === "user" || reply.role === "assistant")) result.set(String(id), reply)
      } catch { /* Legacy or invalid data cannot authorize a display projection. */ }
    }
  }
  return result
}

/** Called synchronously inside the existing cold Fork batch, after its transcript insert.
 * A failed copy is removed by the existing Fork rollback. Source and target retain their
 * ordinary visible text. Only exact user identities may carry a trusted admission forward.
 */
export function copyForkInputProjections(input: {
  sourceThreadId: string
  targetThreadId: string
  messages: readonly Identity[]
  persistedMessages: readonly Identity[]
  prepared: readonly (Identity & { text: string | null })[]
}): void {
  const inherited = readForkInputProjections(input.sourceThreadId,
    input.persistedMessages.filter(message => message.role === "user").map(message => message.id))
  const decisions = new Map<string, string | null>()
  for (const message of input.prepared) {
    if (message.role === "user") decisions.set(getMessageProviderOccurrenceIdentity(message), message.text)
  }
  // A second Fork must retain the already projected body rather than replace
  // it with the original checkpoint's reference-bearing admission string.
  for (const message of input.persistedMessages) {
    if (message.role === "user" && inherited.has(message.id))
      decisions.set(getMessageProviderOccurrenceIdentity(message), inherited.get(message.id)!)
  }
  const readOrigins = botHistoricalMessageReader(input.sourceThreadId, () => getThreadCore(input.sourceThreadId))
  const userMessages = input.messages.filter(message => message.role === "user")
  const userIds = userMessages.map(message => message.id)
  const origins = readOrigins?.(userIds)
  const forkReplies = readForkReplyOrigins(input.sourceThreadId, userIds)
  const replies = new Map(userMessages.flatMap(message => {
    const reply = origins?.get(message.id)?.replyTo ?? forkReplies.get(message.id)
    return reply ? [[getMessageProviderOccurrenceIdentity(message), reply] as const] : []
  }))
  if (!decisions.size && !replies.size) return
  const targets = getThreadMessageIdentityContext(input.targetThreadId,
    userMessages.map(message => ({
      messageId: message.id, role: message.role,
      providerSourceId: message.provider_source_id, providerOccurrence: message.provider_occurrence
    })), 1)
  for (const message of targets) {
    const identity = getMessageProviderOccurrenceIdentity(message)
    const reply = replies.get(identity)
    if (message.role !== "user" || (!decisions.has(identity) && !reply)) continue
    const admitted = decisions.has(identity) ? decisions.get(identity) : message.content
    const text = typeof admitted === "string" ? projectBotReplyInput(admitted, reply) : null
    // Bound this sparse private column even when a Hook returns an unusually large
    // string. Omit such model excerpts instead of falling back to unapproved raw text.
    const value = typeof text === "string" && Buffer.byteLength(text, "utf8") <= 64 * 1024 ? text : ""
    const display = typeof message.content === "string" && verifiedBotMessageReply(message.content, reply) && reply
      ? JSON.stringify({ id: reply.id, ordinal: reply.ordinal, role: reply.role }) : null
    if (value === message.content && !display) continue
    getDb().run(`UPDATE thread_messages SET bot_input_projection=?, bot_fork_reply_origin=?
      WHERE thread_id=? AND message_id=? AND role='user'`,
      [value === message.content ? null : value, display, input.targetThreadId, message.id])
  }
}
