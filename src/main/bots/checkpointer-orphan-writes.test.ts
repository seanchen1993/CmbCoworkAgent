import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"
import { pinBotCheckpointResults } from "./checkpoint-queue"

const stores = new Set<BotStore>()
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const identity = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`
const checkpoint = (value: number) => ({ ...emptyCheckpoint(), id: identity(value) })
const metadata = (step: number) => ({ source: "loop" as const, step, parents: {} })
function fixture(path = ":memory:") {
  const store = new BotStore(path)
  stores.add(store)
  const { conversationId } = store.createBot({ nonce: "bot", name: "Interrupted task" })
  store.send({ nonce: "task", conversationId, text: "Complete the work" })
  const { run, lease } = store.claim("host", 300_000)!
  const saver = new BotCheckpointSaver(store, lease, run.id)
  const config = (value?: number, ns = ""): RunnableConfig => ({
    configurable: {
      thread_id: run.id,
      checkpoint_ns: ns,
      ...(value === undefined ? {} : { checkpoint_id: identity(value) })
    }
  })
  return { store, run, lease, saver, config }
}
function writes(store: BotStore, id?: string) {
  return Number(
    store.db.exec(
      `SELECT COUNT(*) FROM bot_graph_writes${id ? " WHERE checkpoint_id=?" : ""}`,
      id ? [id] : []
    )[0].values[0][0]
  )
}

it("collects unpublished results after reopening loses the old process's pins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-checkpoint-orphans-"))
  directories.push(directory)
  const path = join(directory, "bots.sqlite")
  const f = fixture(path)
  const original = await f.saver.put(f.config(), checkpoint(10), metadata(0))
  await f.saver.putWrites(f.config(20), [["messages", "result before graph publication"]], "tool")
  const release = pinBotCheckpointResults(f.store, f.run.id, "", identity(20))
  f.store.close()
  stores.delete(f.store)
  const reopened = new BotStore(path)
  stores.add(reopened)
  const saver = new BotCheckpointSaver(reopened, f.lease, f.run.id)
  try {
    const next = await saver.put(original, checkpoint(30), metadata(1))
    expect(writes(reopened)).toBe(0)
    expect((await saver.getTuple(next))?.metadata?.step).toBe(1)
    expect((await saver.getTuple(original))?.metadata?.step).toBe(0)
  } finally {
    release()
  }
})

it("preserves future publication and isolates orphan cleanup by task and namespace", async () => {
  const f = fixture()
  let config = await f.saver.put(f.config(), checkpoint(10), metadata(0))
  await f.saver.putWrites(f.config(40), [["messages", "future result"]], "future")
  await f.saver.putWrites(f.config(15, "internal"), [["messages", "independent"]], "other")
  const { conversationId } = f.store.createBot({ nonce: "other-bot", name: "Other task" })
  f.store.send({ nonce: "other-task", conversationId, text: "Independent work" })
  const other = f.store.claim("other-host", 300_000)!
  const otherSaver = new BotCheckpointSaver(f.store, other.lease, other.run.id)
  await otherSaver.putWrites(
    { configurable: { thread_id: other.run.id, checkpoint_id: identity(15) } },
    [["messages", "other task result"]],
    "other-task-tool"
  )
  config = await f.saver.put(config, checkpoint(20), metadata(1))
  expect(writes(f.store, identity(40))).toBe(1)
  expect(writes(f.store, identity(15))).toBe(2)
  const published = await f.saver.put(config, checkpoint(40), metadata(2))
  expect((await f.saver.getTuple(published))?.pendingWrites).toEqual([
    ["future", "messages", "future result"]
  ])
})

it("keeps an unpublished original parent until the following checkpoint no longer depends on it", async () => {
  const f = fixture()
  await f.saver.putWrites(f.config(10), [["messages", "original parent result"]], "tool")
  const next = await f.saver.put(f.config(10), checkpoint(20), metadata(0))
  expect(writes(f.store, identity(10))).toBe(1)
  await f.saver.put(next, checkpoint(30), metadata(1))
  expect(writes(f.store)).toBe(0)
})

it("protects unpublished results during serde and collects them after the expired write releases its pin", async () => {
  const f = fixture()
  let config = await f.saver.put(f.config(), checkpoint(10), metadata(0))
  await f.saver.putWrites(f.config(20), [["messages", "committed before publication"]], "first")
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    if (value === "held result") {
      entered()
      await gate
    }
    return serialize(value)
  })
  const pending = f.saver.putWrites(f.config(20), [["messages", "held result"]], "second")
  // Observe rejection immediately, including when cleanup has advanced the head.
  const settled = pending.then(
    () => null,
    (error: unknown) => error
  )
  try {
    await started
    const other = new BotCheckpointSaver(f.store, f.lease, f.run.id)
    config = await other.put(config, checkpoint(30), metadata(1))
    expect(writes(f.store, identity(20))).toBe(1)
    release()
    expect(await settled).toMatchObject({ code: "checkpoint_unavailable" })
    await other.put(config, checkpoint(40), metadata(2))
    expect(writes(f.store)).toBe(0)
  } finally {
    release()
    await settled
  }
})

it("rolls orphan cleanup, the graph head, run pointer and event back together", async () => {
  const f = fixture()
  const config = await f.saver.put(f.config(), checkpoint(10), metadata(0))
  await f.saver.putWrites(f.config(20), [["messages", "unpublished result"]], "tool")
  const before = f.store.getRun(f.run.id)
  const original = f.store.db.run.bind(f.store.db)
  const fault = vi.spyOn(f.store.db, "run").mockImplementation((sql, args) => {
    if (sql.startsWith("DELETE FROM bot_graph_writes")) throw new Error("orphan cleanup failed")
    return original(sql, args)
  })
  await expect(f.saver.put(config, checkpoint(30), metadata(1))).rejects.toThrow(
    "orphan cleanup failed"
  )
  expect(writes(f.store)).toBe(1)
  expect(f.store.getRun(f.run.id).checkpoint).toBe(before.checkpoint)
  expect(f.store.getRun(f.run.id).revision).toBe(before.revision)
  expect(await f.saver.getTuple(f.config(30))).toBeUndefined()
  expect(f.store.events().filter((event) => event.kind === "run.checkpoint")).toHaveLength(1)
  fault.mockRestore()
  const next = await f.saver.put(config, checkpoint(30), metadata(1))
  expect(writes(f.store)).toBe(0)
  expect((await f.saver.getTuple(next))?.metadata?.step).toBe(1)
})

it("cannot clean durable results after its task lease is cancelled during metadata encoding", async () => {
  const f = fixture()
  const config = await f.saver.put(f.config(), checkpoint(10), metadata(0))
  await f.saver.putWrites(f.config(20), [["messages", "durable orphan"]], "tool")
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    if (value && typeof value === "object" && "source" in value) f.store.cancel(f.run.id)
    return serialize(value)
  })
  await expect(f.saver.put(config, checkpoint(30), metadata(1))).rejects.toMatchObject({
    code: "stale_lease"
  })
  expect(writes(f.store)).toBe(1)
  expect(await f.saver.getTuple(f.config(30))).toBeUndefined()
})

it("shares the bounded cleanup count between graph history and unpublished result identities", async () => {
  const f = fixture()
  let config = await f.saver.put(f.config(), checkpoint(1000), metadata(0))
  f.store.transaction(() => {
    for (let index = 0; index < 200; index++) {
      const id = identity(index)
      if (index % 2 === 0)
        f.store.db.run(
          "INSERT INTO bot_graph_checkpoints SELECT thread_id,ns,?,NULL,type,data,metadata_type,metadata FROM bot_graph_checkpoints WHERE thread_id=? AND id=?",
          [id, f.run.id, identity(1000)]
        )
      else
        f.store.db.run(
          "INSERT INTO bot_graph_writes VALUES(?,?,?,'tool',0,'messages','json',zeroblob(1))",
          [f.run.id, "", id]
        )
    }
  })
  const records = () =>
    Number(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints")[0].values[0][0]) +
    writes(f.store)
  const before = records()
  config = await f.saver.put(config, checkpoint(1001), metadata(1))
  expect(before + 1 - records()).toBe(64)
  expect(writes(f.store)).toBe(68)
  for (let step = 2; step <= 5; step++)
    config = await f.saver.put(config, checkpoint(1000 + step), metadata(step))
  expect(writes(f.store)).toBe(0)
  expect(records()).toBe(4)
  expect((await f.saver.getTuple(config))?.metadata?.step).toBe(5)
})

it("bounds orphan cleanup bytes without copying opaque stored payloads into the Host", async () => {
  const f = fixture()
  const config = await f.saver.put(f.config(), checkpoint(100), metadata(0))
  f.store.transaction(() => {
    for (let index = 0; index < 4; index++)
      f.store.db.run(
        "INSERT INTO bot_graph_writes VALUES(?,?,?,'tool',0,'messages','json',zeroblob(?))",
        [f.run.id, "", identity(index), 12 * 1024 * 1024]
      )
  })
  const next = await f.saver.put(config, checkpoint(101), metadata(1))
  expect(writes(f.store)).toBe(2)
  expect((await f.saver.getTuple(next))?.metadata?.step).toBe(1)
})
