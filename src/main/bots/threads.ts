import { z } from "zod"
import type { BotStore } from "./store"
import type { NativeSqliteBindings } from "../db/native-sqlite-adapter"
import { BotDomainError } from "../../shared/bot-types"
import type { BotThread, BotThreadSummary } from "../../shared/bot-threads"
import * as v from "./validation"

/** Explicit scope metadata; reply_to also represents approvals and cannot identify a branch. */
export class BotThreads {
  constructor(private readonly store: BotStore) {}

  private rows(sql: string, parameters: NativeSqliteBindings = []): Record<string, unknown>[] {
    const statement = this.store.db.prepare(sql, parameters),
      result: Record<string, unknown>[] = []
    try {
      while (statement.step()) result.push(statement.getAsObject())
      return result
    } finally {
      statement.free()
    }
  }

  forMessage(id: string): string | undefined {
    const row = this.rows("SELECT root_id FROM bot_message_threads WHERE message_id=?", [id])[0]
    return row ? z.string().parse(row.root_id) : undefined
  }

  root(conversationId: string, rootId: string): { id: string; sequence: number } {
    v.identifier(conversationId)
    v.identifier(rootId)
    const row = this.rows(
      `SELECT id,sequence FROM bot_messages m WHERE conversation_id=? AND id=?
      AND sender IN ('user','bot') AND NOT EXISTS(SELECT 1 FROM bot_message_threads t WHERE t.message_id=m.id)`,
      [conversationId, rootId]
    )[0]
    if (!row) throw new BotDomainError("thread_unavailable", "分支起点不存在或不属于当前主对话")
    return z.object({ id: z.string(), sequence: z.number() }).parse(row)
  }

  /** Called inside the message/read-state transaction, including the first branch send. */
  ensure(conversationId: string, rootId: string): void {
    this.root(conversationId, rootId)
    this.store.db.run("INSERT OR IGNORE INTO bot_threads VALUES(?,?,?)", [
      rootId,
      conversationId,
      this.store.now()
    ])
  }

  bind(conversationId: string, messageId: string, rootId: string): void {
    this.ensure(conversationId, rootId)
    this.store.db.run("INSERT INTO bot_message_threads VALUES(?,?)", [messageId, rootId])
  }

  get(input: { conversationId: string; rootId: string }): BotThread {
    v.record(input)
    this.root(input.conversationId, input.rootId)
    const [summary] = this.summaries({
      conversationId: input.conversationId,
      rootIds: [input.rootId]
    })
    return {
      ...summary,
      conversationId: input.conversationId,
      root: this.store.message({ conversationId: input.conversationId, id: input.rootId })
    }
  }

  summaries(input: { conversationId: string; rootIds: string[] }): BotThreadSummary[] {
    v.record(input)
    const conversationId = v.identifier(input.conversationId),
      rootIds = v.uniqueIds(input.rootIds, 0, 200)
    this.store.getConversation(conversationId)
    if (!rootIds.length) return []
    const roots = new Map(
      this.rows(
        `SELECT m.id,b.root_id,(SELECT COUNT(*) FROM bot_message_threads t WHERE t.root_id=m.id) AS count
       FROM bot_messages m LEFT JOIN bot_threads b ON b.root_id=m.id
       WHERE m.conversation_id=? AND m.id IN (${rootIds.map(() => "?").join(",")})
       AND m.sender IN ('user','bot') AND NOT EXISTS(SELECT 1 FROM bot_message_threads t WHERE t.message_id=m.id)`,
        [conversationId, ...rootIds]
      ).map((row) => [String(row.id), row])
    )
    return rootIds.flatMap((rootId) => {
      const row = roots.get(rootId)
      if (!row) return []
      // Most main messages have no branch. Do not rescan the conversation for each empty root.
      const readState = row.root_id
        ? this.store.readStates.get(conversationId, rootId)
        : {
            revision: 0,
            lastReadSequence: 0,
            latestSequence: 0,
            unreadCount: 0,
            firstUnreadSequence: null,
            manuallyUnread: false
          }
      return [{ rootId, count: Number(row.count), readState }]
    })
  }

  unreadSummary(conversationId: string): {
    threadUnreadCount: number
    threadUnreadRootId?: string
  } {
    const row = this.rows(
      `WITH unread AS (SELECT b.root_id,b.created_at,MAX(COALESCE(s.manually_unread,0),(
          SELECT COUNT(*) FROM bot_message_threads t JOIN bot_messages m ON m.id=t.message_id
          WHERE t.root_id=b.root_id AND m.sender!='user' AND m.sequence>COALESCE(s.last_read_sequence,0)
        )) AS n FROM bot_threads b LEFT JOIN bot_thread_read_states s ON s.root_id=b.root_id WHERE b.conversation_id=?)
        SELECT COALESCE(SUM(n),0) AS n,(SELECT root_id FROM unread WHERE n>0 ORDER BY created_at,root_id LIMIT 1) AS root FROM unread`,
      [conversationId]
    )[0]
    return {
      threadUnreadCount: Number(row.n),
      ...(row.root ? { threadUnreadRootId: String(row.root) } : {})
    }
  }
}
