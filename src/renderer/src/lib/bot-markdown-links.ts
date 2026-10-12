import { defaultUrlTransform, type UrlTransform } from "react-markdown"
import type { Root, Text } from "mdast"
import type { Plugin } from "unified"
import { SKIP, visit } from "unist-util-visit"
import { parseBotDeepLink } from "../../../shared/bot-deep-link"
import { botLiteralLinkBoundary } from "../../../shared/bot-message-links"

/** Bot-only extension. Images and all other schemes retain the Markdown package policy. */
export const botMarkdownUrlTransform: UrlTransform = (url, key) => {
  const internal = key === "href" ? parseBotDeepLink(url) : null
  return internal ? internal.canonicalUrl : defaultUrlTransform(url)
}

/** GFM accepts Chinese sentence punctuation in bare URLs. Split only literal
 * autolinks; explicit Markdown destinations and Unicode paths remain intact. */
export const remarkBotLiteralLinks: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value)
  visit(tree, "link", (node, index, parent) => {
    if (!parent || index === undefined || !node.position || node.children.length !== 1) return
    const label = node.children[0]
    if (label.type !== "text" || !/^https?:\/\//i.test(label.value)) return
    const { start, end } = node.position
    if (start.offset === undefined || end.offset === undefined) return
    if (source.slice(start.offset, end.offset) !== label.value) return
    const boundary = botLiteralLinkBoundary(label.value)
    if (boundary < 0) return
    const url = label.value.slice(0, boundary)
    // Do not invent a link for an incomplete host while tokens are streaming.
    try {
      if (!new URL(url).hostname) return
    } catch {
      return
    }
    const split = { ...start, offset: start.offset + boundary, column: start.column + boundary }
    const suffix: Text = {
      type: "text",
      value: label.value.slice(boundary),
      position: { start: split, end }
    }
    node.url = url
    node.position = { start, end: split }
    node.children = [{ type: "text", value: url, position: node.position }]
    parent.children.splice(index + 1, 0, suffix)
    return [SKIP, index + 2]
  })
}
