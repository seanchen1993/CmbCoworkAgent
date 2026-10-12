import { afterEach, expect, it, vi } from "vitest"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

async function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { conversationId } = store.createBot({ nonce: "bot", name: "Checkpoint limits" })
  store.send({ nonce: "task", conversationId, text: "work" })
  const { run, lease } = store.claim("host", 60_000)!
  const saver = new BotCheckpointSaver(store, lease, run.id)
  const checkpoint = emptyCheckpoint()
  const config = await saver.put({ configurable: { thread_id: run.id } }, checkpoint, {
    source: "loop",
    step: 0,
    parents: {}
  })
  return { store, run, saver, config, checkpoint }
}

it("rejects oversized metadata without replacing the durable checkpoint", async () => {
  const f = await fixture()
  const changed = { ...f.checkpoint, channel_values: { messages: ["must not commit"] } }
  await expect(
    f.saver.put(f.config, changed, {
      source: "loop",
      step: 1,
      parents: { ["x".repeat(18 * 1024 * 1024)]: "parent" }
    })
  ).rejects.toMatchObject({ code: "checkpoint_size" })
  const saved = await f.saver.getTuple(f.config)
  expect(saved?.checkpoint.channel_values).toEqual({})
  expect(saved?.metadata?.step).toBe(0)
})

it("bounds accumulated tool writes atomically, while preserving retry semantics", async () => {
  const f = await fixture()
  const value = "e".repeat(6 * 1024 * 1024)
  await f.saver.putWrites(f.config, [["messages", value]], "tool-a")
  await f.saver.putWrites(f.config, [["messages", value]], "tool-b")
  // A replay is ignored by LangGraph identity, even when its supplied value differs.
  await f.saver.putWrites(f.config, [["messages", "must not replace"]], "tool-a")
  await expect(
    f.saver.putWrites(
      f.config,
      [
        ["small", "must roll back"],
        ["messages", value]
      ],
      "tool-c"
    )
  ).rejects.toMatchObject({ code: "checkpoint_size" })
  const saved = await f.saver.getTuple(f.config)
  expect(saved?.pendingWrites).toEqual([
    ["tool-a", "messages", value],
    ["tool-b", "messages", value]
  ])
  // Another checkpoint has its own budget; normal progress remains possible.
  const next = await f.saver.put(f.config, emptyCheckpoint(), {
    source: "loop",
    step: 1,
    parents: {}
  })
  await f.saver.putWrites(next, [["messages", value]], "tool-c")
  expect((await f.saver.getTuple(next))?.pendingWrites).toHaveLength(1)
})

it("rejects a huge write batch before allocating serialized copies", async () => {
  const f = await fixture()
  const serialize = vi.spyOn(f.saver.serde, "dumpsTyped")
  await expect(
    f.saver.putWrites(
      f.config,
      Array.from({ length: 10_000 }, () => ["messages", "x"]),
      "tool"
    )
  ).rejects.toMatchObject({ code: "checkpoint_size" })
  expect(serialize).not.toHaveBeenCalled()
  expect((await f.saver.getTuple(f.config))?.pendingWrites).toEqual([])
})

it("preserves an error write when an over-budget replacement rolls back", async () => {
  const f = await fixture()
  await f.saver.putWrites(f.config, [["messages", "e".repeat(10 * 1024 * 1024)]], "tool-a")
  await f.saver.putWrites(f.config, [["__error__", "original error"]], "tool-b")
  await expect(
    f.saver.putWrites(f.config, [["__error__", "e".repeat(8 * 1024 * 1024)]], "tool-b")
  ).rejects.toMatchObject({ code: "checkpoint_size" })
  expect((await f.saver.getTuple(f.config))?.pendingWrites?.[1]).toEqual([
    "tool-b",
    "__error__",
    "original error"
  ])
  await f.saver.putWrites(f.config, [["__error__", "updated error"]], "tool-b")
  expect((await f.saver.getTuple(f.config))?.pendingWrites?.[1]).toEqual([
    "tool-b",
    "__error__",
    "updated error"
  ])
})

it("stops serialization when the run is cancelled and commits no partial writes", async () => {
  const f = await fixture()
  const original = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  const serialize = vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    const encoded = await original(value)
    f.store.cancel(f.run.id)
    return encoded
  })
  await expect(
    f.saver.putWrites(
      f.config,
      [
        ["a", "first"],
        ["b", "second"]
      ],
      "tool"
    )
  ).rejects.toThrow()
  expect(serialize).toHaveBeenCalledTimes(1)
  expect((await f.saver.getTuple(f.config))?.pendingWrites).toEqual([])
})
