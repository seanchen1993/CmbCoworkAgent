import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"
const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "学习助手" })
  return { store, bot, conversationId, teach: new BotTeachStore(store) }
}
function queued(f: ReturnType<typeof fixture>) {
  let session = f.teach.create({
    botId: f.bot.id,
    conversationId: f.conversationId,
    nonce: "recording"
  })
  f.teach.addFrame(session.id, {
    at: 10,
    sha256: "a".repeat(64),
    size: 100,
    url: "https://example.test",
    title: "任务"
  })
  session = f.teach.update(session.id, session.revision, "finalizing")
  return f.teach.update(session.id, session.revision, "queued", {
    video: { size: 200, sha256: "b".repeat(64), mime: "video/webm" }
  })
}

it("deduplicates starts, excludes simultaneous recordings and rejects stale state transitions", () => {
  const f = fixture(),
    input = { botId: f.bot.id, conversationId: f.conversationId, nonce: "recording" }
  const session = f.teach.create(input)
  expect(f.teach.create(input).id).toBe(session.id)
  expect(() => f.teach.create({ ...input, nonce: "another" })).toThrow("已有示范")
  expect(() => f.teach.update(session.id, session.revision, "ready")).toThrow("不支持")
  const paused = f.teach.update(session.id, session.revision, "paused")
  f.teach.addEvent(session.id, "text", { text: "must-not-record" })
  expect(f.teach.events(session.id)).toEqual([])
  expect(() => f.teach.update(session.id, session.revision, "recording")).toThrow("已变化")
  f.teach.update(session.id, paused.revision, "discarded")
  expect(f.teach.create({ ...input, nonce: "another" }).id).not.toBe(session.id)
})

it("recovers the learning enqueue crash gap without creating duplicate runs", () => {
  const f = fixture(),
    session = queued(f)
  const learned = f.teach.queue(session.id)
  expect(f.teach.queue(session.id).learningRunId).toBe(learned.learningRunId)
  // Crash after store.send committed but before the session phase update was committed.
  f.store.db.run("UPDATE bot_teach_sessions SET phase='queued',learning_run_id=NULL WHERE id=?", [
    session.id
  ])
  expect(f.teach.queue(session.id).learningRunId).toBe(learned.learningRunId)
  expect(f.store.snapshot().runs).toHaveLength(1)
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
})

it("keeps tool instructions out of the visible learning request while retaining its recording binding", () => {
  const f = fixture(),
    session = f.teach.queue(queued(f).id)
  const message = f.store.messages(f.conversationId)[0]
  expect(message.text).toBe(
    "示范已保存，请把刚才的操作整理成可复用技能，并说明适用场景和验收方法。"
  )
  expect(message.text).not.toContain(session.id)
  expect(f.teach.forRun(session.learningRunId!)?.id).toBe(session.id)
})

it("recovers an older learning receipt with its exact original message without duplicating work", () => {
  const f = fixture(),
    session = queued(f)
  const original = f.store.send({
    nonce: `teach-learning:${session.id}:${session.attempt}`,
    conversationId: session.conversationId,
    recipients: [session.botId],
    text: `示范已结束，请学习记录 ${session.id}，提炼可复用的步骤、输入参数、判断条件和验收方法，并保存为技能。先用 read_demonstration 查看画面和操作，不能把坐标串当作技能；尚未试跑，不要标记已验证。`
  })
  const recovered = f.teach.queue(session.id)
  expect(recovered.learningRunId).toBe(original.runIds[0])
  expect(f.teach.forRun(original.runIds[0])?.id).toBe(session.id)
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
  expect(f.store.snapshot().runs).toHaveLength(1)
})

it("does not bind an unrelated receipt or invent another nonce when a learning request conflicts", () => {
  const f = fixture(),
    session = queued(f)
  f.store.send({
    nonce: `teach-learning:${session.id}:${session.attempt}`,
    conversationId: session.conversationId,
    recipients: [session.botId],
    text: "与示范无关的任务"
  })
  expect(() => f.teach.queue(session.id)).toThrow("同一请求标识")
  expect(f.teach.get(session.id)).toMatchObject({ phase: "queued", learningRunId: null })
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
  expect(f.store.snapshot().runs).toHaveLength(1)
})

it("requires actual frame reads, atomically saves one unverified skill and fences other runs", () => {
  const f = fixture(),
    session = f.teach.queue(queued(f).id),
    claim = f.store.claim("host")!
  const input = { name: "整理记录", instructions: "读取用户指定记录，整理并核对结果" }
  expect(() => f.teach.saveLearned(session.id, claim.lease, "save", input)).toThrow("完整查看")
  f.teach.readFrames(session.id, claim.lease, [0])
  const skill = f.teach.saveLearned(session.id, claim.lease, "save", input)
  expect(skill.verified).toBe(false)
  expect(f.teach.saveLearned(session.id, claim.lease, "save", input)).toEqual(skill)
  expect(f.store.skills(f.bot.id)).toHaveLength(1)
  expect(f.teach.get(session.id)).toMatchObject({ phase: "ready", skillId: skill.id })
  f.store.finish(claim.lease, "succeeded", "学习完成")
  expect(() => f.teach.retry({ id: session.id, nonce: "already-learned" })).toThrow(
    "不支持重新学习"
  )
  expect(f.store.skills(f.bot.id)).toHaveLength(1)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(1)
  f.store.send({ nonce: "other", conversationId: f.conversationId, text: "其他任务" })
  expect(() => f.teach.authorizeRead(session.id, f.store.claim("host")!.lease)).toThrow("不属于")
})

it("retries saved recordings with a new durable run while deduplicating retry requests", () => {
  const f = fixture(),
    session = f.teach.queue(queued(f).id),
    claim = f.store.claim("host")!
  f.store.finish(claim.lease, "failed", "模型服务暂时不可用")
  f.teach.update(session.id, session.revision, "failed", { error: "模型服务暂时不可用" })
  const retried = f.teach.retry({ id: session.id, nonce: "retry-once" })
  expect(retried.attempt).toBe(1)
  expect(retried.learningRunId).not.toBe(session.learningRunId)
  expect(f.teach.retry({ id: session.id, nonce: "retry-once" }).learningRunId).toBe(
    retried.learningRunId
  )
  expect(f.store.getRun(session.learningRunId!).status).toBe("failed")
  expect(f.store.getRun(retried.learningRunId!).status).toBe("queued")
  expect(
    f.store.messages(f.conversationId).filter((message) => message.sender === "user")
  ).toHaveLength(2)
  expect(() => f.teach.retry({ id: session.id, nonce: "double-click" })).toThrow("不支持重新学习")
})

it.each(["queued", "running", "waiting_input", "needs_review"] as const)(
  "does not relearn while the original learning run is %s",
  (status) => {
    const f = fixture(),
      session = f.teach.queue(queued(f).id)
    if (status !== "queued") {
      const claim = f.store.claim("host")!
      if (status === "waiting_input")
        f.store.requestInteraction(claim.lease, { kind: "question", prompt: "请补充缺少的步骤" })
      if (status === "needs_review") f.store.recoverAbandonedAtStartup()
    }
    expect(f.store.getRun(session.learningRunId!).status).toBe(status)
    const failed = f.teach.update(session.id, session.revision, "failed")
    expect(() => f.teach.retry({ id: session.id, nonce: "cannot-relearn" })).toThrow(
      "请先处理原学习任务"
    )
    expect(f.teach.get(session.id)).toEqual(failed)
    expect(f.store.snapshot().runs).toHaveLength(1)
    expect(f.store.messages(f.conversationId)).toHaveLength(1)
  }
)

it("preserves an existing skill identity even if a recording's phase is failed", () => {
  const f = fixture(),
    session = f.teach.queue(queued(f).id),
    claim = f.store.claim("host")!
  f.teach.readFrames(session.id, claim.lease, [0])
  const skill = f.teach.saveLearned(session.id, claim.lease, "save", {
    name: "已保存的技能",
    instructions: "保留已经保存的工作方法"
  })
  f.store.finish(claim.lease, "succeeded", "学习完成")
  // A conflicting imported or legacy phase cannot erase the committed skill identity.
  f.store.db.run("UPDATE bot_teach_sessions SET phase='failed' WHERE id=?", [session.id])
  const before = f.teach.get(session.id)
  expect(() => f.teach.retry({ id: session.id, nonce: "saved-skill-retry" })).toThrow(
    "不支持重新学习"
  )
  expect(f.teach.get(session.id)).toEqual(before)
  expect(f.store.skills(f.bot.id)).toEqual([skill])
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(1)
})

it("rolls back the message and receipt if binding a learning run to its recording fails", () => {
  const f = fixture(),
    session = queued(f)
  f.store.db.run(
    "CREATE TRIGGER fail_learning BEFORE UPDATE OF phase ON bot_teach_sessions WHEN NEW.phase='learning' BEGIN SELECT RAISE(ABORT,'binding failed'); END"
  )
  expect(() => f.teach.queue(session.id)).toThrow("binding failed")
  expect(f.store.messages(f.conversationId)).toEqual([])
  expect(f.store.claim("host")).toBeNull()
  expect(f.teach.get(session.id).phase).toBe("queued")
  f.store.db.run("DROP TRIGGER fail_learning")
  const learned = f.teach.queue(session.id)
  expect(learned.learningRunId).not.toBeNull()
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
})

it("pages all recordings with tied timestamps, excludes deleted ones and rejects another Bot's cursor", () => {
  const f = fixture()
  const ids = new Set<string>()
  for (let index = 0; index < 35; index++) {
    const session = f.teach.create({
      botId: f.bot.id,
      conversationId: f.conversationId,
      nonce: `recording-${index}`
    })
    f.teach.update(session.id, session.revision, "interrupted")
    f.store.db.run("UPDATE bot_teach_sessions SET started_at=1 WHERE id=?", [session.id])
    ids.add(session.id)
  }
  const first = f.teach.history({ botId: f.bot.id })
  expect(first.items).toHaveLength(30)
  const second = f.teach.history({ botId: f.bot.id, before: first.nextCursor! })
  expect(second.items).toHaveLength(5)
  expect(second.nextCursor).toBeNull()
  expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(ids)
  const other = f.store.createBot({ name: "other", nonce: "other" })
  expect(() => f.teach.history({ botId: other.bot.id, before: first.nextCursor! })).toThrow(
    "不属于"
  )
  f.teach.discardSaved({ id: first.items[0].id, revision: first.items[0].revision })
  expect(
    f.teach.history({ botId: f.bot.id }).items.some((item) => item.id === first.items[0].id)
  ).toBe(false)
})

it("prevents deleting active or uncertain learning evidence and preserves skill and nonce after explicit deletion", () => {
  const f = fixture(),
    queuedSession = queued(f)
  let session = f.teach.queue(queuedSession.id)
  expect(() => f.teach.discardSaved(session)).toThrow("学习结束")
  const claim = f.store.claim("test-host")!
  f.teach.update(session.id, session.revision, "failed")
  session = f.teach.get(session.id)
  expect(() => f.teach.discardSaved(session)).toThrow("恢复所需")
  f.store.finish(claim.lease, "failed", "test failed")
  const skill = f.store.saveSkill({
    botId: f.bot.id,
    name: "independent skill",
    instructions: "review",
    enabled: true
  })
  expect(() => f.teach.discardSaved({ id: session.id, revision: session.revision - 1 })).toThrow(
    "状态已变化"
  )
  f.teach.discardSaved(session)
  expect(f.teach.get(session.id).video).toBeNull()
  expect(f.teach.frames(session.id)).toEqual([])
  expect(f.teach.events(session.id)).toEqual([])
  expect(
    f.teach.create({ botId: f.bot.id, conversationId: f.conversationId, nonce: "recording" }).phase
  ).toBe("discarded")
  expect(f.store.skills(f.bot.id).some((item) => item.id === skill.id)).toBe(true)
  expect(f.teach.discardSaved(session).phase).toBe("discarded")
})

it("keeps demonstrations attached to a Bot's direct conversation", () => {
  const f = fixture()
  const other = f.store.createBot({ nonce: "other", name: "其他" })
  const group = f.store.createGroup({
    nonce: "group",
    name: "群",
    members: [f.bot.id, other.bot.id]
  })
  expect(() =>
    f.teach.create({ botId: f.bot.id, conversationId: group.id, nonce: "invalid" })
  ).toThrow("私聊")
  expect(f.teach.list()).toEqual([])
})
