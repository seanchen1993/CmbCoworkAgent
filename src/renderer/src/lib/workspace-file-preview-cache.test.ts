import { beforeEach, describe, expect, it } from "vitest"
import { WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES } from "../../../shared/workspace-file-preview"
import {
  readWorkspaceFilePreviewCache,
  resetWorkspaceFilePreviewCacheForTests,
  workspaceFilePreviewCacheStatsForTests,
  writeWorkspaceFilePreviewCache
} from "./workspace-file-preview-cache"

beforeEach(resetWorkspaceFilePreviewCacheForTests)

describe("workspace file preview renderer cache", () => {
  it("uses a total-byte LRU instead of retaining every opened file", () => {
    for (let index = 0; index < 100; index += 1) {
      const content = String(index).padEnd(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES, "x")
      writeWorkspaceFilePreviewCache(`file-${index}`, {
        success: true,
        content,
        contentBytes: Buffer.byteLength(content),
        size: content.length,
        modified_at: "2026-08-24T00:00:00.000Z",
        offset: 0,
        nextOffset: null,
        hasMore: false,
        hasPrevious: false,
        truncated: false,
        lineCount: 1
      })
    }

    const stats = workspaceFilePreviewCacheStatsForTests()
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes)
    expect(stats.entries).toBeLessThan(100)
    expect(readWorkspaceFilePreviewCache("file-0")).toBeUndefined()
    expect(readWorkspaceFilePreviewCache("file-99")?.content.startsWith("99")).toBe(true)
  })
})
