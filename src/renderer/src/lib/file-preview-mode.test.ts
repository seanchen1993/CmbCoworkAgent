import { describe, expect, it } from "vitest"
import {
  resourcePreviewModeForPath,
  textPreviewKind,
  workspaceFilePreviewModeForPath
} from "./file-preview-mode"

describe("HTML preview mode by surface", () => {
  it.each([
    "index.html",
    "index.htm",
    "INDEX.HTML",
    "INDEX.HTM",
    "site/pages/index.Html",
    "site\\pages\\index.HtM"
  ])("opens resource preview %s as source and workspace file as UI", (filePath) => {
    expect(resourcePreviewModeForPath(filePath)).toBe("source")
    expect(workspaceFilePreviewModeForPath(filePath)).toBe("preview")
  })

  it.each([
    "index.xhtml",
    "index.html.txt",
    "html",
    "site.html/index.ts",
    "component.tsx",
    "README.md"
  ])("leaves %s on its default preview", (filePath) => {
    expect(resourcePreviewModeForPath(filePath)).toBeUndefined()
    expect(workspaceFilePreviewModeForPath(filePath)).toBeUndefined()
  })
})

describe("text preview kind", () => {
  it("renders HTML only for an explicitly enabled preview surface", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        allowHtmlRender: true,
        previewMode: "preview",
        truncated: false
      })
    ).toBe("html")
  })

  it("routes HTML source mode to the code viewer", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        allowHtmlRender: true,
        previewMode: "source",
        truncated: false
      })
    ).toBe("code")
  })

  it("keeps HTML as source when the surface did not explicitly enable rendering", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        allowHtmlRender: false,
        previewMode: "preview",
        truncated: false
      })
    ).toBe("code")
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        allowHtmlRender: true,
        previewMode: undefined,
        truncated: false
      })
    ).toBe("code")
  })

  it("does not render truncated HTML as a document", () => {
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: true,
        allowHtmlRender: true,
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
        allowHtmlRender: false,
        previewMode: undefined,
        truncated: false
      })
    ).toBe("markdown")
    expect(
      textPreviewKind({
        markdownLike: false,
        htmlLike: false,
        allowHtmlRender: false,
        previewMode: undefined,
        truncated: false
      })
    ).toBe("code")
  })
})
