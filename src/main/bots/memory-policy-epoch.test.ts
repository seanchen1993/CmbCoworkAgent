import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotDomainError } from "../../shared/bot-types"
import { botMemoryPolicyInput } from "../../shared/bot-memory"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 1_800_000_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const owner = store.createBot({ nonce: "owner", name: "Memory Bot" })
  store.send({ nonce: "task", conversationId: owner.conversationId, text: "Remember review steps" })
  const claim = store.claim("fixture")!
  store.finish(claim.lease, "succeeded", "Recorded review steps")
  now += 16000
  const synthesis = store.memory.prepare(owner.bot.id)!
  expect(synthesis).toBeTruthy()
  const policy = store.memory.policy(owner.bot.id),
    input = { botId: owner.bot.id, revision: policy.revision, enabled: false },
    restore = () =>
      store.db.run(
        "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
        ["replacement", store.now()]
      ),
    evidence = () =>
      JSON.stringify([
        store.memory.policy(owner.bot.id),
        store.db.exec("SELECT * FROM bot_memory_state"),
        store.db.exec("SELECT * FROM bot_memory_evidence"),
        store.db.exec("SELECT * FROM bot_events")
      ])
  return { store, owner, input, policy, restore, evidence }
}
it("rejects the actual legacy unscoped policy request after a restore marker even at identical Bot/revision", () => {
  const f = fixture()
  f.restore()
  const before = f.evidence()
  expect(() => f.store.memory.setPolicy(f.input)).toThrow(BotDomainError)
  expect(f.evidence()).toBe(before)
  expect(f.store.memory.policy(f.owner.bot.id)).toMatchObject({
    revision: 0,
    enabled: true,
    pending: 1,
    dataEpoch: "replacement"
  })
})
it("keeps legacy initial-workspace callers compatible without borrowing the current restored epoch", () => {
  const f = fixture()
  expect(f.store.memory.setPolicy(f.input)).toMatchObject({
    enabled: false,
    revision: 1,
    dataEpoch: "initial"
  })
})
it("refuses a reviewed old epoch before any manual barrier or policy/evidence event mutation", () => {
  const f = fixture(),
    input = { ...f.input, expectedDataEpoch: f.policy.dataEpoch }
  f.restore()
  const before = f.evidence()
  expect(() => f.store.memory.setPolicy(input)).toThrowError(
    expect.objectContaining({ code: "data_epoch" })
  )
  expect(f.evidence()).toBe(before)
})
it("accepts only the genuinely reread replacement epoch and retains normal policy CAS", () => {
  const f = fixture()
  f.restore()
  const authority = f.store.memory.policy(f.owner.bot.id),
    input = { ...f.input, revision: authority.revision, expectedDataEpoch: authority.dataEpoch }
  expect(f.store.memory.setPolicy(input)).toMatchObject({
    enabled: false,
    revision: 1,
    dataEpoch: "replacement",
    pending: 0
  })
  expect(() => f.store.memory.setPolicy(input)).toThrowError(
    expect.objectContaining({ code: "revision_conflict" })
  )
})
it("rejects malformed explicit authority and never accepts arbitrary current-epoch fields", () => {
  const f = fixture()
  for (const expectedDataEpoch of ["", 5, "x".repeat(161)])
    expect(() => botMemoryPolicyInput.parse({ ...f.input, expectedDataEpoch })).toThrow()
  expect(() => botMemoryPolicyInput.parse({ ...f.input, currentDataEpoch: "initial" })).toThrow()
})
