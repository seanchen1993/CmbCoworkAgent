import * as React from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_NODES,
  OFFICE_PREVIEW_MAX_ROWS,
  OFFICE_PREVIEW_MAX_SHEETS,
  type WorkspaceOfficePreviewData
} from "../../../../shared/workspace-file-preview"

const documentTags = new Set(
  "h1 h2 h3 h4 h5 h6 p br strong b em i u s del sup sub ol ul li blockquote pre code table thead tbody tfoot tr td th caption hr".split(
    " "
  )
)
const transparentTags = new Set(["a", "span", "div"])
const tagClasses: Record<string, string> = {
  h1: "text-2xl font-semibold",
  h2: "text-xl font-semibold",
  h3: "text-lg font-semibold",
  h4: "font-semibold",
  h5: "font-semibold",
  h6: "font-semibold",
  p: "whitespace-pre-wrap leading-7",
  ul: "list-disc space-y-1 pl-6",
  ol: "list-decimal space-y-1 pl-6",
  blockquote: "border-l-2 border-border pl-4 text-muted-foreground",
  pre: "overflow-x-auto rounded-md bg-muted p-3",
  table: "w-full border-collapse text-sm",
  td: "border border-border px-3 py-2 align-top",
  th: "border border-border bg-muted px-3 py-2 text-left font-medium"
}

/** Project inert nodes into React; no source attributes or resource elements are copied. */
function projectOfficeNodes(nodes: ArrayLike<ChildNode>) {
  let remaining = OFFICE_PREVIEW_MAX_NODES
  let truncated = false
  const visit = (
    children: ArrayLike<ChildNode>,
    depth: number,
    path: string
  ): React.ReactNode[] => {
    const result: React.ReactNode[] = []
    for (let index = 0; index < children.length; index++) {
      if (remaining-- <= 0 || depth > 64) {
        truncated = true
        break
      }
      const node = children[index]
      if (node.nodeType === 3) {
        result.push(node.textContent ?? "")
        continue
      }
      if (node.nodeType !== 1) continue
      const element = node as Element
      const tag = element.tagName.toLowerCase()
      if (!documentTags.has(tag) && !transparentTags.has(tag)) continue
      const key = `${path}-${index}`
      const content = visit(element.childNodes, depth + 1, key)
      if (transparentTags.has(tag)) {
        result.push(...content)
        continue
      }
      const props: Record<string, unknown> = { key, className: tagClasses[tag] }
      if (tag === "td" || tag === "th") {
        for (const [attribute, prop] of [
          ["colspan", "colSpan"],
          ["rowspan", "rowSpan"]
        ]) {
          const value = element.getAttribute(attribute) ?? ""
          if (/^[1-9]\d{0,2}$/.test(value) && Number(value) <= 100) props[prop] = Number(value)
        }
      }
      result.push(React.createElement(tag, props, ...(tag === "br" || tag === "hr" ? [] : content)))
    }
    return result
  }
  const projected = visit(nodes, 0, "office")
  return { nodes: projected, truncated }
}

function projectOfficeHtml(html: string) {
  // Template descendants stay inert, including images. Prevent input closing our wrapper.
  const document = new DOMParser().parseFromString(
    `<template>${html.replace(/<\/template/gi, "&lt;/template")}</template>`,
    "text/html"
  )
  return projectOfficeNodes(document.querySelector("template")?.content.childNodes ?? [])
}

export function BotOfficeFilePreview({
  preview,
  filePath
}: {
  preview: WorkspaceOfficePreviewData
  filePath: string
}) {
  const [selection, setSelection] = React.useState({ preview, index: 0 })
  const selectedSheet = selection.preview === preview ? selection.index : 0
  if (selection.preview !== preview) setSelection({ preview, index: 0 })
  const document = React.useMemo(
    () => (preview.kind === "docx" ? projectOfficeHtml(preview.html) : null),
    [preview]
  )
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  if (document) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-6" role="document" aria-label={fileName}>
        <div className="space-y-4 break-words">{document.nodes}</div>
        {!document.nodes.length && (
          <p className="text-muted-foreground">文档没有可预览的文字或表格。</p>
        )}
        {document.truncated && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            内容较多，仅展示部分内容。请下载查看完整文档。
          </p>
        )}
      </div>
    )
  }
  if (preview.kind !== "spreadsheet") return null
  const sheets = preview.sheets.slice(0, OFFICE_PREVIEW_MAX_SHEETS)
  const sheet = sheets[selectedSheet] ?? sheets[0]
  const rows = sheet?.rows.slice(0, OFFICE_PREVIEW_MAX_ROWS) ?? []
  const truncated =
    preview.truncated ||
    preview.sheets.length > sheets.length ||
    sheet?.truncated ||
    (sheet?.rows.length ?? 0) > rows.length ||
    rows.some((row) => row.length > OFFICE_PREVIEW_MAX_COLUMNS)
  return (
    <Tabs
      value={String(selectedSheet)}
      onValueChange={(value) => setSelection({ preview, index: Number(value) })}
      className="flex min-h-0 flex-1 flex-col"
      role="region"
      aria-label={fileName}
    >
      <TabsList
        className="h-auto shrink-0 justify-start overflow-x-auto rounded-none border-b border-border bg-transparent px-3 py-2"
        aria-label="工作表"
      >
        {sheets.map((item, index) => (
          <TabsTrigger key={index} value={String(index)} className="shrink-0">
            {item.name}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent
        value={String(selectedSheet)}
        className="mt-0 min-h-0 flex-1 overflow-auto p-4 focus-visible:ring-inset"
      >
        {rows.length ? (
          <table className="w-full border-collapse text-sm">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.slice(0, OFFICE_PREVIEW_MAX_COLUMNS).map((cell, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="whitespace-pre-wrap border border-border px-3 py-2 align-top"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">工作表为空。</p>
        )}
        {truncated && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            内容较多，仅展示部分行、列或工作表。请下载查看完整工作簿。
          </p>
        )}
      </TabsContent>
    </Tabs>
  )
}
