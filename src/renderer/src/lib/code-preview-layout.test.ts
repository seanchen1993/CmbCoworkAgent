import { describe, expect, it } from "vitest"
import { shouldSoftWrapCodePreview } from "./code-preview-layout"

describe("shouldSoftWrapCodePreview", () => {
  it("soft-wraps minified HTML and JavaScript instead of showing one oversized line", () => {
    expect(shouldSoftWrapCodePreview(["const bundle=" + "x".repeat(300)])).toBe(true)
  })

  it("keeps ordinary source and large multiline files on the normal layout path", () => {
    expect(shouldSoftWrapCodePreview(["const answer = 42"])).toBe(false)
    expect(shouldSoftWrapCodePreview(Array.from({ length: 1000 }, () => "x".repeat(300)))).toBe(
      false
    )
  })
})
