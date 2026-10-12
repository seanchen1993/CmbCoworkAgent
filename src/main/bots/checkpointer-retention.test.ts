import { afterEach, expect, it, vi } from "vitest"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { conversationId } = store.createBot({ nonce: "bot", name: "Long task" })
  store.send({ nonce: "task", conversationId, text: "Complete the work" })
  const { run, lease } = store.claim("host", 300_000)!
  const saver = new BotCheckpointSaver(store, lease, run.id)
  return { store, run, lease, saver, conversationId }
}
const metadata = (step: number) => ({ source: "loop" as const, step, parents: {} })

it("bounds repeated full snapshots and their tool writes while retaining the resumable head", async () => {
  const f = fixture()
  let config: RunnableConfig = { configurable: { thread_id: f.run.id } }
  const before = f.store.messages(f.conversationId)
  for (let index = 0; index < 40; index++) {
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = { messages: [`step ${index}`] }
    config = await f.saver.put(config, checkpoint, metadata(index))
    await f.saver.putWrites(config, [["messages", `result ${index}`]], "tool")
  }
  const retained = f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints")[0].values[0][0]
  expect(retained).toBeLessThanOrEqual(4)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_writes")[0].values[0][0]).toBe(retained)
  const restartedSaver = new BotCheckpointSaver(f.store, f.lease, f.run.id)
  expect(await restartedSaver.getTuple(config)).toMatchObject({
    checkpoint: { channel_values: { messages: ["step 39"] } },
    pendingWrites: [["tool", "messages", "result 39"]]
  })
  expect(f.store.messages(f.conversationId)).toEqual(before)
  expect(f.store.events().filter((event) => event.kind === "run.checkpoint")).toHaveLength(40)
})

it("pins concurrent result serialization and releases it without resurrecting retired writes", async () => {
  const f = fixture()
  let config = await f.saver.put(
    { configurable: { thread_id: f.run.id } },
    emptyCheckpoint(),
    metadata(0)
  )
  const original = config
  const releases: (() => void)[] = []
  let started!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    const encoded = await serialize(value)
    if (value === "result-a" || value === "result-b") {
      await new Promise<void>((resolve) => {
        releases.push(resolve)
        if (releases.length === 2) started()
      })
    }
    return encoded
  })
  const a = f.saver.putWrites(original, [["messages", "result-a"]], "tool-a")
  const b = f.saver.putWrites(original, [["messages", "result-b"]], "tool-b")
  try {
    await bothStarted
    for (let step = 1; step < 10; step++)
      config = await f.saver.put(config, emptyCheckpoint(), metadata(step))
    expect(await f.saver.getTuple(original)).toBeDefined()
    releases[0]()
    await a
    config = await f.saver.put(config, emptyCheckpoint(), metadata(10))
    expect(await f.saver.getTuple(original)).toBeDefined()
    releases[1]()
    await b
    expect((await f.saver.getTuple(original))?.pendingWrites).toHaveLength(2)
    await f.saver.put(config, emptyCheckpoint(), metadata(11))
    expect(await f.saver.getTuple(original)).toBeUndefined()
    await expect(
      f.saver.putWrites(original, [["messages", "late"]], "old-tool")
    ).rejects.toMatchObject({ code: "checkpoint_unavailable" })
    expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_writes")[0].values[0][0]).toBe(0)
  } finally {
    releases.forEach((release) => release())
    await Promise.allSettled([a, b])
  }
})

it("rolls checkpoint cleanup and the new head back together when deletion fails", async () => {
  const f = fixture()
  let config: RunnableConfig = { configurable: { thread_id: f.run.id } }
  for (let step = 0; step < 4; step++) {
    config = await f.saver.put(config, emptyCheckpoint(), metadata(step))
    await f.saver.putWrites(config, [["messages", `result ${step}`]], "tool")
  }
  const head = f.store.getRun(f.run.id).checkpoint
  const next = emptyCheckpoint()
  const run = f.store.db.run.bind(f.store.db)
  const fault = vi.spyOn(f.store.db, "run").mockImplementation((sql, args) => {
    if (sql.startsWith("DELETE FROM bot_graph_checkpoints")) throw new Error("cleanup failed")
    return run(sql, args)
  })
  await expect(f.saver.put(config, next, metadata(4))).rejects.toThrow("cleanup failed")
  expect(f.store.getRun(f.run.id).checkpoint).toBe(head)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints")[0].values[0][0]).toBe(4)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_writes")[0].values[0][0]).toBe(4)
  fault.mockRestore()
  const advanced = await f.saver.put(config, next, metadata(4))
  expect((await f.saver.getTuple(advanced))?.metadata?.step).toBe(4)
})

it("isolates retention by task and namespace and permits writes before their new checkpoint", async () => {
  const f = fixture()
  const { conversationId } = f.store.createBot({ nonce: "second", name: "Other task" })
  f.store.send({ nonce: "second-task", conversationId, text: "Independent" })
  const other = f.store.claim("other-host", 300_000)!
  const otherSaver = new BotCheckpointSaver(f.store, other.lease, other.run.id)
  const otherConfig = await otherSaver.put(
    { configurable: { thread_id: other.run.id } },
    emptyCheckpoint(),
    metadata(0)
  )
  const childConfig = await f.saver.put(
    { configurable: { thread_id: f.run.id, checkpoint_ns: "internal" } },
    emptyCheckpoint(),
    metadata(0)
  )
  let config: RunnableConfig = { configurable: { thread_id: f.run.id } }
  for (let step = 0; step < 12; step++)
    config = await f.saver.put(config, emptyCheckpoint(), metadata(step))
  const checkpoint = emptyCheckpoint()
  const incoming = { configurable: { thread_id: f.run.id, checkpoint_id: checkpoint.id } }
  await f.saver.putWrites(incoming, [["messages", "early"]], "tool")
  await f.saver.put(config, checkpoint, metadata(12))
  expect((await f.saver.getTuple(incoming))?.pendingWrites).toEqual([["tool", "messages", "early"]])
  expect(await otherSaver.getTuple(otherConfig)).toBeDefined()
  expect(await f.saver.getTuple(childConfig)).toBeDefined()
})

it("cleans legacy history in bounded batches without loading snapshot payloads", async () => {
  const f = fixture()
  let config = await f.saver.put(
    { configurable: { thread_id: f.run.id } },
    emptyCheckpoint(),
    metadata(0)
  )
  f.store.transaction(() => {
    for (let step = 0; step < 200; step++)
      f.store.db.run(
        "INSERT INTO bot_graph_checkpoints SELECT thread_id,ns,?,NULL,type,data,metadata_type,metadata FROM bot_graph_checkpoints WHERE thread_id=? AND id=?",
        [
          `00000000-0000-0000-0000-${String(step).padStart(12, "0")}`,
          f.run.id,
          String(config.configurable?.checkpoint_id)
        ]
      )
  })
  config = await f.saver.put(config, emptyCheckpoint(), metadata(1))
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints")[0].values[0][0]).toBe(138)
  for (let step = 2; step < 6; step++)
    config = await f.saver.put(config, emptyCheckpoint(), metadata(step))
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints")[0].values[0][0]).toBe(4)
  expect(await f.saver.getTuple(config)).toBeDefined()
})

it.each([
  { data: 4, metadata: 3, writes: 4, removed: 2 },
  { data: 16, metadata: 16, writes: 16, removed: 1 }
])("bounds legacy cleanup bytes including metadata and results: %j", async (size) => {
  const f = fixture()
  const config = await f.saver.put(
    { configurable: { thread_id: f.run.id } },
    emptyCheckpoint(),
    metadata(0)
  )
  const mib = 1024 * 1024
  f.store.transaction(() => {
    for (let index = 0; index < 5; index++) {
      const id = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`
      // The three oldest records are eligible; newer records stay protected.
      const bytes = index < 3 ? mib : 1
      // Deliberately opaque legacy payloads: retention must never deserialize them.
      f.store.db.run(
        "INSERT INTO bot_graph_checkpoints VALUES(?,?,?,NULL,'json',zeroblob(?),'json',zeroblob(?))",
        [f.run.id, "", id, size.data * bytes, size.metadata * bytes]
      )
      f.store.db.run(
        "INSERT INTO bot_graph_writes VALUES(?,?,?,'tool',0,'messages','json',zeroblob(?))",
        [f.run.id, "", id, size.writes * bytes]
      )
    }
  })
  const next = await f.saver.put(config, emptyCheckpoint(), metadata(1))
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_checkpoints")[0].values[0][0]).toBe(
    7 - size.removed
  )
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_graph_writes")[0].values[0][0]).toBe(
    5 - size.removed
  )
  expect((await f.saver.getTuple(next))?.metadata?.step).toBe(1)
})
