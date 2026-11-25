import { parse, type DefaultTreeAdapterMap } from "parse5"

const hidden = new Set(["script", "style", "template", "noscript", "iframe", "object"])
const paragraphs = new Set(["title", "p", "div", "section", "br", "tr", "pre", "li",
  "h1", "h2", "h3", "h4", "h5", "h6"])

export function extractHtmlText(source: string): string {
  type Node = DefaultTreeAdapterMap["node"]
  const stack: Array<Node | string> = [parse(source)]
  const parts: string[] = []
  while (stack.length) {
    const node = stack.pop()!
    if (typeof node === "string") {
      parts.push(node)
      continue
    }
    if ("value" in node) parts.push(node.value)
    if (!("childNodes" in node)) continue
    const tag = "tagName" in node ? node.tagName : ""
    if (hidden.has(tag)) continue
    if (paragraphs.has(tag)) {
      parts.push("\n")
      stack.push("\n")
    }
    if (tag === "li") parts.push("- ")
    if (tag === "td" || tag === "th") stack.push("\t")
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i])
  }
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}
