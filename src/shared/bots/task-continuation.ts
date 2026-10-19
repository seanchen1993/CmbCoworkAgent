/** Host-only transcript namespace. This is a display/source lookup, never authorization. */
export function botContinuationTaskId(messageId: string): string | undefined {
  return /^bot-continuation:([A-Za-z0-9_-]{1,128}):[a-f0-9]{64}$/.exec(messageId)?.[1]
}
