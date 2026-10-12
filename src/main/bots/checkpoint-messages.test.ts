import { afterEach, expect, it, vi } from "vitest"
import { emptyCheckpoint, type Checkpoint } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages"
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
  const { conversationId } = store.createBot({ nonce: "bot", name: "Incremental task" })
  store.send({ nonce: "task", conversationId, text: "Complete the work" })
  const { run, lease } = store.claim("host", 300_000)!
  const saver = new BotCheckpointSaver(store, lease, run.id)
  const fresh = () => new BotCheckpointSaver(store, lease, run.id)
  const root = { configurable: { thread_id: run.id } }
  const put = (config: RunnableConfig, messages: unknown[], step = 0, checkpoint?: Checkpoint) =>
    saver.put(
      config,
      { ...(checkpoint ?? emptyCheckpoint()), channel_values: { messages } },
      { source: "loop", step, parents: {} }
    )
  return { store, run, lease, saver, fresh, root, put }
}
function count(store: BotStore, table: string) {
  return Number(store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0])
}

it("serializes appended messages without serializing the unchanged long history again", async () => {
  const f = fixture()
  let messages = Array.from(
    { length: 120 },
    (_, index) => new HumanMessage({ id: `m${index}`, content: `${index}:` + "e".repeat(2000) })
  )
  let config = await f.put(f.root, messages)
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  let serializedBytes = 0
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    const encoded = await serialize(value)
    serializedBytes += encoded[1].length
    return encoded
  })
  for (let index = 0; index < 24; index++) {
    messages = [...messages, new HumanMessage({ id: `new${index}`, content: `new ${index}` })]
    config = await f.put(config, messages, index + 1)
  }
  expect(serializedBytes).toBeLessThan(64 * 1024)
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(messages)
  expect(count(f.store, "bot_graph_checkpoints")).toBe(4)
  expect(count(f.store, "bot_graph_message_heads")).toBe(4)
  expect(
    Number(
      f.store.db.exec("SELECT SUM(LENGTH(data)) FROM bot_graph_message_snapshots")[0].values[0][0]
    )
  ).toBeLessThan(400 * 1024)
})

it("preserves replacements, deletions and in-place array edits instead of sampling the prefix", async () => {
  const f = fixture()
  const messages: unknown[] = Array.from(
    { length: 200 },
    (_, index) => new HumanMessage({ id: `m${index}`, content: `message ${index}` })
  )
  let config = await f.put(f.root, messages)
  messages[37] = new AIMessage({ id: "changed", content: "replacement in old history" })
  messages.push(new ToolMessage({ tool_call_id: "tool", content: "result" }))
  config = await f.put(config, messages)
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(messages)
  const shorter = messages.slice(0, 80)
  config = await f.put(config, shorter)
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(shorter)
  config = await f.put(config, [])
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual([])
})

it("keeps a child's immutable message parent when its graph checkpoint identity is overwritten", async () => {
  const f = fixture(),
    a = emptyCheckpoint()
  const original = [new HumanMessage("original")]
  const first = await f.put(f.root, original, 0, a)
  const next = [...original, new AIMessage("child")]
  const second = await f.put(first, next)
  await f.put(f.root, [new HumanMessage("replacement")], 2, a)
  expect((await f.fresh().getTuple(second))?.checkpoint.channel_values.messages).toEqual(next)
  expect((await f.fresh().getTuple(first))?.checkpoint.channel_values.messages).toEqual([
    new HumanMessage("replacement")
  ])
})

it("rebases bounded delta chains and collects only ancestors that no retained head needs", async () => {
  const f = fixture()
  let config: RunnableConfig = f.root,
    messages: unknown[] = []
  for (let index = 0; index < 270; index++) {
    messages = [...messages, new HumanMessage(`step ${index}`)]
    config = await f.put(config, messages, index)
  }
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(messages)
  expect(count(f.store, "bot_graph_checkpoints")).toBe(4)
  expect(count(f.store, "bot_graph_message_snapshots")).toBeLessThanOrEqual(128 + 4)
  expect(
    Number(f.store.db.exec("SELECT MAX(depth) FROM bot_graph_message_snapshots")[0].values[0][0])
  ).toBeLessThanOrEqual(128)
  for await (const tuple of f.fresh().list(f.root)) {
    const step = Number(tuple.metadata!.step)
    expect(tuple.checkpoint.channel_values.messages).toEqual(messages.slice(0, step + 1))
  }
})

it.each(["missing", "cycle", "prefix"])("fails closed on a %s message chain", async (damage) => {
  const f = fixture(),
    messages = [new HumanMessage("base")]
  let config = await f.put(f.root, messages)
  config = await f.put(config, [...messages, new AIMessage("tail")])
  if (damage === "missing")
    f.store.db.run("DELETE FROM bot_graph_message_snapshots WHERE parent_id IS NULL")
  if (damage === "cycle")
    f.store.db.run(
      "UPDATE bot_graph_message_snapshots SET parent_id=id WHERE parent_id IS NOT NULL"
    )
  if (damage === "prefix")
    f.store.db.run(
      "UPDATE bot_graph_message_snapshots SET prefix_length=9999 WHERE parent_id IS NOT NULL"
    )
  await expect(f.fresh().getTuple(config)).rejects.toMatchObject({
    code: "checkpoint_messages_unavailable"
  })
})

it("preserves the aggregate history limit when each individual suffix would fit", async () => {
  const f = fixture(),
    messages = [new HumanMessage("x".repeat(13 * 1024 * 1024))]
  const config = await f.put(f.root, messages)
  await expect(
    f.put(config, [...messages, new HumanMessage("y".repeat(4 * 1024 * 1024))])
  ).rejects.toMatchObject({ code: "checkpoint_size" })
  expect(count(f.store, "bot_graph_message_heads")).toBe(1)
  expect(count(f.store, "bot_graph_message_snapshots")).toBe(1)
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(messages)
})

it("orders concurrent savers for one namespace while other namespaces can progress", async () => {
  const f = fixture(),
    original = [new HumanMessage("base")]
  const config = await f.put(f.root, original)
  const aCheckpoint = emptyCheckpoint(),
    aMessage = new HumanMessage("held suffix")
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    if (Array.isArray(value) && value[0] === aMessage) {
      entered()
      await gate
    }
    return serialize(value)
  })
  const a = f.put(config, [...original, aMessage], 1, aCheckpoint)
  await started
  let bFinished = false
  const next = [...original, aMessage, new AIMessage("second saver")]
  const b = f
    .fresh()
    .put(
      { configurable: { thread_id: f.run.id, checkpoint_id: aCheckpoint.id } },
      { ...emptyCheckpoint(), channel_values: { messages: next } },
      { source: "loop", step: 2, parents: {} }
    )
    .then((value) => {
      bFinished = true
      return value
    })
  try {
    const independent = await f
      .fresh()
      .put({ configurable: { thread_id: f.run.id, checkpoint_ns: "other" } }, emptyCheckpoint(), {
        source: "loop",
        step: 0,
        parents: {}
      })
    expect(await f.fresh().getTuple(independent)).toBeDefined()
    expect(bFinished).toBe(false)
  } finally {
    release()
    await Promise.allSettled([a, b])
  }
  expect((await f.fresh().getTuple(await b))?.checkpoint.channel_values.messages).toEqual(next)
})

it("pins results across saver instances until asynchronous serialization finishes", async () => {
  const f = fixture()
  let config = await f.put(f.root, [new HumanMessage("original")])
  const original = config
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    if (value === "late result") {
      entered()
      await gate
    }
    return serialize(value)
  })
  const pending = f.saver.putWrites(original, [["messages", "late result"]], "tool")
  try {
    await started
    const other = f.fresh()
    for (let index = 0; index < 7; index++)
      config = await other.put(config, emptyCheckpoint(), {
        source: "loop",
        step: index,
        parents: {}
      })
    expect(await f.fresh().getTuple(original)).toBeDefined()
    release()
    await pending
    expect((await f.fresh().getTuple(original))?.pendingWrites).toEqual([
      ["tool", "messages", "late result"]
    ])
    await other.put(config, emptyCheckpoint(), { source: "loop", step: 8, parents: {} })
    expect(await f.fresh().getTuple(original)).toBeUndefined()
    expect(count(f.store, "bot_graph_message_snapshots")).toBe(0)
  } finally {
    release()
    await pending
  }
})

it("holds a complete read while concurrent writes collect its old DB rows", async () => {
  const f = fixture(),
    messages = [new HumanMessage("original")]
  const original = await f.put(f.root, messages)
  const reader = f.fresh(),
    deserialize = reader.serde.loadsTyped.bind(reader.serde)
  let release!: () => void,
    entered!: () => void,
    first = true
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.spyOn(reader.serde, "loadsTyped").mockImplementation(async (...args) => {
    if (first) {
      first = false
      entered()
      await gate
    }
    return deserialize(...args)
  })
  const reading = reader.getTuple(original)
  try {
    await started
    let config = original
    for (let step = 0; step < 6; step++)
      config = await f.put(config, [new HumanMessage(`replacement ${step}`)])
    expect(await f.fresh().getTuple(original)).toBeUndefined()
  } finally {
    release()
  }
  expect((await reading)?.checkpoint.channel_values.messages).toEqual(messages)
})

it("keeps the serialized prefix identity if a caller changes its array during metadata encoding", async () => {
  const f = fixture(),
    messages: unknown[] = [new HumanMessage("original")]
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  let changed = false
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    if (!changed && value && typeof value === "object" && "source" in value) {
      changed = true
      messages[0] = new HumanMessage("replacement")
    }
    return serialize(value)
  })
  const first = await f.put(f.root, messages)
  expect((await f.fresh().getTuple(first))?.checkpoint.channel_values.messages).toEqual([
    new HumanMessage("original")
  ])
  const next = await f.put(first, [...messages, new AIMessage("tail")])
  expect((await f.fresh().getTuple(next))?.checkpoint.channel_values.messages).toEqual([
    ...messages,
    new AIMessage("tail")
  ])
})

it("rebases before cumulative delta bytes exceed the shared Cmb limit", async () => {
  const f = fixture()
  let config: RunnableConfig = f.root,
    messages: unknown[] = []
  for (let step = 0; step < 11; step++) {
    messages = [...messages, new HumanMessage(`${step}:` + "x".repeat(1024 * 1024))]
    config = await f.put(config, messages, step)
  }
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(messages)
  expect(
    Number(
      f.store.db.exec("SELECT MAX(delta_bytes) FROM bot_graph_message_snapshots")[0].values[0][0]
    )
  ).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(count(f.store, "bot_graph_message_snapshots")).toBeLessThanOrEqual(11)
})

it("rolls back the message delta, head, event and run pointer when retention fails", async () => {
  const f = fixture()
  let messages: unknown[] = [],
    config: RunnableConfig = f.root
  for (let step = 0; step < 4; step++) {
    messages = [...messages, new HumanMessage(`message ${step}`)]
    config = await f.put(config, messages, step)
  }
  const previousRun = f.store.getRun(f.run.id)
  const original = f.store.db.run.bind(f.store.db)
  const failure = vi.spyOn(f.store.db, "run").mockImplementation((sql, args) => {
    if (sql.startsWith("DELETE FROM bot_graph_checkpoints"))
      throw new Error("interrupted transaction")
    return original(sql, args)
  })
  await expect(f.put(config, [...messages, new AIMessage("not committed")])).rejects.toThrow(
    "interrupted transaction"
  )
  expect(count(f.store, "bot_graph_message_heads")).toBe(4)
  expect(count(f.store, "bot_graph_message_snapshots")).toBe(4)
  expect(f.store.getRun(f.run.id).checkpoint).toBe(previousRun.checkpoint)
  expect(f.store.getRun(f.run.id).revision).toBe(previousRun.revision)
  expect(f.store.events().filter((event) => event.kind === "run.checkpoint")).toHaveLength(4)
  expect((await f.fresh().getTuple(config))?.checkpoint.channel_values.messages).toEqual(messages)
  failure.mockRestore()
  const next = await f.put(config, [...messages, new AIMessage("committed")])
  expect((await f.fresh().getTuple(next))?.checkpoint.channel_values.messages).toEqual([
    ...messages,
    new AIMessage("committed")
  ])
})

it("rebases a cached parent already collected by another saver before the next put", async () => {
  const f = fixture(),
    messages = [new HumanMessage("original")]
  const first = await f.put(f.root, messages)
  const other = f.fresh()
  let config = first
  for (let step = 0; step < 6; step++)
    config = await other.put(config, emptyCheckpoint(), { source: "loop", step, parents: {} })
  expect(await other.getTuple(first)).toBeUndefined()
  const expected = [...messages, new AIMessage("continuation from cached state")]
  const next = await f.put(first, expected)
  expect((await f.fresh().getTuple(next))?.checkpoint.channel_values.messages).toEqual(expected)
  expect(
    Number(f.store.db.exec("SELECT MAX(depth) FROM bot_graph_message_snapshots")[0].values[0][0])
  ).toBe(1)
})

it("does not publish message state after cancellation during suffix encoding", async () => {
  const f = fixture(),
    messages = [new HumanMessage("original")]
  const first = await f.put(f.root, messages)
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  const nextMessage = new AIMessage("cancelled suffix")
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    const encoded = await serialize(value)
    if (Array.isArray(value) && value[0] === nextMessage) f.store.cancel(f.run.id)
    return encoded
  })
  await expect(f.put(first, [...messages, nextMessage])).rejects.toThrow()
  expect(count(f.store, "bot_graph_message_snapshots")).toBe(1)
  expect(count(f.store, "bot_graph_message_heads")).toBe(1)
  expect((await f.fresh().getTuple(first))?.checkpoint.channel_values.messages).toEqual(messages)
})

it("rejects excess message counts before copying or serializing the array", async () => {
  const f = fixture()
  const messages: unknown[] = new Array(1_000_001)
  const copy = vi.spyOn(messages, "slice")
  const serialize = vi.spyOn(f.saver.serde, "dumpsTyped")
  await expect(f.put(f.root, messages)).rejects.toMatchObject({ code: "checkpoint_size" })
  expect(copy).not.toHaveBeenCalled()
  expect(serialize).not.toHaveBeenCalled()
  expect(count(f.store, "bot_graph_checkpoints")).toBe(0)
})

it("rebases the captured messages if the caller changes its array while a collected parent is retried", async () => {
  const f = fixture(),
    messages = [new HumanMessage("original")]
  const first = await f.put(f.root, messages)
  const other = f.fresh()
  let config = first
  for (let step = 0; step < 6; step++)
    config = await other.put(config, emptyCheckpoint(), { source: "loop", step, parents: {} })
  expect(await other.getTuple(first)).toBeUndefined()
  const source = [...messages, new AIMessage("captured continuation")]
  const expected = source.slice()
  const serialize = f.saver.serde.dumpsTyped.bind(f.saver.serde)
  vi.spyOn(f.saver.serde, "dumpsTyped").mockImplementation(async (value) => {
    if (value && typeof value === "object" && "source" in value) {
      source[0] = new HumanMessage("later replacement")
      source.push(new AIMessage("later append"))
    }
    return serialize(value)
  })
  const next = await f.put(first, source)
  expect((await f.fresh().getTuple(next))?.checkpoint.channel_values.messages).toEqual(expected)
})
