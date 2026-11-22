import { describe, expect, it } from "vitest"
import {
  normalizeAtFileMentionPath,
  replaceHandledAtFileMentions,
  resolveWorkspaceMentionAbsolutePath,
  stripHandledAtFileMentions
} from "./at-file-mention-text"

describe("handled file mention text", () => {
  it("uses the original logical slash path", () => {
    expect(resolveWorkspaceMentionAbsolutePath("C:\\logical-root\\", "\\src\\file.txt")).toBe(
      "C:/logical-root/src/file.txt"
    )
    expect(normalizeAtFileMentionPath("  /src\\file.txt  ")).toBe("src/file.txt")
  })

  it("replaces accepted quoted, repeated and backslash paths without consuming missing text", () => {
    expect(
      stripHandledAtFileMentions(
        '@"src/file name.txt" @src\\a.txt @missing.txt @src/a.txt',
        new Set(["src/file name.txt", "src/a.txt"])
      )
    ).toBe("src/file name.txt src/a.txt @missing.txt src/a.txt")
  })

  it("retains a protected Bot mention and reports offsets for text edits before it", () => {
    const input = '@"first file.txt" @bot.txt @bot.txt'
    const protectedStart = input.indexOf("@bot.txt")
    const result = replaceHandledAtFileMentions(input, new Set(["first file.txt", "bot.txt"]), [
      { start: protectedStart, end: protectedStart + "@bot.txt".length }
    ])
    expect(result.cleanedMessage).toBe("first file.txt @bot.txt bot.txt")
    expect(result.textEdits.map(edit => input.slice(edit.start, edit.end)))
      .toEqual(['@"first file.txt"', " @bot.txt"])
  })

  it("does not reinterpret a fragment or consume an unhandled request", () => {
    const raw = "read @a.txt#L2-3 @missing.txt"
    expect(stripHandledAtFileMentions(raw, new Set(["a.txt"]))).toBe(raw)
    expect(stripHandledAtFileMentions("keep @a.txt", new Set())).toBe("keep @a.txt")
  })
})
