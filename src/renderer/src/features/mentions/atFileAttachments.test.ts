import { afterEach, describe, expect, it, vi } from "vitest"
import {
  readBoundedWorkspaceMentionFile,
  resolveAtFileAttachments,
  type MentionedWorkspaceFile
} from "./atFileAttachments"

afterEach(() => {
  vi.useRealTimers()
})

describe("bounded @file attachment reads", () => {
  it("stops paging as soon as the remaining character budget is filled", async () => {
    const offsets: number[] = []
    const result = await readBoundedWorkspaceMentionFile({
      maxChars: 7,
      readPage: async (offset) => {
        offsets.push(offset)
        return offset === 0
          ? {
              success: true,
              content: "abcd",
              contentBytes: 4,
              size: 100,
              modified_at: "2026-08-25T00:00:00.000Z",
              offset: 0,
              nextOffset: 4,
              hasMore: true,
              hasPrevious: false,
              truncated: true,
              lineCount: 1
            }
          : {
              success: true,
              content: "efgh",
              contentBytes: 4,
              size: 100,
              modified_at: "2026-08-25T00:00:00.000Z",
              offset: 4,
              nextOffset: 8,
              hasMore: true,
              hasPrevious: true,
              truncated: true,
              lineCount: 1
            }
      }
    })

    expect(offsets).toEqual([0, 4])
    expect(result).toEqual({ success: true, content: "abcdefg", size: 100, truncated: true })
  })

  it("rejects a non-advancing preview cursor", async () => {
    await expect(
      readBoundedWorkspaceMentionFile({
        maxChars: 100,
        readPage: async () => ({
          success: true,
          content: "x",
          contentBytes: 1,
          size: 10,
          modified_at: "2026-08-25T00:00:00.000Z",
          offset: 0,
          nextOffset: 0,
          hasMore: true,
          hasPrevious: false,
          truncated: true,
          lineCount: 1
        })
      })
    ).resolves.toEqual({ success: false })
  })

  it("cancels the underlying worker when the 3-second enhancement timeout expires", async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const mentionedFile: MentionedWorkspaceFile = {
      id: "/notes.md",
      displayPath: "notes.md",
      workspaceFilePath: "/notes.md",
      filename: "notes.md",
      size: 20,
      absolutePath: "C:/workspace/notes.md"
    }
    const pending = resolveAtFileAttachments({
      rawMessage: "",
      attachments: [],
      mentionedFiles: [mentionedFile],
      workspacePath: "C:/workspace",
      workspaceFiles: [],
      maxAttachments: 3,
      maxTotalChars: 24_000,
      readWorkspaceFile: () => new Promise(() => undefined),
      cancelWorkspaceFileReads: cancel
    })

    await vi.advanceTimersByTimeAsync(3_001)
    await expect(pending).resolves.toMatchObject({
      attachments: [],
      warningMessage: "@文件部分处理失败，已按普通消息继续发送。"
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
