import { Tokenizer, TokenizerMode, Token, type TokenHandler } from "parse5"
import { normalizeBotPreviewUrl } from "../../shared/bot-link-preview"

function text(value: string, limit: number): string {
  let clean = "",
    space = false
  for (let index = 0; index < value.length && clean.length < limit; index++) {
    const code = value.charCodeAt(index),
      character = value[index]
    if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      /\s/.test(character)
    ) {
      space = clean.length > 0
      continue
    }
    if (space) clean += " "
    if (clean.length < limit) clean += character
    space = false
  }
  clean = clean.trimEnd()
  const last = clean.charCodeAt(clean.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? clean.slice(0, -1) : clean
}
/** parse5 7.3's HTML tokenizer scans entities once. Bound its duplicate-attribute lookup to <=64. */
class PreviewTokenizer extends Tokenizer {
  protected override _leaveAttrName(): void {
    const token = this.currentToken
    if (
      token &&
      (token.type === Token.TokenType.START_TAG || token.type === Token.TokenType.END_TAG) &&
      token.attrs.length >= 64
    )
      throw new Error("HTML attribute limit")
    if (this.currentAttr.name.length > 128) throw new Error("HTML attribute name limit")
    super._leaveAttrName()
  }
}
/** No DOM construction, parser tree repair, scripts, external entities, or mounted HTML. */
export function scrapeBotLinkPreview(
  bytes: Buffer,
  finalUrl: string,
  contentType = "text/html; charset=utf-8"
) {
  if (bytes.length > 256 * 1024) throw new Error("HTML byte limit")
  const meta = new Map<string, string>()
  let title = "",
    collectTitle = false,
    templateDepth = 0,
    count = 0
  const token = () => {
    if (++count > 8192) throw new Error("HTML token limit")
  }
  const character = (value: Token.CharacterToken) => {
    token()
    if (collectTitle && !templateDepth && title.length < 512)
      title += value.chars.slice(0, 512 - title.length)
  }
  const handler: TokenHandler = {
    onStartTag(value) {
      token()
      const name = value.tagName
      if (name === "body") {
        tokenizer.pause()
        return
      }
      if (name === "script") tokenizer.state = TokenizerMode.SCRIPT_DATA
      else if (["style", "noscript", "xmp", "iframe", "noembed", "noframes"].includes(name))
        tokenizer.state = TokenizerMode.RAWTEXT
      else if (name === "title" || name === "textarea") tokenizer.state = TokenizerMode.RCDATA
      else if (name === "plaintext") tokenizer.state = TokenizerMode.PLAINTEXT
      if (name === "template") {
        if (++templateDepth > 16) throw new Error("HTML template limit")
        return
      }
      if (templateDepth) return
      if (name === "title") {
        collectTitle = true
        return
      }
      if (name !== "meta") return
      const key = (
        Token.getTokenAttr(value, "property") ??
        Token.getTokenAttr(value, "name") ??
        ""
      ).toLowerCase()
      if (
        [
          "og:title",
          "twitter:title",
          "og:description",
          "description",
          "twitter:description",
          "og:site_name",
          "application-name",
          "og:image",
          "og:image:url",
          "twitter:image",
          "twitter:image:src"
        ].includes(key) &&
        !meta.has(key)
      )
        meta.set(key, (Token.getTokenAttr(value, "content") ?? "").slice(0, 4096))
    },
    onEndTag(value) {
      token()
      if (value.tagName === "template") templateDepth = Math.max(0, templateDepth - 1)
      if (value.tagName === "title") collectTitle = false
      if (value.tagName === "head") tokenizer.pause()
    },
    onCharacter: character,
    onWhitespaceCharacter: character,
    onNullCharacter: character,
    onComment: token,
    onDoctype: token,
    onEof: token
  }
  const tokenizer = new PreviewTokenizer({}, handler)
  let charset = "utf-8"
  const aliases = new Map([
    ["utf8", "utf-8"],
    ["utf-8", "utf-8"],
    ["gbk", "gb18030"],
    ["gb2312", "gb18030"],
    ["gb18030", "gb18030"],
    ["big5", "big5"],
    ["iso-8859-1", "windows-1252"],
    ["windows-1252", "windows-1252"],
    ["utf-16le", "utf-16le"],
    ["utf-16be", "utf-16be"]
  ])
  for (const part of contentType.split(";")) {
    const pair = part.trim().split("=")
    if (pair[0]?.trim().toLowerCase() === "charset") {
      charset =
        aliases.get(
          (pair[1] ?? "")
            .trim()
            .replace(/^['"]|['"]$/g, "")
            .toLowerCase()
        ) ?? "utf-8"
      break
    }
  }
  tokenizer.write(new TextDecoder(charset).decode(bytes), true)
  const image =
    meta.get("og:image") ??
    meta.get("og:image:url") ??
    meta.get("twitter:image") ??
    meta.get("twitter:image:src")
  let imageUrl: string | undefined
  if (image && image.length <= 2048) {
    try {
      imageUrl = normalizeBotPreviewUrl(new URL(image, finalUrl).href) ?? undefined
    } catch {
      /* no image */
    }
  }
  return {
    title: text(meta.get("og:title") ?? meta.get("twitter:title") ?? title, 512),
    description: text(
      meta.get("og:description") ??
        meta.get("description") ??
        meta.get("twitter:description") ??
        "",
      1024
    ),
    siteName: text(meta.get("og:site_name") ?? meta.get("application-name") ?? "", 128),
    imageUrl
  }
}
