/**
 * Regression tests for durable visible thread transcript persistence.
 *
 * Run:
 *   npx tsx tests/thread-messages-db.spec.ts
 */

import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { Message } from "../src/main/types.ts"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../src/shared/checkpoint-transcript.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function checkpointConfig(threadId: string, checkpointId?: string): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId }
  }
}

function checkpointMetadata(): CheckpointMetadata {
  return {
    source: "input",
    step: 0,
    writes: {},
    parents: {}
  } as CheckpointMetadata
}

function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: "2026-07-08T02:00:00.000Z",
    channel_values: {
      messages: [
        { id: "user-1", type: "human", content: "旧问题" },
        { id: "assistant-1", type: "ai", content: "旧回答" }
      ],
      __interrupt__: [{ value: { actionRequests: [{ action: "shell", args: {} }] } }]
    },
    channel_versions: { messages: 1 },
    versions_seen: {},
    pending_sends: []
  } as unknown as Checkpoint
}

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), "cmb-thread-messages-db-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(home, { recursive: true, force: true })
  }
}

async function testMessagesPersistAcrossReopen(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-visible-messages"
  const startedAt = new Date("2026-07-07T01:00:00.000Z")

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Visible transcript" })
  assertEqual(
    db.upsertThreadMessages(threadId, [
      {
        id: "user-1",
        role: "user",
        content: "请检查动态工作流历史",
        goal_id: "goal-1",
        active_window_id: "window-1",
        created_at: startedAt,
        start_at: startedAt,
        end_at: startedAt
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "历史",
        created_at: new Date(startedAt.getTime() + 1000)
      }
    ]),
    2,
    "initial insert count should include both messages"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-1",
      role: "assistant",
      content: "历史恢复已落盘",
      tool_calls: [{ id: "tool-1", name: "inspect", args: { target: "checkpoint" } }],
      created_at: new Date(startedAt.getTime() + 1500)
    }
  ])

  let messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 2, "thread should have two visible messages")
  assertEqual(messages[0].id, "user-1", "user message should keep insertion order")
  assertEqual(messages[0].goal_id, "goal-1", "goal id should persist")
  assertEqual(messages[0].active_window_id, "window-1", "active window id should persist")
  assertEqual(messages[1].id, "assistant-1", "assistant message should keep insertion order")
  assertEqual(messages[1].content, "历史恢复已落盘", "stream snapshot should replace prefix")
  assertEqual(messages[1].tool_calls?.[0]?.name, "inspect", "tool calls should persist")

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 2, "messages should reload after database reopen")
  assert(messages[0].created_at instanceof Date, "created_at should hydrate as Date")
  assertEqual(messages[0].active_window_id, "window-1", "goal metadata should survive reopen")
  assertEqual(messages[1].content, "历史恢复已落盘", "assistant content should survive reopen")

  db.deleteThread(threadId)
  assertEqual(db.getThreadMessages(threadId).length, 0, "deleteThread should clear transcript")
  await db.closeDatabase()
}

async function testStreamingDeltaMerge(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-stream-delta"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Streaming delta" })
  const chunks: Message[] = [
    { id: "assistant-delta", role: "assistant", content: "一", created_at: new Date() },
    { id: "assistant-delta", role: "assistant", content: "二", created_at: new Date() },
    { id: "assistant-delta", role: "assistant", content: "三", created_at: new Date() }
  ]
  for (const chunk of chunks) db.upsertThreadMessages(threadId, [chunk])

  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 1, "streaming deltas should keep one message row")
  assertEqual(messages[0].content, "一二三", "streaming deltas should append in order")

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testBatchStreamingDeltaCoalesce(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-stream-delta-batch"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Streaming delta batch" })
  const chunks: Message[] = [
    { id: "assistant-delta-batch", role: "assistant", content: "一", created_at: new Date() },
    { id: "assistant-delta-batch", role: "assistant", content: "二", created_at: new Date() },
    { id: "assistant-delta-batch", role: "assistant", content: "三", created_at: new Date() }
  ]
  const count = db.upsertThreadMessages(threadId, chunks)

  const messages = db.getThreadMessages(threadId)
  assertEqual(count, 1, "batched streaming deltas should count one upserted message")
  assertEqual(messages.length, 1, "batched streaming deltas should keep one message row")
  assertEqual(messages[0].content, "一二三", "batched streaming deltas should append in order")

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testTranscriptUpsertDoesNotTouchThreadUpdatedAt(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-transcript-no-touch"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Transcript-only update" })
  const before = db.getThread(threadId)?.updated_at
  assert(typeof before === "number", "thread should exist before transcript upsert")

  await delay(10)
  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-no-touch",
      role: "assistant",
      content: "只更新可见 transcript",
      created_at: new Date()
    }
  ])

  const after = db.getThread(threadId)?.updated_at
  assertEqual(after, before, "transcript-only upsert should not change thread updated_at")
  assertEqual(db.getThreadMessages(threadId).length, 1, "message should still persist")

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testTranscriptContentIsBounded(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-transcript-content-bounds"
  const largeText = "x".repeat(130_000)
  const largeToolResult = "y".repeat(90_000)
  const largeToolArg = "z".repeat(50_000)

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Bounded transcript" })
  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-large",
      role: "assistant",
      content: largeText,
      tool_calls: [{ id: "tool-large", name: "inspect", args: { payload: largeToolArg } }],
      created_at: new Date()
    },
    {
      id: "tool-large-result",
      role: "tool",
      content: [{ type: "tool_result", content: largeToolResult }],
      created_at: new Date()
    }
  ])

  const messages = db.getThreadMessages(threadId)
  const assistant = messages.find((message) => message.id === "assistant-large")
  const toolResult = messages.find((message) => message.id === "tool-large-result")

  assert(assistant, "assistant transcript should persist")
  assert(typeof assistant!.content === "string", "assistant content should remain a string")
  assert(
    (assistant!.content as string).length < largeText.length,
    "large text transcript should be truncated"
  )
  assert(
    (assistant!.content as string).includes("[truncated"),
    "truncated text should include a marker"
  )
  const payload = assistant!.tool_calls?.[0]?.args?.payload
  assert(typeof payload === "string", "tool call args should persist as an object")
  assert(payload.length < largeToolArg.length, "large tool call args should be truncated")

  assert(toolResult, "tool result transcript should persist")
  assert(Array.isArray(toolResult!.content), "tool result content should remain block content")
  const toolBlocks = Array.isArray(toolResult!.content) ? toolResult!.content : []
  const blockContent = toolBlocks[0]?.content
  assert(typeof blockContent === "string", "tool result block content should stay readable")
  assert(
    blockContent.length < largeToolResult.length,
    "large tool result content should be truncated"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testMessageLookupHelpersStayBoundedToRequestedRange(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-message-lookup-helpers"
  const baseAt = new Date("2026-07-08T03:00:00.000Z")

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Lookup helpers" })
  db.upsertThreadMessages(threadId, [
    {
      id: "user-1",
      role: "user",
      content: "first",
      created_at: baseAt
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "second",
      created_at: new Date(baseAt.getTime() + 1000)
    },
    {
      id: "user-2",
      role: "user",
      content: "third",
      created_at: new Date(baseAt.getTime() + 2000)
    }
  ])

  assertEqual(
    db.getThreadMessagesByIds(threadId, ["assistant-1", "missing", "user-1"]).map((m) => m.id).join(","),
    "assistant-1,user-1",
    "id lookup should preserve requested order and ignore missing ids"
  )
  assertEqual(
    db.getThreadMessagesAfterAnyId(threadId, ["user-1", "assistant-1"]).map((m) => m.id).join(","),
    "user-2",
    "tail lookup should start after the latest matching checkpoint id"
  )
  assertEqual(
    db.getThreadMessagesAfterAnyId(threadId, ["missing-boundary"]).map((m) => m.id).join(","),
    "user-1,assistant-1,user-2",
    "tail lookup should return persisted messages when checkpoint ids are absent from DB"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testDurableTailFeedsRuntimeContext(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { withCheckpointer, closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  const { getDurableRuntimeTail } = await import("../src/main/ipc/thread-runtime-tail.ts")
  const { deleteThreadCheckpoint } = await import("../src/main/storage.ts")
  const threadId = "thread-runtime-tail"
  const baseAt = new Date("2026-07-08T02:00:00.000Z")

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Runtime tail" })
  db.upsertThreadMessages(threadId, [
    {
      id: "user-1",
      role: "user",
      content: "旧问题",
      created_at: baseAt
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "旧回答",
      created_at: new Date(baseAt.getTime() + 1000)
    },
    {
      id: "workflow-plumbing",
      role: "user",
      content: WORKFLOW_NOTIFICATION_TURN_PROMPT,
      created_at: new Date(baseAt.getTime() + 1500)
    },
    {
      id: "user-2",
      role: "user",
      content: "checkpoint 后的问题",
      created_at: new Date(baseAt.getTime() + 2000)
    },
    {
      id: "assistant-2",
      role: "assistant",
      content: "checkpoint 后的回答",
      tool_calls: [{ id: "tool-2", name: "inspect", args: { target: "tail" } }],
      created_at: new Date(baseAt.getTime() + 3000)
    }
  ])

  await withCheckpointer(threadId, async (saver) => {
    await saver.put(checkpointConfig(threadId), makeCheckpoint("cp-tail"), checkpointMetadata())
    await saver.flushStrict()
  })

  const tail = await getDurableRuntimeTail(threadId)
  assertEqual(tail.checkpointHasInterrupt, true, "checkpoint interrupt flag should be detected")
  assertEqual(tail.persistedMessages.length, 2, "only messages after checkpoint should be tail")
  assertEqual(tail.persistedMessages[0].id, "user-2", "tail should start after checkpoint ids")
  assertEqual(tail.persistedMessages[1].id, "assistant-2", "tail should keep persisted order")
  assertEqual(tail.messages.length, 2, "tail should convert to runtime messages")
  assertEqual(tail.messages[0]._getType(), "human", "user tail should become HumanMessage")
  assertEqual(tail.messages[1]._getType(), "ai", "assistant tail should become AIMessage")

  await closeCheckpointer(threadId)
  deleteThreadCheckpoint(threadId)
  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function main(): Promise<void> {
  await withTempHome(async () => {
    await testMessagesPersistAcrossReopen()
    await testStreamingDeltaMerge()
    await testBatchStreamingDeltaCoalesce()
    await testTranscriptUpsertDoesNotTouchThreadUpdatedAt()
    await testTranscriptContentIsBounded()
    await testMessageLookupHelpersStayBoundedToRequestedRange()
    await testDurableTailFeedsRuntimeContext()
  })
  console.log("thread-messages-db.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
