import { describe, expect, it } from "vitest"
import { filePreviewModeForPath, textPreviewKind } from "./file-preview-mode"

describe("workspace file preview mode", () => {
  it.each([
    "index.html",
    "index.htm",
    "INDEX.HTML",
    "INDEX.HTM",
    "site/pages/index.Html",
    "site\\pages\\index.HtM"
  ])("opens %s as source", (filePath) => {
    expect(filePreviewModeForPath(filePath)).toBe("source")
  })

  it.each([
    "index.xhtml",
    "index.html.txt",
    "html",
    "site.html/index.ts",
    "component.tsx",
    "README.md"
  ])("leaves %s on its default preview", (filePath) => {
    expect(filePreviewModeForPath(filePath)).toBeUndefined()
  })
})

describe("text preview kind", () => {
  it("routes HTML source mode to the code viewer", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        previewMode: "source",
        truncated: false
      })
    ).toBe("code")
  })

  it("keeps HTML as source even when a caller requests document preview", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        previewMode: "preview",
        truncated: false
      })
    ).toBe("code")
  })

  it("does not render truncated HTML as a document", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        previewMode: "preview",
        truncated: true
      })
    ).toBe("code")
  })

  it("does not change Markdown or ordinary source routing", () => {
    expect(
      textPreviewKind({
        markdownLike: true,
        htmlLike: false,
        previewMode: undefined,
        truncated: false
      })
    ).toBe("markdown")
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: false,
        previewMode: undefined,
        truncated: false
      })
    ).toBe("code")
  })
})
