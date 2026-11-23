import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { botImScopeId } from "./im-gateway-store"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
function fixture() {
  const native = new DatabaseSync(":memory:")
  const db = new NativeSqliteAdapter(native)
  databases.push(db)
  let now = Date.now()
  let store = new BotStore(db, () => ++now)
  const a = store.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
  const b = store.create({ name: "B", instructions: "", color: "#123456", modelRef: null })
  const finish = (id: string) => {
    store.transition(id, "running")
    store.settle(id, "completed", null, "Done")
  }
  const privateDispatch = () => {
    const root = store.enqueue({ botId: a.id, requestId: `private-${now}`, message: "private" })
    store.transition(root.id, "running")
    const child = store.delegate(root.id, b.id, "PRIVATE CONTENT", "private")
    store.settle(root.id, "completed", null, "")
    return child
  }
  const imDispatch = (label: string, kind: "group" | "dm" = "group") => {
    const binding = { id: label, botId: a.id, kind, label, version: 1, state: "active" as const,
      conversationKey: label, expiresAt: new Date(now + 1e8).toISOString(), createdAt: new Date(now).toISOString() }
    const route = store.imGateway.register("realm", "principal", binding)
    store.im.importImBinding({ id: route.id, botId: a.id, kind, label, channelKey: botImScopeId("realm", "principal", label), version: 1 })
    const eventId = `${label}-${now}`
    const wire = { route: { bindingId: label, botId: a.id, kind, label, version: 1, senderId: "sender" },
      event: { schemaVersion: 1 as const, eventId, platformMessageId: eventId, principalId: "principal", conversationKey: label,
        conversationSeq: now, message: { type: "text" as const, text: label }, occurredAt: new Date(now).toISOString(), redelivered: false,
        lease: { id: "lease", expiresAt: new Date(now + 1e8).toISOString() } } }
    const event = store.imGateway.receive("realm", "principal", wire)
    store.imGateway.settle(event.id, "active", undefined, now + 1e8)
    const receipt = store.im.inject({ simulation: true, bindingId: route.id, eventId: event.id, messageId: eventId, senderId: "sender", text: label, mentionsBotIds: [a.id] })
    const root = store.getTask(receipt.taskId!)
    store.transition(root.id, "running")
    const child = store.delegate(root.id, b.id, `${label} CONTENT`, eventId)
    store.settle(root.id, "completed", null, "")
    return { root, child, route, binding, event }
  }
  return {
    db, native, a, b, get store() { return store }, privateDispatch, imDispatch, finish,
    reopen() { store = new BotStore(db, () => ++now); return store },
    age() { now += 31 * 86400000 },
    tail() { for (let i = 0; i < 101; i++) finish(store.enqueue({ botId: a.id, requestId: `tail-${i}-${now}`, message: "tail" }).id) }
  }
}

it("isolates IM exchange anchors, history and cursors while keeping personal IM with the private conversation", () => {
  const f = fixture()
  const own = f.privateDispatch(), one = f.imDispatch("one"), two = f.imDispatch("two"), personal = f.imDispatch("personal", "dm")
  const history = f.store.exchangeHistory(f.a.id, one.child.id, undefined, undefined, undefined, one.route.id)
  expect(history.items.map(x => x.message)).toEqual(["one CONTENT"])
  expect(f.store.exchange(f.a.id, one.child.id, undefined, undefined, one.route.id).message).toBe("one CONTENT")
  expect(f.store.exchangeHistory(f.a.id, own.id).items.map(x => x.message)).toEqual(["PRIVATE CONTENT", "personal CONTENT"])
  expect(personal.child.mockSource?.audienceKey).toBe("desktop")
  expect(() => f.store.exchange(f.a.id, one.child.id)).toThrow("当前会话")
  expect(() => f.store.exchange(f.a.id, own.id, undefined, undefined, one.route.id)).toThrow("当前会话")
  expect(() => f.store.exchangeHistory(f.a.id, one.child.id, undefined, two.child.id, undefined, one.route.id)).toThrow("当前会话")
  expect(() => f.store.exchange(f.b.id, one.child.id, undefined, undefined, one.route.id)).toThrow("招乎群")
  expect(() => f.store.exchange(f.a.id, one.child.id, "other", undefined, one.route.id)).toThrow("范围冲突")
})

it("keeps a stable IM audience through archive, reopen and binding revocation", () => {
  const f = fixture()
  const own = f.privateDispatch(), one = f.imDispatch("one"), two = f.imDispatch("two")
  for (const child of [own, one.child, two.child]) f.finish(child.id)
  f.store.flushReplies()
  for (const task of f.store.recentTasks().filter(t => t.state === "queued")) f.finish(task.id)
  for (const event of [one.event, two.event]) {
    f.store.imGateway.settle(event.id, "completed")
    f.store.imGateway.acknowledged(event.id)
  }
  f.tail(); f.age()
  while (f.store.pruneTaskHistory()) { /* bounded batches until the expired records are archived */ }
  expect(f.native.prepare("SELECT audience_key FROM bot_exchange_archive WHERE id=?").get(one.child.id)).toEqual({ audience_key: `im:${one.route.id}` })
  f.reopen()
  expect(f.store.exchangeHistory(f.a.id, one.child.id, undefined, undefined, undefined, one.route.id).items.map(x => x.message)).toEqual(["one CONTENT"])
  expect(f.store.exchangeHistory(f.a.id, own.id).items.map(x => x.message)).toEqual(["PRIVATE CONTENT"])
  f.store.imGateway.register("realm", "principal", { ...one.binding, version: 2, state: "revoked" })
  expect(f.store.exchange(f.a.id, one.child.id, undefined, undefined, one.route.id).message).toBe("one CONTENT")
  const replacement = f.imDispatch("replacement")
  expect(() => f.store.exchange(f.a.id, one.child.id, undefined, undefined, replacement.route.id)).toThrow("当前会话")
})

it("retains audience isolation across history pages and refreshes", () => {
  const f = fixture()
  const one = Array.from({ length: 33 }, () => f.imDispatch("one"))
  const two = f.imDispatch("two")
  const page = f.store.exchangeHistory(f.a.id, one.at(-1)!.child.id, undefined, undefined, undefined, one[0].route.id)
  expect(page.items).toHaveLength(30)
  expect(page.items.every(x => x.message === "one CONTENT")).toBe(true)
  const older = f.store.exchangeHistory(f.a.id, one.at(-1)!.child.id, undefined, page.before, undefined, one[0].route.id)
  expect(older.items).toHaveLength(3)
  expect(older.before).toBeUndefined()
  expect(f.store.exchange(f.a.id, older.items[0].taskId, undefined, undefined, one[0].route.id).message).toBe("one CONTENT")
  expect(() => f.store.exchangeHistory(f.a.id, one.at(-1)!.child.id, undefined, two.child.id, undefined, one[0].route.id)).toThrow("当前会话")
})
