import { createHash } from "node:crypto"
import {
  botAvatarAddress,
  botAvatarChange,
  botAvatarBase64,
  type BotAvatarChanged
} from "../../shared/bot-avatar"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"
import type { BotDocumentReader } from "./document-reader"

type Receipt = <T>(nonce: string, input: unknown, operation: () => T) => T
export class BotAvatars {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: Receipt,
    private readonly event: (kind: string, id: string, value: unknown) => void
  ) {}

  read(raw: unknown): string | null {
    const parsed = botAvatarAddress.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "头像目标无效")
    const { botId, hash } = parsed.data
    this.store.getBot(botId)
    const row = this.store.db.exec("SELECT png FROM bot_avatar_images WHERE bot_id=? AND hash=?", [
      botId,
      hash
    ])[0]?.values[0]
    return row ? botAvatarBase64.parse(row[0]) : null
  }

  async change(
    raw: unknown,
    signal: AbortSignal,
    reader: Pick<BotDocumentReader, "avatar">
  ): Promise<BotAvatarChanged> {
    const parsed = botAvatarChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "头像参数无效")
    const input = parsed.data
    const request = { op: "avatar.change", ...input }
    // A completed retry needs neither the original Bot revision nor a functioning decoder.
    if (
      this.store.db.exec("SELECT 1 FROM bot_receipts WHERE nonce=?", [input.nonce])[0]?.values
        .length
    )
      return this.receipt(input.nonce, request, () => {
        throw new Error("头像收据不存在")
      })
    this.store.assertMutationEpoch(input.expectedDataEpoch)
    const before = this.store.getBot(input.botId)
    if (before.revision !== input.revision)
      throw new BotDomainError("revision_conflict", "Bot 已变化，请重新打开头像编辑")
    let png: string | null = null
    if (input.pngBase64 !== null) {
      try {
        png = botAvatarBase64.parse(await reader.avatar(input.pngBase64, signal))
      } catch (error) {
        signal.throwIfAborted()
        throw new BotDomainError(
          "avatar_invalid",
          error instanceof Error ? error.message : "头像无法读取"
        )
      }
    }
    signal.throwIfAborted()
    return this.store.transaction(() =>
      this.receipt(input.nonce, request, () => {
        this.store.assertMutationEpoch(input.expectedDataEpoch)
        const bot = this.store.getBot(input.botId)
        if (bot.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "Bot 已变化，请重新打开头像编辑")
        const hash =
          png === null
            ? null
            : createHash("sha256").update(Buffer.from(png, "base64")).digest("hex")
        if (png === null)
          this.store.db.run("DELETE FROM bot_avatar_images WHERE bot_id=?", [bot.id])
        else
          this.store.db.run(
            "INSERT INTO bot_avatar_images VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET hash=excluded.hash,png=excluded.png",
            [bot.id, hash, png]
          )
        this.store.db.run("UPDATE bots SET revision=revision+1,updated_at=? WHERE id=?", [
          this.store.now(),
          bot.id
        ])
        this.event("bot.avatar_changed", bot.id, { revision: bot.revision + 1, hash })
        return { botId: bot.id, revision: bot.revision + 1, hash }
      })
    )
  }
}
