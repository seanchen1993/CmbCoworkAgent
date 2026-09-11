import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import * as db from "../db"
import { StreamConverter } from "../agent/stream-converter"
import { createStreamDataSerializer } from "../ipc/stream-data-serialization"
import { ScheduledTranscript } from "./scheduled-transcript"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
beforeAll(async () => {
  storage.path = join(mkdtempSync(join(tmpdir(), "cmb-scheduled-writer-")), "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup() {
  const id = crypto.randomUUID()
  db.createThread(id)
  const writer = new ScheduledTranscript(id)
  const serialize = createStreamDataSerializer()
  const converter = new StreamConverter()
  const frame = (mode: string, data: unknown) => {
    const wire = serialize(mode, data)
    const events = converter.processChunk(mode, wire.data, {
      valuesMessageIndexOffset: wire.valuesMessageIndexOffset,
      valuesSnapshotKind: wire.valuesSnapshotKind,
      valuesSnapshotScope: "turn"
    })
    writer.consume(mode, wire, events)
  }
  return { id, writer, frame, rows: () => db.getThreadMessages(id) }
}

it("preserves repeated deltas, explicit clears and independent snapshot fields", async () => {
  const { id, writer, frame, rows } = setup()
  for (let index = 0; index < 2; index++)
    frame("messages", [
      new AIMessageChunk({
        id: "a",
        content: "ha",
        additional_kwargs: { reasoning_content: "think" }
      }),
      {}
    ])
  writer.flush()
  expect(rows()[0]).toMatchObject({ content: "haha", reasoning: "thinkthink" })
  const stale = rows()[0]
  frame("messages", [
    new AIMessage({ id: "a", content: "", additional_kwargs: { reasoning_content: "" } }),
    {}
  ])
  writer.flush()
  expect(rows()[0].content).toBe("")
  expect(rows()[0].reasoning ?? "").toBe("")
  frame("messages", [new AIMessageChunk({ id: "a", content: "fresh" }), {}])
  frame("messages", [
    { id: ["AIMessage"], kwargs: { id: "a", additional_kwargs: { reasoning_content: "new" } } },
    {}
  ])
  await writer.finish()
  expect(rows()[0]).toMatchObject({ content: "fresh", reasoning: "new" })
  db.upsertThreadMessages(id, [stale])
  expect(rows()[0].content).toBe("fresh")
})

it("keeps tool argument chunks across timed flushes and separates reused provider cycles", async () => {
  const { writer, frame, rows } = setup()
  frame("messages", [
    new AIMessageChunk({
      id: "same",
      content: "first",
      tool_call_chunks: [{ index: 0, id: "call-1", name: "echo", args: '{"value":' }]
    }),
    {}
  ])
  writer.flush()
  frame("messages", [
    new AIMessageChunk({
      id: "same",
      content: "",
      tool_call_chunks: [{ index: 0, args: '"one"}' }]
    }),
    {}
  ])
  frame("messages", [new ToolMessage({ id: "t", tool_call_id: "call-1", content: "result" }), {}])
  frame("messages", [
    new AIMessageChunk({
      id: "same",
      content: "second",
      tool_call_chunks: [{ index: 0, id: "call-2", name: "echo", args: '{"value":' }]
    }),
    {}
  ])
  writer.flush()
  // A repeated/late result from cycle one cannot reset cycle two's partial args.
  frame("messages", [new ToolMessage({ id: "t", tool_call_id: "call-1", content: "result" }), {}])
  frame("messages", [
    new AIMessageChunk({
      id: "same",
      content: "",
      tool_call_chunks: [{ index: 0, args: '"two"}' }]
    }),
    {}
  ])
  frame("messages", [new ToolMessage({ id: "t2", tool_call_id: "call-2", content: "result2" }), {}])
  frame("messages", [new AIMessageChunk({ id: "same", content: "final" }), {}])
  await writer.finish()
  expect(rows().map((message) => message.content)).toEqual([
    "first",
    "result",
    "second",
    "result2",
    "final"
  ])
  expect(rows()[0].tool_calls).toMatchObject([{ id: "call-1", args: { value: "one" } }])
  expect(rows()[2].tool_calls).toEqual([{ id: "call-2", name: "echo", args: { value: "two" } }])
  expect(rows().at(-1)?.tool_calls ?? []).toEqual([])
  expect(new Set(rows().map((message) => message.id)).size).toBe(5)
})

it("applies changed append/tail values without rewriting preceding tool cycles", async () => {
  const { id, writer, frame, rows } = setup()
  const user = new HumanMessage({ id: "u", content: "question" })
  db.upsertThreadMessages(id, [
    { id: "u", role: "user", content: "question", created_at: new Date() }
  ])
  const first = new AIMessage({
    id: "same",
    content: "first",
    tool_calls: [{ id: "call", name: "echo", args: {} }]
  })
  const tool = new ToolMessage({ id: "t", content: "result", tool_call_id: "call" })
  frame("values", { messages: [user, first, tool] })
  frame("values", {
    messages: [user, first, tool, new AIMessage({ id: "same", content: "draft" })]
  })
  frame("values", {
    messages: [
      user,
      first,
      tool,
      new AIMessage({
        id: "same",
        content: "corrected",
        additional_kwargs: { reasoning_content: "reason" }
      })
    ]
  })
  const stale = rows().at(-1)!
  frame("values", {
    messages: [user, first, tool, new AIMessage({ id: "same", content: "short" })]
  })
  frame("values", { todos: [] })
  await writer.finish()
  db.upsertThreadMessages(id, [stale])
  expect(rows().map((message) => message.content)).toEqual(["question", "first", "result", "short"])
  expect(rows().at(-1)?.reasoning).toBe("reason")
})

it("batches long token streams and appends text without rereading stable history", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const { id, writer, frame, rows } = setup()
  db.upsertThreadMessages(
    id,
    Array.from({ length: 10_000 }, (_, index) => ({
      id: `history-${index}`,
      role: "user" as const,
      content: "history",
      created_at: new Date(index)
    }))
  )
  const lookup = vi.spyOn(db, "getThreadMessageIdentityContext")
  const upsert = vi.spyOn(db, "upsertThreadMessages")
  const append = vi.spyOn(db, "appendThreadMessageTextDelta")
  const start = performance.now()
  for (let index = 0; index < 4096; index++) {
    frame("messages", [new AIMessageChunk({ id: "a", content: "x" }), {}])
  }
  await writer.finish()
  expect(rows().at(-1)?.content).toBe("x".repeat(4096))
  expect(upsert).toHaveBeenCalledTimes(1)
  expect(append).toHaveBeenCalledTimes(31)
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(lookup.mock.calls[0][1].length).toBeLessThanOrEqual(128)
  expect(vi.getTimerCount()).toBe(0)
  console.log(
    `Scheduled transcript: 4096 chunks / 10000 history rows in ${Math.round(performance.now() - start)} ms; 32 writes, 1 bounded identity lookup`
  )
})

it("flushes idle partial output on the timer and retries a failed batch once without duplication", async () => {
  vi.useFakeTimers()
  const { writer, frame, rows } = setup()
  const upsert = vi.spyOn(db, "upsertThreadMessages").mockImplementationOnce(() => {
    throw new Error("busy")
  })
  vi.spyOn(console, "warn").mockImplementation(() => {})
  frame("messages", [new AIMessageChunk({ id: "a", content: "prefix" }), {}])
  await vi.advanceTimersByTimeAsync(250)
  expect(rows()).toHaveLength(0)
  frame("messages", [new AIMessageChunk({ id: "a", content: "suffix" }), {}])
  await writer.finish()
  expect(rows()[0].content).toBe("prefixsuffix")
  expect(upsert).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it("excludes unowned subagent interiors and summarization from the parent transcript", async () => {
  const { writer, frame, rows } = setup()
  frame("messages", [
    new AIMessageChunk({ id: "child", content: "private child" }),
    { langgraph_checkpoint_ns: "tools:child" }
  ])
  frame("messages", [
    new AIMessageChunk({
      id: "summary",
      content: "internal summary",
      additional_kwargs: { lc_source: "summarization" }
    }),
    {}
  ])
  frame("messages", [new AIMessageChunk({ id: "parent", content: "parent answer" }), {}])
  await writer.finish()
  expect(rows().map((message) => message.content)).toEqual(["parent answer"])
})
