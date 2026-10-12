import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import {
  botRoutineDispatchRequest,
  type BotRoutineDispatchHistory
} from "../../shared/bot-routine-dispatch"
import type { BotStore } from "./store"

const payload = z.object({
  dueAt: z.number().int(),
  nextAt: z.number().int().nullable(),
  runId: z.string().nullable()
})
const statuses = z.enum([
  "queued",
  "running",
  "waiting_input",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "needs_review"
])

/** The scheduler already commits occurrence decisions, messages, queue insertion
 * and its next cursor atomically. Reuse those events as receipts, including
 * coalesced/skipped occurrences that have no separate run. No second scheduler
 * or parallel receipt database is needed.
 */
export function readBotRoutineDispatchHistory(
  store: BotStore,
  raw: unknown
): BotRoutineDispatchHistory {
  const input = botRoutineDispatchRequest.parse(raw)
  store.assertMutationEpoch(input.expectedDataEpoch)
  store.getBot(input.botId)
  const routine = store.db.exec("SELECT 1 FROM bot_routines WHERE id=? AND bot_id=?", [
    input.routineId,
    input.botId
  ])[0]?.values.length
  if (!routine) throw new BotDomainError("routine_scope", "例程不存在或不属于此 Bot")
  if (input.before !== undefined) {
    const cursor = store.db.exec(
      "SELECT 1 FROM bot_events WHERE cursor=? AND entity_id=? AND kind IN ('routine.triggered','routine.coalesced','routine.skipped')",
      [input.before, input.routineId]
    )[0]?.values.length
    if (!cursor) throw new BotDomainError("history_cursor", "调度记录游标不属于此例程")
  }
  const result = store.db.exec(
    `SELECT e.cursor,e.kind,e.created_at,e.payload,
    CASE WHEN r.bot_id=? AND r.source=? THEN r.status ELSE NULL END AS run_status
    FROM bot_events e LEFT JOIN bot_runs r ON r.id=json_extract(e.payload,'$.runId')
    WHERE e.entity_id=? AND e.kind IN ('routine.triggered','routine.coalesced','routine.skipped')
    ${input.before === undefined ? "" : "AND e.cursor<?"} ORDER BY e.cursor DESC LIMIT ?`,
    [
      input.botId,
      `routine:${input.routineId}`,
      input.routineId,
      ...(input.before === undefined ? [] : [input.before]),
      input.limit + 1
    ]
  )[0]
  const rows = result?.values ?? []
  const items = rows.slice(0, input.limit).map(([cursor, kind, createdAt, text, status]) => {
    const parsed = payload.safeParse(JSON.parse(String(text)))
    if (!parsed.success) throw new BotDomainError("dispatch_record", "调度记录损坏，请核对原记录")
    return {
      cursor: Number(cursor),
      recordedAt: Number(createdAt),
      ...parsed.data,
      disposition: String(kind).slice("routine.".length) as "triggered" | "coalesced" | "skipped",
      status: status === null ? null : statuses.parse(status)
    }
  })
  return { items, next: rows.length > input.limit ? items.at(-1)!.cursor : null }
}
