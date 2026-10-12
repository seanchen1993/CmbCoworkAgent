import { z } from "zod"
import type { BotStore } from "./store"
import { BotDomainError, type BotReadInput, type BotReadState } from "../../shared/bot-types"
import * as v from "./validation"

/** Reading a message and deliberately leaving a reminder are independent state. */
export class BotReadStates {
  constructor(private readonly store: BotStore) {}

  get(conversationId: string, threadRootId?: string): BotReadState {
    if (threadRootId !== undefined) this.store.threads.root(conversationId, threadRootId)
    const table = threadRootId ? "bot_thread_read_states" : "bot_read_states"
    const key = threadRootId ? "root_id" : "conversation_id"
    const row = this.store.db.prepare(
      `WITH scoped_messages AS (
        ${
          threadRootId
            ? "SELECT m.sequence,m.sender FROM bot_message_threads t JOIN bot_messages m ON m.id=t.message_id WHERE m.conversation_id=? AND t.root_id=?"
            : "SELECT m.sequence,m.sender FROM bot_messages m LEFT JOIN bot_message_threads t ON t.message_id=m.id WHERE m.conversation_id=? AND NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=m.id) AND COALESCE(t.root_id,'')=?"
        }
      ) SELECT
      COALESCE(s.revision,0) AS revision, COALESCE(s.last_read_sequence,0) AS lastReadSequence,
      COALESCE(s.manually_unread,0) AS manual,
      (SELECT COALESCE(MAX(sequence),0) FROM scoped_messages) AS latestSequence,
      (SELECT COUNT(*) FROM scoped_messages WHERE sender!='user' AND sequence>COALESCE(s.last_read_sequence,0)) AS unreadCount,
      (SELECT MIN(sequence) FROM scoped_messages WHERE sender!='user' AND sequence>COALESCE(s.last_read_sequence,0)) AS firstUnreadSequence,
      (SELECT MAX(sequence) FROM scoped_messages WHERE sender!='user') AS lastIncoming
      FROM bot_conversations c LEFT JOIN ${table} s ON s.${key}=? WHERE c.id=?`,
      [
        v.identifier(conversationId),
        threadRootId ?? "",
        threadRootId ?? conversationId,
        conversationId
      ]
    )
    try {
      if (!row.step()) throw new BotDomainError("not_found", "对话不存在")
      const result = z
        .object({
          revision: z.number(),
          lastReadSequence: z.number(),
          manual: z.number(),
          latestSequence: z.number(),
          unreadCount: z.number(),
          firstUnreadSequence: z.number().nullable(),
          lastIncoming: z.number().nullable()
        })
        .parse(row.getAsObject())
      return {
        revision: result.revision,
        lastReadSequence: result.lastReadSequence,
        manuallyUnread: result.manual === 1,
        latestSequence: result.latestSequence,
        unreadCount: Math.max(result.unreadCount, result.manual),
        firstUnreadSequence:
          result.firstUnreadSequence ??
          (result.manual ? (result.lastIncoming ?? (result.latestSequence || null)) : null)
      }
    } finally {
      row.free()
    }
  }

  set(input: BotReadInput, changed: (state: BotReadState) => void): BotReadState {
    v.record(input)
    const id = v.identifier(input.conversationId),
      threadRootId =
        input.threadRootId === undefined ? undefined : v.identifier(input.threadRootId),
      revision = v.integer(input.revision, "读取版本"),
      through = v.integer(input.throughSequence, "读取位置"),
      unread = v.boolean(input.unread, "未读标记")
    return this.store.transaction(() => {
      const current = this.get(id, threadRootId)
      if (revision !== current.revision)
        throw new BotDomainError("revision_conflict", "读取位置已变化，请刷新后重试")
      if (through > current.latestSequence)
        throw new BotDomainError("invalid_input", "不能标记尚不存在的消息为已读")
      if (through) {
        const message = this.store.db.prepare(
          "SELECT m.id FROM bot_messages m LEFT JOIN bot_message_threads t ON t.message_id=m.id WHERE m.conversation_id=? AND m.sequence=? AND NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=m.id) AND COALESCE(t.root_id,'')=?",
          [id, through, threadRootId ?? ""]
        )
        try {
          if (!message.step()) throw new BotDomainError("invalid_input", "读取位置不属于当前对话")
        } finally {
          message.free()
        }
      }
      const next = unread ? current.lastReadSequence : Math.max(current.lastReadSequence, through)
      if (next === current.lastReadSequence && unread === current.manuallyUnread) return current
      if (threadRootId) this.store.threads.ensure(id, threadRootId)
      const table = threadRootId ? "bot_thread_read_states" : "bot_read_states"
      const key = threadRootId ? "root_id" : "conversation_id"
      this.store.db.run(
        `INSERT INTO ${table} VALUES(?,?,?,?) ON CONFLICT(${key})
        DO UPDATE SET last_read_sequence=excluded.last_read_sequence,manually_unread=excluded.manually_unread,revision=excluded.revision`,
        [threadRootId ?? id, next, unread, revision + 1]
      )
      const result = this.get(id, threadRootId)
      changed(result)
      return result
    })
  }
}
