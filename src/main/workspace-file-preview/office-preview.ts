import AdmZip from "adm-zip"
import type { CellObject } from "xlsx"
import {
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_NODES,
  OFFICE_PREVIEW_MAX_OUTPUT_BYTES,
  OFFICE_PREVIEW_MAX_ROWS,
  OFFICE_PREVIEW_MAX_SHEETS,
  type WorkspaceOfficePreviewData
} from "../../shared/workspace-file-preview"

/** Display the original formula when its cached result is absent; never calculate it. */
export function uncachedOfficeFormula(cell: CellObject): string | undefined {
  return cell.f && (cell.t === "z" || cell.v === null || cell.v === undefined)
    ? `=${cell.f.replace(/^=/, "")}（未计算）`
    : undefined
}

function previewTooLarge(): never {
  throw new Error("Office 预览内容超过上限，请保存原文件查看")
}

function assertSpreadsheetShape(bytes: Buffer): void {
  const zip = new AdmZip(bytes)
  const workbook = zip.getEntry("xl/workbook.xml")
  if (!workbook) throw new Error("XLSX 缺少工作簿，无法预览")
  const count =
    workbook
      .getData()
      .toString("utf8")
      .match(/<(?:[\w.-]+:)?sheet(?:\s|\/|>)/g)?.length ?? 0
  if (count === 0) throw new Error("XLSX 没有可预览的工作表")
  if (count > OFFICE_PREVIEW_MAX_SHEETS) {
    throw new Error(`工作表超过 ${OFFICE_PREVIEW_MAX_SHEETS} 张，请保存原文件查看`)
  }
  // SheetJS has a row limit but no column limit. Reject wide XML before its cell parser.
  for (const entry of zip.getEntries()) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(entry.entryName)) continue
    const xml = entry.getData().toString("utf8")
    let rowCells = 0
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?(row|dimension|c)\b([^>]*)>/g)) {
      if (match[1] === "row") rowCells = 0
      if (match[1] === "c" && ++rowCells > OFFICE_PREVIEW_MAX_COLUMNS) previewTooLarge()
      const reference = match[2].match(/\b(?:ref|r)=["']([A-Z]+\d+(?::[A-Z]+\d+)?)["']/)?.[1]
      const column = (reference?.split(":").at(-1) ?? "").match(/^[A-Z]+/)?.[0] ?? ""
      let index = 0
      for (const letter of column) index = index * 26 + letter.charCodeAt(0) - 64
      if (index > OFFICE_PREVIEW_MAX_COLUMNS) {
        throw new Error(`工作表超过 ${OFFICE_PREVIEW_MAX_COLUMNS} 列，请保存原文件查看`)
      }
    }
  }
}

/** Runs only in the existing preview worker after stable read and ZIP-budget validation. */
export async function parseOfficePreview(
  bytes: Buffer,
  fileName: string,
  checkCancelled: () => void
): Promise<WorkspaceOfficePreviewData> {
  checkCancelled()
  if (!/\.(docx|xlsx)$/i.test(fileName)) throw new Error("Office 预览仅支持 DOCX、XLSX")
  let result: WorkspaceOfficePreviewData
  if (/\.docx$/i.test(fileName)) {
    const mammoth = await import("mammoth")
    checkCancelled()
    const converted = await mammoth.convertToHtml(
      { buffer: bytes },
      {
        externalFileAccess: false,
        styleMap: ["p[style-name='Title'] => h1:fresh"],
        // Do not read embedded/linked images or allocate base64 that the preview would discard.
        convertImage: mammoth.images.imgElement(async () => ({ src: "" }))
      }
    )
    const html = converted.value.replace(
      /<img\b[^>]*>/g,
      "<span>（图片已省略，请保存原文件查看）</span>"
    )
    if (Buffer.byteLength(html, "utf8") > OFFICE_PREVIEW_MAX_OUTPUT_BYTES) previewTooLarge()
    if ((html.match(/<[^/!][^>]*>|[^<]+/g)?.length ?? 0) > OFFICE_PREVIEW_MAX_NODES) {
      throw new Error("文档内容过多，请保存原文件查看")
    }
    result = { kind: "docx", html }
  } else {
    assertSpreadsheetShape(bytes)
    checkCancelled()
    const XLSX = await import("xlsx")
    checkCancelled()
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      sheetRows: OFFICE_PREVIEW_MAX_ROWS + 1,
      sheetStubs: true,
      cellFormula: true,
      cellText: true
    })
    if (workbook.SheetNames.length > OFFICE_PREVIEW_MAX_SHEETS) {
      throw new Error("工作表数量超过预览上限，请保存原文件查看")
    }
    let outputBytes = 0
    const budgetString = (value: string): string => {
      if (Buffer.byteLength(value, "utf8") > OFFICE_PREVIEW_MAX_OUTPUT_BYTES) previewTooLarge()
      outputBytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 1
      if (outputBytes > OFFICE_PREVIEW_MAX_OUTPUT_BYTES) previewTooLarge()
      return value
    }
    const sheets = workbook.SheetNames.map((name) => {
      checkCancelled()
      budgetString(name)
      const sheet = workbook.Sheets[name]
      const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null
      const full = sheet["!fullref"] ? XLSX.utils.decode_range(sheet["!fullref"]) : range
      if (range && range.e.c >= OFFICE_PREVIEW_MAX_COLUMNS) previewTooLarge()
      const rows: string[][] = []
      if (range) {
        const end = Math.min(range.e.r, OFFICE_PREVIEW_MAX_ROWS - 1)
        for (let row = range.s.r; row <= end; row++) {
          const cells: string[] = []
          for (let column = range.s.c; column <= range.e.c; column++) {
            const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as
              | CellObject
              | undefined
            cells.push(
              budgetString(
                !cell
                  ? ""
                  : (uncachedOfficeFormula(cell) ??
                      (cell.t === "z" ? "" : XLSX.utils.format_cell(cell)))
              )
            )
          }
          rows.push(cells)
        }
      }
      return { name, rows, truncated: Boolean(full && full.e.r >= OFFICE_PREVIEW_MAX_ROWS) }
    })
    result = { kind: "spreadsheet", sheets, truncated: sheets.some((sheet) => sheet.truncated) }
  }
  checkCancelled()
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > OFFICE_PREVIEW_MAX_OUTPUT_BYTES) {
    previewTooLarge()
  }
  return result
}
