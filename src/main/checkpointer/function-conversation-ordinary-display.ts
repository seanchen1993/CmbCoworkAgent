import { createHash } from "node:crypto"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS,
  type FunctionConversationProjectionColumns } from "../db/function-conversation-projection-receipt"
import type { NativeSqliteAdapter, NativeSqliteValue } from "../db/native-sqlite-adapter"

/** Bounded read evidence only. This never creates a canonical row, seal or recovery source. */
export interface OrdinaryCheckpointDisplayCoverage {
  readonly ordinal: number
  readonly payload: string
  readonly columnsDigest: string
}
export const ORDINARY_CHECKPOINT_COVERAGE_BYTE_LIMIT = 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly string[] = []) {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(row => Object.fromEntries(result.columns.map(
    (key, index) => [key, row[index]]))) : []
}

/**
 * Deliberately lossless, narrow ordinary projection contract. Native metadata or other
 * message kinds require their own projection contract; absence of a seal does not trust them.
 * The caller must separately bind payload to the complete original checkpoint native digest.
 */
export function readOrdinaryToolDisplayCoverage(db: NativeSqliteAdapter, threadId: string,
  payload: string): { messageId: string; columnsDigest: string } | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { return undefined }
  const envelope = record(parsed), data = record(envelope?.data)
  if (!envelope || envelope.type !== "tool" || Object.keys(envelope).length !== 2 || !data ||
    Object.keys(data).some(key => !["id", "content", "name", "tool_call_id",
      "additional_kwargs", "response_metadata"].includes(key)) ||
    typeof data.id !== "string" || !data.id || typeof data.content !== "string" ||
    typeof data.tool_call_id !== "string" || !data.tool_call_id ||
    (data.name !== undefined && (typeof data.name !== "string" || !data.name)) ||
    !record(data.additional_kwargs) || Object.keys(data.additional_kwargs as object).length ||
    !record(data.response_metadata) || Object.keys(data.response_metadata as object).length)
    return undefined
  const rows = query(db, `SELECT ${FUNCTION_CONVERSATION_PROJECTION_COLUMNS.join(",")}
    FROM thread_messages WHERE thread_id=? AND message_id=?`, [threadId, data.id])
  if (rows.length !== 1) return undefined
  const columns = rows[0] as Record<string, NativeSqliteValue>
  if (columns.role !== "tool" || columns.content_json !== JSON.stringify(data.content) ||
    columns.tool_call_id !== data.tool_call_id || columns.name !== (data.name ?? null) ||
    columns.provider_source_id !== data.id || columns.provider_occurrence !== 1 ||
    columns.stream_authority !== 1 || columns.recovery_integrity !== 1 ||
    ["prompt_origin_json", "function_row_json", "reasoning", "tool_calls_json", "status",
      "is_error", "content_priority", "goal_id", "active_window_id"].some(key => columns[key] !== null) ||
    !Number.isSafeInteger(columns.ordinal) || Number(columns.ordinal) < 0 ||
    !Number.isFinite(columns.created_at) ||
    ["start_at", "end_at"].some(key => columns[key] !== null && !Number.isFinite(columns[key])))
    return undefined
  // A plain row must not hide canonical admission or fragment/recovery state in side tables.
  for (const table of ["function_conversation_projection_receipts", "thread_message_fragments",
    "thread_message_fragment_states"]) {
    if (query(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]).length &&
      query(db, `SELECT 1 FROM ${table} WHERE thread_id=? AND ${table === "function_conversation_projection_receipts"
          ? "uuid" : "message_id"}=? LIMIT 1`,
        [threadId, data.id]).length) return undefined
  }
  const digest = createHash("sha256").update(JSON.stringify(FUNCTION_CONVERSATION_PROJECTION_COLUMNS
    .map(key => (columns as FunctionConversationProjectionColumns)[key]))).digest("hex")
  return { messageId: data.id, columnsDigest: digest }
}
