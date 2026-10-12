import { extractTextFromUnknownContent } from "../coordinator-worker-stream"
import { isPlainRecord } from "./structured-output"

export interface MessageLike {
  additional_kwargs?: { tool_calls?: unknown[] }
  content?: unknown
  name?: unknown
  status?: unknown
  kwargs?: {
    additional_kwargs?: { tool_calls?: unknown[] }
    content?: unknown
    name?: unknown
    status?: unknown
    tool_calls?: unknown[]
    invalid_tool_calls?: unknown[]
    tool_call_id?: unknown
    usage_metadata?: { output_tokens?: number }
  }
  usage_metadata?: { output_tokens?: number }
  tool_calls?: unknown[]
  invalid_tool_calls?: unknown[]
  tool_call_id?: unknown
  id?: unknown
  _getType?: () => string
}

export function snapshotMessages(snapshot: unknown): MessageLike[] {
  if (typeof snapshot !== "object" || snapshot === null) return []
  const messages = (snapshot as { messages?: unknown }).messages
  return Array.isArray(messages) ? (messages as MessageLike[]) : []
}

export function messageClassName(message: MessageLike): string {
  if (typeof message._getType === "function") {
    try {
      return message._getType()
    } catch {
      /* fall through to serialized form */
    }
  }
  const id = message.id
  if (Array.isArray(id)) return String(id[id.length - 1] ?? "")
  return String((message as { type?: unknown }).type ?? "")
}

export function isAiMessage(message: MessageLike): boolean {
  const className = messageClassName(message).toLowerCase()
  return className === "ai" || className.includes("aimessage")
}

export function isToolMessage(message: MessageLike): boolean {
  const className = messageClassName(message).toLowerCase()
  return className === "tool" || className.includes("toolmessage")
}

export function messageToolCalls(message: MessageLike): unknown[] {
  // Collect ALL tool calls a message carries — deduped by id — across every shape it can take: live
  // vs serialized, normalized `tool_calls`, raw `additional_kwargs.tool_calls`, and the canonical
  // malformed bucket `invalid_tool_calls`. A "first non-empty" scan would MISS a malformed call when
  // the SAME turn also has a valid one (valid → tool_calls, malformed → invalid_tool_calls), and the
  // dangling/fail-fast logic must see BOTH: deepseek can leave normalized EMPTY while the real call
  // lives in additional_kwargs/invalid_tool_calls (truncated/unparseable args), or emit valid +
  // invalid side by side. Returning the UNION feeds every id to danglingToolCallIds, which then
  // cross-checks normalizedToolCallIds: a dangling id NOT in the normalized set is unrepairable
  // (patchToolCalls would drop any synthesized result) → fail-fast retry instead of a 400. Dedup
  // keeps the first (normalized) form when a call appears in several shapes; id-less calls are kept
  // as-is (danglingToolCallIds ignores them; token estimation may double-count, which errs high).
  const out: unknown[] = []
  const seen = new Set<string>()
  const candidates = [
    message.tool_calls,
    message.kwargs?.tool_calls,
    message.additional_kwargs?.tool_calls,
    message.kwargs?.additional_kwargs?.tool_calls,
    message.invalid_tool_calls,
    message.kwargs?.invalid_tool_calls
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const call of candidate) {
      const id = toolCallId(call)
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      out.push(call)
    }
  }
  return out
}

export function toolCallId(toolCall: unknown): string | undefined {
  if (!isPlainRecord(toolCall)) return undefined
  return typeof toolCall.id === "string" && toolCall.id.trim() ? toolCall.id : undefined
}

export function toolMessageToolCallId(message: MessageLike): string | undefined {
  const id = message.tool_call_id ?? message.kwargs?.tool_call_id
  return typeof id === "string" && id.trim() ? id : undefined
}

export function extractOutputTokens(snapshot: unknown, text: string): number {
  let total = 0
  for (const message of snapshotMessages(snapshot)) {
    if (!isAiMessage(message)) continue
    const usage = message.usage_metadata ?? message.kwargs?.usage_metadata
    const reported = usage?.output_tokens
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      // Authoritative per-message usage (langchain reports per LLM call).
      total += reported
    } else {
      // This message reported NO usage — estimate ITS output (text + serialized
      // tool-call args). Filling per-message rather than all-or-nothing means a
      // gateway that meters only some messages doesn't undercount; a hard spend
      // cap should err high, not low.
      total += estimateTokenCount(
        extractTextFromUnknownContent(message.content ?? message.kwargs?.content)
      )
      const toolCalls = messageToolCalls(message)
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        total += estimateTokenCount(stringifyToolCalls(toolCalls))
      }
    }
  }
  if (total > 0) return total
  // Last resort when the snapshot carried no assistant content at all.
  return Math.max(1, estimateTokenCount(text))
}

function estimateTokenCount(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1
  }
  // `text.length` is UTF-16 units; astral CJK chars (Ext B+) count as 1 above
  // but occupy 2 units, so `other` is at most a hair high — safe for a spend cap.
  const other = Math.max(0, text.length - cjk)
  return Math.ceil(cjk + other / 4)
}

/** Common CJK ranges where a character is ~1 token (a flat chars/4 underestimates). */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) || // symbols/punct, kana, CJK Unified + Ext A
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef) || // halfwidth/fullwidth forms
    (code >= 0x20000 && code <= 0x3ffff) // CJK Unified Ext B–F + compat supplement
  )
}

function stringifyToolCalls(toolCalls: unknown): string {
  try {
    return JSON.stringify(toolCalls) ?? ""
  } catch {
    return ""
  }
}
