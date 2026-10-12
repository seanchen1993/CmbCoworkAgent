import { parseBotDeepLink } from "./bot-deep-link"

/** A bounded number of interactive spans; the rest of the user's text stays readable. */
export const BOT_MESSAGE_MAX_LINKS = 64
export const BOT_MESSAGE_LINK_MAX_LENGTH = 2048
/** Bare links stop at Chinese prose punctuation; explicit rich destinations do not. */
export function botLiteralLinkBoundary(value: string): number {
  return value.search(/[，。；：！？、…“”‘’（）【】《》]/u)
}
export type BotMessageLinkPart =
  | { kind: "text"; from: number; to: number; text: string }
  | { kind: "link"; from: number; to: number; text: string; href: string }

/** User text is literal. Only public link schemes and validated app message routes are interactive. */
export function botMessageLinkHref(value: string): string | null {
  if (!value || value.length > BOT_MESSAGE_LINK_MAX_LENGTH || /[\s<>"'`]/u.test(value)) return null
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return null
  }
  const internal = parseBotDeepLink(value)
  if (internal) return internal.canonicalUrl
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const parsed = new URL(value)
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null
  } catch {
    return null
  }
}

function linkTokenEnd(value: string): number {
  let end = value.length
  const balance = { ")": 0, "]": 0, "}": 0 }
  for (const character of value) {
    if (character === "(") balance[")"]--
    else if (character === "[") balance["]"]--
    else if (character === "{") balance["}"]--
    else if (character === ")" || character === "]" || character === "}") balance[character]++
  }
  while (end > 0) {
    const character = value[end - 1]
    if (/[.,;:!?，。；：！？、…]/u.test(character)) end--
    else if (
      (character === ")" || character === "]" || character === "}") &&
      balance[character] > 0
    ) {
      balance[character]--
      end--
    } else break
  }
  return end
}

/** UTF-16 ranges preserve persisted reference offsets and every original character.
 * Token scanning and punctuation handling are linear; no DOM or global cache is retained. */
export function botMessageLinkParts(text: string): BotMessageLinkPart[] {
  const parts: BotMessageLinkPart[] = []
  const pattern = /(?:https?:\/\/|cmbcowork:\/\/)[^\s<>"'`，。；：！？、]+/giu
  let cursor = 0
  let links = 0
  for (const match of text.matchAll(pattern)) {
    const from = match.index
    const boundary = botLiteralLinkBoundary(match[0])
    const literal = boundary < 0 ? match[0] : match[0].slice(0, boundary)
    const token = literal.slice(0, linkTokenEnd(literal))
    const href = botMessageLinkHref(token)
    if (!href) continue
    if (from > cursor)
      parts.push({ kind: "text", from: cursor, to: from, text: text.slice(cursor, from) })
    cursor = from + token.length
    parts.push({ kind: "link", from, to: cursor, text: token, href })
    if (++links === BOT_MESSAGE_MAX_LINKS) break
  }
  if (cursor < text.length)
    parts.push({ kind: "text", from: cursor, to: text.length, text: text.slice(cursor) })
  return parts
}
