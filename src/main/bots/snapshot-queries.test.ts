import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "History" })
  store.transaction(() => {
    store.db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO bot_events(kind,entity_id,payload,created_at) SELECT 'run.checkpoint','run-'||x,'{}',x FROM n`)
    store.db.run(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO bot_runs(id,bot_id,conversation_id,message_id,root_run_id,depth,lane,source,status,created_at,updated_at)
      SELECT 'run-'||x,?,?,'message-'||x,'run-'||x,0,'user','user','succeeded',x,x FROM n`,
      [bot.id, conversationId]
    )
    store.db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO bot_interactions(id,run_id,kind,prompt,status,expires_at,created_at)
      SELECT 'interaction-'||x,'run-'||x,'question','Question','answered',x,x FROM n`)
  })
  return store
}

it("reads workspace state without scanning completed task, interaction or unrelated event history", () => {
  const store = fixture()
  const queries = vi.spyOn(store.db, "prepare")
  const directQueries = vi.spyOn(store.db, "exec")
  expect(store.snapshot()).toMatchObject({ dataEpoch: "initial", runs: [], interactions: [] })
  const statements = [...queries.mock.calls, ...directQueries.mock.calls].map(([sql]) => sql)
  for (const [table, predicate, index] of [
    [
      "bot_events",
      "kind IN ('workspace.restored','computer.restored')",
      "bot_event_restore_cursor"
    ],
    ["bot_runs", "status NOT IN", "bot_run_open_projection"],
    ["bot_interactions", "status='pending'", "bot_interaction_pending_projection"]
  ]) {
    const sql = statements.find((value) => value.includes(`FROM ${table} WHERE ${predicate}`))
    expect(sql).toBeDefined()
    const plan = store.db.exec(`EXPLAIN QUERY PLAN ${sql}`)[0].values.map((row) => String(row[3]))
    expect(plan.some((step) => step.includes(`USING INDEX ${index}`))).toBe(true)
    expect(plan.some((step) => step === `SCAN ${table}` || step.includes("TEMP B-TREE"))).toBe(
      false
    )
  }
})

it("keeps all open statuses and pending cards ordered, and reflects closure and restore epochs immediately", () => {
  const store = fixture()
  const statuses = ["queued", "running", "waiting_input", "cancelling", "needs_review"]
  const ids = statuses.map((status, index) => {
    const { conversationId } = store.createBot({ nonce: `bot-${index}`, name: status })
    const sent = store.send({ nonce: `send-${index}`, conversationId, text: status })
    const id = sent.runIds[0]
    store.db.run("UPDATE bot_runs SET status=?,created_at=? WHERE id=?", [status, index % 2, id])
    store.db.run(
      "INSERT INTO bot_interactions(id,run_id,kind,prompt,status,expires_at,created_at) VALUES(?,?,'question','Pending','pending',9999999999999,?)",
      [`pending-${index}`, id, index % 2]
    )
    return id
  })
  const first = store.snapshot()
  expect(first.runs.map((run) => run.id)).toEqual(
    [...ids].sort((a, b) => {
      const left = ids.indexOf(a) % 2,
        right = ids.indexOf(b) % 2
      return left - right || a.localeCompare(b)
    })
  )
  expect(new Set(first.runs.map((run) => run.status))).toEqual(new Set(statuses))
  expect(first.interactions.map((item) => item.id)).toEqual([
    "pending-0",
    "pending-2",
    "pending-4",
    "pending-1",
    "pending-3"
  ])
  store.db.run("UPDATE bot_runs SET status='cancelled' WHERE id=?", [ids[0]])
  store.db.run("UPDATE bot_interactions SET status='answered' WHERE id='pending-0'")
  for (const [epoch, time] of [
    ["first-restore", 100],
    ["second-restore", 1]
  ] as const) {
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
      [epoch, time]
    )
    expect(store.backupSchedule.epoch()).toBe(epoch)
    expect(store.snapshot().dataEpoch).toBe(epoch)
  }
  const next = store.snapshot()
  expect(next.runs).toHaveLength(4)
  expect(next.interactions).toHaveLength(4)
  expect(next.runs.some((run) => run.id === ids[0])).toBe(false)
})
