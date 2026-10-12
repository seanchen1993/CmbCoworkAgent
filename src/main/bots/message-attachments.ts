import { BotDomainError } from "../../shared/bot-types"
import {
  botMessageAttachment,
  type BotMessageAttachment
} from "../../shared/bot-message-attachments"
import type { BotStore } from "./store"

type Projection = { ids: string[]; files: BotMessageAttachment[] }

/** One indexed metadata read per message page, never one artifact scan per row.
 * Only selected message links are projected; dead or cross-conversation objects
 * retain an unavailable reference without exposing their private metadata. */
export function attachmentsForMessages(
  store: BotStore,
  rows: Record<string, unknown>[]
): Map<string, Projection> {
  if (rows.length > 200) throw new BotDomainError("invalid_input", "附件投影超出消息分页范围")
  const messages = new Map(rows.map((row) => [String(row.id), String(row.conversation_id)]))
  const output = new Map<string, Projection>()
  if (!messages.size) return output
  const statement = store.db.prepare(
    `SELECT f.message_id,f.artifact_id,m.conversation_id AS message_conversation_id,
     a.id,a.conversation_id,a.run_id,a.name,a.mime,a.size,a.sha256,a.created_at,l.origin,l.deleted_at
     FROM bot_message_files f JOIN bot_messages m ON m.id=f.message_id
     LEFT JOIN bot_artifacts a ON a.id=f.artifact_id AND a.conversation_id=m.conversation_id
     LEFT JOIN bot_artifact_lifecycle l ON l.artifact_id=a.id
     WHERE f.message_id IN (${[...messages].map(() => "?").join(",")})
     ORDER BY f.message_id,f.rowid LIMIT 4001`,
    [...messages.keys()]
  )
  let count = 0
  try {
    while (statement.step()) {
      if (++count > 4000) throw new BotDomainError("invalid_input", "附件关联超出消息分页范围")
      const row = statement.getAsObject(),
        id = String(row.message_id)
      if (messages.get(id) !== row.message_conversation_id) continue
      const value = output.get(id) ?? { ids: [], files: [] }
      if (value.ids.length >= 20)
        throw new BotDomainError("invalid_input", "单条消息附件关联超出范围")
      value.ids.push(String(row.artifact_id))
      if (row.id != null && row.deleted_at == null) {
        const descriptor = botMessageAttachment.safeParse({
          id: row.id,
          conversationId: row.conversation_id,
          runId: row.run_id,
          name: row.name,
          mime: row.mime,
          size: row.size,
          sha256: row.sha256,
          createdAt: row.created_at,
          ...(row.origin == null ? {} : { origin: row.origin })
        })
        if (descriptor.success) value.files.push(descriptor.data)
      }
      output.set(id, value)
    }
  } finally {
    statement.free()
  }
  return output
}
