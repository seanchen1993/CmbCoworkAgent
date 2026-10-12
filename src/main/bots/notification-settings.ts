import { BotDomainError } from "../../shared/bot-types"
import { botNotificationChange, type BotNotificationSettings } from "../../shared/bot-notifications"
import type { BotStore } from "./store"

/** Human UI preference, independent of execution/profile revisions. */
export class BotNotificationPreferences {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}
  list(): BotNotificationSettings[] {
    return (
      this.store.db.exec(
        "SELECT n.bot_id,n.revision,n.enabled FROM bot_notification_settings n JOIN bots b ON b.id=n.bot_id WHERE b.deleted_at IS NULL ORDER BY n.bot_id"
      )[0]?.values ?? []
    ).map(([botId, revision, enabled]) => ({
      botId: String(botId),
      revision: Number(revision),
      enabled: Boolean(enabled)
    }))
  }
  change(raw: unknown): BotNotificationSettings {
    const parsed = botNotificationChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "通知设置格式不正确")
    const input = parsed.data
    return this.store.transaction(() => {
      this.store.getBot(input.botId)
      if (input.dataEpoch !== this.store.backupSchedule.epoch())
        throw new BotDomainError("data_epoch", "数据已恢复，请重新读取通知设置")
      return this.receipt(input.nonce, { op: "notification.settings", ...input }, () => {
        const current = this.list().find((item) => item.botId === input.botId) ?? {
          botId: input.botId,
          revision: 0,
          enabled: true
        }
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "通知设置已变化，请刷新后重试")
        const next = { botId: input.botId, revision: current.revision + 1, enabled: input.enabled }
        this.store.db.run(
          "INSERT INTO bot_notification_settings VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled",
          [next.botId, next.revision, Number(next.enabled)]
        )
        this.event("notification.settings_changed", next.botId, next)
        return next
      })
    })
  }
}
