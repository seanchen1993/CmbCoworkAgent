import { normalizeBotPreviewUrl } from "../../../shared/bot-link-preview"
import { botMessageLinkParts } from "../../../shared/bot-message-links"

/** Additive preview only: persisted body/reference offsets and ordinary links are unchanged. */
export function botMessagePreviewLink(text: string): { url: string; href: string } | null {
  const trimmed = text.trim(),
    parts = botMessageLinkParts(trimmed)
  if (parts.length !== 1 || parts[0].kind !== "link" || parts[0].text !== trimmed) return null
  const url = normalizeBotPreviewUrl(parts[0].href)
  return url ? { url, href: parts[0].href } : null
}
export function botMessagePreviewUrl(text: string): string | null {
  return botMessagePreviewLink(text)?.url ?? null
}
