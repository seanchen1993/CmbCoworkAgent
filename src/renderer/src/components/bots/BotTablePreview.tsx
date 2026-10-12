import { useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Copy, Table2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  BOT_TABLE_COLUMNS,
  BOT_TABLE_ROWS,
  botTableColumn,
  type BotTablePage
} from "../../../../shared/bot-table-preview"

/** Follows Grok's sheet switcher and cell detail interaction. Existing Cmb
 * dialog/clipboard own the lifecycle; only a bounded page enters the DOM. */
export function BotTablePreview({
  table,
  navigate
}: {
  table: BotTablePage
  navigate(sheet: number, rowOffset: number, columnOffset: number): void
}) {
  const [selected, setSelected] = useState({ row: 0, column: 0 })
  const grid = useRef<HTMLTableElement>(null)
  const columns = Math.min(BOT_TABLE_COLUMNS, Math.max(0, table.totalColumns - table.columnOffset))
  const cell = table.rows[selected.row]?.[selected.column] ?? ""
  const address = `${botTableColumn(table.firstColumn + table.columnOffset + selected.column)}${table.firstRow + table.rowOffset + selected.row + 1}`
  const page = (rowOffset: number, columnOffset = table.columnOffset) =>
    navigate(table.sheet, rowOffset, columnOffset)
  const select = (row: number, column: number) => {
    const next = {
      row: Math.max(0, Math.min(table.rows.length - 1, row)),
      column: Math.max(0, Math.min(columns - 1, column))
    }
    setSelected(next)
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${next.row}:${next.column}"]`)
      ?.focus()
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Table2 size={15} className="shrink-0 text-muted-foreground" />
          <Select
            value={String(table.sheet)}
            onValueChange={(value) => navigate(Number(value), 0, 0)}
          >
            <SelectTrigger className="h-8 w-44 max-w-[45vw] text-xs" aria-label="选择工作表">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {table.sheets.map((name, index) => (
                <SelectItem key={index} value={String(index)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {table.totalRows.toLocaleString()} 行 · {table.totalColumns.toLocaleString()} 列
        </span>
      </div>
      {table.rows.length && columns ? (
        <>
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <table
              ref={grid}
              className="w-full table-fixed border-separate border-spacing-0 text-xs"
              style={{ minWidth: 48 + columns * 144 }}
              aria-label={`${table.sheets[table.sheet]} 表格预览`}
            >
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  <th className="w-12 border-b border-r px-2 py-2" aria-label="行号" />
                  {Array.from({ length: columns }, (_, column) => (
                    <th
                      key={column}
                      scope="col"
                      className="w-36 border-b border-r px-3 py-2 font-medium text-muted-foreground"
                    >
                      {botTableColumn(table.firstColumn + table.columnOffset + column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th
                      scope="row"
                      className="sticky left-0 border-b border-r bg-muted px-2 text-center font-normal tabular-nums text-muted-foreground"
                    >
                      {table.firstRow + table.rowOffset + rowIndex + 1}
                    </th>
                    {Array.from({ length: columns }, (_, column) => {
                      const active = selected.row === rowIndex && selected.column === column
                      const coordinate = `${botTableColumn(table.firstColumn + table.columnOffset + column)}${table.firstRow + table.rowOffset + rowIndex + 1}`
                      return (
                        <td key={column} className="border-b border-r p-0">
                          <button
                            type="button"
                            data-cell={`${rowIndex}:${column}`}
                            tabIndex={active ? 0 : -1}
                            aria-label={`单元格 ${coordinate}`}
                            aria-pressed={active}
                            className={cn(
                              "block h-9 w-full truncate px-3 text-left outline-none transition-colors motion-reduce:transition-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              active && "bg-primary/10 ring-1 ring-inset ring-primary/40"
                            )}
                            onClick={() => setSelected({ row: rowIndex, column })}
                            onKeyDown={(event) => {
                              const delta = {
                                ArrowUp: [-1, 0],
                                ArrowDown: [1, 0],
                                ArrowLeft: [0, -1],
                                ArrowRight: [0, 1]
                              }[event.key]
                              if (!delta) return
                              event.preventDefault()
                              select(rowIndex + delta[0], column + delta[1])
                            }}
                          >
                            {row[column] ?? ""}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex max-h-28 shrink-0 items-start gap-3 overflow-auto border-t bg-muted/20 px-4 py-2">
            <span className="pt-1 text-xs font-medium tabular-nums text-muted-foreground">
              {address}
            </span>
            <p
              className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-1 text-xs"
              aria-label="所选单元格内容"
            >
              {cell || "空单元格"}
            </p>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              aria-label="复制单元格"
              disabled={!cell}
              onClick={() =>
                void navigator.clipboard
                  .writeText(cell)
                  .then(() => toast.success("已复制单元格"))
                  .catch(() => toast.error("复制失败"))
              }
            >
              <Copy size={13} />
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          此工作表为空
        </div>
      )}
      {table.truncated && (
        <p className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
          较长单元格仅预览前 512 个字符，完整内容请保存原文件查看。
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="上一页行"
            disabled={!table.rowOffset}
            onClick={() => page(Math.max(0, table.rowOffset - BOT_TABLE_ROWS))}
          >
            <ChevronLeft size={14} />
          </Button>
          <span className="min-w-20 text-center tabular-nums">
            {table.totalRows
              ? `${table.rowOffset + 1}–${table.rowOffset + table.rows.length} 行`
              : "0 行"}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="下一页行"
            disabled={table.rowOffset + table.rows.length >= table.totalRows}
            onClick={() => page(table.rowOffset + BOT_TABLE_ROWS)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="前面的列"
            disabled={!table.columnOffset}
            onClick={() =>
              page(table.rowOffset, Math.max(0, table.columnOffset - BOT_TABLE_COLUMNS))
            }
          >
            <ChevronLeft size={14} />
          </Button>
          <span className="min-w-20 text-center tabular-nums">
            {columns
              ? `${botTableColumn(table.firstColumn + table.columnOffset)}–${botTableColumn(table.firstColumn + table.columnOffset + columns - 1)} 列`
              : "0 列"}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label="后面的列"
            disabled={table.columnOffset + columns >= table.totalColumns}
            onClick={() => page(table.rowOffset, table.columnOffset + BOT_TABLE_COLUMNS)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
