import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { BOT_REQUEST_RECEIPT_RETENTION_MS } from "../../shared/bots/contracts"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let now = 1000
  const store = new BotStore(db, () => now)
  const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
  const peer = store.create({ name: "B", instructions: "", color: "#ea2845", modelRef: null })
  return {
    db,
    store,
    bot,
    peer,
    advance: (ms: number) => {
      now += ms
    }
  }
}
const check = (requestId: string, message = "Synthetic") => ({
  requestId,
  messageHash: createHash("sha256").update(message).digest("hex")
})

describe("private Bot inbox receipts", () => {
  it("distinguishes accepted, conflicting and absent requests before any transcript exists", () => {
    const f = fixture()
    const task = f.store.enqueue({ botId: f.bot.id, requestId: "first", message: "Synthetic" })
    expect(f.store.requestReceipts(f.bot.id, [check("first"), check("missing")])).toEqual([
      { requestId: "first", state: "accepted" },
      { requestId: "missing", state: "absent" }
    ])
    expect(f.store.requestReceipts(f.bot.id, [check("first", "Changed")])[0].state).toBe("conflict")
    expect(f.store.requestReceipts(f.peer.id, [check("first")])[0]).toEqual({
      requestId: "first",
      state: "conflict"
    })
    f.store.transition(task.id, "cancelled")
    expect(f.store.requestReceipts(f.bot.id, [check("first")])[0].state).toBe("accepted")
  })
  it("confines group requests and rejects invalid batches at the domain boundary", () => {
    const f = fixture()
    f.store.enqueue(
      { botId: f.bot.id, requestId: "group-request", message: "Synthetic" },
      { kind: "group", groupId: "g", messageId: "m" }
    )
    expect(f.store.requestReceipts(f.bot.id, [check("group-request")])[0]).toEqual({
      requestId: "group-request",
      state: "conflict"
    })
    expect(() => f.store.requestReceipts(f.bot.id, [check("a"), check("a")])).toThrow()
    expect(() =>
      f.store.requestReceipts(
        f.bot.id,
        Array.from({ length: 33 }, (_, i) => check(`r-${i}`))
      )
    ).toThrow()
    expect(f.store.requestReceipts(f.bot.id, [])).toEqual([])
  })
  it("uses compact receipts after pruning, preserves replay prevention, and shares the retention cutoff", () => {
    const f = fixture()
    const task = f.store.enqueue({ botId: f.bot.id, requestId: "old", message: "Synthetic" })
    f.store.transition(task.id, "cancelled")
    f.advance(1)
    for (let i = 0; i < 100; i++) {
      const tail = f.store.enqueue({ botId: f.bot.id, requestId: `tail-${i}`, message: "Tail" })
      f.store.transition(tail.id, "cancelled")
    }
    f.advance(31 * 86400000)
    expect(f.store.pruneTaskHistory()).toBe(1)
    expect(() => f.store.getTask(task.id)).toThrow()
    expect(f.store.requestReceipts(f.bot.id, [check("old")])[0].state).toBe("accepted")
    expect(f.store.requestReceipts(f.bot.id, [check("old", "changed")])[0].state).toBe("conflict")
    expect(() =>
      f.store.enqueue({ botId: f.bot.id, requestId: "old", message: "Synthetic" })
    ).toThrow()
    f.advance(BOT_REQUEST_RECEIPT_RETENTION_MS)
    f.store.pruneTaskHistory()
    expect(f.store.requestReceipts(f.bot.id, [check("old")])[0].state).toBe("absent")
  })
})
