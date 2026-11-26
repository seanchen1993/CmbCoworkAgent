import {
  projectChatSearchFragment,
  projectChatSearchUserBlocks
} from "./chat-search-visible-content"
import { createChatSearchPlan } from "./chat-search-plan"
import {
  markdownPossibleSourceText,
  markdownSearchAdmission,
  projectMarkdownVisibleText,
  type MarkdownSearchProjection,
  type MarkdownSearchSpan
} from "./markdown-visible-text"
import { getSystemNoticePresentation, parseGoalNoticeText } from "./goal-notice-presentation"
import { splitBotInlineReasoning } from "./bots/inline-reasoning"
import { stripThinkBlocksForDisplay } from "./think-block-display"
import { cleanUserAttachmentContentForDisplay } from "./user-attachment-display"
import { THREAD_SEARCH_QUERY_LIMIT } from "./thread-search-types"
import { buildStreamingMarkdownPreview, MAX_STREAMING_MARKDOWN_RENDER_CHARS } from "./streaming-markdown-preview"
import type {
  ChatSearchLocation,
  ChatSearchPlan,
  ChatSearchSourceSegment
} from "./chat-search-types"

export interface ProjectedChatSearchSegment extends Omit<ChatSearchSourceSegment, "raw"> {
  text: string
  revision: string
  foldedPreview?: boolean
  sourceSpans?: MarkdownSearchSpan[]
}

/** Hash only an admitted fragment. Used with source coordinates and text revalidation. */
export function chatSearchRevision(text: string): string {
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < text.length; index += 1) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619)
    second = Math.imul(second, 33) ^ text.charCodeAt(index)
  }
  return `${text.length}:${first >>> 0}:${second >>> 0}`
}

function joinSearchSourceSegments(plan: ChatSearchPlan): ChatSearchSourceSegment[] {
  const joined: ChatSearchSourceSegment[] = []
  for (const segment of plan.segments) {
    const previous = joined.at(-1)
    if (
      previous &&
      previous.kind === segment.kind &&
      previous.blockIndex === segment.blockIndex &&
      previous.end === segment.start &&
      previous.stripThink === segment.stripThink
    ) {
      previous.raw += segment.raw
      previous.end = segment.end
    } else joined.push({ ...segment })
  }
  return joined
}

function projectChatSearchSegments(
  plan: ChatSearchPlan,
  deferRevision: boolean
): ProjectedChatSearchSegment[] {
  const joined = joinSearchSourceSegments(plan)
  if (plan.role === "user" && joined.filter((source) => source.kind === "body").length > 1) {
    const body = joined.filter((source) => source.kind === "body")
    const text = projectChatSearchUserBlocks(body.map((source) => source.raw), Boolean(plan.sideUserContent))
    const summary = projectChatSearchPlan(
      {
        ...plan,
        segments: joined.filter((source) => source.kind !== "body")
      },
      deferRevision
    )
    return [
      {
        kind: "body",
        blockIndex: -1,
        start: 0,
        end: text.length,
        sourceLength: text.length,
        text,
        revision: deferRevision ? "" : chatSearchRevision(text)
      },
      ...summary
    ]
  }
  const projected = joined.flatMap<ProjectedChatSearchSegment>(({ raw, ...source }) => {
    if (source.stripThink && source.kind === "body") {
      const body = source.stripThink === "leading"
        ? splitBotInlineReasoning(raw).body
        : stripThinkBlocksForDisplay(raw)
      const visiblePlan = createChatSearchPlan(plan.role, body)
      const segments = projectChatSearchPlan(visiblePlan, deferRevision).map((segment) => ({
        ...segment,
        blockIndex: source.blockIndex
      }))
      plan.truncated ||= visiblePlan.truncated
      return segments
    }
    const visible =
      plan.cleanAttachments && source.kind === "body"
        ? cleanUserAttachmentContentForDisplay(raw)
        : raw
    const projection: MarkdownSearchProjection = source.kind === "summary"
      ? { text: raw, truncated: false }
      : projectChatSearchFragment(plan.role, visible, {
        trackSource: source.sourceLength > MAX_STREAMING_MARKDOWN_RENDER_CHARS,
        sideUserContent: plan.sideUserContent
      })
    const { text, truncated, sourceSpans } = projection
    plan.truncated ||= truncated
    return { ...source, text, ...(sourceSpans ? { sourceSpans } : {}),
      revision: deferRevision ? "" : chatSearchRevision(text) }
  })
  const previewSources: ChatSearchSourceSegment[] = []
  if (plan.role === "assistant") previewSources.push(...plan.segments)
  if (plan.role === "system") {
    for (const source of joined) {
      if (source.kind !== "body" || source.raw.length <= MAX_STREAMING_MARKDOWN_RENDER_CHARS) continue
      const notice = getSystemNoticePresentation(source.raw).text
      if (parseGoalNoticeText(notice)) continue
      const preview = buildStreamingMarkdownPreview(notice)
      if (!preview.omittedCharacters) continue
      previewSources.push({ ...source, raw: preview.head, start: 0, end: preview.head.length,
        sourceLength: notice.length }, { ...source, raw: preview.tail,
        start: notice.length - preview.tail.length, end: notice.length, sourceLength: notice.length })
    }
  }
  for (const { raw, ...source } of previewSources) {
    if (source.kind !== "body" || source.stripThink || source.sourceLength <= MAX_STREAMING_MARKDOWN_RENDER_CHARS ||
        (source.start !== 0 && source.end !== source.sourceLength)) continue
    const whole = projected.find((part) => !part.foldedPreview && part.kind === "body" &&
      part.blockIndex === source.blockIndex && part.start <= source.start && part.end >= source.end)
    if (!whole || (whole.start === source.start && whole.end === source.end)) continue
    const preview = projectMarkdownVisibleText(raw, true)
    plan.truncated ||= preview.truncated
    const anchor = preview.sourceSpans?.find((span) => span.sourceEnd === undefined)
    const anchorOffset = anchor ? source.start + anchor.sourceStart - whole.start : -1
    const wholeSpan = whole.sourceSpans?.find((span) => span.sourceEnd === undefined && anchorOffset >= span.sourceStart &&
      anchorOffset < span.sourceStart + span.end - span.start)
    const sameTextOffset = anchor && wholeSpan
      ? wholeSpan.start + anchorOffset - wholeSpan.sourceStart - anchor.start
      : -1
    if (preview.text && (sameTextOffset < 0 || !whole.text.startsWith(preview.text, sameTextOffset))) {
      projected.push({ ...source, text: preview.text, foldedPreview: true,
        sourceSpans: preview.sourceSpans,
        revision: deferRevision ? "" : chatSearchRevision(preview.text) })
    }
  }
  return projected
}

/** The admitted plan owns its coverage flag, including presentation text added by controls. */
export function projectChatSearchPlan(
  plan: ChatSearchPlan,
  deferRevision = false
): ProjectedChatSearchSegment[] {
  const remaining = { body: 256 * 1024, preview: 256 * 1024 }
  return projectChatSearchSegments(plan, deferRevision).flatMap((segment) => {
    const budget = segment.foldedPreview ? "preview" : "body"
    if (segment.text.length <= remaining[budget]) {
      remaining[budget] -= segment.text.length
      return [segment]
    }
    plan.truncated = true
    const text = segment.text.slice(0, remaining[budget])
    remaining[budget] = 0
    return text
      ? [{ ...segment, text, revision: deferRevision ? "" : chatSearchRevision(text) }]
      : []
  })
}

/** Exclude impossible body matches before running the Markdown projector. */
export function createChatSearchPlanQueryFilter(query: string): (plan: ChatSearchPlan) => boolean {
  const needle = query.trim().toLowerCase()
  if (!needle || /[\r\n]/.test(needle)) return () => true
  // Compare only characters preserved by markup and unaffected by context-dependent case folding.
  const required = Array.from(needle).filter((character) =>
    /[a-z0-9]/.test(character) ||
    (/[\p{L}\p{N}\p{S}]/u.test(character) && !/\p{Cased}/u.test(character))
  )
  const couldMatchBlock = (block: string) => {
    const lower = block.toLowerCase()
    if (lower.includes(needle)) return true
    // Whitespace removed at a line ending cannot produce a new literal match
    // that does not itself contain a line break.
    if (markdownSearchAdmission(block.replaceAll(" \n", "\n").trimEnd()) === "literal") return false
    const possible = markdownPossibleSourceText(block).toLowerCase()
    let offset = 0
    for (const character of required) {
      const index = possible.indexOf(character, offset)
      if (index < 0) return false
      offset = index + character.length
    }
    return true
  }
  const couldMatchBody = (body: string, plan: ChatSearchPlan, mayHaveFoldedPreview: boolean) => {
    const admission = markdownSearchAdmission(body)
    if (admission === "truncated") {
      plan.truncated = true
      return mayHaveFoldedPreview
    }
    if (body.includes("[^") && /\[\^[^\r\n]{1,999}?\]:/.test(body)) return true
    const text = body.toLowerCase()
    if (text.includes(needle)) return true
    if (admission === "literal") return false
    const absent = required.find((character) => !text.includes(character))
    if (absent) {
      const possible = markdownPossibleSourceText(body)
      if (possible === body || !possible.toLowerCase().includes(absent)) return false
    }
    // A blank source line remains a line break between visible blocks, or is
    // literal inside code/HTML. Footnotes can move content between blocks.
    return body.split(/\r?\n[ \t]*\r?\n/).some(couldMatchBlock)
  }
  return (plan) => {
    // User and system controls can introduce display words missing from raw text.
    if (plan.role === "user" || plan.role === "system") return true
    const segments = plan.segments.length > 1 ? joinSearchSourceSegments(plan) : plan.segments
    return segments.some((segment) => segment.kind === "summary"
      ? segment.raw.toLowerCase().includes(needle)
      : segment.stripThink || couldMatchBody(segment.raw, plan,
        segment.sourceLength > MAX_STREAMING_MARKDOWN_RENDER_CHARS))
  }
}

/** Offsets always refer to the original UTF-16 text, even when case folding grows a character. */
export function findChatTextRanges(
  text: string,
  query: string,
  limit: number
): Array<{
  start: number
  end: number
}> {
  const trimmedQuery = query.trim()
  if (!trimmedQuery || trimmedQuery.length > THREAD_SEARCH_QUERY_LIMIT || limit <= 0) return []
  const needle = trimmedQuery.toLowerCase()
  const normalized = text.toLowerCase()
  let index = normalized.indexOf(needle)
  if (index === -1) return []
  let offsets: Uint32Array | undefined
  if (normalized.length !== text.length) {
    offsets = new Uint32Array(normalized.length + 1)
    let original = 0
    let folded = 0
    for (const character of text) {
      const length = character.toLowerCase().length
      for (let index = 0; index < length; index += 1) offsets[folded++] = original
      original += character.length
      offsets[folded] = original
    }
  }
  const ranges: Array<{ start: number; end: number }> = []
  while (index !== -1 && ranges.length < limit) {
    const end = index + needle.length
    ranges.push({
      start: offsets?.[index] ?? index,
      end: offsets ? Math.max(offsets[end], offsets[end - 1] + 1) : end
    })
    if (ranges.length < limit) index = normalized.indexOf(needle, end)
  }
  return ranges
}

export function* iterateChatSearchLocations(
  segments: readonly ProjectedChatSearchSegment[],
  query: string,
  limit = 1001
): Generator<ChatSearchLocation> {
  let count = 0
  const matchedSources = new Set<string>()
  const matchedNodes = new Map<string, string>()
  for (const segment of segments) {
    let segmentOccurrence = 0
    let revision = segment.revision
    for (const range of findChatTextRanges(segment.text, query, segment.foldedPreview ? limit : limit - count)) {
      const occurrence = segmentOccurrence++
      const covers = (part: MarkdownSearchSpan) => range.start >= part.start && range.start < part.end
      const span = segment.sourceSpans?.find((part) => part.sourceEnd === undefined && covers(part))
      if (span) {
        const sourceOffset = segment.start + span.sourceStart + range.start - span.start
        const key = `${segment.blockIndex}:${sourceOffset}`
        if (segment.foldedPreview && matchedSources.has(key)) continue
        if (!segment.foldedPreview) matchedSources.add(key)
      }
      const node = segment.sourceSpans?.find((part) => part.sourceEnd !== undefined && covers(part))
      if (node?.sourceEnd !== undefined) {
        const start = segment.start + node.sourceStart
        const end = segment.start + node.sourceEnd
        const key = `${segment.blockIndex}:${start}:${end}:${range.start - node.start}`
        const value = segment.text.slice(node.start, node.end)
        if (segment.foldedPreview && matchedNodes.get(key) === value) continue
        if (!segment.foldedPreview) matchedNodes.set(key, value)
      }
      revision ||= chatSearchRevision(segment.text)
      const contextStart = Math.max(0, range.start - 80)
      const contextEnd = Math.min(segment.text.length, range.end + 80)
      yield {
        kind: segment.kind,
        blockIndex: segment.blockIndex,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        revision,
        start: range.start,
        end: range.end,
        segmentOccurrence: occurrence,
        context: segment.text.slice(contextStart, contextEnd),
        contextStart: range.start - contextStart,
        contextEnd: range.end - contextStart
      }
      if (++count >= limit) return
    }
    if (count >= limit) break
  }
}

export function findChatSearchLocations(
  segments: readonly ProjectedChatSearchSegment[],
  query: string,
  limit = 1001
): ChatSearchLocation[] {
  return [...iterateChatSearchLocations(segments, query, limit)]
}

/** Revalidate a locator against the current visible projection before revealing its context. */
export function validateChatSearchLocation(
  segments: readonly ProjectedChatSearchSegment[],
  location: ChatSearchLocation
): boolean {
  const length = Number(location.revision.split(":", 1)[0])
  if (!Number.isSafeInteger(length) || length < 0 || length > 256 * 1024) return false
  if (location.start < 0 || location.end > length) return false
  return segments.some(
    (candidate) =>
      candidate.kind === location.kind &&
      candidate.blockIndex === location.blockIndex &&
      candidate.start === location.sourceStart &&
      candidate.end >= location.sourceEnd &&
      candidate.text.length >= length &&
      chatSearchRevision(candidate.text.slice(0, length)) === location.revision &&
      candidate.text.slice(location.start, location.end) ===
        location.context.slice(location.contextStart, location.contextEnd)
  )
}
