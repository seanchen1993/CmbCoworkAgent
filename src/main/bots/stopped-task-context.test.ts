import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db, () => 1000)
  const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
  const peer = store.create({ name: "B", instructions: "", color: "#ea2845", modelRef: null })
  return { store, bot, peer }
}

describe("Bot stopped task context", () => {
  it("provides actual stopped receipts, excluding other Bots, group work and unfinished tasks", () => {
    const { store, bot, peer } = fixture()
    const stopped = store.enqueue({ botId: bot.id, requestId: "stopped", message: "Prior work" })
    store.transition(stopped.id, "cancelled")
    const interrupted = store.enqueue(
      { botId: bot.id, requestId: "interrupted", message: "Original workflow result" },
      { kind: "notification", notificationKind: "workflow", key: "wf_old", runStartedAt: "old" }
    )
    store.transition(interrupted.id, "running")
    store.transition(interrupted.id, "interrupted")
    for (const [requestId, botId, origin] of [
      ["foreign", peer.id, undefined],
      ["group", bot.id, { kind: "group" as const, groupId: "g", messageId: "m" }]
    ] as const) {
      const task = store.enqueue({ botId, requestId, message: "PRIVATE_OR_GROUP" }, origin)
      store.transition(task.id, "cancelled")
    }
    const completed = store.enqueue({ botId: bot.id, requestId: "done", message: "Finished work" })
    store.transition(completed.id, "running")
    store.transition(completed.id, "completed")
    const active = store.enqueue({ botId: bot.id, requestId: "active", message: "Active work" })
    store.transition(active.id, "running")
    store.enqueue({ botId: bot.id, requestId: "queued", message: "Pending work" })
    const current = store.enqueue({ botId: bot.id, requestId: "new", message: "New assignment" })
    expect(store.stoppedTaskContext(current.id)).toEqual([
      {
        taskId: interrupted.id,
        state: "interrupted",
        source: "notification",
        reference: { kind: "workflow", key: "wf_old", runStartedAt: "old" },
        messagePreview: "Original workflow result"
      },
      { taskId: stopped.id, state: "cancelled", source: "user", messagePreview: "Prior work" }
    ])
    expect(store.stoppedTaskContext(interrupted.id)).toEqual([])
    expect(() => store.stoppedTaskContext("missing")).toThrow()
  })
  it("bounds receipt count and previews, including tied timestamps, without changing control state", () => {
    const { store, bot } = fixture()
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const t = store.enqueue({ botId: bot.id, requestId: `old-${i}`, message: "界".repeat(1000) })
      store.transition(t.id, "cancelled")
      ids.push(t.id)
    }
    const current = store.enqueue({ botId: bot.id, requestId: "current", message: "New work" })
    const before = { tasks: store.recentTasks(), revision: store.revision() }
    const result = store.stoppedTaskContext(current.id)
    expect(result.map((row) => row.taskId)).toEqual(ids.slice(-4).reverse())
    expect(result.every((row) => row.messagePreview === "界".repeat(240))).toBe(true)
    expect({ tasks: store.recentTasks(), revision: store.revision() }).toEqual(before)
  })
})
