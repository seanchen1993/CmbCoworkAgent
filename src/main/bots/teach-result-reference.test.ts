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
  const created = store.createBot({ nonce: "bot", name: "Learner" })
  const teach = new BotTeachStore(store)
  let session = teach.create({
    botId: created.bot.id,
    conversationId: created.conversationId,
    nonce: "recording"
  })
  teach.addFrame(session.id, {
    at: 10,
    sha256: "a".repeat(64),
    size: 100,
    url: "https://example.test",
    title: "Recorded input"
  })
  session = teach.update(session.id, session.revision, "finalizing")
  session = teach.update(session.id, session.revision, "queued", {
    video: { size: 200, sha256: "b".repeat(64), mime: "video/webm" }
  })
  session = teach.queue(session.id)
  const claim = store.claim("learner")!
  teach.readFrames(session.id, claim.lease, [0])
  const skill = teach.saveLearned(session.id, claim.lease, "save", {
    name: "Recorded workflow",
    instructions: "Use the new inputs and verify the actual output"
  })
  return { store, teach, created, session, skill, ...claim }
}

it("persists an actual saved skill reference in the final learning result and makes the same unverified version selectable next", () => {
  const f = fixture()
  f.store.finish(f.lease, "succeeded", "Saved; choose whether to try new inputs")
  const final = f.store
    .messages(f.created.conversationId)
    .find((message) => message.runId === f.run.id && message.sender === "bot")!
  const reference = { botId: f.created.bot.id, id: f.skill.id, name: f.skill.name, version: 1 }
  expect(final.skillReferences).toEqual([reference])
  expect(
    f.store.skillReferences.catalog({ conversationId: f.created.conversationId })
  ).toContainEqual(expect.objectContaining({ ...reference, verified: false }))
  const accepted = f.store.send({
    nonce: "new-input",
    conversationId: f.created.conversationId,
    text: "Run on the new data",
    skills: [{ botId: reference.botId, id: reference.id, version: reference.version }]
  })
  expect(f.store.skillReferences.forRun(accepted.runIds[0])).toEqual([reference])
  expect(f.store.skills(f.created.bot.id)[0].verified).toBe(false)
})

it("keeps the learned version frozen when it is edited before the final bubble and does not authorize a stale next-task selection", () => {
  const f = fixture()
  f.store.saveSkill({
    botId: f.skill.botId,
    id: f.skill.id,
    version: f.skill.version,
    name: "Edited workflow",
    instructions: "Edited steps",
    enabled: true
  })
  f.store.finish(f.lease, "succeeded", "Saved original version")
  const final = f.store
    .messages(f.created.conversationId)
    .find((message) => message.runId === f.run.id && message.sender === "bot")!
  expect(final.skillReferences).toEqual([
    { botId: f.skill.botId, id: f.skill.id, name: f.skill.name, version: 1 }
  ])
  expect(() =>
    f.store.send({
      nonce: "stale",
      conversationId: f.created.conversationId,
      text: "Use the old version",
      skills: [{ botId: f.skill.botId, id: f.skill.id, version: 1 }]
    })
  ).toThrow(expect.objectContaining({ code: "skill_changed" }))
})

it.each(["failed", "cancelled"] as const)(
  "does not attach a successful-learning reference to a %s terminal error",
  (outcome) => {
    const f = fixture()
    f.store.finish(f.lease, outcome, "Learning did not complete")
    expect(
      f.store
        .messages(f.created.conversationId)
        .filter((message) => message.runId === f.run.id)
        .every((message) => !message.skillReferences?.length)
    ).toBe(true)
  }
)

it("rejects a saved skill reference if the persisted learning identity was moved to another Bot", () => {
  const f = fixture(),
    other = f.store.createBot({ nonce: "other", name: "Other" })
  f.store.db.run("UPDATE bot_teach_sessions SET bot_id=? WHERE id=?", [other.bot.id, f.session.id])
  expect(() => f.store.finish(f.lease, "succeeded", "Not published")).toThrow(
    expect.objectContaining({ code: "teach_scope" })
  )
  expect(f.store.getRun(f.run.id).status).toBe("running")
  expect(
    f.store.messages(f.created.conversationId).some((message) => message.sender === "bot")
  ).toBe(false)
})
