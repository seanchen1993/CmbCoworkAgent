import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import type {
  BotRunHistoryRequest,
  BotInteractionDetailRequest
} from "../../shared/bot-run-history"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
function fixture() {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "create", name: "项目助手" })
  const receipt = store.send({ nonce: "send", conversationId, text: "检查项目" })
  const { run, lease } = store.claim("host")!
  return {
    store,
    bot,
    conversationId,
    run,
    lease,
    address: { conversationId, runId: receipt.runIds[0] }
  }
}

it("retains settled failure diagnostics in one indexed run read and keeps legacy records readable", () => {
  const f = fixture()
  const diagnostic = {
    code: "rate_limit",
    status: 429,
    requestId: "history-provider",
    callId: "history-call"
  }
  f.store.finish(f.lease, "failed", "rejected", diagnostic)
  expect(f.store.runHistory(f.address).run.diagnostic).toEqual(diagnostic)
  const plan = f.store.db.exec(
    "EXPLAIN QUERY PLAN SELECT substr(payload,1,4096) AS payload FROM bot_events WHERE entity_id=? AND kind='run.settled' ORDER BY cursor DESC LIMIT 1",
    [f.run.id]
  )
  expect(JSON.stringify(plan)).toContain("bot_event_entity_kind")
  f.store.db.run("UPDATE bot_events SET payload=? WHERE entity_id=? AND kind='run.settled'", [
    JSON.stringify({ status: "failed" }),
    f.run.id
  ])
  expect(f.store.runHistory(f.address).run.diagnostic).toBeUndefined()
  f.store.db.run("UPDATE bot_events SET payload=? WHERE entity_id=? AND kind='run.settled'", [
    JSON.stringify({
      status: "failed",
      diagnostic: { ...diagnostic, requestId: "https://unsafe.invalid/key" }
    }),
    f.run.id
  ])
  expect(f.store.runHistory(f.address).run.diagnostic).toBeUndefined()
})

it("pages durable execution events without streaming/checkpoint noise or unrelated private data", () => {
  const f = fixture()
  for (let n = 0; n < 85; n++) {
    f.store.activity(f.lease, `检查步骤 ${n}`, "file")
    f.store.streamOutput(f.lease, `MODEL_INTERNAL_OUTPUT_${n}`)
  }
  const other = f.store.createBot({ nonce: "other", name: "其他项目" })
  f.store.send({
    nonce: "other-task",
    conversationId: other.conversationId,
    text: "PRIVATE_OTHER_TASK"
  })
  const first = f.store.runHistory({ ...f.address, limit: 15 })
  expect(first.run).not.toHaveProperty("checkpoint")
  expect(first.run).not.toHaveProperty("leaseOwner")
  f.store.activity(f.lease, "刚产生的新进展")
  const ids = first.items.map((item) => item.cursor)
  let before = first.nextBefore
  while (before) {
    const page = f.store.runHistory({ ...f.address, before, limit: 15 })
    ids.push(...page.items.map((item) => item.cursor))
    expect(JSON.stringify(page)).not.toMatch(/MODEL_INTERNAL_OUTPUT|PRIVATE_OTHER_TASK/)
    before = page.nextBefore
  }
  expect(ids).toHaveLength(87) // queued + started + 85 activities
  expect(new Set(ids).size).toBe(ids.length)
  expect(f.store.runHistory(f.address).items[0].label).toBe("刚产生的新进展")
  const foreign = f.store
    .events(0, 1000)
    .find((event) => event.kind === "run.queued" && event.entityId !== f.run.id)!
  expect(() => f.store.runHistory({ ...f.address, before: foreign.cursor })).toThrow("记录位置")
  expect(() => f.store.runHistory({ ...f.address, conversationId: other.conversationId })).toThrow(
    "当前对话"
  )
  expect(() => f.store.runHistory({ ...f.address, threadRootId: "foreign" })).toThrow("分支")
  expect(() => f.store.runHistory({ ...f.address, limit: 51 })).toThrow()
  expect(() => f.store.runHistory(null as unknown as BotRunHistoryRequest)).toThrow()
})

it("binds an effect to the exact consumed approval, reads result tails, and keeps questions out of summaries", () => {
  const f = fixture()
  const action = {
    connector: { provider: "检查系统", tool: "append_note", arguments: { text: "审批内容" } }
  }
  const rejected = f.store.requestInteraction(f.lease, {
    kind: "approval",
    action,
    prompt: "Rejected earlier description"
  })
  f.store.answerInteraction({ id: rejected.id, revision: rejected.revision, answer: "reject" })
  const approved = f.store.requestInteraction(f.lease, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action)
  })
  f.store.answerInteraction({ id: approved.id, revision: approved.revision, answer: "approve" })
  f.store.beginEffect(f.lease, { id: "effect", action, approvalId: approved.id })
  const text = "😀".repeat(8010) + "RESULT_TAIL"
  f.store.settleEffect(f.lease, "effect", "succeeded", text)
  const first = f.store.effectDetail({ ...f.address, effectId: "effect" })
  expect(first.approval).toMatchObject({ id: approved.id, prompt: JSON.stringify(action) })
  expect(first.nextOffset).toBe(8000)
  const tail = f.store.effectDetail({ ...f.address, effectId: "effect", offset: first.nextOffset! })
  expect(first.effect.result! + tail.effect.result!).toBe(text)
  expect(tail.nextOffset).toBeNull()
  expect(() => f.store.effectDetail({ ...f.address, effectId: "other" })).toThrow("不属于")
  const question = f.store.requestInteraction(f.lease, {
    kind: "question",
    prompt: "PRIVATE_QUESTION_CONTENT"
  })
  f.store.answerInteraction({
    id: question.id,
    revision: question.revision,
    answer: "PRIVATE_ANSWER"
  })
  const history = f.store.runHistory(f.address)
  expect(JSON.stringify(history)).not.toMatch(/PRIVATE_|审批内容|Rejected earlier/)
  expect(history.items.filter((item) => item.effectId === "effect")).toHaveLength(2)
  expect(history.items.map((item) => item.label)).toContain("操作：已完成")
})

it("keeps rejected requests readable and binds approved requests to their exact effects", () => {
  const f = fixture()
  const action = { shell: { command: "node test.cjs", cwd: "project" } }
  const rejected = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: JSON.stringify(action),
    action
  })
  f.store.answerInteraction({ id: rejected.id, revision: rejected.revision, answer: "reject" })
  expect(f.store.interactionDetail({ ...f.address, interactionId: rejected.id })).toMatchObject({
    interaction: { status: "answered", answer: "reject", prompt: JSON.stringify(action) },
    effects: []
  })
  const approved = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: JSON.stringify(action),
    action
  })
  f.store.answerInteraction({ id: approved.id, revision: approved.revision, answer: "approve" })
  f.store.beginEffect(f.lease, { id: "linked", action, approvalId: approved.id })
  const detail = f.store.interactionDetail({ ...f.address, interactionId: approved.id })
  expect(detail.effects).toEqual([{ id: "linked", status: "started" }])
  expect(detail.interaction).not.toHaveProperty("actionHash")
  expect(detail.interaction.revision).toBe(approved.revision + 1)
  f.store.db.run("UPDATE bot_effects SET action_hash='mismatched-legacy-action' WHERE id='linked'")
  expect(f.store.interactionDetail({ ...f.address, interactionId: approved.id }).effects).toEqual(
    []
  )
  expect(
    f.store.runHistory(f.address).items.filter((item) => item.interactionId === approved.id)
  ).toHaveLength(2)
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  const sent = f.store.send({
    nonce: "other-send",
    conversationId: other.conversationId,
    text: "other"
  })
  expect(() =>
    f.store.interactionDetail({
      conversationId: other.conversationId,
      runId: sent.runIds[0],
      interactionId: approved.id
    })
  ).toThrow("当前任务")
  expect(() =>
    f.store.interactionDetail({ ...f.address, threadRootId: "foreign", interactionId: approved.id })
  ).toThrow("分支")
  expect(() => f.store.interactionDetail(null as unknown as BotInteractionDetailRequest)).toThrow()
  expect(() => f.store.interactionDetail({ ...f.address, interactionId: "../other" })).toThrow(
    "标识"
  )
})

it("returns historical question replies but removes secure-input tokens and never treats permission as an effect", () => {
  const f = fixture()
  const question = f.store.requestInteraction(f.lease, { kind: "question", prompt: "目标分支？" })
  f.store.answerInteraction({ id: question.id, revision: question.revision, answer: "release/v2" })
  expect(f.store.interactionDetail({ ...f.address, interactionId: question.id })).toMatchObject({
    interaction: { prompt: "目标分支？", answer: "release/v2" },
    secret: null,
    effects: []
  })
  const token = "11000000-0000-4000-8000-000000000001"
  const prompt = JSON.stringify({
    secretRequest: {
      version: 1,
      label: "测试登录",
      description: "完成授权登录",
      botId: f.bot.id,
      token,
      origin: "https://example.test",
      path: "/signin",
      field: "Password"
    }
  })
  const secret = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt,
    action: { token }
  })
  f.store.answerInteraction({ id: secret.id, revision: secret.revision, answer: "reject" })
  const detail = f.store.interactionDetail({ ...f.address, interactionId: secret.id })
  expect(detail).toMatchObject({
    interaction: { answer: "reject", prompt: "完成授权登录" },
    secret: { label: "测试登录", origin: "https://example.test", field: "Password" },
    effects: []
  })
  expect(JSON.stringify(detail)).not.toContain(token)
})

it("upgrades v11 receipts without guessing historical approvals, and preserves new links across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "bot-run-history-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  let store = new BotStore(path)
  const { conversationId } = store.createBot({ nonce: "create", name: "A" })
  store.send({ nonce: "send", conversationId, text: "检查" })
  const { run, lease } = store.claim("host")!
  const action = { path: "report.txt" }
  const approval = store.requestInteraction(lease, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action)
  })
  store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  store.beginEffect(lease, { id: "old-effect", action, approvalId: approval.id })
  store.settleEffect(lease, "old-effect", "succeeded", "已保存")
  store.close()
  const previous = new DatabaseSync(path)
  previous.exec("DROP TABLE bot_effect_approvals; UPDATE bot_schema SET version=11")
  previous.close()
  store = new BotStore(path)
  expect(readdirSync(join(root, "backups")).some((name) => name.startsWith("bots-v11-"))).toBe(true)
  const address = { conversationId, runId: run.id }
  expect(store.effectDetail({ ...address, effectId: "old-effect" }).approval).toBeNull()
  const newAction = { path: "new-report.txt" }
  const approved = store.requestInteraction(lease, {
    kind: "approval",
    action: newAction,
    prompt: JSON.stringify(newAction)
  })
  store.answerInteraction({ id: approved.id, revision: approved.revision, answer: "approve" })
  store.beginEffect(lease, { id: "new-effect", action: newAction, approvalId: approved.id })
  store.close()
  store = new BotStore(path)
  cleanup.push(() => store.close())
  expect(store.effectDetail({ ...address, effectId: "new-effect" }).approval?.id).toBe(approved.id)
  expect(store.effectDetail({ ...address, effectId: "new-effect" }).effect.status).toBe("started")
  expect(store.effectDetail({ ...address, effectId: "old-effect" }).effect.result).toBe("已保存")
})
