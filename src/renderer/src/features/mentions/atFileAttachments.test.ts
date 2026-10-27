import type { FileInfo } from "@/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isMentionedWorkspaceFileForWorkspace,
  readBoundedWorkspaceMentionFile,
  retainMentionedWorkspaceFilesForWorkspace,
  resolveAtFileAttachments,
  toMentionedWorkspaceFile
} from "./atFileAttachments"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
    const mentionedFile = toMentionedWorkspaceFile(
      {
        id: "/notes.md",
        displayPath: "notes.md",
        workspaceFilePath: "/notes.md",
        filename: "notes.md",
        size: 20
      },
      "C:/workspace"
    )
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

  it("binds a selected chip to its normalized workspace and removes it after A -> B", () => {
    vi.stubGlobal("window", { electron: { process: { platform: "win32" } } })
    const selectedInA = toMentionedWorkspaceFile(
      {
        id: "/same.md",
        displayPath: "same.md",
        workspaceFilePath: "/same.md",
        filename: "same.md"
      },
      "C:\\Workspace-A\\"
    )

    expect(isMentionedWorkspaceFileForWorkspace(selectedInA, "c:/workspace-a")).toBe(true)
    expect(isMentionedWorkspaceFileForWorkspace(selectedInA, "C:/workspace-b")).toBe(false)
    expect(retainMentionedWorkspaceFilesForWorkspace([selectedInA], "C:/workspace-b")).toEqual([])
  })

  it("never reads B/same.md or labels it as A/same.md when an A chip is stale", async () => {
    const selectedInA = toMentionedWorkspaceFile(
      {
        id: "/same.md",
        displayPath: "same.md",
        workspaceFilePath: "/same.md",
        filename: "same.md"
      },
      "C:/workspace-a"
    )
    const readWorkspaceFile = vi.fn().mockResolvedValue({
      success: true,
      content: "content from workspace B"
    })

    const result = await resolveAtFileAttachments({
      rawMessage: "",
      attachments: [],
      mentionedFiles: [selectedInA],
      workspacePath: "C:/workspace-b",
      workspaceFiles: [{ path: "/same.md", is_dir: false }],
      maxAttachments: 3,
      maxTotalChars: 24_000,
      readWorkspaceFile
    })

    expect(readWorkspaceFile).not.toHaveBeenCalled()
    expect(result.attachments).toEqual([])
    expect(result.warningMessage).toBe("@文件所属工作区已变更，旧工作区引用未被发送。")
  })
})


it("keeps explicit Bot identities while resolving same-named and surrounding real file references", async () => {
  const rawMessage = "@a.csv @b.csv @a.csv @c.csv @b.csv"
  const protectedRanges = [{ start: 7, end: 13 }, { start: 14, end: 20 }]
  const reads: string[] = []
  const result = await resolveAtFileAttachments({
    rawMessage, protectedRanges, attachments: [], mentionedFiles: [], workspacePath: "/workspace",
    workspaceFiles: ["a.csv", "b.csv", "c.csv"].map(path => ({ path, name: path, is_dir: false } as FileInfo)),
    maxAttachments: 5, maxTotalChars: 1000,
    readWorkspaceFile: async path => { reads.push(path); return { success: true, content: "id,amount\n1,3" } }
  })
  expect(reads).toEqual(["/a.csv", "/c.csv", "/b.csv"])
  expect(result.cleanedMessage).toBe("a.csv @b.csv @a.csv c.csv b.csv")
  expect(result.attachments).toHaveLength(3)
  const onlyBot = await resolveAtFileAttachments({
    rawMessage: "@b.csv", protectedRanges: [{ start: 0, end: 6 }], attachments: [], mentionedFiles: [], workspacePath: "/workspace",
    workspaceFiles: [{ path: "b.csv", name: "b.csv", is_dir: false } as FileInfo], maxAttachments: 5, maxTotalChars: 1000,
    readWorkspaceFile: async () => { throw new Error("Selected Bot is not a file") }
  })
  expect(onlyBot.attachments).toEqual([])
  expect(onlyBot.cleanedMessage).toBe("@b.csv")
  expect(onlyBot.textEdits).toEqual([])
})
