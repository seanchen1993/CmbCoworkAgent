import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5"

export interface HtmlSourceEdit {
  start: number
  end: number
  value: string
}

/** Apply edits against original offsets, with one allocation of the final document. */
export function applyHtmlSourceEdits(html: string, edits: HtmlSourceEdit[]): string {
  const parts: string[] = []
  let offset = 0
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (edit.start < offset || edit.end < edit.start || edit.end > html.length)
      throw new Error("HTML 修改范围重叠或无效")
    parts.push(html.slice(offset, edit.start), edit.value)
    offset = edit.end
  }
  parts.push(html.slice(offset))
  return parts.join("")
}

export function htmlElements(root: Tree.Node): Tree.Element[] {
  const result: Tree.Element[] = []
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if ("tagName" in node) result.push(node)
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i])
  }
  return result
}

/** Locate real HTML tags; tag-shaped strings in scripts/comments are never insertion points. */
export function insertDesignBodyScript(html: string, code: string, marker: string): string {
  if (!/^data-design-[a-z-]+$/.test(marker)) throw new Error("无效的宿主脚本标记")
  const nodes = htmlElements(parse(html, { sourceCodeLocationInfo: true }))
  const edits: HtmlSourceEdit[] = nodes
    .filter((node) => node.tagName === "script" && node.attrs.some((attr) => attr.name === marker))
    .flatMap((node) =>
      node.sourceCodeLocation
        ? [
            {
              start: node.sourceCodeLocation.startOffset,
              end: node.sourceCodeLocation.endOffset,
              value: ""
            }
          ]
        : []
    )
  const body = nodes.find((node) => node.tagName === "body")
  const root = nodes.find((node) => node.tagName === "html")
  const offset =
    body?.sourceCodeLocation?.endTag?.startOffset ??
    root?.sourceCodeLocation?.endTag?.startOffset ??
    html.length
  edits.push({
    start: offset,
    end: offset,
    value: `<script ${marker}>${code.replace(/<\/script/gi, "<\\/script")}</script>`
  })
  return applyHtmlSourceEdits(html, edits)
}
