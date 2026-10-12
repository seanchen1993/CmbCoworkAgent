import { expect, it } from "vitest"
import * as XLSX from "xlsx"
import * as iconv from "iconv-lite"
import { readBotTable } from "./table-reader"
import { botTableColumn, botTableText } from "../../shared/bot-table-preview"

const read = (name: string, bytes: Buffer, rowOffset = 0, columnOffset = 0, sheet = 0) =>
  readBotTable({ kind: "table", name, bytes, rowOffset, columnOffset, sheet })

it("preserves quoted delimiters, CRLF, multiline cells, escaped quotes and empty rows", () => {
  const source = '标题,说明\r\n"a,b","第一行\n第二行 ""引用"""\r\n,\r\n'
  expect(read("report.csv", Buffer.from(source))).toMatchObject({
    totalRows: 3,
    totalColumns: 2,
    rows: [
      ["标题", "说明"],
      ["a,b", '第一行\n第二行 "引用"'],
      ["", ""]
    ]
  })
  expect(read("report.tsv", iconv.encode("名称\t状态\r\n中文\t通过", "gb18030")).rows[1]).toEqual([
    "中文",
    "通过"
  ])
  expect(read("empty.csv", Buffer.alloc(0)).rows).toEqual([])
  expect(() => read("broken.csv", Buffer.from('"unclosed'))).toThrow("引号")
})

it("pages past the original 2000-row ceiling and bounds retained rows, columns and cell text", () => {
  const text = Array.from({ length: 2051 }, (_, row) =>
    Array.from({ length: 24 }, (_, col) => `${row}:${col}`).join(",")
  ).join("\n")
  const page = read("rows.csv", Buffer.from(text), 2000, 20)
  expect(page).toMatchObject({ totalRows: 2051, totalColumns: 24 })
  expect(page.rows).toHaveLength(50)
  expect(page.rows[0]).toEqual(["2000:20", "2000:21", "2000:22", "2000:23"])
  expect(read("rows.csv", Buffer.from(text), 2050).rows).toHaveLength(1)
  const hugeCell = read("long.csv", Buffer.from('"' + "文".repeat(2_000_000) + '",end'))
  expect(hugeCell.rows[0][0]).toHaveLength(512)
  expect(hugeCell.rows[0][1]).toBe("end")
  expect(hugeCell.truncated).toBe(true)
  expect(JSON.stringify(hugeCell).length).toBeLessThan(1000)
  expect(() => read("rows.csv", Buffer.from(text), 2051)).toThrow("范围")
  expect(() => read("rows.csv", Buffer.from(text), 0, 24)).toThrow("范围")
})

it.each(["xlsx", "xls"] as const)(
  "reads formatted cached %s values, sheets and real coordinates without running formulas",
  (bookType) => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "空白")
    const sheet = XLSX.utils.aoa_to_sheet([])
    XLSX.utils.sheet_add_aoa(
      sheet,
      [
        ["第一行", 42],
        ["<img src=x onerror=alert(1)>", 2]
      ],
      { origin: "C5" }
    )
    sheet.D5.z = "0.00"
    sheet.D6.f = "1+1"
    sheet["!ref"] = "C5:D6"
    XLSX.utils.book_append_sheet(workbook, sheet, "研发")
    const bytes = XLSX.write(workbook, { bookType, type: "buffer" })
    expect(read(`report.${bookType}`, bytes, 0, 0, 0).rows).toEqual([])
    const page = read(`report.${bookType}`, bytes, 0, 0, 1)
    expect(page).toMatchObject({ sheets: ["空白", "研发"], firstRow: 4, firstColumn: 2 })
    expect(page.rows).toEqual([
      ["第一行", "42.00"],
      ["<img src=x onerror=alert(1)>", "2"]
    ])
    expect(() => read(`report.${bookType}`, bytes, 0, 0, 2)).toThrow("工作表不存在")
  }
)

it("rejects invalid bytes/coordinates and produces quoted plain-text copies", () => {
  expect(() => read("bad.xlsx", Buffer.from("not a workbook"))).toThrow()
  expect(() => read("bad.xls", Buffer.from("<html>remote</html>"))).toThrow()
  expect(() => read("page.html", Buffer.from("html"))).toThrow()
  expect(() => read("data.csv", Buffer.from("x"), -1)).toThrow()
  expect(botTableColumn(0)).toBe("A")
  expect(botTableColumn(26)).toBe("AA")
  expect(botTableColumn(16383)).toBe("XFD")
  expect(
    botTableText([
      ["a\tb", 'c"d'],
      ["<script>", "=A1"]
    ])
  ).toBe('"a\tb"\t"c""d"\n<script>\t=A1')
})
