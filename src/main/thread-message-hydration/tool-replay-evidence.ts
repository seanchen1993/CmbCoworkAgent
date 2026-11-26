interface PageResult {
  id: string
  ordinal?: number
  role: string
  provider_occurrence?: number
}

// A null cutoff includes earlier rows on the same page. The tuple matches
// backward pagination when multiple messages share an ordinal.
const earlierThanCutoff = `CASE WHEN ?3 IS NULL
  THEN (earlier.ordinal, earlier.message_id) < (copy.ordinal, copy.message_id)
  ELSE earlier.ordinal < ?3 END`

// Check exact saved payloads through provider and primary-key indexes. A
// fragment head alone cannot establish that the prior full output was equal.
// Start from the requested page IDs and keep materialization explicit so the
// query planner cannot run these lookups for the rest of the thread.
const exactEarlierToolResult = `
  earlier.thread_id = copy.thread_id AND earlier.role = 'tool'
  AND ${earlierThanCutoff}
  AND COALESCE(earlier.provider_occurrence, 1) < copy.provider_occurrence
  AND earlier.content_json IS copy.content_json
  AND earlier.tool_call_id IS copy.tool_call_id
  AND earlier.name IS copy.name AND earlier.reasoning IS copy.reasoning
  AND COALESCE(earlier.status, 'success') = COALESCE(copy.status, 'success')
  AND COALESCE(earlier.is_error, 0) = COALESCE(copy.is_error, 0)
  AND earlier.goal_id IS copy.goal_id AND earlier.active_window_id IS copy.active_window_id
  AND NOT EXISTS (SELECT 1 FROM thread_message_fragment_states AS fragment
    WHERE fragment.thread_id = earlier.thread_id AND fragment.message_id = earlier.message_id)`

function toolResultSignature(alias: "copy" | "earlier"): string {
  return `json_array(${alias}.content_json, ${alias}.tool_call_id, ${alias}.name,
    ${alias}.reasoning, COALESCE(${alias}.status, 'success'), COALESCE(${alias}.is_error, 0),
    ${alias}.goal_id, ${alias}.active_window_id)`
}

const TOOL_REPLAY_EVIDENCE_SQL = `
  WITH candidates AS MATERIALIZED (
    SELECT copy.message_id, copy.ordinal, copy.provider_source_id, copy.provider_occurrence,
      ${toolResultSignature("copy")} AS signature, COALESCE(
      (SELECT earlier.message_id FROM thread_messages AS earlier
       WHERE earlier.message_id = copy.provider_source_id AND ${exactEarlierToolResult}
         AND (earlier.provider_source_id IS NULL OR earlier.provider_source_id = copy.provider_source_id)
       LIMIT 1),
      (SELECT earlier.message_id FROM thread_messages AS earlier
       WHERE earlier.provider_source_id = copy.provider_source_id AND ${exactEarlierToolResult}
         AND earlier.provider_occurrence = 1
       LIMIT 1)
    ) AS earlier_id
    FROM json_each(?2) AS requested
    CROSS JOIN thread_messages AS copy ON copy.thread_id = ?1 AND copy.message_id = requested.value
    WHERE copy.role = 'tool' AND copy.provider_occurrence > 1
      AND copy.provider_source_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM thread_message_fragment_states AS fragment
        WHERE fragment.thread_id = copy.thread_id AND fragment.message_id = copy.message_id)
  ), unresolved AS MATERIALIZED (
    SELECT * FROM candidates WHERE earlier_id IS NULL
  ), sources AS MATERIALIZED (
    SELECT provider_source_id, MAX(provider_occurrence) AS last_occurrence
    FROM unresolved GROUP BY provider_source_id
  ), matches AS (
    SELECT copy.message_id, earlier.message_id AS earlier_id, MIN(earlier.provider_occurrence)
    FROM sources
    CROSS JOIN thread_messages AS earlier ON earlier.thread_id = ?1
      AND earlier.provider_source_id = sources.provider_source_id AND earlier.role = 'tool'
      AND earlier.provider_occurrence > 1 AND earlier.provider_occurrence < sources.last_occurrence
      AND (?3 IS NULL OR earlier.ordinal < ?3)
    CROSS JOIN unresolved AS copy ON copy.provider_source_id = earlier.provider_source_id
      AND copy.signature = ${toolResultSignature("earlier")}
      AND earlier.provider_occurrence < copy.provider_occurrence AND ${earlierThanCutoff}
    WHERE NOT EXISTS (SELECT 1 FROM thread_message_fragment_states AS fragment
      WHERE fragment.thread_id = earlier.thread_id AND fragment.message_id = earlier.message_id)
    GROUP BY copy.message_id
  )
  SELECT message_id, earlier_id FROM candidates WHERE earlier_id IS NOT NULL
  UNION ALL SELECT message_id, earlier_id FROM matches`

export function readPriorToolReplayIds(
  threadId: string,
  messages: readonly PageResult[],
  query: (
    sql: string,
    threadId: string,
    ids: string,
    beforeOrdinal: number | null
  ) => Iterable<readonly unknown[]>,
  options?: { includeInPage?: boolean }
): ReadonlyMap<string, string> {
  const ids = messages
    .filter((message) => message.role === "tool" && (message.provider_occurrence ?? 1) > 1)
    .map(({ id }) => id)
  const proof = new Map<string, string>()
  if (!ids.length) return proof
  const cutoff = options?.includeInPage ? null : Math.min(...messages.map(({ ordinal }) => ordinal ?? 0))
  if (cutoff !== null && cutoff <= 0) return proof
  for (const [id, earlierId] of query(
    TOOL_REPLAY_EVIDENCE_SQL,
    threadId,
    JSON.stringify(ids),
    cutoff
  )) {
    if (typeof id === "string" && typeof earlierId === "string") proof.set(id, earlierId)
  }
  return proof
}
