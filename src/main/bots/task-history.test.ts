import { afterEach, expect, it, vi } from "vitest"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { type RunnableConfig } from "@langchain/core/runnables"
import { renderContextHistory } from "../agent/context-summarization-middleware"
import { emptyCheckpoint, type SerializerProtocol } from "@langchain/langgraph-checkpoint"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"
import { botTaskHistoryTool } from "./task-history"
import type { BotRuntimeRequest } from "./host"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

function fixture(path = ":memory:") {
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "A" })
  store.send({ nonce: "task", conversationId, text: "assigned work" })
  const claimed = store.claim("host", 60_000)!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot,
    store,
    messages: store.messagesForRun(claimed.run.id),
    signal: new AbortController().signal
  }
  const check = () => {
    request.signal.throwIfAborted()
    request.store.assertDispatch(request.lease)
  }
  const saver = new BotCheckpointSaver(request.store, request.lease, request.run.id)
  let savedConfig: RunnableConfig = { configurable: { thread_id: request.run.id } }
  return {
    saver,
    request,
    check,
    reader: () => botTaskHistoryTool(request, check),
    save: async (messages: BaseMessage[]) => {
      const checkpoint = emptyCheckpoint()
      checkpoint.channel_values.messages = messages
      savedConfig = await saver.put(savedConfig, checkpoint, {
        source: "loop",
        step: 0,
        parents: {}
      })
    }
  }
}

it("reads the durable original transcript after reopening SQLite and paginates one message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-task-history-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  const f = fixture(path)
  await f.save([
    new HumanMessage("Original evidence before summary " + "x".repeat(300)),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call-1", name: "execute", args: { command: "test" } }]
    }),
    new ToolMessage({
      content: "exit code 1; failed assertion",
      tool_call_id: "call-1",
      name: "execute",
      status: "error"
    })
  ])
  f.request.store.close()
  f.request.store = new BotStore(path)
  cleanup.push(() => f.request.store.close())
  const first = JSON.parse(await f.reader().invoke({ limit: 64 }))
  const second = JSON.parse(await f.reader().invoke({ offset: first.nextOffset, limit: 64 }))
  expect(first.text).toContain("Original evidence before summary")
  expect(first).toMatchObject({ message: 0, totalMessages: 3, nextOffset: 64, nextMessage: 1 })
  expect(second).toMatchObject({ message: 0, nextOffset: 128 })
  expect(first.text + second.text).toHaveLength(128)
  const result = JSON.parse(await f.reader().invoke({ message: 2 }))
  expect(result.text).toContain("exit code 1; failed assertion")
  expect(result.text).toContain('tool_call_id="call-1"')
  expect(result.status).toBe("error")
  expect(result.nextMessage).toBeNull()
  expect(f.request.store.effects(f.request.run.id)).toEqual([])
})

it("keeps binary media and private URLs out of the text projection", async () => {
  const f = fixture()
  await f.save([
    new HumanMessage({
      content: [
        { type: "text", text: "Recorded chart" },
        { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE_BYTES" } },
        { type: "image_url", image_url: { url: "https://private.example/chart?token=SECRET" } }
      ]
    })
  ])
  const result = await f.reader().invoke({})
  expect(result).toContain("Recorded chart")
  expect(result).not.toContain("PRIVATE_IMAGE_BYTES")
  expect(result).not.toContain("private.example")
  expect(result).not.toContain("SECRET")
})

it("rejects caller-supplied scope and reads only the leased task", async () => {
  const f = fixture()
  await f.save([new HumanMessage("OWN_TASK_EVIDENCE")])
  const other = f.request.store.createBot({ nonce: "other", name: "Other" })
  const sent = f.request.store.send({
    nonce: "other-task",
    conversationId: other.conversationId,
    text: "PRIVATE_OTHER_BOT"
  })
  await expect(
    f.reader().invoke({
      type: "tool_call",
      name: "read_task_history",
      id: "foreign",
      args: { runId: sent.runIds[0] }
    })
  ).rejects.toThrow()
  await expect(
    f.reader().invoke({
      type: "tool_call",
      name: "read_task_history",
      id: "path",
      args: { path: "/etc/passwd" }
    })
  ).rejects.toThrow()
  const text = await f.reader().invoke({})
  expect(text).toContain("OWN_TASK_EVIDENCE")
  expect(text).not.toContain("PRIVATE_OTHER_BOT")
  expect(JSON.parse(await f.reader().invoke({ message: 99 }))).toMatchObject({
    text: "",
    nextMessage: null
  })
})

it("refuses an absent checkpoint and oversized output requests", async () => {
  const f = fixture()
  await expect(f.reader().invoke({})).rejects.toMatchObject({ code: "task_history_unavailable" })
  await expect(f.reader().invoke({ limit: 8001 })).rejects.toThrow()
  await expect(f.reader().invoke({ offset: -1 })).rejects.toThrow()
})

it("does not publish a read that loses its task lease while loading the checkpoint", async () => {
  const f = fixture()
  await f.save([new HumanMessage("MUST_NOT_RETURN_AFTER_CANCELLATION")])
  const get = BotCheckpointSaver.prototype.getMessage
  vi.spyOn(BotCheckpointSaver.prototype, "getMessage").mockImplementation(async function (
    this: BotCheckpointSaver,
    config,
    index
  ) {
    const saved = await get.call(this, config, index)
    f.request.store.cancel(f.request.run.id)
    return saved
  })
  await expect(f.reader().invoke({})).rejects.toThrow()
})

function row(store: BotStore, sql: string, parameters: unknown[] = []) {
  const statement = store.db.prepare(sql, parameters)
  try {
    return statement.step() ? statement.getAsObject() : undefined
  } finally {
    statement.free()
  }
}

it("decodes only the indexed message, not other history, state, metadata or pending writes", async () => {
  const f = fixture()
  const checkpoint = emptyCheckpoint()
  const messages = Array.from(
    { length: 120 },
    (_, index) =>
      new HumanMessage({
        id: `original-${index}`,
        content: `Evidence ${index}: ` + "h".repeat(4096)
      })
  )
  messages[57] = new HumanMessage({
    id: "selected",
    content: "EXACT_TARGET " + "q".repeat(200_000)
  })
  checkpoint.channel_values = { messages, unrelated: "UNRELATED_STATE_" + "s".repeat(500_000) }
  const config = await f.saver.put({ configurable: { thread_id: f.request.run.id } }, checkpoint, {
    source: "loop",
    step: 0,
    parents: { PRIVATE_METADATA: "private-checkpoint" }
  })
  await f.saver.putWrites(config, [["unrelated", "PRIVATE_PENDING_WRITE"]], "pending-task")
  const loads = f.saver.serde.loadsTyped.bind(f.saver.serde)
  const decoded: string[] = []
  vi.spyOn(
    Object.getPrototypeOf(f.saver.serde) as SerializerProtocol,
    "loadsTyped"
  ).mockImplementation(async (type, bytes) => {
    decoded.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes))
    return loads(type, bytes)
  })
  const reader = f.reader()
  const first = JSON.parse(await reader.invoke({ message: 57, limit: 8000 }))
  const next = JSON.parse(
    await reader.invoke({ message: 57, offset: first.nextOffset, limit: 8000 })
  )
  const full = renderContextHistory([messages[57]])
  const last = JSON.parse(
    await reader.invoke({ message: 57, offset: full.length - 4000, limit: 8000 })
  )
  expect(first).toMatchObject({
    id: "selected",
    totalMessages: 120,
    nextOffset: 8000,
    nextMessage: 58
  })
  expect(first.text + next.text).toBe(full.slice(0, 16000))
  expect(last).toMatchObject({ text: full.slice(-4000), nextOffset: null })
  expect(decoded).toHaveLength(3)
  for (const data of decoded) {
    expect(data).toContain("EXACT_TARGET")
    expect(data).not.toContain("Evidence 56")
    expect(data).not.toContain("UNRELATED_STATE")
    expect(data).not.toContain("PRIVATE_METADATA")
    expect(data).not.toContain("PRIVATE_PENDING_WRITE")
    expect(data.length).toBeLessThan(205_000)
  }
  expect(f.request.store.effects(f.request.run.id)).toEqual([])
})

it("indexes immutable delta ancestors through replacements and deletions", async () => {
  const f = fixture()
  const originals: BaseMessage[] = Array.from(
    { length: 12 },
    (_, index) => new HumanMessage({ id: `m-${index}`, content: `original ${index}` })
  )
  await f.save(originals)
  const replaced = [...originals]
  replaced[7] = new AIMessage({ id: "replacement", content: "replacement at seven" })
  replaced.push(
    new ToolMessage({
      id: "result",
      tool_call_id: "call",
      content: "immutable result",
      status: "error"
    })
  )
  await f.save(replaced)
  await f.save(replaced.slice(0, 11))
  await f.save([
    ...replaced.slice(0, 11),
    new ToolMessage({
      id: "new-result",
      tool_call_id: "new-call",
      content: "new tail",
      status: "success"
    })
  ])
  const rows = f.request.store.db.exec("SELECT prefix_length FROM bot_graph_message_snapshots")[0]
    .values
  expect(rows.some(([prefix]) => Number(prefix) > 0)).toBe(true)
  const reader = f.reader()
  expect(JSON.parse(await reader.invoke({ message: 2 }))).toMatchObject({
    id: "m-2",
    totalMessages: 12,
    role: "human"
  })
  expect(JSON.parse(await reader.invoke({ message: 7 }))).toMatchObject({
    id: "replacement",
    role: "ai"
  })
  expect(JSON.parse(await reader.invoke({ message: 11 }))).toMatchObject({
    id: "new-result",
    status: "success",
    nextMessage: null
  })
  expect(await reader.invoke({ message: 11 })).not.toContain("immutable result")
})

it("reads old inline JSONPlus checkpoints after reopening without a message snapshot head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-history-inline-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  const f = fixture(path)
  const original = new ToolMessage({
    id: "legacy",
    content: "legacy original result",
    tool_call_id: "legacy-call",
    status: "error"
  })
  await f.save([new HumanMessage("legacy input"), original])
  const checkpoint = emptyCheckpoint()
  checkpoint.channel_values.messages = [new HumanMessage("legacy input"), original]
  const [type, data] = await f.saver.serde.dumpsTyped(checkpoint)
  f.request.store.transaction(() => {
    f.request.store.db.run("UPDATE bot_graph_checkpoints SET type=?,data=? WHERE thread_id=?", [
      type,
      data,
      f.request.run.id
    ])
    f.request.store.db.run("DELETE FROM bot_graph_message_heads WHERE thread_id=?", [
      f.request.run.id
    ])
  })
  f.request.store.close()
  f.request.store = new BotStore(path)
  cleanup.push(() => f.request.store.close())
  const result = JSON.parse(await f.reader().invoke({ message: 1 }))
  expect(result).toMatchObject({
    id: "legacy",
    role: "tool",
    status: "error",
    totalMessages: 2,
    text: renderContextHistory([original])
  })
})

it.each(["missing-parent", "cycle", "count", "prefix", "marker", "selected-non-message"] as const)(
  "rejects corrupted indexed history: %s",
  async (kind) => {
    const f = fixture()
    const original = [new HumanMessage("retained")]
    await f.save(original)
    await f.save([...original, new AIMessage("child")])
    const latest = row(
      f.request.store,
      `SELECT s.* FROM bot_graph_message_snapshots s JOIN bot_graph_message_heads h ON h.snapshot_id=s.id
     WHERE h.thread_id=? ORDER BY h.checkpoint_id DESC LIMIT 1`,
      [f.request.run.id]
    )!
    f.request.store.transaction(() => {
      if (kind === "missing-parent")
        f.request.store.db.run("DELETE FROM bot_graph_message_snapshots WHERE id=?", [
          latest.parent_id
        ])
      if (kind === "cycle")
        f.request.store.db.run("UPDATE bot_graph_message_snapshots SET parent_id=id WHERE id=?", [
          latest.id
        ])
      if (kind === "count")
        f.request.store.db.run(
          "UPDATE bot_graph_message_snapshots SET message_count=3 WHERE id=?",
          [latest.id]
        )
      if (kind === "prefix")
        f.request.store.db.run(
          "UPDATE bot_graph_message_snapshots SET prefix_length=99 WHERE id=?",
          [latest.id]
        )
      if (kind === "marker")
        f.request.store.db.run(
          "UPDATE bot_graph_checkpoints SET data=CAST(json_set(CAST(data AS TEXT),'$.channel_values.messages.messageCount',77) AS BLOB) WHERE thread_id=?",
          [f.request.run.id]
        )
      if (kind === "selected-non-message") {
        const data = new TextEncoder().encode('[{"not":"a message"}]')
        const difference =
          data.length -
          Number(
            row(
              f.request.store,
              "SELECT LENGTH(data) AS bytes FROM bot_graph_message_snapshots WHERE id=?",
              [latest.id]
            )!.bytes
          )
        f.request.store.db.run(
          "UPDATE bot_graph_message_snapshots SET data=?,total_bytes=total_bytes+?,delta_bytes=delta_bytes+? WHERE id=?",
          [data, difference, difference, latest.id]
        )
      }
    })
    await expect(f.reader().invoke({ message: 1 })).rejects.toThrow()
  }
)

function gateOneMessageDecode(f: ReturnType<typeof fixture>) {
  const loads = f.saver.serde.loadsTyped.bind(f.saver.serde)
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(
    Object.getPrototypeOf(f.saver.serde) as SerializerProtocol,
    "loadsTyped"
  ).mockImplementation(async (type, data) => {
    entered()
    await blocked
    return loads(type, data)
  })
  return { started, release }
}

it("pins one committed head during async decode and reads a newer head on the next call", async () => {
  const f = fixture()
  await f.save([new HumanMessage({ id: "old", content: "OLD_COMMITTED" })])
  const oldId = row(f.request.store, "SELECT id FROM bot_graph_checkpoints WHERE thread_id=?", [
    f.request.run.id
  ])!.id
  const gate = gateOneMessageDecode(f)
  const reader = f.reader()
  const pending = reader.invoke({})
  await gate.started
  for (let index = 0; index < 6; index++)
    await f.save([new HumanMessage({ id: `new-${index}`, content: `NEW_COMMITTED_${index}` })])
  expect(
    row(f.request.store, "SELECT id FROM bot_graph_checkpoints WHERE id=?", [oldId])
  ).toBeUndefined()
  gate.release()
  expect(JSON.parse(await pending)).toMatchObject({
    id: "old",
    text: expect.stringContaining("OLD_COMMITTED"),
    totalMessages: 1
  })
  expect(JSON.parse(await reader.invoke({}))).toMatchObject({
    id: "new-5",
    text: expect.stringContaining("NEW_COMMITTED_5"),
    totalMessages: 1
  })
})

it("rejects a restored data generation even if the same run and checkpoint IDs survive", async () => {
  const f = fixture()
  await f.save([new HumanMessage("OLD_GENERATION")])
  const gate = gateOneMessageDecode(f)
  const pending = f.reader().invoke({})
  await gate.started
  f.request.store.transaction(() =>
    f.request.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','restored-generation','{}',?)",
      [Date.now()]
    )
  )
  gate.release()
  await expect(pending).rejects.toMatchObject({ code: "data_epoch" })
})

it("fails closed for a malformed selected message but does not revive unrelated instances", async () => {
  const f = fixture()
  const checkpoint = emptyCheckpoint()
  checkpoint.channel_values.messages = [
    new HumanMessage("VALID_SELECTED"),
    { unrelated: "non-message" }
  ]
  await f.saver.put({ configurable: { thread_id: f.request.run.id } }, checkpoint, {
    source: "loop",
    step: 0,
    parents: {}
  })
  expect(await f.reader().invoke({ message: 0 })).toContain("VALID_SELECTED")
  await expect(f.reader().invoke({ message: 1 })).rejects.toMatchObject({
    code: "task_history_unavailable"
  })
})

it.each(["namespace", "thread"] as const)(
  "never resolves a delta ancestor from another %s",
  async (scope) => {
    const f = fixture()
    const original = [new HumanMessage("OWN_NAMESPACE")]
    await f.save(original)
    await f.save([...original, new AIMessage("own child")])
    const latest = row(
      f.request.store,
      `SELECT s.* FROM bot_graph_message_snapshots s JOIN bot_graph_message_heads h ON h.snapshot_id=s.id
     WHERE h.thread_id=? ORDER BY h.checkpoint_id DESC LIMIT 1`,
      [f.request.run.id]
    )!
    f.request.store.transaction(() => {
      if (scope === "namespace")
        f.request.store.db.run("UPDATE bot_graph_message_snapshots SET ns='foreign' WHERE id=?", [
          latest.parent_id
        ])
      else
        f.request.store.db.run(
          "UPDATE bot_graph_message_snapshots SET thread_id='foreign' WHERE id=?",
          [latest.parent_id]
        )
    })
    await expect(f.reader().invoke({ message: 0 })).rejects.toMatchObject({
      code: "checkpoint_messages_unavailable"
    })
  }
)

it("keeps an empty committed history distinct from a missing checkpoint", async () => {
  const f = fixture()
  await f.save([])
  expect(JSON.parse(await f.reader().invoke({}))).toEqual({
    message: 0,
    totalMessages: 0,
    text: "",
    nextOffset: null,
    nextMessage: null
  })
})
