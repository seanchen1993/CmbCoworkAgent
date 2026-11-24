import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"

const databases: NativeSqliteAdapter[] = []
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const bot = store.create({
    name: "Synthetic",
    instructions: "",
    color: "#ea2845",
    modelRef: null
  })
  return { db, store, bot }
}
afterEach(() => {
  vi.restoreAllMocks()
  databases.splice(0).forEach((db) => db.close())
})

describe("Bot first conversation", () => {
  it("persists one introduction across opening, restart and history removal", () => {
    const { db, store, bot } = fixture()
    const task = store.introduce(bot.id)!
    expect(task.origin.kind).toBe("introduction")
    expect(store.introduce(bot.id)).toBeNull()
    store.transition(task.id, "running")
    store.settle(task.id, "completed", null, "Hello")
    db.run("DELETE FROM bot_tasks WHERE id=?", [task.id])
    expect(new BotStore(db).introduce(bot.id)).toBeNull()
  })

  it("does not send a new greeting to legacy Bots after schema migration", () => {
    const { db, bot } = fixture()
    db.run("ALTER TABLE bots DROP COLUMN introduction_pending")
    expect(new BotStore(db).introduce(bot.id)).toBeNull()
  })

  it("rolls back the first-run claim when enqueue fails", () => {
    const { store, bot } = fixture()
    const enqueue = vi.spyOn(store, "enqueue").mockImplementationOnce(() => {
      throw new Error("synthetic queue failure")
    })
    expect(() => store.introduce(bot.id)).toThrow("synthetic queue failure")
    enqueue.mockRestore()
    expect(store.introduce(bot.id)?.origin.kind).toBe("introduction")
  })

  it.each([false, true])("prioritizes the actual first message (greeting queued=%s)", (queued) => {
    const { store, bot } = fixture()
    const intro = queued ? store.introduce(bot.id)! : null
    const user = store.enqueue({ botId: bot.id, requestId: "first", message: "Do this" })
    if (intro) expect(store.getTask(intro.id).state).toBe("cancelled")
    expect(store.nextQueued([])?.id).toBe(user.id)
    expect(store.introduce(bot.id)).toBeNull()
  })

  it("requires a consumed direct message before allowing profile changes during introduction", () => {
    const { store, bot } = fixture()
    const intro = store.introduce(bot.id)!
    store.transition(intro.id, "running")
    expect(() => store.updateOwnProfile(intro.id, { name: "Unrequested" })).toThrow()
    const user = store.enqueue({
      botId: bot.id,
      requestId: "name",
      message: "Call yourself Example"
    })
    expect(store.hasDirectUserRequest(intro.id)).toBe(false)
    store.injectIntoRun(user.id, intro.id)
    expect(store.updateOwnProfile(intro.id, { name: "Example" }).name).toBe("Example")
    store.settleRun(intro.id, [user.id], "completed", null, "Done")
    expect(store.getTask(user.id).state).toBe("completed")
    expect(store.hasDirectUserRequest(intro.id)).toBe(false)
  })

  it("does not start archived Bots or repeat an interrupted introduction", () => {
    const { store, bot } = fixture()
    const archived = store.update({ ...bot, archived: true, expectedVersion: bot.version })
    expect(store.introduce(bot.id)).toBeNull()
    store.update({ ...archived, archived: false, expectedVersion: archived.version })
    const intro = store.introduce(bot.id)!
    store.transition(intro.id, "running")
    store.recover()
    expect(store.getTask(intro.id).state).toBe("interrupted")
    expect(store.introduce(bot.id)).toBeNull()
  })
})
