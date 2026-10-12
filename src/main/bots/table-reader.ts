import { extname } from "node:path"
import * as XLSX from "xlsx"
import { assertBoundedOfficeArchive, decodeTextFileAutoEncoding } from "../file-parser"
import { botTableRequest, botTableResult } from "./table-contract"
import { readDelimitedTable } from "./upstream/grok-delimited-table"
import {
  BOT_TABLE_CELL_CHARACTERS,
  BOT_TABLE_COLUMNS,
  BOT_TABLE_ROWS,
  type BotTablePage
} from "../../shared/bot-table-preview"

/** Only called in the disposable document worker. Never evaluates formulas,
 * opens workbook links or materializes a full sheet_to_json array. */
export function readBotTable(input: unknown): BotTablePage {
  const request = botTableRequest.parse(input)
  const { name, sheet, rowOffset, columnOffset } = request
  const bytes = Buffer.from(request.bytes)
  const extension = extname(name).toLowerCase()
  let result: BotTablePage
  if (extension === ".csv" || extension === ".tsv") {
    if (sheet !== 0) throw new Error("工作表不存在")
    result = {
      sheets: ["Sheet 1"],
      sheet,
      rowOffset,
      columnOffset,
      firstRow: 0,
      firstColumn: 0,
      ...readDelimitedTable(
        decodeTextFileAutoEncoding(bytes),
        extension === ".tsv" ? "\t" : ",",
        rowOffset,
        columnOffset
      )
    }
  } else {
    if (extension === ".xlsx") assertBoundedOfficeArchive(bytes)
    else if (extension !== ".xls") throw new Error("不支持的表格格式")
    else if (!bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
      throw new Error("文件不是有效的 Excel 工作簿")
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellText: true,
      bookVBA: false,
      bookDeps: false
    })
    if (!workbook.SheetNames.length || workbook.SheetNames.length > 100)
      throw new Error("预览支持 1 至 100 个工作表，请拆分后查看")
    const target = workbook.Sheets[workbook.SheetNames[sheet]]
    if (!target) throw new Error("工作表不存在")
    let hasCells = false
    for (const key in target) {
      if (/^[A-Z]+[1-9][0-9]*$/.test(key)) {
        hasCells = true
        break
      }
    }
    const range = hasCells && target["!ref"] ? XLSX.utils.decode_range(target["!ref"]) : null
    if (
      range &&
      (![range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger) ||
        range.s.r < 0 ||
        range.s.c < 0 ||
        range.e.r < range.s.r ||
        range.e.c < range.s.c ||
        range.e.r > 1_048_575 ||
        range.e.c > 16_383)
    )
      throw new Error("工作表包含无效的单元格范围")
    result = {
      sheets: workbook.SheetNames,
      sheet,
      rowOffset,
      columnOffset,
      firstRow: range?.s.r ?? 0,
      firstColumn: range?.s.c ?? 0,
      totalRows: range ? range.e.r - range.s.r + 1 : 0,
      totalColumns: range ? range.e.c - range.s.c + 1 : 0,
      rows: [],
      truncated: false
    }
    for (let row = rowOffset; row < Math.min(result.totalRows, rowOffset + BOT_TABLE_ROWS); row++) {
      const cells: string[] = []
      for (
        let column = columnOffset;
        column < Math.min(result.totalColumns, columnOffset + BOT_TABLE_COLUMNS);
        column++
      ) {
        const cell =
          target[
            XLSX.utils.encode_cell({ r: result.firstRow + row, c: result.firstColumn + column })
          ]
        const text = cell ? String(cell.w ?? cell.v ?? "") : ""
        if (text.length > BOT_TABLE_CELL_CHARACTERS) result.truncated = true
        cells.push(text.slice(0, BOT_TABLE_CELL_CHARACTERS))
      }
      result.rows.push(cells)
    }
  }
  if (
    (rowOffset && rowOffset >= result.totalRows) ||
    (columnOffset && columnOffset >= result.totalColumns)
  )
    throw new Error("页码超出工作表范围")
  return botTableResult.parse(result)
}
