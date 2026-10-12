import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botReplyContext } from "./context"

const stores: BotStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.forEach((store) => store.close())
  stores.length = 0
  directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  directories.length = 0
})
function open(path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  return store
}

it("resolves quotes outside a loaded page and preserves target identity through retries and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-replies-"))
  directories.push(directory)
  const path = join(directory, "bots.sqlite"),
    store = open(path)
  const { conversationId } = store.createBot({ nonce: "bot", name: "A" })
  const referenced = store.createBot({ nonce: "referenced", name: "质量检查" })
  const target = store.send({
    nonce: "original",
    conversationId,
    text: "需求原文",
    references: [{ kind: "bot", id: referenced.bot.id }]
  })
  store.updateBot({ id: referenced.bot.id, revision: referenced.bot.revision, name: "已改名" })
  // Fill history without starting model work.
  for (let i = 0; i < 220; i++)
    store.send({ nonce: `later-${i}`, conversationId, text: `后续 ${i}` })
  expect(store.messages(conversationId).some((message) => message.id === target.messageId)).toBe(
    false
  )
  const input = {
    nonce: "reply",
    conversationId,
    text: "只修改这条的第二项",
    replyTo: target.messageId
  }
  const receipt = store.send(input)
  expect(store.send(input)).toEqual(receipt)
  expect(() => store.send({ ...input, replyTo: undefined })).toThrow("不同")
  const message = store.message({ conversationId, id: receipt.messageId })
  expect(message.replyPreview).toMatchObject({
    id: target.messageId,
    sender: "user",
    text: "需求原文",
    truncated: false
  })
  expect(botReplyContext(message)).toContain("需求原文")
  expect(message.replyPreview?.entityReferences).toMatchObject([
    { kind: "bot", id: referenced.bot.id, name: "质量检查" }
  ])
  expect(botReplyContext(message)).toContain(referenced.bot.id)
  expect(botReplyContext(message)).toContain("not a new request")
  expect(store.messagesForRun(receipt.runIds[0]).at(-1)?.replyPreview?.id).toBe(target.messageId)
  store.close()
  stores.splice(stores.indexOf(store), 1)
  const reopened = open(path)
  expect(reopened.send(input)).toEqual(receipt)
  expect(reopened.message({ conversationId, id: receipt.messageId })).toEqual(message)
})

it("rejects foreign or missing targets atomically and keeps internal correlation out of explicit quotes", () => {
  const store = open()
  const a = store.createBot({ nonce: "a", name: "A" }),
    b = store.createBot({ nonce: "b", name: "B" })
  const privateMessage = store.send({
    nonce: "private",
    conversationId: a.conversationId,
    text: "PRIVATE_CONTENT"
  })
  const input = {
    nonce: "reply",
    conversationId: b.conversationId,
    text: "引用",
    replyTo: privateMessage.messageId
  }
  expect(() => store.send(input)).toThrow("不属于当前对话")
  expect(() =>
    store.message({ conversationId: b.conversationId, id: privateMessage.messageId })
  ).toThrow("不属于当前对话")
  expect(() => store.send({ ...input, replyTo: "missing" })).toThrow("不存在")
  expect(() => store.message({ conversationId: b.conversationId, id: "' OR 1=1" })).toThrow("格式")
  expect(store.messages(b.conversationId)).toEqual([])
  expect(store.snapshot().runs).toHaveLength(1)
  const claimed = store.claim("host")!
  store.finish(claimed.lease, "succeeded", "完成")
  const output = store.messages(a.conversationId).at(-1)!
  expect(output.replyTo).toBe(privateMessage.messageId)
  expect(output.replyPreview).toBeUndefined()
  expect(botReplyContext(output)).toBe("")
  const accepted = store.send({ ...input, conversationId: a.conversationId, replyTo: output.id })
  expect(
    store.message({ conversationId: a.conversationId, id: accepted.messageId }).replyPreview?.text
  ).toBe("完成")
})

it("bounds quote size while making the complete target readable and includes quotes in group context", () => {
  const store = open()
  const a = store.createBot({ nonce: "a", name: "A" }),
    b = store.createBot({ nonce: "b", name: "B" })
  const group = store.createGroup({ nonce: "g", name: "team", members: [a.bot.id, b.bot.id] })
  const text = "旧需求 ".repeat(2_000) + "END_OF_QUOTE"
  const original = store.send({ nonce: "original", conversationId: group.id, text })
  const sent = store.send({
    nonce: "reply",
    conversationId: group.id,
    text: "继续这个",
    replyTo: original.messageId
  })
  const message = store.message({ conversationId: group.id, id: sent.messageId })
  expect(message.replyPreview?.text).toHaveLength(8_000)
  expect(message.replyPreview?.truncated).toBe(true)
  expect(botReplyContext(message)).toContain("read_message")
  expect(store.message({ conversationId: group.id, id: original.messageId }).text).toBe(text)
  const claim = store.claim("host")!
  const context = store.groups.scope(claim.run.id)
  expect(context?.prompt).toContain(`In reply to ${original.messageId}`)
})
