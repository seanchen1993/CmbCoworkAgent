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
import {
  clearCurrentRunMessageQueue,
  registerCurrentRunCompletedAssistantRoute,
  resolveCurrentRunCompletedAssistantIdentity,
  resolveCurrentRunInjectionAnchorId,
  routeCurrentRunCompletedAssistantMessage,
  setCurrentRunMessageQueueOwner
} from "../src/main/agent/current-run-message-queue.ts"
import {
  mergeCheckpointAuthorityTranscriptMessages,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../src/shared/checkpoint-transcript.ts"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  normalizeAppendedMessageIds
} from "../src/shared/message-role-collision.ts"

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

async function testSteeredTranscriptRecordsAreSplicedBeforeDelayedFollowup(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-steered-transcript-order"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Steered transcript order" })

  db.upsertThreadMessages(threadId, [
    { id: "user-original", role: "user", content: "原始请求", created_at: new Date() },
    {
      id: "assistant-guided-reply",
      role: "assistant",
      content: "引导后的回复先到达",
      created_at: new Date()
    },
    {
      id: "assistant-original-reply",
      role: "assistant",
      content: "原始回复延后到达",
      created_at: new Date()
    },
    { id: "user-guide", role: "user", content: "引导消息", created_at: new Date() }
  ])

  assert(
    db.moveThreadMessagesAfterLastNonAssistant(threadId, [
      "assistant-original-reply",
      "user-guide"
    ]),
    "steering records should move before delayed follow-up output"
  )
  assertEqual(
    db.getThreadMessages(threadId).map((message) => message.id).join(","),
    "user-original,assistant-original-reply,user-guide,assistant-guided-reply",
    "durable transcript should retain logical turn order despite delayed stream delivery"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testSteeredTranscriptBlockUsesPhysicalRunAnchor(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-steered-transcript-replacement-race"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Steered transcript replacement race" })

  db.upsertThreadMessages(threadId, [
    { id: "user-original", role: "user", content: "original", created_at: new Date() },
    {
      id: "assistant-original",
      role: "assistant",
      content: "original reply",
      created_at: new Date()
    },
    {
      id: "user-replacement",
      role: "user",
      content: "replacement",
      created_at: new Date()
    },
    { id: "user-guide", role: "user", content: "guide", created_at: new Date() }
  ])

  assert(
    db.moveThreadMessagesAfterAnchor(threadId, "user-original", [
      "assistant-original",
      "user-guide"
    ]),
    "the old run block should move after its own predecessor"
  )
  assertEqual(
    db.getThreadMessages(threadId).map((message) => message.id).join(","),
    "user-original,assistant-original,user-guide,user-replacement",
    "a replacement user persisted first must remain after the old run's completed reply and guide"
  )

  await db.flushStrict()
  await db.closeDatabase()
  await db.initializeDatabase()
  assertEqual(
    db.getThreadMessages(threadId).map((message) => message.id).join(","),
    "user-original,assistant-original,user-guide,user-replacement",
    "the physical-run anchored order should survive database reopen"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testSteeredTranscriptAnchorSurvivesCrossRoleProviderCollision(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-steered-transcript-role-collision-anchor"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Steered role-collision anchor" })
  const at = new Date("2026-07-22T08:00:00.000Z")

  db.upsertThreadMessages(threadId, [
    { id: "user-original", role: "user", content: "original", created_at: at },
    {
      id: "shared-provider",
      role: "assistant",
      content: "tool call",
      created_at: at
    },
    {
      id: "shared-provider",
      role: "tool",
      tool_call_id: "call-1",
      content: "tool result",
      created_at: at
    },
    { id: "user-replacement", role: "user", content: "replacement", created_at: at },
    { id: "assistant-completed", role: "assistant", content: "completed", created_at: at },
    { id: "user-guide", role: "user", content: "guide", created_at: at }
  ])
  const anchorId = resolveCurrentRunInjectionAnchorId(db.getThreadMessages(threadId), {
    id: "shared-provider",
    role: "tool",
    providerSourceId: "shared-provider"
  })
  assert(anchorId && anchorId !== "shared-provider", "tool anchor should resolve past assistant id")
  db.moveThreadMessagesAfterAnchor(threadId, anchorId, ["assistant-completed", "user-guide"])
  assertEqual(
    db.getThreadMessages(threadId).map((message) => `${message.role}:${message.id}`).join(","),
    `user:user-original,assistant:shared-provider,tool:${anchorId},assistant:assistant-completed,user:user-guide,user:user-replacement`,
    "a role-normalized tool predecessor must keep the guide after the tool and before replacement"
  )

  db.deleteThread(threadId)
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
      provider_source_id: "reused-provider-id",
      provider_occurrence: 2,
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
  assertEqual(
    tail.messages[1].additional_kwargs[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY],
    "reused-provider-id",
    "runtime tail should preserve the assistant provider source id"
  )
  assertEqual(
    tail.messages[1].additional_kwargs[MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY],
    2,
    "runtime tail should preserve the assistant provider occurrence"
  )

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

async function testSameRoleDuplicateIdsPersistAsDistinctRows(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-same-role-provider-id"
  const sharedId = "same-role-provider-id"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Same-role provider id" })
  const normalizedMessages = mergeCheckpointAuthorityTranscriptMessages<Message>(
    [
      {
        id: sharedId,
        role: "assistant",
        content: "first distinct assistant chunk",
        created_at: new Date("2026-07-20T02:30:00.000Z")
      },
      {
        id: sharedId,
        role: "assistant",
        content: "second distinct assistant chunk",
        created_at: new Date("2026-07-20T02:30:01.000Z")
      }
    ],
    []
  )

  assertEqual(normalizedMessages.length, 2, "checkpoint normalization must keep both chunks")
  assertEqual(
    normalizedMessages[1].id,
    buildMessageSameRoleDuplicateId(sharedId, "assistant"),
    "the second same-role chunk must use a dedicated duplicate identity"
  )
  db.upsertThreadMessages(threadId, normalizedMessages)

  let persistedMessages = db.getThreadMessages(threadId)
  assertEqual(persistedMessages.length, 2, "database upsert must not coalesce same-role chunks")
  assertEqual(
    persistedMessages.map((message) => message.content).join("|"),
    "first distinct assistant chunk|second distinct assistant chunk",
    "both same-role chunks must retain their own content"
  )

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  persistedMessages = db.getThreadMessages(threadId)
  assertEqual(persistedMessages.length, 2, "same-role duplicate rows must survive database reopen")
  assertEqual(
    persistedMessages[1].id,
    buildMessageSameRoleDuplicateId(sharedId, "assistant"),
    "the durable duplicate identity must remain stable"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testLateRawRoleCollisionChunkFollowsMessageAlias(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-role-collision-alias-late-chunk"
  const providerId = "shared-role-collision-alias-id"
  const assistantCollisionId = buildMessageRoleCollisionId(providerId, "assistant")
  const finalId = "final-role-collision-alias-id"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Role collision alias late chunk" })
  db.upsertThreadMessages(threadId, [
    {
      id: providerId,
      role: "user",
      content: "user keeps the provider id",
      created_at: new Date("2026-07-20T00:00:00.000Z")
    },
    {
      id: providerId,
      role: "assistant",
      content: "draft",
      created_at: new Date("2026-07-20T00:00:01.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(threadId, assistantCollisionId, finalId, "assistant"),
    true,
    "the role-scoped assistant row should accept its final provider id"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: providerId,
      role: "assistant",
      content: "draft completed",
      created_at: new Date("2026-07-20T00:00:02.000Z")
    }
  ])
  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 2, "a late raw assistant chunk must not recreate the collision row")
  assertEqual(
    messages.some((message) => message.id === assistantCollisionId),
    false,
    "the aliased role-collision id must stay retired"
  )
  assertEqual(
    messages.find((message) => message.id === finalId)?.content,
    "draft completed",
    "the late raw chunk must update the canonical final assistant row"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testThreadMessageUpsertReplayAndAppendContracts(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-message-upsert-contracts"
  const providerId = "reused-assistant-id-across-turns"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Message upsert contracts" })
  const firstBatch: Message[] = [
    {
      id: "first-user",
      role: "user",
      content: "first question",
      created_at: new Date("2026-07-20T00:09:59.000Z")
    },
    {
      id: providerId,
      role: "assistant",
      content: "old answer",
      created_at: new Date("2026-07-20T00:10:00.000Z")
    }
  ]
  db.upsertThreadMessages(threadId, firstBatch)
  db.upsertThreadMessages(threadId, firstBatch)
  assertEqual(
    db.getThreadMessages(threadId).length,
    2,
    "replaying an identical persisted batch must remain idempotent"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "new-user-turn",
      role: "user",
      content: "new question",
      created_at: new Date("2026-07-20T00:10:01.000Z")
    }
  ])
  db.upsertThreadMessages(
    threadId,
    normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
      {
        id: providerId,
        role: "assistant",
        content: "new answer",
        created_at: new Date("2026-07-20T00:10:02.000Z")
      }
    ]) as Message[]
  )

  let messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 4, "a reused assistant id after a user turn must create a new row")
  assertEqual(
    messages.map((message) => message.content).join("|"),
    "first question|old answer|new question|new answer",
    "database ordinals must retain the later assistant after its user boundary"
  )
  assertEqual(
    messages[3]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant"),
    "the later assistant must receive the stable occurrence id"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: providerId,
      role: "assistant",
      content: "authoritative historical repair",
      content_priority: 1,
      created_at: new Date("2026-07-20T00:10:03.000Z")
    }
  ])
  messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 4, "a historical repair must update the exact row without appending")
  assertEqual(
    messages[0]?.content,
    "first question",
    "the historical repair must not disturb the original user row"
  )
  assertEqual(
    messages[1]?.content,
    "authoritative historical repair",
    "an authoritative exact-id repair must update the historical assistant"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testSameRoleOccurrenceIdentitySurvivesAlias(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-same-role-occurrence-alias"
  const providerId = "reused-provider-id-with-alias"
  const secondOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)
  const thirdOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)
  const canonicalSecondId = "canonical-second-answer"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Same-role occurrence alias" })
  db.upsertThreadMessages(threadId, [
    {
      id: "alias-user-1",
      role: "user",
      content: "question one",
      created_at: new Date("2026-07-20T05:00:00.000Z")
    },
    {
      id: providerId,
      role: "assistant",
      content: "answer one",
      created_at: new Date("2026-07-20T05:00:01.000Z")
    },
    {
      id: "alias-user-2",
      role: "user",
      content: "question two",
      created_at: new Date("2026-07-20T05:00:02.000Z")
    }
  ])
  const checkpointDuplicate = mergeCheckpointAuthorityTranscriptMessages<Message>(
    [
      {
        id: providerId,
        role: "assistant",
        content: "answer one",
        created_at: new Date("2026-07-20T05:00:01.000Z")
      },
      {
        id: providerId,
        role: "assistant",
        content: "answer two",
        created_at: new Date("2026-07-20T05:00:03.000Z")
      }
    ],
    []
  )[1]
  assertEqual(
    checkpointDuplicate.provider_source_id,
    providerId,
    "checkpoint duplicate ids must carry their provider source identity"
  )
  db.upsertThreadMessages(threadId, [checkpointDuplicate])
  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      secondOccurrenceId,
      canonicalSecondId,
      "assistant"
    ),
    true,
    "the second occurrence should accept its canonical provider id"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "alias-user-3",
      role: "user",
      content: "question three",
      created_at: new Date("2026-07-20T05:00:04.000Z")
    }
  ])
  db.upsertThreadMessages(
    threadId,
    normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
      {
        id: providerId,
        role: "assistant",
        content: "answer three",
        created_at: new Date("2026-07-20T05:00:05.000Z")
      }
    ]) as Message[]
  )

  let messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 6, "a third reuse must remain distinct after the second was aliased")
  assertEqual(
    messages.map((message) => message.content).join("|"),
    "question one|answer one|question two|answer two|question three|answer three",
    "alias resolution must not merge the third answer into the second occurrence"
  )
  assertEqual(
    messages[3]?.provider_source_id,
    providerId,
    "the canonical alias row must retain its original provider identity"
  )
  assertEqual(
    messages[5]?.id,
    thirdOccurrenceId,
    "the next reuse must advance to the third occurrence id"
  )

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  messages = db.getThreadMessages(threadId)
  assertEqual(
    messages[3]?.provider_source_id,
    providerId,
    "provider occurrence identity must survive a database reopen"
  )

  const gapThreadId = "thread-same-role-occurrence-alias-gap"
  const gapProviderId = "reused-provider-id-with-alias-gap"
  const gapThirdOccurrenceId = buildMessageSameRoleDuplicateId(
    gapProviderId,
    "assistant",
    3
  )
  const gapFourthOccurrenceId = buildMessageSameRoleDuplicateId(
    gapProviderId,
    "assistant",
    4
  )
  const gapCanonicalThirdId = "canonical-third-answer-after-gap"
  db.createThread(gapThreadId, { title: "Same-role occurrence alias gap" })
  db.upsertThreadMessages(gapThreadId, [
    {
      id: "alias-gap-user-1",
      role: "user",
      content: "gap question one",
      created_at: new Date("2026-07-20T06:00:00.000Z")
    },
    {
      id: gapProviderId,
      role: "assistant",
      content: "gap answer one",
      created_at: new Date("2026-07-20T06:00:01.000Z")
    },
    {
      id: "alias-gap-user-3",
      role: "user",
      content: "gap question three",
      created_at: new Date("2026-07-20T06:00:02.000Z")
    },
    {
      id: gapThirdOccurrenceId,
      provider_source_id: gapProviderId,
      role: "assistant",
      content: "gap answer three",
      created_at: new Date("2026-07-20T06:00:03.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(
      gapThreadId,
      gapThirdOccurrenceId,
      gapCanonicalThirdId,
      "assistant"
    ),
    true,
    "the gapped third occurrence should accept its canonical id"
  )
  const durableGapMessages = db.getThreadMessages(gapThreadId)
  const checkpointGapMessages = durableGapMessages.map((message) => {
    const checkpointMessage = { ...message }
    delete checkpointMessage.provider_occurrence
    delete checkpointMessage.provider_source_id
    return message.id === gapCanonicalThirdId
      ? { ...checkpointMessage, id: gapThirdOccurrenceId }
      : checkpointMessage
  })
  const restoredGapMessages = mergeCheckpointAuthorityTranscriptMessages(
    checkpointGapMessages,
    durableGapMessages
  )
  assertEqual(
    restoredGapMessages[3]?.provider_occurrence,
    3,
    "checkpoint recovery must retain the durable canonical occurrence"
  )
  assertEqual(
    restoredGapMessages.length,
    durableGapMessages.length,
    "checkpoint and durable aliases for one occurrence must merge into one row"
  )
  const restoredFirstAlias = mergeCheckpointAuthorityTranscriptMessages(
    [{ id: "checkpoint-first-alias-draft", role: "assistant", content: "answer" }],
    [
      {
        id: "checkpoint-first-alias-final",
        provider_source_id: "checkpoint-first-alias-draft",
        provider_occurrence: 1,
        role: "assistant",
        content: "answer"
      }
    ]
  )
  assertEqual(
    restoredFirstAlias.length,
    1,
    "a durable first-occurrence alias must merge with its checkpoint draft"
  )
  const restoredImplicitFirstAlias = mergeCheckpointAuthorityTranscriptMessages(
    [{ id: "checkpoint-implicit-first-draft", role: "assistant", content: "draft" }],
    [
      {
        id: "checkpoint-implicit-first-final",
        provider_source_id: "checkpoint-implicit-first-draft",
        role: "assistant",
        content: "draft complete"
      }
    ]
  )
  assertEqual(
    restoredImplicitFirstAlias.length,
    1,
    "a canonical first occurrence without numeric metadata must merge with its unique draft"
  )
  assertEqual(
    restoredImplicitFirstAlias[0]?.content,
    "draft complete",
    "the canonical first occurrence must contribute its completed content"
  )
  const restoredImplicitFirstAliasWithLaterOccurrence =
    mergeCheckpointAuthorityTranscriptMessages(
      [
        {
          id: "checkpoint-multi-alias-provider",
          role: "assistant",
          content: "draft one"
        },
        {
          id: "checkpoint-multi-alias-provider",
          role: "assistant",
          content: "answer two"
        }
      ],
      [
        {
          id: "checkpoint-multi-alias-canonical-one",
          provider_source_id: "checkpoint-multi-alias-provider",
          role: "assistant",
          content: "draft one complete"
        },
        {
          id: "checkpoint-multi-alias-canonical-two",
          provider_source_id: "checkpoint-multi-alias-provider",
          provider_occurrence: 2,
          role: "assistant",
          content: "answer two"
        }
      ]
    )
  assertEqual(
    restoredImplicitFirstAliasWithLaterOccurrence.length,
    2,
    "a canonical first occurrence must align even when the provider has later raw occurrences"
  )
  assertEqual(
    restoredImplicitFirstAliasWithLaterOccurrence.map(
      (message) => message.provider_occurrence
    ).join("|"),
    "|2",
    "the implicit first alias and explicit later occurrence must remain distinct"
  )
  const restoredExplicitSourceConflict = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-shared-source-conflict",
        provider_source_id: "checkpoint-source-a",
        provider_occurrence: 1,
        role: "assistant",
        content: "source a"
      }
    ],
    [
      {
        id: "checkpoint-shared-source-conflict",
        provider_source_id: "checkpoint-source-b",
        provider_occurrence: 1,
        role: "assistant",
        content: "source b"
      }
    ]
  )
  assertEqual(
    restoredExplicitSourceConflict.length,
    2,
    "an exact id shared by two explicit provider sources must remain distinct"
  )
  assertEqual(
    restoredExplicitSourceConflict[1]?.provider_occurrence,
    1,
    "a different provider source must retain its own first occurrence"
  )
  const checkpointBaseSourceConflict = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-base-shared-source",
        provider_source_id: "checkpoint-base-source-a",
        provider_occurrence: 1,
        role: "assistant",
        content: "base source a"
      },
      {
        id: "checkpoint-base-shared-source",
        provider_source_id: "checkpoint-base-source-b",
        provider_occurrence: 1,
        role: "assistant",
        content: "base source b"
      }
    ],
    []
  )
  assertEqual(
    checkpointBaseSourceConflict[1]?.provider_occurrence,
    1,
    "base checkpoint collisions from another provider source must not start at occurrence two"
  )
  const restoredExactIdOccurrences = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-shared-explicit-id",
        provider_source_id: "checkpoint-shared-explicit-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "first"
      }
    ],
    [
      {
        id: "checkpoint-shared-explicit-id",
        provider_source_id: "checkpoint-shared-explicit-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "second"
      }
    ]
  )
  assertEqual(
    restoredExactIdOccurrences.length,
    2,
    "an exact provider id reused for a different explicit occurrence must stay distinct"
  )
  assertEqual(
    restoredExactIdOccurrences[1]?.provider_occurrence,
    2,
    "the preserved exact-id collision must retain its incoming occurrence"
  )
  const restoredExactIdGap = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-shared-explicit-gap-id",
        provider_source_id: "checkpoint-shared-explicit-gap-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "first"
      }
    ],
    [
      {
        id: "checkpoint-shared-explicit-gap-id",
        provider_source_id: "checkpoint-shared-explicit-gap-source",
        provider_occurrence: 5,
        role: "assistant",
        content: "fifth"
      }
    ]
  )
  assertEqual(
    restoredExactIdGap[1]?.provider_occurrence,
    5,
    "an exact-id collision must preserve a gapped incoming occurrence"
  )
  assertEqual(
    restoredExactIdGap[1]?.id,
    buildMessageSameRoleDuplicateId(
      "checkpoint-shared-explicit-gap-source",
      "assistant",
      5
    ),
    "a gapped exact-id collision must use its declared occurrence id"
  )
  const restoredGappedLegacyOccurrences = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-gapped-alias-three",
        provider_source_id: "checkpoint-gapped-source",
        provider_occurrence: 3,
        role: "assistant",
        content: "third"
      },
      {
        id: "checkpoint-gapped-legacy-four",
        provider_source_id: "checkpoint-gapped-source",
        role: "assistant",
        content: "fourth"
      }
    ],
    [
      {
        id: "checkpoint-gapped-alias-two",
        provider_source_id: "checkpoint-gapped-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "second"
      }
    ]
  )
  assertEqual(
    restoredGappedLegacyOccurrences.length,
    3,
    "a legacy row after a gapped occurrence must not masquerade as an earlier occurrence"
  )
  assertEqual(
    restoredGappedLegacyOccurrences.find((message) => message.content === "second")
      ?.provider_occurrence,
    2,
    "the earlier explicit occurrence must remain distinct from the later legacy row"
  )
  const restoredExactIdGappedLegacyOccurrences = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-gapped-shared-id",
        provider_source_id: "checkpoint-gapped-shared-source",
        provider_occurrence: 3,
        role: "assistant",
        content: "third"
      },
      {
        id: "checkpoint-gapped-shared-id",
        provider_source_id: "checkpoint-gapped-shared-source",
        role: "assistant",
        content: "fourth"
      }
    ],
    [
      {
        id: buildMessageSameRoleDuplicateId(
          "checkpoint-gapped-shared-source",
          "assistant",
          2
        ),
        provider_source_id: "checkpoint-gapped-shared-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "second"
      }
    ]
  )
  assertEqual(
    restoredExactIdGappedLegacyOccurrences.length,
    3,
    "a legacy exact-id collision after an explicit gap must not consume occurrence two"
  )
  assertEqual(
    restoredExactIdGappedLegacyOccurrences.find((message) => message.content === "fourth")
      ?.provider_occurrence,
    4,
    "a legacy exact-id collision must advance past the running provider occurrence"
  )
  const restoredEffectiveExactIdConflict = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-effective-gap-three",
        provider_source_id: "checkpoint-effective-gap-source",
        provider_occurrence: 3,
        role: "assistant",
        content: "third"
      },
      {
        id: "checkpoint-effective-gap-shared",
        provider_source_id: "checkpoint-effective-gap-source",
        role: "assistant",
        content: "fourth"
      }
    ],
    [
      {
        id: "checkpoint-effective-gap-shared",
        provider_source_id: "checkpoint-effective-gap-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "second"
      }
    ]
  )
  assertEqual(
    restoredEffectiveExactIdConflict.length,
    3,
    "an exact id must not merge when its effective occurrence conflicts with the incoming one"
  )
  assertEqual(
    restoredEffectiveExactIdConflict.find((message) => message.content === "second")
      ?.provider_occurrence,
    2,
    "the earlier incoming occurrence must remain distinct from the effective legacy occurrence"
  )
  const checkpointGapBase = [
    {
      id: "checkpoint-idempotent-gap",
      provider_source_id: "checkpoint-idempotent-gap-source",
      role: "assistant" as const,
      content: "one"
    },
    {
      id: "checkpoint-idempotent-gap",
      provider_source_id: "checkpoint-idempotent-gap-source",
      provider_occurrence: 3,
      role: "assistant" as const,
      content: "three"
    }
  ]
  const completeGapReplay = [
    {
      id: "checkpoint-idempotent-gap",
      provider_source_id: "checkpoint-idempotent-gap-source",
      provider_occurrence: 1,
      role: "assistant" as const,
      content: "one"
    },
    {
      id: buildMessageSameRoleDuplicateId(
        "checkpoint-idempotent-gap-source",
        "assistant",
        2
      ),
      provider_source_id: "checkpoint-idempotent-gap-source",
      provider_occurrence: 2,
      role: "assistant" as const,
      content: "two"
    },
    {
      id: buildMessageSameRoleDuplicateId(
        "checkpoint-idempotent-gap-source",
        "assistant",
        3
      ),
      provider_source_id: "checkpoint-idempotent-gap-source",
      provider_occurrence: 3,
      role: "assistant" as const,
      content: "three"
    }
  ]
  const restoredCompleteGap = mergeCheckpointAuthorityTranscriptMessages(
    checkpointGapBase,
    completeGapReplay
  )
  assertEqual(
    restoredCompleteGap.map((message) => message.provider_occurrence).join("|"),
    "1|2|3",
    "a complete durable replay must fill a checkpoint occurrence gap in provider order"
  )
  const repeatedCompleteGap = mergeCheckpointAuthorityTranscriptMessages(
    restoredCompleteGap,
    completeGapReplay
  )
  assertEqual(
    repeatedCompleteGap.length,
    3,
    "replaying a complete gapped provider snapshot must remain idempotent"
  )
  assertEqual(
    repeatedCompleteGap.map((message) => message.content).join("|"),
    "one|two|three",
    "repeated complete gap replay must not duplicate an out-of-order occurrence"
  )
  const highOccurrenceCheckpointBase = [
    {
      id: "checkpoint-high-gap-provider",
      provider_source_id: "checkpoint-high-gap-provider",
      provider_occurrence: 3,
      role: "assistant" as const,
      content: "three"
    },
    {
      id: "checkpoint-high-gap-provider",
      provider_source_id: "checkpoint-high-gap-provider",
      role: "assistant" as const,
      content: "four"
    }
  ]
  const completeHighGapReplay = [1, 2, 3, 4].map((occurrence) => ({
    id:
      occurrence === 1
        ? "checkpoint-high-gap-canonical-one"
        : buildMessageSameRoleDuplicateId(
            "checkpoint-high-gap-provider",
            "assistant",
            occurrence
          ),
    provider_source_id: "checkpoint-high-gap-provider",
    provider_occurrence: occurrence,
    role: "assistant" as const,
    content: ["one", "two", "three", "four"][occurrence - 1]
  }))
  const restoredCompleteHighGap = mergeCheckpointAuthorityTranscriptMessages(
    highOccurrenceCheckpointBase,
    completeHighGapReplay
  )
  assertEqual(
    restoredCompleteHighGap.map((message) => message.provider_occurrence).join("|"),
    "1|2|3|4",
    "a replay starting before an occupied raw provider id must retain every occurrence"
  )
  const repeatedCompleteHighGap = mergeCheckpointAuthorityTranscriptMessages(
    restoredCompleteHighGap,
    completeHighGapReplay
  )
  assertEqual(
    repeatedCompleteHighGap.length,
    4,
    "replaying a complete high-gap provider snapshot must remain idempotent"
  )
  assertEqual(
    repeatedCompleteHighGap.map((message) => message.content).join("|"),
    "one|two|three|four",
    "the occurrence-one collision id must not displace or duplicate occurrence two"
  )
  const gapUserFour: Message = {
    id: "alias-gap-user-4",
    role: "user",
    content: "gap question four",
    created_at: new Date("2026-07-20T06:00:04.000Z")
  }
  db.upsertThreadMessages(gapThreadId, [gapUserFour])
  const gapFourth = normalizeAppendedMessageIds([...restoredGapMessages, gapUserFour], [
    {
      id: gapProviderId,
      role: "assistant",
      content: "gap answer four",
      created_at: new Date("2026-07-20T06:00:05.000Z")
    }
  ]) as Message[]
  assertEqual(
    gapFourth[0]?.id,
    gapFourthOccurrenceId,
    "a canonical alias must retain a gapped provider occurrence number"
  )
  db.upsertThreadMessages(gapThreadId, gapFourth)
  const gapMessages = db.getThreadMessages(gapThreadId)
  assertEqual(
    gapMessages.length,
    6,
    "a new turn after a gapped canonical alias must remain a distinct row"
  )
  assertEqual(
    gapMessages[3]?.provider_occurrence,
    3,
    "the canonical row must persist its original provider occurrence"
  )
  assertEqual(
    gapMessages[5]?.id,
    gapFourthOccurrenceId,
    "the occurrence after a gapped canonical alias must advance past the alias source"
  )

  db.deleteThread(threadId)
  db.deleteThread(gapThreadId)
  await db.closeDatabase()
}

async function testAfterModelSteerRekeysCurrentProviderOccurrence(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-after-model-steer-provider-occurrence"
  const providerId = "after-model-reused-provider"
  const secondOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)
  const stableId = "current-run-assistant:stable-occurrence-two"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "After model provider occurrence" })
  db.upsertThreadMessages(threadId, [
    {
      id: "after-model-user-1",
      role: "user",
      content: "first question",
      created_at: new Date("2026-07-22T01:00:00.000Z")
    },
    {
      id: providerId,
      role: "assistant",
      content: "old answer",
      created_at: new Date("2026-07-22T01:00:01.000Z")
    },
    {
      id: "after-model-user-2",
      role: "user",
      content: "second question",
      created_at: new Date("2026-07-22T01:00:02.000Z")
    }
  ])
  const [partial] = normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
    {
      id: providerId,
      role: "assistant",
      content: "new partial",
      created_at: new Date("2026-07-22T01:00:03.000Z")
    }
  ]) as Message[]
  db.upsertThreadMessages(threadId, [partial])

  const completed = {
    id: stableId,
    sourceId: providerId,
    content: "new final"
  }
  const identity = resolveCurrentRunCompletedAssistantIdentity(
    db.getThreadMessages(threadId),
    completed
  )
  assertEqual(
    identity.sourceId,
    secondOccurrenceId,
    "afterModel must resolve the current occurrence-scoped provider row"
  )
  assertEqual(
    db.replaceThreadMessageId(threadId, identity.sourceId!, stableId, "assistant"),
    true,
    "the current provider occurrence should rekey to the stable id"
  )
  const finalMessages: Message[] = [
    {
      id: stableId,
      provider_source_id: identity.providerSourceId,
      provider_occurrence: identity.providerOccurrence,
      role: "assistant",
      content: completed.content,
      content_priority: 1,
      created_at: new Date("2026-07-22T01:00:04.000Z")
    },
    {
      id: "after-model-steered-user",
      role: "user",
      content: "steer",
      created_at: new Date("2026-07-22T01:00:05.000Z")
    }
  ]
  db.upsertThreadMessages(threadId, finalMessages)
  db.moveThreadMessagesAfterLastNonAssistant(
    threadId,
    finalMessages.map((message) => message.id)
  )
  await db.flushStrict()
  await db.closeDatabase()
  await db.initializeDatabase()

  let messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 5, "afterModel rekey must leave one row per visible message")
  assertEqual(
    messages.map((message) => `${message.role}:${String(message.content)}`).join("|"),
    "user:first question|assistant:old answer|user:second question|assistant:new final|user:steer",
    "afterModel rekey must preserve the old answer and current-turn order across reopen"
  )
  const retryIdentity = resolveCurrentRunCompletedAssistantIdentity(messages, completed)
  assertEqual(
    retryIdentity.sourceId,
    stableId,
    "a retry after durable persistence must reuse the existing stable assistant row"
  )
  assertEqual(
    retryIdentity.providerOccurrence,
    2,
    "a retry after durable persistence must keep the existing provider occurrence"
  )
  db.upsertThreadMessages(threadId, finalMessages)
  assertEqual(
    db.getThreadMessages(threadId).length,
    5,
    "retrying the completed reply and steered user must remain idempotent"
  )
  const runToken = "after-model-route-run"
  setCurrentRunMessageQueueOwner(threadId, runToken)
  registerCurrentRunCompletedAssistantRoute(threadId, runToken, {
    rawSourceId: providerId,
    stableId,
    providerSourceId: providerId,
    providerOccurrence: 2,
    content: completed.content,
    observedContent: "new "
  })
  const routedLateIdentity = routeCurrentRunCompletedAssistantMessage(
    threadId,
    {
      id: providerId,
      role: "assistant",
      content: "final"
    },
    runToken
  )
  assertEqual(
    routedLateIdentity?.stableId,
    stableId,
    "the production-shaped delayed raw event must route to the stable occurrence"
  )
  db.upsertThreadMessages(
    threadId,
    normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
      {
        id: routedLateIdentity!.stableId,
        provider_source_id: routedLateIdentity!.providerSourceId,
        provider_occurrence: routedLateIdentity!.providerOccurrence,
        role: "assistant",
        content: routedLateIdentity!.content,
        created_at: new Date("2026-07-22T01:00:06.000Z")
      }
    ]) as Message[]
  )
  messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 5, "a delayed tuple-two replay must reuse the stable row")

  db.upsertThreadMessages(threadId, [
    {
      id: "after-model-user-3",
      role: "user",
      content: "third question",
      created_at: new Date("2026-07-22T01:00:07.000Z")
    }
  ])
  const [thirdOccurrence] = normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
    {
      id: providerId,
      role: "assistant",
      content: "third answer",
      created_at: new Date("2026-07-22T01:00:08.000Z")
    }
  ]) as Message[]
  assertEqual(
    thirdOccurrence.provider_occurrence,
    3,
    "a later provider reuse must remain independent of the completed occurrence alias"
  )
  db.upsertThreadMessages(threadId, [thirdOccurrence])
  messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 7, "the next provider occurrence must remain a distinct row")
  assertEqual(messages[1]?.content, "old answer", "the first occurrence must remain untouched")

  clearCurrentRunMessageQueue(threadId, runToken)
  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testFirstOccurrenceIdentitySurvivesEveryAliasPath(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const providerId = "first-occurrence-provider-id"
  const secondOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)

  await db.initializeDatabase()
  for (const scenario of ["existing-source", "early-alias", "existing-target"] as const) {
    const threadId = `thread-first-occurrence-alias-${scenario}`
    const canonicalId = `canonical-first-answer-${scenario}`
    db.createThread(threadId, { title: `First occurrence alias ${scenario}` })

    if (scenario === "early-alias") {
      assertEqual(
        db.replaceThreadMessageId(threadId, providerId, canonicalId, "assistant"),
        true,
        "an early alias should be remembered before its source row arrives"
      )
      db.upsertThreadMessages(threadId, [
        {
          id: "first-alias-user",
          role: "user",
          content: "question one",
          created_at: new Date("2026-07-20T06:00:00.000Z")
        },
        {
          id: providerId,
          role: "assistant",
          content: "answer one",
          created_at: new Date("2026-07-20T06:00:01.000Z")
        }
      ])
    } else {
      db.upsertThreadMessages(threadId, [
        {
          id: "first-alias-user",
          role: "user",
          content: "question one",
          created_at: new Date("2026-07-20T06:00:00.000Z")
        },
        {
          id: providerId,
          role: "assistant",
          content: "answer one draft",
          created_at: new Date("2026-07-20T06:00:01.000Z")
        },
        ...(scenario === "existing-target"
          ? [
              {
                id: canonicalId,
                role: "assistant" as const,
                content: "answer one",
                created_at: new Date("2026-07-20T06:00:02.000Z")
              }
            ]
          : [])
      ])
      assertEqual(
        db.replaceThreadMessageId(threadId, providerId, canonicalId, "assistant"),
        true,
        "an existing first occurrence should accept its canonical id"
      )
    }

    let messages = db.getThreadMessages(threadId)
    assertEqual(
      messages.find((message) => message.id === canonicalId)?.provider_source_id,
      providerId,
      `${scenario} aliases must retain the first provider identity`
    )
    db.upsertThreadMessages(threadId, [
      {
        id: "second-alias-user",
        role: "user",
        content: "question two",
        created_at: new Date("2026-07-20T06:00:03.000Z")
      }
    ])
    db.upsertThreadMessages(
      threadId,
      normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
        {
          id: providerId,
          role: "assistant",
          content: "answer two",
          created_at: new Date("2026-07-20T06:00:04.000Z")
        }
      ]) as Message[]
    )
    messages = db.getThreadMessages(threadId)
    assertEqual(messages.length, 4, `${scenario} aliases must preserve two complete turns`)
    assertEqual(
      messages.at(-1)?.id,
      secondOccurrenceId,
      `${scenario} aliases must advance provider reuse to occurrence two`
    )
    assertEqual(
      messages.at(-1)?.content,
      "answer two",
      `${scenario} aliases must not merge the second answer into the first`
    )

    await db.flush()
    await db.closeDatabase()
    await db.initializeDatabase()
    assertEqual(
      db.getThreadMessages(threadId).find((message) => message.id === canonicalId)
        ?.provider_source_id,
      providerId,
      `${scenario} provider identity must survive database reopen`
    )
    db.deleteThread(threadId)
  }
  await db.closeDatabase()
}

async function testEarlyAliasPreservesGappedProviderOccurrence(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-early-gapped-occurrence-alias"
  const providerId = "early-gapped-provider-id"
  const thirdOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)
  const fourthOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 4)
  const canonicalThirdId = "early-gapped-canonical-three"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Early gapped occurrence alias" })
  db.upsertThreadMessages(threadId, [
    {
      id: "early-gap-user-one",
      role: "user",
      content: "question one",
      created_at: new Date("2026-07-20T06:30:00.000Z")
    },
    {
      id: providerId,
      role: "assistant",
      content: "answer one",
      created_at: new Date("2026-07-20T06:30:01.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(
      threadId,
      thirdOccurrenceId,
      canonicalThirdId,
      "assistant"
    ),
    true,
    "an early gapped occurrence alias should be remembered before either row exists"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "early-gap-user-three",
      role: "user",
      content: "question three",
      created_at: new Date("2026-07-20T06:30:02.000Z")
    },
    {
      id: thirdOccurrenceId,
      role: "assistant",
      content: "answer three",
      created_at: new Date("2026-07-20T06:30:03.000Z")
    }
  ])
  assertEqual(
    db.getThreadMessages(threadId).find((message) => message.id === canonicalThirdId)
      ?.provider_occurrence,
    3,
    "early alias application must retain the occurrence encoded in the source id"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: "early-gap-user-four",
      role: "user",
      content: "question four",
      created_at: new Date("2026-07-20T06:30:04.000Z")
    }
  ])
  const fourth = normalizeAppendedMessageIds(db.getThreadMessages(threadId), [
    {
      id: providerId,
      role: "assistant",
      content: "answer four",
      created_at: new Date("2026-07-20T06:30:05.000Z")
    }
  ]) as Message[]
  assertEqual(
    fourth[0]?.id,
    fourthOccurrenceId,
    "the occurrence after an early gapped alias must advance past the preserved gap"
  )
  db.upsertThreadMessages(threadId, fourth)
  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 6, "the fourth answer must remain a distinct message row")
  assertEqual(
    messages.map((message) => message.content).join("|"),
    "question one|answer one|question three|answer three|question four|answer four",
    "an early gapped alias must not merge later turns into its canonical row"
  )

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testReplaceThreadMessageIdRejectsDifferentProviderOccurrence(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-provider-identity-rekey-conflict"
  const rawFirstThreadId = "thread-raw-first-occurrence-rekey-conflict"
  const canonicalFirstThreadId = "thread-canonical-first-occurrence-rekey-conflict"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Provider identity rekey conflict" })
  db.upsertThreadMessages(threadId, [
    {
      id: "canonical-same",
      provider_source_id: "provider-A",
      provider_occurrence: 2,
      role: "assistant",
      content: "answer A",
      created_at: new Date("2026-07-20T07:00:00.000Z")
    },
    {
      id: "draft-B",
      provider_source_id: "provider-B",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer B",
      created_at: new Date("2026-07-20T07:00:01.000Z")
    }
  ])

  assertEqual(
    db.replaceThreadMessageId(threadId, "draft-B", "canonical-same", "assistant"),
    false,
    "different provider occurrences must refuse a destructive rekey"
  )
  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 2, "a rejected rekey must preserve both provider messages")
  assertEqual(
    messages.map((message) => message.content).join("|"),
    "answer A|answer B",
    "a rejected rekey must not discard either answer"
  )
  assertEqual(
    messages.map((message) => message.provider_source_id).join("|"),
    "provider-A|provider-B",
    "a rejected rekey must not overwrite provider identities"
  )

  db.createThread(rawFirstThreadId, { title: "Raw first occurrence rekey conflict" })
  db.upsertThreadMessages(rawFirstThreadId, [
    {
      id: "provider-reused",
      role: "assistant",
      content: "old answer",
      created_at: new Date("2026-07-20T07:01:00.000Z")
    },
    {
      id: "draft-occ2",
      provider_source_id: "provider-reused",
      provider_occurrence: 2,
      role: "assistant",
      content: "new answer",
      created_at: new Date("2026-07-20T07:01:01.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(
      rawFirstThreadId,
      "draft-occ2",
      "provider-reused",
      "assistant"
    ),
    false,
    "a raw provider id must be treated as occurrence one when occurrence two targets it"
  )
  const rawFirstMessages = db.getThreadMessages(rawFirstThreadId)
  assertEqual(rawFirstMessages.length, 2, "the raw first and explicit second answers must survive")
  assertEqual(
    rawFirstMessages.map((message) => message.content).join("|"),
    "old answer|new answer",
    "the explicit second answer must not be swallowed by the raw first occurrence"
  )

  db.createThread(canonicalFirstThreadId, {
    title: "Canonical first occurrence rekey conflict"
  })
  db.upsertThreadMessages(canonicalFirstThreadId, [
    {
      id: "canonical-one",
      provider_source_id: "canonical-reused-provider",
      role: "assistant",
      content: "first answer",
      created_at: new Date("2026-07-20T07:02:00.000Z")
    },
    {
      id: "canonical-two",
      provider_source_id: "canonical-reused-provider",
      provider_occurrence: 2,
      role: "assistant",
      content: "second answer",
      created_at: new Date("2026-07-20T07:02:01.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(
      canonicalFirstThreadId,
      "canonical-one",
      "canonical-two",
      "assistant"
    ),
    false,
    "a canonical occurrence one must not rekey into occurrence two"
  )
  assertEqual(
    db.getThreadMessages(canonicalFirstThreadId).length,
    2,
    "a rejected canonical occurrence conflict must preserve both answers"
  )

  db.deleteThread(threadId)
  db.deleteThread(rawFirstThreadId)
  db.deleteThread(canonicalFirstThreadId)
  await db.closeDatabase()
}

async function testOpaqueDraftRekeyPreservesCanonicalProviderIdentity(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-opaque-draft-canonical-rekey"
  const providerId = "opaque-draft-provider-id"
  const canonicalId = "opaque-draft-canonical-two"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Opaque draft canonical rekey" })
  db.upsertThreadMessages(threadId, [
    {
      id: "opaque-stream-draft",
      role: "assistant",
      content: "draft answer",
      created_at: new Date("2026-07-20T07:10:00.000Z")
    },
    {
      id: canonicalId,
      provider_source_id: providerId,
      provider_occurrence: 2,
      role: "assistant",
      content: "final answer",
      created_at: new Date("2026-07-20T07:10:01.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(threadId, "opaque-stream-draft", canonicalId, "assistant"),
    true,
    "an opaque stream draft should merge into its existing canonical row"
  )
  let messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 1, "the opaque draft and canonical row should coalesce once")
  assertEqual(
    messages[0]?.provider_source_id,
    providerId,
    "an opaque draft must not overwrite the canonical provider source"
  )
  assertEqual(
    messages[0]?.provider_occurrence,
    2,
    "an opaque draft must not overwrite the canonical provider occurrence"
  )
  db.upsertThreadMessages(
    threadId,
    normalizeAppendedMessageIds(messages, [
      {
        id: buildMessageSameRoleDuplicateId(providerId, "assistant", 2),
        provider_source_id: providerId,
        provider_occurrence: 2,
        role: "assistant",
        content: "final answer",
        created_at: new Date("2026-07-20T07:10:02.000Z")
      }
    ]) as Message[]
  )
  messages = db.getThreadMessages(threadId)
  assertEqual(
    messages.length,
    1,
    "replaying the canonical provider occurrence must not create a duplicate row"
  )
  assertEqual(messages[0]?.id, canonicalId, "the canonical message id must remain stable")

  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testSameRoleRenderIdProviderTupleConflictPersistsBothRows(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-same-role-provider-tuple-conflict"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Same-role provider tuple conflict" })
  db.upsertThreadMessages(threadId, [
    {
      id: "same-role-tuple-render-id",
      provider_source_id: "same-role-provider-a",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer A",
      created_at: new Date("2026-07-21T05:00:00.000Z")
    }
  ])
  db.upsertThreadMessages(threadId, [
    {
      id: "same-role-tuple-render-id",
      provider_source_id: "same-role-provider-b",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer B",
      created_at: new Date("2026-07-21T05:00:01.000Z")
    }
  ])
  db.upsertThreadMessages(threadId, [
    {
      id: "same-role-tuple-render-id",
      provider_source_id: "same-role-provider-b",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer B",
      created_at: new Date("2026-07-21T05:00:01.000Z")
    }
  ])
  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 2, "different provider tuples must persist as two rows")
  assertEqual(
    new Set(messages.map((message) => message.id)).size,
    2,
    "different provider tuples must receive unique database message ids"
  )
  assertEqual(
    messages.map((message) => message.content).join("|"),
    "answer A|answer B",
    "database replay must not overwrite or concatenate different provider tuples"
  )
  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testCompleteSnapshotBackfillReordersProviderOccurrences(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-provider-occurrence-backfill-order"
  const providerId = "provider-occurrence-backfill"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Provider occurrence backfill order" })

  db.upsertThreadMessages(threadId, [
    {
      id: "persisted-system-anchor",
      role: "system",
      content: "system anchor",
      created_at: new Date("2026-07-21T05:09:59.000Z")
    },
    {
      id: "snapshot-user-three",
      role: "user",
      content: "question three",
      created_at: new Date("2026-07-21T05:10:04.000Z")
    },
    {
      id: "canonical-occurrence-three",
      provider_source_id: providerId,
      provider_occurrence: 3,
      role: "assistant",
      content: "three",
      created_at: new Date("2026-07-21T05:10:05.000Z")
    }
  ])
  const completeSnapshot: Message[] = [
    {
      id: "snapshot-user-one",
      role: "user",
      content: "question one",
      created_at: new Date("2026-07-21T05:10:00.000Z")
    },
    {
      id: "snapshot-occurrence-one",
      provider_source_id: providerId,
      provider_occurrence: 1,
      role: "assistant",
      content: "one",
      created_at: new Date("2026-07-21T05:10:01.000Z")
    },
    {
      id: "snapshot-user-two",
      role: "user",
      content: "question two",
      created_at: new Date("2026-07-21T05:10:02.000Z")
    },
    {
      id: "snapshot-occurrence-two",
      provider_source_id: providerId,
      provider_occurrence: 2,
      role: "assistant",
      content: "two",
      created_at: new Date("2026-07-21T05:10:03.000Z")
    },
    {
      id: "snapshot-user-three",
      role: "user",
      content: "question three",
      created_at: new Date("2026-07-21T05:10:04.000Z")
    },
    {
      id: "snapshot-occurrence-three",
      provider_source_id: providerId,
      provider_occurrence: 3,
      role: "assistant",
      content: "three",
      created_at: new Date("2026-07-21T05:10:05.000Z")
    }
  ]

  db.upsertThreadMessages(threadId, completeSnapshot)
  db.upsertThreadMessages(threadId, completeSnapshot)
  assertEqual(
    db
      .getThreadMessages(threadId)
      .map((message) => message.content)
      .join("|"),
    "system anchor|question one|one|question two|two|question three|three",
    "a complete snapshot must backfill whole turns around snapshot-external anchors"
  )
  assertEqual(
    db
      .getThreadMessagesAfterAnyId(threadId, ["snapshot-user-one"])
      .map((message) => message.content)
      .join("|"),
    "one|question two|two|question three|three",
    "durable tail lookup must follow the repaired whole-turn order"
  )

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  assertEqual(
    db
      .getThreadMessages(threadId)
      .map((message) => message.content)
      .join("|"),
    "system anchor|question one|one|question two|two|question three|three",
    "whole-turn snapshot order must survive database reopen"
  )
  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testAliasCollisionRecoveryPreservesAssistantToolOrder(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-alias-recovery-order"
  const draftId = "alias-recovery-assistant-draft"
  const sharedCanonicalId = "alias-recovery-shared-canonical"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Alias recovery order" })
  db.upsertThreadMessages(threadId, [
    {
      id: draftId,
      role: "assistant",
      content: "calling tool",
      created_at: new Date("2026-07-21T05:20:00.000Z")
    }
  ])
  assertEqual(
    db.replaceThreadMessageId(threadId, draftId, sharedCanonicalId, "assistant"),
    true,
    "the assistant draft should adopt its canonical id"
  )
  db.upsertThreadMessages(threadId, [
    {
      id: sharedCanonicalId,
      role: "tool",
      content: "tool result",
      tool_call_id: "alias-recovery-call",
      created_at: new Date("2026-07-21T05:20:01.000Z")
    }
  ])
  assertEqual(
    db
      .getThreadMessages(threadId)
      .map((message) => `${message.role}:${message.content}`)
      .join("|"),
    "assistant:calling tool|tool:tool result",
    "cross-role alias recovery must keep the assistant before its tool result"
  )
  assertEqual(
    db
      .getThreadMessagesAfterAnyId(threadId, [draftId])
      .map((message) => message.content)
      .join("|"),
    "tool result",
    "durable tail lookup must include the late tool after the recovered assistant"
  )

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  assertEqual(
    db
      .getThreadMessages(threadId)
      .map((message) => `${message.role}:${message.content}`)
      .join("|"),
    "assistant:calling tool|tool:tool result",
    "cross-role alias recovery order must survive database reopen"
  )
  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testCanonicalTupleRebasesImplicitRawOccurrence(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-implicit-raw-canonical-rebase"
  const providerId = "implicit-raw-provider"
  await db.initializeDatabase()
  db.createThread(threadId, { title: "Implicit raw canonical rebase" })
  db.upsertThreadMessages(threadId, [
    {
      id: providerId,
      role: "assistant",
      content: "same answer",
      created_at: new Date("2026-07-21T05:30:00.000Z")
    }
  ])
  const canonical: Message = {
    id: "implicit-raw-checkpoint-canonical",
    provider_source_id: providerId,
    provider_occurrence: 1,
    role: "assistant",
    content: "same answer",
    created_at: new Date("2026-07-21T05:30:01.000Z")
  }
  db.upsertThreadMessages(threadId, [canonical])
  db.upsertThreadMessages(threadId, [canonical])
  let messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 1, "a canonical tuple must rebase onto its implicit raw occurrence")
  assertEqual(messages[0]?.id, providerId, "the existing raw render id must remain stable")

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 1, "implicit raw tuple rebase must survive database reopen")
  db.deleteThread(threadId)
  await db.closeDatabase()
}

async function testCrossRoleProviderIdCollisionPersistsBothRows(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const threadId = "thread-cross-role-provider-id"

  await db.initializeDatabase()
  db.createThread(threadId, { title: "Cross-role provider id" })
  assertEqual(
    db.upsertThreadMessages(threadId, [
      {
        id: "shared-provider-id",
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "call-1", name: "read_file", args: {} }],
        created_at: new Date("2026-07-20T01:00:00.000Z")
      },
      {
        id: "shared-provider-id",
        role: "tool",
        content: "tool result",
        tool_call_id: "call-1",
        name: "read_file",
        created_at: new Date("2026-07-20T01:00:01.000Z")
      }
    ]),
    2,
    "same-batch cross-role provider ids should persist as two rows"
  )

  db.upsertThreadMessages(threadId, [
    {
      id: "shared-provider-id",
      role: "tool",
      content: "tool result updated",
      tool_call_id: "call-1",
      created_at: new Date("2026-07-20T01:00:02.000Z")
    }
  ])

  await db.flush()
  await db.closeDatabase()
  await db.initializeDatabase()
  const messages = db.getThreadMessages(threadId)
  assertEqual(messages.length, 2, "cross-role rows should survive database reopen")
  assertEqual(
    new Set(messages.map((message) => message.id)).size,
    2,
    "persisted cross-role rows should have unique internal ids"
  )
  assertEqual(
    messages.map((message) => message.role).join(","),
    "assistant,tool",
    "persisted cross-role rows should keep their roles and order"
  )
  assertEqual(
    messages.find((message) => message.role === "tool")?.content,
    "tool result updated",
    "later raw-id tool chunks should update the same role-scoped row"
  )

  db.deleteThread(threadId)

  const syntheticOnlyThreadId = "thread-synthetic-role-id-only"
  db.createThread(syntheticOnlyThreadId, { title: "Synthetic role id only" })
  const syntheticToolId = buildMessageRoleCollisionId("orphaned-provider-id", "tool")
  db.upsertThreadMessages(syntheticOnlyThreadId, [
    {
      id: syntheticToolId,
      role: "tool",
      content: "orphaned tool result",
      tool_call_id: "call-orphaned",
      created_at: new Date("2026-07-20T02:00:00.000Z")
    }
  ])
  db.upsertThreadMessages(syntheticOnlyThreadId, [
    {
      id: "orphaned-provider-id",
      role: "tool",
      content: "orphaned tool result updated",
      tool_call_id: "call-orphaned",
      created_at: new Date("2026-07-20T02:00:01.000Z")
    }
  ])
  const syntheticOnlyMessages = db.getThreadMessages(syntheticOnlyThreadId)
  assertEqual(
    syntheticOnlyMessages.length,
    1,
    "raw provider updates should reuse an existing role-scoped row without its raw sibling"
  )
  assertEqual(
    syntheticOnlyMessages[0]?.id,
    syntheticToolId,
    "a synthetic-only role row should keep its stable internal id"
  )
  assertEqual(
    syntheticOnlyMessages[0]?.content,
    "orphaned tool result updated",
    "a synthetic-only role row should still receive later raw provider updates"
  )
  db.deleteThread(syntheticOnlyThreadId)

  const oppositeKeeperThreadId = "thread-opposite-role-keeper"
  db.createThread(oppositeKeeperThreadId, { title: "Opposite role keeper" })
  db.upsertThreadMessages(oppositeKeeperThreadId, [
    {
      id: "opposite-keeper-id",
      role: "assistant",
      content: "assistant keeps the raw id in the database",
      created_at: new Date("2026-07-20T03:00:00.000Z")
    }
  ])
  db.upsertThreadMessages(oppositeKeeperThreadId, [
    {
      id: "opposite-keeper-id",
      role: "user",
      content: "user receives the synthetic database id",
      created_at: new Date("2026-07-20T03:00:01.000Z")
    }
  ])
  db.upsertThreadMessages(oppositeKeeperThreadId, [
    {
      id: buildMessageRoleCollisionId("opposite-keeper-id", "assistant"),
      role: "assistant",
      content: "assistant update from the opposite UI keeper",
      created_at: new Date("2026-07-20T03:00:02.000Z")
    }
  ])
  const oppositeKeeperMessages = db.getThreadMessages(oppositeKeeperThreadId)
  assertEqual(
    oppositeKeeperMessages.length,
    2,
    "a synthetic UI id must reuse the database row for the same source id and role"
  )
  assertEqual(
    oppositeKeeperMessages.find((message) => message.role === "assistant")?.content,
    "assistant keeps the raw id in the databaseassistant update from the opposite UI keeper",
    "the opposite-keeper update must merge into the existing assistant row"
  )
  assertEqual(
    oppositeKeeperMessages.some(
      (message) =>
        message.id === buildMessageRoleCollisionId("opposite-keeper-id", "assistant") &&
        message.role === "assistant"
    ),
    false,
    "the opposite UI keeper must not create a duplicate synthetic assistant row"
  )
  db.deleteThread(oppositeKeeperThreadId)

  const trimmedCollisionThreadId = "thread-trimmed-role-collision"
  db.createThread(trimmedCollisionThreadId, { title: "Trimmed role collision" })
  db.upsertThreadMessages(trimmedCollisionThreadId, [
    {
      id: "trimmed-provider-id",
      role: "assistant",
      content: "assistant row",
      created_at: new Date("2026-07-20T04:00:00.000Z")
    }
  ])
  db.upsertThreadMessages(trimmedCollisionThreadId, [
    {
      id: "  trimmed-provider-id  ",
      role: "tool",
      content: "tool result with padded provider id",
      tool_call_id: "call-trimmed",
      created_at: new Date("2026-07-20T04:00:01.000Z")
    }
  ])
  const trimmedCollisionMessages = db.getThreadMessages(trimmedCollisionThreadId)
  assertEqual(
    trimmedCollisionMessages.length,
    2,
    "id trimming must happen before cross-role collision normalization"
  )
  assertEqual(
    trimmedCollisionMessages.map((message) => message.role).join(","),
    "assistant,tool",
    "a padded provider id must not make the tool row collide with the assistant primary key"
  )
  db.deleteThread(trimmedCollisionThreadId)
  await db.closeDatabase()
}

async function main(): Promise<void> {
  await withTempHome(async () => {
    await testMessagesPersistAcrossReopen()
    await testSteeredTranscriptRecordsAreSplicedBeforeDelayedFollowup()
    await testSteeredTranscriptBlockUsesPhysicalRunAnchor()
    await testSteeredTranscriptAnchorSurvivesCrossRoleProviderCollision()
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
    await testSameRoleDuplicateIdsPersistAsDistinctRows()
    await testLateRawRoleCollisionChunkFollowsMessageAlias()
    await testThreadMessageUpsertReplayAndAppendContracts()
    await testSameRoleOccurrenceIdentitySurvivesAlias()
    await testAfterModelSteerRekeysCurrentProviderOccurrence()
    await testFirstOccurrenceIdentitySurvivesEveryAliasPath()
    await testEarlyAliasPreservesGappedProviderOccurrence()
    await testReplaceThreadMessageIdRejectsDifferentProviderOccurrence()
    await testOpaqueDraftRekeyPreservesCanonicalProviderIdentity()
    await testSameRoleRenderIdProviderTupleConflictPersistsBothRows()
    await testCompleteSnapshotBackfillReordersProviderOccurrences()
    await testAliasCollisionRecoveryPreservesAssistantToolOrder()
    await testCanonicalTupleRebasesImplicitRawOccurrence()
    await testCrossRoleProviderIdCollisionPersistsBothRows()
  })
  console.log("thread-messages-db.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
