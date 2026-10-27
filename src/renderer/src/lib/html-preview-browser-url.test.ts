import { describe, expect, it } from "vitest"

import { resolveHtmlPreviewBrowserUrl } from "./html-preview-browser-url"

describe("resolveHtmlPreviewBrowserUrl", () => {
  it("does not prepend the workspace to an absolute HTML path", () => {
    expect(
      resolveHtmlPreviewBrowserUrl(
        "/workspace/需求/.cmb-design/ds_123_design-main/index.html",
        "/workspace/需求",
        "darwin"
      )
    ).toBe("file:///workspace/%E9%9C%80%E6%B1%82/.cmb-design/ds_123_design-main/index.html")
  })

  it("still resolves generic relative thumbnail paths against their workspace", () => {
    expect(resolveHtmlPreviewBrowserUrl("preview/index.html", "/workspace", "darwin")).toBe(
      "file:///workspace/preview/index.html"
    )
  })
})
