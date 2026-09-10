import {
  projectChatSearchFragment,
  projectChatSearchUserBlocks
} from "./chat-search-visible-content"
import { createChatSearchPlan } from "./chat-search-plan"
import { stripThinkBlocksForDisplay } from "./think-block-display"
import { cleanUserAttachmentContentForDisplay } from "./user-attachment-display"
import type {
  ChatSearchLocation,
  ChatSearchPlan,
  ChatSearchSourceSegment
} from "./chat-search-types"

export interface ProjectedChatSearchSegment extends Omit<ChatSearchSourceSegment, "raw"> {
  text: string
  revision: string
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

function projectChatSearchSegments(plan: ChatSearchPlan): ProjectedChatSearchSegment[] {
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
  if (plan.role === "user" && joined.filter((source) => source.kind === "body").length > 1) {
    const body = joined.filter((source) => source.kind === "body")
    const text = projectChatSearchUserBlocks(body.map((source) => source.raw))
    const summary = projectChatSearchPlan({
      ...plan,
      segments: joined.filter((source) => source.kind !== "body")
    })
    return [
      {
        kind: "body",
        blockIndex: -1,
        start: 0,
        end: text.length,
        sourceLength: text.length,
        text,
        revision: chatSearchRevision(text)
      },
      ...summary
    ]
  }
  return joined.flatMap(({ raw, ...source }) => {
    if (source.stripThink && source.kind === "body") {
      const visiblePlan = createChatSearchPlan(plan.role, stripThinkBlocksForDisplay(raw))
      return projectChatSearchPlan(visiblePlan).map((segment) => ({
        ...segment,
        blockIndex: source.blockIndex
      }))
    }
    const visible =
      plan.cleanAttachments && source.kind === "body"
        ? cleanUserAttachmentContentForDisplay(raw)
        : raw
    const text = source.kind === "summary" ? raw : projectChatSearchFragment(plan.role, visible)
    return { ...source, text, revision: chatSearchRevision(text) }
  })
}

/** The admitted plan owns its coverage flag, including presentation text added by controls. */
export function projectChatSearchPlan(plan: ChatSearchPlan): ProjectedChatSearchSegment[] {
  let remaining = 256 * 1024
  return projectChatSearchSegments(plan).flatMap((segment) => {
    if (segment.text.length <= remaining) {
      remaining -= segment.text.length
      return [segment]
    }
    plan.truncated = true
    const text = segment.text.slice(0, remaining)
    remaining = 0
    return text ? [{ ...segment, text, revision: chatSearchRevision(text) }] : []
  })
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
  const normalized = text.toLowerCase()
  const needle = query.trim().toLowerCase()
  if (!needle || needle.length > 256 || limit <= 0) return []
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
  let from = 0
  while (ranges.length < limit) {
    const index = normalized.indexOf(needle, from)
    if (index < 0) break
    const end = index + needle.length
    ranges.push({
      start: offsets?.[index] ?? index,
      end: offsets ? Math.max(offsets[end], offsets[end - 1] + 1) : end
    })
    from = end
  }
  return ranges
}

export function* iterateChatSearchLocations(
  segments: readonly ProjectedChatSearchSegment[],
  query: string,
  limit = 1001
): Generator<ChatSearchLocation> {
  let count = 0
  for (const segment of segments) {
    let segmentOccurrence = 0
    for (const range of findChatTextRanges(segment.text, query, limit - count)) {
      const contextStart = Math.max(0, range.start - 80)
      const contextEnd = Math.min(segment.text.length, range.end + 80)
      yield {
        kind: segment.kind,
        blockIndex: segment.blockIndex,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        revision: segment.revision,
        start: range.start,
        end: range.end,
        segmentOccurrence: segmentOccurrence++,
        context: segment.text.slice(contextStart, contextEnd),
        contextStart: range.start - contextStart,
        contextEnd: range.end - contextStart
      }
      count += 1
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
  const segment = segments.find(
    (candidate) =>
      candidate.kind === location.kind &&
      candidate.blockIndex === location.blockIndex &&
      candidate.start === location.sourceStart &&
      candidate.end >= location.sourceEnd &&
      candidate.text.length >= length
  )
  if (!segment || location.start < 0 || location.end > length) return false
  const text = segment.text.slice(0, length)
  return (
    chatSearchRevision(text) === location.revision &&
    text.slice(location.start, location.end) ===
      location.context.slice(location.contextStart, location.contextEnd)
  )
}
