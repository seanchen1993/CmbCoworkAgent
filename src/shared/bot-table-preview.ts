/** Bounded presentation data. Cells are text, never executable formulas or HTML. */
export const BOT_TABLE_ROWS = 50
export const BOT_TABLE_COLUMNS = 20
export const BOT_TABLE_CELL_CHARACTERS = 512

export interface BotTablePage {
  sheets: string[]
  sheet: number
  rowOffset: number
  columnOffset: number
  /** Zero-based coordinates of the first cell in the selected sheet's used range. */
  firstRow: number
  firstColumn: number
  totalRows: number
  totalColumns: number
  rows: string[][]
  truncated: boolean
}

export function botTableColumn(index: number): string {
  let label = ""
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label
  return label
}

export function botTableText(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[\t\r\n"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join("\t")
    )
    .join("\n")
}
