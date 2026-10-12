import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotSearch } from "./search"
import { BOT_INTRODUCTION_SOURCE } from "../../shared/bot-introduction"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 1_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const input = {
    nonce: "new-bot",
    name: "新 Bot",
    introduction: { language: "zh-CN" },
    expectedDataEpoch: store.dataEpoch()
  }
  const created = store.createBot(input)
  const run = store.nextClaim()!
  return {
    store,
    input,
    ...created,
    run,
    expire() {
      now += 40_000
    }
  }
}

it("creates one hidden cue and ordinary run in the durable creation receipt; old/default and cloned Bots stay quiet", () => {
  const f = fixture()
  expect(f.run.source).toBe(BOT_INTRODUCTION_SOURCE)
  expect(f.store.createBot(f.input)).toEqual({ bot: f.bot, conversationId: f.conversationId })
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0]!.values[0]![0]).toBe(1)
  expect(f.store.messages(f.conversationId)).toEqual([])
  expect(f.store.messagesForRun(f.run.id)).toEqual([])
  expect(() => f.store.message({ conversationId: f.conversationId, id: f.run.messageId })).toThrow()
  expect(() =>
    f.store.send({
      nonce: "reject-hidden-reply",
      conversationId: f.conversationId,
      text: "不应引用内部提示",
      replyTo: f.run.messageId
    })
  ).toThrow("回复的消息不存在")
  expect(f.store.readStates.get(f.conversationId)).toMatchObject({
    unreadCount: 0,
    latestSequence: 0
  })
  expect(
    f.store.snapshot().conversations.find((item) => item.id === f.conversationId)?.lastMessage
  ).toBeUndefined()
  expect(
    new BotSearch(f.store).search({ kind: "message", query: "introduction cue" }).matches
  ).toEqual([])
  const plain = f.store.createBot({ nonce: "old-client", name: "Legacy" })
  expect(f.store.createBot({ nonce: "old-client", name: "Legacy" })).toEqual(plain)
  f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: f.bot.revision })
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0]!.values[0]![0]).toBe(1)
  expect(() => f.store.createBot({ ...f.input, introduction: { language: "en" } })).toThrow("不同")
})

it("rolls the Bot, cue and run back on stale epoch, without altering an accepted legacy create hash", () => {
  const store = new BotStore(":memory:")
  stores.push(store)
  const old = { nonce: "legacy", name: "Original" }
  const result = store.createBot(old)
  store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored','{}',?)",
    [store.now()]
  )
  expect(store.createBot(old)).toEqual(result)
  expect(() =>
    store.createBot({
      nonce: "wrong",
      name: "No write",
      expectedDataEpoch: "initial",
      introduction: { language: "zh-CN" }
    })
  ).toThrow()
  expect(store.listBots()).toHaveLength(1)
  expect(store.db.exec("SELECT COUNT(*) FROM bot_messages")[0]!.values[0]![0]).toBe(0)
  expect(store.db.exec("SELECT COUNT(*) FROM bot_runs")[0]!.values[0]![0]).toBe(0)
})

it("a genuine first task suppresses a queued greeting and owns only its real user message", () => {
  const f = fixture()
  const sent = f.store.send({ nonce: "work", conversationId: f.conversationId, text: "请核对项目" })
  expect(f.store.getRun(f.run.id).status).toBe("cancelled")
  const work = f.store.claim("host")!
  expect(work.run.id).toBe(sent.runIds[0])
  expect(work.run.source).toBe("user")
  expect(f.store.messages(f.conversationId).map((item) => [item.sender, item.text])).toEqual([
    ["user", "请核对项目"]
  ])
  expect(
    f.store.send({ nonce: "work", conversationId: f.conversationId, text: "请核对项目" })
  ).toEqual(sent)
})

it("first genuine input aimed at a live greeting creates a normal task; a racing greeting cannot publish after suppression", () => {
  const f = fixture()
  const greeting = f.store.claim("host")!
  expect(f.store.assertIntroductionDispatch(greeting.lease)).toEqual({ language: "zh-CN" })
  const sent = f.store.send({
    nonce: "first-work",
    conversationId: f.conversationId,
    text: "开始实际工作",
    steerRunId: greeting.run.id
  })
  expect(sent.runIds).not.toContain(greeting.run.id)
  expect(f.store.getRun(greeting.run.id).status).toBe("cancelling")
  expect(() => f.store.assertIntroductionDispatch(greeting.lease)).toThrow()
  expect(f.store.finish(greeting.lease, "succeeded", "迟到的欢迎").status).toBe("cancelled")
  expect(f.store.messages(f.conversationId).map((item) => item.text)).toEqual(["开始实际工作"])
  expect(f.store.claim("host")?.run.id).toBe(sent.runIds[0])
})

it("publishes a genuine completed introduction with no fake user turn or unanswered question lease", () => {
  const f = fixture()
  const greeting = f.store.claim("host")!
  f.store.finish(greeting.lease, "succeeded", "你好！你想先处理哪项工作？")
  expect(f.store.messages(f.conversationId)).toMatchObject([
    { sender: "bot", text: "你好！你想先处理哪项工作？", replyTo: null }
  ])
  expect(f.store.readStates.get(f.conversationId).unreadCount).toBe(1)
  expect(f.store.snapshot().interactions).toEqual([])
  const sent = f.store.send({ nonce: "answer", conversationId: f.conversationId, text: "先看代码" })
  const next = f.store.claim("host")!
  expect(next.run.id).toBe(sent.runIds[0])
  expect(f.store.messagesForRun(next.run.id).map((item) => item.sender)).toEqual(["bot", "user"])
})

it("interrupting a harmless introduction does not block subsequent work behind needs_review", () => {
  const f = fixture()
  f.store.claim("old-host")
  f.expire()
  expect(f.store.recoverExpired()).toBe(1)
  expect(f.store.getRun(f.run.id).status).toBe("cancelled")
  expect(f.store.messages(f.conversationId)).toEqual([])
  const work = f.store.send({
    nonce: "after-restart",
    conversationId: f.conversationId,
    text: "继续工作"
  })
  expect(f.store.claim("new-host")?.run.id).toBe(work.runIds[0])
})

it("only explicitly requested primary ensure creation introduces; present and tombstoned paths do not", () => {
  const store = new BotStore(":memory:")
  stores.push(store)
  const input = {
    nonce: "primary",
    revision: 0,
    dataEpoch: store.dataEpoch(),
    introduction: { language: "zh-CN" },
    profile: { name: "主 Bot" }
  }
  const created = store.primary.ensure(input)
  expect(created.outcome).toBe("created")
  expect(store.primary.ensure(input)).toEqual(created)
  expect(store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0]!.values[0]![0]).toBe(1)
  const present = store.primary.ensure({
    ...input,
    nonce: "again",
    revision: created.state.revision
  })
  expect(present.outcome).toBe("hasMainBot")
  expect(store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0]!.values[0]![0]).toBe(1)
  store.deleteBot(created.botId!, store.getBot(created.botId!).revision, store.dataEpoch())
  const tombstoned = store.primary.ensure({
    ...input,
    nonce: "gone",
    revision: store.primary.read().revision
  })
  expect(tombstoned.outcome).toBe("tombstoned")
  expect(store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0]!.values[0]![0]).toBe(1)
})

it("retaining a message after its completed introduction run is purged never exposes the hidden cue", () => {
  const f = fixture()
  const greeting = f.store.claim("host")!
  f.store.finish(greeting.lease, "succeeded", "你好！")
  f.store.db.run("DELETE FROM bot_runs WHERE id=?", [greeting.run.id])
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0]!.values[0]![0]).toBe(0)
  expect(f.store.messages(f.conversationId).map((item) => item.text)).toEqual(["你好！"])
  expect(f.store.readStates.get(f.conversationId).unreadCount).toBe(1)
  expect(() =>
    f.store.send({
      nonce: "reject-purged-cue-reply",
      conversationId: f.conversationId,
      text: "不应引用内部提示",
      replyTo: greeting.run.messageId
    })
  ).toThrow("回复的消息不存在")
  expect(
    new BotSearch(f.store).search({ kind: "message", query: "introduction cue" }).matches
  ).toEqual([])
})

it("a genuine peer assignment preempts the recipient's live introduction through ordinary enqueue", () => {
  const f = fixture()
  const intro = f.store.claim("welcome-host")!
  const sender = f.store.createBot({ nonce: "sender", name: "项目 Bot" })
  f.store.send({ nonce: "goal", conversationId: sender.conversationId, text: "请委派实际项目工作" })
  const parent = f.store.claim("sender-host")!
  const peer = f.store.sendPeer(parent.lease, {
    nonce: "delegate",
    recipient: f.bot.id,
    text: "请处理这项项目工作"
  })
  expect(f.store.getRun(intro.run.id).status).toBe("cancelling")
  f.store.finish(intro.lease, "cancelled", "被实际工作取代")
  expect(f.store.messages(f.conversationId).map((message) => message.text)).toEqual([
    "请处理这项项目工作"
  ])
  expect(f.store.claim("worker-host")?.run.id).toBe(peer.runIds[0])
})

it("a routine event preempts queued introduction and preserves its original routine authority", () => {
  const f = fixture()
  f.store.saveRoutine({
    botId: f.bot.id,
    name: "检查",
    prompt: "检查项目现状",
    enabled: true,
    schedule: { kind: "event", topic: "project.changed" },
    timezone: "UTC"
  })
  const dispatched = f.store.emitEvent({
    nonce: "project-event",
    topic: "project.changed",
    payload: "变化的项目资料"
  }).runIds
  expect(dispatched).toHaveLength(1)
  expect(f.store.getRun(f.run.id).status).toBe("cancelled")
  const claimed = f.store.claim("event-host")!
  expect(claimed.run.id).toBe(dispatched[0])
  expect(claimed.run.source).toMatch(/^event:/)
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
})

it("an explicitly run routine preempts live introduction without changing the ordinary task lane", () => {
  const f = fixture()
  const intro = f.store.claim("welcome-host")!
  const routine = f.store.saveRoutine({
    botId: f.bot.id,
    name: "检查",
    prompt: "核对项目",
    enabled: false,
    schedule: { kind: "event", topic: "manual.check" },
    timezone: "UTC"
  })
  const actual = f.store.runRoutine({
    nonce: "manual-work",
    id: routine.id,
    revision: routine.revision,
    expectedDataEpoch: f.store.dataEpoch()
  })
  expect(f.store.getRun(intro.run.id).status).toBe("cancelling")
  f.store.finish(intro.lease, "cancelled", "真实任务开始")
  expect(f.store.claim("work-host")?.run.id).toBe(actual.id)
})
