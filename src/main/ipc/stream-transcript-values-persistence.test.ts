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
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { buildGoalContinuationPrompt } from "../agent/goals/goal-manager"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY } from "../../shared/message-role-collision"
import {
  buildToolResultAssociations,
  getWorkerToolUiKey
} from "../../renderer/src/lib/worker-tool-result-key"

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

it.each([true, false])(
  "reopens Goal continuations with each assistant, tool result and response in order (streamed tool: %s)",
  async (streamedTool) => {
    const threadId = `goal-continuation-${streamedTool}`
    db.createThread(threadId)
    const userContent = "/goal read the fixture"
    const user = new HumanMessage({ id: "goal-user", content: userContent })
    db.upsertThreadMessages(
      threadId,
      [
        {
          id: "historical-assistant-alias",
          role: "assistant",
          provider_source_id: "provider-ai",
          provider_occurrence: 8,
          content: "Earlier work",
          created_at: new Date()
        },
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `history-${index}`,
          role: "assistant" as const,
          content: `Archived reply ${index}`,
          created_at: new Date()
        })),
        { id: user.id!, role: "user", content: userContent, created_at: new Date() }
      ],
      { preserveExistingOrder: true }
    )

    const transcript: unknown[] = [user]
    const boundaryIds: string[] = []
    for (const turn of [1, 2]) {
      const boundaryId = `continuation-${turn}`
      boundaryIds.push(boundaryId)
      const boundary = new HumanMessage({
        id: boundaryId,
        content: buildGoalContinuationPrompt({
          goalId: "goal",
          activeWindowId: "goal-window",
          threadId,
          objective: "Read the fixture",
          completionCondition: "Report the result",
          context: {},
          ledger: { progress: [], evidence: [], blockers: [] },
          turnsUsed: turn,
          maxTurns: 3,
          status: "active",
          lastVerdict: null,
          lastReason: null,
          pausedReason: null,
          consecutiveParseFailures: 0,
          createdAt: 1,
          updatedAt: 1
        })
      })
      const ordinal = db.reserveThreadGraphTranscriptBoundary(threadId, boundaryId)
      expect(db.reserveThreadGraphTranscriptBoundary(threadId, boundaryId)).toBe(ordinal)
      expect(db.getThreadMessagesByIds(threadId, [boundaryId])).toEqual([])
      const previousOccurrences = (sources: readonly string[]) =>
        db.getThreadMessageProviderOccurrencesBeforeUser(threadId, boundaryId, sources)
      const readBaseline = (selectors: Parameters<typeof db.getThreadMessageIdentityContext>[1]) =>
        db.getThreadMessageIdentityContext(threadId, selectors, 4)
      let serialize = createStreamDataSerializer({ projectMessageChunks: true })
      let accumulator = createSerializedValuesMessageAccumulator()
      const flush = (tuples: unknown[]) => {
        const queuedMessages = tuples.map(persistedMessageFromStreamPayload).filter(Boolean)
        const result = resolveStreamTranscriptFlush({
          queuedMessages: queuedMessages.filter((message) => message !== null),
          boundaryOrdinal: ordinal,
          loadPreviousOccurrences: previousOccurrences,
          loadBaselineMessages: () =>
            readBaseline(
              queuedMessages.flatMap((message) =>
                message
                  ? [
                      {
                        messageId: message.id,
                        providerSourceId: message.provider_source_id ?? message.id,
                        providerOccurrence: message.provider_occurrence,
                        role: message.role
                      }
                    ]
                  : []
              )
            )
        })
        db.upsertThreadMessages(threadId, result.messages, {
          preserveExistingOrder: result.preserveExistingOrder
        })
      }
      const values = (messages: unknown[]) => {
        const frame = serialize("values", { messages })
        const completeMessages = accumulator.update(frame).messages
        flush(
          selectStreamTranscriptValueSnapshots(frame.data, frame.valuesSnapshotKind, {
            completeMessages,
            resolveBoundaryOrdinal: (id) => db.getThreadTranscriptBoundaryOrdinal(threadId, id),
            loadPreviousTurnOccurrences: (id, sources) =>
              db.getThreadMessageProviderOccurrencesBeforeUser(threadId, id, sources),
            loadBaselineMessages: (selectors) =>
              readBaseline(
                selectors.map((message) => ({
                  messageId: message.id,
                  providerSourceId: message.provider_source_id ?? message.id,
                  providerOccurrence: message.provider_occurrence,
                  role: message.role as "assistant" | "tool"
                }))
              )
          })
        )
      }
      const toolCall = { id: "same-call", name: "read_file", args: { file_path: "fixture.txt" } }
      const assistant = new AIMessage({
        id: `graph-reply-${turn}`,
        additional_kwargs: { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "provider-ai" },
        content: "Reading the fixture",
        tool_calls: [toolCall]
      })
      const tool = new ToolMessage({
        id: `result-${turn}`,
        name: "read_file",
        content: `Result ${turn}`,
        tool_call_id: toolCall.id,
        status: "success"
      })
      const final = new AIMessage({
        id: `graph-final-${turn}`,
        additional_kwargs: { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "final-provider-ai" },
        content: "Fixture read"
      })
      transcript.push(boundary)
      values(transcript)
      flush([
        serialize("messages", [
          new AIMessage({
            id: "provider-ai",
            content: assistant.content,
            tool_calls: [toolCall]
          }),
          { checkpoint_ns: `model:${turn}` }
        ]).data
      ])
      transcript.push(assistant)
      values(transcript)
      if (streamedTool) flush([serialize("messages", [tool, {}]).data])
      transcript.push(tool)
      values(transcript)
      // Retry opens a fresh serialization stream and replays graph history.
      serialize = createStreamDataSerializer({ projectMessageChunks: true })
      accumulator = createSerializedValuesMessageAccumulator()
      values(transcript)
      flush([
        serialize("messages", [
          new AIMessageChunk({
            id: "final-provider-ai",
            content: final.content
          }),
          { checkpoint_ns: `model:final-${turn}` }
        ]).data
      ])
      transcript.push(final)
      values(transcript)
    }

    const path = join(mkdtempSync(join(tmpdir(), "cmb-goal-checkpoint-")), "checkpoints.sqlite")
    const saver = new SqlJsSaver(path)
    const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    await saver.put(
      config,
      {
        v: 1,
        id: "goal-checkpoint",
        ts: new Date().toISOString(),
        channel_values: { messages: transcript },
        channel_versions: { messages: 1 },
        versions_seen: {}
      },
      { source: "loop", step: 1, parents: {} }
    )
    await saver.close()
    await db.closeDatabase()
    await db.initializeDatabase()

    const reopenedCheckpoint = new SqlJsSaver(path)
    expect(
      (await reopenedCheckpoint.getTuple(config))?.checkpoint.channel_values.messages
    ).toHaveLength(9)
    await reopenedCheckpoint.close()
    const persisted = db.getThreadMessagesPage(threadId, { limit: 10 }).messages.slice(-6)
    expect(persisted.map((message) => [message.role, message.content])).toEqual([
      ["assistant", "Reading the fixture"],
      ["tool", "Result 1"],
      ["assistant", "Fixture read"],
      ["assistant", "Reading the fixture"],
      ["tool", "Result 2"],
      ["assistant", "Fixture read"]
    ])
    expect(persisted.map((message) => message.ordinal)).toEqual([43, 44, 45, 47, 48, 49])
    expect(db.getThreadMessageCount(threadId)).toBe(48)
    expect(db.getThreadMessagesByIds(threadId, boundaryIds)).toEqual([])
    expect(db.getThreadTranscriptBoundaryOrdinal(threadId, boundaryIds[1])).toBe(46)
    expect(
      persisted
        .filter((message) => message.provider_source_id === "provider-ai")
        .map((message) => message.provider_occurrence)
    ).toEqual([9, 10])
    const associations = buildToolResultAssociations(persisted)
    for (const [offset, turn] of [
      [0, 1],
      [3, 2]
    ]) {
      const { id, tool_calls } = persisted[offset]
      expect(associations.get(getWorkerToolUiKey(id, tool_calls?.[0].id, 0))).toEqual({
        content: `Result ${turn}`,
        is_error: false
      })
      expect(persisted[offset + 1]).toMatchObject({ tool_call_id: "same-call", status: "success" })
    }
  }
)

it("keeps reserved Goal positions through a steering splice and removes them on deletion", () => {
  const threadId = "goal-boundary-order"
  db.createThread(threadId)
  const write = (id: string, role: "user" | "assistant") => ({
    id,
    role,
    content: id,
    created_at: new Date()
  })
  db.upsertThreadMessages(threadId, [write("user", "user"), write("prior-reply", "assistant")])
  expect(db.reserveThreadGraphTranscriptBoundary(threadId, "continuation")).toBe(2)
  db.upsertThreadMessages(threadId, [write("continuation-reply", "assistant")])
  db.upsertThreadMessages(threadId, [write("injected", "user")])
  expect(db.moveThreadMessagesAfterAnchor(threadId, "user", ["injected"])).toBe(true)
  expect(db.getThreadTranscriptBoundaryOrdinal(threadId, "continuation")).toBe(3)
  expect(db.getThreadMessages(threadId).map(({ id, ordinal }) => [id, ordinal])).toEqual([
    ["user", 0],
    ["injected", 1],
    ["prior-reply", 2],
    ["continuation-reply", 4]
  ])
  db.upsertThreadMessages(threadId, [write("follow-up", "user")])
  expect(db.moveThreadMessagesAfterAnchor(threadId, "continuation", ["follow-up"])).toBe(true)
  expect(db.getThreadMessages(threadId).map(({ id, ordinal }) => [id, ordinal])).toEqual([
    ["user", 0],
    ["injected", 1],
    ["prior-reply", 2],
    ["follow-up", 4],
    ["continuation-reply", 5]
  ])
  db.deleteThread(threadId)
  expect(db.getThreadTranscriptBoundaryOrdinal(threadId, "continuation")).toBeUndefined()
})

it("preserves the previous result when another Goal boundary reuses raw tool IDs", () => {
  const threadId = "goal-reused-tool-result-id"
  db.createThread(threadId)
  for (const turn of [1, 2]) {
    const boundaryId = `turn-${turn}`
    const boundaryOrdinal = db.reserveThreadGraphTranscriptBoundary(threadId, boundaryId)
    const serialize = createStreamDataSerializer()
    const frame = serialize("messages", [
      new ToolMessage({
        id: "reused-result",
        tool_call_id: "reused-call",
        content: `Result in turn ${turn}`,
        status: "success"
      }),
      {}
    ])
    const queued = persistedMessageFromStreamPayload(frame.data)!
    const result = resolveStreamTranscriptFlush({
      queuedMessages: [queued],
      boundaryOrdinal,
      loadPreviousOccurrences: (sources) =>
        db.getThreadMessageProviderOccurrencesBeforeUser(threadId, boundaryId, sources),
      loadBaselineMessages: () =>
        db.getThreadMessageIdentityContext(threadId, [
          { messageId: queued.id, providerSourceId: queued.id, role: "tool" }
        ])
    })
    db.upsertThreadMessages(threadId, result.messages, {
      preserveExistingOrder: result.preserveExistingOrder
    })
  }

  expect(db.getThreadMessages(threadId)).toMatchObject([
    { ordinal: 1, content: "Result in turn 1", tool_call_id: "reused-call", status: "success" },
    {
      ordinal: 3,
      content: "Result in turn 2",
      provider_occurrence: 2,
      tool_call_id: "reused-call",
      status: "success"
    }
  ])
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
