import { describe, expect, it } from "vitest"
import {
  buildStreamingMarkdownPreview,
  MAX_STREAMING_MARKDOWN_RENDER_CHARS
} from "./streaming-markdown-preview"

describe("bounded protected Markdown previews", () => {
  it("keeps ordinary live documents whole while a retained view uses the same fragments", () => {
    const text = "head\n\n" + "x".repeat(64000) + "\n\ntail"
    expect(buildStreamingMarkdownPreview(text).omittedCharacters).toBe(0)
    const retained = buildStreamingMarkdownPreview(text, 60 * 1024)
    expect(retained.omittedCharacters).toBeGreaterThan(0)
    expect(text.startsWith(retained.head)).toBe(true)
    expect(text.endsWith(retained.tail)).toBe(true)
    expect(retained.head.length + retained.tail.length).toBeLessThanOrEqual(56 * 1024)
    expect(retained.head.length + retained.tail.length + retained.omittedCharacters).toBe(
      text.length
    )
  })

  it("keeps the live paragraph boundaries for oversized retained messages", () => {
    const text = "head paragraph\n\n".repeat(10000)
    expect(buildStreamingMarkdownPreview(text, 60 * 1024)).toEqual(
      buildStreamingMarkdownPreview(text)
    )
  })

  it.each([Number.NaN, Infinity, -1, 1_000_000])(
    "never raises the live render ceiling for %s",
    (limit) => {
      const text = "x".repeat(MAX_STREAMING_MARKDOWN_RENDER_CHARS + 1)
      const preview = buildStreamingMarkdownPreview(text, limit)
      expect(preview.omittedCharacters).toBeGreaterThan(0)
      expect(preview.head.length + preview.tail.length).toBeLessThanOrEqual(
        MAX_STREAMING_MARKDOWN_RENDER_CHARS
      )
    }
  )
})
