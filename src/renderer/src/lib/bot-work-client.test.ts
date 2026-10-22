import { describe, expect, it, vi } from "vitest"
import type { BotClient, BotTask } from "../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../shared/bots/work"
import { botWorkClient } from "./bot-work-client"

const work: BotWorkItem = {
  id: "work-a",
  botId: "bot-a",
  threadId: "thread-a",
  parentThreadId: "main-a",
  title: "Draft",
  goal: "Draft",
  audienceKey: "desktop",
  threadInitialized: true,
  state: "active",
  version: 2,
  createdAt: 1,
  updatedAt: 1,
  executionState: null,
  pendingPeers: 0,
  backgroundBusy: false
}
function fixture() {
  const methods = [
    "send",
    "open",
    "requestReceipts",
    "messageReply",
    "stopConversation",
    "messageOrigins",
    "exchange",
    "exchangeHistory",
    "listFiles",
    "importFiles",
    "attachFiles",
    "attachFileBytes",
    "exportFile",
    "shareFile",
    "browserPreview",
    "takeOverBrowser",
    "giveBackBrowser",
    "navigateBrowser"
  ]
  const client = Object.fromEntries(
    methods.map((name) => [name, vi.fn(async () => undefined)])
  ) as unknown as BotClient
  vi.mocked(client.open).mockResolvedValue({ threadId: work.threadId })
  vi.mocked(client.send).mockImplementation(
    async (input) => ({ ...input, threadId: work.threadId, workId: work.id }) as BotTask
  )
  return { client, scoped: botWorkClient(client, work) }
}
describe("original beta client bound to a work", () => {
  it("keeps send, receipts, references, file operations and browser on one actual target", async () => {
    const { client, scoped } = fixture()
    await scoped.open(work.botId)
    await scoped.send({ botId: work.botId, requestId: "r", message: "Edit" })
    expect(client.send).toHaveBeenCalledWith({
      botId: work.botId,
      workId: work.id,
      requestId: "r",
      message: "Edit"
    })
    await scoped.requestReceipts(work.botId, [])
    expect(client.requestReceipts).toHaveBeenCalledWith(work.botId, [], work.id)
    await scoped.messageReply(work.botId, "message")
    expect(client.messageReply).toHaveBeenCalledWith(work.botId, "message", work.id)
    await scoped.stopConversation(work.botId)
    expect(client.stopConversation).toHaveBeenCalledWith(work.botId, undefined, work.id)
    await scoped.messageOrigins(work.botId, ["m"])
    expect(client.messageOrigins).toHaveBeenCalledWith(work.botId, ["m"], undefined, work.id)
    await scoped.exchangeHistory(work.botId, "task", undefined, "older")
    expect(client.exchangeHistory).toHaveBeenCalledWith(
      work.botId,
      "task",
      undefined,
      "older",
      work.id
    )
    await scoped.listFiles(work.botId, "cursor")
    expect(client.listFiles).toHaveBeenCalledWith(work.botId, "cursor", undefined, work.id)
    await scoped.attachFiles(work.botId, 2, 24000)
    expect(client.attachFiles).toHaveBeenCalledWith(work.botId, 2, 24000, undefined, work.id)
    await scoped.exportFile(work.botId, "report.md")
    expect(client.exportFile).toHaveBeenCalledWith(work.botId, "report.md", undefined, work.id)
    await scoped.browserPreview(work.botId)
    expect(client.browserPreview).toHaveBeenCalledWith("work-work-a--bot-a", undefined)
  })
  it("refuses crossed identities and mismatched replies before consuming a draft", async () => {
    const { client, scoped } = fixture()
    await expect(scoped.send({ botId: "other", requestId: "r", message: "Edit" })).rejects.toThrow(
      "目标"
    )
    expect(() => scoped.listFiles(work.botId, undefined, "group")).toThrow("目标")
    expect(() => scoped.takeOverBrowser("other")).toThrow("目标")
    vi.mocked(client.send).mockResolvedValue({ threadId: "main-a", workId: work.id } as BotTask)
    await expect(
      scoped.send({ botId: work.botId, requestId: "r", message: "Edit" })
    ).rejects.toThrow("回执")
    vi.mocked(client.open).mockResolvedValue({ threadId: "main-a" })
    await expect(scoped.open(work.botId)).rejects.toThrow("回执")
  })
})
