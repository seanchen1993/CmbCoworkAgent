/** Grok deep-link validation adapted to local Cmb Bot message routes; see PROVENANCE. */
export const BOT_DEEP_LINK_SCHEME = "cmbcowork"
export const BOT_DEEP_LINK_MAX_LENGTH = 2048
export interface BotDeepLink {
  conversationId: string
  messageId: string
}
export interface ParsedBotDeepLink {
  link: BotDeepLink
  canonicalUrl: string
}
export interface BotNavigationAPI {
  ready(): Promise<void>
  onOpen(callback: (link: BotDeepLink) => void): () => void
}
function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 33 || code > 126) return false
  }
  return true
}
function hasValidPercentEncoding(value: string): boolean {
  return !/%(?![0-9A-Fa-f]{2})/.test(value)
}
function hasCanonicalPathSection(raw: string): boolean {
  const queryStart = raw.indexOf("?")
  const beforeQuery = queryStart === -1 ? raw : raw.slice(0, queryStart)
  return !beforeQuery.includes("%") && !/\/\.{1,2}(?:\/|$)/.test(beforeQuery)
}

const identifier = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const route = new RegExp(`^/v1/bots/(${identifier})/messages/(${identifier})$`, "i")
export function botMessageLink(link: BotDeepLink): string {
  const value = `${BOT_DEEP_LINK_SCHEME}://app/v1/bots/${link.conversationId}/messages/${link.messageId}`
  if (!parseBotDeepLink(value)) throw new Error("无效的消息定位地址")
  return value
}
export function parseBotDeepLink(raw: unknown): ParsedBotDeepLink | null {
  if (
    typeof raw !== "string" ||
    !raw.length ||
    raw.length > BOT_DEEP_LINK_MAX_LENGTH ||
    !isPrintableAscii(raw) ||
    raw.includes("#") ||
    raw.includes("\\") ||
    !hasValidPercentEncoding(raw) ||
    !hasCanonicalPathSection(raw)
  )
    return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (
    url.protocol !== `${BOT_DEEP_LINK_SCHEME}:` ||
    url.host !== "app" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    raw.includes("?")
  )
    return null
  const match = route.exec(url.pathname)
  if (!match) return null
  const link = { conversationId: match[1].toLowerCase(), messageId: match[2].toLowerCase() }
  return {
    link,
    canonicalUrl: `${BOT_DEEP_LINK_SCHEME}://app/v1/bots/${link.conversationId}/messages/${link.messageId}`
  }
}
