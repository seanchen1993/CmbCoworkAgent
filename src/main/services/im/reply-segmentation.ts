import { createHash } from "node:crypto"
import {
  IM_GATEWAY_SCHEMA_VERSION,
  IM_REPLY_MAX_SEGMENT_CHARACTERS,
  IM_REPLY_MAX_SEGMENTS,
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

export function eventShortCode(eventId: string): string {
  return createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 8).toUpperCase()
}

export function buildImEventReplies(input: {
  event: Pick<ImEventRecord, "eventId" | "conversationKey">
  text: string
  prefix?: string
  deliveryId?: string
}): RemoteImReplyV1[] {
  const deliveryId = input.deliveryId ?? `${input.event.eventId}:reply`
  const segments = segmentImReplyText(input.text, { prefix: input.prefix })
  return segments.map((content, index) => ({
    schemaVersion: IM_GATEWAY_SCHEMA_VERSION,
    deliveryId,
    eventId: input.event.eventId,
    conversationKey: input.event.conversationKey,
    idempotencyKey: `${deliveryId}:reply:${index}`,
    segment: { index, count: segments.length },
    message: { type: "text", content }
  }))
}

export function buildImProactiveReplies(input: {
  deliveryId: string
  conversationKey: string
  text: string
  prefix?: string
}): RemoteImReplyV1[] {
  const deliveryId = input.deliveryId.trim()
  if (!deliveryId) throw new Error("deliveryId is required")
  const segments = segmentImReplyText(input.text, { prefix: input.prefix })
  return segments.map((content, index) => ({
    schemaVersion: IM_GATEWAY_SCHEMA_VERSION,
    deliveryId,
    conversationKey: input.conversationKey,
    idempotencyKey: `${deliveryId}:reply:${index}`,
    segment: { index, count: segments.length },
    message: { type: "text", content }
  }))
}
