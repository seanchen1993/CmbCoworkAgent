import { z } from "zod"
import { botRoutineSaveOutcome, type BotRoutineSaveOutcome } from "../../shared/bot-routine-outcome"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"

export const BOT_ROUTINE_OUTCOME_EVENT = "message.routine_saved"
export const botRoutineSaveOutcomeRecord = botRoutineSaveOutcome
  .extend({
    runId: z.string().regex(/^[\w:.-]{1,160}$/),
    receiptNonce: z.string().min(1).max(326)
  })
  .strict()

/** One indexed page read. The receipt remains the save owner, not this display event.
 * SQLite extracts only small identity fields: a saved prompt never crosses this boundary. */
export function routineOutcomesForMessages(
  store: BotStore,
  rows: Record<string, unknown>[]
): Map<string, BotRoutineSaveOutcome> {
  const outcomes = new Map<string, BotRoutineSaveOutcome>()
  if (rows.length > 200) throw new BotDomainError("invalid_input", "例程投影超出消息分页范围")
  const messages = new Map(
    rows
      .filter((row) => row.sender === "system" && typeof row.run_id === "string")
      .map((row) => [String(row.id), row])
  )
  if (!messages.size) return outcomes
  const eventJson =
    "CASE WHEN length(CAST(e.payload AS BLOB))<=4096 AND json_valid(e.payload) THEN e.payload ELSE '{}' END"
  const receiptJson = "CASE WHEN json_valid(c.response) THEN c.response ELSE '{}' END"
  const statement = store.db.prepare(
    `SELECT e.entity_id,${eventJson} AS record,
     substr(json_extract(${receiptJson},'$.id'),1,161) AS saved_id,
     substr(json_extract(${receiptJson},'$.botId'),1,161) AS saved_bot_id,
     substr(json_extract(${receiptJson},'$.name'),1,101) AS saved_name,
     CASE WHEN json_type(${receiptJson},'$.revision')='integer'
       AND json_extract(${receiptJson},'$.revision') BETWEEN 1 AND 9007199254740991
       THEN json_extract(${receiptJson},'$.revision') ELSE NULL END AS saved_revision,
     r.id AS owner_run_id,r.bot_id AS owner_bot_id,
     r.conversation_id AS owner_conversation_id,r.message_id AS owner_message_id,
     t.root_id AS owner_thread_root,c.nonce AS receipt_nonce
     FROM bot_events e JOIN bot_messages m ON m.id=e.entity_id
     JOIN bot_runs r ON r.id=m.run_id
     LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
     JOIN bot_receipts c ON c.nonce=json_extract(${eventJson},'$.receiptNonce')
     WHERE e.kind=? AND e.entity_id IN (${[...messages].map(() => "?").join(",")})
     ORDER BY e.cursor LIMIT 201`,
    [BOT_ROUTINE_OUTCOME_EVENT, ...messages.keys()]
  )
  const records: Record<string, unknown>[] = []
  try {
    while (statement.step()) records.push(statement.getAsObject())
  } finally {
    statement.free()
  }
  // Duplicate metadata is not a new successful save. Preserve the underlying chat.
  if (records.length > 200) return outcomes
  const seen = new Set<string>()
  for (const row of records) {
    const messageId = String(row.entity_id)
    if (seen.has(messageId)) {
      outcomes.delete(messageId)
      continue
    }
    seen.add(messageId)
    const message = messages.get(messageId)
    let parsed: ReturnType<typeof botRoutineSaveOutcomeRecord.safeParse>
    try {
      parsed = botRoutineSaveOutcomeRecord.safeParse(JSON.parse(String(row.record)))
    } catch {
      continue
    }
    if (!parsed.success || !message) continue
    const record = parsed.data
    if (
      record.runId !== message.run_id ||
      record.runId !== row.owner_run_id ||
      record.botId !== message.bot_id ||
      record.botId !== row.owner_bot_id ||
      message.conversation_id !== row.owner_conversation_id ||
      message.reply_to !== row.owner_message_id ||
      (message.thread_root ?? null) !== (row.owner_thread_root ?? null) ||
      !record.receiptNonce.startsWith(`tool:${record.runId}:`) ||
      record.receiptNonce !== row.receipt_nonce ||
      record.id !== row.saved_id ||
      record.botId !== row.saved_bot_id ||
      record.name !== row.saved_name ||
      record.revision !== row.saved_revision
    )
      continue
    outcomes.set(
      messageId,
      botRoutineSaveOutcome.parse({
        version: record.version,
        operation: record.operation,
        id: record.id,
        botId: record.botId,
        name: record.name,
        revision: record.revision,
        dataEpoch: record.dataEpoch
      })
    )
  }
  return outcomes
}
