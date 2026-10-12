import { BotDomainError } from "../../shared/bot-types"
import {
  BOT_USAGE_WINDOW_MS,
  botUsageBudgetAddress,
  botUsageBudgetChange,
  type BotUsageBudgetPolicy,
  type BotUsageBudgetView
} from "../../shared/bot-usage-budget"
import type { BotStore } from "./store"
import { botModelUsage } from "./model-usage"

/** User-configured rolling output allowances. Each user's Host owns its own store.
 * Unknown calls retain their reservation; these counters are not supplier billing. */
export class BotUsageBudgets {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  private policy(botId: string | null): BotUsageBudgetPolicy {
    const row = this.store.db.exec(
      "SELECT revision,output_limit FROM bot_usage_budgets WHERE scope=?",
      [botId ?? "user"]
    )[0]?.values[0]
    return {
      botId,
      revision: row ? Number(row[0]) : 0,
      outputLimit: !row || row[1] === null ? null : Number(row[1])
    }
  }

  view(raw: unknown): BotUsageBudgetView {
    const parsed = botUsageBudgetAddress.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "用量范围无效")
    const { botId } = parsed.data
    if (botId) this.store.getBot(botId)
    const asOf = this.store.now(),
      windowStart = asOf - BOT_USAGE_WINDOW_MS
    const policy = this.policy(botId)
    const usage = botModelUsage(this.store, { budgetBotId: botId, since: windowStart })
    return {
      ...policy,
      dataEpoch: this.store.backupSchedule.epoch(),
      asOf,
      windowStart,
      usage,
      available:
        policy.outputLimit === null
          ? null
          : Math.max(0, policy.outputLimit - usage.outputTokens - usage.reservedOutputTokens)
    }
  }

  change(raw: unknown): BotUsageBudgetPolicy {
    const parsed = botUsageBudgetChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "用量额度设置无效")
    const input = parsed.data
    return this.store.transaction(() => {
      if (input.botId) this.store.getBot(input.botId)
      if (input.dataEpoch !== this.store.backupSchedule.epoch())
        throw new BotDomainError("data_epoch", "数据已恢复，请重新读取用量设置")
      return this.receipt(input.nonce, { op: "usage.budget", ...input }, () => {
        const current = this.policy(input.botId)
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "用量设置已变化，请刷新后重试")
        const next = {
          botId: input.botId,
          revision: current.revision + 1,
          outputLimit: input.outputLimit
        }
        this.store.db.run(
          `INSERT INTO bot_usage_budgets VALUES(?,?,?) ON CONFLICT(scope)
          DO UPDATE SET revision=excluded.revision,output_limit=excluded.output_limit`,
          [input.botId ?? "user", next.revision, next.outputLimit]
        )
        this.event("usage.budget_changed", input.botId ?? "user", next)
        return next
      })
    })
  }

  /** Call inside the same transaction as reservation, before any model transport.
   * Peer/child calls consume the actual executing Bot's allowance and the user pool. */
  capacity(botId: string, requested: number): number {
    const userLimit = this.policy(null).outputLimit,
      botLimit = this.policy(botId).outputLimit
    if (userLimit === null && botLimit === null) return requested
    const totals = this.store.db.exec(
      `SELECT COALESCE(SUM(CAST(COALESCE(output_tokens,reserved) AS REAL)),0),
      COALESCE(SUM(CASE WHEN bot_id=? THEN CAST(COALESCE(output_tokens,reserved) AS REAL) ELSE 0 END),0)
      FROM bot_model_usage WHERE created_at>=?`,
      [botId, this.store.now() - BOT_USAGE_WINDOW_MS]
    )[0].values[0]
    const available = Math.min(
      requested,
      userLimit === null ? Infinity : userLimit - Number(totals[0]),
      botLimit === null ? Infinity : botLimit - Number(totals[1])
    )
    if (available <= 0)
      throw new BotDomainError(
        "model_usage_budget",
        "过去 24 小时的模型输出额度已用尽，请在“用量与额度”中查看或调整"
      )
    return available
  }
}
