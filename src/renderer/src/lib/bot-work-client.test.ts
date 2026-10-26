import { describe, expect, it, vi } from "vitest"
import type { BotChangeEvent, BotClient, BotTask } from "../../../shared/bots/contracts"
import { BotClientRegistry } from "../../../shared/bots/client-registry"
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
    "messageReactions",
    "setMessageReaction",
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
    "navigateBrowser",
    "operateBrowser"
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
  it("preserves the complete frozen local client through the registry facade", async () => {
    const base = fixture().client
    let receive: ((event: BotChangeEvent) => void) | undefined
    const unsubscribe = vi.fn(() => {
      receive = undefined
    })
    const client = Object.freeze({
      ...base,
      hostId: "local",
      filePreview: Object.freeze({}),
      cancel: vi.fn(async () => undefined),
      subscribe: vi.fn((listener: (event: BotChangeEvent) => void) => {
        receive = listener
        return unsubscribe
      })
    }) as unknown as BotClient
    const registry = new BotClientRegistry()
    registry.register(client)
    const registered = registry.get("local")
    expect(Object.keys(registered)).toEqual([])
    const scoped = botWorkClient(registered, work)
    expect(scoped.hostId).toBe("local")
    expect(scoped.filePreview).toBe(client.filePreview)
    expect(scoped.subscribe).toBe(scoped.subscribe)
    expect(scoped.cancel).toBe(scoped.cancel)
    const listener = vi.fn()
    const stop = scoped.subscribe(listener)
    receive!({ hostId: "other", revision: 1 })
    receive!({ hostId: "local", revision: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(receive).toBeUndefined()
    await scoped.cancel("queued-task")
    expect(client.cancel).toHaveBeenCalledWith("queued-task")
    await scoped.open(work.botId)
    expect(client.open).toHaveBeenCalledWith(work.botId, work.id)
    await scoped.setMessageReaction({ kind: "bot", botId: work.botId }, "m", "👍", false)
    expect(client.setMessageReaction).toHaveBeenCalledWith(
      { kind: "bot", botId: work.botId, workId: work.id },
      "m",
      "👍",
      false
    )
  })
  it("keeps private-field receivers for direct and registered class clients", async () => {
    class Client {
      #hostId = "class-host"
      #preview = Object.freeze({})
      #listeners = new Set<(event: BotChangeEvent) => void>()
      #calls: unknown[][] = []
      get hostId() {
        return this.#hostId
      }
      get filePreview() {
        return this.#preview
      }
      get calls() {
        return this.#calls
      }
      get listenerCount() {
        return this.#listeners.size
      }
      subscribe(listener: (event: BotChangeEvent) => void) {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
      }
      async cancel(id: string) {
        this.#calls.push(["cancel", id])
      }
      async open(id: string, workId?: string) {
        this.#calls.push(["open", id, workId])
        return { threadId: work.threadId }
      }
      async send(input: Parameters<BotClient["send"]>[0]) {
        this.#calls.push(["send", input])
        return { ...input, threadId: work.threadId } as BotTask
      }
    }
    for (const registered of [false, true]) {
      const raw = Object.freeze(new Client())
      const registry = new BotClientRegistry()
      registry.register(raw as unknown as BotClient)
      const scoped = botWorkClient(
        registered ? registry.get(raw.hostId) : (raw as unknown as BotClient),
        work
      )
      expect(scoped.hostId).toBe(raw.hostId)
      expect(scoped.filePreview).toBe(raw.filePreview)
      const stop = scoped.subscribe(vi.fn())
      expect(raw.listenerCount).toBe(1)
      stop()
      expect(raw.listenerCount).toBe(0)
      const cancel = scoped.cancel
      await cancel("queued-task")
      await scoped.open(work.botId)
      await scoped.send({ botId: work.botId, requestId: "r", message: "Edit" })
      expect(raw.calls).toEqual([
        ["cancel", "queued-task"],
        ["open", work.botId, work.id],
        ["send", { botId: work.botId, requestId: "r", message: "Edit", workId: work.id }]
      ])
    }
  })
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
    await scoped.messageReactions({ kind: "bot", botId: work.botId }, ["message"])
    expect(client.messageReactions).toHaveBeenCalledWith(
      { kind: "bot", botId: work.botId, workId: work.id }, ["message"]
    )
    await scoped.setMessageReaction({ kind: "bot", botId: work.botId }, "message", "👍", true)
    expect(client.setMessageReaction).toHaveBeenCalledWith(
      { kind: "bot", botId: work.botId, workId: work.id }, "message", "👍", true
    )
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
    await scoped.giveBackBrowser(work.botId, 7, "skipped")
    expect(client.giveBackBrowser).toHaveBeenCalledWith("work-work-a--bot-a", 7, "skipped")
    const action = { action: "reload" as const, pageId: "page-a" }
    await scoped.operateBrowser(work.botId, action, 7)
    expect(client.operateBrowser).toHaveBeenCalledWith("work-work-a--bot-a", action, 7)
  })
  it("refuses crossed identities and mismatched replies before consuming a draft", async () => {
    const { client, scoped } = fixture()
    await expect(scoped.send({ botId: "other", requestId: "r", message: "Edit" })).rejects.toThrow(
      "目标"
    )
    expect(() => scoped.listFiles(work.botId, undefined, "group")).toThrow("目标")
    expect(() => scoped.takeOverBrowser("other")).toThrow("目标")
    expect(() => scoped.operateBrowser("other", { action: "new" }, 7)).toThrow("目标")
    expect(client.operateBrowser).not.toHaveBeenCalled()
    expect(() => scoped.messageReactions({ kind: "group", groupId: "g" }, ["m"])).toThrow("目标")
    expect(() => scoped.setMessageReaction({ kind: "bot", botId: work.botId, workId: "other" }, "m", "👍", true)).toThrow("目标")
    expect(() => scoped.messageReactions({ kind: "bot", botId: "other" }, ["m"])).toThrow("目标")
    expect(client.setMessageReaction).not.toHaveBeenCalled()
    vi.mocked(client.send).mockResolvedValue({ threadId: "main-a", workId: work.id } as BotTask)
    await expect(
      scoped.send({ botId: work.botId, requestId: "r", message: "Edit" })
    ).rejects.toThrow("回执")
    vi.mocked(client.open).mockResolvedValue({ threadId: "main-a" })
    await expect(scoped.open(work.botId)).rejects.toThrow("回执")
  })
})
