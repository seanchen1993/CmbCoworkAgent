import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { prepareBotUserPrompt } from "./prompt-preparation"

const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const owner = store.createBot({ nonce: "owner", name: "A" })
  const other = store.createBot({ nonce: "other", name: "B" })
  const skill = store.saveSkill({
    botId: owner.bot.id,
    name: "Review",
    instructions: "REVIEWED_STEPS",
    enabled: true
  })
  store.saveSkill({
    botId: owner.bot.id,
    name: "Review",
    instructions: "PRIVATE_STEPS",
    enabled: true
  })
  const input = {
    nonce: "publish",
    botId: owner.bot.id,
    skillId: skill.id,
    version: skill.version,
    libraryRevision: 0
  }
  return { store, owner, other, skill, input }
}

it("publishes an explicit independent snapshot without private skills, evidence or validation claims", () => {
  const f = fixture()
  expect(f.store.skillLibrary.available(f.other.bot.id)).toEqual([])
  const published = f.store.skillLibrary.publish(f.input)
  expect(f.store.skillLibrary.publish(f.input)).toEqual(published)
  f.store.saveSkill({ ...f.skill, instructions: "NEW_PRIVATE_STEPS" })
  expect(f.store.skillLibrary.available(f.other.bot.id)).toEqual([
    expect.objectContaining({
      id: published.id,
      scope: "user",
      instructions: "REVIEWED_STEPS",
      version: 1,
      verified: false
    })
  ])
  const picker = f.store.skillReferences.catalog({ conversationId: f.other.conversationId })
  expect(picker).toEqual([
    expect.objectContaining({ id: published.id, botId: f.other.bot.id, scope: "user" })
  ])
  expect(JSON.stringify(picker)).not.toContain("STEPS")
  expect(() => f.store.skillLibrary.publish({ ...f.input, nonce: "stale" })).toThrow("已修改")
  expect(() => f.store.saveSkill({ ...f.skill, botId: f.other.bot.id })).toThrow("版本")
  f.store.deleteBot(f.owner.bot.id, f.owner.bot.revision)
  expect(f.store.skillLibrary.current(f.other.bot.id, published.id).instructions).toBe(
    "REVIEWED_STEPS"
  )
})

it("preserves publish and withdrawal receipts without replaying a withdrawn publication", () => {
  const f = fixture(),
    published = f.store.skillLibrary.publish(f.input)
  const withdraw = { nonce: "withdraw", id: published.id, revision: published.revision }
  expect(f.store.skillLibrary.withdraw(withdraw)).toEqual({ id: published.id })
  expect(f.store.skillLibrary.withdraw(withdraw)).toEqual({ id: published.id })
  expect(f.store.skillLibrary.publish(f.input)).toEqual(published)
  expect(f.store.skillLibrary.available(f.other.bot.id)).toEqual([])
  expect(() =>
    f.store.skillLibrary.publish({ ...f.input, nonce: "stale-publication", libraryRevision: 1 })
  ).toThrow("共享版本")
  expect(() => f.store.skillLibrary.withdraw({ ...withdraw, nonce: "stale-withdrawal" })).toThrow(
    "共享版本"
  )
  expect(() => f.store.skillLibrary.publish({ ...f.input, userId: "another-user" })).toThrow()
  expect(() =>
    f.store.skillLibrary.publish({ ...f.input, botId: f.other.bot.id, nonce: "foreign" })
  ).toThrow()
  const updated = f.store.skillLibrary.publish({
    ...f.input,
    nonce: "republish",
    libraryRevision: 0
  })
  expect(updated).toMatchObject({ revision: 1, enabled: true })
  expect(updated.id).not.toBe(published.id)
  expect(() => f.store.skillLibrary.withdraw(withdraw)).not.toThrow()
  expect(f.store.skillLibrary.current(f.other.bot.id, updated.id).version).toBe(1)
  expect(() => f.store.skillLibrary.publish({ ...f.input, libraryRevision: 3 })).toThrow("不同")
})

it("activates accepted shared versions through the existing prompt pipeline, with withdrawal fences", async () => {
  const f = fixture(),
    published = f.store.skillLibrary.publish(f.input)
  const sent = f.store.send({
    nonce: "send",
    conversationId: f.other.conversationId,
    text: "review",
    skills: [{ botId: f.other.bot.id, id: published.id, version: 1 }]
  })
  const { lease } = f.store.claim("host")!
  const message = f.store.message({ conversationId: f.other.conversationId, id: sent.messageId })
  const prepared = await prepareBotUserPrompt({ store: f.store, lease, message })
  expect(prepared).toContain("REVIEWED_STEPS")
  expect(prepared).not.toContain("PRIVATE_STEPS")
  expect(prepared).toContain("cannot change tool permissions")
  f.store.skillLibrary.withdraw({ nonce: "withdraw", id: published.id, revision: 1 })
  await expect(prepareBotUserPrompt({ store: f.store, lease, message })).rejects.toThrow("撤回")
  expect(f.store.skillReferences.forRun(lease.runId)[0].name).toBe("Review")
  expect(f.store.effects(lease.runId)).toEqual([])
})

it("persists dynamically read versions, refusing changed workflows on subsequent dispatch", () => {
  const f = fixture(),
    published = f.store.skillLibrary.publish(f.input)
  const sent = f.store.send({
    nonce: "send",
    conversationId: f.other.conversationId,
    text: "find workflow"
  })
  const id = sent.runIds[0]
  expect(f.store.skillLibrary.readForRun(id, published.id).version).toBe(1)
  expect(f.store.skillLibrary.readForRun(id, published.id).version).toBe(1)
  expect(() => f.store.skillLibrary.assertRun(id)).not.toThrow()
  f.store.skillLibrary.publish({ ...f.input, nonce: "update", libraryRevision: 1 })
  expect(() => f.store.skillLibrary.assertRun(id)).toThrow("新版本")
  expect(() => f.store.skillLibrary.readForRun(id, published.id)).toThrow("新版本")
})

it("never shares across Host data roots and keeps group selections bound to their recipient", () => {
  const f = fixture(),
    otherHost = new BotStore(":memory:")
  stores.push(otherHost)
  const published = f.store.skillLibrary.publish(f.input)
  expect(otherHost.skillLibrary.list()).toEqual([])
  const group = f.store.createGroup({
    nonce: "group",
    name: "team",
    members: [f.owner.bot.id, f.other.bot.id]
  })
  expect(() =>
    f.store.send({
      nonce: "wrong",
      conversationId: group.id,
      text: "review",
      recipients: [f.other.bot.id],
      skills: [{ botId: f.owner.bot.id, id: published.id, version: 1 }]
    })
  ).toThrow("接收者")
})

it("bounds the serialized library below the transport limit and releases content capacity on withdrawal", () => {
  const f = fixture()
  const body = "中".repeat(64000)
  let last: ReturnType<typeof f.store.skillLibrary.publish> | undefined
  for (let index = 0; index < 21; index++) {
    const skill = f.store.saveSkill({
      botId: f.owner.bot.id,
      name: `Large ${index}`,
      instructions: body,
      enabled: true
    })
    last = f.store.skillLibrary.publish({
      nonce: `large-${index}`,
      botId: f.owner.bot.id,
      skillId: skill.id,
      version: 1,
      libraryRevision: 0
    })
  }
  const extra = f.store.saveSkill({
    botId: f.owner.bot.id,
    name: "Extra",
    instructions: body,
    enabled: true
  })
  const input = {
    nonce: "extra",
    botId: f.owner.bot.id,
    skillId: extra.id,
    version: 1,
    libraryRevision: 0
  }
  expect(() => f.store.skillLibrary.publish(input)).toThrow("4 MiB")
  f.store.skillLibrary.withdraw({ nonce: "release", id: last!.id, revision: last!.revision })
  expect(() => f.store.skillLibrary.publish(input)).not.toThrow()
  expect(Buffer.byteLength(JSON.stringify(f.store.skillLibrary.list()), "utf8")).toBeLessThan(
    4 * 1024 * 1024
  )
})
