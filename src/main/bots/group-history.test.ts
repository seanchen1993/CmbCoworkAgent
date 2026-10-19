import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function historyFixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const bot = store.create({ name: "History", instructions: "", color: "#ea2845", modelRef: null })
  const a = store.saveGroup({ name: "A", memberIds: [bot.id] })
  const b = store.saveGroup({ name: "B", memberIds: [bot.id] })
  for (let index = 1; index <= 80; index++) {
    for (const [prefix, groupId, offset] of [
      ["a", a.id, 0],
      ["b", b.id, 50]
    ] as const) {
      db.run(
        `INSERT INTO bot_group_messages
         (ordinal,id,group_id,author_bot_id,text,targets_json,created_at,reply_to_id)
         VALUES (?,?,?,NULL,?,'[]',?,?)`,
        [
          index * 100 + offset,
          `${prefix}-${index}`,
          groupId,
          `${prefix} ${index}`,
          index,
          index === 40 ? `${prefix}-39` : null
        ]
      )
    }
  }
  return { store, a, b }
}

describe("bounded group history windows", () => {
  it("retains backward cursor ordering and group isolation", () => {
    const { store, a } = historyFixture()
    const latest = store.groupMessages(a.id)
    expect(latest.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `a-${index + 31}`)
    )
    const older = store.groupMessages(a.id, latest[0].ordinal)
    expect(older.map((item) => item.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `a-${index + 1}`)
    )
  })

  it("opens exact targets with following context despite sparse global ordinals", () => {
    const { store, a } = historyFixture()
    const page = store.groupMessages(a.id, { targetMessageId: "a-40" })
    expect(page.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `a-${index + 16}`)
    )
    expect(page.find((item) => item.id === "a-40")?.replyTo).toEqual({
      id: "a-39",
      ordinal: 3900,
      authorBotId: null,
      text: "a 39"
    })
    expect(store.groupMessages(a.id, page[0].ordinal).at(-1)?.id).toBe("a-15")
  })

  it("includes following context for the earliest target and remains bounded at the end", () => {
    const { store, a } = historyFixture()
    const first = store.groupMessages(a.id, { targetMessageId: "a-1" })
    expect(first.map((item) => item.id)).toEqual(
      Array.from({ length: 26 }, (_, index) => `a-${index + 1}`)
    )
    expect(store.groupMessages(a.id, { targetMessageId: "a-80" })).toEqual(
      store.groupMessages(a.id)
    )
  })

  it("rejects unavailable and other-group targets without reading their context", () => {
    const { store, a } = historyFixture()
    for (const targetMessageId of ["b-40", "missing"]) {
      expect(() => store.groupMessages(a.id, { targetMessageId })).toThrow("被回复的消息已不可用")
    }
    expect(() => store.groupMessages("missing-group", { targetMessageId: "a-40" })).toThrow()
  })
})
