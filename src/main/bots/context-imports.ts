import {
  botContextImport,
  botContextOrigin,
  formatBotContextImport,
  type BotContextImportReceipt,
  type BotContextOrigin
} from "../../shared/bot-context-import"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"

/** Explicit selections from the local desktop only. No source database, credentials,
 * files, project permissions or task execution state are inherited by the Host. */
export class BotContextImports {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, action: () => T) => T,
    private readonly append: (conversationId: string, text: string) => string,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  import(raw: unknown): BotContextImportReceipt {
    const parsed = botContextImport.safeParse(raw)
    if (!parsed.success)
      throw new BotDomainError(
        "invalid_input",
        parsed.error.issues[0]?.message ?? "历史记录选择无效"
      )
    const input = parsed.data
    return this.store.transaction(() =>
      this.receipt(input.nonce, { operation: "context.import", ...input }, () => {
        this.store.getBot(input.botId)
        const conversationId = this.store.directConversation(input.botId).id
        const messageId = this.append(conversationId, formatBotContextImport(input.draft))
        const origin: BotContextOrigin = {
          ...input.draft.source,
          messageIds: input.draft.messages.map((message) => message.id)
        }
        this.store.db.run("INSERT INTO bot_context_imports VALUES(?,?)", [
          messageId,
          JSON.stringify(origin)
        ])
        this.event("context.imported", messageId, {
          botId: input.botId,
          conversationId,
          count: origin.messageIds.length
        })
        return { conversationId, messageId }
      })
    )
  }

  forMessages(ids: string[]): Map<string, BotContextOrigin> {
    const result = new Map<string, BotContextOrigin>()
    if (!ids.length) return result
    if (ids.length > 200) throw new BotDomainError("invalid_input", "历史记录读取超出分页范围")
    const rows =
      this.store.db.exec(
        `SELECT message_id,origin FROM bot_context_imports WHERE message_id IN (${ids.map(() => "?").join(",")})`,
        ids
      )[0]?.values ?? []
    for (const [id, raw] of rows)
      result.set(String(id), botContextOrigin.parse(JSON.parse(String(raw))))
    return result
  }
}
