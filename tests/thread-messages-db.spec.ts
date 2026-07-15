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

async function testReplaceThreadMessageIdKeepsSingleCanonicalRow(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-message-id-alias"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Message alias" })
  db.upsertThreadMessages(threadId, [
    {
      id: "live-ai-id",
      role: "assistant",
      content: "final answer",
      created_at: new Date("2026-07-09T00:00:00.000Z")
    }
  ])

  assertEqual(
    db.replaceThreadMessageId(threadId, "live-ai-id", "final-ai-id"),
    true,
    "message alias should migrate an existing streamed row"
  )
  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 1, "message alias migration should not leave a duplicate row")
  assertEqual(messages[0]?.id, "final-ai-id", "final provider id should be persisted")
  assertEqual(messages[0]?.content, "final answer", "message content should survive id migration")

  db.upsertThreadMessages(threadId, [
    {
      id: "rewrite-live-id",
      role: "assistant",
      content: "draft answer",
      created_at: new Date("2026-07-09T00:00:01.000Z")
    },
    {
      id: "rewrite-final-id",
      role: "assistant",
      content: "final rewritten answer",
      created_at: new Date("2026-07-09T00:00:02.000Z")
    }
  ])
  db.replaceThreadMessageId(threadId, "rewrite-live-id", "rewrite-final-id")
  const rewrittenMessages = db.getThreadMessages(threadId)
  assertEqual(
    rewrittenMessages.some((message) => message.id === "rewrite-live-id"),
    false,
    "an existing streamed row should collapse into an existing final row"
  )
  assertEqual(
    rewrittenMessages.find((message) => message.id === "rewrite-final-id")?.content,
    "final rewritten answer",
    "the final provider row should remain authoritative when both ids already exist"
  )

  assertEqual(
    db.replaceThreadMessageId(threadId, "late-live-id", "late-final-id", "assistant"),
    true,
    "message alias should be remembered before the streamed row arrives"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "late-live-id",
      role: "assistant",
      content: "late final answer",
      created_at: new Date("2026-07-09T00:00:01.000Z")
    }
  ])
  const messagesAfterLateWrite = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterLateWrite.length,
    3,
    "late streamed writes should not create an old-id row"
  )
  assertEqual(
    messagesAfterLateWrite.some((message) => message.id === "late-live-id"),
    false,
    "late streamed writes should resolve the remembered alias"
  )
  assertEqual(
    messagesAfterLateWrite.some((message) => message.id === "late-final-id"),
    true,
    "late streamed writes should use the final provider id"
  )

  db.replaceThreadMessageId(threadId, "chain-live-id", "chain-final-id-1", "assistant")
  db.replaceThreadMessageId(threadId, "chain-final-id-1", "chain-final-id-2", "assistant")
  db.replaceThreadMessageId(threadId, "chain-final-id-2", "chain-final-id-3", "assistant")
  db.upsertThreadMessages(threadId, [
    {
      id: "chain-live-id",
      role: "assistant",
      content: "answer after repeated snapshot ids",
      created_at: new Date("2026-07-09T00:00:03.000Z")
    }
  ])
  const messagesAfterAliasChain = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterAliasChain.some((message) => message.id === "chain-live-id"),
    false,
    "the original streamed id should not survive a repeated alias chain"
  )
  assertEqual(
    messagesAfterAliasChain.some((message) => message.id === "chain-final-id-1"),
    false,
    "intermediate provider ids should not survive a repeated alias chain"
  )
  assertEqual(
    messagesAfterAliasChain.some((message) => message.id === "chain-final-id-3"),
    true,
    "late writes should resolve through the full alias chain"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "cross-role-source",
      role: "assistant",
      content: "assistant row",
      created_at: new Date("2026-07-09T00:00:04.000Z")
    },
    {
      id: "cross-role-target",
      role: "tool",
      content: "tool row",
      tool_call_id: "cross-role-call",
      created_at: new Date("2026-07-09T00:00:05.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(threadId, "cross-role-source", "cross-role-target"),
    false,
    "message id aliases must not merge rows with different roles"
  )
  const messagesAfterCrossRoleCollision = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterCrossRoleCollision.some(
      (message) => message.id === "cross-role-source" && message.role === "assistant"
    ),
    true,
    "a rejected cross-role alias must preserve the source row"
  )
  assertEqual(
    messagesAfterCrossRoleCollision.some(
      (message) => message.id === "cross-role-target" && message.role === "tool"
    ),
    true,
    "a rejected cross-role alias must preserve the target row"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "late-cross-role-target",
      role: "tool",
      content: "existing tool target",
      tool_call_id: "late-cross-role-call",
      created_at: new Date("2026-07-09T00:00:06.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(threadId, "late-cross-role-source", "late-cross-role-target"),
    true,
    "message alias may be remembered before a future source row arrives"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "late-cross-role-source",
      role: "assistant",
      content: "late assistant source",
      created_at: new Date("2026-07-09T00:00:07.000Z")
    }
  ])
  const messagesAfterLateCrossRoleCollision = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterLateCrossRoleCollision.some(
      (message) => message.id === "late-cross-role-source" && message.role === "assistant"
    ),
    true,
    "a late cross-role alias must keep the source row under its original id"
  )
  assertEqual(
    messagesAfterLateCrossRoleCollision.some(
      (message) => message.id === "late-cross-role-target" && message.role === "tool"
    ),
    true,
    "a late cross-role alias must not overwrite the target row role"
  )

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "early-role-source",
      "early-role-final",
      "assistant"
    ),
    true,
    "message aliases remembered before any row arrives should carry an expected role"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "early-role-source",
      role: "tool",
      content: "tool row should not be rewritten to an assistant alias",
      tool_call_id: "early-role-call",
      created_at: new Date("2026-07-09T00:00:08.000Z")
    }
  ])
  const messagesAfterEarlyRoleMismatch = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterEarlyRoleMismatch.some(
      (message) => message.id === "early-role-source" && message.role === "tool"
    ),
    true,
    "a remembered assistant alias must not rewrite a later tool message"
  )
  assertEqual(
    messagesAfterEarlyRoleMismatch.some((message) => message.id === "early-role-final"),
    false,
    "a role-mismatched early alias must not create the canonical target row"
  )

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "early-collision-source",
      "early-collision-target",
      "assistant"
    ),
    true,
    "an early alias with a known role may canonicalize the first matching source row"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "early-collision-source",
      role: "assistant",
      content: "assistant source that arrives before the target id",
      created_at: new Date("2026-07-09T00:00:09.000Z")
    }
  ])
  assertEqual(
    db.getThreadMessages(threadId).some(
      (message) =>
        message.id === "early-collision-target" &&
        message.role === "assistant" &&
        message.content === "assistant source that arrives before the target id"
    ),
    true,
    "a role-matched early source should still use the canonical id while no collision exists"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "early-collision-target",
      role: "tool",
      content: "actual tool target that arrives later",
      tool_call_id: "early-collision-call",
      created_at: new Date("2026-07-09T00:00:10.000Z")
    }
  ])
  const messagesAfterEarlyCanonicalCollision = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterEarlyCanonicalCollision.some(
      (message) =>
        message.id === "early-collision-source" &&
        message.role === "assistant" &&
        message.content === "assistant source that arrives before the target id"
    ),
    true,
    "a later cross-role target should move the aliased source back to its original id"
  )
  assertEqual(
    messagesAfterEarlyCanonicalCollision.some(
      (message) =>
        message.id === "early-collision-target" &&
        message.role === "tool" &&
        message.content === "actual tool target that arrives later"
    ),
    true,
    "a later cross-role target must be inserted instead of being skipped"
  )

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "same-batch-collision-source",
      "same-batch-collision-target",
      "assistant"
    ),
    true,
    "same-batch aliases should still be remembered with an expected role"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "same-batch-collision-source",
      role: "assistant",
      content: "same-batch assistant source",
      created_at: new Date("2026-07-09T00:00:11.000Z")
    },
    {
      id: "same-batch-collision-target",
      role: "tool",
      content: "same-batch tool target",
      tool_call_id: "same-batch-collision-call",
      created_at: new Date("2026-07-09T00:00:12.000Z")
    }
  ])
  const messagesAfterSameBatchCanonicalCollision = db.getThreadMessages(threadId)
  assertEqual(
    messagesAfterSameBatchCanonicalCollision.some(
      (message) =>
        message.id === "same-batch-collision-source" &&
        message.role === "assistant" &&
        message.content === "same-batch assistant source"
    ),
    true,
    "same-batch cross-role aliases must keep the source row under its original id"
  )
  assertEqual(
    messagesAfterSameBatchCanonicalCollision.some(
      (message) =>
        message.id === "same-batch-collision-target" &&
        message.role === "tool" &&
        message.content === "same-batch tool target"
    ),
    true,
    "same-batch cross-role aliases must keep the target row under its original id"
  )

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "late-cross-role-source-with-role",
      "late-cross-role-target",
      "assistant"
    ),
    false,
    "message aliases with a known role must reject an existing target row with a different role"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testAssistantToolCallAliasDoesNotPolluteFinalTextAnswer(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-tool-call-alias-guard"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Tool call alias guard" })
  db.upsertThreadMessages(threadId, [
    {
      id: "tool-call-source",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", name: "execute", args: { command: "git status --short" } }],
      created_at: new Date("2026-07-10T01:00:00.000Z")
    },
    {
      id: "text-answer-target",
      role: "assistant",
      content: "DUP_TEST_A_20260711 只应该出现一次。",
      created_at: new Date("2026-07-10T01:00:02.000Z")
    }
  ])

  assertEqual(
    db.replaceThreadMessageId(threadId, "tool-call-source", "text-answer-target", "assistant"),
    false,
    "a tool-call assistant row must not be merged into a text-only final answer row"
  )
  let messages = db.getThreadMessages(threadId)
  assertEqual(
    messages.some((message) => message.id === "tool-call-source"),
    true,
    "the rejected alias should preserve the original tool-call assistant row"
  )
  assertEqual(
    messages.find((message) => message.id === "text-answer-target")?.tool_calls?.length ?? 0,
    0,
    "the text-only final answer must not inherit tool calls from the rejected alias"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "existing-tool-call-source",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-existing", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T01:00:02.500Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "existing-tool-call-source",
      "future-text-answer-target",
      "assistant"
    ),
    false,
    "an existing tool-call row must not be renamed to a future text-answer alias target"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "future-text-answer-target",
      role: "assistant",
      content: "future final text",
      created_at: new Date("2026-07-10T01:00:02.750Z")
    }
  ])
  messages = db.getThreadMessages(threadId)
  assertEqual(
    messages.some((message) => message.id === "existing-tool-call-source"),
    true,
    "the existing tool-call source should remain under its original id"
  )
  assertEqual(
    messages.find((message) => message.id === "future-text-answer-target")?.tool_calls?.length ??
      0,
    0,
    "a future text answer must not inherit tool calls from a rejected existing-source alias"
  )

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "remembered-tool-call-source",
      "remembered-text-answer-target",
      "assistant"
    ),
    true,
    "pre-row assistant aliases may still be remembered"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "remembered-tool-call-source",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-2", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T01:00:03.000Z")
    },
    {
      id: "remembered-text-answer-target",
      role: "assistant",
      content: "final text after a zero-arg tool",
      created_at: new Date("2026-07-10T01:00:04.000Z")
    }
  ])
  messages = db.getThreadMessages(threadId)
  assertEqual(
    messages.some((message) => message.id === "remembered-tool-call-source"),
    true,
    "a same-batch text target must not steal a remembered tool-call source id"
  )
  assertEqual(
    messages.find((message) => message.id === "remembered-text-answer-target")?.tool_calls
      ?.length ?? 0,
    0,
    "same-batch final text must stay free of source tool calls"
  )

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "unresolved-tool-call-source",
      "unresolved-final-answer-target",
      "assistant"
    ),
    true,
    "pre-row assistant aliases may be remembered before either row exists"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "unresolved-tool-call-source",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-3", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T01:00:05.000Z")
    }
  ])
  messages = db.getThreadMessages(threadId)
  assertEqual(
    messages.some((message) => message.id === "unresolved-tool-call-source"),
    true,
    "an unresolved assistant alias must not rename a tool-call row without seeing its target"
  )
  assertEqual(
    messages.some((message) => message.id === "unresolved-final-answer-target"),
    false,
    "the unresolved alias target must not be created by a tool-call source row"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testReplaceThreadMessageIdRespectsAuthoritativeContentPriority(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-message-id-priority-merge"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Message alias priority merge" })
  db.upsertThreadMessages(threadId, [
    {
      id: "authoritative-empty-source",
      role: "assistant",
      content: "",
      content_priority: 1,
      tool_calls: [],
      created_at: new Date("2026-07-10T02:00:00.000Z")
    },
    {
      id: "stale-target",
      role: "assistant",
      content: "stale final text",
      tool_calls: [{ id: "call-stale", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T02:00:01.000Z")
    }
  ])

  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "authoritative-empty-source",
      "stale-target",
      "assistant"
    ),
    true,
    "same-role aliases should still merge when the source is an authoritative empty repair"
  )
  let messages = db.getThreadMessages(threadId)
  let repaired = messages.find((message) => message.id === "stale-target")
  assertEqual(repaired?.content, "", "source authoritative empty content should clear stale target")
  assertEqual(
    repaired?.tool_calls?.length ?? -1,
    0,
    "source authoritative empty tool_calls should clear stale target tool calls"
  )
  assertEqual(repaired?.content_priority, 1, "merged repair priority should persist")

  db.upsertThreadMessages(threadId, [
    {
      id: "stale-target",
      role: "assistant",
      content: "late stale replay",
      tool_calls: [{ id: "call-stale", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T02:00:02.000Z")
    }
  ])
  repaired = db.getThreadMessages(threadId).find((message) => message.id === "stale-target")
  assertEqual(
    repaired?.content,
    "",
    "a lower-priority replay must not undo an authoritative alias clear"
  )
  assertEqual(
    repaired?.tool_calls?.length ?? -1,
    0,
    "a lower-priority replay must not restore tool calls after an authoritative alias clear"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "stale-source",
      role: "assistant",
      content: "stale source text",
      tool_calls: [{ id: "call-source-stale", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T02:00:03.000Z")
    },
    {
      id: "authoritative-empty-target",
      role: "assistant",
      content: "",
      content_priority: 1,
      tool_calls: [],
      created_at: new Date("2026-07-10T02:00:04.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      "stale-source",
      "authoritative-empty-target",
      "assistant"
    ),
    true,
    "same-role aliases should merge when the target is an authoritative empty repair"
  )
  messages = db.getThreadMessages(threadId)
  repaired = messages.find((message) => message.id === "authoritative-empty-target")
  assertEqual(repaired?.content, "", "target authoritative empty content should clear stale source")
  assertEqual(
    repaired?.tool_calls?.length ?? -1,
    0,
    "target authoritative empty tool_calls should clear stale source tool calls"
  )
  assertEqual(
    messages.some((message) => message.id === "stale-source"),
    false,
    "merged stale source row should be removed"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testAuthoritativeSnapshotCanClearPersistedAssistantContent(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-authoritative-empty-snapshot"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Authoritative empty snapshot" })
  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: "final answer accidentally attached to the tool call",
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }],
      created_at: new Date("2026-07-10T00:00:00.000Z")
    }
  ])
  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: "",
      content_priority: 1,
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }],
      created_at: new Date("2026-07-10T00:00:01.000Z")
    }
  ])

  const messages = db.getThreadMessages(threadId)
  assertEqual(messages[0]?.content, "", "an authoritative snapshot should clear persisted content")
  assertEqual(
    messages[0]?.tool_calls?.length ?? -1,
    1,
    "a tool-call assistant repair should keep its legitimate tool call"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: "",
      content_priority: 1,
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }],
      created_at: new Date("2026-07-10T00:00:02.000Z")
    },
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: "late lower-priority replay",
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }],
      created_at: new Date("2026-07-10T00:00:03.000Z")
    }
  ])
  assertEqual(
    db.getThreadMessages(threadId)[0]?.content,
    "",
    "a lower-priority replay in the same batch must not undo an authoritative clear"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-equal-priority-tool-call",
      role: "assistant",
      content: "earlier authoritative content",
      content_priority: 1,
      tool_calls: [{ id: "call-2", name: "get_status", args: {} }],
      created_at: new Date("2026-07-10T00:00:04.000Z")
    },
    {
      id: "assistant-equal-priority-tool-call",
      role: "assistant",
      content: "",
      content_priority: 1,
      tool_calls: [{ id: "call-2", name: "get_status", args: {} }],
      created_at: new Date("2026-07-10T00:00:05.000Z")
    }
  ])
  assertEqual(
    db
      .getThreadMessages(threadId)
      .find((message) => message.id === "assistant-equal-priority-tool-call")?.content,
    "",
    "the latest authoritative DB snapshot should replace equal-priority content"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-final-answer",
      role: "assistant",
      content: "DUP_TEST_A_20260711 只应该出现一次。",
      tool_calls: [{ id: "call-final", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T00:00:06.000Z")
    }
  ])
  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-final-answer",
      role: "assistant",
      content: "DUP_TEST_A_20260711 只应该出现一次。",
      content_priority: 1,
      tool_calls: [],
      created_at: new Date("2026-07-10T00:00:07.000Z")
    }
  ])
  let finalAnswer = db
    .getThreadMessages(threadId)
    .find((message) => message.id === "assistant-final-answer")
  assertEqual(
    finalAnswer?.tool_calls?.length ?? -1,
    0,
    "an authoritative checkpoint final answer should clear polluted persisted tool calls"
  )

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  finalAnswer = db
    .getThreadMessages(threadId)
    .find((message) => message.id === "assistant-final-answer")
  assertEqual(
    finalAnswer?.tool_calls?.length ?? -1,
    0,
    "cleared final-answer tool calls should survive database reopen"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "assistant-final-answer",
      role: "assistant",
      content: "lower-priority replay",
      tool_calls: [{ id: "call-final", name: "execute", args: {} }],
      created_at: new Date("2026-07-10T00:00:08.000Z")
    }
  ])
  finalAnswer = db
    .getThreadMessages(threadId)
    .find((message) => message.id === "assistant-final-answer")
  assertEqual(
    finalAnswer?.content,
    "DUP_TEST_A_20260711 只应该出现一次。",
    "a lower-priority replay after reopen must not replace authoritative final text"
  )
  assertEqual(
    finalAnswer?.tool_calls?.length ?? -1,
    0,
    "a lower-priority replay after reopen must not restore cleared tool calls"
  )

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
    await testReplaceThreadMessageIdKeepsSingleCanonicalRow()
    await testAssistantToolCallAliasDoesNotPolluteFinalTextAnswer()
    await testReplaceThreadMessageIdRespectsAuthoritativeContentPriority()
    await testAuthoritativeSnapshotCanClearPersistedAssistantContent()
  })
  console.log("thread-messages-db.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
