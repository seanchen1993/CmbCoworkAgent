import { createHash } from "node:crypto"
import {
  IM_GATEWAY_SCHEMA_VERSION,
  IM_REPLY_MAX_SEGMENT_CHARACTERS,
  IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS,
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

function fittingPointCount(
  points: string[],
  maxCharacters: number,
  maxUtf16Characters: number
): number {
  let units = 0
  let count = 0
  for (const point of points) {
    if (count >= maxCharacters || units + point.length > maxUtf16Characters) break
    units += point.length
    count += 1
  }
  return count
}

function takeAtBoundary(
  points: string[],
  maxCharacters: number,
  maxUtf16Characters: number
): { head: string; tail: string[] } {
  const limit = fittingPointCount(points, maxCharacters, maxUtf16Characters)
  if (limit < 1) throw new Error("Reply segment leaves no room for content")
  if (points.length <= limit) return { head: points.join(""), tail: [] }
  const lowerBound = Math.max(1, Math.floor(limit * 0.45))
  let boundary = -1
  for (let index = limit - 1; index >= lowerBound; index -= 1) {
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
  const end = boundary > 0 ? boundary : limit
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
  if (
    lengthOf(singlePrefix) + lengthOf(normalized) <= maxCharacters &&
    (singlePrefix + normalized).length <= IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS
  ) {
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
    const points = codePoints(normalized)
    // The UTF-16 limit can require truncation even when the source has fewer
    // than maxCharacters code points. Never let head and tail overlap there.
    const excerptBudget = Math.min(contentBudget, points.length - 1)
    if (minimumHeadCharacters + minimumTailCharacters > excerptBudget) {
      throw new Error("singleSegmentOverflow minimum content exceeds the available reply")
    }
    const additionalCharacters = excerptBudget - minimumHeadCharacters - minimumTailCharacters
    let headCharacters = minimumHeadCharacters + Math.ceil(additionalCharacters / 2)
    let tailCharacters = minimumTailCharacters + Math.floor(additionalCharacters / 2)
    const clipped = (): string =>
      `${singlePrefix}${points.slice(0, headCharacters).join("")}${notice}${points.slice(-tailCharacters).join("")}`
    while (clipped().length > IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS) {
      if (headCharacters >= tailCharacters && headCharacters > minimumHeadCharacters) {
        headCharacters -= 1
      } else if (tailCharacters > minimumTailCharacters) {
        tailCharacters -= 1
      } else if (headCharacters > minimumHeadCharacters) {
        headCharacters -= 1
      } else {
        throw new Error("singleSegmentOverflow minimum content exceeds the platform limit")
      }
    }
    return [clipped()]
  }

  // V1 caps at eight segments, so every [i/n] marker has the same six-character
  // upper bound. Splitting against that bound makes the later count immutable.
  const markerBudget = Math.max(
    lengthOf(visibleSegmentPrefix(prefix, 0, 8)),
    lengthOf(visibleSegmentPrefix(prefix, 7, 8))
  )
  const payloadBudget = maxCharacters - markerBudget
  const markerUtf16Budget = Math.max(
    visibleSegmentPrefix(prefix, 0, 8).length,
    visibleSegmentPrefix(prefix, 7, 8).length
  )
  const payloadUtf16Budget = IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS - markerUtf16Budget
  if (payloadBudget < 1 || payloadUtf16Budget < 1) {
    throw new Error("Reply prefix leaves no room for content")
  }

  const chunks: string[] = []
  let remaining = codePoints(normalized)
  while (remaining.length > 0 && chunks.length < maxSegments) {
    const next = takeAtBoundary(remaining, payloadBudget, payloadUtf16Budget)
    chunks.push(next.head)
    remaining = next.tail
  }

  if (remaining.length > 0) {
    const notice = `\n\n${IM_REPLY_TRUNCATION_NOTICE}`
    const finalPayloadBudget = payloadBudget - lengthOf(notice)
    const finalUtf16Budget = payloadUtf16Budget - notice.length
    if (finalPayloadBudget < 1 || finalUtf16Budget < 1) {
      throw new Error("Reply segment is too small for truncation notice")
    }
    const current = codePoints(chunks[maxSegments - 1] ?? "")
    chunks[maxSegments - 1] =
      `${takeAtBoundary(current, finalPayloadBudget, finalUtf16Budget).head}${notice}`
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

interface ImOpenTable {
  header: string
  separator: string
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

function tableCells(line: string): string[] {
  const value = line.trim().replace(/^\|/u, "").replace(/\|$/u, "")
  return value.split(/(?<!\\)\|/u).map((cell) => cell.trim())
}

function isTableRow(line: string): boolean {
  return tableCells(line).length >= 2
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line)
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
}

/** Tracks a table only while complete rows continue; fenced code is not a table. */
function tableAfter(
  chunk: string,
  open: ImOpenTable | null,
  openFence: ImOpenFence | null
): ImOpenTable | null {
  let table = open
  let fence = openFence
  let precedingRow: string | null = null
  const lines = chunk.split("\n")
  if (chunk.endsWith("\n")) lines.pop()
  for (const line of lines) {
    const nextFence = fenceAfter(line, fence)
    if (fence || nextFence) {
      fence = nextFence
      table = null
      precedingRow = null
      continue
    }
    if (table && isTableRow(line)) continue
    table =
      precedingRow && isTableSeparator(line) ? { header: precedingRow, separator: line } : null
    precedingRow = isTableRow(line) ? line : null
  }
  return table
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
  maxCharacters: number,
  maxUtf16Characters: number
): { head: string; tail: string[]; paragraphBreak: boolean } {
  const limit = fittingPointCount(points, maxCharacters, maxUtf16Characters)
  if (limit < 1) throw new Error("Reply segment leaves no room for content")
  if (points.length <= limit) return { head: points.join(""), tail: [], paragraphBreak: false }
  const lowerBound = Math.max(1, Math.floor(limit * 0.45))
  for (let index = limit - 1; index >= lowerBound; index -= 1) {
    if (points[index] === "\n" && points[index - 1] === "\n") {
      return {
        head: points.slice(0, index).join("").trimEnd(),
        tail: points.slice(index + 1),
        paragraphBreak: true
      }
    }
  }
  // A row is a Markdown unit. Prefer a complete line over a nearby space in
  // one of its cells; the next card can then repeat the table header.
  for (let index = limit - 1; index >= lowerBound; index -= 1) {
    if (points[index] === "\n") {
      return {
        head: points.slice(0, index).join("").trimEnd(),
        tail: points.slice(index + 1),
        paragraphBreak: false
      }
    }
  }
  return { ...takeAtBoundary(points, maxCharacters, maxUtf16Characters), paragraphBreak: false }
}

/**
 * One segment's body within `budget`, closing a code fence the cut leaves open
 * and reopening the one the previous segment closed. Shrinks and cuts again
 * when the closing fence would not fit.
 */
function cutMarkdownSegment(
  points: string[],
  reopenFence: ImOpenFence | null,
  reopenTable: ImOpenTable | null,
  budget: number,
  utf16Budget: number
): { body: string; tail: string[]; open: ImOpenFence | null; table: ImOpenTable | null } {
  const opener = reopenFence
    ? `${reopenFence.opener}\n`
    : reopenTable
      ? `${reopenTable.header}\n${reopenTable.separator}\n`
      : ""
  let room = budget - lengthOf(opener)
  let utf16Room = utf16Budget - opener.length
  for (;;) {
    if (room < 1 || utf16Room < 1) {
      throw new Error("Reply segment is too small for its Markdown context")
    }
    const { head, tail, paragraphBreak } = takeMarkdownAtBoundary(points, room, utf16Room)
    const open = fenceAfter(head, reopenFence)
    const closing = open ? `\n${open.indent}${open.marker}` : ""
    const body = `${opener}${head}${closing}`
    if (lengthOf(body) <= budget && body.length <= utf16Budget) {
      const continuedTable = paragraphBreak ? null : tableAfter(head, reopenTable, reopenFence)
      const nextLineEnd = tail.indexOf("\n")
      const nextLine = (nextLineEnd < 0 ? tail : tail.slice(0, nextLineEnd)).join("")
      return {
        body,
        tail,
        open,
        table: continuedTable && isTableRow(nextLine) ? continuedTable : null
      }
    }
    room -= lengthOf(closing)
    utf16Room -= closing.length
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
  if (
    lengthOf(singleHeader) + lengthOf(normalized) <= maxCharacters &&
    (singleHeader + normalized).length <= IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS
  ) {
    return [`${singleHeader}${normalized}`]
  }

  // As in segmentImReplyText: budget against the widest header any segment
  // can get, so the count decided afterwards cannot push one over the limit.
  const headerBudget = Math.max(
    lengthOf(markdownSegmentHeader(prefix, 0, 8)),
    lengthOf(markdownSegmentHeader(prefix, 7, 8))
  )
  const budget = maxCharacters - headerBudget
  const headerUtf16Budget = Math.max(
    markdownSegmentHeader(prefix, 0, 8).length,
    markdownSegmentHeader(prefix, 7, 8).length
  )
  const utf16Budget = IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS - headerUtf16Budget
  if (budget < 1 || utf16Budget < 1) throw new Error("Reply prefix leaves no room for content")

  const bodies: string[] = []
  let remaining = codePoints(normalized)
  let reopenFence: ImOpenFence | null = null
  let reopenTable: ImOpenTable | null = null
  let lastStart = remaining
  let lastFence: ImOpenFence | null = null
  let lastTable: ImOpenTable | null = null
  while (remaining.length > 0 && bodies.length < maxSegments) {
    lastStart = remaining
    lastFence = reopenFence
    lastTable = reopenTable
    const cut = cutMarkdownSegment(remaining, reopenFence, reopenTable, budget, utf16Budget)
    bodies.push(cut.body)
    remaining = cut.tail
    reopenFence = cut.open
    reopenTable = cut.table
  }

  if (remaining.length > 0) {
    const notice = `\n\n${IM_REPLY_TRUNCATION_NOTICE}`
    const cut = cutMarkdownSegment(
      lastStart,
      lastFence,
      lastTable,
      budget - lengthOf(notice),
      utf16Budget - notice.length
    )
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
