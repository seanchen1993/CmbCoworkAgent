import { describe, expect, it } from "vitest"
import { parseBotFileDelivery, parseBotOutputFiles } from "./file-delivery"

describe("verified file delivery projection", () => {
  it("bounds explicit portable output paths without accepting private or ambiguous destinations", () => {
    expect(parseBotOutputFiles()).toEqual([])
    const paths = ["reports/核验 报告.md", "data.csv"]
    expect(parseBotOutputFiles(paths)).toEqual(["data.csv", "reports/核验 报告.md"])
    expect(paths[0]).toBe("reports/核验 报告.md")
    for (const value of [
      null,
      "report.md",
      ["../private.md"],
      ["a/../x"],
      ["/tmp/x"],
      ["C:/x"],
      ["a\\x"],
      ["a//x"],
      ["./x"],
      ["a\0b"],
      ["a\nb"],
      ["x."],
      ["a/COM1.txt"],
      ["x", "x"],
      Array(9).fill("x"),
      [""]
    ])
      expect(() => parseBotOutputFiles(value)).toThrow("协作输出")
  })
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
