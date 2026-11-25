import { describe, expect, it } from "vitest"
import { encode } from "iconv-lite"
import AdmZip from "adm-zip"
import {
  MAX_ATTACHMENT_ARCHIVE_TOTAL_BYTES,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_TEXT_LENGTH,
  getSupportedExtensions,
  parseFileBytes
} from "./file-parser"

function bytes(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, "utf8")).buffer
}

describe("bounded attachment byte parser", () => {
  it("parses user-dropped text bytes without accepting a host file path", async () => {
    const result = await parseFileBytes("../../notes.md", bytes("# safe drop\ncontent"), 1_000)
    expect(result).toMatchObject({
      filename: "notes.md",
      filePath: "notes.md",
      content: "# safe drop\ncontent",
      mimeType: "text/markdown",
      truncated: false
    })
  })

  it("hard-bounds input bytes before format parsing", async () => {
    await expect(
      parseFileBytes("oversized.txt", new ArrayBuffer(MAX_ATTACHMENT_FILE_BYTES + 1))
    ).rejects.toThrow(/单文件不超过 5MB/)
  })

  it("hard-bounds output text and validates the requested character budget", async () => {
    const result = await parseFileBytes(
      "long.txt",
      bytes("x".repeat(MAX_ATTACHMENT_TEXT_LENGTH * 2))
    )
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThan(32_000)
    await expect(parseFileBytes("bad.txt", bytes("x"), 0)).rejects.toThrow(
      /字符预算无效/
    )
  })

  it("rejects unsupported extensions without interpreting bytes", async () => {
    await expect(parseFileBytes("payload.exe", bytes("not executable"))).rejects.toThrow(
      /不支持的文件类型/
    )
  })

  it("rejects an Office archive whose declared expansion exceeds the hard budget", async () => {
    const archive = new AdmZip()
    archive.addFile("xl/workbook.xml", Buffer.from("x"))
    const payload = archive.toBuffer()
    const centralHeader = payload.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralHeader).toBeGreaterThanOrEqual(0)
    payload.writeUInt32LE(MAX_ATTACHMENT_ARCHIVE_TOTAL_BYTES + 1, centralHeader + 24)
    await expect(
      parseFileBytes(
        "bomb.xlsx",
        Uint8Array.from(payload).buffer
      )
    ).rejects.toThrow(/解压|条目/)
  })
})

describe("chat document uploads", () => {
  it("extracts declared GBK HTML tables without script or template contents", async () => {
    const html = '<meta charset="gbk"><title>报告</title><script>hidden</script>' +
      '<table><tr><th>部门</th><th>金额</th></tr><tr><td>研发</td><td>42</td></tr></table>' +
      '<template>hidden</template><img src="https://example.invalid/">'
    const result = await parseFileBytes("report.HTM", Uint8Array.from(encode(html, "gbk")).buffer)
    expect(result.content).toContain("研发\t42")
    expect(result.content).toContain("报告")
    expect(result.content).not.toContain("hidden")
    expect(result.mimeType).toBe("text/html")
  })

  it("reads real encoding declarations after comments and raw script text", async () => {
    const html = "<!-- <meta charset=utf-8> -->" +
      "<script>const example = '<meta charset=utf-8>'</script>" +
      '<meta http-equiv="Content-Type" content="text/html; charset=gbk"><p>年度报告</p>'
    const file = Uint8Array.from(encode(html, "gbk")).buffer
    expect((await parseFileBytes("report.html", file)).content).toBe("年度报告")
    expect((await parseFileBytes("bom.html", bytes("\uFEFF<meta charset=gbk><p>年度报告</p>")))
      .content).toBe("年度报告")
  })

  it("preserves table columns across merged cells and resets spans between row groups", async () => {
    const html = `<table><thead><tr><th rowspan="0">组</th><th colspan="2">本期</th>
      <th>上期</th></tr><tr><td>A</td><td>B</td><td>C</td></tr></thead>
      <tbody><tr><td>新组</td><td rowspan="2">跨行</td><td>X</td></tr>
      <tr><td>末行</td><td>Y</td></tr></tbody></table>`
    const lines = (await parseFileBytes("table.html", bytes(html))).content.split(/\n+/)
    expect(lines).toEqual(["组\t本期\t\t上期", "\tA\tB\tC", "新组\t跨行\tX", "末行\t\tY"])
    await expect(parseFileBytes("wide.htm", bytes('<table><td colspan="9999999">x</td></table>')))
      .rejects.toThrow("表格列数")
  })

  it.each(["json", "jsonl", "yaml", "yml", "xml", "log", "tsv"])(
    "accepts %s and enforces the remaining character budget", async ext => {
      expect(getSupportedExtensions()).toContain("." + ext)
      const result = await parseFileBytes("input." + ext, bytes("abcdef"), 3)
      expect(result.content).toBe("abc")
      expect(result.truncated).toBe(true)
    }
  )

  it("explains an empty dynamic document", async () => {
    await expect(parseFileBytes("empty.html", bytes("<title>App</title><main> </main><script>go()</script>")))
      .rejects.toThrow("静态正文")
  })
})
