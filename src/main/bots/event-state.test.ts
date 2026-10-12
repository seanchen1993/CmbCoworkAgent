import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotWebhookServer } from "./webhook-server"
import type { BotRunLease } from "../../shared/bot-types"
import type { BotEventVersion } from "../../shared/bot-event-state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cmb-event-state-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "bots.sqlite")
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const owner = store.createBot({ nonce: "owner", name: "Event owner" })
  const peer = store.createBot({ nonce: "peer", name: "Event reviewer" })
  const routine = store.saveRoutine({
    botId: owner.bot.id,
    name: "Latest object",
    prompt: "Update only the reviewed source version",
    timezone: "UTC",
    enabled: true,
    schedule: {
      kind: "event",
      topic: "object.updated",
      eventPolicy: { mode: "latest-state", sourceEpoch: "source-v1" }
    }
  })
  const key = store.webhooks.change({
    nonce: "enable",
    botId: owner.bot.id,
    routineId: routine.id,
    revision: 0,
    operation: "rotate"
  }).key!
  const auth = store.webhooks.authorize(routine.id, `Bearer ${key}`)!
  const version = (sequence: number, entityKey = "object-1"): BotEventVersion => ({
    sourceEpoch: "source-v1",
    entityKey,
    sequence
  })
  const accept = (
    sequence: number,
    eventId = `event-${sequence}`,
    content = `value-${sequence}`,
    entityKey = "object-1"
  ) => store.webhooks.accept(auth, eventId, content, version(sequence, entityKey))
  return { dir, path, store, owner, peer, routine, key, auth, version, accept }
}
function approval(store: BotStore, lease: BotRunLease, action: unknown, answer = true) {
  const ask = store.requestInteraction(lease, {
    kind: "approval",
    prompt: JSON.stringify(action),
    action
  })
  if (answer) store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
  return ask
}
it("keeps ordinary events and explicitly validates the latest-state source contract", () => {
  const f = fixture()
  const ordinary = f.store.saveRoutine({
    ...f.routine,
    id: undefined,
    name: "Every event",
    schedule: { kind: "event", topic: "ordinary" }
  })
  expect(
    f.store.emitEvent({ nonce: "ordinary1", topic: "ordinary", payload: "one" }).runIds
  ).toHaveLength(1)
  expect(
    f.store.emitEvent({ nonce: "ordinary2", topic: "ordinary", payload: "two" }).runIds
  ).toHaveLength(1)
  expect(f.store.routine(f.owner.bot.id, ordinary.id).schedule).toEqual({
    kind: "event",
    topic: "ordinary"
  })
  expect(() => f.store.webhooks.accept(f.auth, "missing", "{}")).toThrow("最新状态事件")
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => f.accept(sequence, `invalid${String(sequence).replace(/[^\w]/g, "")}`)).toThrow(
      "最新状态事件"
    )
  expect(() =>
    f.store.webhooks.accept(f.auth, "epoch", "{}", { ...f.version(1), sourceEpoch: "foreign" })
  ).toThrow("来源批次")
  expect(f.store.db.exec("SELECT * FROM bot_event_heads")[0]?.values ?? []).toEqual([])
  expect(() =>
    f.store.runRoutine({ id: f.routine.id, nonce: "manual", revision: f.routine.revision })
  ).toThrow("带来源版本")
})
it("commits high water, delivery, run and immutable replay together; stale events cannot dispatch", () => {
  const f = fixture()
  const first = f.accept(5)
  const original = f.store.getRun(first.runIds[0])
  expect(f.accept(5)).toEqual(first)
  expect(f.accept(5, "another-id")).toMatchObject({
    runIds: first.runIds,
    disposition: "duplicate"
  })
  expect(() => f.accept(5, "conflict", "different")).toThrow("相同来源版本")
  expect(f.accept(3)).toMatchObject({ runIds: [], disposition: "stale" })
  expect(() => f.accept(3, "old-conflict", "changed-old")).toThrow("相同来源版本")
  const second = f.accept(6)
  expect(f.store.getRun(original.id).status).toBe("cancelled")
  expect(f.store.claim("host")!.run.id).toBe(second.runIds[0])
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(2)
  expect(f.store.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
})
it("rolls back version advancement when the original dispatch transaction fails", () => {
  const f = fixture(),
    first = f.accept(1)
  const run = f.store.db.run.bind(f.store.db)
  const spy = vi.spyOn(f.store.db, "run").mockImplementation((sql, args) => {
    if (sql.startsWith("INSERT INTO bot_event_heads")) throw new Error("controlled commit failure")
    return run(sql, args)
  })
  expect(() => f.accept(2)).toThrow("controlled commit failure")
  spy.mockRestore()
  expect(f.store.getRun(first.runIds[0]).status).toBe("queued")
  expect(f.store.snapshot().runs).toHaveLength(1)
  expect(f.accept(2).runIds).toHaveLength(1)
})
it.each([false, true])(
  "retires old approvals before dispatch after a newer event (already approved=%s)",
  (answered) => {
    const f = fixture()
    f.accept(1)
    const current = f.store.claim("host")!
    const action = { update: "object-1", value: "old" }
    const ask = approval(f.store, current.lease, action, answered)
    const newer = f.accept(2)
    if (!answered) {
      expect(f.store.getInteraction(ask.id).status).toBe("cancelled")
      expect(() =>
        f.store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
      ).toThrow()
    }
    expect(() =>
      f.store.beginEffect(current.lease, { id: "old-write", action, approvalId: ask.id })
    ).toThrow()
    expect(f.store.effects(current.run.id)).toEqual([])
    expect(f.store.claim("other-host")).toBeNull()
    f.store.finish(current.lease, "cancelled", "Superseded")
    expect(f.store.claim("other-host")!.run.id).toBe(newer.runIds[0])
  }
)
it("inherits the root version in another Bot and blocks a successor while a child outcome is unknown", () => {
  const f = fixture()
  f.accept(1)
  const parent = f.store.claim("host")!
  const handoff = f.store.sendPeer(parent.lease, {
    nonce: "handoff",
    recipient: f.peer.bot.id,
    text: "Review current object"
  })
  const child = f.store.claim("peer-host")!
  expect(handoff.runIds).toContain(child.run.id)
  expect(f.store.webhooks.states.versionForRun(child.run.id)).toEqual(f.version(1))
  const action = { target: "controlled-object", version: f.version(1) }
  const ask = approval(f.store, child.lease, action)
  f.store.beginEffect(child.lease, { id: "child-write", action, approvalId: ask.id })
  const next = f.accept(2)
  expect(() => f.store.assertDispatch(child.lease)).toThrow()
  // Receipt collection remains permitted; cancellation does not claim rollback.
  f.store.settleEffect(child.lease, "child-write", "unknown", "lost acknowledgement")
  f.store.finish(child.lease, "cancelled", "Superseded with unknown outcome")
  f.store.finish(parent.lease, "cancelled", "Superseded")
  expect(f.store.getRun(child.run.id).status).toBe("needs_review")
  expect(f.store.claim("new-host")).toBeNull()
  const review = f.store.getRun(child.run.id)
  expect(f.store.webhooks.states.versionForRun(child.run.id)).toEqual(f.version(1))
  expect(f.store.db.exec("SELECT sequence FROM bot_event_heads")[0].values[0][0]).toBe(2)
  expect(() => f.store.webhooks.states.assertCurrent(child.run.id)).toThrow("版本已过期")
  expect(() =>
    f.store.recover({
      id: review.id,
      revision: review.revision,
      decision: "resume",
      note: "Old version",
      effects: [{ id: "child-write", outcome: "succeeded", note: "Observed target" }]
    })
  ).toThrow("版本已过期")
  f.store.recover({
    id: review.id,
    revision: review.revision,
    decision: "cancel",
    note: "Target checked; retire old version",
    effects: [{ id: "child-write", outcome: "succeeded", note: "Observed target" }]
  })
  expect(f.store.claim("new-host")!.run.id).toBe(next.runIds[0])
})
it("keeps source fences and replay receipts after restart and safely migrates schema 73", () => {
  const f = fixture(),
    first = f.accept(9)
  f.store.close()
  const old = new DatabaseSync(f.path)
  old.exec("UPDATE bot_schema SET version=73")
  old.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  expect(next.webhooks.accept(f.auth, "event-9", "value-9", f.version(9))).toEqual(first)
  expect(next.webhooks.accept(f.auth, "late", "value-4", f.version(4))).toMatchObject({
    disposition: "stale",
    runIds: []
  })
  expect(next.webhooks.states.versionForRun(first.runIds[0])).toEqual(f.version(9))
  expect(readdirSync(join(f.dir, "backups")).some((name) => name.startsWith("bots-v73-"))).toBe(
    true
  )
  expect(next.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
})

it("pins the configured epoch and retires pending work when that epoch is deliberately changed", () => {
  const f = fixture(),
    first = f.accept(7)
  const changed = f.store.saveRoutine({
    ...f.routine,
    schedule: {
      kind: "event",
      topic: "object.updated",
      eventPolicy: { mode: "latest-state", sourceEpoch: "source-v2" }
    }
  })
  expect(f.store.getRun(first.runIds[0]).status).toBe("cancelled")
  expect(() => f.accept(8)).toThrow("来源批次")
  const version = { ...f.version(0), sourceEpoch: "source-v2" }
  const accepted = f.store.webhooks.accept(f.auth, "epoch2-first", "new epoch", version)
  expect(f.store.webhooks.states.versionForRun(accepted.runIds[0])).toEqual(version)
  expect(changed.schedule).toMatchObject({ eventPolicy: { sourceEpoch: "source-v2" } })
})
it("uses explicit HTTP envelope versions and returns a durable stale acknowledgement", async () => {
  const f = fixture(),
    server = new BotWebhookServer(f.store, () => {})
  cleanup.push(() => server.close())
  await server.start()
  const url = server.view({ botId: f.owner.bot.id, routineId: f.routine.id }).url!
  const post = (id: string, sequence: number, extra = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": id
      },
      body: JSON.stringify({ ...f.version(sequence), payload: { value: sequence }, ...extra })
    })
  const accepted = await post("http5", 5)
  expect(accepted.status).toBe(200)
  const received = await accepted.json()
  expect(await (await post("http5", 5)).json()).toEqual(received)
  expect(await (await post("http4", 4)).json()).toMatchObject({
    accepted: true,
    disposition: "stale",
    runIds: []
  })
  expect((await post("httpConflict", 5, { payload: { value: 42 } })).status).toBe(409)
  expect((await post("httpUnsafe", Number.MAX_SAFE_INTEGER + 1)).status).toBe(400)
  expect(f.store.snapshot().runs).toHaveLength(1)
})
it("preserves an unknown external CAS write across restart and never releases its successor before reconciliation", async () => {
  const f = fixture()
  let object = { sequence: 0, value: "initial" },
    attempts = 0
  const target = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(Buffer.from(part))
    const input = JSON.parse(Buffer.concat(chunks).toString())
    attempts++
    if (Number(req.headers["if-match"]) !== object.sequence || input.sequence <= object.sequence) {
      res.writeHead(409).end()
      return
    }
    object = input
    if (req.headers["x-lose-response"]) req.socket.destroy()
    else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(object))
  })
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        target.closeAllConnections()
        target.close(() => resolve())
      })
  )
  const url = `http://127.0.0.1:${(target.address() as { port: number }).port}`
  f.accept(1)
  const old = f.store.claim("host")!,
    action = { object: "object-1", sequence: 1, expectedTargetVersion: 0 }
  const ask = approval(f.store, old.lease, action)
  f.store.beginEffect(old.lease, { id: "cas1", action, approvalId: ask.id })
  await expect(
    fetch(url, {
      method: "PUT",
      headers: { "If-Match": "0", "X-Lose-Response": "1" },
      body: JSON.stringify({ sequence: 1, value: "first" })
    })
  ).rejects.toThrow()
  const nextId = f.accept(2).runIds[0]
  f.store.settleEffect(old.lease, "cas1", "unknown", "Target applied but reply was lost")
  f.store.finish(old.lease, "cancelled", "Await reconciliation")
  f.store.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  expect(next.claim("restarted")).toBeNull()
  expect(next.effects(old.run.id)[0].status).toBe("unknown")
  expect(() =>
    next.saveRoutine({
      ...next.routine(f.owner.bot.id, f.routine.id),
      schedule: { kind: "event", topic: "object.updated" }
    })
  ).toThrow("核对后再退出最新状态模式")
  expect(object).toEqual({ sequence: 1, value: "first" })
  const review = next.getRun(old.run.id)
  next.recover({
    id: review.id,
    revision: review.revision,
    decision: "cancel",
    note: "Read exact target version 1",
    effects: [
      { id: "cas1", outcome: "succeeded", note: "Target version and body match original operation" }
    ]
  })
  const current = next.claim("restarted")!
  expect(current.run.id).toBe(nextId)
  const currentAction = { object: "object-1", sequence: 2, expectedTargetVersion: 1 }
  const currentAsk = approval(next, current.lease, currentAction)
  next.beginEffect(current.lease, { id: "cas2", action: currentAction, approvalId: currentAsk.id })
  const applied = await fetch(url, {
    method: "PUT",
    headers: { "If-Match": "1" },
    body: JSON.stringify({ sequence: 2, value: "latest" })
  })
  expect(applied.status).toBe(200)
  next.settleEffect(current.lease, "cas2", "succeeded", await applied.text())
  // Even an already-sent stale request requires target-side CAS to be safe.
  expect(
    (
      await fetch(url, {
        method: "PUT",
        headers: { "If-Match": "0" },
        body: JSON.stringify({ sequence: 1, value: "late-old" })
      })
    ).status
  ).toBe(409)
  expect(object).toEqual({ sequence: 2, value: "latest" })
  expect(attempts).toBe(3)
  expect(next.effects(current.run.id)).toHaveLength(1)
})
