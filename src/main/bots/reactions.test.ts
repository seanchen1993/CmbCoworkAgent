import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { isBotReactionEmoji } from "../../shared/bot-reactions"
import { projectReactionCounts } from "../../shared/upstream/grok-reactions"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "react-bot", name: "Bot" })
  const sent = store.send({ nonce: "react-message", conversationId, text: "完成项目" })
  const task = store.claim("react-host")!
  return { store, bot, conversationId, sent, ...task }
}
it("binds persistent reactions to messages without answering approvals, duplicating retries or enqueuing work", () => {
  const f = fixture()
  const interaction = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: "发布",
    action: { publish: true }
  })
  const input = {
    conversationId: f.conversationId,
    messageId: f.sent.messageId,
    emoji: "👍",
    active: true,
    revision: 0
  }
  const state = f.store.reactions.setUser(input)
  expect(f.store.reactions.setUser(input)).toEqual(state)
  expect(state).toEqual({
    messageId: f.sent.messageId,
    revision: 1,
    reactions: [{ emoji: "👍", by: "me" }]
  })
  expect(f.store.getInteraction(interaction.id).status).toBe("pending")
  expect(f.store.getRun(f.run.id).status).toBe("waiting_input")
  expect(f.store.snapshot().runs).toHaveLength(1)
  expect(f.store.messages(f.conversationId)[0].reactionState).toEqual(state)
  const removed = f.store.reactions.setUser({ ...input, revision: 1, active: false })
  expect(removed).toMatchObject({ revision: 2, reactions: [] })
  expect(() => f.store.reactions.setUser(input)).toThrow("已变化")
})

it("keeps Bot and user reactions separate and records model tool replay exactly once", () => {
  const f = fixture(),
    input = { messageId: f.sent.messageId, emoji: "🎉", active: true }
  const botReaction = f.store.reactions.setBot(f.lease, input, "reaction-1")
  const both = f.store.reactions.setUser({
    ...input,
    conversationId: f.conversationId,
    revision: 1
  })
  expect(f.store.reactions.setBot(f.lease, input, "reaction-1")).toEqual(botReaction)
  expect(f.store.reactions.read(input.messageId)).toEqual(both)
  expect(projectReactionCounts(both.reactions)).toMatchObject([
    { emoji: "🎉", count: 2, isMine: true, reactors: [f.bot.id, "me"] }
  ])
  f.store.reactions.setBot(f.lease, { ...input, active: false }, "reaction-2")
  expect(f.store.reactions.read(input.messageId).reactions).toEqual([{ emoji: "🎉", by: "me" }])
  f.store.finish(f.lease, "succeeded", "完成")
  expect(() => f.store.reactions.setBot(f.lease, input, "late")).toThrow()
})

it("rejects cross-conversation reads/writes and Bot reactions to Bot messages", () => {
  const f = fixture(),
    other = f.store.createBot({ nonce: "other", name: "Other" })
  const sent = f.store.send({
    nonce: "other-message",
    conversationId: other.conversationId,
    text: "其他任务"
  })
  expect(() =>
    f.store.reactions.setBot(
      f.lease,
      { messageId: sent.messageId, emoji: "👍", active: true },
      "bad"
    )
  ).toThrow("不属于")
  expect(() =>
    f.store.reactions.readMany({ conversationId: f.conversationId, messageIds: [sent.messageId] })
  ).toThrow("不属于")
  expect(() =>
    f.store.reactions.setUser({
      conversationId: f.conversationId,
      messageId: sent.messageId,
      revision: 0,
      emoji: "👍",
      active: true
    })
  ).toThrow("不属于")
  f.store.finish(f.lease, "succeeded", "结果")
  const answer = f.store.messages(f.conversationId).at(-1)!
  f.store.send({ nonce: "next", conversationId: f.conversationId, text: "继续" })
  let task = f.store.claim("host")!
  if (task.run.botId !== f.bot.id) {
    f.store.finish(task.lease, "succeeded", "done")
    task = f.store.claim("host")!
  }
  expect(() =>
    f.store.reactions.setBot(
      task.lease,
      { messageId: answer.id, emoji: "👍", active: true },
      "self"
    )
  ).toThrow("用户消息")
})

it("bounds reactions and accepts one grapheme including skin tones, flags and keycaps", () => {
  for (const emoji of ["👍", "❤️", "🎉", "👩🏽‍💻", "🇨🇳", "1️⃣"])
    expect(isBotReactionEmoji(emoji)).toBe(true)
  for (const emoji of ["", "批准", "<img>", "👍👍", "👍 approve", "1", "a", "\n👍"])
    expect(isBotReactionEmoji(emoji)).toBe(false)
  const f = fixture()
  expect(() =>
    f.store.reactions.setUser({
      conversationId: f.conversationId,
      messageId: f.sent.messageId,
      emoji: "approve",
      active: true,
      revision: 0
    })
  ).toThrow("有效表情")
  expect(() =>
    f.store.reactions.readMany({
      conversationId: f.conversationId,
      messageIds: Array(201).fill(f.sent.messageId)
    })
  ).toThrow()
})
