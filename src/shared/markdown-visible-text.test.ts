import { describe, expect, it } from "vitest"
import { projectMarkdownVisibleText } from "./markdown-visible-text"

describe("Markdown visible search projection", () => {
  it("keeps link labels but excludes link and image destinations", () => {
    const text = projectMarkdownVisibleText(
      "[visible label](https://hidden.example/path_(secret)) ![alt](hidden-image.png)"
    )
    expect(text).toContain("visible label")
    expect(text).not.toContain("hidden.example")
    expect(text).not.toContain("hidden-image")
    expect(text).not.toContain("alt")
    expect(projectMarkdownVisibleText("visible\n[ref]: https://visible.example\nend"))
      .toBe("visible\n[ref]: https://visible.example\nend")
    expect(projectMarkdownVisibleText("visible\n\n[ref]: https://hidden.example\n\nend"))
      .toBe("visible\n\n\nend")
  })

  it("preserves visible emphasis, inline code, fenced code and GFM order", () => {
    expect(projectMarkdownVisibleText("**bold** then `code`\n```ts\nconst x = 1\n```\n| cell |"))
      .toBe("bold then code\nconst x = 1\n| cell |")
  })

  it("preserves coding punctuation and projects common GFM controls", () => {
    expect(projectMarkdownVisibleText("foo_bar *.ts a > b #tag ~x\n- item\n1. next\n- [x] done"))
      .toBe("foo_bar *.ts a > b #tag ~x\nitem\nnext\ndone")
    expect(projectMarkdownVisibleText("[label][ref]\n\n[ref]: https://hidden\n\n&amp;"))
      .toBe("label\n\n\n&")
    expect(projectMarkdownVisibleText("```ts\nunclosed body"))
      .toBe("unclosed body")
    expect(projectMarkdownVisibleText("```diff\n+ [x](literal)\n- #tag *.ts\n```"))
      .toBe("+ [x](literal)\n- #tag *.ts\n")
    expect(projectMarkdownVisibleText("    ```ts\n    literal fence"))
      .toBe("    ```ts\n    literal fence")
    expect(() => projectMarkdownVisibleText("&#999999999;")).not.toThrow()
    expect(projectMarkdownVisibleText("foo__bar__ a__b__c")).toBe("foo__bar__ a__b__c")
    expect(projectMarkdownVisibleText("__init__ obj.__class__")).toBe("init obj.class")
  })

  it("keeps a multi-megabyte projection linear", () => {
    const markdown = "plain foo_bar [label](https://hidden) `code`\n".repeat(85_000)
    const started = performance.now()
    const projected = projectMarkdownVisibleText(markdown)
    expect(projected).toContain("plain foo_bar label code")
    expect(projected).not.toContain("https://hidden")
    expect(performance.now() - started).toBeLessThan(1_500)
  })
})
