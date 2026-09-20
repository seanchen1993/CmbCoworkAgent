import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
  createStreamDataSerializer,
  createSerializedValuesMessageAccumulator
} from "./stream-data-serialization"
import { persistedMessageFromStreamPayload } from "./stream-transcript-payload"
import {
  selectStreamTranscriptValueSnapshots,
  getStreamTranscriptValueLocalOccurrence
} from "./stream-transcript-values"
import { resolveStreamTranscriptFlush } from "./stream-transcript-flush"
import * as db from "../db"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

beforeAll(async () => {
  storage.path = join(mkdtempSync(join(tmpdir(), "cmb-values-authority-")), "threads.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
})

it("accepts new native values after clear without letting delayed renderer echoes restore drafts", () => {
  const threadId = "native-values-authority"
  db.createThread(threadId)
  const serialize = createStreamDataSerializer()
  const persist = (tuples: unknown[]) => {
    const queued = tuples.map(persistedMessageFromStreamPayload).filter((value) => value !== null)
    const result = resolveStreamTranscriptFlush({
      queuedMessages: queued,
      loadBaselineMessages: () => db.getThreadMessages(threadId)
    })
    db.upsertThreadMessages(threadId, result.messages, { preserveExistingOrder: true })
  }
  const values = (content: string, reasoning?: string) => {
    const projected = serialize("values", {
      messages: [
        new HumanMessage({ id: "u", content: "question" }),
        new AIMessage({
          id: "a",
          content,
          additional_kwargs: reasoning === undefined ? {} : { reasoning_content: reasoning }
        })
      ]
    })
    persist(selectStreamTranscriptValueSnapshots(projected.data, projected.valuesSnapshotKind))
  }
  persist([
    serialize("messages", [
      new AIMessageChunk({
        id: "a",
        content: "draft",
        additional_kwargs: { reasoning_content: "old reasoning" }
      }),
      {}
    ]).data
  ])
  const stale = db.getThreadMessages(threadId)[0]
  values("", "")
  expect(db.getThreadMessages(threadId)[0]).toMatchObject({ content: "" })
  expect(db.getThreadMessages(threadId)[0].reasoning ?? "").toBe("")
  db.upsertThreadMessages(threadId, [stale])
  expect(db.getThreadMessages(threadId)[0].content).toBe("")
  values("new final", "new reasoning")
  expect(db.getThreadMessages(threadId)).toHaveLength(1)
  expect(db.getThreadMessages(threadId)[0]).toMatchObject({
    content: "new final",
    reasoning: "new reasoning"
  })
  values("short final")
  expect(db.getThreadMessages(threadId)[0]).toMatchObject({
    content: "short final",
    reasoning: "new reasoning"
  })
})

it.each([false, true])(
  "keeps reused provider IDs in separate tool cycles (existing stream: %s)",
  (streamed) => {
    const threadId = `values-cycles-${streamed}`
    db.createThread(threadId)
    const messages = [
      new AIMessage({
        id: "same",
        content: "first",
        tool_calls: [{ id: "c1", name: "echo", args: { value: 1 } }]
      }),
      new ToolMessage({ id: "t1", content: "result1", tool_call_id: "c1" }),
      new AIMessage({
        id: "same",
        content: "second",
        tool_calls: [{ id: "c2", name: "echo", args: { value: 2 } }]
      }),
      new ToolMessage({ id: "t2", content: "result2", tool_call_id: "c2" }),
      new AIMessage({ id: "same", content: "final" })
    ]
    const serialize = createStreamDataSerializer()
    const persist = (tuples: unknown[]) => {
      const queued = tuples.map(persistedMessageFromStreamPayload).filter((value) => value !== null)
      const result = resolveStreamTranscriptFlush({
        queuedMessages: queued,
        loadBaselineMessages: () => db.getThreadMessages(threadId)
      })
      db.upsertThreadMessages(threadId, result.messages, { preserveExistingOrder: true })
    }
    if (streamed) persist(messages.map((message) => serialize("messages", [message, {}]).data))
    const before = db.getThreadMessages(threadId)
    const frame = serialize("values", { messages })
    persist(
      selectStreamTranscriptValueSnapshots(frame.data, frame.valuesSnapshotKind, {
        loadBaselineMessages: () => db.getThreadMessages(threadId)
      })
    )
    const after = db.getThreadMessages(threadId)
    const assistants = after.filter((message) => message.role === "assistant")
    expect(after.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant"
    ])
    expect(
      after
        .filter((message) => message.role === "tool")
        .map((message) => [message.id, message.tool_call_id, message.content])
    ).toEqual([
      ["t1", "c1", "result1"],
      ["t2", "c2", "result2"]
    ])
    expect(assistants.map((message) => message.content)).toEqual(["first", "second", "final"])
    expect(assistants.map((message) => message.tool_calls?.map((call) => call.id) ?? [])).toEqual([
      ["c1"],
      ["c2"],
      []
    ])
    if (streamed)
      expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id))
  }
)

it("routes changed append/tail fields onto prior streamed identities across a user boundary", () => {
  const threadId = "values-append-tail-identities"
  db.createThread(threadId)
  db.upsertThreadMessages(threadId, [
    {
      id: "old",
      role: "assistant",
      provider_source_id: "same",
      provider_occurrence: 7,
      content: "old history",
      created_at: new Date(1)
    },
    { id: "u", role: "user", content: "new question", created_at: new Date(2) },
    {
      id: "custom-first",
      role: "assistant",
      provider_source_id: "same",
      provider_occurrence: 8,
      content: "first draft",
      tool_calls: [{ id: "c1", name: "echo", args: { value: 1 } }],
      created_at: new Date(3)
    },
    { id: "t1", role: "tool", tool_call_id: "c1", content: "result", created_at: new Date(4) }
  ])
  const serialize = createStreamDataSerializer()
  const accumulator = createSerializedValuesMessageAccumulator()
  const user = new HumanMessage({ id: "u", content: "new question" })
  const first = new AIMessage({
    id: "same",
    content: "first",
    tool_calls: [{ id: "c1", name: "echo", args: { value: 1 } }]
  })
  const tool = new ToolMessage({ id: "t1", tool_call_id: "c1", content: "result" })
  const frame = (messages: unknown[]) => {
    const wire = serialize("values", { messages })
    const complete = accumulator.update(wire)
    const tuples = selectStreamTranscriptValueSnapshots(wire.data, wire.valuesSnapshotKind, {
      completeMessages: complete.messages,
      loadBaselineMessages: () => db.getThreadMessages(threadId),
      loadPreviousTurnOccurrences: (userId, sources) =>
        db.getThreadMessageProviderOccurrencesBeforeUser(threadId, userId, sources)
    })
    const resolved = resolveStreamTranscriptFlush({
      queuedMessages: tuples.map((tuple) => persistedMessageFromStreamPayload(tuple)!),
      loadBaselineMessages: () => db.getThreadMessages(threadId)
    })
    db.upsertThreadMessages(threadId, resolved.messages, { preserveExistingOrder: true })
    return { wire, tuples }
  }
  frame([user, first, tool])
  expect(
    db.getThreadMessages(threadId).find((message) => message.id === "custom-first")?.content
  ).toBe("first")
  const final = new AIMessage({ id: "same", content: "final draft" })
  const appended = frame([user, first, tool, final])
  expect(appended.wire.valuesSnapshotKind).toBe("append")
  expect(appended.tuples).toHaveLength(1)
  const tail = frame([
    user,
    first,
    tool,
    new AIMessage({ id: "same", content: "final draft tail" })
  ])
  expect(tail.wire.valuesSnapshotKind).toBe("tail")
  expect(tail.tuples).toHaveLength(1)
  expect(getStreamTranscriptValueLocalOccurrence(tail.tuples[0])).toBe(2)
  frame([user, first, tool, new AIMessage({ id: "same", content: "short" })])
  const stored = db.getThreadMessages(threadId)
  expect(
    stored.filter((message) => message.role === "assistant").map((message) => message.content)
  ).toEqual(["old history", "first", "short"])
  expect(stored.at(-1)).toMatchObject({ provider_source_id: "same", provider_occurrence: 9 })
  expect(stored.at(-1)?.tool_calls ?? []).toEqual([])
})
it.each([false, true])(
  "aligns reducer-collapsed values without rewriting old cycles (streamed: %s)",
  (streamed) => {
    const threadId = `collapsed-runtime-values-${streamed}`
    db.createThread(threadId)
    const serialize = createStreamDataSerializer()
    const accumulator = createSerializedValuesMessageAccumulator()
    const persist = (tuples: unknown[]) => {
      const queued = tuples.map(persistedMessageFromStreamPayload).filter((value) => value !== null)
      const resolved = resolveStreamTranscriptFlush({
        queuedMessages: queued,
        loadBaselineMessages: () => db.getThreadMessages(threadId)
      })
      db.upsertThreadMessages(threadId, resolved.messages, { preserveExistingOrder: true })
    }
    const values = (messages: unknown[]) => {
      const frame = serialize("values", { messages })
      const complete = accumulator.update(frame).messages
      persist(
        selectStreamTranscriptValueSnapshots(frame.data, frame.valuesSnapshotKind, {
          completeMessages: complete,
          loadBaselineMessages: () => db.getThreadMessages(threadId)
        })
      )
    }
    const tools: ToolMessage[] = []
    for (const cycle of [1, 2]) {
      const ai = new AIMessage({
        id: "same",
        content: `checking-${cycle}`,
        tool_calls: [{ id: `c${cycle}`, name: "read_file", args: { file_path: "fixture.txt" } }]
      })
      if (streamed) persist([serialize("messages", [ai, { checkpoint_ns: `model:${cycle}` }]).data])
      values([ai, ...tools])
      const tool = new ToolMessage({
        id: `t${cycle}`,
        tool_call_id: `c${cycle}`,
        content: `result-${cycle}`
      })
      tools.push(tool)
      if (streamed) persist([serialize("messages", [tool, {}]).data])
      values([ai, ...tools])
    }
    const final = new AIMessage({ id: "same", content: "hahaha done" })
    if (streamed) persist([serialize("messages", [final, { checkpoint_ns: "model:3" }]).data])
    values([final, ...tools])
    const assistants = db
      .getThreadMessages(threadId)
      .filter((message) => message.role === "assistant")
    expect(assistants.map((message) => message.content)).toEqual([
      "checking-1",
      "checking-2",
      "hahaha done"
    ])
    expect(assistants.map((message) => message.tool_calls?.map((call) => call.id) ?? [])).toEqual([
      ["c1"],
      ["c2"],
      []
    ])
    // An explicit earlier tool owner remains addressable for a complete correction.
    values([
      new AIMessage({
        id: "same",
        content: "corrected first",
        tool_calls: [{ id: "c1", name: "read_file", args: { file_path: "fixture.txt" } }]
      }),
      ...tools
    ])
    expect(
      db
        .getThreadMessages(threadId)
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
    ).toEqual(["corrected first", "checking-2", "hahaha done"])
  }
)
it("clears complete values tool calls without clearing tools on metadata-only updates", () => {
  const threadId = "values-explicit-tool-clear"
  db.createThread(threadId)
  db.upsertThreadMessages(threadId, [
    {
      id: "same",
      role: "assistant",
      content: "draft",
      tool_calls: [{ id: "obsolete", name: "echo", args: {} }],
      created_at: new Date()
    }
  ])
  const values = (kwargs: Record<string, unknown>) => {
    const tuples = selectStreamTranscriptValueSnapshots(
      { messages: [{ id: ["AIMessage"], kwargs: { id: "same", ...kwargs } }] },
      "full",
      { loadBaselineMessages: () => db.getThreadMessages(threadId) }
    )
    const queued = tuples.map(persistedMessageFromStreamPayload).filter((value) => value !== null)
    const resolved = resolveStreamTranscriptFlush({
      queuedMessages: queued,
      loadBaselineMessages: () => db.getThreadMessages(threadId)
    })
    db.upsertThreadMessages(threadId, resolved.messages, { preserveExistingOrder: true })
  }
  values({ content: "draft correction" })
  expect(db.getThreadMessages(threadId)[0].tool_calls?.map((call) => call.id)).toEqual(["obsolete"])
  values({ tool_calls: [] })
  expect(db.getThreadMessages(threadId)[0].tool_calls ?? []).toEqual([])
})
it("keeps tool-only authority across stale echoes, native deltas and fork copies", () => {
  const threadId = "tool-field-authority"
  db.createThread(threadId)
  const old = {
    id: "a",
    role: "assistant" as const,
    content: "body",
    reasoning: "thought",
    tool_calls: [{ id: "c", name: "echo", args: { value: "old" } }],
    created_at: new Date()
  }
  db.upsertThreadMessages(threadId, [old])
  db.upsertThreadMessages(threadId, [
    { ...old, content: "", content_mode: "delta", tool_calls: [], tool_calls_mode: "snapshot" }
  ])
  db.upsertThreadMessages(threadId, [old])
  expect(db.getThreadMessages(threadId)[0]).toMatchObject({
    content: "body",
    reasoning: "thought",
    tool_calls: []
  })
  const copiedId = "tool-field-authority-copy"
  db.createThread(copiedId)
  db.upsertThreadMessages(copiedId, db.applyThreadMessageStreamAuthority(threadId, [old]))
  db.upsertThreadMessages(copiedId, [old])
  expect(db.getThreadMessages(copiedId)[0].tool_calls ?? []).toEqual([])
  db.upsertThreadMessages(threadId, [
    {
      ...old,
      content: " tail",
      content_mode: "delta",
      tool_calls_mode: "delta",
      tool_calls: [{ id: "c", name: "echo", args: { value: "new" } }]
    }
  ])
  db.upsertThreadMessages(threadId, [old])
  expect(db.getThreadMessages(threadId)[0].tool_calls?.[0].args).toEqual({ value: "new" })
})
it("honors tool snapshot priority while refusing unmarked stale tool echoes", () => {
  const id = "tool-snapshot-priority"
  db.createThread(id)
  const row = {
    id: "a",
    role: "assistant" as const,
    content: "body",
    tool_calls: [{ id: "c", name: "echo", args: {} }],
    created_at: new Date()
  }
  db.upsertThreadMessages(id, [{ ...row, content_priority: 5, tool_calls_mode: "snapshot" }])
  db.upsertThreadMessages(id, [
    { ...row, content_priority: 2, tool_calls: [], tool_calls_mode: "snapshot" }
  ])
  expect(db.getThreadMessages(id)[0].tool_calls?.map((call) => call.id)).toEqual(["c"])
  db.upsertThreadMessages(id, [
    { ...row, content_priority: 6, tool_calls: [], tool_calls_mode: "snapshot" }
  ])
  db.upsertThreadMessages(id, [{ ...row, content_priority: 99 }])
  expect(db.getThreadMessages(id)[0].tool_calls ?? []).toEqual([])
})
