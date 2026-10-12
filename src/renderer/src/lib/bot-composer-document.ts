import { z } from "zod"
import { botEntityReference, type BotEntityReference } from "../../../shared/bot-entity-references"
import { botSkillReference, type BotSkillReference } from "../../../shared/bot-skill-references"
import type { BotComposerDraft } from "./bot-composer-draft"
import type { BotInlineReferenceSpan } from "../../../shared/bot-inline-references"
import {
  botSelectionQuote,
  quoteText,
  BOT_SELECTION_QUOTE_LIMIT,
  type BotSelectionQuoteSpan
} from "../../../shared/bot-selection-quotes"

export const BOT_COMPOSER_TEXT_LIMIT = 64_000
const recipient = z
  .object({
    kind: z.literal("recipient"),
    id: z.string().regex(/^[\w:.-]{1,160}$/),
    name: z.string().min(1).max(100)
  })
  .strict()
export const botInlineReference = z.union([
  botEntityReference,
  botSkillReference.extend({ kind: z.literal("skill") }).strict(),
  recipient,
  z
    .object({ kind: z.literal("everyone"), id: z.literal("everyone"), name: z.literal("全体 Bot") })
    .strict()
])
export type BotInlineReference = z.infer<typeof botInlineReference>

const safeLink = z
  .string()
  .max(8192)
  .refine((value) => /^(https?:|mailto:)/i.test(value))
const mark = z
  .object({ type: z.literal("link"), attrs: z.object({ href: safeLink }).strip() })
  .strip()
const inline = z.union([
  z
    .object({
      type: z.literal("text"),
      text: z.string().min(1).max(BOT_COMPOSER_TEXT_LIMIT),
      marks: z.array(mark).max(1).optional()
    })
    .strip(),
  z.object({ type: z.literal("hardBreak") }).strip(),
  z
    .object({
      type: z.literal("quoteReference"),
      attrs: z.object({ quote: botSelectionQuote }).strict()
    })
    .strip(),
  z
    .object({
      type: z.literal("botReference"),
      attrs: z.object({ reference: botInlineReference }).strict()
    })
    .strip()
])
const document = z
  .object({
    type: z.literal("doc"),
    content: z
      .array(
        z
          .object({ type: z.literal("paragraph"), content: z.array(inline).max(16_000).optional() })
          .strip()
      )
      .min(1)
      .max(16_000)
  })
  .strip()
export type BotComposerDocument = z.infer<typeof document>

export function inlineReferenceKey(reference: BotInlineReference): string {
  return reference.kind === "skill"
    ? `skill:${reference.botId}:${reference.id}`
    : `${reference.kind}:${reference.id}`
}

export function inlineReferenceText(reference: BotInlineReference): string {
  return `${reference.kind === "skill" ? "/" : "@"}${reference.name}`
}

/** Grok's paragraph/hard-break/link serialization, with Cmb's typed identities.
 * Rendered labels are data; IDs remain separately validated by the Host. */
export function composerDocumentText(doc: BotComposerDocument): string {
  return composerDocumentPayload(doc).text
}

/** Positions are produced by the same serializer as model-visible message text. */
export function composerDocumentPayload(doc: BotComposerDocument): {
  text: string
  inlineReferences: BotInlineReferenceSpan[]
  selectionQuotes: BotSelectionQuoteSpan[]
} {
  const pieces: string[] = [],
    inlineReferences: BotInlineReferenceSpan[] = [],
    selectionQuotes: BotSelectionQuoteSpan[] = []
  let offset = 0
  const append = (value: string) => {
    pieces.push(value)
    offset += value.length
  }
  doc.content.forEach((paragraph, paragraphIndex) => {
    if (paragraphIndex) append("\n")
    const nodes = paragraph.content ?? []
    nodes.forEach((node, index) => {
      if (node.type === "hardBreak") {
        append("\n")
        return
      }
      if (node.type === "quoteReference") {
        const from = offset
        append(quoteText(node.attrs.quote))
        selectionQuotes.push({ from, to: offset, quote: node.attrs.quote })
        return
      }
      if (node.type === "botReference") {
        const reference = node.attrs.reference,
          from = offset
        append(inlineReferenceText(reference))
        inlineReferences.push({
          from,
          to: offset,
          reference:
            reference.kind === "skill"
              ? {
                  kind: "skill",
                  botId: reference.botId,
                  id: reference.id,
                  version: reference.version
                }
              : reference.kind === "everyone"
                ? { kind: "everyone", id: "everyone" }
                : { kind: reference.kind, id: reference.id }
        })
        return
      }
      const href = node.marks?.[0].attrs.href
      const value = node.text.trim()
      if (!href || [href, `https://${href}`, `http://${href}`, `mailto:${href}`].includes(value)) {
        append(node.text)
        return
      }
      const next = nodes[index + 1]
      append(
        next?.type === "text" && next.marks?.[0].attrs.href === href
          ? node.text
          : `${node.text} (${href})`
      )
    })
  })
  return { text: pieces.join(""), inlineReferences, selectionQuotes }
}

export function composerDraftInlineReferences(draft: BotComposerDraft): BotInlineReferenceSpan[] {
  if (!draft.richText) return []
  const payload = composerDocumentPayload(composerDocument(draft))
  return payload.text === draft.prompt ? payload.inlineReferences : []
}

export function composerDraftSelectionQuotes(draft: BotComposerDraft): BotSelectionQuoteSpan[] {
  if (!draft.richText) return []
  const payload = composerDocumentPayload(composerDocument(draft))
  return payload.text === draft.prompt ? payload.selectionQuotes : []
}

export function parseComposerDocument(value: unknown): BotComposerDocument | null {
  const result = document.safeParse(value)
  if (!result.success) return null
  const doc = result.data
  let nodes = 0
  for (const paragraph of doc.content) nodes += 1 + (paragraph.content?.length ?? 0)
  const quotes = doc.content.flatMap((paragraph) =>
    (paragraph.content ?? []).filter((node) => node.type === "quoteReference")
  )
  if (quotes.length > BOT_SELECTION_QUOTE_LIMIT) return null
  const selected = composerDocumentReferences(doc)
  // Repeated identities still create separate avatar/React node views. Bound
  // their rendered count as well as the number of unique Host selections.
  if (selected.length > 64) return null
  for (const [kind, limit] of [
    ["skill", 6],
    ["recipient", 6],
    ["entity", 12]
  ] as const) {
    const keys = new Set(
      selected
        .filter((ref) =>
          kind === "entity"
            ? ref.kind !== "skill" && ref.kind !== "recipient" && ref.kind !== "everyone"
            : ref.kind === kind
        )
        .map(inlineReferenceKey)
    )
    if (keys.size > limit) return null
  }
  return nodes <= 16_000 && composerDocumentText(doc).length <= BOT_COMPOSER_TEXT_LIMIT ? doc : null
}

function savedDocument(richText?: string): BotComposerDocument | null {
  if (!richText || richText.length > 2 * 1024 * 1024) return null
  try {
    return parseComposerDocument(JSON.parse(richText))
  } catch {
    return null
  }
}

export function composerDocumentReferences(doc: BotComposerDocument): BotInlineReference[] {
  return doc.content.flatMap((paragraph) =>
    (paragraph.content ?? []).flatMap((node) =>
      node.type === "botReference" ? [node.attrs.reference] : []
    )
  )
}

/** Restore legacy text/selection drafts and reconcile external remove buttons.
 * Unsupported persisted HTML/JSON never becomes editor markup. */
export function composerDocument(draft: BotComposerDraft): BotComposerDocument {
  const saved = savedDocument(draft.richText)
  const doc: BotComposerDocument = saved ?? {
    type: "doc",
    content: draft.prompt.split("\n").map((text) => ({
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {})
    }))
  }
  const expected = new Map<string, BotInlineReference>([
    ...(draft.skills ?? []).map((skill) => {
      const ref = { ...skill, kind: "skill" as const }
      return [inlineReferenceKey(ref), ref] as const
    }),
    ...(draft.references ?? []).map((ref) => [inlineReferenceKey(ref), ref] as const)
  ])
  const seen = new Set<string>()
  for (const paragraph of doc.content) {
    paragraph.content = (paragraph.content ?? []).flatMap<z.infer<typeof inline>>((node) => {
      if (node.type !== "botReference") return [node]
      const reference = node.attrs.reference
      const key = inlineReferenceKey(reference)
      if (reference.kind === "recipient")
        return draft.recipients?.includes(reference.id) ? [node] : []
      if (reference.kind === "everyone") return draft.recipients?.length ? [] : [node]
      const current = expected.get(key)
      if (!current) return []
      seen.add(key)
      return [{ type: "botReference" as const, attrs: { reference: current } }]
    })
  }
  const missing = [...expected]
    .filter(([key]) => !seen.has(key))
    .flatMap(([, reference]) => [
      { type: "botReference" as const, attrs: { reference } },
      { type: "text" as const, text: " " }
    ])
  if (missing.length) doc.content[0].content = [...missing, ...(doc.content[0].content ?? [])]
  for (const paragraph of doc.content) if (!paragraph.content?.length) delete paragraph.content
  return doc
}

/** A single editor transaction owns text and its reference selections together. */
export function composerDocumentChange(
  doc: unknown,
  draft: BotComposerDraft
): Partial<BotComposerDraft> | null {
  const parsed = parseComposerDocument(doc)
  if (!parsed) return null
  const skills = new Map<string, BotSkillReference>()
  const references = new Map<string, BotEntityReference>()
  const previous = savedDocument(draft.richText)
  const priorInline = previous
    ? composerDocumentReferences(previous)
        .filter((ref) => ref.kind === "recipient")
        .map((ref) => ref.id)
    : []
  const recipients = new Set((draft.recipients ?? []).filter((id) => !priorInline.includes(id)))
  for (const ref of composerDocumentReferences(parsed)) {
    if (ref.kind === "skill") {
      skills.set(inlineReferenceKey(ref), {
        botId: ref.botId,
        id: ref.id,
        version: ref.version,
        name: ref.name
      })
    } else if (ref.kind === "recipient") recipients.add(ref.id)
    else if (ref.kind === "everyone") recipients.clear()
    else references.set(inlineReferenceKey(ref), ref)
  }
  if (skills.size > 6 || references.size > 12 || recipients.size > 6) return null
  const prompt = composerDocumentText(parsed)
  return {
    prompt,
    richText: prompt ? JSON.stringify(parsed) : undefined,
    skills: [...skills.values()],
    references: [...references.values()],
    recipients: [...recipients]
  }
}

/** Append an explicit UI instruction without flattening existing inline identities. */
export function appendComposerText(
  draft: BotComposerDraft,
  text: string
): Partial<BotComposerDraft> | null {
  const previous = composerDocument(draft)
  const paragraphs = text.split("\n").map((line) => ({
    type: "paragraph" as const,
    ...(line ? { content: [{ type: "text" as const, text: line }] } : {})
  }))
  return composerDocumentChange(
    {
      type: "doc",
      content: composerDocumentText(previous)
        ? [...previous.content, { type: "paragraph" }, ...paragraphs]
        : paragraphs
    },
    draft
  )
}
