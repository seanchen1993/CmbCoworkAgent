import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import type { BotWorkflowChildInput } from "./workflow-children"
import { guardBotRpcMutationEpoch } from "./rpc-mutation-epoch"
import { readBotUserForm, type BotUserForm } from "../../shared/bot-user-form"

const form: BotUserForm = {
  title: "项目发布信息",
  fields: [
    { id: "branch", label: "分支", type: "text", required: true },
    { id: "date", label: "日期", type: "date", required: true },
    { id: "count", label: "数量", type: "number", required: true },
    {
      id: "target",
      label: "环境",
      type: "select",
      required: true,
      options: [
        { value: "test", label: "测试环境" },
        { value: "prod", label: "生产环境" }
      ]
    },
    { id: "notes", label: "说明", type: "textarea" }
  ]
}
const values = { branch: " main ", date: "2028-02-29", count: "0", target: "test", notes: " " }
const stores: BotStore[] = [],
  folders: string[] = []
let now = 1_800_000_000_000
function fixture(path = ":memory:") {
  const store = new BotStore(path, () => now)
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "create", name: "研发助手" })
  store.send({ nonce: "send", conversationId, text: "准备发布" })
  const { run, lease } = store.claim("host", 60_000)!
  return { store, bot, conversationId, run, lease }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true })
  now = 1_800_000_000_000
})
it("validates original typed fields before SQL answer, canonical replay and one acknowledgement", () => {
  const f = fixture(),
    item = f.store.requestUserFormInteraction(f.lease, form)
  expect(readBotUserForm(item.prompt)).toMatchObject({
    version: 1,
    dataEpoch: "initial",
    input: form
  })
  const input = { id: item.id, revision: item.revision, expectedDataEpoch: "initial", answer: "" }
  for (const bad of [
    {},
    { ...values, date: "2026-02-30" },
    { ...values, count: "Infinity" },
    { ...values, target: "测试环境" },
    { ...values, surprise: "forged" }
  ])
    expect(() =>
      f.store.answerInteraction({
        ...input,
        answer: JSON.stringify({ status: "submitted", values: bad })
      })
    ).toThrow()
  expect(f.store.getInteraction(item.id).status).toBe("pending")
  expect(f.store.getRun(f.run.id).status).toBe("waiting_input")
  expect(f.store.messages(f.conversationId).filter((m) => m.runId === f.run.id)).toHaveLength(0)
  const answer = { ...input, answer: JSON.stringify({ status: "submitted", values }) },
    result = f.store.answerInteraction(answer)
  expect(JSON.parse(result.answer!)).toEqual({
    status: "submitted",
    values: {
      branch: "main",
      date: "2028-02-29",
      count: "0",
      target: "test"
    }
  })
  expect(f.store.answerInteraction(answer)).toEqual(result)
  expect(f.store.answerInteraction({ ...answer, answer: result.answer! })).toEqual(result)
  const messages = f.store.messages(f.conversationId).filter((m) => m.runId === f.run.id)
  expect(messages).toHaveLength(1)
  expect(messages[0].text).toContain("测试环境")
  expect(messages[0].replyTo).toBe(f.run.messageId)
  expect(() =>
    f.store.answerInteraction({ ...answer, answer: '{"status":"cancelled","values":{}}' })
  ).toThrow()
})
it("rejects raw question markers and invalid form definitions at creation, without granting Teach a new route", () => {
  const f = fixture()
  for (const prompt of [
    '{"botUserForm":{"version":1,"dataEpoch":"forged","input":{}}}',
    '{"botUserForm":'
  ])
    expect(() => f.store.requestInteraction(f.lease, { kind: "question", prompt })).toThrow()
  expect(() =>
    f.store.requestUserFormInteraction(f.lease, {
      ...form,
      fields: [
        {
          id: "password",
          type: "password",
          label: "密码"
        }
      ]
    } as unknown as BotUserForm)
  ).toThrow()
  expect(f.store.snapshot().interactions).toEqual([])
  expect(f.store.requestInteraction(f.lease, { kind: "question", prompt: "旧普通问题" }).kind).toBe(
    "question"
  )
})
it("cancelled ordinary forms contain no values or approval and retain their original question receipt", () => {
  const f = fixture(),
    item = f.store.requestUserFormInteraction(f.lease, form)
  const input = {
    id: item.id,
    revision: 1,
    expectedDataEpoch: "initial",
    answer: '{"status":"cancelled","values":{}}'
  }
  const receipt = f.store.answerInteraction(input)
  expect(receipt.kind).toBe("question")
  expect(receipt.actionHash).toBeNull()
  expect(JSON.parse(receipt.answer!)).toEqual({ status: "cancelled", values: {} })
  expect(f.store.effects(f.run.id)).toEqual([])
  expect(f.store.answerInteraction(input)).toEqual(receipt)
})
it.each(["cancel", "expire", "restart"])("does not admit an answer after original %s", (mode) => {
  const f = fixture(),
    item = f.store.requestUserFormInteraction(f.lease, form)
  if (mode === "cancel") f.store.cancel(f.run.id)
  if (mode === "expire") now += 3_600_001
  if (mode === "restart") f.store.recoverAbandonedAtStartup()
  expect(() =>
    f.store.answerInteraction({
      id: item.id,
      revision: item.revision,
      expectedDataEpoch: "initial",
      answer: '{"status":"cancelled","values":{}}'
    })
  ).toThrow()
  if (mode === "restart") {
    expect(f.store.getRun(f.run.id).status).toBe("needs_review")
    expect(f.store.getInteraction(item.id).status).toBe("expired")
  }
})
it("retains the accepted form receipt in SQLite but fences replay before the old success on data replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-form-receipt-"))
  folders.push(directory)
  const path = join(directory, "bots.sqlite"),
    f = fixture(path),
    item = f.store.requestUserFormInteraction(f.lease, form)
  const input = {
    id: item.id,
    revision: item.revision,
    expectedDataEpoch: "initial",
    answer: JSON.stringify({ status: "submitted", values })
  }
  const receipt = f.store.answerInteraction(input)
  f.store.close()
  const next = new BotStore(path, () => now)
  stores.push(next)
  expect(next.answerInteraction(input)).toEqual(receipt)
  next.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',?)",
    [now]
  )
  expect(() => next.answerInteraction(input)).toThrow("恢复")
  expect(() => next.answerInteraction({ ...input, expectedDataEpoch: "replacement" })).toThrow(
    "原表单"
  )
  expect(next.getInteraction(item.id).answer).toBe(receipt.answer)
})
it("requires the original form epoch without changing legacy questions, and fences an asynchronous ACK", async () => {
  const f = fixture(),
    item = f.store.requestUserFormInteraction(f.lease, form)
  expect(() =>
    f.store.answerInteraction({
      id: item.id,
      revision: 1,
      answer: '{"status":"cancelled","values":{}}'
    })
  ).toThrow("工作区")
  let epoch = "initial"
  await expect(
    guardBotRpcMutationEpoch(
      "answer",
      { expectedDataEpoch: "initial" },
      () => epoch,
      async () => {
        epoch = "replacement"
        return "old accepted answer"
      }
    )
  ).rejects.toMatchObject({ code: "data_epoch" })
  expect(
    await guardBotRpcMutationEpoch(
      "answer",
      {},
      () => "replacement",
      async () => "legacy"
    )
  ).toBe("legacy")
})
it("inherits both old question deny names for ordinary, browser and native task profiles", () => {
  for (const access of [{}, { browserAccess: "page" }, { desktopAccess: "shared-native" }])
    for (const denied of ["ask_user", "request_user_input", "request_user_form"])
      expect(
        botWorkflowChildAllows(
          { ...access, disallowedTools: [denied] } as BotWorkflowChildInput,
          "request_user_form"
        )
      ).toBe(false)
  expect(botWorkflowChildAllows({} as BotWorkflowChildInput, "request_user_form")).toBe(true)
})
