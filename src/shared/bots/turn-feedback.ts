/** Host control receipts are not execution failures. Unknown or errored results stay errors. */
export const BOT_CONTINUATION_KIND = "bot-foreground-continuation"

export const BOT_TOOL_OPENING = "我来看看。"

/** Announce a handoff only after its native receipt. Earlier tool prose is private. */
export function isBotHandoffCall(call: unknown): boolean {
  if (!call || typeof call !== "object" || !("name" in call)) return false
  if (call.name === "bot_skill_dispatch" || call.name === "bot_work_create" || call.name === "bot_work_send") return true
  if (call.name !== "bot_feature_update" || !("args" in call)) return false
  const args = call.args
  return !!args && typeof args === "object" && "action" in args &&
    ["session", "continue", "manage"].includes(String(args.action))
}

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
