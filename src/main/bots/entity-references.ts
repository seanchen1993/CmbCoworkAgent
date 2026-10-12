import type { BotConnector } from "../../shared/bot-api"
import {
  botEntityCandidateRequest,
  botEntityReference,
  botEntityReferences,
  botEntitySelections,
  type BotEntityReference,
  type BotEntitySelection
} from "../../shared/bot-entity-references"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"

export function parseBotEntitySelections(value: unknown): BotEntitySelection[] {
  const parsed = botEntitySelections.safeParse(value)
  if (!parsed.success) throw new BotDomainError("invalid_input", "消息引用格式无效，请重新选择")
  return parsed.data
}

/** Account-local identity references. No conversation contents, routine prompts or secrets
 * are exported. A reference cannot add a group member or change a connector grant. */
export class BotEntityReferences {
  constructor(private readonly store: BotStore) {}

  /** Navigation metadata from the actual atomic creation, never model prose.
   * Existing event and entity-reference tables keep recovery and replay intact.
   * Deleted targets are omitted; no private data or capabilities are copied. */
  createdInRun(runId: string): BotEntityReference[] {
    return botEntityReferences.parse(
      this.rows(
        `SELECT DISTINCT b.id,b.name,c.id AS conversation_id FROM bot_events e
         JOIN bots b ON b.id=json_extract(e.payload,'$.botId') AND b.deleted_at IS NULL
         JOIN bot_conversations c ON c.id=json_extract(e.payload,'$.conversationId') AND c.kind='direct'
         JOIN bot_members m ON m.conversation_id=c.id AND m.bot_id=b.id
         WHERE e.entity_id=? AND e.kind='bot.created-from-task'
         ORDER BY b.id LIMIT 12`,
        [runId]
      ).map((row) => ({
        kind: "bot",
        id: row.id,
        name: row.name,
        conversationId: row.conversation_id
      }))
    )
  }

  private rows(sql: string, values: string[] = []): Record<string, unknown>[] {
    const query = this.store.db.prepare(sql, values)
    try {
      const rows: Record<string, unknown>[] = []
      while (query.step()) rows.push(query.getAsObject())
      return rows
    } finally {
      query.free()
    }
  }

  catalog(raw: unknown, connectors: readonly BotConnector[] = []): BotEntityReference[] {
    const input = botEntityCandidateRequest.parse(raw)
    this.store.getConversation(input.conversationId)
    const pattern = `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`
    const result: BotEntityReference[] = []
    if (!input.kind || input.kind === "bot")
      for (const row of this.rows(
        "SELECT b.id,b.name,c.id AS conversation_id FROM bots b JOIN bot_members m ON m.bot_id=b.id JOIN bot_conversations c ON c.id=m.conversation_id AND c.kind='direct' WHERE b.deleted_at IS NULL AND b.name LIKE ? ESCAPE '\\' ORDER BY b.name,b.id LIMIT 32",
        [pattern]
      ))
        result.push(
          botEntityReference.parse({
            kind: "bot",
            id: row.id,
            name: row.name,
            conversationId: row.conversation_id
          })
        )
    if (!input.kind || input.kind === "group")
      for (const row of this.rows(
        "SELECT id,name FROM bot_conversations WHERE kind='group' AND name LIKE ? ESCAPE '\\' ORDER BY name,id LIMIT 32",
        [pattern]
      ))
        result.push(
          botEntityReference.parse({
            kind: "group",
            id: row.id,
            name: row.name,
            conversationId: row.id
          })
        )
    if (!input.kind || input.kind === "routine")
      for (const row of this.rows(
        "SELECT r.id,r.name,r.bot_id FROM bot_routines r JOIN bots b ON b.id=r.bot_id WHERE b.deleted_at IS NULL AND r.name LIKE ? ESCAPE '\\' ORDER BY r.name,r.id LIMIT 32",
        [pattern]
      ))
        result.push(
          botEntityReference.parse({
            kind: "routine",
            id: row.id,
            name: row.name,
            botId: row.bot_id
          })
        )
    if (!input.kind || input.kind === "connector")
      for (const connector of connectors
        .filter((item) =>
          item.name.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase())
        )
        .slice(0, 32))
        result.push(
          botEntityReference.parse({
            kind: "connector",
            id: connector.id,
            name: connector.name.slice(0, 200)
          })
        )
    return result
  }

  resolve(
    selections: BotEntitySelection[],
    connectors: readonly BotConnector[]
  ): BotEntityReference[] {
    return selections.map((selection) => {
      let value: unknown
      if (selection.kind === "bot") {
        const row = this.rows(
          "SELECT b.id,b.name,c.id AS conversation_id FROM bots b JOIN bot_members m ON m.bot_id=b.id JOIN bot_conversations c ON c.id=m.conversation_id AND c.kind='direct' WHERE b.id=? AND b.deleted_at IS NULL",
          [selection.id]
        )[0]
        if (row) value = { ...selection, name: row.name, conversationId: row.conversation_id }
      } else if (selection.kind === "group") {
        const row = this.rows("SELECT name FROM bot_conversations WHERE id=? AND kind='group'", [
          selection.id
        ])[0]
        if (row) value = { ...selection, name: row.name, conversationId: selection.id }
      } else if (selection.kind === "routine") {
        const row = this.rows(
          "SELECT r.name,r.bot_id FROM bot_routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.deleted_at IS NULL",
          [selection.id]
        )[0]
        if (row) value = { ...selection, name: row.name, botId: row.bot_id }
      } else {
        const connector = connectors.find((item) => item.id === selection.id)
        if (connector) value = { ...selection, name: connector.name.slice(0, 200) }
      }
      if (!value)
        throw new BotDomainError("reference_unavailable", "引用的对象已不可用，请移除后重新选择")
      return botEntityReference.parse(value)
    })
  }

  save(messageId: string, references: BotEntityReference[]): void {
    if (references.length)
      this.store.db.run("INSERT INTO bot_message_entities VALUES(?,?)", [
        messageId,
        JSON.stringify(references)
      ])
  }

  forMessage(messageId: string): BotEntityReference[] {
    const row = this.rows("SELECT refs FROM bot_message_entities WHERE message_id=?", [
      messageId
    ])[0]
    return row ? botEntityReferences.parse(JSON.parse(String(row.refs))) : []
  }
}
