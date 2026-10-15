import { describe, expect, it } from "vitest"
import { parseBotFileDelivery } from "./file-delivery"

describe("verified file delivery projection", () => {
  it("keeps real zero-byte and Unicode metadata without interpreting assistant prose", () => {
    const files = [{ filePath: "C:\\workspace\\核验 报告.md", name: "核验 报告.md", size: 0 }]
    expect(parseBotFileDelivery(JSON.stringify({ kind: "bot-file-delivery", files }))).toEqual(
      files
    )
    expect(parseBotFileDelivery("[核验 报告](C:/workspace/核验 报告.md)")).toBeNull()
  })
  it("rejects malformed, excessive, duplicated and unsafe file metadata", () => {
    const file = { filePath: "/workspace/report.md", name: "report.md", size: 32 }
    for (const files of [
      [],
      Array(9).fill(file),
      [file, file],
      [{ ...file, size: -1 }],
      [{ ...file, size: 1.1 }],
      [{ ...file, name: "../report.md" }],
      [{ ...file, filePath: "a\0b" }],
      [{ ...file, name: null }]
    ])
      expect(parseBotFileDelivery(JSON.stringify({ kind: "bot-file-delivery", files }))).toBeNull()
    expect(parseBotFileDelivery("x".repeat(40_001))).toBeNull()
    expect(parseBotFileDelivery(null)).toBeNull()
  })
})
