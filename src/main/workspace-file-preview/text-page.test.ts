import { describe, expect, it } from "vitest"
import { projectWorkspacePreviewTextPage } from "./text-page"
import { WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES } from "../../shared/workspace-file-preview"

describe("workspace preview text projection", () => {
  it("preserves complete CRLF, Unicode and the terminal cursor", () => {
    const content = "first\r\n汉🙂\nlast",
      buffer = Buffer.from(content)
    expect(projectWorkspacePreviewTextPage(buffer, buffer.length, 0, buffer.length)).toEqual({
      content,
      contentBytes: buffer.length,
      consumedBytes: buffer.length,
      lineCount: 3,
      nextOffset: null,
      hasMore: false,
      hasPrevious: false,
      truncated: false
    })
  })

  it("consumes 500 lines and leaves the rest for the next page", () => {
    const first = "line\n".repeat(500),
      buffer = Buffer.from(first + "last\n")
    expect(projectWorkspacePreviewTextPage(buffer, buffer.length, 0, buffer.length)).toEqual({
      content: first,
      contentBytes: Buffer.byteLength(first),
      consumedBytes: Buffer.byteLength(first),
      lineCount: 500,
      nextOffset: Buffer.byteLength(first),
      hasMore: true,
      hasPrevious: false,
      truncated: true
    })
  })

  it("leaves an incomplete codepoint to the next actual byte read", () => {
    const prefix = "a".repeat(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES - 1)
    const complete = Buffer.from(prefix + "🙂"),
      buffer = complete.subarray(0, WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
    const page = projectWorkspacePreviewTextPage(buffer, buffer.length, 0, complete.length)
    expect(page.content).toBe(prefix)
    expect(page.nextOffset).toBe(Buffer.byteLength(prefix))
    const next = projectWorkspacePreviewTextPage(
      complete.subarray(prefix.length),
      4,
      prefix.length,
      complete.length
    )
    expect(next.content).toBe("🙂")
    expect(next.nextOffset).toBeNull()
    expect(next.hasPrevious).toBe(true)
  })

  it("advances malformed bytes while bounding replacement text", () => {
    const buffer = Buffer.alloc(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES, 0x80)
    const page = projectWorkspacePreviewTextPage(buffer, buffer.length, 0, buffer.length + 1)
    expect(page.consumedBytes).toBe(buffer.length)
    expect(page.nextOffset).toBe(buffer.length)
    expect(page.content).toBe("�".repeat(Math.floor(buffer.length / 3)))
    expect(page.contentBytes).toBeLessThanOrEqual(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
  })
})
