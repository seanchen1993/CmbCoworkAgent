import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Message, ThreadMessagesPageOptions } from "../types"

const state = vi.hoisted(() => ({ databasePath: "", readPage: vi.fn() }))
vi.mock("../storage", () => ({
  getDbPath: () => state.databasePath,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../thread-message-hydration/client", () => ({
  readThreadMessagesPageInWorker: state.readPage
}))

import * as threadDb from "../db"
import { recoverMainCheckpointMessages } from "../agent/checkpoint-message-recovery"
import { readThreadMessagesPage } from "../thread-message-hydration/page-reader"
import { readThreadHydrationProjection } from "../thread-metadata-hydration/reader"
import { bootstrapStockLegacyCheckpointTranscript } from "./legacy-stock-transcript-store"
import { hasPendingStockLegacyMessageTimes, migrateLegacyMessageTimes } from "./legacy-stock-message-times"
import type { LegacySearchBootstrapGuard } from "./runtime-projection-protocol"
import { sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { SqlJsSaver } from "./sqljs-saver"
import { persistedMessageToRuntimeMessage } from "../ipc/persisted-runtime-message"
import { GOAL_USER_EVENT_MESSAGE_ID_PREFIX, GOAL_USER_MESSAGE_EVENT_PREFIX } from "../../shared/goal-events"

const TS = "2026-09-01T00:00:20.000Z"
const START = "2026-09-01T00:00:00.000Z"
const END = "2026-09-01T00:00:10.000Z"
const metadata = { source: "loop", step: 1, writes: {}, parents: {} } as CheckpointMetadata
let directory = ""
let reader: DatabaseSync
const savers: SqlJsSaver[] = []

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-checkpoint-report-regressions-"))
  state.databasePath = join(directory, "messages.sqlite")
  await threadDb.initializeDatabase()
  threadDb.createThread("thread")
  reader = new DatabaseSync(state.databasePath)
  state.readPage.mockImplementation(async (_id: string, options: ThreadMessagesPageOptions) =>
    page(options)
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  state.readPage.mockReset()
  for (const saver of savers.splice(0)) await saver.close()
  reader.close()
  await threadDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function message(id: string, role: Message["role"], content: Message["content"] = id): Message {
  return { id, role, content, created_at: new Date(Date.parse(TS) - 1) }
}

function page(options: ThreadMessagesPageOptions = {}, auditStockLegacyTimes = false) {
  return readThreadMessagesPage(reader, {
    type: "read-page",
    requestId: 1,
    databasePath: state.databasePath,
    threadId: "thread",
    ...(auditStockLegacyTimes && { auditStockLegacyTimes: true as const }),
    options: { limit: 1000, byteBudget: 4 * 1024 * 1024, ...options },
    cancellationBuffer: new SharedArrayBuffer(4)
  }).page
}

function recovery(expected: number) {
  return recoverMainCheckpointMessages({
    threadId: "thread",
    checkpointNs: "",
    checkpointId: "cp",
    missingCheckpointId: "cp",
    checkpointTs: TS,
    expectedMessageCount: expected,
    hasInterrupt: true,
    requiresExactRecovery: true
  })
}

function config() {
  return { configurable: { thread_id: "thread", checkpoint_ns: "" } }
}

function checkpoint(messages: unknown[], interrupt = false): Checkpoint {
  return {
    v: 1,
    id: "cp",
    ts: TS,
    channel_values: {
      messages,
      ...(interrupt
        ? { __interrupt__: [{ value: { actionRequests: [{ action: "inspect" }] } }] }
        : {})
    },
    channel_versions: { messages: 1 },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

async function seedCheckpoint(
  messages: unknown[],
  options: { legacy?: boolean; interrupt?: boolean } = {}
) {
  const path = join(directory, "checkpoint.sqlite")
  const saver = new SqlJsSaver(path)
  savers.push(saver)
  const value = checkpoint(messages, options.interrupt)
  await saver.put(config(), value, metadata)
  const [type, payload] = await saver.serde.dumpsTyped(value)
  await saver.close()
  if (options.legacy) {
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
    raw.exec("DELETE FROM checkpoint_message_snapshots; DELETE FROM checkpoint_runtime_projections")
    raw.close()
  }
  return path
}

function bootstrap(path: string, guard?: LegacySearchBootstrapGuard) {
  const row = threadDb.getThreadCore("thread")
  const messageDatabaseFile = threadDb.getOpenDatabaseFile(threadDb.getDb())
  if (!row || !messageDatabaseFile) throw Error("Missing ordinary legacy fixture identity")
  return bootstrapStockLegacyCheckpointTranscript(
    path,
    state.databasePath,
    "thread",
    "",
    new SharedArrayBuffer(4),
    {
      messageDatabaseFile,
      checkpointFamilyKey: sqliteRecoveryFamilyKey(path),
      incarnation: captureThreadIncarnation(row),
      workspace: ""
    },
    guard
  )
}

it("continues backward pages from a live anchor after saved ordinals move", () => {
  threadDb.upsertThreadMessages("thread", [
    message("first", "user", "needle"),
    message("adjacent", "assistant", "needle"),
    { ...message("anchor", "user", "needle"), goal_id: "preserved-goal", active_window_id: "goal-window" }
  ])
  const event = threadDb.addThreadGoalEvent(
    "thread", `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal keep the archived prompt`, "preserved-goal", 1, "goal-window", "anchor"
  )
  const goalId = `${GOAL_USER_EVENT_MESSAGE_ID_PREFIX}${event.event_id}`
  const initial = page({ limit: 1 })
  expect(initial.messages.map((row) => row.id)).toEqual(["anchor"])
  const cursor = { limit: 1, beforeOrdinal: initial.beforeOrdinal!, beforeMessageId: initial.beforeMessageId! }
  reader.exec("UPDATE thread_messages SET ordinal = ordinal + 1")
  expect(page(cursor).messages.map((row) => row.id)).toEqual(["adjacent"])
  expect(threadDb.getThreadMessagesPage("thread", cursor).messages.map((row) => row.id)).toEqual(["adjacent"])
  expect(threadDb.searchThreadMessages("thread", "needle", cursor).matches.map((row) => row.messageId))
    .toEqual(["adjacent"])
  expect(page({ targetMessageId: "adjacent", residentMessageIds: ["anchor", goalId, "missing"] }).residentOrdinals)
    .toEqual([["anchor", (initial.beforeOrdinal ?? 0) + 1], [goalId, (initial.beforeOrdinal ?? 0) + 1, "anchor"], ["missing", null]])
})

describe("checkpoint recovery storage provenance", () => {
  it("round-trips image blocks through durable storage, repair, and a second reopen", async () => {
    const content = [
      { type: "text", text: "inspect" },
      { type: "image_url", image_url: { url: "data:image/png;base64,audit", detail: "high" } }
    ] as unknown as Message["content"]
    const args = { options: { resolution: [640, 480] } }
    const toolCalls = [{ id: "tool-1", name: "inspect", args }]
    threadDb.upsertThreadMessages("thread", [
      message("u-1", "user", content),
      { ...message("a-1", "assistant", ""), tool_calls: toolCalls }
    ])
    const path = await seedCheckpoint(
      [
        new HumanMessage({ id: "u-1", content: content as HumanMessage["content"] }),
        new AIMessage({ id: "a-1", content: "", tool_calls: toolCalls })
      ],
      { interrupt: true }
    )
    const raw = new DatabaseSync(path)
    raw.exec("DELETE FROM checkpoint_message_snapshots")
    raw.close()
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: recoverMainCheckpointMessages
    })
    savers.push(saver)
    const repaired = await saver.getTuple(config())
    expect(repaired?.checkpoint.channel_values.messages).toMatchObject([
      { content },
      { tool_calls: toolCalls }
    ])
    expect(state.readPage).toHaveBeenCalledOnce()
    await saver.close()
    const reopened = new SqlJsSaver(path)
    savers.push(reopened)
    expect((await reopened.getTuple(config()))?.checkpoint.channel_values.messages).toMatchObject([
      { content },
      { tool_calls: toolCalls }
    ])
  })

  it("rejects an already-clamped nested tool object without repairing its snapshot", async () => {
    const args = { a: { b: { c: { d: { e: { f: { value: 42 } } } } } } }
    const calls = [{ id: "tool-1", name: "inspect", args }]
    threadDb.upsertThreadMessages("thread", [{ ...message("a-1", "assistant"), tool_calls: calls }])
    const hydrated = page({ recoveryCheckpointId: "cp" })
    expect(hydrated.truncatedMessageIds).toBeUndefined()
    expect(hydrated.messages[0].tool_calls).not.toEqual(calls)
    expect(hydrated.recoveryIntegrity).toBe("unverified")
    expect(await recovery(1)).toBeNull()
    const path = await seedCheckpoint(
      [new AIMessage({ id: "a-1", content: "a-1", tool_calls: calls })],
      { interrupt: true }
    )
    const raw = new DatabaseSync(path)
    raw.exec("DELETE FROM checkpoint_message_snapshots")
    const saver = new SqlJsSaver(path, undefined, {
      recoverMissingCheckpointMessages: recoverMainCheckpointMessages
    })
    savers.push(saver)
    await expect(saver.getTuple(config())).rejects.toMatchObject({
      code: "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED"
    })
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM checkpoint_message_snapshots").get()?.count
    ).toBe(0)
    raw.close()
  })

  it.each([
    ["long text", "x".repeat(120_001), undefined],
    [
      "prototype key",
      "",
      [{ id: "t", name: "inspect", args: JSON.parse('{"__proto__":{"value":42}}') }]
    ],
    ["block limit", Array.from({ length: 81 }, () => ({ type: "text", text: "x" })), undefined],
    [
      "tool count",
      "",
      Array.from({ length: 51 }, (_, i) => ({ id: `t-${i}`, name: "inspect", args: {} }))
    ],
    [
      "object keys",
      "",
      [
        {
          id: "t",
          name: "inspect",
          args: Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`k${i}`, i]))
        }
      ]
    ]
  ])(
    "keeps %s truncation uncertified across overwrite and reload",
    async (_name, content, calls) => {
      threadDb.upsertThreadMessages("thread", [
        {
          ...message("a", "assistant", content as Message["content"]),
          tool_calls: calls as Message["tool_calls"]
        }
      ])
      threadDb.upsertThreadMessages("thread", [
        { ...message("a", "assistant", "short"), content_priority: 1 }
      ])
      expect(page({ recoveryCheckpointId: "cp" }).recoveryIntegrity).toBe("unverified")
      expect(await recovery(1)).toBeNull()
    }
  )

  it("does not certify old rows by reading, updating timestamps, or copying their preview", async () => {
    threadDb.upsertThreadMessages("thread", [message("old", "user", "[Object]")])
    reader.exec("UPDATE thread_messages SET recovery_integrity = NULL")
    const old = threadDb.getThreadMessages("thread")[0]
    expect(old.recovery_integrity).toBe("unverified")
    threadDb.upsertThreadMessages("thread", [{ ...old, end_at: new Date() }])
    threadDb.upsertThreadMessages("thread", [{ ...old, id: "copy" }])
    expect(page().messages.every((m) => m.recovery_integrity === "unverified")).toBe(true)
    expect(await recovery(2)).toBeNull()
  })

  it("marks discarded streaming deltas without rescanning the accumulated text", () => {
    const identity = { provider_source_id: "a", provider_occurrence: 1 }
    threadDb.upsertThreadMessages("thread", [
      { ...message("a", "assistant", "x".repeat(119_999)), ...identity }
    ])
    expect(
      threadDb.appendThreadMessageTextDelta("thread", {
        ...message("a", "assistant", "yz"),
        ...identity
      })
    ).toBe(true)
    expect(page({ recoveryCheckpointId: "cp" }).recoveryIntegrity).toBe("unverified")
    expect(
      reader.prepare("SELECT recovery_integrity FROM thread_messages").get()?.recovery_integrity
    ).toBe(0)
    const run = vi.spyOn(threadDb.getDb(), "run")
    for (let index = 0; index < 100; index += 1) {
      expect(
        threadDb.appendThreadMessageTextDelta("thread", {
          ...message("a", "assistant", "discarded"),
          ...identity
        })
      ).toBe(true)
    }
    expect(run).not.toHaveBeenCalled()
    run.mockRestore()
  })

  it("keeps lost provenance when two aliases merge", () => {
    threadDb.upsertThreadMessages("thread", [message("a", "assistant"), message("b", "assistant")])
    reader.exec("UPDATE thread_messages SET recovery_integrity = NULL WHERE message_id = 'a'")
    expect(threadDb.replaceThreadMessageId("thread", "a", "b", "assistant")).toBe(true)
    expect(page({ recoveryCheckpointId: "cp" }).recoveryIntegrity).toBe("unverified")
  })
})

describe("legacy checkpoint timing migration", () => {
  const legacyMessages = () => [
    new HumanMessage({ id: "u", content: "question" }),
    new AIMessage({ id: "a", content: "answer" })
  ]

  it.each([false, true])(
    "restores the old ten-second duration (compact merge first: %s)",
    async (mergeFirst) => {
      threadDb.updateThread("thread", {
        thread_values: JSON.stringify({
          messageTimes: { a: { start_at: START, end_at: END } },
          messageTimeOrder: [{ id: "a", start_at: START, end_at: END }]
        })
      })
      if (mergeFirst) threadDb.mergeThreadValues("thread", { todos: [] })
      const path = await seedCheckpoint(legacyMessages(), { legacy: true })
      bootstrap(path)
      const answer = page({ includeVisibleMessagePresence: true }).messages.find(
        (m) => m.id === "a"
      )!
      expect(answer.start_at?.toISOString()).toBe(START)
      expect(answer.end_at?.toISOString()).toBe(END)
      expect(answer.created_at.toISOString()).toBe(START)
      expect(
        page({ includeVisibleMessagePresence: true }).legacyMessageTimesPending
      ).toBeUndefined()
      const projection = readThreadHydrationProjection(reader, {
        type: "read-thread",
        requestId: 1,
        databasePath: state.databasePath,
        threadId: "thread",
        cancellationBuffer: new SharedArrayBuffer(4)
      })
      expect(projection.thread?.thread_values).toEqual({})
      threadDb.mergeThreadValues("thread", { todos: [] })
      expect(
        page()
          .messages.find((m) => m.id === "a")
          ?.end_at?.toISOString()
      ).toBe(END)
    }
  )

  it("repairs a previously completed import and does no timing writes on another bootstrap", async () => {
    const path = await seedCheckpoint(legacyMessages(), { legacy: true })
    bootstrap(path)
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({ messageTimes: { a: { start_at: START, end_at: END } } })
    })
    expect(page({ includeVisibleMessagePresence: true }).legacyMessageTimesPending).toBe(true)
    bootstrap(path)
    expect(
      page()
        .messages.find((m) => m.id === "a")
        ?.end_at?.toISOString()
    ).toBe(END)
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare")
    bootstrap(path)
    expect(
      prepare.mock.calls.some(([sql]) => /UPDATE thread_messages\s+SET start_at/.test(sql))
    ).toBe(false)
  })

  it("supports complete old positional order but refuses an order shifted by an extra event", async () => {
    const path = await seedCheckpoint(legacyMessages(), { legacy: true })
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimeOrder: [
          { id: "old-u", start_at: START },
          { id: "old-a", start_at: START, end_at: END }
        ]
      })
    })
    bootstrap(path)
    expect(
      page()
        .messages.find((m) => m.id === "a")
        ?.end_at?.toISOString()
    ).toBe(END)
    reader.exec("UPDATE thread_messages SET start_at = NULL, end_at = NULL")
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimeOrder: [
          { id: "event", start_at: START },
          { id: "old-u", start_at: START },
          { id: "old-a", start_at: START, end_at: END }
        ]
      })
    })
    bootstrap(path)
    expect(page().messages.every((m) => !m.start_at && !m.end_at)).toBe(true)
  })

  it.each(["named", "positional"])("checks %s timing when the first checkpoint contains only a suffix",
    async (mode) => {
    threadDb.upsertThreadMessages("thread", [
      message("older-reply", "assistant", "first persisted reply"),
      message("tail-reply", "assistant", "last persisted reply")
    ])
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify(mode === "named"
        ? { messageTimes: {
            "older-reply": { start_at: START, end_at: END },
            "tail-reply": { start_at: END, end_at: TS }
          } }
        : { messageTimeOrder: [{ start_at: START, end_at: END }, { start_at: END, end_at: TS }] })
    })
    const path = await seedCheckpoint([
      new AIMessage({ id: "tail-reply", content: "last persisted reply" }),
      new HumanMessage({ id: "new-question", content: "imported question" })
    ], { legacy: true })
    bootstrap(path)
    const messages = page().messages
    expect(messages.map((row) => row.id)).toEqual(["older-reply", "tail-reply", "new-question"])
    expect(messages.map((row) => row.start_at?.toISOString())).toEqual(
      mode === "named" ? [START, END, undefined] : [undefined, undefined, undefined])
    expect(reader.prepare("SELECT applied_checkpoint_id FROM thread_legacy_message_times").get()
      ?.applied_checkpoint_id).toBe(mode === "named" ? "cp" : null)
  })

  it("rechecks a timing archive already marked applied by an older reader", async () => {
    threadDb.upsertThreadMessages("thread", [
      message("older-reply", "assistant"),
      { ...message("tail-reply", "assistant"), start_at: new Date(END), end_at: new Date(TS) }
    ])
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({ messageTimes: {
        "older-reply": { start_at: START, end_at: END },
        "tail-reply": { start_at: END, end_at: TS }
      } })
    })
    reader.exec(`UPDATE thread_legacy_message_times
      SET applied_checkpoint_id = 'cp', applied_context = NULL WHERE thread_id = 'thread'`)
    const path = await seedCheckpoint([new AIMessage({ id: "tail-reply", content: "tail-reply" })], { legacy: true })
    expect(hasPendingStockLegacyMessageTimes(reader, "thread", "cp")).toBe(true)
    bootstrap(path)
    expect(page().messages.map((row) => row.start_at?.toISOString())).toEqual([START, END])
    expect(hasPendingStockLegacyMessageTimes(reader, "thread", "cp")).toBe(false)
    expect(reader.prepare("SELECT applied_checkpoint_id, applied_context FROM thread_legacy_message_times").get())
      .toEqual({ applied_checkpoint_id: "cp", applied_context: expect.any(String) })
    const firstPage = { includeVisibleMessagePresence: true }
    expect(page(firstPage, true).legacyMessageTimesPending).toBeUndefined()
    // A raw tail append deliberately leaves both the app bucket and the structure epoch
    // untouched. The existing stock source ledger must still trigger an exact re-audit.
    reader.exec(`INSERT INTO thread_messages (thread_id, message_id, ordinal, role, content_json, created_at)
      SELECT 'thread', 'raw-tail', MAX(ordinal) + 1, 'assistant', '"raw tail"', ${Date.parse(TS)}
      FROM thread_messages WHERE thread_id = 'thread'`)
    expect(page(firstPage, true).legacyMessageTimesPending).toBe(true)
    expect(page(firstPage).legacyMessageTimesPending).toBeUndefined()
    reader.exec("DELETE FROM legacy_checkpoint_transcript_sources WHERE thread_id = 'thread'")
    expect(page(firstPage, true).legacyMessageTimesPending).toBeUndefined()
  })

  it("audits the changed durable membership when a checkpoint keeps its ID", async () => {
    threadDb.upsertThreadMessages("thread", [message("tail-reply", "assistant")])
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({ messageTimes: {
        "older-reply": { start_at: START, end_at: END },
        "tail-reply": { start_at: END, end_at: TS }
      } })
    })
    const tail = new AIMessage({ id: "tail-reply", content: "tail-reply" })
    const path = await seedCheckpoint([tail], { legacy: true })
    bootstrap(path)
    expect(hasPendingStockLegacyMessageTimes(reader, "thread", "cp")).toBe(false)
    const source = new SqlJsSaver(path)
    const restored = new AIMessage({ id: "older-reply", content: "older-reply" })
    const [type, payload] = await source.serde.dumpsTyped(checkpoint([restored, tail]))
    await source.close()
    const checkpointDb = new DatabaseSync(path)
    try {
      checkpointDb.prepare("UPDATE checkpoints SET type = ?, checkpoint = ? WHERE checkpoint_id = 'cp'")
        .run(type, payload)
    } finally {
      checkpointDb.close()
    }
    bootstrap(path)
    expect(page().messages.map((row) => [row.id, row.start_at?.toISOString()]))
      .toEqual([["older-reply", START], ["tail-reply", END]])
    expect(hasPendingStockLegacyMessageTimes(reader, "thread", "cp")).toBe(false)
  })

  it("preserves the original positional archive after a proven append to an interrupted copy", async () => {
    const originalCount = 70
    const original = Array.from({ length: originalCount }, (_, index) =>
      new AIMessage({ id: `time-${index}`, content: `old replay ${index}` }))
    threadDb.updateThread("thread", { thread_values: JSON.stringify({
      messageTimeOrder: Array.from({ length: originalCount }, () => ({ start_at: START, end_at: END }))
    }) })
    const path = await seedCheckpoint(original, { legacy: true })
    reader.exec(`CREATE TRIGGER stop_original_copy BEFORE INSERT ON thread_messages WHEN NEW.message_id = 'time-65'
      BEGIN SELECT RAISE(ABORT, 'interrupted positional archive'); END;`)
    expect(() => bootstrap(path)).toThrow("interrupted positional archive")
    reader.exec("DROP TRIGGER stop_original_copy")
    const saver = new SqlJsSaver(path)
    const [type, payload] = await saver.serde.dumpsTyped(checkpoint([
      ...original, new AIMessage({ id: "appended", content: "new replay" })
    ]))
    await saver.close()
    const source = new DatabaseSync(path)
    try {
      source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
    } finally {
      source.close()
    }
    expect(bootstrap(path).stats.searchProjectionState).toBe("complete")
    expect(page().messages.map((row) => row.start_at?.toISOString()))
      .toEqual([...Array.from({ length: originalCount }, () => START), undefined])
    expect(hasPendingStockLegacyMessageTimes(reader, "thread", "cp")).toBe(false)
  })

  it("preserves an unpublished positional time archive across a proven provider revision", async () => {
    const assistant = (id: string, content: string) => persistedMessageToRuntimeMessage({
      id, role: "assistant", content, created_at: new Date(TS),
      provider_source_id: "stable-provider", provider_occurrence: 1
    })
    threadDb.updateThread("thread", { thread_values: JSON.stringify({
      messageTimeOrder: [{ start_at: START, end_at: END }]
    }) })
    const path = await seedCheckpoint([assistant("temporary", "old provisional")], { legacy: true })
    const row = reader.prepare(`SELECT created_at, json_extract(metadata, '$.cmb_thread_incarnation') AS token
      FROM threads WHERE thread_id = 'thread'`).get()
    const guarded = () => bootstrap(path, {
      incarnation: { token: typeof row?.token === "string" ? row.token : null, legacyCreatedAt: Number(row?.created_at) }
    })
    expect(guarded().stats.searchProjectionState).toBe("complete")
    expect(page().messages[0].start_at).toBeUndefined()
    const saver = new SqlJsSaver(path)
    const [type, payload] = await saver.serde.dumpsTyped(checkpoint([
      assistant("temporary", "updated provisional"),
      assistant("canonical", "updated provisional and final reply"),
      new HumanMessage({ id: "later", content: "following history" })
    ]))
    await saver.close()
    const source = new DatabaseSync(path)
    try {
      source.prepare("UPDATE checkpoints SET type = ?, checkpoint = ?").run(type, payload)
    } finally {
      source.close()
    }
    expect(guarded().stats.searchProjectionState).toBe("complete")
    expect(bootstrap(path).stats.searchProjectionState).toBe("complete")
    expect(page().messages.map((item) => [item.id, item.start_at?.toISOString(), item.end_at?.toISOString()]))
      .toEqual([["temporary", START, END], ["later", undefined, undefined]])
  })

  it("preserves existing durable times and ignores invalid/backward legacy times", async () => {
    threadDb.upsertThreadMessages("thread", [
      { ...message("a", "assistant"), start_at: new Date(START), end_at: new Date(END) }
    ])
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimes: {
          a: { start_at: END, end_at: START },
          u: { start_at: "invalid", end_at: "invalid" }
        }
      })
    })
    const path = await seedCheckpoint(legacyMessages(), { legacy: true })
    bootstrap(path)
    expect(
      page()
        .messages.find((m) => m.id === "a")
        ?.start_at?.toISOString()
    ).toBe(START)
    expect(page().messages.find((m) => m.id === "u")?.start_at).toBeUndefined()
  })

  it("archives a large map without parsing it on the main process compact-write path", () => {
    const map = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`old-${i}`, { start_at: START, end_at: END }])
    )
    threadDb.updateThread("thread", { thread_values: JSON.stringify({ messageTimes: map }) })
    const originalParse = JSON.parse
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.length > 100_000)
        throw new Error("main parsed legacy timing map")
      return originalParse(text, reviver)
    })
    expect(() => threadDb.mergeThreadValues("thread", { todos: [] })).not.toThrow()
    expect(
      reader.prepare("SELECT length(values_json) AS size FROM thread_legacy_message_times").get()
        ?.size
    ).toBeGreaterThan(100_000)
    threadDb.deleteThread("thread")
    expect(
      reader.prepare("SELECT COUNT(*) AS count FROM thread_legacy_message_times").get()?.count
    ).toBe(0)
  })

  it("leaves a resumable archive if timing backfill is cancelled between bounded batches", () => {
    const messages = Array.from({ length: 130 }, (_, i) => message(`a-${i}`, "assistant"))
    threadDb.upsertThreadMessages("thread", messages)
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimes: Object.fromEntries(
          messages.map((m) => [m.id, { start_at: START, end_at: END }])
        )
      })
    })
    const targets = messages.map((m) => ({
      messageId: m.id,
      providerSourceId: null,
      providerOccurrence: null
    }))
    const execute = reader.exec.bind(reader)
    let committed = false
    const exec = vi.spyOn(reader, "exec").mockImplementation((sql) => {
      execute(sql)
      if (sql === "COMMIT") committed = true
    })
    try {
      expect(() =>
        migrateLegacyMessageTimes(reader, "thread", "cp", targets, () => {
          if (committed) throw new Error("cancelled")
        })
      ).toThrow("cancelled")
    } finally {
      exec.mockRestore()
    }
    const partial = Number(reader.prepare("SELECT COUNT(*) AS count FROM thread_messages WHERE end_at = ?")
      .get(Date.parse(END))?.count ?? 0)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(messages.length)
    expect(
      reader.prepare("SELECT applied_checkpoint_id FROM thread_legacy_message_times").get()
        ?.applied_checkpoint_id
    ).toBeNull()
    migrateLegacyMessageTimes(reader, "thread", "cp", targets, () => {})
    expect(
      reader
        .prepare("SELECT COUNT(*) AS count FROM thread_messages WHERE end_at = ?")
        .get(Date.parse(END))?.count
    ).toBe(130)
  })

  it("does not apply a stale archive when its source changes before staging", () => {
    threadDb.upsertThreadMessages("thread", [message("a", "assistant")])
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimes: { a: { start_at: START, end_at: END } }
      })
    })
    threadDb.mergeThreadValues("thread", { todos: [] })
    const prepare = reader.prepare.bind(reader)
    const spy = vi.spyOn(reader, "prepare").mockImplementation((sql) => {
      if (sql.includes("INSERT INTO thread_legacy_message_times")) {
        threadDb.updateThread("thread", {
          thread_values: JSON.stringify({
            messageTimes: { a: { start_at: END, end_at: TS } }
          })
        })
      }
      return prepare(sql)
    })
    const targets = [{ messageId: "a", providerSourceId: null, providerOccurrence: null }]
    migrateLegacyMessageTimes(reader, "thread", "cp", targets, () => {})
    spy.mockRestore()
    expect(page().messages[0].start_at).toBeUndefined()
    migrateLegacyMessageTimes(reader, "thread", "cp", targets, () => {})
    expect(page().messages[0].start_at?.toISOString()).toBe(END)
  })

  it("bounds timing repairs by the size of the rows SQLite rewrites", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      ...message(`long-${i}`, "assistant"),
      content: "x".repeat(116_000)
    }))
    threadDb.upsertThreadMessages("thread", messages)
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimes: Object.fromEntries(messages.map((row) =>
          [row.id, { start_at: START, end_at: END }]))
      })
    })
    const targets = messages.map((row) => ({
      messageId: row.id,
      providerSourceId: null,
      providerOccurrence: null
    }))
    const exec = vi.spyOn(reader, "exec")
    try {
      migrateLegacyMessageTimes(reader, "thread", "cp", targets, () => {})
      expect(exec.mock.calls.filter(([sql]) => sql === "COMMIT").length).toBeGreaterThanOrEqual(3)
      expect(reader.prepare(`SELECT count(*) AS count FROM thread_messages
        WHERE start_at = ? AND end_at = ? AND octet_length(content_json) > 100000`)
        .get(Date.parse(START), Date.parse(END))?.count).toBe(messages.length)
      expect(reader.prepare("SELECT applied_checkpoint_id FROM thread_legacy_message_times").get()
        ?.applied_checkpoint_id).toBe("cp")
    } finally {
      exec.mockRestore()
    }
  })

  it("archives new timing values even when the previous values were null or invalid JSON", () => {
    for (const previous of [null, "invalid"]) {
      reader.prepare("UPDATE threads SET thread_values = ?").run(previous)
      reader.exec("DELETE FROM thread_legacy_message_times")
      threadDb.updateThread("thread", {
        thread_values: JSON.stringify({
          messageTimes: { a: { start_at: START, end_at: END } }
        })
      })
      expect(
        reader.prepare("SELECT values_json FROM thread_legacy_message_times").get()?.values_json
      ).toContain(START)
    }
  })

  it("does not backfill into a same-millisecond recreation of the thread", () => {
    const oldCreatedAt = threadDb.getThreadCore("thread")!.created_at
    const messages = Array.from({ length: 130 }, (_, i) => message(`a-${i}`, "assistant"))
    threadDb.upsertThreadMessages("thread", messages)
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimes: Object.fromEntries(
          messages.map((m) => [m.id, { start_at: START, end_at: END }])
        )
      })
    })
    const execute = reader.exec.bind(reader)
    let recreated = false
    const exec = vi.spyOn(reader, "exec").mockImplementation((sql) => {
      if (!recreated && sql === "BEGIN IMMEDIATE") {
        recreated = true
        threadDb.deleteThread("thread")
        threadDb.createThread("thread")
        reader.prepare("UPDATE threads SET created_at = ? WHERE thread_id = 'thread'")
          .run(oldCreatedAt)
        threadDb.upsertThreadMessages("thread", messages)
      }
      execute(sql)
    })
    try {
      migrateLegacyMessageTimes(
        reader,
        "thread",
        "cp",
        messages.map((m) => ({ messageId: m.id, providerSourceId: null, providerOccurrence: null })),
        () => {}
      )
    } finally {
      exec.mockRestore()
    }
    expect(recreated).toBe(true)
    expect(
      reader
        .prepare(
          "SELECT COUNT(*) AS count FROM thread_messages WHERE start_at IS NOT NULL OR end_at IS NOT NULL"
        )
        .get()?.count
    ).toBe(0)
  })

  it("does not create a negative duration by filling half of an existing timing pair", async () => {
    threadDb.upsertThreadMessages("thread", [
      { ...message("u", "user"), start_at: new Date(END) },
      { ...message("a", "assistant"), end_at: new Date(START) }
    ])
    threadDb.updateThread("thread", {
      thread_values: JSON.stringify({
        messageTimes: {
          u: { start_at: START, end_at: START },
          a: { start_at: END, end_at: END }
        }
      })
    })
    bootstrap(await seedCheckpoint(legacyMessages(), { legacy: true }))
    expect(page().messages.find((m) => m.id === "u")?.end_at).toBeUndefined()
    expect(page().messages.find((m) => m.id === "a")?.start_at).toBeUndefined()
  })
})
