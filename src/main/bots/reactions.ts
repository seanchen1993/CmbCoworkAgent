import {
  botReactionEmoji,
  botReactionState,
  type BotReactInput,
  type BotReactionState
} from "../../shared/bot-reactions"
import { SAND_REACTION_SELF } from "../../shared/upstream/grok-reactions"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import * as v from "./validation"

/** Reactions are presentation data. They never answer an approval, enqueue work or grant authority. */
export class BotReactions {
  constructor(
    private readonly store: BotStore,
    private readonly changed: (conversationId: string, state: BotReactionState) => void
  ) {}

  read(messageId: string): BotReactionState {
    const query = this.store.db.prepare(
      "SELECT revision,reactions FROM bot_message_reactions WHERE message_id=?",
      [v.identifier(messageId)]
    )
    try {
      if (!query.step()) return { messageId, revision: 0, reactions: [] }
      const row = query.getAsObject()
      return botReactionState.parse({
        messageId,
        revision: row.revision,
        reactions: JSON.parse(String(row.reactions))
      })
    } finally {
      query.free()
    }
  }

  readMany(input: { conversationId: string; messageIds: string[] }): BotReactionState[] {
    v.record(input)
    const conversationId = v.identifier(input.conversationId)
    const ids = v.uniqueIds(input.messageIds, 1, 200)
    this.store.getConversation(conversationId)
    const query = this.store.db.prepare(
      `SELECT m.id,COALESCE(r.revision,0) AS revision,COALESCE(r.reactions,'[]') AS reactions FROM bot_messages m LEFT JOIN bot_message_reactions r ON r.message_id=m.id WHERE m.conversation_id=? AND NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=m.id) AND m.id IN (${ids.map(() => "?").join(",")})`,
      [conversationId, ...ids]
    )
    try {
      const values = new Map<string, BotReactionState>()
      while (query.step()) {
        const row = query.getAsObject()
        const state = botReactionState.parse({
          messageId: row.id,
          revision: row.revision,
          reactions: JSON.parse(String(row.reactions))
        })
        values.set(state.messageId, state)
      }
      if (values.size !== ids.length)
        throw new BotDomainError("not_found", "消息不存在或不属于此对话")
      return ids.map((id) => values.get(id)!)
    } finally {
      query.free()
    }
  }

  private message(conversationId: string, messageId: string) {
    const query = this.store.db.prepare(
      "SELECT sender FROM bot_messages m WHERE conversation_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=m.id)",
      [conversationId, messageId]
    )
    try {
      if (!query.step()) throw new BotDomainError("not_found", "消息不存在或不属于此对话")
      return String(query.getAsObject().sender)
    } finally {
      query.free()
    }
  }

  setUser(input: BotReactInput): BotReactionState {
    v.record(input)
    const conversationId = v.identifier(input.conversationId),
      messageId = v.identifier(input.messageId)
    const emoji = botReactionEmoji.parse(input.emoji),
      active = v.boolean(input.active, "回应状态"),
      revision = v.integer(input.revision, "回应版本")
    return this.store.transaction(() => {
      this.store.getConversation(conversationId)
      if (this.message(conversationId, messageId) === "system")
        throw new Error("任务状态消息不支持表情回应")
      const current = this.read(messageId)
      const present = current.reactions.some(
        (reaction) => reaction.by === SAND_REACTION_SELF && reaction.emoji === emoji
      )
      if (current.revision === revision + 1 && present === active) return current
      if (current.revision !== revision)
        throw new BotDomainError("revision_conflict", "回应已变化，请刷新后重试")
      return this.set(conversationId, current, SAND_REACTION_SELF, emoji, active)
    })
  }

  setBot(
    lease: BotRunLease,
    input: { messageId: string; emoji: string; active: boolean },
    callId: string
  ): BotReactionState {
    const messageId = v.identifier(input.messageId),
      emoji = botReactionEmoji.parse(input.emoji),
      active = v.boolean(input.active, "回应状态")
    return this.store.toolOnce(lease, callId, { messageId, emoji, active }, () => {
      const run = this.store.getRun(lease.runId)
      if (this.message(run.conversationId, messageId) !== "user")
        throw new Error("Bot 只能回应当前对话中的用户消息")
      return this.set(run.conversationId, this.read(messageId), run.botId, emoji, active)
    })
  }

  private set(
    conversationId: string,
    current: BotReactionState,
    by: string,
    emoji: string,
    active: boolean
  ): BotReactionState {
    const exists = current.reactions.some(
      (reaction) => reaction.by === by && reaction.emoji === emoji
    )
    if (exists === active) return current
    const reactions = current.reactions.filter(
      (reaction) => reaction.by !== by || reaction.emoji !== emoji
    )
    if (active) reactions.push({ by, emoji })
    if (reactions.length > 100 || reactions.filter((reaction) => reaction.by === by).length > 20)
      throw new Error("此消息的表情回应已达上限")
    const next = { messageId: current.messageId, revision: current.revision + 1, reactions }
    this.store.db.run(
      "INSERT INTO bot_message_reactions VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision,reactions=excluded.reactions",
      [next.messageId, next.revision, JSON.stringify(reactions)]
    )
    this.changed(conversationId, next)
    return next
  }
}
