import { describe, expect, it } from "vitest"
import { markdownSearchAdmission, projectMarkdownVisibleText } from "./markdown-visible-text"

describe("Markdown visible search projection", () => {
  it.each([
    ["Release is **very *ready*** for rollout.", "Release is very ready for rollout."],
    ["Inline code is ` line\nbreak ` today.", "Inline code is line break today."],
    ["Build &copy; 2026 after review.", "Build © 2026 after review."],
    ["Before [missing book][REF_ID] after.", "Before [missing book][REF_ID] after."],
    ["prefix [manual](broken\n\nurl) suffix", "prefix [manual](broken\nurl) suffix"],
    ["> Recommended\n> steps", "\nRecommended\nsteps\n"],
    [String.raw`Open C:\ai\CmbCoworkAgent now.`, String.raw`Open C:\ai\CmbCoworkAgent now.`],
    ["```diff\n+ [x](literal &lt;ready&gt;)\n- #tag *.ts\n```", "+ [x](literal &lt;ready&gt;)\n- #tag *.ts\n"],
    ["[visible label](https://hidden.example/path_(secret)) ![alt](hidden-image.png)", "visible label "],
    ["[label][ref]\n\n[ref]: https://hidden\n\n&amp;", "label\n&"],
    ["visible\n[ref]: https://visible.example\nend", "visible\n[ref]: https://visible.example\nend"],
    ["---", ""],
    ["1. ordered item", "\nordered item\n"],
    ["prefix ``abc`", "prefix ``abc`"]
  ])("projects %j with the normal chat Markdown semantics", (source, text) => {
    expect(projectMarkdownVisibleText(source)).toEqual({ text, truncated: false })
  })

  it("indexes GFM table cell text without exposing its separator syntax", () => {
    const result = projectMarkdownVisibleText("Color | Value\n:--- | ---:\nred | active")
    expect(result.truncated).toBe(false)
    expect(result.text).toMatch(/Color\s+Value\s+red\s+active/)
    expect(result.text).not.toContain("|")
    expect(result.text).not.toContain("---")
  })

  it("admits long literal text and reports pathological parser input as unsearched", () => {
    const literal = "the original message ".repeat(8_000) + "final words"
    expect(markdownSearchAdmission(literal)).toBe("literal")
    expect(projectMarkdownVisibleText(literal)).toEqual({ text: literal, truncated: false })
    const started = performance.now()
    for (const source of ["[x](".repeat(16_000), "> ".repeat(4000), "-\t".repeat(1700),
      "1.\t".repeat(1700), "`".repeat(64_000), literal.repeat(6)]) {
      expect(projectMarkdownVisibleText(source)).toEqual({ text: "", truncated: true })
    }
    const wideTable = ["| x ".repeat(7000), "| - ".repeat(7000), "| y ".repeat(7000)].join("|\n")
    expect(projectMarkdownVisibleText(wideTable)).toEqual({ text: "", truncated: true })
    expect(projectMarkdownVisibleText("**important**\n" + "normal x\n".repeat(5000)))
      .toEqual({ text: "", truncated: true })
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
