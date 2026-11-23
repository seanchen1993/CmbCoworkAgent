interface PageResult {
  id: string
  ordinal?: number
  role: string
  provider_occurrence?: number
}

// Check exact saved payloads through provider and primary-key indexes. A
// fragment head alone cannot establish that the prior full output was equal.
const exactEarlierToolResult = `
  earlier.thread_id = copy.thread_id AND earlier.role = 'tool'
  AND earlier.ordinal < ?3
  AND COALESCE(earlier.provider_occurrence, 1) < copy.provider_occurrence
  AND earlier.content_json IS copy.content_json
  AND earlier.tool_call_id IS copy.tool_call_id
  AND earlier.name IS copy.name AND earlier.reasoning IS copy.reasoning
  AND COALESCE(earlier.status, 'success') = COALESCE(copy.status, 'success')
  AND COALESCE(earlier.is_error, 0) = COALESCE(copy.is_error, 0)
  AND earlier.goal_id IS copy.goal_id AND earlier.active_window_id IS copy.active_window_id
  AND NOT EXISTS (SELECT 1 FROM thread_message_fragment_states AS fragment
    WHERE fragment.thread_id = earlier.thread_id AND fragment.message_id = earlier.message_id)`

const TOOL_REPLAY_EVIDENCE_SQL = `
  WITH candidates AS (
    SELECT copy.message_id, COALESCE(
      (SELECT earlier.message_id FROM thread_messages AS earlier
       WHERE earlier.provider_source_id = copy.provider_source_id AND ${exactEarlierToolResult}
       ORDER BY earlier.provider_occurrence, earlier.ordinal LIMIT 1),
      (SELECT earlier.message_id FROM thread_messages AS earlier
       WHERE earlier.message_id = copy.provider_source_id AND ${exactEarlierToolResult}
       LIMIT 1)
    ) AS earlier_id
    FROM json_each(?2) AS requested
    JOIN thread_messages AS copy ON copy.thread_id = ?1 AND copy.message_id = requested.value
    WHERE copy.role = 'tool' AND copy.provider_occurrence > 1
      AND copy.provider_source_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM thread_message_fragment_states AS fragment
        WHERE fragment.thread_id = copy.thread_id AND fragment.message_id = copy.message_id)
  ) SELECT message_id, earlier_id FROM candidates WHERE earlier_id IS NOT NULL`

export function readPriorToolReplayIds(
  threadId: string,
  messages: readonly PageResult[],
  query: (
    sql: string,
    threadId: string,
    ids: string,
    beforeOrdinal: number
  ) => Iterable<readonly unknown[]>
): ReadonlyMap<string, string> {
  const ids = messages
    .filter((message) => message.role === "tool" && (message.provider_occurrence ?? 1) > 1)
    .map(({ id }) => id)
  const proof = new Map<string, string>()
  if (!ids.length) return proof
  const oldest = Math.min(...messages.map(({ ordinal }) => ordinal ?? 0))
  if (oldest <= 0) return proof
  for (const [id, earlierId] of query(
    TOOL_REPLAY_EVIDENCE_SQL,
    threadId,
    JSON.stringify(ids),
    oldest
  )) {
    if (typeof id === "string" && typeof earlierId === "string") proof.set(id, earlierId)
  }
  return proof
}
