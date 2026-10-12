import { randomUUID } from "node:crypto"
import type { BotStore } from "./store"
import type { ModelResponseDiagnostic } from "../agent/model-response-diagnostics"
import type { CmbModelSettings } from "../models/model-factory"
import type { BotModelUsagePurpose, BotModelUsageSummary } from "../../shared/bot-model-usage"
import { BotDomainError } from "../../shared/bot-types"

/** Persist before transport. A disconnect/crash/missing receipt stays unknown,
 * including after restart; a reserved output ceiling is never billed usage. */
export function startBotModelUsage(
  store: BotStore,
  input: {
    id?: string
    botId: string
    runId?: string
    model: CmbModelSettings & { ref?: string }
    purpose: BotModelUsagePurpose
    reserved: number
  }
): string {
  const id = input.id ?? randomUUID(),
    ref = input.model.ref ?? input.model.id
  if (
    !Number.isSafeInteger(input.reserved) ||
    input.reserved <= 0 ||
    input.reserved > 100_000 ||
    typeof ref !== "string" ||
    !ref ||
    ref.length > 512 ||
    typeof input.model.model !== "string" ||
    !input.model.model ||
    input.model.model.length > 512
  )
    throw new BotDomainError("model_usage_configuration", "模型名称或输出额度无效，请检查模型配置")
  store.getBot(input.botId)
  if (input.runId && store.getRun(input.runId).botId !== input.botId)
    throw new BotDomainError("model_usage_scope", "模型请求不属于当前 Bot")
  if (store.usageBudgets.capacity(input.botId, input.reserved) < input.reserved)
    throw new BotDomainError("model_usage_budget", "本次模型请求超过剩余输出额度")
  store.db.run(
    `INSERT INTO bot_model_usage(id,bot_id,run_id,model_ref,model,purpose,reserved,created_at)
    VALUES(?,?,?,?,?,?,?,?)`,
    [
      id,
      input.botId,
      input.runId ?? null,
      ref,
      input.model.model,
      input.purpose,
      input.reserved,
      store.now()
    ]
  )
  return id
}

export function settleBotModelUsage(
  store: BotStore,
  id: string,
  usage: ModelResponseDiagnostic
): void {
  if (
    !(usage.doneEvents >= 1) ||
    usage.errorEvents !== 0 ||
    usage.uninspectedEvents !== 0 ||
    usage.outputTokens === undefined
  )
    return
  const count = (value?: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
  if (count(usage.outputTokens) === null) return
  // Counts are set once, never incremented on a replayed completion callback.
  store.db.run(
    `UPDATE bot_model_usage SET input_tokens=?,output_tokens=?,cache_read_tokens=?,reasoning_tokens=?,settled_at=?
    WHERE id=? AND settled_at IS NULL`,
    [
      count(usage.inputTokens),
      usage.outputTokens,
      count(usage.cacheReadTokens),
      count(usage.reasoningTokens),
      store.now(),
      id
    ]
  )
}

/** Callers validate the visible Bot/task scope before invoking this internal query.
 * The panel shows the latest 30 days, bounded to 100 distinct model/purpose rows. */
export function botModelUsage(
  store: BotStore,
  scope:
    | { memoryBotId: string }
    | { rootRunId: string }
    | { budgetBotId: string | null; since: number }
): BotModelUsageSummary {
  const byBot = "memoryBotId" in scope
  if (byBot) store.getBot(scope.memoryBotId)
  else if ("rootRunId" in scope) store.getRun(scope.rootRunId)
  else if (scope.budgetBotId) store.getBot(scope.budgetBotId)
  const [where, args] = byBot
    ? ([
        "u.bot_id=? AND u.run_id IS NULL AND u.created_at>=?",
        [scope.memoryBotId, store.now() - 30 * 86_400_000]
      ] as const)
    : "rootRunId" in scope
      ? (["u.run_id IN (SELECT id FROM bot_runs WHERE root_run_id=?)", [scope.rootRunId]] as const)
      : scope.budgetBotId
        ? (["u.bot_id=? AND u.created_at>=?", [scope.budgetBotId, scope.since]] as const)
        : (["u.created_at>=?", [scope.since]] as const)
  const aggregate = `COUNT(*) requests,
    SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) unknown_requests,
    COALESCE(SUM(CAST(input_tokens AS REAL)),0) input_tokens,COALESCE(SUM(CAST(output_tokens AS REAL)),0) output_tokens,
    COALESCE(SUM(CASE WHEN settled_at IS NULL THEN reserved ELSE 0 END),0) reserved,
    COUNT(input_tokens) input_reported`
  const totals = store.db.prepare(`SELECT ${aggregate} FROM bot_model_usage u WHERE ${where}`, args)
  const summary: BotModelUsageSummary = {
    requests: 0,
    unknownRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reservedOutputTokens: 0,
    inputReportedRequests: 0,
    otherModelRequests: 0,
    models: []
  }
  try {
    if (totals.step()) {
      const row = totals.getAsObject()
      summary.requests = Number(row.requests)
      summary.unknownRequests = Number(row.unknown_requests)
      summary.inputTokens = Number(row.input_tokens)
      summary.outputTokens = Number(row.output_tokens)
      summary.reservedOutputTokens = Number(row.reserved)
      summary.inputReportedRequests = Number(row.input_reported)
    }
  } finally {
    totals.free()
  }
  const stmt = store.db.prepare(
    `SELECT model_ref,model,purpose,${aggregate}
    FROM bot_model_usage u WHERE ${where} GROUP BY model_ref,model,purpose ORDER BY MAX(created_at) DESC,model_ref,model,purpose LIMIT 100`,
    args
  )
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      summary.models.push({
        modelRef: String(row.model_ref),
        model: String(row.model),
        purpose: row.purpose as BotModelUsagePurpose,
        requests: Number(row.requests),
        unknownRequests: Number(row.unknown_requests),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        inputReportedRequests: Number(row.input_reported)
      })
    }
  } finally {
    stmt.free()
  }
  summary.otherModelRequests =
    summary.requests - summary.models.reduce((sum, model) => sum + model.requests, 0)
  return summary
}
