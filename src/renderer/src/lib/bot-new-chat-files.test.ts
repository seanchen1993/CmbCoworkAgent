import { describe, expect, it, vi } from "vitest"
import type { BotClient } from "../../../shared/bots/contracts"
import type { FileAttachment } from "../../../shared/file-attachment"
import { BotDraftFileTransfer, validateNewChatFiles } from "./bot-new-chat-files"

const retained = (name: string): FileAttachment => ({
  filename: name,
  filePath: `shared/id/${name}`,
  content: "42",
  size: 2,
  mimeType: "text/plain",
  truncated: false
})

describe("new Bot chat attachment handoff", () => {
  it("retries only failed imports, then reimports for a different recipient", async () => {
    const a = new File(["42"], "a.txt"),
      b = new File(["43"], "b.txt")
    const attachFileBytes = vi
      .fn()
      .mockResolvedValueOnce([retained("a.txt")])
      .mockRejectedValueOnce(new Error("parser unavailable"))
      .mockResolvedValueOnce([retained("b.txt")])
      .mockResolvedValueOnce([retained("a.txt")])
      .mockResolvedValueOnce([retained("b.txt")])
    const client = { hostId: "local", attachFileBytes } as unknown as BotClient
    const transfer = new BotDraftFileTransfer()
    await expect(transfer.retain(client, "a", undefined, [a, b], [], () => true)).rejects.toThrow(
      "parser unavailable"
    )
    const result = await transfer.retain(client, "a", undefined, [a, b], [], () => true)
    expect(result.map((file) => file.filename)).toEqual(["a.txt", "b.txt"])
    expect(attachFileBytes).toHaveBeenCalledTimes(3)
    expect(attachFileBytes.mock.calls[2][2]).toBe(23_998)
    await transfer.retain(client, "b", "group", [a, b], [], () => true)
    expect(attachFileBytes).toHaveBeenCalledTimes(5)
    expect(attachFileBytes.mock.calls[3][0]).toBe("b")
    expect(attachFileBytes.mock.calls[3][3]).toBe("group")
  })

  it("rejects oversized and too many attachments before reading bytes or invoking IPC", async () => {
    const file = new File(["42"], "a.txt")
    const large = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large")
    expect(() => validateNewChatFiles([large])).toThrow("5 MiB")
    const attachFileBytes = vi.fn()
    const client = { hostId: "local", attachFileBytes } as unknown as BotClient
    await expect(
      new BotDraftFileTransfer().retain(
        client,
        "a",
        undefined,
        [file, file],
        [retained("b"), retained("c")],
        () => true
      )
    ).rejects.toThrow("3")
    expect(attachFileBytes).not.toHaveBeenCalled()
  })

  it("does not give a late upload to a different conversation", async () => {
    let current = true
    const file = new File(["42"], "a.txt")
    const attachFileBytes = vi.fn(async () => {
      current = false
      return [retained("a.txt")]
    })
    const client = { hostId: "local", attachFileBytes } as unknown as BotClient
    await expect(
      new BotDraftFileTransfer().retain(client, "a", undefined, [file], [], () => current)
    ).rejects.toThrow("收件人已切换")
  })

  it("shares retained files only within the same group and respects existing draft text budgets", async () => {
    const file = new File(["42"], "a.txt")
    const attachFileBytes = vi.fn().mockResolvedValue([retained("a.txt")])
    const client = { hostId: "local", attachFileBytes } as unknown as BotClient
    const transfer = new BotDraftFileTransfer()
    await transfer.retain(client, "a", "group", [file], [], () => true)
    await transfer.retain(client, "b", "group", [file], [], () => true)
    expect(attachFileBytes).toHaveBeenCalledTimes(1)
    await expect(
      transfer.retain(
        client,
        "b",
        "group",
        [file],
        [{ ...retained("existing"), content: "x".repeat(23_999) }],
        () => true
      )
    ).rejects.toThrow("24,000")
    transfer.keep([])
    await transfer.retain(client, "b", "group", [file], [], () => true)
    expect(attachFileBytes).toHaveBeenCalledTimes(2)
  })
})
