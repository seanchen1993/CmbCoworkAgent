const LEGACY_GOAL_ANCHOR_TIME_WINDOW_MS = 5_000

/**
 * Goal events and visible messages are written separately. A recorded request
 * ID is authoritative when its user row exists. An older event can use a
 * nearby user row from its own active window. Goal IDs survive /goal resume
 * and therefore cannot identify which window owns a command.
 *
 * Both hydration readers use these aliases so the same event keeps its position
 * even when the worker is unavailable.
 */
export const GOAL_EVENT_TRANSCRIPT_ANCHOR_JOIN = `
  LEFT JOIN thread_messages AS anchor
    ON anchor.rowid = COALESCE(
      (
        SELECT candidate.rowid
        FROM thread_messages AS candidate
        WHERE candidate.thread_id = event.thread_id
          AND candidate.message_id = event.transcript_message_id
          AND candidate.role = 'user'
          AND (NULLIF(candidate.active_window_id, '') IS NULL
            OR NULLIF(event.active_window_id, '') IS NULL
            OR candidate.active_window_id = event.active_window_id)
      ),
      (
        SELECT MIN(rowid) FROM (
          SELECT candidate.rowid
          FROM thread_messages AS candidate
          WHERE candidate.thread_id = event.thread_id
            AND event.transcript_message_id IS NULL
            AND event.active_window_id IS NOT NULL AND event.active_window_id != ''
            AND candidate.active_window_id != ''
            AND candidate.active_window_id = event.active_window_id
            AND candidate.role = 'user'
            AND candidate.created_at BETWEEN event.created_at - ${LEGACY_GOAL_ANCHOR_TIME_WINDOW_MS}
                                         AND event.created_at + ${LEGACY_GOAL_ANCHOR_TIME_WINDOW_MS}
          LIMIT 2
        )
        HAVING COUNT(*) = 1
      )
    )`

export function readGoalEventTranscriptOrdinal(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}
