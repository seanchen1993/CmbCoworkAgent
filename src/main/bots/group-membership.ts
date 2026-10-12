import type { DatabaseSync } from "node:sqlite"

/** The caller owns the existing Store or restore transaction. Preserve direct
 * conversations and every historical sender; retire only deleted group members.
 * Keyset batches keep legacy repair bounded, and each changed group advances once. */
export function pruneDeletedBotGroupMembers(
  db: DatabaseSync,
  options: {
    botId?: string
    beforeChange?(conversationId: string): void
    afterChange?(conversationId: string): void
  } = {}
): number {
  const affected = db.prepare(
    `SELECT DISTINCT c.id FROM bot_conversations c
     JOIN bot_members m ON m.conversation_id=c.id JOIN bots b ON b.id=m.bot_id
     WHERE c.kind='group' AND b.deleted_at IS NOT NULL AND c.id>?` +
      (options.botId === undefined ? "" : " AND b.id=?") +
      " ORDER BY c.id LIMIT 128"
  )
  const remove = db.prepare(
    `DELETE FROM bot_members WHERE conversation_id=?
     AND bot_id IN (SELECT id FROM bots WHERE deleted_at IS NOT NULL)`
  )
  const advance = db.prepare("UPDATE bot_conversations SET revision=revision+1 WHERE id=?")
  let cursor = "",
    count = 0
  for (;;) {
    const groups =
      options.botId === undefined ? affected.all(cursor) : affected.all(cursor, options.botId)
    if (!groups.length) return count
    for (const row of groups) {
      const id = String(row.id)
      options.beforeChange?.(id)
      remove.run(id)
      advance.run(id)
      options.afterChange?.(id)
      count++
      cursor = id
    }
  }
}
