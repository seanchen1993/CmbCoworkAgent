import type { FileInfo } from "@/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildAttachmentMessageParts } from "../../../../shared/attachment-message-parts"
import { formatTransferredBotReplyEdit } from "../../../../shared/bots/message-reply"
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
  it("keeps imported quote mentions literal while retaining authored file choices and editor attachment cleanup", async () => {
    const quote = { id: "source", ordinal: 1, role: "assistant" as const,
      text: 'Read @notes.md and @"config.json".\n@notes.md is reference data.' }
    const edited = formatTransferredBotReplyEdit("📎 old.csv\n\nCheck @current.md", quote)
    // The ordinary edit path removes display-only paperclip rows, never restores their attachments.
    const rawMessage = edited.replace(/^(?:📎[^\n]*\n)+(?:\n)?/u, "").trim()
    expect(rawMessage).not.toContain("old.csv")
    expect(rawMessage).toContain("\\@notes.md")
    expect(rawMessage).toContain("@current.md")
    const reads: string[] = []
    const resolved = await resolveAtFileAttachments({
      rawMessage, attachments: [], mentionedFiles: [], workspacePath: "/workspace",
      workspaceFiles: ["notes.md", "config.json", "current.md"].map(path => ({ path, name: path, is_dir: false } as FileInfo)),
      maxAttachments: 5, maxTotalChars: 24000,
      readWorkspaceFile: async path => { reads.push(path); return { success: true, content: "Selected current file" } }
    })
    expect(reads).toEqual(["/current.md"])
    expect(resolved.attachments).toHaveLength(1)
    expect(resolved.cleanedMessage).toContain("\\@notes.md")
    expect(resolved.cleanedMessage).not.toContain("old.csv")
  })

  it("reads a retained chip through the current conversation's attachment capability", async () => {
    const selected = toMentionedWorkspaceFile({
      id: "/notes.md", displayPath: "notes.md", workspaceFilePath: "/notes.md", filename: "notes.md"
    }, "/workspace")
    const readWorkspaceFile = vi.fn(async () => ({ success: true, content: "workspace preview" }))
    const readWorkspaceAttachment = vi.fn(async () => ({
      filename: "notes.md", filePath: "/retained/notes.md", content: "retained bytes",
      size: 14, mimeType: "text/plain", truncated: false,
      botInputId: "input-00000000-0000-0000-0000-000000000000"
    }))
    const input = {
      rawMessage: "Review this file", attachments: [], mentionedFiles: [selected],
      workspacePath: "/workspace", workspaceFiles: [], maxAttachments: 3, maxTotalChars: 24000,
      readWorkspaceFile
    }

    const managed = await resolveAtFileAttachments({ ...input, readWorkspaceAttachment })
    expect(readWorkspaceFile).not.toHaveBeenCalled()
    expect(readWorkspaceAttachment).toHaveBeenCalledWith("/notes.md", 24000)
    expect(managed.attachments).toEqual([expect.objectContaining({
      filePath: "/retained/notes.md", botInputId: expect.any(String)
    })])

    const ordinary = await resolveAtFileAttachments(input)
    expect(readWorkspaceFile).toHaveBeenCalledWith("/notes.md", 24000)
    expect(ordinary.attachments).toEqual([expect.objectContaining({
      filePath: "/workspace/notes.md", content: "workspace preview"
    })])
    expect(ordinary.attachments[0]).not.toHaveProperty("botInputId")
  })

  it.each(["denied", "missing receipt"])("keeps the managed composer on a retained-input failure (%s)", async reason => {
    const readWorkspaceFile = vi.fn()
    const readWorkspaceAttachment = vi.fn(async () => {
      if (reason === "denied") throw new Error("source changed")
      return { filename: "notes.md", filePath: "/workspace/notes.md", content: "preview", size: 7,
        mimeType: "text/plain", truncated: false }
    })
    await expect(resolveAtFileAttachments({
      rawMessage: "Use @notes.md", attachments: [], mentionedFiles: [], workspacePath: "/workspace",
      workspaceFiles: [{ path: "notes.md", is_dir: false }], maxAttachments: 3, maxTotalChars: 24000,
      readWorkspaceFile, readWorkspaceAttachment
    })).rejects.toThrow()
    expect(readWorkspaceFile).not.toHaveBeenCalled()
  })

  it("reserves a receipt for each selected Bot file when the first excerpt is large", async () => {
    const filenames = ["large.txt", "required.csv"]
    const mentionedFiles = filenames.map(filename => toMentionedWorkspaceFile({
      id: `/${filename}`, displayPath: filename, workspaceFilePath: `/${filename}`, filename
    }, "/workspace"))
    const ids = ["input-00000000-0000-0000-0000-000000000001", "input-00000000-0000-0000-0000-000000000002"]
    const readWorkspaceAttachment = vi.fn(async (path: string, maxChars: number) => {
      const filename = path.slice(1)
      const large = filename === "large.txt"
      return {
        filename, filePath: `/retained/${filename}`, content: large ? "a".repeat(maxChars) : "amount\n10",
        size: large ? 32_000 : 9, mimeType: "text/plain", truncated: large,
        botInputId: ids[large ? 0 : 1]
      }
    })
    const input = {
      rawMessage: "Review both files", attachments: [], mentionedFiles,
      workspacePath: "/workspace", workspaceFiles: [], maxAttachments: 3, maxTotalChars: 24_000,
      readWorkspaceFile: vi.fn(), readWorkspaceAttachment
    }
    const result = await resolveAtFileAttachments(input)
    expect(readWorkspaceAttachment.mock.calls).toEqual([["/large.txt", 12_000], ["/required.csv", 12_000]])
    expect(result.mentionAttachmentLimitHit).toBe(false)
    const { attachmentModelBlocks } = buildAttachmentMessageParts(result.attachments)
    expect(attachmentModelBlocks).toContain(`filename="large.txt" input_id="${ids[0]}"`)
    expect(attachmentModelBlocks).toContain(`filename="required.csv" input_id="${ids[1]}"`)
    expect(attachmentModelBlocks).toContain("amount\n10")

    readWorkspaceAttachment.mockClear()
    await expect(resolveAtFileAttachments({ ...input, maxTotalChars: 1 })).rejects.toThrow("附件内容已达上限")
    await expect(resolveAtFileAttachments({ ...input, maxAttachments: 1 })).rejects.toThrow("最多只能发送 1 个附件")
    expect(readWorkspaceAttachment).not.toHaveBeenCalled()
  })

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
