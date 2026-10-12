// Extracted from Grok Bot 0.18; see PROVENANCE.json. Localized fallback labels only.
export type TranscriptReplyPreview =
  | { kind: "user-text" | "assistant-text"; text: string }
  | { kind: "file"; url: string; name?: string }
  | { kind: "image" }
  | { kind: "link"; url: string }
  | { kind: "missing" }

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=4720289
const REPLY_TEXT_LABEL_LIMIT = 40
const REPLY_QUOTE_LIMIT = 96

function replyAttachmentBasename(url: string): string {
  let path = url
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    // The reply target may be a local path rather than a URL.
  }
  const trimmed = path.replace(/\/+$/u, "")
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed) || url
}

function replyLinkHost(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function normalizeReplyText(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

function truncateReplyText(text: string, limit: number): string {
  const normalized = normalizeReplyText(text)
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1).trimEnd()}…`
}

/** The compact target label used by the shipped reply quote and composer pill. */
export function replyPreviewLabel(preview: TranscriptReplyPreview): string {
  switch (preview.kind) {
    case "user-text":
    case "assistant-text": {
      const text = normalizeReplyText(preview.text)
      if (text.length === 0) return "消息"
      if (text.length <= REPLY_TEXT_LABEL_LIMIT) return text
      return `${text.slice(0, REPLY_TEXT_LABEL_LIMIT - 1).replace(/[\s:;,.!?\u2013\u2014-]+$/gu, "")}…`
    }
    case "image":
      return "图片"
    case "file":
      return preview.name != null && preview.name.length > 0
        ? preview.name
        : replyAttachmentBasename(preview.url)
    case "link":
      return replyLinkHost(preview.url)
    case "missing":
      return "消息"
  }
}

export function replyQuoteLabel(preview: TranscriptReplyPreview): string {
  switch (preview.kind) {
    case "user-text":
    case "assistant-text": {
      const text = truncateReplyText(preview.text, REPLY_QUOTE_LIMIT)
      return text.length > 0 ? text : "（空消息）"
    }
    case "image":
      return "图片"
    case "file":
      return truncateReplyText(replyPreviewLabel(preview), REPLY_QUOTE_LIMIT)
    case "link":
      return truncateReplyText(replyPreviewLabel(preview), REPLY_QUOTE_LIMIT)
    case "missing":
      return "（消息不可用）"
  }
}
