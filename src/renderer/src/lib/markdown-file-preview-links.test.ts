import { describe, expect, it } from "vitest"
import { isLocalFileLikeHref, normalizePreviewFileHref } from "./markdown-file-preview-links"

describe("markdown file preview links", () => {
  it("normalizes Windows drive links with a leading slash before matching the workspace", () => {
    expect(
      normalizePreviewFileHref(
        "/D:/workspace/LU76/LU76.12_qua-statistics/src/main/java/com/cmb/qua/statistics/controller/QuaController.java:330",
        "D:/workspace/LU76/LU76.12_qua-statistics"
      )
    ).toBe(
      "D:/workspace/LU76/LU76.12_qua-statistics/src/main/java/com/cmb/qua/statistics/controller/QuaController.java"
    )
  })

  it("classifies unresolved local file links so markdown can block default navigation", () => {
    expect(isLocalFileLikeHref("/D:/workspace/project/src/Foo.java:12")).toBe(true)
    expect(isLocalFileLikeHref("https://example.com/D:/not-local")).toBe(false)
  })
})
