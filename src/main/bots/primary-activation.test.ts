import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 1_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const main = store.createBot({ nonce: "main", name: "Main" })
  const target = store.createBot({ nonce: "target", name: "Worker" })
  const outside = store.createBot({ nonce: "outside", name: "Outside" })
  store.primary.change({
    nonce: "choose",
    revision: 0,
    dataEpoch: store.dataEpoch(),
    botId: main.bot.id
  })
  let sequence = 0
  const configure = (enabled = true) => {
    const state = store.primary.read()
    return store.primary.configureCheckIn({
      nonce: `configuration-${sequence++}`,
      revision: state.checkInRevision,
      primaryRevision: state.revision,
      dataEpoch: state.dataEpoch,
      botId: main.bot.id,
      enabled,
      prompt: "Follow the assigned work and return evidence once",
      targetBotIds: [target.bot.id],
      everyMs: 60_000,
      timezone: "UTC"
    })
  }
  const start = (worker = target) => {
    const accepted = store.send({
      nonce: `work-${sequence++}`,
      conversationId: worker.conversationId,
      text: "Compute 17+25"
    })
    const claim = store.claim("worker", 300_000)!
    expect(claim.run.id).toBe(accepted.runIds[0])
    return claim
  }
  const tick = () => {
    now += 60_000
    return store.dispatchDueRoutines()
  }
  return { store, main, target, outside, configure, start, tick }
}
function activation(store: BotStore) {
  return store.db.exec("SELECT activation_fingerprint FROM bot_primary_checkin WHERE id=1")[0]
    .values[0][0]
}
function fingerprint(store: BotStore) {
  return store.db.exec("SELECT fingerprint FROM bot_primary_checkin WHERE id=1")[0].values[0][0]
}

it("does not replay older finished work on first enable or at unchanged idle ticks", () => {
  const f = fixture(),
    old = f.start()
  f.store.finish(old.lease, "succeeded", "42")
  const state = f.configure()
  expect(activation(f.store)).toMatch(/^[a-f0-9]{64}$/)
  expect(state.checkIn).not.toHaveProperty("activationFingerprint")
  expect(fingerprint(f.store)).toBeNull()
  expect(f.tick()).toEqual([])
  expect(f.tick()).toEqual([])
})

it("detects work accepted and finished between activation and the first scheduled tick", () => {
  const f = fixture()
  f.configure()
  const fast = f.start()
  f.store.finish(fast.lease, "succeeded", "42")
  const [id] = f.tick()
  expect(id).toBeTruthy()
  const claim = f.store.claim("main", 300_000)!
  expect(claim.run.id).toBe(id)
  expect(
    f.store.message({ conversationId: claim.run.conversationId, id: claim.run.messageId }).text
  ).toContain(fast.run.id)
  f.store.finish(claim.lease, "succeeded", "Worker completed: 42")
  expect(fingerprint(f.store)).toMatch(/^[a-f0-9]{64}$/)
  expect(f.tick()).toEqual([])
})

it("does not lose an already active task that finishes before the first tick", () => {
  const f = fixture(),
    work = f.start()
  f.configure()
  f.store.finish(work.lease, "succeeded", "42")
  expect(f.tick()).toHaveLength(1)
})

it.each(["failed", "cancelled"] as const)(
  "retries an unacknowledged fast completion after Main %s",
  (outcome) => {
    const f = fixture()
    f.configure()
    const work = f.start()
    f.store.finish(work.lease, "succeeded", "42")
    const [first] = f.tick()
    const claim = f.store.claim("main", 300_000)!
    expect(claim.run.id).toBe(first)
    f.store.finish(claim.lease, outcome, "Main did not finish")
    expect(fingerprint(f.store)).toBeNull()
    const [retry] = f.tick()
    expect(retry).toBeTruthy()
    expect(retry).not.toBe(first)
  }
)

it("rebases a new activation, ignores work outside the target list and still detects later target completion", () => {
  const f = fixture(),
    old = f.start()
  f.store.finish(old.lease, "succeeded", "42")
  f.configure()
  f.configure(false)
  f.configure()
  const outside = f.start(f.outside)
  f.store.finish(outside.lease, "succeeded", "Outside")
  expect(f.tick()).toEqual([])
  const newer = f.start()
  f.store.finish(newer.lease, "succeeded", "New 42")
  expect(f.tick()).toHaveLength(1)
})

it("initializes an older saved configuration quietly and persists its baseline for a later fast task", () => {
  const f = fixture(),
    old = f.start()
  f.store.finish(old.lease, "succeeded", "42")
  const state = f.configure()
  f.store.db.run("UPDATE bot_primary_checkin SET activation_fingerprint=NULL WHERE id=1")
  expect(f.tick()).toEqual([])
  expect(activation(f.store)).toMatch(/^[a-f0-9]{64}$/)
  expect(f.store.primary.read().checkInRevision).toBe(state.checkInRevision)
  const newer = f.start()
  f.store.finish(newer.lease, "succeeded", "New 42")
  expect(f.tick()).toHaveLength(1)
})

it("detects a same-millisecond completion whose random UUID sorts before older work", () => {
  const f = fixture()
  // Explicit SQL boundary fixture fixes both UUID order and accepted timestamps.
  // The trigger messages keep their real AUTOINCREMENT ordering; no model executes.
  const older = "ffffffff-ffff-4fff-8fff-ffffffffffff"
  const newer = "00000000-0000-4000-8000-000000000001"
  const complete = (id: string, result: string) => {
    f.store.db.run(
      `INSERT INTO bot_messages(id,conversation_id,bot_id,sender,text,created_at)
      VALUES(?,?,NULL,'user','Compute 17+25',1000000)`,
      [id, f.target.conversationId]
    )
    f.store.db.run(
      `INSERT INTO bot_runs(id,bot_id,conversation_id,message_id,parent_run_id,root_run_id,
      depth,lane,source,status,result,created_at,updated_at)
      VALUES(?,?,?,?,NULL,?,0,'user','user','succeeded',?,1000000,1000000)`,
      [id, f.target.bot.id, f.target.conversationId, id, id, result]
    )
  }
  complete(older, "Older 42")
  const observed = vi.spyOn(f.store.db, "exec")
  f.configure()
  const query = observed.mock.calls.find(([sql]) =>
    sql.includes("SELECT id,bot_id,status,substr(result,1,1000),created_at FROM bot_runs")
  )
  observed.mockRestore()
  expect(query).toBeDefined()
  const plan = f.store.db
    .exec(`EXPLAIN QUERY PLAN ${query![0]}`, query![1])[0]
    .values.map((row) => String(row[3]))
  expect(plan.join("\n")).toContain("bot_primary_settled_signal (bot_id=?)")
  expect(plan.join("\n")).toContain("sqlite_autoindex_bot_messages_1 (id=?)")
  expect(plan).not.toContain("SCAN bot_runs")
  // Different SQLite builds label the same partial-order sort differently.
  // A full-history ORDER BY sort would regress the indexed timestamp prefix.
  for (const detail of plan.filter((value) => value.includes("TEMP B-TREE")))
    expect(detail).toMatch(/(?:RIGHT PART|LAST \d+ TERMS) OF ORDER BY/)
  // Keep the new work in the exact old timestamp; its message sequence is later.
  complete(newer, "New 42")
  const [id] = f.tick()
  expect(id).toBeTruthy()
  const claim = f.store.claim("main", 300_000)!
  expect(claim.run.id).toBe(id)
  const prompt = f.store.message({
    conversationId: claim.run.conversationId,
    id: claim.run.messageId
  }).text
  expect(prompt).toContain(newer)
  expect(prompt).not.toContain(older)
  f.store.finish(claim.lease, "succeeded", "New work completed: 42")
  expect(f.tick()).toEqual([])
})
