import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
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

type Cell = { row: number; column: number }
type CellRange = { anchor: Cell; focus: Cell }

function SpreadsheetTable({
  preview,
  sheet
}: {
  preview: WorkspaceOfficePreviewData
  sheet: { name: string; rows: string[][] } | undefined
}) {
  const rows = sheet?.rows.slice(0, OFFICE_PREVIEW_MAX_ROWS) ?? []
  const columns = Math.min(
    OFFICE_PREVIEW_MAX_COLUMNS,
    rows.reduce((count, row) => Math.max(count, row.length), 0)
  )
  // A long first cell is still readable in full; repeating it in every row's
  // accessible name must not multiply the bounded preview payload.
  const columnLabels = Array.from({ length: columns }, (_, column) => {
    const header = rows[0]?.[column] ?? ""
    return (
      (header.length > 80 ? `${header.slice(0, 80).replace(/[\uD800-\uDBFF]$/, "")}…` : header) ||
      `第 ${column + 1} 列`
    )
  })
  const root = React.useRef<HTMLDivElement>(null)
  const surface = React.useRef<HTMLDivElement>(null)
  const [state, setState] = React.useState<{
    preview: WorkspaceOfficePreviewData
    range: CellRange | null
    expanded: boolean
  }>({ preview, range: null, expanded: false })
  if (state.preview !== preview) setState({ preview, range: null, expanded: false })
  const range = state.preview === preview ? state.range : null
  const expanded = state.preview === preview && state.expanded
  const valueAt = (cell: Cell) => rows[cell.row]?.[cell.column] ?? ""
  const labelAt = (cell: Cell) => `预览第 ${cell.row + 1} 行 · ${columnLabels[cell.column]}`
  const bounds = range && {
    top: Math.min(range.anchor.row, range.focus.row),
    bottom: Math.max(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.column, range.focus.column),
    right: Math.max(range.anchor.column, range.focus.column)
  }
  const selected = (cell: Cell) =>
    Boolean(
      bounds &&
      cell.row >= bounds.top &&
      cell.row <= bounds.bottom &&
      cell.column >= bounds.left &&
      cell.column <= bounds.right
    )
  const focusCell = (cell: Cell) => {
    const button = root.current?.querySelector<HTMLButtonElement>(
      `[data-office-row="${cell.row}"][data-office-column="${cell.column}"]`
    )
    button?.focus({ preventScroll: true })
    button?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }
  const choose = (cell: Cell, extend = false, initialAnchor = cell) => {
    setState({
      preview,
      range: { anchor: extend ? (range?.anchor ?? initialAnchor) : cell, focus: cell },
      expanded: false
    })
    focusCell(cell)
  }
  const selectionText = () => {
    if (!bounds) return ""
    const escape = (value: string) =>
      /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
    return rows
      .slice(bounds.top, bounds.bottom + 1)
      .map((row) =>
        Array.from({ length: bounds.right - bounds.left + 1 }, (_, offset) =>
          escape(row[bounds.left + offset] ?? "")
        ).join("\t")
      )
      .join("\n")
  }
  const copy = async () => {
    if (!range) return
    const text = selectionText()
    try {
      await navigator.clipboard.writeText(text)
      toast.success("已复制所选单元格")
    } catch {
      toast.error("复制失败，请重试")
    }
  }
  // Radix's outer dialog handles Escape at document capture. Give this preview's
  // selection the first Escape, without intercepting another dialog or later Escapes.
  React.useEffect(() => {
    if (!range) return
    const onEscape = (event: KeyboardEvent) => {
      const scope = root.current
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        !(event.target instanceof Node) ||
        !scope?.contains(event.target)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      setState({ preview, range: null, expanded: false })
      surface.current?.focus({ preventScroll: true })
    }
    window.addEventListener("keydown", onEscape, true)
    return () => window.removeEventListener("keydown", onEscape, true)
  }, [preview, range])
  const cellButton = (cell: Cell) => {
    const value = valueAt(cell)
    const valueLabel =
      value === ""
        ? "空单元格"
        : value.length > 120
          ? `${value.slice(0, 120).replace(/[\uD800-\uDBFF]$/, "")}…`
          : value
    const active = range?.focus.row === cell.row && range.focus.column === cell.column
    return (
      <button
        type="button"
        data-office-row={cell.row}
        data-office-column={cell.column}
        aria-label={`${labelAt(cell)}：${valueLabel}`}
        title={value || undefined}
        tabIndex={active || (!range && cell.row === 0 && cell.column === 0) ? 0 : -1}
        className={`block min-h-9 w-full truncate px-3 py-2 text-left font-normal focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 ${selected(cell) ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
        onClick={(event) => choose(cell, event.shiftKey)}
      >
        {value || "\u00a0"}
      </button>
    )
  }
  return (
    <div
      ref={root}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.altKey) return
        const target = event.target as HTMLElement
        const cell = target.closest<HTMLButtonElement>("[data-office-row]")
        if (!cell && target !== surface.current) return
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && range) {
          event.preventDefault()
          event.stopPropagation()
          void copy()
          return
        }
        if (event.ctrlKey || event.metaKey || !rows.length || !columns) return
        const delta = (
          { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<
            string,
            number[]
          >
        )[event.key]
        if (!delta) return
        event.preventDefault()
        event.stopPropagation()
        const current = range?.focus ?? {
          row: Number(cell?.dataset.officeRow ?? 0),
          column: Number(cell?.dataset.officeColumn ?? 0)
        }
        choose(
          {
            row: Math.max(0, Math.min(rows.length - 1, current.row + delta[0])),
            column: Math.max(0, Math.min(columns - 1, current.column + delta[1]))
          },
          event.shiftKey,
          current
        )
      }}
    >
      {range && (
        <div
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-2"
          role="region"
          aria-label="所选单元格"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {labelAt(range.focus)}
              {bounds && (bounds.top !== bounds.bottom || bounds.left !== bounds.right)
                ? `（${bounds.bottom - bounds.top + 1} 行 × ${bounds.right - bounds.left + 1} 列）`
                : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setState({ ...state, expanded: !expanded })}
              aria-expanded={expanded}
            >
              {expanded ? "收起完整值" : "展开完整值"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copy()}>
              复制所选单元格
            </Button>
          </div>
          <div
            aria-label="单元格完整值"
            className={
              expanded
                ? "max-h-40 overflow-auto whitespace-pre-wrap break-all text-sm"
                : "truncate whitespace-pre text-sm"
            }
          >
            {valueAt(range.focus) || "\u00a0"}
          </div>
        </div>
      )}
      <div
        ref={surface}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto p-4 focus-visible:outline-none"
      >
        {rows.length && columns ? (
          <table
            role="grid"
            aria-label={sheet?.name}
            aria-multiselectable="true"
            className="table-fixed border-collapse text-sm"
            style={{ width: 48 + columns * 176, minWidth: "100%" }}
          >
            <colgroup>
              <col style={{ width: 48 }} />
              {Array.from({ length: columns }, (_, column) => (
                <col key={column} style={{ width: 176 }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th
                  scope="col"
                  className="border border-border px-2 text-xs font-normal"
                  title="预览行号"
                >
                  #
                </th>
                {Array.from({ length: columns }, (_, column) => (
                  <th
                    key={column}
                    scope="col"
                    aria-selected={selected({ row: 0, column })}
                    className="border border-border text-left"
                  >
                    {cellButton({ row: 0, column })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((_, index) => (
                <tr key={index}>
                  <th
                    scope="row"
                    className="border border-border bg-muted/40 px-2 text-right text-xs font-normal text-muted-foreground"
                  >
                    {index + 2}
                  </th>
                  {Array.from({ length: columns }, (_, column) => (
                    <td
                      key={column}
                      role="gridcell"
                      aria-selected={selected({ row: index + 1, column })}
                      className="border border-border"
                    >
                      {cellButton({ row: index + 1, column })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">工作表为空。</p>
        )}
      </div>
    </div>
  )
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
        className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden focus-visible:ring-inset"
      >
        <SpreadsheetTable key={selectedSheet} preview={preview} sheet={sheet} />
        {truncated && (
          <p role="status" className="shrink-0 px-4 py-2 text-sm text-muted-foreground">
            内容较多，仅展示部分行、列或工作表。请下载查看完整工作簿。
          </p>
        )}
      </TabsContent>
    </Tabs>
  )
}
