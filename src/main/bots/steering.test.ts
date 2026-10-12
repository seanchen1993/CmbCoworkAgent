import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import type { BotRunLease } from "../../shared/bot-types"
import { BotSteeringInterrupt } from "./steering"
import { BOT_SESSION_END_KEY, BOT_STOP_FAILURE_KEY } from "./skill-hook-state"

const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "A" })
  const sent = store.send({ nonce: "task", conversationId, text: "原任务" })
  const { lease } = store.claim("host")!
  const send = (text = "新要求", nonce = "steer") =>
    store.send({ nonce, conversationId, text, steerRunId: sent.runIds[0] })
  return { store, bot, conversationId, sent, lease, send }
}
function take(store: BotStore, lease: BotRunLease, appliedIds: string[] = []) {
  return store.steering.queue(lease).take({
    threadId: lease.runId,
    ownerRunToken: `${lease.owner}:${lease.fence}`,
    appliedIds,
    phase: "beforeModel"
  })
}

it("queues explicit plugin commands separately and never edits a running command through steering", () => {
  const f = fixture()
  const command = f.send("/plugin notes argument")
  expect(command.runIds[0]).not.toBe(f.lease.runId)
  expect(f.store.getRun(command.runIds[0]).source).toBe("plugin-command")
  expect(f.store.steering.hasPending(f.lease.runId)).toBe(false)
  f.store.finish(f.lease, "succeeded", "done")
  const next = f.store.claim("host")!
  const followup = f.store.send({
    nonce: "follow-up",
    conversationId: f.conversationId,
    text: "下一件事",
    steerRunId: next.run.id
  })
  expect(followup.runIds[0]).not.toBe(next.run.id)
  expect(f.store.steering.hasPending(next.run.id)).toBe(false)
})

it.each([BOT_SESSION_END_KEY, BOT_STOP_FAILURE_KEY])(
  "routes new instructions to their own task after a durable terminal phase (%s)",
  (key) => {
    const f = fixture()
    f.store.toolOnce(f.lease, key, { event: "terminal" }, () => true)
    const sent = f.send()
    expect(sent.runIds).toHaveLength(1)
    expect(sent.runIds[0]).not.toBe(f.lease.runId)
    expect(f.store.getRun(sent.runIds[0])).toMatchObject({
      status: "queued",
      messageId: sent.messageId
    })
    expect(f.store.steering.hasPending(f.lease.runId)).toBe(false)
    expect(f.send()).toEqual(sent)
    expect(f.store.claim("another")).toBeNull()
  }
)

it("durably attaches once, redelivers a crash before checkpoint, and respects the compacted graph marker", async () => {
  const f = fixture()
  const sent = f.send()
  expect(f.send()).toEqual(sent)
  expect(sent.runIds).toEqual(f.sent.runIds)
  expect(f.store.steering.state(sent.messageId)?.state).toBe("pending")
  expect(f.store.snapshot().runs).toHaveLength(1)
  const first = await take(f.store, f.lease)
  expect(first.map((message) => message.id)).toEqual([sent.messageId])
  expect(f.store.steering.state(sent.messageId)?.state).toBe("accepted")
  expect((await take(f.store, f.lease)).map((message) => message.id)).toEqual([sent.messageId])
  expect(await take(f.store, f.lease, [sent.messageId])).toEqual([])
  f.store.fenceOwner(f.lease.owner, "test crash")
  await expect(take(f.store, f.lease)).rejects.toThrow("执行权")
  f.store.recover({
    id: f.lease.runId,
    revision: f.store.getRun(f.lease.runId).revision,
    decision: "resume",
    note: "已核对，无外部操作",
    effects: []
  })
  const next = f.store.claim("replacement")!
  expect((await take(f.store, next.lease)).map((message) => message.id)).toEqual([sent.messageId])
  expect(await take(f.store, next.lease, [sent.messageId])).toEqual([])
})

it("revokes pending approvals at a safe boundary and rejects approved-but-unstarted actions", async () => {
  const f = fixture()
  const action = { tool: "submit", value: 1 }
  const card = f.store.requestInteraction(f.lease, { kind: "approval", prompt: "提交", action })
  f.send()
  expect(() => f.store.steering.interruptIfPending(f.lease)).toThrow(BotSteeringInterrupt)
  expect(f.store.getInteraction(card.id).status).toBe("cancelled")
  expect(f.store.getRun(f.lease.runId).status).toBe("running")
  expect(() =>
    f.store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
  ).toThrow()
  await take(f.store, f.lease)
  const next = f.store.requestInteraction(f.lease, { kind: "approval", prompt: "再次提交", action })
  f.store.answerInteraction({ id: next.id, revision: next.revision, answer: "approve" })
  f.send("更改要求", "second")
  expect(() =>
    f.store.beginEffect(f.lease, { id: "not-started", approvalId: next.id, action })
  ).toThrow(BotSteeringInterrupt)
  expect(f.store.effects(f.lease.runId)).toEqual([])
})

it("lets a started effect settle, then consumes the instruction without replaying the action", async () => {
  const f = fixture()
  const action = { tool: "submit" }
  const card = f.store.requestInteraction(f.lease, { kind: "approval", prompt: "提交", action })
  f.store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
  f.store.beginEffect(f.lease, { id: "started", approvalId: card.id, action })
  f.send()
  f.store.settleEffect(f.lease, "started", "succeeded", "外部回执")
  await take(f.store, f.lease)
  f.store.finish(f.lease, "succeeded", "已按新要求完成")
  expect(f.store.effects(f.lease.runId)).toMatchObject([
    { id: "started", status: "succeeded", result: "外部回执" }
  ])
  expect(f.store.claim("next")).toBeNull()
})

it("queues late final arrivals and visibly leaves cancelled instructions unapplied", async () => {
  const f = fixture()
  const late = f.send()
  f.store.finish(f.lease, "succeeded", "刚完成")
  const next = f.store.claim("next")!
  expect(next.run.messageId).toBe(late.messageId)
  expect(f.store.steering.state(late.messageId)).toEqual({ runId: next.run.id, state: "queued" })
  const pending = f.store.send({
    nonce: "new",
    conversationId: f.conversationId,
    text: "第三要求",
    steerRunId: next.run.id
  })
  f.store.cancel(next.run.id)
  f.store.finish(next.lease, "cancelled", "用户停止")
  expect(f.store.steering.state(pending.messageId)?.state).toBe("not_applied")
  expect(f.store.claim("next")).toBeNull()
})

it("rejects cross-conversation and cross-branch steering atomically; settled targets fall back to queued work", () => {
  const f = fixture()
  const other = f.store.createBot({ nonce: "other", name: "B" })
  expect(() =>
    f.store.send({
      nonce: "bad",
      conversationId: other.conversationId,
      text: "wrong",
      steerRunId: f.lease.runId
    })
  ).toThrow("当前私聊")
  expect(f.store.messages(other.conversationId)).toEqual([])
  expect(() =>
    f.store.send({
      nonce: "branch",
      conversationId: f.conversationId,
      threadRootId: f.sent.messageId,
      text: "wrong branch",
      steerRunId: f.lease.runId
    })
  ).toThrow("当前私聊")
  f.store.finish(f.lease, "succeeded", "done")
  const sent = f.send()
  expect(sent.runIds).not.toEqual(f.sent.runIds)
  expect(f.store.claim("next")!.run.messageId).toBe(sent.messageId)
})
