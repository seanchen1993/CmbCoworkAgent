// Rebase a saved cursor by its message ID in the page's own read snapshot.
// A deleted boundary still falls back to the original tuple.
export const THREAD_MESSAGE_BEFORE_CURSOR_SQL = `AND (m.ordinal, m.message_id) < (
  COALESCE((SELECT ordinal FROM thread_messages WHERE thread_id = ? AND message_id = ?), ?), ?
)`

export function threadMessageBeforeCursorBindings(
  threadId: string, messageId: string, ordinal: number
): [string, string, number, string] {
  return [threadId, messageId, ordinal, messageId]
}
