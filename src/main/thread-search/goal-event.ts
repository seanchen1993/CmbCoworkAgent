import { THREAD_SEARCH_TARGET_ID_BYTE_LIMIT } from "../../shared/thread-search-types"
import { GOAL_EVENT_TRANSCRIPT_ANCHOR_JOIN } from "../goal-event-transcript-anchor"

export const threadSearchGoalScopeSql = (prefix = "") => `
  CASE WHEN octet_length(${prefix}goal_id) <= 4096 THEN ${prefix}goal_id END AS goal_id,
  CASE WHEN octet_length(${prefix}active_window_id) <= 4096
    THEN ${prefix}active_window_id END AS active_window_id,
  (COALESCE(octet_length(${prefix}goal_id), 0) > 4096 OR
    COALESCE(octet_length(${prefix}active_window_id), 0) > 4096) AS oversized_scope
`

export const THREAD_SEARCH_GOAL_EVENT_SQL = `
SELECT event.event_id, event.thread_id, ${threadSearchGoalScopeSql("event.")},
       event.message, event.created_at, anchor.ordinal AS transcript_ordinal,
       CASE WHEN octet_length(anchor.message_id) <= ${THREAD_SEARCH_TARGET_ID_BYTE_LIMIT}
         THEN anchor.message_id END AS transcript_message_id
FROM thread_goal_events AS event
${GOAL_EVENT_TRANSCRIPT_ANCHOR_JOIN}
WHERE event.thread_id = ? AND event.event_id = ?
  AND octet_length(event.message) <= 65536
`
