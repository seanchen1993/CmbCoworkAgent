import { afterEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "A" })
  const address = { botId: bot.id, conversationId, runId: null, threadRootId: null }
  const pending = () =>
    Number(store.db.exec("SELECT COUNT(*) FROM bot_browser_downloads")[0].values[0][0])
  return { store, address, pending, guid: randomUUID() }
}

it("retains the original branch, drains interrupted downloads once and never wakes a Bot", () => {
  const { store, address, pending, guid } = fixture()
  const root = store.send({ nonce: "root", conversationId: address.conversationId, text: "Root" })
  store.cancel(root.runIds[0])
  const branch = { ...address, threadRootId: root.messageId }
  store.browserDownloads.started(guid, branch)
  store.browserDownloads.started(guid, branch)
  expect(pending()).toBe(1)
  expect(() => store.browserDownloads.started(guid, address)).toThrow("其他对话或任务")
  expect(() => store.browserDownloads.settled(guid, address, "失败")).toThrow("其他对话或任务")
  expect(store.browserDownloads.recoverAtStartup()).toBe(1)
  expect(store.browserDownloads.recoverAtStartup()).toBe(0)
  const messages = store.messages(address.conversationId, undefined, 100, undefined, root.messageId)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    sender: "system",
    threadRootId: root.messageId,
    text: "下载未完成：后台重启，下载已中断，请重新下载",
    attachments: []
  })
  expect(store.messages(address.conversationId)).toHaveLength(1)
  expect(store.snapshot().runs).toEqual([])
  expect(pending()).toBe(0)
})

it("rolls back the interruption notice together with cleanup and retries exactly once", () => {
  const { store, address, pending, guid } = fixture()
  store.browserDownloads.started(guid, address)
  const run = store.db.run.bind(store.db)
  const fail = vi.spyOn(store.db, "run").mockImplementation((sql, args) => {
    if (sql.startsWith("DELETE FROM bot_browser_downloads")) throw new Error("disk unavailable")
    return run(sql, args)
  })
  expect(() => store.browserDownloads.recoverAtStartup()).toThrow("disk unavailable")
  expect(pending()).toBe(1)
  expect(store.messages(address.conversationId)).toEqual([])
  fail.mockRestore()
  expect(store.browserDownloads.recoverAtStartup()).toBe(1)
  store.browserDownloads.settled(guid, address, "迟到的失败")
  expect(store.messages(address.conversationId)).toHaveLength(1)
  expect(pending()).toBe(0)
})

it("does not publish a failure into a former group or a deleted Bot's conversation", () => {
  const { store, address, pending, guid } = fixture()
  const b = store.createBot({ nonce: "b", name: "B" })
  const c = store.createBot({ nonce: "c", name: "C" })
  const group = store.createGroup({
    nonce: "group",
    name: "Group",
    members: [address.botId, b.bot.id]
  })
  store.browserDownloads.started(guid, { ...address, conversationId: group.id })
  store.updateGroup({
    id: group.id,
    revision: group.revision,
    name: group.name,
    description: "",
    members: [b.bot.id, c.bot.id]
  })
  store.browserDownloads.started(randomUUID(), address)
  store.deleteBot(address.botId, store.getBot(address.botId).revision)
  expect(store.browserDownloads.recoverAtStartup()).toBe(2)
  expect(pending()).toBe(0)
  expect(store.messages(group.id)).toEqual([])
  expect(store.db.exec("SELECT COUNT(*) FROM bot_messages")[0].values[0][0]).toBe(0)
})

it("rejects completion before publication and rejects a foreign task or branch", () => {
  const { store, address, pending, guid } = fixture()
  store.browserDownloads.started(guid, address)
  expect(() => store.browserDownloads.settled(guid, address)).toThrow("尚未保存")
  const b = store.createBot({ nonce: "b", name: "B" })
  const task = store.send({ nonce: "task", conversationId: b.conversationId, text: "Work" })
  expect(() =>
    store.browserDownloads.started(randomUUID(), { ...address, runId: task.runIds[0] })
  ).toThrow("其他对话或任务")
  expect(() =>
    store.browserDownloads.started(randomUUID(), { ...address, threadRootId: task.messageId })
  ).toThrow("分支起点")
  expect(pending()).toBe(1)
})
