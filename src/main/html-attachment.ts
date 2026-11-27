import { parse, type DefaultTreeAdapterMap } from "parse5"

import { MAX_ATTACHMENT_FILE_BYTES } from "../shared/file-attachment"

type Node = DefaultTreeAdapterMap["node"]
type Element = DefaultTreeAdapterMap["element"]
const hidden = new Set(["script", "style", "template", "noscript", "iframe", "object"])
const tableContainers = new Set(["table", "tbody", "thead", "tfoot", "tr"])
const paragraphs = new Set(["title", "p", "div", "section", "br", "tr", "pre", "li",
  "h1", "h2", "h3", "h4", "h5", "h6"])
const attribute = (element: Element, name: string) => element.attrs.find(attr => attr.name === name)?.value

// Parse only the bounded ASCII-compatible prefix used for encoding sniffing. parse5
// distinguishes actual metadata from comments, raw script text and template contents.
export function htmlEncodingDeclaration(prefix: string): string | undefined {
  const stack: Node[] = [parse(prefix)]
  while (stack.length) {
    const node = stack.pop()!
    if ("tagName" in node && node.tagName === "meta") {
      const charset = attribute(node, "charset")
      if (charset) return charset.trim()
      if (attribute(node, "http-equiv")?.toLowerCase() === "content-type") {
        const match = /\bcharset\s*=\s*["']?([\w-]+)/i.exec(attribute(node, "content") ?? "")
        if (match) return match[1]
      }
    }
    if ("childNodes" in node) stack.push(...node.childNodes.slice().reverse())
  }
  return undefined
}

function cellSpan(node: Element, name: string): number {
  const value = attribute(node, name)?.trim() ?? ""
  if (!/^\d+$/.test(value)) return 1
  const span = Number(value)
  if (name === "rowspan") return span === 0 ? Infinity : Math.min(span, 65534)
  return Math.max(1, span)
}

export function extractHtmlText(source: string, image?: (src: string) => string): string {
  const doc = parse(source)
  const html = doc.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "html")
  if (!html) return ""
  const head = html.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "head")
  const title = head?.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "title")
  const body = html.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "body")
  if (!body) return ""

  const stack: Array<Node | string> = [body]
  const parts: string[] = []
  const grids = new WeakMap<Node, { row: number; occupiedUntil: number[] }>()
  const separators = new WeakMap<Node, string>()
  let generatedColumns = 0
  let hasBodyText = false
  while (stack.length) {
    const node = stack.pop()!
    if (typeof node === "string") {
      parts.push(node)
      continue
    }
    if ("value" in node) {
      if (node.parentNode && "tagName" in node.parentNode &&
        tableContainers.has(node.parentNode.tagName) &&
        !node.value.trim()) continue
      parts.push(node.value)
      if (node.value.trim()) hasBodyText = true
    }
    if (!("childNodes" in node)) continue
    const tag = "tagName" in node ? node.tagName : ""
    if (hidden.has(tag)) continue
    if (image && "tagName" in node && tag === "img") {
      parts.push(image(attribute(node, "src") ?? ""))
      hasBodyText = true
    }
    if (image && (tag === "svg" || tag === "canvas")) {
      parts.push(image("data:unsupported"))
      hasBodyText = true
      continue
    }
    if (paragraphs.has(tag)) {
      parts.push("\n")
      stack.push("\n")
    }
    if (tag === "li") parts.push("- ")
    if (tag === "tr" && "parentNode" in node && node.parentNode) {
      const group = node.parentNode
      const grid = grids.get(group) ?? { row: 0, occupiedUntil: [] }
      grids.set(group, grid)
      let column = 0
      let previousStart = -1
      for (const cell of node.childNodes) {
        if (!("tagName" in cell) || (cell.tagName !== "td" && cell.tagName !== "th")) continue
        while (grid.occupiedUntil[column] > grid.row) column++
        const span = cellSpan(cell, "colspan")
        if (column + span > 1024) throw new Error("HTML 表格列数超过解析上限")
        generatedColumns += span + column - Math.max(0, previousStart)
        if (generatedColumns > MAX_ATTACHMENT_FILE_BYTES) throw new Error("HTML 表格展开超过解析上限")
        separators.set(cell, "\t".repeat(column - Math.max(0, previousStart)))
        previousStart = column
        const end = grid.row + cellSpan(cell, "rowspan")
        for (let i = 0; i < span; i++) grid.occupiedUntil[column++] = end
      }
      grid.row++
    }
    const separator = separators.get(node)
    if (separator) parts.push(separator)
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i])
  }
  if (!hasBodyText) return ""
  const heading = title?.childNodes
    .flatMap(node => "value" in node ? [node.value] : []).join("").trim()
  return (heading ? heading + "\n" : "") + parts.join("").replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").replace(/^[\r\n ]+|[\r\n ]+$/g, "")
}
