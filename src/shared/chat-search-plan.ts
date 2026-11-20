import { buildStreamingMarkdownPreview } from "./streaming-markdown-preview"
import { systemNoticeBlockText } from "./goal-notice-presentation"
import { getCollapsedToolCallSummary } from "./tool-call-summary"
import { hasLegacyStructuredTranscriptNotice } from "./thread-message-content"
import type { ChatSearchPlan, ChatSearchSourceSegment } from "./chat-search-types"

export const CHAT_SEARCH_INPUT_LIMIT = 256 * 1024
export const CHAT_SEARCH_BLOCK_LIMIT = 128

/** Select source slices before parsing, normalizing, joining or transferring their contents. */
export function createChatSearchPlan(
  role: string,
  content: unknown,
  options: { stripThink?: boolean } = {}
): ChatSearchPlan {
  const segments: ChatSearchSourceSegment[] = []
  const middles: Array<{ text: string; blockIndex: number; start: number; end: number }> = []
  const semanticBlocks = new Set<number>()
  const legacyProjectionTruncated =
    Array.isArray(content) && hasLegacyStructuredTranscriptNotice(content)
  let remaining = CHAT_SEARCH_INPUT_LIMIT
  let truncated = false
  const append = (text: string, blockIndex: number, start: number, end: number): void => {
    const available = Math.max(0, remaining - (segments.length ? 1 : 0))
    const length = Math.min(end - start, available)
    if (length < end - start) truncated = true
    if (length <= 0) return
    segments.push({
      kind: "body",
      blockIndex,
      start,
      end: start + length,
      sourceLength: text.length,
      raw: text.slice(start, start + length),
      ...(semanticBlocks.has(blockIndex) ? { stripThink: true } : {})
    })
    remaining -= length + (segments.length > 1 ? 1 : 0)
  }
  const select = (text: string, blockIndex: number): void => {
    const markerProbe = options.stripThink
      ? `${text.slice(0, 64)}${text.slice(-64)}`.toLowerCase()
      : ""
    if (markerProbe.includes("<think") || markerProbe.includes("</think>"))
      semanticBlocks.add(blockIndex)
    // User/system controls have semantic wrappers. Never parse a severed wrapper as body text.
    if (role === "user" || role === "system" || semanticBlocks.has(blockIndex)) {
      if (text.length > remaining) {
        truncated = true
        return
      }
      append(text, blockIndex, 0, text.length)
      return
    }
    const preview = buildStreamingMarkdownPreview(text)
    append(text, blockIndex, 0, preview.head.length)
    if (!preview.omittedCharacters) return
    const tailStart = text.length - preview.tail.length
    append(text, blockIndex, tailStart, text.length)
    middles.push({ text, blockIndex, start: preview.head.length, end: tailStart })
  }
  if (typeof content === "string") select(content, 0)
  else if (Array.isArray(content) && role === "system") {
    const parts: string[] = []
    let units = 0
    const bodyBlocks = content.length - Number(legacyProjectionTruncated)
    for (let index = 0; index < Math.min(bodyBlocks, CHAT_SEARCH_BLOCK_LIMIT); index += 1) {
      const text = systemNoticeBlockText(content[index])
      if (!text) continue
      units += text.length + Number(parts.length > 0)
      if (units > remaining) break
      parts.push(text)
    }
    truncated = units > remaining || bodyBlocks > CHAT_SEARCH_BLOCK_LIMIT
    if (!truncated) select(parts.join("\n"), 0)
  }
  else if (Array.isArray(content)) {
    const bodyBlocks = content.length - Number(legacyProjectionTruncated)
    const count = Math.min(bodyBlocks, CHAT_SEARCH_BLOCK_LIMIT)
    truncated = bodyBlocks > count
    const textBlocks: Array<{ text: string; index: number }> = []
    for (let index = 0; index < count; index += 1) {
      const block = content[index] as { type?: unknown; text?: unknown; content?: unknown } | null
      if (!block || typeof block !== "object") continue
      const text = block.type === "text" ? block.text : null
      if (typeof text === "string") textBlocks.push({ text, index })
    }
    // Reserve both ends of the message before spending the budget on intervening blocks.
    const first = textBlocks[0]
    const last = textBlocks.at(-1)
    if (first) select(first.text, first.index)
    if (last && last !== first) select(last.text, last.index)
    for (const block of textBlocks.slice(1, -1)) select(block.text, block.index)
  }
  for (const middle of middles) append(middle.text, middle.blockIndex, middle.start, middle.end)
  segments.sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start)
  return {
    role,
    segments,
    truncated: truncated || legacyProjectionTruncated,
    ...(options.stripThink ? { stripThink: true } : {}),
    ...(role === "user" && typeof content === "string" ? { cleanAttachments: true } : {})
  }
}

export function appendChatSearchToolSummaries(
  plan: ChatSearchPlan,
  toolCalls: readonly { name?: unknown; args?: unknown }[]
): void {
  let units = plan.segments.reduce((sum, segment) => sum + segment.raw.length + 1, 0)
  for (let index = 0; index < Math.min(CHAT_SEARCH_BLOCK_LIMIT, toolCalls.length); index += 1) {
    const remaining = CHAT_SEARCH_INPUT_LIMIT - units - 1
    if (remaining <= 0) {
      plan.truncated = true
      break
    }
    const call = toolCalls[index]
    const args =
      call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {}
    const bound = (value: unknown, tail = false): string | undefined => {
      if (typeof value !== "string") return undefined
      if (value.length > remaining) plan.truncated = true
      return tail ? value.slice(-remaining) : value.slice(0, remaining)
    }
    // Bound before the summary helper splits paths or constructs strings.
    const summary = getCollapsedToolCallSummary({
      name: bound(call.name) ?? "",
      args: {
        path: bound(args.path ?? args.file_path, true),
        command: bound(args.command),
        pattern: bound(args.pattern ?? args.query)
      }
    })
    const raw = summary.slice(0, remaining)
    if (raw.length < summary.length) plan.truncated = true
    if (!raw) continue
    plan.segments.push({
      kind: "summary",
      blockIndex: index,
      start: 0,
      end: raw.length,
      sourceLength: summary.length,
      raw
    })
    units += raw.length + 1
  }
  if (toolCalls.length > CHAT_SEARCH_BLOCK_LIMIT) plan.truncated = true
}
