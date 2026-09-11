import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AIMessageChunk } from "@langchain/core/messages"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const storageState = vi.hoisted(() => ({ databasePath: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storageState.databasePath,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as db from "./index"
import {
  openThreadMessageHydrationDatabase,
  readThreadMessagesPage
} from "../thread-message-hydration/page-reader"
import { mergeCheckpointAuthorityTranscriptMessages } from "../../shared/checkpoint-transcript"
import { normalizeVisibleReasoningText } from "../../renderer/src/lib/message-display-visibility"
import { stripThinkBlocksForDisplay } from "../../shared/think-block-display"
import { bootstrapLegacyCheckpointTranscript } from "../checkpointer/runtime-projection-store"
import type { Message } from "../types"
import {
  resolveStreamTranscriptFlush,
  readStreamTranscriptReasoning,
  type QueuedStreamTranscriptMessage
} from "../ipc/stream-transcript-flush"
import { createStreamDataSerializer } from "../ipc/stream-data-serialization"

let temporaryDirectory = ""
const fixtures: Message[] = [
  {
    id: "a1",
    role: "assistant",
    content: "回答 A",
    reasoning: "测试思考 A",
    created_at: new Date(1)
  },
  {
    id: "a2",
    role: "assistant",
    content: "<think>测试思考 B</think>\n\n回答 B",
    reasoning: "测试思考 B",
    created_at: new Date(2)
  }
]

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-reasoning-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await db.initializeDatabase()
  db.createThread("think-thread")
  db.upsertThreadMessages("think-thread", fixtures)
})

afterAll(async () => {
  await db.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

function projectForDisplay(message: Message) {
  const reasoning = normalizeVisibleReasoningText(message.reasoning)
  return {
    id: message.id,
    reasoning,
    content: reasoning ? stripThinkBlocksForDisplay(String(message.content)) : message.content
  }
}

describe("durable thread reasoning", () => {
  it("rejects a stale UI priority bump after a native clear and accepts the next native final", () => {
    const threadId = "stale-ui-priority-thread"
    db.createThread(threadId)
    const old = {
      id: "a",
      role: "assistant" as const,
      content: "old",
      created_at: new Date(1),
      tool_calls: [{ id: "call", name: "echo", args: { value: "trusted" } }]
    }
    db.upsertThreadMessages(threadId, [old])
    db.upsertThreadMessages(threadId, [{ ...old, content: "", content_mode: "snapshot" }])
    db.upsertThreadMessages(threadId, [{ ...old, content_priority: 1, tool_calls: [] }])
    expect(db.getThreadMessages(threadId)[0]).toMatchObject({
      content: "",
      tool_calls: old.tool_calls
    })
    expect(db.getThreadMessages(threadId)[0].content_priority).toBeUndefined()
    db.upsertThreadMessages(threadId, [
      { ...old, content: "native final", content_mode: "snapshot" }
    ])
    expect(db.getThreadMessages(threadId)[0].content).toBe("native final")
    db.upsertThreadMessages(threadId, [
      { ...old, id: "batch", content: "", content_mode: "snapshot" },
      { ...old, id: "batch", content_priority: 1, tool_calls: [] }
    ])
    expect(db.getThreadMessages(threadId)[1]).toMatchObject({
      content: "",
      tool_calls: old.tool_calls
    })
    expect(db.getThreadMessages(threadId)[1].content_priority).toBeUndefined()
  })

  it("keeps explicit clears across stale echoes, trusted deltas and database reopen", async () => {
    const threadId = "durable-clear-authority-thread"
    db.createThread(threadId)
    const old = {
      id: "a",
      role: "assistant" as const,
      content: "old draft",
      reasoning: "old reasoning",
      created_at: new Date(1)
    }
    db.upsertThreadMessages(threadId, [old])
    db.upsertThreadMessages(threadId, [
      { ...old, content: "", content_mode: "snapshot", reasoning: "", reasoning_mode: "snapshot" }
    ])
    db.upsertThreadMessages(threadId, [old])
    expect(db.getThreadMessages(threadId)[0]).toMatchObject({ content: "" })
    expect(db.getThreadMessages(threadId)[0].reasoning).toBeUndefined()
    db.upsertThreadMessages(threadId, [
      { ...old, content: "new", content_mode: "delta", reasoning: "new", reasoning_mode: "delta" }
    ])
    await db.closeDatabase()
    await db.initializeDatabase()
    db.upsertThreadMessages(threadId, [old])
    expect(db.getThreadMessages(threadId)[0]).toMatchObject({ content: "new", reasoning: "new" })
  })

  it("retains authority when a replacement and deltas coalesce in one upsert", () => {
    const threadId = "coalesced-content-authority-thread"
    db.createThread(threadId)
    const old = {
      id: "a",
      role: "assistant" as const,
      content: "old draft",
      created_at: new Date(1)
    }
    db.upsertThreadMessages(threadId, [old])
    db.upsertThreadMessages(threadId, [
      { ...old, content: "", content_mode: "snapshot" },
      { ...old, content: "ha", content_mode: "delta" },
      { ...old, content: "ha", content_mode: "delta" }
    ])
    db.upsertThreadMessages(threadId, [old])
    expect(db.getThreadMessages(threadId)[0].content).toBe("haha")
  })

  it("applies explicit reasoning replacements but preserves unmarked partial history", () => {
    const threadId = "reasoning-authority-thread"
    db.createThread(threadId)
    const message = {
      id: "a",
      role: "assistant" as const,
      content: "answer",
      created_at: new Date(1)
    }
    db.upsertThreadMessages(threadId, [{ ...message, reasoning: "long reasoning tail" }])
    db.upsertThreadMessages(threadId, [{ ...message, reasoning: "long" }])
    expect(db.getThreadMessages(threadId)[0].reasoning).toBe("long reasoning tail")
    db.upsertThreadMessages(threadId, [
      { ...message, reasoning: "long", reasoning_mode: "snapshot" }
    ])
    expect(db.getThreadMessages(threadId)[0].reasoning).toBe("long")
    db.upsertThreadMessages(threadId, [message])
    expect(db.getThreadMessages(threadId)[0].reasoning).toBe("long")
    db.upsertThreadMessages(threadId, [{ ...message, reasoning: "", reasoning_mode: "snapshot" }])
    expect(db.getThreadMessages(threadId)[0].reasoning).toBeUndefined()
  })

  it("preserves independent authority when aliases merge and threads are copied", () => {
    const source = "authority-alias-source"
    const target = "authority-copy-target"
    db.createThread(source)
    db.createThread(target)
    const old = {
      id: "canonical",
      role: "assistant" as const,
      content: "old",
      reasoning: "old",
      created_at: new Date(1)
    }
    db.upsertThreadMessages(source, [old])
    db.upsertThreadMessages(source, [
      {
        ...old,
        id: "temporary",
        content: "",
        reasoning: "",
        content_mode: "snapshot",
        reasoning_mode: "snapshot"
      }
    ])
    expect(db.replaceThreadMessageId(source, "temporary", "canonical", "assistant")).toBe(true)
    db.upsertThreadMessages(source, [old])
    expect(db.getThreadMessages(source)[0].content).toBe("")
    expect(db.getThreadMessages(source)[0].reasoning).toBeUndefined()
    db.upsertThreadMessages(target, db.applyThreadMessageStreamAuthority(source, [old]))
    db.upsertThreadMessages(target, [old])
    expect(db.getThreadMessages(target)[0].content).toBe("")
    expect(db.getThreadMessages(target)[0].reasoning).toBeUndefined()
    expect(db.getThreadMessages(target)[0]).not.toHaveProperty("stream_authority")
  })

  it("does not let reasoning authority freeze normal content updates or grant tool authority", () => {
    const threadId = "reasoning-only-authority-thread"
    db.createThread(threadId)
    const old = {
      id: "a",
      role: "assistant" as const,
      content: "first",
      reasoning: "old",
      created_at: new Date(1),
      tool_calls: [{ id: "call", name: "echo", args: {} }]
    }
    db.upsertThreadMessages(threadId, [old])
    db.upsertThreadMessages(threadId, [{ ...old, reasoning: "", reasoning_mode: "snapshot" }])
    db.upsertThreadMessages(threadId, [{ ...old, content: "first final" }])
    expect(db.getThreadMessages(threadId)[0]).toMatchObject({
      content: "first final",
      tool_calls: old.tool_calls
    })
    expect(db.getThreadMessages(threadId)[0].reasoning).toBeUndefined()
  })

  it("carries empty stream snapshots through the queue into SQLite", () => {
    const threadId = "empty-stream-snapshot-thread"
    db.createThread(threadId)
    const message = {
      id: "a",
      role: "assistant" as const,
      content: "draft",
      created_at: new Date(1)
    }
    db.upsertThreadMessages(threadId, [message])
    const result = resolveStreamTranscriptFlush({
      queuedMessages: [
        { ...message, content: "", streamContentMode: "snapshot", streamToolCallChunks: [] }
      ],
      loadBaselineMessages: () => db.getThreadMessages(threadId)
    })
    db.upsertThreadMessages(threadId, result.messages)
    expect(db.getThreadMessages(threadId)[0].content).toBe("")
  })

  it("preserves content priority and tool calls during content-only replacements", () => {
    const threadId = "stream-snapshot-priority-thread"
    db.createThread(threadId)
    const message = {
      id: "a",
      role: "assistant" as const,
      content: "answer",
      created_at: new Date(1)
    }
    const toolCalls = [{ id: "call", name: "lookup", args: {} }]
    db.upsertThreadMessages(threadId, [{ ...message, tool_calls: toolCalls, content_priority: 2 }])
    db.upsertThreadMessages(threadId, [{ ...message, content: "", content_mode: "snapshot" }])
    expect(db.getThreadMessages(threadId)[0]).toMatchObject({
      content: "answer",
      tool_calls: toolCalls
    })
    db.upsertThreadMessages(threadId, [
      {
        ...message,
        content: "",
        content_mode: "snapshot",
        content_priority: 2,
        tool_calls: toolCalls
      }
    ])
    expect(db.getThreadMessages(threadId)[0].content).toBe("")
    const plain = { ...message, id: "plain" }
    db.upsertThreadMessages(threadId, [{ ...plain, tool_calls: toolCalls }])
    db.upsertThreadMessages(threadId, [{ ...plain, content: "", content_mode: "snapshot" }])
    expect(db.getThreadMessages(threadId)[1]).toMatchObject({ content: "", tool_calls: toolCalls })
    expect(db.getThreadMessages(threadId)[1]).not.toHaveProperty("content_mode")
  })

  it("retains snapshot authority across coalesced reasoning updates", () => {
    const threadId = "coalesced-reasoning-authority-thread"
    db.createThread(threadId)
    const message = {
      id: "a",
      role: "assistant" as const,
      content: "answer",
      created_at: new Date(1)
    }
    db.upsertThreadMessages(threadId, [{ ...message, reasoning: "long reasoning tail" }])
    db.upsertThreadMessages(threadId, [
      { ...message, reasoning: "", reasoning_mode: "snapshot" },
      { ...message, reasoning: "new", reasoning_mode: "delta" }
    ])
    expect(db.getThreadMessages(threadId)[0].reasoning).toBe("new")
    expect(db.getThreadMessages(threadId)[0]).not.toHaveProperty("reasoning_mode")
  })

  it("preserves reasoning and recovery integrity when writes coalesce", () => {
    const threadId = "reasoning-integrity-thread"
    db.createThread(threadId)
    db.upsertThreadMessages(threadId, [
      { id: "plain", role: "assistant", content: "完整回答", created_at: new Date(1) },
      { id: "thinking", role: "assistant", content: "回答", created_at: new Date(2) },
      {
        id: "thinking",
        role: "assistant",
        content: "回答",
        reasoning: "保留思考内容",
        recovery_integrity: "unverified",
        created_at: new Date(2)
      }
    ])
    expect(db.getThreadMessages(threadId)).toMatchObject([
      { id: "plain", recovery_integrity: "verified" },
      { id: "thinking", reasoning: "保留思考内容", recovery_integrity: "unverified" }
    ])
  })

  it("persists provider reasoning snapshots independently of content delta mode", () => {
    const threadId = "provider-reasoning-thread"
    db.createThread(threadId)
    const serialize = createStreamDataSerializer({
      projectMessageChunks: true,
      messageChunkModes: { content: "snapshot", reasoning: "snapshot" }
    })
    const snapshots = [
      "initial",
      "initial reasoning",
      "replacement reasoning",
      "replacement reasoning complete"
    ]
    for (const [index, reasoning] of snapshots.entries()) {
      const payload = serialize("messages", [
        new AIMessageChunk({
          id: "provider-ai",
          content: "a".repeat(index + 1),
          additional_kwargs: { reasoning_content: reasoning }
        }),
        { langgraph_node: "agent" }
      ]).data as unknown[]
      const message = payload[0] as { kwargs: { content: string } }
      const result = resolveStreamTranscriptFlush({
        queuedMessages: [
          {
            id: "provider-ai",
            provider_source_id: "provider-ai",
            provider_occurrence: 1,
            role: "assistant",
            content: message.kwargs.content,
            ...readStreamTranscriptReasoning(payload, "delta"),
            created_at: new Date(1),
            streamContentMode: "delta",
            streamToolCallChunks: []
          }
        ],
        loadBaselineMessages: () => db.getThreadMessages(threadId)
      })
      db.upsertThreadMessages(threadId, result.messages)
      expect(db.getThreadMessages(threadId)[0].reasoning).toBe(reasoning)
    }
  })

  it("retains repeated reasoning deltas across flushes and idempotent renderer snapshots", () => {
    const threadId = "streaming-think-thread"
    db.createThread(threadId)
    const chunk = (
      reasoning: string,
      mode: "delta" | "snapshot" = "delta"
    ): QueuedStreamTranscriptMessage => ({
      id: "stream-ai",
      provider_source_id: "stream-ai",
      provider_occurrence: 1,
      role: "assistant",
      content: "",
      reasoning,
      reasoning_mode: mode,
      created_at: new Date(1),
      streamContentMode: "delta",
      streamToolCallChunks: []
    })
    let identity: ReturnType<typeof resolveStreamTranscriptFlush>["nextAssistantIdentity"]
    const flush = (queuedMessages: QueuedStreamTranscriptMessage[]) => {
      const result = resolveStreamTranscriptFlush({
        queuedMessages,
        currentAssistantIdentity: identity,
        loadBaselineMessages: () => db.getThreadMessages(threadId)
      })
      expect(result.appendTextDelta).not.toBe(true)
      db.upsertThreadMessages(threadId, result.messages, { preserveExistingOrder: true })
      identity = result.nextAssistantIdentity
    }
    flush([chunk("思"), chunk("思")])
    flush([chunk("思"), chunk("考")])
    expect(db.getThreadMessages(threadId)[0].reasoning).toBe("思思思考")
    const completed = "思思思考" + "完整内容".repeat(1000)
    flush([chunk(completed, "snapshot"), chunk("完成")])
    db.upsertThreadMessages(threadId, [
      {
        ...chunk(completed + "完成", "snapshot"),
        content: "最终回答"
      }
    ])
    db.upsertThreadMessages(threadId, [
      {
        id: "stream-ai",
        role: "assistant",
        content: "最终回答",
        created_at: new Date(1)
      }
    ])
    const stored = db.getThreadMessages(threadId)[0]
    expect(stored.reasoning).toBe(completed + "完成")
    expect(stored.content).toBe("最终回答")
    expect(stored).not.toHaveProperty("reasoning_mode")
  })

  it("fills missing checkpoint reasoning from the durable snapshot", () => {
    const base: Message[] = fixtures.map((message) => ({ ...message, reasoning: undefined }))
    expect(
      mergeCheckpointAuthorityTranscriptMessages(base, fixtures).map((message) => message.reasoning)
    ).toEqual(fixtures.map((message) => message.reasoning))
  })

  it("keeps reasoning when a temporary message id merges into its canonical row", () => {
    const threadId = "alias-think-thread"
    db.createThread(threadId)
    db.upsertThreadMessages(threadId, [
      { ...fixtures[0], id: "temporary", reasoning: "完整思考" },
      { ...fixtures[0], id: "canonical", reasoning: undefined }
    ])
    expect(db.replaceThreadMessageId(threadId, "temporary", "canonical", "assistant")).toBe(true)
    expect(db.getThreadMessages(threadId)).toMatchObject([
      { id: "canonical", reasoning: "完整思考", recovery_integrity: "unverified" }
    ])
  })

  it("includes reasoning in page budgets and bounds an oversized reasoning preview", () => {
    const threadId = "large-think-thread"
    db.createThread(threadId)
    db.upsertThreadMessages(
      threadId,
      Array.from({ length: 4 }, (_, index) => ({
        ...fixtures[0],
        id: `large-${index}`,
        reasoning: "思😀".repeat(35_000)
      }))
    )
    expect(db.getThreadMessagesPage(threadId, { byteBudget: 64 * 1024 }).messages).toHaveLength(1)
    const reader = openThreadMessageHydrationDatabase(storageState.databasePath)
    try {
      const { page } = readThreadMessagesPage(reader, {
        type: "read-page",
        requestId: 2,
        databasePath: storageState.databasePath,
        threadId,
        options: { byteBudget: 64 * 1024 },
        cancellationBuffer: new SharedArrayBuffer(4)
      })
      expect(page.messages).toHaveLength(1)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024)
      expect(page.truncatedMessageIds).toEqual(["large-3"])
      expect(page.messages[0].reasoning).toContain("当前仅显示有界预览")
      expect(page.messages[0].reasoning).not.toMatch(/[\uD800-\uDBFF]\n/)
      expect(page.hasMore).toBe(true)
      const next = readThreadMessagesPage(reader, {
        type: "read-page",
        requestId: 3,
        databasePath: storageState.databasePath,
        threadId,
        options: {
          byteBudget: 64 * 1024,
          beforeOrdinal: page.beforeOrdinal!,
          beforeMessageId: page.beforeMessageId!
        },
        cancellationBuffer: new SharedArrayBuffer(4)
      }).page
      expect(next.messages[0].id).toBe("large-2")
    } finally {
      reader.close()
    }
  })

  it("retains reasoning when the full checkpoint remains the authority (1.4.10 path)", () => {
    const durable = db.getThreadMessages("think-thread")
    const restored = mergeCheckpointAuthorityTranscriptMessages(fixtures, durable)
    expect(restored.map((message) => message.reasoning)).toEqual(
      fixtures.map((message) => message.reasoning)
    )
    expect(restored.map(projectForDisplay)).toEqual([
      { id: "a1", reasoning: "测试思考 A", content: "回答 A" },
      { id: "a2", reasoning: "测试思考 B", content: "回答 B" }
    ])
  })

  it("must preserve reasoning in a durable database round trip", () => {
    const durable = db.getThreadMessages("think-thread")
    expect(durable.map(projectForDisplay)).toEqual(fixtures.map(projectForDisplay))
    expect(durable.map((message) => message.reasoning)).toEqual(
      fixtures.map((message) => message.reasoning)
    )
    expect(durable.every((message) => message.recovery_integrity === "unverified")).toBe(true)
  })

  it("must preserve reasoning in the actual worker page reader after database reopen", async () => {
    await db.closeDatabase()
    await db.initializeDatabase()
    const reader = openThreadMessageHydrationDatabase(storageState.databasePath)
    try {
      const { page } = readThreadMessagesPage(reader, {
        type: "read-page",
        requestId: 1,
        databasePath: storageState.databasePath,
        threadId: "think-thread",
        options: { limit: 50, includeVisibleMessagePresence: true },
        cancellationBuffer: new SharedArrayBuffer(4)
      })
      expect(page.messages.map(projectForDisplay)).toEqual(fixtures.map(projectForDisplay))
      expect(page.messages.map((message) => message.reasoning)).toEqual(
        fixtures.map((message) => message.reasoning)
      )
    } finally {
      reader.close()
    }
  })

  it("must preserve reasoning when importing an old checkpoint into durable history", () => {
    const threadId = "legacy-think-thread"
    db.createThread(threadId)
    const checkpointPath = join(temporaryDirectory, "checkpoint.sqlite")
    const checkpointDb = new DatabaseSync(checkpointPath)
    checkpointDb.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, parent_checkpoint_id TEXT,
        checkpoint_ts TEXT, type TEXT, checkpoint BLOB, metadata BLOB
      );
      CREATE TABLE checkpoint_message_snapshots (
        thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, parent_checkpoint_id TEXT,
        prefix_length INTEGER NOT NULL DEFAULT 0, message_count INTEGER,
        generation TEXT NOT NULL DEFAULT '', type TEXT, suffix BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE checkpoint_runtime_projections (
        thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, parent_checkpoint_id TEXT,
        checkpoint_ts TEXT, projection_version INTEGER NOT NULL DEFAULT 1,
        type TEXT, runtime_checkpoint BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns)
      );
      CREATE TABLE writes (
        thread_id TEXT, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT,
        task_id TEXT, idx INTEGER, channel TEXT, type TEXT, value TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `)
    checkpointDb
      .prepare(
        `INSERT INTO checkpoints
      (thread_id, checkpoint_ns, checkpoint_id, checkpoint_ts, type, checkpoint, metadata)
      VALUES (?, '', 'checkpoint-1', '2026-08-17T00:00:00.000Z', 'json', ?, '{}')
    `
      )
      .run(
        threadId,
        JSON.stringify({
          channel_values: {
            messages: fixtures.map((message) => ({
              id: message.id,
              type: "ai",
              content: message.content,
              additional_kwargs: { reasoning: message.reasoning }
            }))
          },
          channel_versions: {},
          versions_seen: {}
        })
      )
    checkpointDb.close()
    const bootstrap = bootstrapLegacyCheckpointTranscript(
      checkpointPath,
      storageState.databasePath,
      threadId,
      "",
      new SharedArrayBuffer(4)
    )
    const durable = db.getThreadMessages(threadId)
    expect(bootstrap.stats.migratedMessages).toBe(2)
    const check = new DatabaseSync(checkpointPath, { readOnly: true })
    const snapshots = check.prepare("SELECT suffix FROM checkpoint_message_snapshots").all()
    expect(
      snapshots.some((row) =>
        Buffer.from(row.suffix as Uint8Array)
          .toString()
          .includes("测试思考 A")
      )
    ).toBe(true)
    check.close()
    expect(durable.map((message) => message.reasoning)).toEqual(
      fixtures.map((message) => message.reasoning)
    )
  })

  it("upgrades an old database without backfilling its existing messages", async () => {
    const originalPath = storageState.databasePath
    const oldPath = join(temporaryDirectory, "old-schema.sqlite")
    const currentSchema = String(
      db
        .getDb()
        .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_messages'")[0]
        .values[0][0]
    )
    const legacy = new DatabaseSync(oldPath)
    legacy.exec(
      currentSchema
        .replace("      reasoning TEXT,\n", "")
        .replace("      stream_authority INTEGER NOT NULL DEFAULT 0,\n", "")
    )
    expect(
      legacy
        .prepare("PRAGMA table_info(thread_messages)")
        .all()
        .some((column) => column.name === "reasoning")
    ).toBe(false)
    legacy
      .prepare(
        `INSERT INTO thread_messages
      (thread_id, message_id, role, content_json, created_at, ordinal)
      VALUES ('old-thread', 'old-message', 'assistant', '"旧回答"', 1, 0)
    `
      )
      .run()
    legacy.close()
    await db.closeDatabase()
    storageState.databasePath = oldPath
    try {
      await db.initializeDatabase()
      db.createThread("old-thread")
      expect(db.getThreadMessages("old-thread")[0]).toMatchObject({
        id: "old-message",
        content: "旧回答"
      })
      expect(db.getThreadMessages("old-thread")[0].reasoning).toBeUndefined()
      db.upsertThreadMessages("old-thread", [fixtures[0]])
      await db.closeDatabase()
      await db.initializeDatabase()
      expect(
        db.getThreadMessages("old-thread").find((message) => message.id === "a1")?.reasoning
      ).toBe(fixtures[0].reasoning)
    } finally {
      await db.closeDatabase()
      storageState.databasePath = originalPath
      await db.initializeDatabase()
    }
  })
})
