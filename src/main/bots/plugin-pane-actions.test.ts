import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import type { BotPluginPaneAction } from "../../shared/bot-plugin-panes"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({
    nonce: "create",
    name: "Pane owner",
    instructions: "Help"
  })
  const opening = store.send({ nonce: "opening", conversationId, text: "/plugin board" })
  const claim = store.claim("host")!
  store.finish(claim.lease, "succeeded", "已打开面板")
  const input: BotPluginPaneAction = {
    botId: bot.id,
    conversationId,
    sessionId: randomUUID(),
    target: "pane",
    action: {
      pane: "plugin:board",
      generation: randomUUID(),
      plugin: "plugin",
      handle: 1,
      kind: "press",
      intentId: randomUUID()
    }
  }
  const submit = (value = input, origin = () => opening.messageId) =>
    store.pluginPaneActions.submit(value, origin)
  return { store, bot, conversationId, opening, input, submit }
}

it("queues a UI intent once without synthesizing a chat message or authorizing its external effects", () => {
  const f = fixture()
  const count = f.store.messages(f.conversationId).length
  const result = f.submit()
  expect(
    f.submit({
      ...f.input,
      threadRootId: undefined,
      action: { ...f.input.action, value: undefined }
    })
  ).toEqual(result)
  expect(
    f.submit(f.input, () => {
      throw Error("expired session")
    })
  ).toEqual(result)
  expect(f.store.messages(f.conversationId)).toHaveLength(count)
  const claimed = f.store.claim("host")!
  expect(claimed.run.id).toBe(result.runIds[0])
  expect(f.store.pluginPaneActions.read(claimed.run.id)).toEqual(f.input)
  f.store.pluginPaneActions.start(claimed.lease, f.input)
  expect(() =>
    f.store.beginEffect(claimed.lease, {
      id: "external",
      approvalId: "missing",
      action: { shell: { command: "write" } }
    })
  ).toThrow()
  f.store.finish(claimed.lease, "succeeded", "done")
  expect(f.store.messages(f.conversationId)).toHaveLength(count)
  expect(() => f.submit({ ...f.input, action: { ...f.input.action, value: "different" } })).toThrow(
    "同一请求标识"
  )
})

it("validates the Bot, conversation, branch and exact opening message before accepting an intent", () => {
  const f = fixture()
  const other = f.store.createBot({ nonce: "other", name: "Other", instructions: "Help" })
  const extra = () => ({ ...f.input, action: { ...f.input.action, intentId: randomUUID() } })
  expect(() => f.submit({ ...extra(), botId: other.bot.id })).toThrow("不属于当前对话")
  expect(() => f.submit({ ...extra(), conversationId: other.conversationId })).toThrow(
    "不属于当前对话"
  )
  expect(() => f.submit(extra(), () => "missing-message")).toThrow()
  expect(() => f.submit({ ...extra(), threadRootId: f.opening.messageId })).toThrow(
    "不属于当前讨论"
  )
  expect(() =>
    f.store.pluginPaneActions.submit({ ...f.input, approved: true }, () => f.opening.messageId)
  ).toThrow()
  expect(f.store.db.exec("SELECT count(*) FROM bot_runs")[0]?.values[0]?.[0]).toBe(1)
})

it("does not start an interrupted callback twice, even under a fresh lease", () => {
  const f = fixture()
  const receipt = f.submit()
  const first = f.store.claim("host")!
  f.store.pluginPaneActions.start(first.lease, f.input)
  f.store.fenceOwner("host", "test interruption")
  const interrupted = f.store.getRun(receipt.runIds[0])
  expect(interrupted.status).toBe("needs_review")
  expect(() => f.store.pluginPaneActions.start(first.lease, f.input)).toThrow()
  // The started marker is durable and cannot be supplied or erased by the caller.
  const marker = f.store.db.exec("SELECT response FROM bot_receipts WHERE nonce=?", [
    `tool:${first.run.id}:plugin-pane:started`
  ])[0]?.values[0]?.[0]
  expect(marker).toBe("true")
  expect(f.submit()).toEqual(receipt)
  f.store.recover({
    id: interrupted.id,
    revision: interrupted.revision,
    decision: "resume",
    note: "Reviewed the interrupted gesture",
    effects: []
  })
  const next = f.store.claim("new-host")!
  expect(next.lease.fence).toBeGreaterThan(first.lease.fence)
  expect(() => f.store.pluginPaneActions.start(next.lease, f.input)).toThrow("结果未确认")
})

it("bounds pending pane work and rolls back rejected requests", () => {
  const f = fixture()
  for (let i = 0; i < 32; i++)
    f.submit({ ...f.input, action: { ...f.input.action, intentId: randomUUID() } })
  const value = { ...f.input, action: { ...f.input.action, intentId: randomUUID() } }
  expect(() => f.submit(value)).toThrow("面板操作较多")
  expect(f.store.db.exec("SELECT count(*) FROM bot_plugin_pane_actions")[0]?.values[0]?.[0]).toBe(
    32
  )
})
