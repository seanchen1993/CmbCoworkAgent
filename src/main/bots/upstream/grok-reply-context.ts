// Extracted unchanged from Grok Bot 0.18; see PROVENANCE.json.
export interface ReplyContext {
  readonly targetId: string
  readonly quote: string
}
export function buildReplyContextNote(replyContext: unknown): string {
  if (
    typeof replyContext !== "object" ||
    replyContext == null ||
    !("targetId" in replyContext) ||
    !("quote" in replyContext)
  )
    return ""
  if (typeof replyContext.targetId !== "string" || typeof replyContext.quote !== "string") return ""
  const targetId = replyContext.targetId.trim(),
    quote = replyContext.quote.trim()
  return targetId.length === 0 || quote.length === 0 ? "" : `[In reply to ${targetId}: "${quote}"]`
}
