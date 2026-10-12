import { startBotModelUsage, settleBotModelUsage } from "./model-usage"
import { botModelCallDiagnostics } from "./model-call-diagnostics"
import { botModelAttemptPending } from "./model-error-diagnostic-scope"
import { randomUUID } from "node:crypto"
import { BotDomainError } from "../../shared/bot-types"
import { withModelResponseDiagnostics } from "../agent/model-response-diagnostics"
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../models/defaults"
import type { CmbModelSettings } from "../models/model-factory"
import type { BotRuntimeRequest } from "./host"
import { BOT_ROOT_OUTPUT_LIMIT } from "../../shared/bot-model-budget"

/** The root shares one persistent pool across parent, peer, workflow and helper calls.
 * Reservation precedes the HTTP attempt. Missing usage/disconnect keeps the
 * whole reservation charged; a valid final usage receipt releases the surplus. */
export function botWorkflowModelFetch(
  request: BotRuntimeRequest,
  config: CmbModelSettings & { ref?: string },
  send: typeof fetch = fetch,
  assertCurrent?: () => Promise<void>
): typeof fetch {
  const { store, lease, run, signal } = request
  const child = store.workflowChildren.metadata(run.id)
  if (run.source === "workflow-child" && !child)
    throw new BotDomainError("workflow_child_scope", "子任务缺少所属工作流")
  return async (url, init) => {
    botModelAttemptPending()
    signal.throwIfAborted()
    if (typeof init?.body !== "string")
      throw new BotDomainError("workflow_model_protocol", "模型请求缺少可核对的输出上限")
    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body)
    } catch {
      throw new BotDomainError("workflow_model_protocol", "模型请求不是 JSON")
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new BotDomainError("workflow_model_protocol", "模型请求格式无效")
    const tokenKey = Object.hasOwn(body, "max_completion_tokens")
      ? "max_completion_tokens"
      : "max_tokens"
    const configured = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    const requested = Math.min(Number(body[tokenKey] ?? configured), configured)
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > 100_000)
      throw new BotDomainError("workflow_model_protocol", "模型输出上限无效")
    // A model SDK can delay or repeat an HTTP attempt after its outer tool was
    // admitted. Recheck async authority before charging or sending this attempt;
    // usage settlement below keeps the original lease-only receipt fence.
    if (assertCurrent) await assertCurrent()
    signal.throwIfAborted()
    const id = randomUUID()
    const reserved = store.transaction(() => {
      store.assertDispatch(lease)
      const limit = child
        ? Number(
            store.db.exec("SELECT output_limit FROM bot_workflow_limits WHERE workflow_id=?", [
              child.workflowId
            ])[0]?.values[0]?.[0]
          )
        : BOT_ROOT_OUTPUT_LIMIT
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new BotDomainError("workflow_budget", "工作流预算不存在")
      const totals = store.db.exec(
        `SELECT COUNT(*), COALESCE(SUM(COALESCE(consumed,reserved)),0),
         COALESCE(SUM(CASE WHEN workflow_id=? THEN COALESCE(consumed,reserved) ELSE 0 END),0)
         FROM bot_workflow_model_calls WHERE root_run_id=?`,
        [child?.workflowId ?? null, run.rootRunId]
      )[0].values[0]
      const available = Math.min(
        BOT_ROOT_OUTPUT_LIMIT - Number(totals[1]),
        child ? limit - Number(totals[2]) : BOT_ROOT_OUTPUT_LIMIT
      )
      if (available <= 0 || Number(totals[0]) >= 2000)
        throw new BotDomainError("workflow_budget", "任务共享输出预算已用尽，已保留当前结果")
      const amount = store.usageBudgets.capacity(run.botId, Math.min(available, requested))
      store.db.run("INSERT INTO bot_workflow_model_calls VALUES(?,?,?,?,?,NULL,?)", [
        id,
        run.id,
        child?.workflowId ?? null,
        run.rootRunId,
        amount,
        store.now()
      ])
      startBotModelUsage(store, {
        id,
        botId: run.botId,
        runId: run.id,
        model: config,
        purpose: "task",
        reserved: amount
      })
      return amount
    })
    // Rewrite the actual request, not only the model's advisory prompt.
    body[tokenKey] = reserved
    if (Object.hasOwn(body, "max_tokens")) body.max_tokens = reserved
    const diagnostics = botModelCallDiagnostics({
      callId: id,
      botId: run.botId,
      runId: run.id,
      rootRunId: run.rootRunId,
      purpose: "task",
      knownSecrets: config.apiKey ? [config.apiKey] : []
    })
    const metered = withModelResponseDiagnostics(
      (url, init) => diagnostics.send(send, url, init),
      { model: config.model, purpose: "bot-task-budget" },
      (usage) => {
        diagnostics.complete(usage)
        if (
          usage.doneEvents < 1 ||
          usage.outputTokens === undefined ||
          usage.errorEvents > 0 ||
          usage.uninspectedEvents > 0
        )
          return
        store.transaction(() => {
          // A cancelling task may settle an already-started model request. A stale
          // owner may not release an interrupted reservation after recovery.
          store.assertLease(lease, true, true)
          settleBotModelUsage(store, id, usage)
          store.db.run(
            "UPDATE bot_workflow_model_calls SET consumed=? WHERE id=? AND consumed IS NULL",
            [usage.outputTokens, id]
          )
        })
      }
    )
    return metered(url, {
      ...init,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
    })
  }
}
