import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { botIntroductionQuestionInput } from "../../shared/bot-introduction-question"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const input = botIntroductionQuestionInput.parse({
  questions: [
    {
      id: "work",
      header: "工作范围",
      question: "你想先核对哪类材料？",
      options: [
        { label: "报表数字", description: "检查合计和差额" },
        { label: "文档内容", description: "检查材料的一致性" }
      ]
    }
  ]
})
function fixture(path = ":memory:") {
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const created = store.createBot({
    nonce: "create",
    name: "核对助手",
    introduction: { language: "zh-CN" }
  })
  const task = store.claim("host")!
  const stage = () => store.introductionQuestions.stage(task.lease, "opening-question", input)
  const finish = () => store.finish(task.lease, "succeeded", "你好！发来要核对的材料就可以开始。")
  return { store, ...created, ...task, stage, finish }
}
function reply(f: ReturnType<typeof fixture>, ignored = false) {
  const question = f.store
    .messages(f.conversationId)
    .find((message) => message.introductionQuestion)!.introductionQuestion!
  return {
    runId: question.runId,
    messageId: question.messageId,
    revision: question.revision,
    dataEpoch: question.dataEpoch,
    nonce: "answer-once",
    answer: JSON.stringify(
      ignored
        ? { status: "cancelled", answers: {} }
        : {
            status: "submitted",
            answers: {
              work: { type: "option", questionId: "work", optionIndex: 1, label: "forged label" }
            }
          }
    )
  }
}

it("stages exactly one optional question and publishes it with the real hello, releasing the lease", () => {
  const f = fixture()
  expect(f.stage()).toEqual({ prepared: true, optional: true })
  expect(f.stage()).toEqual({ prepared: true, optional: true })
  expect(() => f.store.introductionQuestions.stage(f.lease, "other", input)).toThrow("已经")
  expect(f.store.getRun(f.run.id).status).toBe("running")
  expect(f.store.snapshot().interactions).toEqual([])
  expect(f.store.messages(f.conversationId)).toEqual([])
  f.finish()
  const message = f.store.messages(f.conversationId)[1]
  expect(message.text).toBe(input.questions[0].question)
  expect(message.introductionQuestion).toMatchObject({
    runId: f.run.id,
    messageId: message.id,
    botId: f.bot.id,
    conversationId: f.conversationId,
    input,
    status: "pending",
    createdAt: message.createdAt
  })
  expect(f.store.getRun(f.run.id)).toMatchObject({
    status: "succeeded",
    leaseOwner: null,
    leaseUntil: null
  })
  expect(f.store.snapshot().interactions).toEqual([])
  expect(f.store.claim("host")).toBeNull()
  expect(f.store.effects(f.run.id)).toEqual([])
})

it("ignoring a question is durable and replayable without creating a fake human answer, run or memory", () => {
  const f = fixture()
  f.stage()
  f.finish()
  const request = reply(f, true),
    before = f.store.messages(f.conversationId)
  const receipt = f.store.introductionQuestions.reply(request)
  expect(receipt).toMatchObject({ send: null, question: { status: "skipped", revision: 2 } })
  expect(f.store.introductionQuestions.reply(request)).toEqual(receipt)
  expect(f.store.messages(f.conversationId).map((m) => [m.id, m.text])).toEqual(
    before.map((m) => [m.id, m.text])
  )
  expect(f.store.nextClaim()).toBeNull()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_memories")[0].values[0][0]).toBe(0)
})

it("submitted choices use server labels and start one ordinary human task, never revive the introduction", () => {
  const f = fixture()
  f.stage()
  f.finish()
  const request = reply(f),
    receipt = f.store.introductionQuestions.reply(request)
  expect(receipt.question).toMatchObject({ status: "answered", revision: 2 })
  expect(receipt.send?.runIds).toHaveLength(1)
  expect(f.store.introductionQuestions.reply(request)).toEqual(receipt)
  const next = f.store.claim("host")!
  expect(next.run.id).toBe(receipt.send!.runIds[0])
  expect(next.run).toMatchObject({ source: "user", messageId: receipt.send!.messageId })
  expect(f.store.getRun(f.run.id).status).toBe("succeeded")
  const messages = f.store.messages(f.conversationId)
  expect(messages).toHaveLength(3)
  expect(messages[2]).toMatchObject({
    sender: "user",
    text: "补充信息\n\n你想先核对哪类材料？\n文档内容",
    replyTo: messages[1].id
  })
  expect(messages[2].text).not.toContain("forged")
  expect(() => f.store.introductionQuestions.reply({ ...request, nonce: "second" })).toThrow(
    "已处理"
  )
  expect(() => f.store.introductionQuestions.reply({ ...request, answer: "different" })).toThrow(
    "不同操作"
  )
})

it("a genuine task supersedes the optional question and fences late answers without losing the actual work", () => {
  const f = fixture()
  f.stage()
  f.finish()
  const request = reply(f)
  const work = f.store.send({
    nonce: "new-work",
    conversationId: f.conversationId,
    text: "检查 18+7+25 的合计"
  })
  expect(f.store.messages(f.conversationId)[1].introductionQuestion?.status).toBe("superseded")
  expect(() => f.store.introductionQuestions.reply(request)).toThrow("已处理")
  expect(f.store.claim("host")!.run.id).toBe(work.runIds[0])
  expect(f.store.messages(f.conversationId)).toHaveLength(3)
})

it("first work racing staged or cancelled introduction cannot publish a question or reclaim its tools", () => {
  const f = fixture()
  f.stage()
  f.store.send({ nonce: "actual", conversationId: f.conversationId, text: "先开始工作" })
  expect(f.finish().status).toBe("cancelled")
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
  expect(f.store.messages(f.conversationId)[0].introductionQuestion).toBeUndefined()
  expect(() => f.stage()).toThrow()
  const other = fixture()
  other.stage()
  other.store.finish(other.lease, "failed", "模型连接失败")
  expect(other.store.messages(other.conversationId)[0].introductionQuestion).toBeUndefined()
})

it("rejects invalid choices, multiple opening questions, stale scopes and foreign messages before writes", () => {
  const f = fixture()
  f.stage()
  f.finish()
  expect(
    botIntroductionQuestionInput.safeParse({
      questions: [input.questions[0], { ...input.questions[0], id: "another" }]
    }).success
  ).toBe(false)
  const request = reply(f),
    before = f.store.messages(f.conversationId)
  expect(() =>
    f.store.introductionQuestions.reply({
      ...request,
      answer: JSON.stringify({
        status: "submitted",
        answers: { work: { type: "option", questionId: "work", optionIndex: 10 } }
      })
    })
  ).toThrow("无效")
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  const otherMessage = f.store.send({
    nonce: "other-input",
    conversationId: other.conversationId,
    text: "other work"
  })
  expect(() =>
    f.store.introductionQuestions.reply({ ...request, messageId: otherMessage.messageId })
  ).toThrow("不存在")
  expect(() =>
    f.store.introductionQuestions.reply({ ...request, dataEpoch: "different" })
  ).toThrow()
  expect(f.store.messages(f.conversationId)).toEqual(before)
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored','{}',?)",
    [f.store.now()]
  )
  expect(f.store.messages(f.conversationId)[1].introductionQuestion?.status).toBe("superseded")
  expect(() => f.store.introductionQuestions.reply(request)).toThrow()
})

it("keeps an accepted reply receipt after reopen and never queues it twice after a lost acknowledgement", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-intro-reply-")),
    path = join(root, "bots.sqlite")
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const f = fixture(path)
  f.stage()
  f.finish()
  const request = reply(f),
    receipt = f.store.introductionQuestions.reply(request)
  f.store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.introductionQuestions.reply(request)).toEqual(receipt)
  expect(reopened.messages(f.conversationId)).toHaveLength(3)
  expect(
    reopened.db.exec("SELECT COUNT(*) FROM bot_runs WHERE source='user'")[0].values[0][0]
  ).toBe(1)
})

it("upgrades schema71 without changing existing public messages or prior creation receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-intro-v71-")),
    path = join(root, "bots.sqlite")
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let store = new BotStore(path)
  cleanup.push(() => store.close())
  const original = { nonce: "legacy", name: "Original" },
    bot = store.createBot(original)
  store.send({ nonce: "old-work", conversationId: bot.conversationId, text: "old task" })
  const messages = store.messages(bot.conversationId)
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_introduction_questions; UPDATE bot_schema SET version=71")
  old.close()
  store = new BotStore(path)
  expect(store.createBot(original)).toEqual(bot)
  expect(store.messages(bot.conversationId)).toEqual(messages)
  expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
  const backups = readdirSync(join(root, "backups")).filter((name) => name.startsWith("bots-v71-"))
  expect(backups).toHaveLength(1)
  const backup = new DatabaseSync(join(root, "backups", backups[0]), { readOnly: true })
  expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(71)
  backup.close()
})
