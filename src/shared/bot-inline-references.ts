import { z } from "zod"
import { botEntitySelection, type BotEntityReference } from "./bot-entity-references"
import { botSkillSelection, type BotSkillReference } from "./bot-skill-references"
import type { BotRecipientReference } from "./bot-recipients"

const address = z.union([
  botEntitySelection,
  botSkillSelection.extend({ kind: z.literal("skill") }).strict(),
  z.object({ kind: z.literal("recipient"), id: z.string().regex(/^[\w:.-]{1,160}$/) }).strict(),
  z.object({ kind: z.literal("everyone"), id: z.literal("everyone") }).strict()
])
export const botInlineReferenceSpans = z
  .array(
    z
      .object({
        from: z.number().int().min(0).max(64_000),
        to: z.number().int().min(1).max(64_000),
        reference: address
      })
      .strict()
  )
  .max(64)
export type BotInlineReferenceSpan = z.infer<typeof botInlineReferenceSpans>[number]
export type BotInlineReferenceAddress = BotInlineReferenceSpan["reference"]

export function botInlineReferenceIdentity(reference: BotInlineReferenceAddress): string {
  return reference.kind === "skill"
    ? `skill:${reference.botId}:${reference.id}:${reference.version}`
    : `${reference.kind}:${reference.id}`
}

/** UTF-16 offsets refer only to the exact persisted plain text, never to HTML.
 * Keep a bounded, ordered, non-overlapping set and do not split surrogate pairs.
 */
export function validInlineReferenceSpans(
  text: string,
  spans: readonly BotInlineReferenceSpan[]
): boolean {
  const boundary = (position: number) => {
    const before = text.charCodeAt(position - 1),
      after = text.charCodeAt(position)
    return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
  }
  let end = 0
  for (const span of spans) {
    if (
      span.from < end ||
      span.to <= span.from ||
      span.to > text.length ||
      !boundary(span.from) ||
      !boundary(span.to)
    )
      return false
    const label = text.slice(span.from, span.to)
    if (
      !label.startsWith(span.reference.kind === "skill" ? "/" : "@") ||
      label.length < 2 ||
      label.length > 201 ||
      /[\r\n\0]/.test(label)
    )
      return false
    end = span.to
  }
  return true
}

/** Canonical labels are Host-resolved send-time metadata, not new authority. */
export function inlineReferenceLabel(
  reference: BotInlineReferenceAddress,
  selected: {
    entities?: readonly BotEntityReference[]
    skills?: readonly BotSkillReference[]
    recipients?: readonly BotRecipientReference[]
    everyone?: boolean
  }
): string | null {
  if (reference.kind === "everyone") return selected.everyone ? "@全体 Bot" : null
  if (reference.kind === "recipient") {
    const item = selected.recipients?.find((item) => item.botId === reference.id)
    return item ? `@${item.name}` : null
  }
  if (reference.kind === "skill") {
    const item = selected.skills?.find(
      (item) =>
        item.id === reference.id &&
        item.botId === reference.botId &&
        item.version === reference.version
    )
    return item ? `/${item.name}` : null
  }
  const item = selected.entities?.find(
    (item) => item.kind === reference.kind && item.id === reference.id
  )
  return item ? `@${item.name}` : null
}
