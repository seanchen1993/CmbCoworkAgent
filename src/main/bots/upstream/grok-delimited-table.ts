// Adapted from the user-provided Grok spreadsheet-viewer-model.ts.
// See PROVENANCE.json. One shared lexer serves preview and exact output validation.
import {
  BOT_TABLE_ROWS,
  BOT_TABLE_COLUMNS,
  BOT_TABLE_CELL_CHARACTERS
} from "../../../shared/bot-table-preview"

type DelimitedVisitor = {
  field(value: string, row: number, column: number, truncated: boolean): void
  row(columns: number, row: number): void
  retain?: (row: number, column: number) => boolean
  maxFieldCharacters: number
  /** Output validation rejects malformed quoting; preview retains vendor behavior. */
  strict?: boolean
}
export function scanDelimitedTable(
  text: string,
  delimiter: "," | "\t",
  visitor: DelimitedVisitor
): void {
  let field = "",
    quoted = false,
    hasContent = false,
    truncated = false
  let row = 0,
    column = 0,
    fieldStarted = false,
    closedQuote = false
  const append = (character: string) => {
    if (visitor.retain && !visitor.retain(row, column)) return
    if (field.length < visitor.maxFieldCharacters) field += character
    else truncated = true
  }
  const pushField = () => {
    visitor.field(field, row, column, truncated)
    field = ""
    truncated = false
    fieldStarted = false
    closedQuote = false
    column++
  }
  const pushRow = () => {
    pushField()
    visitor.row(column, row)
    row++
    column = 0
    hasContent = false
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          append('"')
          index++
        } else {
          quoted = false
          closedQuote = true
        }
      } else append(character)
      continue
    }
    if (character === '"') {
      if (visitor.strict && (fieldStarted || closedQuote))
        throw new Error("表格字段中的引号格式无效")
      quoted = true
      fieldStarted = true
      hasContent = true
      continue
    }
    if (character === delimiter) {
      hasContent = true
      pushField()
      continue
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++
      pushRow()
      continue
    }
    if (visitor.strict && closedQuote) throw new Error("表格引号结束后包含多余字符")
    append(character)
    fieldStarted = true
    hasContent = true
  }
  if (quoted) throw new Error("表格包含未闭合的引号，请检查原文件")
  if (hasContent || column > 0) pushRow()
}

export function readDelimitedTable(
  text: string,
  delimiter: "," | "\t",
  rowOffset: number,
  columnOffset: number
) {
  const rows: string[][] = []
  let row: string[] = [],
    totalRows = 0,
    totalColumns = 0,
    truncated = false
  const selectedRow = (index: number) => index >= rowOffset && index < rowOffset + BOT_TABLE_ROWS
  scanDelimitedTable(text, delimiter, {
    maxFieldCharacters: BOT_TABLE_CELL_CHARACTERS,
    retain: (row, column) =>
      selectedRow(row) && column >= columnOffset && column < columnOffset + BOT_TABLE_COLUMNS,
    field(value, rowIndex, column, clipped) {
      if (
        !selectedRow(rowIndex) ||
        column < columnOffset ||
        column >= columnOffset + BOT_TABLE_COLUMNS
      )
        return
      row.push(value)
      truncated ||= clipped
    },
    row(columns, rowIndex) {
      totalColumns = Math.max(totalColumns, columns)
      totalRows++
      if (selectedRow(rowIndex)) rows.push(row)
      row = []
    }
  })
  return { rows, totalRows, totalColumns, truncated }
}
