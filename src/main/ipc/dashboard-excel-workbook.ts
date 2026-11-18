export type DashboardExcelCell =
  | string
  | number
  | {
      value: string | number
      formula?: string
      hyperlink?: string
      numberFormat?: string
    }
export interface DashboardExcelSheet {
  name: string
  header: string[]
  rows: DashboardExcelCell[][]
  summaryRows?: DashboardExcelCell[][]
  autoFilter?: boolean
}
export function excelColumn(index: number): string {
  let name = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}
export function excelDataStart(sheet: Pick<DashboardExcelSheet, "summaryRows">): number {
  const length = sheet.summaryRows?.length ?? 0
  return length + (length ? 1 : 0) + 2
}

/** 普通导出仍接受字符串、数字；指标导出在主进程使用公式和工作簿内部链接。 */
export async function buildDashboardExcelBuffer(sheets: DashboardExcelSheet[]): Promise<Buffer> {
  const XLSX = await import("xlsx")
  const workbook = XLSX.utils.book_new()
  for (const sheet of sheets) {
    if (sheet.rows.length + excelDataStart(sheet) > 1_048_577)
      throw new Error(`${sheet.name} 超过 Excel 行数上限，请缩小统计周期`)
    const summary = sheet.summaryRows ?? []
    const data = [...summary, ...(summary.length ? [[]] : []), sheet.header, ...sheet.rows]
    const rows = data.map((row) =>
      row.map((cell): string | number | import("xlsx").CellObject => {
        if (typeof cell !== "object") return cell
        return {
          t: typeof cell.value === "number" ? "n" : "s",
          v: cell.value,
          ...(cell.formula ? { f: cell.formula } : {}),
          ...(cell.hyperlink ? { l: { Target: cell.hyperlink, Tooltip: "查看计算依据" } } : {}),
          ...(cell.numberFormat ? { z: cell.numberFormat } : {})
        }
      })
    )
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws["!cols"] = sheet.header.map((h, index) => {
      let length = h.length
      for (const row of data) {
        const cell = row[index]
        const value = typeof cell === "object" ? cell.value : cell
        length = Math.max(length, String(value ?? "").length)
      }
      return { wch: Math.min(length + 4, 40) }
    })
    if (sheet.autoFilter && sheet.rows.length)
      ws["!autofilter"] = {
        ref: `A${excelDataStart(sheet) - 1}:${excelColumn(sheet.header.length - 1)}${excelDataStart(sheet) + sheet.rows.length - 1}`
      }
    XLSX.utils.book_append_sheet(workbook, ws, sheet.name.slice(0, 31))
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer
}
