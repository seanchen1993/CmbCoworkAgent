import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture(group = false) {
  const store = new BotStore(":memory:")
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "A" })
  const b = store.createBot({ nonce: "b", name: "B" })
  const conversationId = group
    ? store.createGroup({ nonce: "group", name: "团队", members: [a.bot.id, b.bot.id] }).id
    : a.conversationId
  const first = store.send({ nonce: "root", conversationId, text: "分支之前的背景" })
  store.cancel(first.runIds[0])
  return { store, a, b, conversationId, rootId: first.messageId }
}

it("separates branches, preserves the fork-point context and routes final and question messages to their scope", () => {
  const { store, conversationId, rootId } = fixture()
  const later = store.send({
    nonce: "later-main",
    conversationId,
    text: "起点之后的主线，不带入分支"
  })
  store.cancel(later.runIds[0])
  const input = { nonce: "branch", conversationId, threadRootId: rootId, text: "分支工作" }
  const sent = store.send(input)
  expect(store.send(input)).toEqual(sent)
  expect(() => store.send({ ...input, threadRootId: later.messageId })).toThrow()
  const claim = store.claim("host")!
  expect(claim.run.threadRootId).toBe(rootId)
  expect(store.messagesForRun(claim.run.id).map((message) => message.text)).toEqual([
    "分支之前的背景",
    "分支工作"
  ])
  const question = store.requestInteraction(claim.lease, { kind: "question", prompt: "补充内容" })
  store.answerInteraction({ id: question.id, revision: 1, answer: "分支答案" })
  store.finish(claim.lease, "succeeded", "分支结果")
  expect(store.messages(conversationId).map((message) => message.text)).toEqual([
    "分支之前的背景",
    "起点之后的主线，不带入分支"
  ])
  const branch = store.messages(conversationId, undefined, 100, undefined, rootId)
  expect(branch.map((message) => message.text)).toEqual([
    "分支工作",
    "补充内容\n\n分支答案",
    "分支结果"
  ])
  expect(branch.every((message) => message.threadRootId === rootId)).toBe(true)
  expect(store.message({ conversationId, id: sent.messageId })).toEqual(branch[0])
  const thread = store.threads.get({ conversationId, rootId })
  expect(thread.count).toBe(3)
  expect(thread.root.id).toBe(rootId)
  expect(thread.readState.unreadCount).toBe(1)
  expect(store.messages(conversationId)[0].threadSummary?.count).toBe(3)
  const mainNext = store.send({ nonce: "main-next", conversationId, text: "主线继续" })
  expect(store.messagesForRun(mainNext.runIds[0]).map((message) => message.text)).not.toContain(
    "分支结果"
  )
  store.cancel(mainNext.runIds[0])
  const sibling = store.send({
    nonce: "sibling",
    conversationId,
    threadRootId: later.messageId,
    text: "另一个分支"
  })
  expect(store.messagesForRun(sibling.runIds[0]).map((message) => message.text)).not.toContain(
    "分支结果"
  )
})

it("fences branch roots and quotes before any message, queue or receipt is committed", () => {
  const { store, b, conversationId, rootId } = fixture()
  const input = {
    nonce: "scope",
    conversationId: b.conversationId,
    threadRootId: rootId,
    text: "invalid"
  }
  expect(() => store.send(input)).toThrow("分支起点")
  expect(store.messages(b.conversationId)).toEqual([])
  const branch = store.send({ ...input, conversationId })
  expect(() =>
    store.send({ nonce: "nested", conversationId, threadRootId: branch.messageId, text: "invalid" })
  ).toThrow("分支起点")
  expect(() =>
    store.send({ nonce: "cross-quote", conversationId, replyTo: branch.messageId, text: "invalid" })
  ).toThrow("对应分支")
  expect(store.threads.summaries({ conversationId: b.conversationId, rootIds: [rootId] })).toEqual(
    []
  )
  const reply = store.send({
    nonce: "root-quote",
    conversationId,
    threadRootId: rootId,
    replyTo: rootId,
    text: "说明起点"
  })
  expect(store.message({ conversationId, id: reply.messageId }).replyPreview?.id).toBe(rootId)
})

it("marks visible branch messages read independently from the main transcript", () => {
  const { store, conversationId, rootId } = fixture()
  store.send({ nonce: "branch", conversationId, threadRootId: rootId, text: "任务" })
  const claim = store.claim("host")!
  store.finish(claim.lease, "succeeded", "分支结果")
  const branch = store.threads.get({ conversationId, rootId }),
    main = store.getConversation(conversationId).readState!
  expect(store.getConversation(conversationId).threadUnreadCount).toBe(1)
  expect(store.getConversation(conversationId).threadUnreadRootId).toBe(rootId)
  store.setReadState({
    conversationId,
    revision: main.revision,
    throughSequence: main.latestSequence,
    unread: false
  })
  expect(store.threads.get({ conversationId, rootId }).readState.unreadCount).toBe(1)
  expect(() =>
    store.setReadState({
      conversationId,
      threadRootId: rootId,
      revision: 0,
      throughSequence: main.latestSequence,
      unread: false
    })
  ).toThrow("当前对话")
  store.setReadState({
    conversationId,
    threadRootId: rootId,
    revision: 0,
    throughSequence: branch.readState.latestSequence,
    unread: false
  })
  expect(store.getConversation(conversationId).threadUnreadCount).toBe(0)
  expect(store.getConversation(conversationId).threadUnreadRootId).toBeUndefined()
  expect(() =>
    store.setReadState({
      conversationId,
      threadRootId: rootId,
      revision: 0,
      throughSequence: branch.readState.latestSequence,
      unread: true
    })
  ).toThrow("读取位置已变化")
})

it("keeps group rounds and stop requests independent across main and branch discussions", () => {
  const { store, a, b, conversationId, rootId } = fixture(true)
  const branch = store.send({
    nonce: "branch",
    conversationId,
    threadRootId: rootId,
    recipients: [a.bot.id],
    text: "BRANCH_ONLY"
  })
  const main = store.send({
    nonce: "main",
    conversationId,
    recipients: [b.bot.id],
    text: "MAIN_LATER_ONLY"
  })
  expect(store.getRun(branch.runIds[0]).status).toBe("queued")
  const claim = store.claim("host")!
  expect(claim.run.id).toBe(branch.runIds[0])
  expect(store.groups.scope(claim.run.id)?.prompt).toContain("BRANCH_ONLY")
  expect(store.groups.scope(claim.run.id)?.prompt).not.toContain("MAIN_LATER_ONLY")
  const published = store.toolOnce(claim.lease, "post", {}, () =>
    store.groups.post(claim.lease, "分支公开结果")
  )
  expect(store.message({ conversationId, id: published.messageId! }).threadRootId).toBe(rootId)
  store.cancel(main.runIds[0])
  expect(store.getRun(branch.runIds[0]).status).toBe("running")
  expect(store.groups.isCurrent(claim.run.id)).toBe(true)
  store.finish(claim.lease, "succeeded", "private")
  store.advanceGroups()
  const next = store.claim("host")!
  expect(next.run.threadRootId).toBe(rootId)
  expect(store.groups.scope(next.run.id)?.prompt).not.toContain("MAIN_LATER_ONLY")
})
