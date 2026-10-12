import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "A" }),
    b = store.createBot({ nonce: "b", name: "B" })
  const first = store.saveSkill({
    botId: a.bot.id,
    name: "同名流程",
    instructions: "A private workflow",
    enabled: true
  })
  const second = store.saveSkill({
    botId: b.bot.id,
    name: "同名流程",
    instructions: "B private workflow",
    enabled: true
  })
  const selection = { botId: a.bot.id, id: first.id, version: first.version }
  return { store, a, b, first, second, selection }
}

it("scopes catalogs and selections by recipient, and never returns full instructions in the picker", () => {
  const f = fixture()
  const catalog = f.store.skillReferences.catalog({ conversationId: f.a.conversationId })
  expect(catalog.map((item) => item.id)).toEqual([f.first.id])
  expect(JSON.stringify(catalog)).not.toContain("private workflow")
  expect(() =>
    f.store.skillReferences.catalog({
      conversationId: f.a.conversationId,
      recipients: [f.b.bot.id]
    })
  ).toThrow("当前对话")
  expect(() =>
    f.store.send({
      nonce: "wrong",
      conversationId: f.b.conversationId,
      text: "运行",
      skills: [f.selection]
    })
  ).toThrow("接收者")
  expect(f.store.messages(f.b.conversationId)).toEqual([])
  expect(f.store.snapshot().runs).toEqual([])
})

it("persists accepted identities, deduplicates retries and preserves historical labels after a skill changes", () => {
  const f = fixture()
  const input = {
    nonce: "send",
    conversationId: f.a.conversationId,
    text: "运行",
    skills: [f.selection]
  }
  const receipt = f.store.send(input)
  f.store.saveSkill({ ...f.first, enabled: false, name: "已停用新名称" })
  expect(f.store.send(input)).toEqual(receipt)
  expect(f.store.skillReferences.forRun(receipt.runIds[0])).toEqual([
    { ...f.selection, name: "同名流程" }
  ])
  expect(f.store.messages(f.a.conversationId)[0].skillReferences).toEqual([
    { ...f.selection, name: "同名流程" }
  ])
  expect(() =>
    f.store.skillReferences.assertCurrent(f.store.skillReferences.forRun(receipt.runIds[0]))
  ).toThrow("停用")
  expect(f.store.skillReferences.catalog({ conversationId: f.a.conversationId })).toEqual([])
  expect(() => f.store.send({ ...input, nonce: "disabled" })).toThrow("停用")
  expect(f.store.messages(f.a.conversationId)).toHaveLength(1)
  expect(() => f.store.send({ ...input, skills: [] })).toThrow("不同")
})

it("does not reinterpret a stale version, accept duplicate selections, or give one group member another member's selected skills", () => {
  const f = fixture()
  f.store.saveSkill({ ...f.first, instructions: "new instructions" })
  expect(() =>
    f.store.send({
      nonce: "old",
      conversationId: f.a.conversationId,
      text: "运行",
      skills: [f.selection]
    })
  ).toThrow("新版本")
  expect(() =>
    f.store.send({
      nonce: "duplicates",
      conversationId: f.a.conversationId,
      text: "运行",
      skills: [f.selection, f.selection]
    })
  ).toThrow("重复")
  const group = f.store.createGroup({
    nonce: "group",
    name: "Team",
    members: [f.a.bot.id, f.b.bot.id]
  })
  const selection = { ...f.selection, version: 2 }
  const sent = f.store.send({
    nonce: "group-send",
    conversationId: group.id,
    text: "运行",
    recipients: [f.a.bot.id],
    skills: [selection]
  })
  expect(f.store.skillReferences.forRun(sent.runIds[0])).toEqual([
    { ...selection, name: f.first.name }
  ])
  expect(() =>
    f.store.send({
      nonce: "wrong-member",
      conversationId: group.id,
      text: "运行",
      recipients: [f.b.bot.id],
      skills: [selection]
    })
  ).toThrow("接收者")
})

it("retains the accepted skill for later room turns, fences revisions and leaves another member and a new request unbound", () => {
  const f = fixture()
  const group = f.store.createGroup({
    nonce: "rounds",
    name: "Team",
    members: [f.a.bot.id, f.b.bot.id]
  })
  const sent = f.store.send({
    nonce: "selected-cycle",
    conversationId: group.id,
    text: "@everyone Run and verify",
    skills: [f.selection]
  })
  const owner = f.store.claim("host")!
  expect(owner.run.botId).toBe(f.a.bot.id)
  f.store.toolOnce(owner.lease, "public", {}, () => f.store.groups.post(owner.lease, "RESULT"))
  f.store.finish(owner.lease, "succeeded", "")
  f.store.advanceGroups()
  const other = f.store.claim("host")!
  expect(f.store.skillReferences.forRun(other.run.id)).toEqual([])
  f.store.toolOnce(other.lease, "verify", {}, () => f.store.groups.post(other.lease, "VERIFIED"))
  f.store.finish(other.lease, "succeeded", "")
  f.store.advanceGroups()
  const rotated = f.store.claim("host")!
  f.store.groups.acceptFinalPass(rotated.lease, "(pass)")
  f.store.finish(rotated.lease, "succeeded", "")
  f.store.advanceGroups()
  const later = f.store.claim("host")!
  expect(later.run.botId).toBe(f.a.bot.id)
  expect(later.run.messageId).not.toBe(sent.messageId)
  expect(f.store.groups.assignmentMessageId(later.run.id)).toBe(sent.messageId)
  const selected = [{ ...f.selection, name: f.first.name }]
  expect(f.store.skillReferences.forRun(later.run.id)).toEqual(selected)
  f.store.saveSkill({ ...f.first, instructions: "Revised" })
  expect(f.store.skillReferences.forRun(later.run.id)).toEqual(selected)
  expect(() => f.store.skillReferences.assertCurrent(selected)).toThrow("新版本")
  f.store.finish(later.lease, "failed", "Accepted version changed")
  f.store.send({ nonce: "unbound-cycle", conversationId: group.id, text: "@A New task" })
  const next = f.store.claim("host")!
  expect(f.store.skillReferences.forRun(next.run.id)).toEqual([])
  expect(f.store.skillReferences.forRun(later.run.id)).toEqual(selected)
})
