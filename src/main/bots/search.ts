import { botEntityReferences } from "../../shared/bot-entity-references"
import { createHash } from "node:crypto"
import { z } from "zod"
import { botSearchInput, type BotSearchInput, type BotSearchPage } from "../../shared/bot-search"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"
import * as v from "./validation"
import { buildContentSnippet } from "./upstream/grok-content-search"

// Same bounded scan pattern as Cmb searchThreadMessages: yield the Host every page.
const SCAN_ROWS = 32,
  SCAN_BYTES = 512 * 1024
const cursorSchema = z
  .object({
    version: z.literal(1),
    before: z.number().int().positive(),
    key: z.string().length(64)
  })
  .strict()
const rowSchema = z.object({
  row_id: z.number().int().positive(),
  id: z.string(),
  conversation_id: z.string(),
  conversation_name: z.string(),
  bot_id: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  entity_refs: z.string().nullable().optional(),
  created_at: z.number()
})
const visible =
  "EXISTS(SELECT 1 FROM bot_members visible_member JOIN bots visible_bot ON visible_bot.id=visible_member.bot_id WHERE visible_member.conversation_id=c.id AND visible_bot.deleted_at IS NULL)"

function queryFor(kind: BotSearchInput["kind"]): {
  from: string
  projection: string
  where: string
} {
  switch (kind) {
    case "message":
      return {
        from: "bot_messages e JOIN bot_conversations c ON c.id=e.conversation_id LEFT JOIN bot_message_entities refs ON refs.message_id=e.id",
        projection: "e.bot_id AS bot_id,c.name AS title,e.text AS content,refs.refs AS entity_refs",
        where: "NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=e.id)"
      }
    case "link":
      return {
        from: "bot_messages e JOIN bot_conversations c ON c.id=e.conversation_id",
        projection: "e.bot_id AS bot_id,c.name AS title,e.text AS content",
        where: "NOT EXISTS(SELECT 1 FROM bot_introduction_cues hidden WHERE hidden.message_id=e.id)"
      }
    case "file":
      return {
        from: "bot_artifacts e JOIN bot_conversations c ON c.id=e.conversation_id",
        projection: "NULL AS bot_id,e.name AS title,e.name || ' ' || e.mime AS content",
        where: "1=1"
      }
    case "group":
      return {
        from: "bot_conversations e JOIN bot_conversations c ON c.id=e.id LEFT JOIN bot_group_profiles g ON g.conversation_id=e.id",
        projection:
          "NULL AS bot_id,e.name AS title,e.name || ' ' || COALESCE(g.description,'') AS content",
        where: "c.kind='group'"
      }
    case "bot":
      return {
        from: "bots e JOIN bot_members member ON member.bot_id=e.id JOIN bot_conversations c ON c.id=member.conversation_id",
        projection: "e.id AS bot_id,e.name AS title,e.name || ' ' || e.instructions AS content",
        where: "e.deleted_at IS NULL AND c.kind='direct'"
      }
    case "routine":
      return {
        from: "bot_routines e JOIN bots b ON b.id=e.bot_id JOIN bot_members member ON member.bot_id=b.id JOIN bot_conversations c ON c.id=member.conversation_id",
        projection: "e.bot_id AS bot_id,e.name AS title,e.name || ' ' || e.prompt AS content",
        where: "b.deleted_at IS NULL AND c.kind='direct'"
      }
  }
}

/** Search only user-visible domain records; model configuration, effects and credentials are absent. */
export class BotSearch {
  constructor(private readonly store: BotStore) {}
  search(raw: BotSearchInput): BotSearchPage {
    const input = botSearchInput.parse(raw)
    const conversationId =
      input.conversationId === undefined ? null : v.identifier(input.conversationId)
    if (conversationId) {
      const conversation = this.store.getConversation(conversationId)
      if (!conversation.members.some((id) => this.store.getBot(id, true).deletedAt === null))
        throw new BotDomainError("not_found", "对话已不可用")
    }
    const needle = input.query.replace(/\s+/gu, " ").toLowerCase()
    const key = createHash("sha256")
      .update(JSON.stringify([needle, input.kind, conversationId]))
      .digest("hex")
    let before = Number.MAX_SAFE_INTEGER
    if (input.cursor) {
      try {
        const cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))
        )
        if (cursor.key !== key) throw new Error("scope")
        before = cursor.before
      } catch {
        throw new BotDomainError("search_cursor", "搜索条件已变化，请重新搜索")
      }
    }
    const query = queryFor(input.kind)
    const stmt = this.store.db.prepare(
      `SELECT e.rowid AS row_id,e.id,e.created_at,c.id AS conversation_id,c.name AS conversation_name,${query.projection}
      FROM ${query.from} WHERE ${query.where} AND ${visible} AND (? IS NULL OR c.id=?) AND e.rowid<?
      ORDER BY e.rowid DESC LIMIT ?`,
      [conversationId, conversationId, before, SCAN_ROWS + 1]
    )
    const matches: BotSearchPage["matches"] = []
    let scanned = 0,
      bytes = 0,
      last = before,
      more = false
    try {
      while (stmt.step()) {
        const row = rowSchema.parse(stmt.getAsObject())
        if (row.entity_refs)
          row.content = [
            botEntityReferences
              .parse(JSON.parse(row.entity_refs))
              .map((reference) => `@${reference.name}`)
              .join(" "),
            row.content
          ]
            .filter(Boolean)
            .join("\n")
        const size = Buffer.byteLength(row.content, "utf8")
        if (scanned >= SCAN_ROWS || (scanned > 0 && bytes + size > SCAN_BYTES)) {
          more = true
          break
        }
        scanned++
        bytes += size
        last = row.row_id
        let text = row.content
        if (input.kind === "link") {
          // Return a matching message, never navigate to or execute an extracted URL.
          const content = text
          text = ""
          for (const match of content.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
            if (match[0].toLowerCase().includes(needle)) {
              text = match[0]
              break
            }
          }
        }
        const snippet = buildContentSnippet(text, needle)
        if (snippet === null) continue
        matches.push({
          kind: input.kind,
          id: row.id,
          conversationId: row.conversation_id,
          conversationName: row.conversation_name,
          botId: row.bot_id,
          title: row.title,
          snippet,
          createdAt: row.created_at
        })
      }
    } finally {
      stmt.free()
    }
    return {
      matches,
      scanned,
      cursor: more
        ? Buffer.from(JSON.stringify({ version: 1, before: last, key })).toString("base64url")
        : null
    }
  }
}
