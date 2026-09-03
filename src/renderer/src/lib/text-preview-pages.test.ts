import { describe, expect, it, vi } from "vitest"
import type { WorkspaceFilePreviewTextResult } from "../../../shared/workspace-file-preview"
import { assembleBoundedTextPreview, shouldAssembleWebSourcePreview } from "./text-preview-pages"

function page(
  content: string,
  offset: number,
  nextOffset: number | null,
  overrides: Partial<WorkspaceFilePreviewTextResult> = {}
): WorkspaceFilePreviewTextResult {
  return {
    success: true,
    content,
    contentBytes: content.length,
    size: nextOffset ?? offset + content.length,
    modified_at: "2026-09-03T00:00:00.000Z",
    offset,
    nextOffset,
    hasMore: nextOffset !== null,
    hasPrevious: offset > 0,
    truncated: offset > 0 || nextOffset !== null,
    lineCount: 1,
    ...overrides
  }
}

describe("assembleBoundedTextPreview", () => {
  it("targets HTML and JavaScript source variants without widening all text previews", () => {
    expect(shouldAssembleWebSourcePreview("C:\\project\\index.HTML")).toBe(true)
    expect(shouldAssembleWebSourcePreview("bundle.min.js")).toBe(true)
    expect(shouldAssembleWebSourcePreview("runtime.cjs")).toBe(true)
    expect(shouldAssembleWebSourcePreview("server.ts")).toBe(false)
    expect(shouldAssembleWebSourcePreview("application.log")).toBe(false)
  })

  it("assembles a complete HTML or JavaScript preview from bounded IPC pages", async () => {
    const first = page("<html>\n", 0, 7, { size: 22 })
    const second = page("<body>\n", 7, 14, { size: 22 })
    const third = page("</html>\n", 14, null, { size: 22 })
    const readPage = vi.fn(async (offset: number) => (offset === 7 ? second : third))

    const result = await assembleBoundedTextPreview(first, readPage, {
      maxBytes: 1024,
      maxPages: 8
    })

    expect(result.content).toBe("<html>\n<body>\n</html>\n")
    expect(result.truncated).toBe(false)
    expect(result.hasMore).toBe(false)
    expect(result.lineCount).toBe(3)
    expect(readPage).toHaveBeenCalledTimes(2)
  })

  it("keeps the last included cursor when the next page would exceed the render budget", async () => {
    const first = page("a".repeat(64), 0, 64, { size: 192 })
    const second = page("b".repeat(64), 64, 128, { size: 192 })
    const readPage = vi.fn(async () => second)

    const result = await assembleBoundedTextPreview(first, readPage, {
      maxBytes: 100,
      maxPages: 8
    })

    expect(result).toBe(first)
    expect(result.nextOffset).toBe(64)
    expect(result.truncated).toBe(true)
  })

  it("rejects pages from a changed file instead of stitching different revisions", async () => {
    const first = page("first", 0, 5, { size: 10 })
    const changed = page("next", 5, null, {
      size: 9,
      modified_at: "2026-09-03T00:00:01.000Z"
    })

    await expect(
      assembleBoundedTextPreview(first, async () => changed, {
        maxBytes: 1024,
        maxPages: 8
      })
    ).rejects.toThrow("文件在预览加载期间发生变化")
  })
})
