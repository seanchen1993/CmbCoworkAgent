import { describe, expect, it } from "vitest"
import { normalizeReleaseNotesForDisplay, sanitizeReleaseNotesUrl } from "./release-notes"

describe("normalizeReleaseNotesForDisplay", () => {
  it("keeps real line breaks and decodes escaped line breaks", () => {
    expect(normalizeReleaseNotesForDisplay("第一行\n第二行")).toBe("第一行\n第二行")
    expect(normalizeReleaseNotesForDisplay("第一行\\n第二行\\r\\n第三行\\r第四行")).toBe(
      "第一行\n第二行\n第三行\n第四行"
    )
  })

  it("preserves escaped sequences in inline and fenced code", () => {
    expect(normalizeReleaseNotesForDisplay("使用 `\\n`\\n- 下一项")).toBe("使用 `\\n`\n- 下一项")
    expect(normalizeReleaseNotesForDisplay("```text\nvalue: \\n\n```\\n- 下一项")).toBe(
      "```text\nvalue: \\n\n```\n- 下一项"
    )
  })

  it("preserves drive and UNC paths while decoding following separators", () => {
    expect(normalizeReleaseNotesForDisplay(String.raw`修复 C:\new\release\n- 下一项`)).toBe(
      "修复 C:\\\\new\\\\release\n- 下一项"
    )
    expect(normalizeReleaseNotesForDisplay(String.raw`修复 \\nas\new\n- 下一项`)).toBe(
      "修复 \\\\\\\\nas\\\\new\n- 下一项"
    )
  })
})

describe("sanitizeReleaseNotesUrl", () => {
  it("allows only absolute HTTP(S) links", () => {
    expect(sanitizeReleaseNotesUrl("https://example.com/release", "href")).toBe(
      "https://example.com/release"
    )
    expect(sanitizeReleaseNotesUrl("http://example.com/release", "href")).toBe(
      "http://example.com/release"
    )
    expect(sanitizeReleaseNotesUrl("../../Windows/System32/calc.exe", "href")).toBe("")
    expect(sanitizeReleaseNotesUrl("file:///C:/Windows/System32/calc.exe", "href")).toBe("")
    expect(sanitizeReleaseNotesUrl("javascript:alert(1)", "href")).toBe("")
    expect(sanitizeReleaseNotesUrl("mailto:test@example.com", "href")).toBe("")
  })

  it("blocks image and other resource URLs", () => {
    expect(sanitizeReleaseNotesUrl("https://example.com/tracker.png", "src")).toBe("")
  })
})
