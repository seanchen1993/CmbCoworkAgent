import type { Root, RootContent, Text } from "mdast"
import { isLocalFileLikeHref } from "./markdown-file-preview-links"

/** Recover local file links whose destinations contain unescaped spaces.
 * Repair parsed text only; tag standalone delivery links without touching code or images.
 * The existing preview component still enforces the workspace boundary.
 */
export function remarkBotFileLinks(): (tree: Root) => void {
  return (tree) => {
    const visit = (parent: Root | RootContent): void => {
      if (!("children" in parent) || parent.type === "link" || parent.type === "linkReference")
        return
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index]
        if (child.type !== "text") {
          visit(child)
          continue
        }
        const parts: Array<Text | Extract<RootContent, { type: "link" }>> = []
        const pattern = /\[([^\[\]\n]+)\]\(([^()\n]+)\)/g
        let offset = 0
        for (const match of child.value.matchAll(pattern)) {
          const path = match[2]
          // Do not reinterpret Markdown titles, images or incomplete streamed links.
          if (
            !path.includes(" ") ||
            path !== path.trim() ||
            /[<>"']/.test(path) ||
            !isLocalFileLikeHref(path) ||
            child.value[match.index! - 1] === "!"
          )
            continue
          if (match.index! > offset)
            parts.push({ type: "text", value: child.value.slice(offset, match.index) })
          parts.push({ type: "link", url: path, children: [{ type: "text", value: match[1] }] })
          offset = match.index! + match[0].length
        }
        if (!parts.length) continue
        if (offset < child.value.length)
          parts.push({ type: "text", value: child.value.slice(offset) })
        parent.children.splice(index, 1, ...parts)
        index += parts.length - 1
      }
      // A standalone delivery link becomes a card; references inside prose stay inline.
      if (parent.type === "paragraph") {
        const content = parent.children.filter(
          (child) => child.type !== "text" || child.value.trim()
        )
        if (content.length === 1 && content[0].type === "link") {
          const link = content[0]
          if (isLocalFileLikeHref(link.url) || !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link.url)) {
            link.data = {
              ...link.data,
              hProperties: { ...link.data?.hProperties, "data-bot-file-card": "true" }
            }
          }
        }
      }
    }
    visit(tree)
  }
}
