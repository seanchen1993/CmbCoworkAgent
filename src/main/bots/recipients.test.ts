import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bots = ["同名", "同名", "检查"].map(
    (name, index) => store.createBot({ nonce: `bot-${index}`, name }).bot
  )
  const group = store.createGroup({
    nonce: "group",
    name: "研发",
    members: bots.map((bot) => bot.id)
  })
  return { store, bots, group }
}

it("routes exact selected identities, retains send-time names and reuses the receipt after rename/removal", () => {
  const { store, bots, group } = fixture()
  const input = {
    nonce: "send",
    conversationId: group.id,
    recipients: [bots[1].id],
    text: "请检查"
  }
  const receipt = store.send(input)
  expect(store.getRun(receipt.runIds[0]).botId).toBe(bots[1].id)
  expect(
    store.message({ conversationId: group.id, id: receipt.messageId }).recipientReferences
  ).toEqual([{ botId: bots[1].id, name: "同名" }])
  store.updateBot({ id: bots[1].id, revision: bots[1].revision, name: "新名称" })
  store.updateGroup({
    id: group.id,
    revision: group.revision,
    name: group.name,
    description: "",
    members: [bots[0].id, bots[2].id]
  })
  expect(store.send(input)).toEqual(receipt)
  expect(store.messages(group.id)[0].recipientReferences?.[0].name).toBe("同名")
  expect(() => store.send({ ...input, recipients: [bots[0].id] })).toThrow("不同")
  expect(() => store.send({ ...input, nonce: "new" })).toThrow("重新选择")
  expect(store.messages(group.id)).toHaveLength(1)
})

it("does not let text names narrow an explicit multi-member selection or summon an unselected peer", () => {
  const { store, bots, group } = fixture()
  const selected = [bots[0].id, bots[2].id]
  store.send({
    nonce: "send",
    conversationId: group.id,
    recipients: selected,
    text: "引用原话：@检查 请帮忙"
  })
  const visited: string[] = []
  for (;;) {
    const claim = store.claim("host")
    if (!claim) break
    visited.push(claim.run.botId)
    store.toolOnce(claim.lease, "pass", {}, () => store.groups.post(claim.lease, "(pass)"))
    store.finish(claim.lease, "succeeded", "private")
    store.advanceGroups()
  }
  expect(visited).toEqual(selected)
})

it("rejects foreign, deleted and duplicate recipients before committing a message or cancelling existing work", () => {
  const { store, bots, group } = fixture()
  const outsider = store.createBot({ nonce: "outsider", name: "外部" }).bot
  const active = store.send({ nonce: "existing", conversationId: group.id, text: "原任务" })
  const claim = store.claim("host")!
  const input = { nonce: "bad", conversationId: group.id, text: "不要提交" }
  expect(() => store.send({ ...input, recipients: [outsider.id] })).toThrow("重新选择")
  expect(() => store.send({ ...input, recipients: [bots[1].id, bots[1].id] })).toThrow("重复")
  expect(store.getRun(active.runIds[0]).status).toBe("running")
  store.finish(claim.lease, "succeeded", "ok")
  store.deleteBot(bots[1].id, bots[1].revision)
  expect(() => store.send({ ...input, recipients: [bots[1].id] })).toThrow("重新选择")
  expect(store.messages(group.id).some((message) => message.text === input.text)).toBe(false)
})
