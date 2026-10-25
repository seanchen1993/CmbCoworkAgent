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
  it("preserves optional sent-byte paths while accepting legacy references and rejecting malformed copies", () => {
    const legacy = { filePath: "/workspace/report.md", name: "report.md", size: 0 }
    const sent = { ...legacy, attachmentPath: "/workspace/.bot-deliveries/hash/report.md" }
    const parse = (files: unknown[]) =>
      parseBotFileDelivery(JSON.stringify({ kind: "bot-file-delivery", files }))
    expect(parse([sent])).toEqual([sent])
    expect(parse([legacy])).toEqual([legacy])
    for (const attachmentPath of [null, "", "bad\0path", "x".repeat(4097), 12])
      expect(parse([{ ...legacy, attachmentPath }])).toBeNull()
    // Adding a snapshot must not reduce the previously accepted eight-path range.
    const long = Array.from({ length: 8 }, (_, i) => ({
      ...legacy,
      filePath: `/${i}/` + "a".repeat(3990),
      attachmentPath: `/${i}/` + "b".repeat(3990)
    }))
    expect(parse(long)).toEqual(long)
  })
})
