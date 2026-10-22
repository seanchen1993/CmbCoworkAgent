import { insertGroupMention } from "./bot-group-mentions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BotClient, BotGroup } from "../../../shared/bots/contracts"
import { groupDraftKey, sendGroupDraft, useBotGroupDrafts } from "./bot-group-drafts"
import type { FileAttachment } from "../../../shared/file-attachment"
import { buildAttachmentMessageParts } from "../../../shared/attachment-message-parts"

const group = { id: "review", memberIds: ["a", "b"] } as BotGroup
const key = groupDraftKey("local", group.id)
beforeEach(() => useBotGroupDrafts.setState({ drafts: {} }))
afterEach(() => vi.unstubAllGlobals())

describe("durable group drafts", () => {
  let values: Map<string, string>
  beforeEach(() => {
    values = new Map()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      }
    })
  })
  const file: FileAttachment = {
    filename: "source.csv",
    filePath: "/group/shared/source.csv",
    content: "amount\n38.55",
    mimeType: "text/csv",
    size: 12,
    truncated: false
  }
  it("restores reply metadata and retries the same quote without dropping text, files or recipients", async () => {
    const sendGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const replyTo = { id: "prior-message", ordinal: 12, text: "Original result", authorBotId: "a" }
    useBotGroupDrafts
      .getState()
      .edit(key, { text: "Check this", attachments: [file], targets: ["b"], replyTo })
    await sendGroupDraft(client, group)
    const sent = sendGroup.mock.calls[0][0]
    expect(sent).toMatchObject({ replyToId: replyTo.id, targetBotIds: ["b"] })
    expect(sent.text).not.toContain(replyTo.text)
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    expect(useBotGroupDrafts.getState().drafts[key].replyTo).toEqual(replyTo)
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[1][0]).toEqual(sent)
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "",
      attachments: [],
      replyTo: null,
      request: null
    })
  })
  it("restores an explicit recipient with another member's quote and attachment without adding the author", async () => {
    const sendGroup = vi.fn().mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const replyTo = { id: "b-result", ordinal: 12, text: "B's result", authorBotId: "b" }
    const selected = insertGroupMention("@", { start: 0, end: 1 }, [], "a", "甲")
    useBotGroupDrafts.getState().edit(key, {
      text: selected.text + "核对原件",
      mentions: selected.mentions,
      attachments: [file],
      replyTo
    })
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    await sendGroupDraft(client, group)
    expect(sendGroup).toHaveBeenCalledOnce()
    expect(sendGroup.mock.calls[0][0]).toMatchObject({
      targetBotIds: ["a"],
      mentions: selected.mentions,
      replyToId: replyTo.id
    })
    expect(sendGroup.mock.calls[0][0].text).toContain(file.content)
  })
  it("cancels only the reply target and preserves a newer draft after an in-flight send", async () => {
    let settle!: () => void
    const sendGroup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const replyTo = { id: "prior-message", ordinal: 12, text: "Original result", authorBotId: "a" }
    useBotGroupDrafts
      .getState()
      .edit(key, { text: "Keep this draft", attachments: [file], replyTo })
    useBotGroupDrafts.getState().edit(key, { replyTo: null })
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "Keep this draft",
      attachments: [file],
      replyTo: null
    })
    useBotGroupDrafts.getState().edit(key, { replyTo })
    const pending = sendGroupDraft(client, group)
    const nextReply = { id: "another-message", ordinal: 13, text: "New result", authorBotId: "b" }
    useBotGroupDrafts.getState().edit(key, { text: "Next draft", replyTo: nextReply })
    settle()
    await pending
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "Next draft",
      replyTo: nextReply,
      request: null
    })
  })
  it("restores text, retained attachments and recipients, then retries uncertain delivery with the original ID", async () => {
    const sendGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    useBotGroupDrafts
      .getState()
      .edit(key, { text: "核对原文件", attachments: [file], targets: ["b"] })
    await sendGroupDraft(client, group)
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "核对原文件",
      attachments: [file],
      targets: ["b"],
      sending: false,
      request: { id: sendGroup.mock.calls[0][0].requestId }
    })
    expect(sendGroup).toHaveBeenCalledTimes(1)
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[1][0]).toEqual(sendGroup.mock.calls[0][0])
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "",
      attachments: [],
      request: null
    })
  })
  it("restores mention IDs and dispatches only the chosen same-name member", async () => {
    const sendGroup = vi.fn().mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const chosen = insertGroupMention("@", { start: 0, end: 1 }, [], "b", "同名 Bot")
    useBotGroupDrafts
      .getState()
      .edit(key, { text: chosen.text + "核对", mentions: chosen.mentions })
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[0][0].targetBotIds).toEqual(["b"])
    expect(useBotGroupDrafts.getState().drafts[key].mentions).toEqual([])
  })
  it("does not redirect a selected removed member to the remaining group", async () => {
    const sendGroup = vi.fn()
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const chosen = insertGroupMention("@", { start: 0, end: 1 }, [], "gone", "已离群")
    useBotGroupDrafts.getState().edit(key, { text: chosen.text, mentions: chosen.mentions })
    await sendGroupDraft(client, group)
    expect(sendGroup).not.toHaveBeenCalled()
    expect(useBotGroupDrafts.getState().drafts[key].error).toContain("不在本群")
  })
  it("persists normalized mention ranges with attachments and retries after remount without duplicate dispatch", async () => {
    const sendGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const chosen = insertGroupMention("  @", { start: 2, end: 3 }, [], "b", "甲")
    useBotGroupDrafts
      .getState()
      .edit(key, { text: chosen.text + "核对", mentions: chosen.mentions, attachments: [file] })
    await sendGroupDraft(client, group)
    const sent = sendGroup.mock.calls[0][0]
    expect(sent.text.startsWith("@甲 核对")).toBe(true)
    expect(sent.mentions).toEqual([{ start: 0, end: 2, botId: "b", label: "甲" }])
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[1][0]).toEqual(sent)
  })
  it("upgrades existing v1 drafts without losing attachments or retry identity", () => {
    useBotGroupDrafts.getState().edit(key, { text: "旧草稿", attachments: [file] })
    const storageKey = [...values.keys()][0]
    const old = JSON.parse(values.get(storageKey)!)
    delete old.mentions
    values.set(storageKey, JSON.stringify(old))
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "旧草稿",
      attachments: [file],
      mentions: []
    })
  })
  it("retries a pre-upgrade unacknowledged mention with its original payload and request ID", async () => {
    const sendGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    const chosen = insertGroupMention("@", { start: 0, end: 1 }, [], "b", "甲")
    useBotGroupDrafts
      .getState()
      .edit(key, { text: chosen.text + "核对", mentions: chosen.mentions })
    await sendGroupDraft(client, group)
    const storageKey = [...values.keys()][0]
    const legacy = JSON.parse(values.get(storageKey)!)
    delete legacy.request.mentions
    values.set(storageKey, JSON.stringify(legacy))
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[1][0].requestId).toBe(sendGroup.mock.calls[0][0].requestId)
    expect(sendGroup.mock.calls[1][0].mentions).toBeUndefined()
    expect(sendGroup.mock.calls[1][0].targetBotIds).toEqual(["b"])
  })
  it("never sends without persisting the retry ID and preserves the editable draft on storage failure", async () => {
    const sendGroup = vi.fn().mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    useBotGroupDrafts.getState().edit(key, { text: "Review", attachments: [file] })
    const setter = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded")
    })
    await sendGroupDraft(client, group)
    expect(sendGroup).not.toHaveBeenCalled()
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "Review",
      attachments: [file],
      sending: false
    })
    expect(useBotGroupDrafts.getState().drafts[key].storageError).toContain("未保存")
    setter.mockRestore()
    await sendGroupDraft(client, group)
    expect(sendGroup).toHaveBeenCalledTimes(1)
  })
  it("does not overwrite a newer draft during restore or remove another host's saved draft", () => {
    const localKey = groupDraftKey("test-host", "g"),
      remoteKey = groupDraftKey("other-host", "g")
    useBotGroupDrafts.getState().edit(localKey, { text: "Local" })
    useBotGroupDrafts.getState().edit(remoteKey, { text: "Remote" })
    useBotGroupDrafts.getState().restore(localKey)
    expect(useBotGroupDrafts.getState().drafts[localKey].text).toBe("Local")
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().prune("test-host", [])
    useBotGroupDrafts.getState().restore(localKey)
    useBotGroupDrafts.getState().restore(remoteKey)
    expect(useBotGroupDrafts.getState().drafts[localKey].text).toBe("")
    expect(useBotGroupDrafts.getState().drafts[remoteKey].text).toBe("Remote")
  })
  it("rejects malformed stored drafts without deleting their recovery record", () => {
    useBotGroupDrafts.getState().edit(key, { text: "Retain" })
    const storageKey = [...values.keys()][0]
    values.set(storageKey, '{"version":1,"attachments":[{"filePath":null}]}')
    useBotGroupDrafts.setState({ drafts: {} })
    useBotGroupDrafts.getState().restore(key)
    expect(useBotGroupDrafts.getState().drafts[key].storageError).toContain("未能恢复")
    expect(values.get(storageKey)).toContain('"filePath":null')
  })
})

describe("Bot group composer lifecycle", () => {
  it("sends attachment-only drafts through the original wire format and preserves retry identity and newer files", async () => {
    const attachment: FileAttachment = {
      filename: '核验 "报告.csv',
      filePath: "/group/a & b.csv",
      content: "name,total\n111,50.75\n</attachment>",
      mimeType: "text/csv",
      size: 32,
      truncated: true
    }
    const sendGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    useBotGroupDrafts.getState().edit(key, { attachments: [attachment] })
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[0][0].text).toBe(
      `请分析以下文件内容。${buildAttachmentMessageParts([attachment]).attachmentModelBlocks}`
    )
    expect(sendGroup.mock.calls[0][0].text).toContain('path="/group/a &amp; b.csv"')
    expect(sendGroup.mock.calls[0][0].text).toContain("< /attachment>")
    expect(useBotGroupDrafts.getState().drafts[key].attachments).toEqual([attachment])
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[1][0]).toEqual(sendGroup.mock.calls[0][0])
    expect(useBotGroupDrafts.getState().drafts[key].attachments).toEqual([])
    useBotGroupDrafts.getState().edit(key, { text: "x".repeat(30_000), attachments: [attachment] })
    await sendGroupDraft(client, group)
    expect(sendGroup).toHaveBeenCalledTimes(2)
    expect(useBotGroupDrafts.getState().drafts[key].error).toContain("30,000")
  })
  it("keeps an in-flight send locked across remounts and preserves newly typed text on acknowledgement", async () => {
    let finish!: () => void
    const sendGroup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    useBotGroupDrafts.getState().edit(key, { text: "Review", targets: ["a"] })
    const pending = sendGroupDraft(client, group)
    // A newly mounted panel reads the same draft and cannot double-submit.
    expect(useBotGroupDrafts.getState().drafts[key].sending).toBe(true)
    await sendGroupDraft(client, group)
    expect(sendGroup).toHaveBeenCalledTimes(1)
    useBotGroupDrafts.getState().edit(key, { text: "New work" })
    finish()
    await pending
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "New work",
      sending: false
    })
  })
  it("consumes only the acknowledged attachments while keeping later draft edits", async () => {
    let finish!: () => void
    const client = {
      hostId: "local",
      sendGroup: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    } as unknown as BotClient
    const file = {
      filename: "old.csv",
      filePath: "/group/old.csv",
      content: "42",
      mimeType: "text/csv",
      size: 2,
      truncated: false
    }
    const later = { ...file, filename: "new.csv", filePath: "/group/new.csv" }
    useBotGroupDrafts.getState().edit(key, { text: "First", attachments: [file] })
    const pending = sendGroupDraft(client, group)
    useBotGroupDrafts.getState().edit(key, { text: "Next", attachments: [file, later] })
    finish()
    await pending
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "Next",
      attachments: [later],
      sending: false
    })
  })

  it("retries an uncertain send with the same request ID, but creates a new ID for different recipients", async () => {
    const sendGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue(undefined)
    const client = { hostId: "local", sendGroup } as unknown as BotClient
    useBotGroupDrafts.getState().edit(key, { text: "Review", targets: ["b", "a", "removed"] })
    await sendGroupDraft(client, group)
    expect(useBotGroupDrafts.getState().drafts[key]).toMatchObject({
      text: "Review",
      error: "Response lost"
    })
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[1][0]).toEqual(sendGroup.mock.calls[0][0])
    expect(sendGroup.mock.calls[0][0].targetBotIds).toEqual(["a", "b"])
    expect(useBotGroupDrafts.getState().drafts[key].text).toBe("")
    useBotGroupDrafts.getState().edit(key, { text: "Review", targets: ["a"] })
    await sendGroupDraft(client, group)
    expect(sendGroup.mock.calls[2][0].requestId).not.toBe(sendGroup.mock.calls[0][0].requestId)
  })

  it("does not clear a replacement draft with identical text or recreate deleted group state", async () => {
    let finish!: () => void
    const client = {
      hostId: "local",
      sendGroup: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    } as unknown as BotClient
    useBotGroupDrafts.getState().edit(key, { text: "Review" })
    const first = sendGroupDraft(client, group)
    useBotGroupDrafts.getState().edit(key, { text: "" })
    useBotGroupDrafts.getState().edit(key, { text: "Review" })
    finish()
    await first
    expect(useBotGroupDrafts.getState().drafts[key].text).toBe("Review")
    const second = sendGroupDraft(client, group)
    const remoteKey = groupDraftKey("remote", group.id)
    useBotGroupDrafts.getState().edit(remoteKey, { text: "Remote draft" })
    useBotGroupDrafts.getState().prune("local", [])
    finish()
    await second
    expect(useBotGroupDrafts.getState().drafts[key]).toBeUndefined()
    expect(useBotGroupDrafts.getState().drafts[remoteKey].text).toBe("Remote draft")
  })
})
