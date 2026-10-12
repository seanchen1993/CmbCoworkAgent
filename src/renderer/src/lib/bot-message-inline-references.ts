import type { BotMessage } from "../../../shared/bot-types"
import {
  botInlineReferenceSpans,
  validInlineReferenceSpans,
  inlineReferenceLabel,
  botInlineReferenceIdentity
} from "../../../shared/bot-inline-references"

/** Legacy or malformed presentation metadata always falls back to the original text. */
export function messageReferenceSpans(message: BotMessage) {
  const parsed = botInlineReferenceSpans.safeParse(message.inlineReferences ?? [])
  if (!parsed.success || !validInlineReferenceSpans(message.text, parsed.data)) return []
  return parsed.data.every(
    (span) =>
      message.text.slice(span.from, span.to) ===
      inlineReferenceLabel(span.reference, {
        entities: message.entityReferences,
        skills: message.skillReferences,
        recipients: message.recipientReferences,
        everyone: true
      })
  )
    ? parsed.data
    : []
}

export function messageInlineReferenceKeys(message: BotMessage) {
  return new Set(
    messageReferenceSpans(message).map((span) => botInlineReferenceIdentity(span.reference))
  )
}
