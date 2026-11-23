import AdmZip from "adm-zip"
import * as XLSX from "xlsx"
import { describe, expect, it, vi } from "vitest"
import { OFFICE_PREVIEW_MAX_OUTPUT_BYTES } from "../../shared/workspace-file-preview"
import { parseOfficePreview, uncachedOfficeFormula } from "./office-preview"

function docx(body: string): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    )
  )
  zip.addFile(
    "_rels/.rels",
    Buffer.from(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    )
  )
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
    )
  )
  return zip.toBuffer()
}

function workbook(sheet: XLSX.WorkSheet, sheets = 1): Buffer {
  const book = XLSX.utils.book_new()
  for (let index = 0; index < sheets; index++)
    XLSX.utils.book_append_sheet(book, sheet, `表${index + 1}`)
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer
}

describe("bounded Office semantic preview", () => {
  it("preserves Chinese paragraphs and real table cells without touching source bytes", async () => {
    const input = docx(
      `<w:p><w:r><w:t>合成核验报告</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>N2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>-7.20</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    )
    const copy = Buffer.from(input)
    const result = await parseOfficePreview(input, "报告.docx", () => {})
    expect(result.kind).toBe("docx")
    if (result.kind !== "docx") throw new Error("expected docx")
    expect(result.html).toContain("<p>合成核验报告</p>")
    expect(result.html).toContain("<table>")
    expect(result.html).toContain("N2")
    expect(result.html).toContain("-7.20")
    expect(input.equals(copy)).toBe(true)
  })

  it("omits actual embedded and linked images without reading them or returning resource URLs", async () => {
    const drawing = (relationship: string) =>
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr descr="图片"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip ${relationship}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    const zip = new AdmZip(docx(drawing('r:embed="embedded"') + drawing('r:link="linked"')))
    zip.updateFile(
      "word/document.xml",
      Buffer.from(
        zip
          .getEntry("word/document.xml")!
          .getData()
          .toString()
          .replace(
            "<w:document ",
            '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
          )
      )
    )
    zip.addFile(
      "word/_rels/document.xml.rels",
      Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="embedded" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/><Relationship Id="linked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/private.png" TargetMode="External"/></Relationships>'
      )
    )
    zip.addFile(
      "word/media/image.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5qkAAAAASUVORK5CYII=",
        "base64"
      )
    )
    const mammoth = await import("mammoth")
    const originalConverter = mammoth.images.imgElement
    const imageReaders: ReturnType<typeof vi.spyOn>[] = []
    const converter = vi.spyOn(mammoth.images, "imgElement").mockImplementation((convert) =>
      originalConverter((image) => {
        for (const method of [
          "read",
          "readAsBuffer",
          "readAsArrayBuffer",
          "readAsBase64String"
        ] as const)
          imageReaders.push(vi.spyOn(image, method))
        return convert(image)
      })
    )
    try {
      const result = await parseOfficePreview(zip.toBuffer(), "images.docx", () => {})
      if (result.kind !== "docx") throw new Error("expected docx")
      expect(result.html.match(/图片已省略/g)).toHaveLength(2)
      expect(result.html).not.toMatch(/<img\b|data:|https:|src=/)
      expect(imageReaders).toHaveLength(8)
      for (const reader of imageReaders) expect(reader).not.toHaveBeenCalled()
    } finally {
      converter.mockRestore()
    }
  })

  it("keeps uncached formulas visible without fabricating zero or executing them", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["合计", 0],
      ["缓存零", 0],
      ["金额", -7.2]
    ])
    sheet.B1 = { t: "n", f: "SUM(B3:B3)" }
    sheet.B2 = { t: "n", v: 0, f: "1-1", z: "0.00" }
    sheet.B3.z = "0.00"
    const result = await parseOfficePreview(workbook(sheet), "金额.xlsx", () => {})
    if (result.kind !== "spreadsheet") throw new Error("expected workbook")
    expect(result.sheets[0].rows).toEqual([
      ["合计", "=SUM(B3:B3)（未计算）"],
      ["缓存零", "0.00"],
      ["金额", "-7.20"]
    ])
    expect(uncachedOfficeFormula({ t: "z", v: 0, f: "SUM(A1:A3)" })).toBe("=SUM(A1:A3)（未计算）")
    expect(uncachedOfficeFormula({ t: "n", v: 0, f: "1-1" })).toBeUndefined()
  })

  it("limits rows before projecting cells and marks the preview as partial", async () => {
    const sheet = XLSX.utils.aoa_to_sheet(Array.from({ length: 205 }, (_, i) => [`行${i}`]))
    const result = await parseOfficePreview(workbook(sheet), "rows.xlsx", () => {})
    if (result.kind !== "spreadsheet") throw new Error("expected workbook")
    expect(result.sheets[0].rows).toHaveLength(200)
    expect(result.sheets[0].rows.at(-1)).toEqual(["行199"])
    expect(result.sheets[0].truncated).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it("rejects wide and too-many-sheet documents before the full workbook parser", async () => {
    await expect(
      parseOfficePreview(
        workbook(XLSX.utils.aoa_to_sheet([Array(51).fill("x")])),
        "wide.xlsx",
        () => {}
      )
    ).rejects.toThrow(/50 列/)
    await expect(
      parseOfficePreview(workbook(XLSX.utils.aoa_to_sheet([["x"]]), 21), "sheets.xlsx", () => {})
    ).rejects.toThrow(/20 张/)
  })

  it("does not allow implicit cell coordinates to bypass the column budget", async () => {
    const zip = new AdmZip(workbook(XLSX.utils.aoa_to_sheet([["x"]])))
    zip.updateFile(
      "xl/worksheets/sheet1.xml",
      Buffer.from(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row>${'<c t="n"><v>1</v></c>'.repeat(51)}</row></sheetData></worksheet>`
      )
    )
    await expect(parseOfficePreview(zip.toBuffer(), "implicit.xlsx", () => {})).rejects.toThrow(
      /超过上限/
    )
  })

  it("rejects oversized semantic output and excessive document nodes", async () => {
    const text = "长".repeat(OFFICE_PREVIEW_MAX_OUTPUT_BYTES)
    await expect(
      parseOfficePreview(docx(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`), "large.docx", () => {})
    ).rejects.toThrow(/超过上限/)
    await expect(
      parseOfficePreview(
        docx("<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(2100)),
        "nodes.docx",
        () => {}
      )
    ).rejects.toThrow(/内容过多/)
    const sheet = XLSX.utils.aoa_to_sheet(
      Array.from({ length: 200 }, () => Array(50).fill("非空金额"))
    )
    await expect(parseOfficePreview(workbook(sheet), "cells.xlsx", () => {})).rejects.toThrow(
      /超过上限/
    )
  })

  it("honors cancellation both before parsing and before returning a result", async () => {
    const input = docx("<w:p><w:r><w:t>核验</w:t></w:r></w:p>")
    await expect(
      parseOfficePreview(input, "report.docx", () => {
        throw new Error("cancelled")
      })
    ).rejects.toThrow("cancelled")
    let checks = 0
    await expect(
      parseOfficePreview(input, "report.docx", () => {
        if (++checks === 3) throw new Error("cancelled")
      })
    ).rejects.toThrow("cancelled")
  })

  it("rejects corrupt or unsupported formats without a fallback interpretation", async () => {
    await expect(parseOfficePreview(Buffer.from("bad"), "bad.docx", () => {})).rejects.toThrow()
    await expect(parseOfficePreview(Buffer.from("bad"), "bad.xlsx", () => {})).rejects.toThrow()
    await expect(parseOfficePreview(Buffer.from("bad"), "bad.pdf", () => {})).rejects.toThrow(
      /DOCX、XLSX/
    )
  })
})
