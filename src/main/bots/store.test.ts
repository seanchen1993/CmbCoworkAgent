import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"

const stores: BotStore[] = [],
  directories: string[] = []
let now = 1_800_000_000_000
function open(path = ":memory:") {
  const store = new BotStore(path, () => now)
  stores.push(store)
  return store
}
function create(store: BotStore, name = "研究员") {
  return store.createBot({ nonce: `create-${Buffer.from(name).toString("hex")}`, name })
}
function task(store: BotStore) {
  const { bot, conversationId } = create(store)
  const receipt = store.send({ nonce: "message-1", conversationId, text: "分析需求" })
  const claimed = store.claim("host-a")!
  return { bot, conversationId, receipt, ...claimed }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  now = 1_800_000_000_000
})

describe("durable Bot work", () => {
  it("acknowledges a lost profile update after restart without replaying it over a newer edit", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-profile-receipt-"))
    directories.push(directory)
    const path = join(directory, "bots.sqlite")
    const store = open(path)
    const { bot, conversationId } = create(store)
    const input = {
      id: bot.id,
      revision: bot.revision,
      nonce: "profile-save",
      name: "评审助手",
      modelRef: null
    }
    const saved = store.updateBot(input)
    const next = store.updateBot({ id: bot.id, revision: saved.revision, instructions: "新的职责" })
    const eventCount = store.events(0).length
    const reopened = open(path)
    expect(reopened.updateBot(input)).toEqual(saved)
    expect(reopened.getBot(bot.id)).toEqual(next)
    expect(reopened.getConversation(conversationId).name).toBe("评审助手")
    expect(reopened.events(0)).toHaveLength(eventCount)
    expect(() => reopened.updateBot({ ...input, name: "另一份修改" })).toThrow("同一请求标识")
    expect(() => reopened.updateBot({ ...input, nonce: "stale-save" })).toThrow("已被修改")
    // A rejected write does not consume its nonce or relax revision checks.
    expect(
      reopened.updateBot({ ...input, nonce: "stale-save", revision: next.revision }).revision
    ).toBe(next.revision + 1)
  })
  it("does not create an update receipt for a busy Bot or an invalid profile", () => {
    const store = open()
    const { bot, lease } = task(store)
    const input = {
      id: bot.id,
      revision: bot.revision,
      nonce: "busy-save",
      instructions: "新的职责"
    }
    expect(() => store.updateBot(input)).toThrow("请先停止")
    expect(store.getBot(bot.id).revision).toBe(bot.revision)
    store.cancel(lease.runId)
    const run = store.getRun(lease.runId)
    // Cancellation still owns execution until its worker has settled.
    expect(run.status).toBe("cancelling")
    expect(() => store.updateBot({ ...input, instructions: "\0" })).toThrow("职责格式")
    expect(
      store.updateBot({
        id: bot.id,
        revision: bot.revision,
        nonce: "busy-save",
        name: "处理中"
      }).name
    ).toBe("处理中")
  })
  it("retains a fenced computer wait without consuming other interaction authority", () => {
    const store = open(),
      { lease, bot } = task(store)
    store.waitForComputer(lease, true)
    const waiting = store.getRun(lease.runId)
    expect(waiting).toMatchObject({ status: "waiting_input", waitingForComputer: true })
    store.waitForComputer(lease, true)
    expect(store.getRun(lease.runId).revision).toBe(waiting.revision)
    expect(() =>
      store.requestInteraction(lease, { kind: "question", prompt: "unexpected" })
    ).toThrow("执行权已失效")
    expect(store.claim("another-host")).toBeNull()
    const other = create(store, "另一个 Bot")
    store.send({ nonce: "independent", conversationId: other.conversationId, text: "独立任务" })
    expect(store.claim("other-host")?.run.botId).not.toBe(bot.id)
    store.waitForComputer(lease, false)
    expect(store.getRun(lease.runId)).toMatchObject({
      status: "running",
      waitingForComputer: false
    })
    const question = store.requestInteraction(lease, { kind: "question", prompt: "请确认" })
    expect(() => store.waitForComputer(lease, false)).toThrow("等待状态已变化")
    expect(() => store.waitForComputer(lease, true)).toThrow("另一项交互")
    store.answerInteraction({ id: question.id, revision: question.revision, answer: "继续" })
    store.waitForComputer(lease, true)
    store.cancel(lease.runId)
    expect(() => store.waitForComputer(lease, false)).toThrow("执行权已失效")
  })
  it("retains plugin presentation across restart without changing model history or accepting an expired writer", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-plugin-notice-"))
    directories.push(directory)
    const path = join(directory, "bots.sqlite"),
      store = open(path)
    const { lease, conversationId } = task(store)
    store.pluginTurn(lease, { reason: "answer", text: "插件完成提示" })
    store.pluginTurn(lease, { reason: "error", text: "重复完成不能覆盖", failed: true })
    store.finish(lease, "succeeded", "模型原始答复")
    expect(() => store.pluginTurn(lease, { reason: "answer", text: "迟到写入" })).toThrow(
      "执行权已失效"
    )
    store.close()
    const next = open(path)
    expect(next.messages(conversationId).at(-1)).toMatchObject({
      text: "模型原始答复",
      pluginNotice: { text: "插件完成提示", failed: false }
    })
    const followup = next.send({ nonce: "next", conversationId, text: "继续" })
    expect(JSON.stringify(next.messagesForRun(followup.runIds[0]))).not.toContain("插件完成提示")
    const current = next.claim("host-b")!
    expect(() =>
      next.pluginTurn(current.lease, { reason: "error", text: "a".repeat(4001) })
    ).toThrow("4000")
    next.cancel(current.run.id)
    next.pluginTurn(current.lease, { reason: "aborted", text: "已停止" })
    next.finish(current.lease, "cancelled", "停止任务")
    expect(next.messages(conversationId).at(-1)?.pluginNotice?.text).toBe("已停止")
  })

  it("persists structured question answers with server validation, replay identity and cancellation fences", () => {
    const store = open(),
      { lease } = task(store)
    const prompt = JSON.stringify({
      botQuestions: {
        version: 1,
        input: {
          questions: [{ id: "branch", header: "分支", question: "使用哪个分支？", options: [] }]
        }
      }
    })
    const interaction = store.requestInteraction(lease, { kind: "question", prompt })
    expect(() =>
      store.answerInteraction({ id: interaction.id, revision: 1, answer: "未经验证的文本" })
    ).toThrow("卡片")
    expect(store.getInteraction(interaction.id).status).toBe("pending")
    const response = {
      id: interaction.id,
      revision: 1,
      answer: JSON.stringify({
        status: "submitted",
        answers: { branch: { type: "other", questionId: "branch", text: "main" } }
      })
    }
    const accepted = store.answerInteraction(response)
    expect(store.answerInteraction(response)).toEqual(accepted)
    const answeredMessages = store
      .messages(store.getRun(lease.runId).conversationId)
      .filter((message) => message.runId === lease.runId)
    expect(answeredMessages).toHaveLength(1)
    expect(answeredMessages[0]).toMatchObject({
      sender: "user",
      text: "补充信息\n\n使用哪个分支？\nmain",
      replyTo: store.getRun(lease.runId).messageId
    })
    expect(() =>
      store.answerInteraction({
        ...response,
        answer: JSON.stringify({ status: "cancelled", answers: {} })
      })
    ).toThrow("已处理")
    const next = store.requestInteraction(lease, { kind: "question", prompt })
    const run = store.getRun(lease.runId)
    store.cancel(run.id)
    expect(() =>
      store.answerInteraction({
        id: next.id,
        revision: 1,
        answer: JSON.stringify({ status: "cancelled", answers: {} })
      })
    ).toThrow()
  })
  it("persists avatar choices, permits appearance changes during work and rejects unsupported values", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-persona-"))
    directories.push(directory)
    const path = join(directory, "bots.sqlite")
    const store = open(path)
    const input = {
      nonce: "persona-create",
      name: "头像",
      avatarShape: "cloud",
      avatarColor: "violet"
    } as const
    const created = store.createBot(input)
    expect(store.createBot(input)).toEqual(created)
    expect(() => store.createBot({ ...input, avatarColor: "blue" })).toThrow()
    expect(() =>
      store.createBot({
        ...input,
        nonce: "bad",
        avatarShape: "<svg>" as unknown as import("../../shared/bot-types").CoworkBot["avatarShape"]
      })
    ).toThrow("头像形状")
    store.send({ nonce: "avatar-work", conversationId: created.conversationId, text: "工作" })
    store.claim("host")
    const updated = store.updateBot({ id: created.bot.id, revision: 1, avatarColor: "green" })
    expect(updated.avatarShape).toBe("cloud")
    expect(updated.avatarColor).toBe("green")
    expect(() =>
      store.updateBot({
        id: created.bot.id,
        revision: 2,
        avatarColor:
          "url(https://example.com)" as unknown as import("../../shared/bot-types").CoworkBot["avatarColor"]
      })
    ).toThrow("头像颜色")
    const reopened = open(path)
    expect(reopened.snapshot().bots[0]).toMatchObject({
      avatarShape: "cloud",
      avatarColor: "green",
      revision: 2
    })
    expect(
      reopened.updateBot({ id: created.bot.id, revision: 2, avatarShape: null, avatarColor: null })
    ).toMatchObject({ avatarShape: null, avatarColor: null })
  })

  it("commits internal tool writes and replay receipts atomically", () => {
    const store = open(),
      { bot, lease } = task(store)
    const mutate = () => store.saveMemory({ botId: bot.id, text: "持久偏好" })
    const first = store.toolOnce(lease, "call-1", { text: "持久偏好", optional: undefined }, mutate)
    expect(store.toolOnce(lease, "call-1", { text: "持久偏好" }, mutate)).toEqual(first)
    expect(store.memories(bot.id)).toHaveLength(1)
    expect(() =>
      store.toolOnce(lease, "call-2", {}, () => {
        mutate()
        throw new Error("commit failed")
      })
    ).toThrow("commit failed")
    expect(store.memories(bot.id)).toHaveLength(1)
  })

  it("keeps nested tool receipts in the owning transaction and rolls them back together", () => {
    const store = open(),
      { bot, lease } = task(store)
    const action = { routine: "nested-write" }
    const approval = store.requestInteraction(lease, { kind: "approval", prompt: "保存", action })
    store.answerInteraction({ id: approval.id, revision: 1, answer: "approve" })
    const effect = { id: "outer", action, approvalId: approval.id }
    const operation = () =>
      JSON.stringify(
        store.toolOnce(lease, "inner", {}, () =>
          store.saveMemory({ botId: bot.id, text: "已确认的要求" })
        )
      )
    expect(() =>
      store.approvedToolOnce(lease, effect, () => {
        operation()
        store.saveMemory({ botId: bot.id, text: "事务内的后续修改" })
        throw new Error("fail after inner receipt")
      })
    ).toThrow("fail after inner receipt")
    expect(store.memories(bot.id)).toEqual([])
    expect(store.effects(lease.runId)).toEqual([])
    expect(store.hasToolResult(lease, "inner")).toBe(false)
    expect(store.hasToolResult(lease, "outer")).toBe(false)
    const result = store.approvedToolOnce(lease, effect, operation)
    expect(store.approvedToolOnce(lease, effect, operation)).toBe(result)
    expect(
      store.toolOnce(lease, "inner", {}, () => {
        throw new Error("must replay")
      })
    ).toEqual(JSON.parse(result))
    expect(store.memories(bot.id)).toHaveLength(1)
    expect(store.effects(lease.runId)).toHaveLength(1)
    // Tool scopes must not permit unrelated nested transactions after completion.
    expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow(
      "Bot 事务不能嵌套"
    )
  })

  it("requires complete effect reconciliation and fences the old executor on recovery", () => {
    const store = open(),
      { lease } = task(store),
      action = { op: "submit" }
    const approval = store.requestInteraction(lease, { kind: "approval", prompt: "提交", action })
    store.answerInteraction({ id: approval.id, revision: 1, answer: "approve" })
    store.beginEffect(lease, { id: "effect", action, approvalId: approval.id })
    now += 31_000
    store.recoverExpired()
    const run = store.getRun(lease.runId)
    expect(() =>
      store.recover({
        id: run.id,
        revision: run.revision,
        decision: "resume",
        note: "已核对",
        effects: []
      })
    ).toThrow("逐项核对")
    store.recover({
      id: run.id,
      revision: run.revision,
      decision: "resume",
      note: "目标系统确认",
      effects: [{ id: "effect", outcome: "succeeded", note: "记录已存在" }]
    })
    expect(() => store.finish(lease, "succeeded", "late")).toThrow("执行权已失效")
    const next = store.claim("host-b")!
    expect(next.run.id).toBe(run.id)
    expect(store.effectResult(next.lease, "effect")?.status).toBe("succeeded")
    expect(() =>
      store.recover({
        id: run.id,
        revision: run.revision,
        decision: "resume",
        note: "again",
        effects: []
      })
    ).toThrow("状态已变化")
  })

  it("settles an expired question as failed instead of leaving its Bot locked", () => {
    const store = open(),
      { lease } = task(store)
    store.requestInteraction(lease, { kind: "question", prompt: "目标？", expiresInMs: 1000 })
    now += 1001
    expect(store.finish(lease, "failed", "请求过期").status).toBe("failed")
    expect(store.snapshot().interactions).toEqual([])
  })
  it("atomically deduplicates acceptance and refuses nonce reuse with different input", () => {
    const store = open(),
      { conversationId } = create(store)
    const input = { nonce: "send-1", conversationId, text: "工作 A" }
    const first = store.send(input),
      eventCount = store.events().length
    expect(store.send(input)).toEqual(first)
    expect(store.events()).toHaveLength(eventCount)
    expect(store.messages(conversationId)).toHaveLength(1)
    expect(() => store.send({ ...input, text: "工作 B" })).toThrow("同一请求标识")
    expect(store.snapshot().runs).toHaveLength(1)
  })

  it("rolls back messages, receipts and events if a group recipient is invalid", () => {
    const store = open(),
      a = create(store, "A"),
      b = create(store, "B"),
      c = create(store, "C")
    const group = store.createGroup({
      nonce: "group",
      name: "项目组",
      members: [a.bot.id, b.bot.id]
    })
    const cursor = store.snapshot().cursor
    expect(() =>
      store.send({
        nonce: "send",
        conversationId: group.id,
        text: "test",
        recipients: [a.bot.id, c.bot.id]
      })
    ).toThrow("当前对话成员")
    expect(store.messages(group.id)).toEqual([])
    expect(store.events(cursor)).toEqual([])
    expect(
      store.send({ nonce: "send", conversationId: group.id, text: "test" }).runIds
    ).toHaveLength(1) // The durable group driver queues one speaker at a time.
  })

  it("allows only one running task per Bot across database connections, but different Bots can work concurrently", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmb-bot-store-"))
    directories.push(dir)
    const path = join(dir, "bots.sqlite"),
      first = open(path),
      second = open(path)
    const a = create(first, "A"),
      b = create(first, "B")
    first.send({ nonce: "a1", conversationId: a.conversationId, text: "one" })
    first.send({ nonce: "a2", conversationId: a.conversationId, text: "two" })
    first.send({ nonce: "b1", conversationId: b.conversationId, text: "three" })
    expect(first.claim("host-1")!.run.botId).toBe(a.bot.id)
    expect(second.claim("host-2")!.run.botId).toBe(b.bot.id)
    expect(second.claim("host-2")).toBeNull()
  })

  it("preserves accepted work across reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmb-bot-restart-"))
    directories.push(dir)
    const path = join(dir, "bots.sqlite"),
      store = open(path)
    const { conversationId } = create(store)
    const sent = store.send({ nonce: "once", conversationId, text: "持久消息" })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = open(path)
    expect(reopened.send({ nonce: "once", conversationId, text: "持久消息" })).toEqual(sent)
    expect(reopened.claim("new-host")!.run.id).toBe(sent.runIds[0])
  })

  it("invalidates an expired executor without replaying potentially submitted work", () => {
    const store = open(),
      { lease, conversationId } = task(store)
    now += 31_000
    expect(store.recoverExpired()).toBe(1)
    expect(store.getRun(lease.runId).status).toBe("needs_review")
    expect(() => store.finish(lease, "succeeded", "late result")).toThrow("执行权已失效")
    store.send({ nonce: "followup", conversationId, text: "继续" })
    expect(store.claim("new-host")).toBeNull()
  })

  it("requires a concrete, unexpired, single-use approval and blocks late writes after Stop", () => {
    const store = open(),
      { lease } = task(store),
      action = { tool: "send", destination: "test", body: "reviewed" }
    const approval = store.requestInteraction(lease, { kind: "approval", prompt: "发送？", action })
    expect(() =>
      store.beginEffect(lease, { id: "effect", action, approvalId: approval.id })
    ).toThrow()
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    expect(() =>
      store.beginEffect(lease, {
        id: "effect",
        action: { ...action, body: "changed" },
        approvalId: approval.id
      })
    ).toThrow("操作未经有效批准")
    store.beginEffect(lease, { id: "effect", action, approvalId: approval.id })
    expect(() =>
      store.beginEffect(lease, { id: "duplicate", action, approvalId: approval.id })
    ).toThrow("已有执行记录")
    store.cancel(lease.runId)
    expect(() => store.assertLease(lease)).toThrow("执行权已失效")
    store.settleEffect(lease, "effect", "succeeded", "actually sent")
    expect(store.finish(lease, "succeeded", "停止前已发送").status).toBe("cancelled")
  })

  it("allows a separately approved repeated action after reopening while each approval stays single-use", () => {
    const directory = mkdtempSync(join(tmpdir(), "bot-effect-approval-"))
    directories.push(directory)
    const path = join(directory, "bots.sqlite")
    const original = open(path)
    const { lease } = task(original)
    const action = { shell: { command: "npm test", cwd: "/project" } }
    const first = original.requestInteraction(lease, {
      kind: "approval",
      prompt: "第一次测试",
      action
    })
    original.answerInteraction({ id: first.id, revision: first.revision, answer: "approve" })
    original.beginEffect(lease, { id: "before-fix", action, approvalId: first.id })
    original.settleEffect(lease, "before-fix", "succeeded", "completed with failing tests")
    original.close()
    stores.splice(stores.indexOf(original), 1)
    const store = open(path)
    const second = store.requestInteraction(lease, {
      kind: "approval",
      prompt: "修改后再次测试",
      action
    })
    store.answerInteraction({ id: second.id, revision: second.revision, answer: "approve" })
    expect(() =>
      store.beginEffect(lease, { id: "reuse-first", action, approvalId: first.id })
    ).toThrow("已有执行记录")
    store.beginEffect(lease, { id: "after-fix", action, approvalId: second.id })
    store.settleEffect(lease, "after-fix", "succeeded", "tests passed")
    expect(() =>
      store.beginEffect(lease, { id: "reuse-second", action, approvalId: second.id })
    ).toThrow("已有执行记录")
    expect(
      store
        .effects(lease.runId)
        .map((effect) => effect.id)
        .sort()
    ).toEqual(["after-fix", "before-fix"])
  })

  it.each(["started", "failed", "unknown", "legacy"] as const)(
    "does not repeat an unresolved or unlinked %s effect under a fresh approval",
    (state) => {
      const store = open(),
        { lease } = task(store)
      const action = { shell: { command: "npm test", cwd: "/project" } }
      const first = store.requestInteraction(lease, { kind: "approval", prompt: "测试", action })
      store.answerInteraction({ id: first.id, revision: first.revision, answer: "approve" })
      store.beginEffect(lease, { id: "original", action, approvalId: first.id })
      if (state !== "started")
        store.settleEffect(
          lease,
          "original",
          state === "legacy" ? "succeeded" : state,
          "recorded outcome"
        )
      if (state === "legacy")
        store.db.run("DELETE FROM bot_effect_approvals WHERE effect_id='original'")
      const second = store.requestInteraction(lease, {
        kind: "approval",
        prompt: "再次测试",
        action
      })
      store.answerInteraction({ id: second.id, revision: second.revision, answer: "approve" })
      expect(() =>
        store.beginEffect(lease, { id: "another", action, approvalId: second.id })
      ).toThrow()
      expect(store.effects(lease.runId)).toHaveLength(1)
    }
  )

  it("keeps unknown side effects visible even when a worker reports success", () => {
    const store = open(),
      { lease } = task(store),
      action = { tool: "publish", version: 1 }
    const approval = store.requestInteraction(lease, { kind: "approval", prompt: "发布？", action })
    store.answerInteraction({ id: approval.id, revision: 1, answer: "approve" })
    store.beginEffect(lease, { id: "uncertain", action, approvalId: approval.id })
    expect(store.finish(lease, "succeeded", "done").status).toBe("needs_review")
  })

  it("preserves a bounded masked failure cause alongside unresolved effects without releasing them", () => {
    const store = open(),
      { lease, conversationId } = task(store),
      action = { tool: "publish", version: 1 }
    const approval = store.requestInteraction(lease, { kind: "approval", prompt: "发布？", action })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    store.beginEffect(lease, { id: "uncertain-failure", action, approvalId: approval.id })
    const failure = `Original workflow input mismatch; Authorization: Bearer PRIVATE_TEST_TOKEN\n${"x".repeat(4000)}`
    const run = store.finish(lease, "failed", failure)
    expect(run).toMatchObject({ status: "needs_review", result: null })
    expect(run.error).toContain("存在未结算的操作或子任务")
    expect(run.error).toContain("Original workflow input mismatch")
    expect(run.error).not.toContain("PRIVATE_TEST_TOKEN")
    expect(run.error!.length).toBeLessThan(2200)
    expect(store.effects(run.id)[0].status).toBe("started")
    expect(store.messages(conversationId).at(-1)?.text).toBe(run.error)
  })

  it("rejects stale concurrent approval responses and tolerates an identical retry", () => {
    const store = open(),
      { lease } = task(store)
    const question = store.requestInteraction(lease, { kind: "question", prompt: "选择目标" })
    const input = { id: question.id, revision: 1, answer: "目标 A" }
    expect(store.answerInteraction(input).answer).toBe("目标 A")
    expect(store.answerInteraction(input).answer).toBe("目标 A")
    expect(() => store.answerInteraction({ ...input, answer: "目标 B" })).toThrow("已处理")
  })

  it("delivers peer work once and returns the result to the origin conversation", () => {
    const store = open(),
      a = task(store),
      b = create(store, "验证员")
    const input = { nonce: "peer", recipient: b.bot.id, text: "验证方案" }
    const sent = store.sendPeer(a.lease, input)
    expect(store.sendPeer(a.lease, input)).toEqual(sent)
    const received = store.claim("host-b")!
    expect(received.run.parentRunId).toBe(a.run.id)
    expect(received.run.lane).toBe("agent")
    store.finish(received.lease, "succeeded", "验证结果：通过")
    expect(store.messages(a.conversationId).at(-1)?.text).toBe("验证结果：通过")
    expect(store.messages(b.conversationId).at(-1)?.text).toBe("验证结果：通过")
  })

  it("prioritizes direct user work before group, peer and background work", () => {
    const store = open(),
      a = create(store, "A"),
      b = create(store, "B")
    const group = store.createGroup({ nonce: "g", name: "组", members: [a.bot.id, b.bot.id] })
    store.send({ nonce: "group-task", conversationId: group.id, text: "群消息" })
    const direct = store.send({
      nonce: "direct-task",
      conversationId: a.conversationId,
      text: "直接消息"
    })
    expect(store.claim("host")!.run.id).toBe(direct.runIds[0])
  })

  it("retains memory tombstones and refuses stale synthesis overwrites", () => {
    const store = open(),
      { bot } = create(store)
    const memory = store.saveMemory({ botId: bot.id, text: "偏好 A" })
    store.deleteMemory(bot.id, memory.id, memory.revision)
    expect(() =>
      store.saveMemory({ botId: bot.id, id: memory.id, revision: memory.revision, text: "旧事实" })
    ).toThrow("修改或删除")
    expect(store.memories(bot.id)).toEqual([])
  })

  it("creates immutable skill versions and never claims an edited skill was validated", () => {
    const store = open(),
      { bot } = create(store)
    const first = store.saveSkill({
      botId: bot.id,
      name: "检查",
      instructions: "检查数据",
      enabled: true
    })
    const second = store.saveSkill({ ...first, instructions: "检查新数据" })
    expect(second.version).toBe(2)
    expect(second.verified).toBe(false)
    expect(() => store.saveSkill({ ...first, instructions: "旧编辑" })).toThrow("版本已改变")
  })

  it("atomically coalesces missed routine occurrences, without duplicate runs or immediate replay", () => {
    const store = open(),
      { bot } = create(store)
    store.saveRoutine({
      botId: bot.id,
      name: "巡检",
      prompt: "检查",
      enabled: true,
      timezone: "Asia/Shanghai",
      schedule: { kind: "interval", anchor: now, everyMs: 60_000 }
    })
    now += 600_000
    expect(store.dispatchDueRoutines()).toHaveLength(1)
    expect(store.dispatchDueRoutines()).toEqual([])
    expect(store.routines(bot.id)[0].nextAt).toBe(now + 60_000)
  })

  it("hiding does not stop work; deleting an idle Bot stops future routines and queued work", () => {
    const store = open(),
      { bot, conversationId } = create(store)
    store.send({ nonce: "queued", conversationId, text: "工作" })
    const hidden = store.updateBot({ id: bot.id, revision: bot.revision, hidden: true })
    expect(store.snapshot().runs[0].status).toBe("queued")
    store.deleteBot(bot.id, hidden.revision)
    expect(store.claim("host")).toBeNull()
    expect(store.snapshot().bots).toEqual([])
  })
})

it("validates connector grants, preserves them on unrelated updates, and prevents authority changes mid-run", () => {
  const store = new BotStore(":memory:")
  try {
    expect(() =>
      store.createBot({ nonce: "invalid", name: "Test", connectorIds: ["one", "one"] })
    ).toThrow("不能重复")
    const { bot, conversationId } = store.createBot({
      nonce: "grant",
      name: "Test",
      connectorIds: ["plugin:docs/server", "one"]
    })
    expect(bot.connectorIds).toEqual(["one", "plugin:docs/server"])
    const changed = store.updateBot({ id: bot.id, revision: bot.revision, pinned: true })
    expect(changed.connectorIds).toEqual(bot.connectorIds)
    store.send({ nonce: "work", conversationId, text: "Work" })
    store.claim("host")
    expect(() =>
      store.updateBot({ id: bot.id, revision: changed.revision, connectorIds: [] })
    ).toThrow("连接器")
    expect(store.getBot(bot.id).connectorIds).toEqual(bot.connectorIds)
  } finally {
    store.close()
  }
})
