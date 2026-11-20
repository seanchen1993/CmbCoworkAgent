import { describe, expect, it } from "vitest"
import { HTML_PREVIEW_MESSAGE_TYPE, isHtmlPreviewRuntimeStatus } from "./html-preview-runtime"

describe("HTML preview runtime status", () => {
  it.each(["ready", "error", "blocked"])("accepts the active document's %s status", (kind) => {
    expect(
      isHtmlPreviewRuntimeStatus({ type: HTML_PREVIEW_MESSAGE_TYPE, id: "active", kind }, "active")
    ).toBe(true)
  })

  it.each([
    null,
    "ready",
    {},
    { kind: "ready" },
    { type: HTML_PREVIEW_MESSAGE_TYPE, id: "old", kind: "ready" },
    { type: HTML_PREVIEW_MESSAGE_TYPE, id: "active", kind: "read-file" }
  ])("rejects malformed, stale, or unsupported messages: %j", (message) => {
    expect(isHtmlPreviewRuntimeStatus(message, "active")).toBe(false)
  })
})
