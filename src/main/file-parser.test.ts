import { describe, expect, it } from "vitest"
import AdmZip from "adm-zip"
import {
  MAX_ATTACHMENT_ARCHIVE_TOTAL_BYTES,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_TEXT_LENGTH,
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
