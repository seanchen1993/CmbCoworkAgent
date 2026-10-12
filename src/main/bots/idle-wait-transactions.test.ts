import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

function fixture() {
  let now = 1_900_000_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "Planner" })
  store.send({ nonce: "task", conversationId: a.conversationId, text: "Synthetic task" })
  const parent = store.claim("parent")!
  return {
    store,
    a,
    parent,
    expireLease: () => {
      now += 30_001
    }
  }
}

function countWrites(store: BotStore) {
  const sql = vi.spyOn(store.db, "run")
  const deletions = Reflect.get(store, "deletions") as { flush(...args: unknown[]): void }
  const flush = vi.spyOn(deletions, "flush")
  return {
    sql,
    flush,
    reserved: () => sql.mock.calls.filter(([statement]) => statement === "BEGIN IMMEDIATE").length
  }
}

it("unchanged computer waits reserve no writer lock and flush no deletion work", () => {
  const f = fixture()
  f.store.waitForComputer(f.parent.lease, true)
  const waiting = f.store.getRun(f.parent.run.id)
  const events = f.store.events()
  const trace = countWrites(f.store)
  for (let n = 0; n < 256; n++) f.store.waitForComputer(f.parent.lease, true)
  expect(f.store.getRun(f.parent.run.id)).toEqual(waiting)
  expect(f.store.events()).toEqual(events)
  expect(trace.reserved()).toBe(0)
  expect(trace.flush).not.toHaveBeenCalled()
  // Real handback still uses its original write transaction and durable event.
  f.store.waitForComputer(f.parent.lease, false)
  expect(trace.reserved()).toBe(1)
  expect(f.store.getRun(f.parent.run.id)).toMatchObject({
    status: "running",
    waitingForComputer: false,
    revision: waiting.revision + 1
  })
  expect(f.store.events().filter((event) => event.kind === "run.computer_wait")).toHaveLength(2)
  const question = f.store.requestInteraction(f.parent.lease, {
    kind: "question",
    prompt: "Synthetic question"
  })
  expect(() => f.store.waitForComputer(f.parent.lease, true)).toThrow("另一项交互")
  f.store.answerInteraction({
    id: question.id,
    revision: question.revision,
    answer: "fixture answer"
  })
  f.store.waitForComputer(f.parent.lease, true)
  expect(() => f.store.waitForComputer({ ...f.parent.lease, owner: "wrong" }, true)).toThrow(
    "执行权"
  )
  expect(() => f.store.waitForComputer({ ...f.parent.lease, fence: 99 }, true)).toThrow("执行权")
  f.expireLease()
  expect(() => f.store.waitForComputer(f.parent.lease, true)).toThrow("执行权")
  f.store.recoverExpired()
  expect(f.store.getRun(f.parent.run.id).status).toBe("needs_review")
  expect(() => f.store.waitForComputer(f.parent.lease, true)).toThrow("执行权")
})

it("unchanged peer waits reserve no writer lock and preserve the exact original return route", () => {
  const f = fixture()
  const b = f.store.createBot({ nonce: "b", name: "Specialist" })
  const sent = f.store.sendPeer(f.parent.lease, {
    nonce: "peer",
    recipient: b.bot.id,
    text: "Synthetic delegated work"
  })
  const child = f.store.waitForPeer(f.parent.lease, sent.runIds[0])
  const waiting = f.store.getRun(f.parent.run.id)
  const events = f.store.events()
  const trace = countWrites(f.store)
  for (let n = 0; n < 256; n++) expect(f.store.waitForPeer(f.parent.lease, child.id)).toEqual(child)
  expect(f.store.getRun(f.parent.run.id)).toEqual(waiting)
  expect(f.store.events()).toEqual(events)
  expect(trace.reserved()).toBe(0)
  expect(trace.flush).not.toHaveBeenCalled()
  const current = f.store.claim("specialist")!
  expect(current.run.id).toBe(child.id)
  const active = f.store.getRun(child.id)
  const baselineReserved = trace.reserved()
  for (let n = 0; n < 256; n++)
    expect(f.store.waitForPeer(f.parent.lease, child.id)).toEqual(active)
  expect(trace.reserved()).toBe(baselineReserved)
  f.store.finish(current.lease, "succeeded", "ACTUAL_SYNTHETIC_RESULT")
  const beforeReturn = trace.reserved()
  expect(f.store.waitForPeer(f.parent.lease, child.id)).toMatchObject({
    status: "succeeded",
    result: "ACTUAL_SYNTHETIC_RESULT"
  })
  expect(trace.reserved()).toBe(beforeReturn + 1)
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
  expect(
    f.store
      .events()
      .filter((event) => event.kind === "run.peer_returned" && event.entityId === f.parent.run.id)
  ).toHaveLength(1)
  expect(
    f.store
      .messages(f.a.conversationId)
      .filter((message) => message.text === "ACTUAL_SYNTHETIC_RESULT")
  ).toHaveLength(1)
  const c = f.store.createBot({ nonce: "c", name: "Independent" })
  const other = f.store.send({
    nonce: "unrelated",
    conversationId: c.conversationId,
    text: "Unrelated task"
  })
  expect(() => f.store.waitForPeer(f.parent.lease, other.runIds[0])).toThrow("只能等待")
  expect(() => f.store.waitForPeer({ ...f.parent.lease, owner: "wrong" }, child.id)).toThrow(
    "执行权"
  )
  f.expireLease()
  expect(() => f.store.waitForPeer(f.parent.lease, child.id)).toThrow("执行权")
})
