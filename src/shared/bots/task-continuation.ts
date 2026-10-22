/** Host-only transcript namespace. This is a display/source lookup, never authorization. */
export function botContinuationTaskId(messageId: string): string | undefined {
  return /^bot-continuation:([A-Za-z0-9_-]{1,128}):[a-f0-9]{64}$/.exec(messageId)?.[1]
}

/** Canonical Host receipt ID; renderer request IDs cannot contain colons. */
export function isBotCommandNotificationMessageId(messageId: string): boolean {
  return /^notification:[A-Za-z0-9_-]{1,256}:command:[A-Za-z0-9_-]{1,128}$/.test(messageId)
}
