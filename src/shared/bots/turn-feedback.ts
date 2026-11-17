/** Host control receipts are not execution failures. Unknown or errored results stay errors. */
export const BOT_CONTINUATION_KIND = "bot-foreground-continuation"

export function isBotContinuationReceipt(result?: {
  content?: unknown
  is_error?: boolean
}): boolean {
  if (result?.is_error || typeof result?.content !== "string") return false
  try {
    const value = JSON.parse(result.content)
    return (
      value?.kind === BOT_CONTINUATION_KIND &&
      value.version === 1 &&
      value.executed === false &&
      value.reason === "foreground_budget" &&
      typeof value.instruction === "string"
    )
  } catch {
    return false
  }
}

export interface BotDispatchFeedback {
  requestMessageId: string
  acknowledgement: string
  hadOpening: boolean
  /** Later visible findings must still reach IM; only the opening is deduplicated. */
  followup?: string
}
