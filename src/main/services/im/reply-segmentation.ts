import { createHash } from "node:crypto"
import {
  IM_GATEWAY_SCHEMA_VERSION,
  IM_REPLY_MAX_SEGMENT_CHARACTERS,
  IM_REPLY_MAX_SEGMENTS,
  type RemoteImReplyFormat,
  type RemoteImReplyV1
} from "../../../shared/im-gateway-contract"
import type { ImEventRecord } from "./event-store"

export const IM_REPLY_TRUNCATION_NOTICE = "内容已截断，完整结果请在桌面 Thread 查看。"

function codePoints(value: string): string[] {
  return Array.from(value)
}

function lengthOf(value: string): number {
  return codePoints(value).length
}

function takeAtBoundary(points: string[], maxCharacters: number): { head: string; tail: string[] } {
  if (points.length <= maxCharacters) return { head: points.join(""), tail: [] }
  const lowerBound = Math.max(1, Math.floor(maxCharacters * 0.45))
  let boundary = -1
  for (let index = maxCharacters - 1; index >= lowerBound; index -= 1) {
    const current = points[index]
    const previous = points[index - 1]
    if (
      current === "\n" ||
      (current === " " && previous !== " ") ||
      "。！？；.!?;".includes(current)
    ) {
      boundary = index + 1
      break
    }
  }
  const end = boundary > 0 ? boundary : maxCharacters
  return {
    head: points.slice(0, end).join("").trimEnd(),
    tail: points.slice(end)
  }
}

function visibleSegmentPrefix(prefix: string, index: number, count: number): string {
  const targetPrefix = index === 0 && prefix.trim() ? `${prefix.trim()}\n` : ""
  return count > 1 ? `${targetPrefix}[${index + 1}/${count}] ` : targetPrefix
}

export interface SegmentImReplyOptions {
  prefix?: string
  maxCharacters?: number
  maxSegments?: number
  singleSegmentOverflow?: {
    minimumHeadCharacters: number
    minimumTailCharacters: number
  }
}

export function segmentImReplyText(text: string, options: SegmentImReplyOptions = {}): string[] {
  const maxCharacters = options.maxCharacters ?? IM_REPLY_MAX_SEGMENT_CHARACTERS
  const maxSegments = options.maxSegments ?? IM_REPLY_MAX_SEGMENTS
  const prefix = options.prefix?.trim() ?? ""
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new Error("maxCharacters must be an integer of at least 32")
  }
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 8) {
    throw new Error("maxSegments must be between 1 and 8")
  }

  const normalized = text.trim() || "处理完成。"
  const singlePrefix = visibleSegmentPrefix(prefix, 0, 1)
  if (lengthOf(singlePrefix) + lengthOf(normalized) <= maxCharacters) {
    return [`${singlePrefix}${normalized}`]
  }

  const singleSegmentOverflow = options.singleSegmentOverflow
  if (singleSegmentOverflow) {
    if (maxSegments !== 1) {
      throw new Error("singleSegmentOverflow requires maxSegments to be 1")
    }
    const { minimumHeadCharacters, minimumTailCharacters } = singleSegmentOverflow
    if (
      !Number.isSafeInteger(minimumHeadCharacters) ||
      minimumHeadCharacters < 1 ||
      !Number.isSafeInteger(minimumTailCharacters) ||
      minimumTailCharacters < 1
    ) {
      throw new Error("singleSegmentOverflow character counts must be positive integers")
    }
    const notice = `\n\n${IM_REPLY_TRUNCATION_NOTICE}\n\n`
    const contentBudget = maxCharacters - lengthOf(singlePrefix) - lengthOf(notice)
    if (minimumHeadCharacters + minimumTailCharacters > contentBudget) {
      throw new Error("singleSegmentOverflow content exceeds the segment character limit")
    }
    const additionalCharacters = contentBudget - minimumHeadCharacters - minimumTailCharacters
    const headCharacters = minimumHeadCharacters + Math.ceil(additionalCharacters / 2)
    const tailCharacters = minimumTailCharacters + Math.floor(additionalCharacters / 2)
    const points = codePoints(normalized)
    return [
      `${singlePrefix}${points.slice(0, headCharacters).join("")}${notice}${points.slice(-tailCharacters).join("")}`
    ]
  }

  // V1 caps at eight segments, so every [i/n] marker has the same six-character
  // upper bound. Splitting against that bound makes the later count immutable.
  const markerBudget = Math.max(
    lengthOf(visibleSegmentPrefix(prefix, 0, 8)),
    lengthOf(visibleSegmentPrefix(prefix, 7, 8))
  )
  const payloadBudget = maxCharacters - markerBudget
  if (payloadBudget < 1) throw new Error("Reply prefix leaves no room for content")

  const chunks: string[] = []
  let remaining = codePoints(normalized)
  while (remaining.length > 0 && chunks.length < maxSegments) {
    const next = takeAtBoundary(remaining, payloadBudget)
    chunks.push(next.head)
    remaining = next.tail
  }

  if (remaining.length > 0) {
    const notice = `\n\n${IM_REPLY_TRUNCATION_NOTICE}`
    const finalPayloadBudget = payloadBudget - lengthOf(notice)
    if (finalPayloadBudget < 1) throw new Error("Reply segment is too small for truncation notice")
    const current = codePoints(chunks[maxSegments - 1] ?? "")
    chunks[maxSegments - 1] = `${takeAtBoundary(current, finalPayloadBudget).head}${notice}`
  }

  const count = chunks.length
  return chunks.map((chunk, index) => `${visibleSegmentPrefix(prefix, index, count)}${chunk}`)
}

/** A fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/u

interface ImOpenFence {
  /** The line that opened it, reused verbatim to reopen it in the next segment. */
  opener: string
  indent: string
  marker: string
}

function fenceAfter(chunk: string, open: ImOpenFence | null): ImOpenFence | null {
  let fence = open
  for (const line of chunk.split("\n")) {
    const match = FENCE_LINE.exec(line)
    if (!match) continue
    const [, indent, marker, rest] = match
    if (!fence) {
      // A backtick fence's info string cannot contain a backtick; such a line
      // is inline code, not an opener.
      if (marker.startsWith("`") && rest.includes("`")) continue
      fence = { opener: line, indent, marker }
    } else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      rest.trim() === ""
    ) {
      fence = null
    }
  }
  return fence
}

/**
 * Prefix lines and the [i/n] marker each stand in their own paragraph. Joined
 * to the body by a single newline, a renderer that folds soft breaks runs them
 * into the first line, and a marker in front of "# 标题" stops it being one.
 */
function markdownSegmentHeader(prefix: string, index: number, count: number): string {
  const parts = index === 0 ? prefix.split("\n").filter((line) => line.trim()) : []
  if (count > 1) parts.push(`[${index + 1}/${count}]`)
  return parts.length > 0 ? `${parts.join("\n\n")}\n\n` : ""
}

/** Prefers a paragraph break, then whatever takeAtBoundary would take. */
function takeMarkdownAtBoundary(
  points: string[],
  maxCharacters: number
): { head: string; tail: string[] } {
  if (points.length <= maxCharacters) return { head: points.join(""), tail: [] }
  const lowerBound = Math.max(1, Math.floor(maxCharacters * 0.45))
  for (let index = maxCharacters - 1; index >= lowerBound; index -= 1) {
    if (points[index] === "\n" && points[index - 1] === "\n") {
      return { head: points.slice(0, index).join("").trimEnd(), tail: points.slice(index + 1) }
    }
  }
  return takeAtBoundary(points, maxCharacters)
}

/**
 * One segment's body within `budget`, closing a code fence the cut leaves open
 * and reopening the one the previous segment closed. Shrinks and cuts again
 * when the closing fence would not fit.
 */
function cutMarkdownSegment(
  points: string[],
  reopen: ImOpenFence | null,
  budget: number
): { body: string; tail: string[]; open: ImOpenFence | null } {
  const opener = reopen ? `${reopen.opener}\n` : ""
  let room = budget - lengthOf(opener)
  for (;;) {
    if (room < 1) throw new Error("Reply segment is too small for its code fence")
    const { head, tail } = takeMarkdownAtBoundary(points, room)
    const open = fenceAfter(head, reopen)
    const closing = open ? `\n${open.indent}${open.marker}` : ""
    const body = `${opener}${head}${closing}`
    if (lengthOf(body) <= budget) return { body, tail, open }
    room -= lengthOf(closing)
  }
}

/**
 * segmentImReplyText for Markdown: every segment becomes its own card, so each
 * has to render on its own. The header stands apart (see
 * markdownSegmentHeader), and a cut inside a fenced code block closes the
 * fence in one segment and reopens it, info string and all, in the next —
 * otherwise the rest of one card renders as code, or the code as prose.
 *
 * The same content goes out unconverted when the reply is sent as text, so
 * nothing here may depend on it being rendered.
 */
export function segmentImMarkdownText(
  text: string,
  options: Omit<SegmentImReplyOptions, "singleSegmentOverflow"> = {}
): string[] {
  const maxCharacters = options.maxCharacters ?? IM_REPLY_MAX_SEGMENT_CHARACTERS
  const maxSegments = options.maxSegments ?? IM_REPLY_MAX_SEGMENTS
  const prefix = options.prefix?.trim() ?? ""
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new Error("maxCharacters must be an integer of at least 32")
  }
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > 8) {
    throw new Error("maxSegments must be between 1 and 8")
  }

  const normalized = text.trim() || "处理完成。"
  const singleHeader = markdownSegmentHeader(prefix, 0, 1)
  if (lengthOf(singleHeader) + lengthOf(normalized) <= maxCharacters) {
    return [`${singleHeader}${normalized}`]
  }

  // As in segmentImReplyText: budget against the widest header any segment
  // can get, so the count decided afterwards cannot push one over the limit.
  const headerBudget = Math.max(
    lengthOf(markdownSegmentHeader(prefix, 0, 8)),
    lengthOf(markdownSegmentHeader(prefix, 7, 8))
  )
  const budget = maxCharacters - headerBudget
  if (budget < 1) throw new Error("Reply prefix leaves no room for content")

  const bodies: string[] = []
  let remaining = codePoints(normalized)
  let reopen: ImOpenFence | null = null
  let lastStart = remaining
  let lastReopen: ImOpenFence | null = null
  while (remaining.length > 0 && bodies.length < maxSegments) {
    lastStart = remaining
    lastReopen = reopen
    const cut = cutMarkdownSegment(remaining, reopen, budget)
    bodies.push(cut.body)
    remaining = cut.tail
    reopen = cut.open
  }

  if (remaining.length > 0) {
    const notice = `\n\n${IM_REPLY_TRUNCATION_NOTICE}`
    const cut = cutMarkdownSegment(lastStart, lastReopen, budget - lengthOf(notice))
    bodies[bodies.length - 1] = `${cut.body}${notice}`
  }

  const count = bodies.length
  return bodies.map((body, index) => `${markdownSegmentHeader(prefix, index, count)}${body}`)
}

export function eventShortCode(eventId: string): string {
  return createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 8).toUpperCase()
}

/**
 * "markdown" is for what the Agent wrote, and only that: it lets the gateway
 * show the reply as a Markdown card. Notices and command replies stay "text" —
 * they are written for a plain chat line, and a stray `*` or `_` in a thread
 * title would otherwise be read as emphasis.
 */
function segmentFor(
  format: RemoteImReplyFormat,
  text: string,
  options: SegmentImReplyOptions
): string[] {
  if (format === "text") return segmentImReplyText(text, options)
  if (options.singleSegmentOverflow) {
    throw new Error("singleSegmentOverflow is only defined for text replies")
  }
  return segmentImMarkdownText(text, options)
}

export function buildImEventReplies(input: {
  event: Pick<ImEventRecord, "eventId" | "conversationKey">
  text: string
  prefix?: string
  deliveryId?: string
  format?: RemoteImReplyFormat
}): RemoteImReplyV1[] {
  const deliveryId = input.deliveryId ?? `${input.event.eventId}:reply`
  const format = input.format ?? "text"
  const segments = segmentFor(format, input.text, { prefix: input.prefix })
  return segments.map((content, index) => ({
    schemaVersion: IM_GATEWAY_SCHEMA_VERSION,
    deliveryId,
    eventId: input.event.eventId,
    conversationKey: input.event.conversationKey,
    idempotencyKey: `${deliveryId}:reply:${index}`,
    segment: { index, count: segments.length },
    message: { type: format, content }
  }))
}

export function buildImProactiveReplies(input: {
  deliveryId: string
  conversationKey: string
  text: string
  prefix?: string
  segmentation?: Omit<SegmentImReplyOptions, "prefix">
  format?: RemoteImReplyFormat
}): RemoteImReplyV1[] {
  const deliveryId = input.deliveryId.trim()
  if (!deliveryId) throw new Error("deliveryId is required")
  const format = input.format ?? "text"
  const segments = segmentFor(format, input.text, {
    ...input.segmentation,
    prefix: input.prefix
  })
  return segments.map((content, index) => ({
    schemaVersion: IM_GATEWAY_SCHEMA_VERSION,
    deliveryId,
    conversationKey: input.conversationKey,
    idempotencyKey: `${deliveryId}:reply:${index}`,
    segment: { index, count: segments.length },
    message: { type: format, content }
  }))
}
