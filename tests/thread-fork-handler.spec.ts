/**
 * Regression tests for the threads:fork handler path.
 *
 * Run:
 *   npx tsx tests/thread-fork-handler.spec.ts
 */

import assert from "assert"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { Checkpoint, CheckpointMetadata, PendingWrite } from "@langchain/langgraph-checkpoint"
import type { Message } from "../src/main/types.ts"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../src/shared/checkpoint-transcript.ts"
import {
  FORK_BOUNDARY_MARKER_VERSION,
  FORK_BOUNDARY_THREAD_METADATA_KEY
} from "../src/shared/checkpoint-forkability.ts"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../src/shared/message-role-collision.ts"

type IpcHandler = (_event: unknown, ...args: unknown[]) => unknown

async function withTempHome(run: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), "cmb-thread-fork-handler-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await run()
  } finally {
    // Native SQLite keeps Windows file handles until both the runtime
    // checkpointer cache and the global DB are explicitly closed.
    try {
      const { closeRuntime } = await import("../src/main/agent/runtime.ts")
      await closeRuntime()
    } catch {
      // Preserve the test's original failure; this is best-effort harness cleanup.
    }
    try {
      const db = await import("../src/main/db/index.ts")
      await db.closeDatabase()
    } catch {
      // Preserve the test's original failure.
    }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(home, { recursive: true, force: true })
  }
}

async function closeAndDeleteThreadCheckpoint(
  threadId: string,
  deleteCheckpoint: (threadId: string) => void
): Promise<void> {
  const { closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  await closeCheckpointer(threadId)
  deleteCheckpoint(threadId)
}

function makeCheckpoint(id: string, ts = "2026-07-08T01:00:00.000Z"): Checkpoint {
  return {
    v: 1,
    id,
    ts,
    channel_values: {
      messages: [
        { id: "user-1", type: "human", content: "fork source prompt" },
        {
          id: "assistant-1",
          type: "ai",
          content: "checkpoint final answer",
          tool_calls: [{ id: "tool-1", name: "inspect", args: { target: "fork" } }]
        }
      ]
    },
    channel_versions: { messages: 1 },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

function makeCheckpointWithVisiblePair(input: {
  id: string
  ts: string
  userId: string
  userText: string
  assistantId: string
  assistantText: string
}): Checkpoint {
  const checkpoint = makeCheckpoint(input.id, input.ts)
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: input.userId, type: "human", content: input.userText },
    { id: input.assistantId, type: "ai", content: input.assistantText }
  ]
  return checkpoint
}

function makeCheckpointWithVisibleMessages(
  id: string,
  ts: string,
  messages: Array<{ id: string; type: "human" | "ai" | "tool"; content: string }>
): Checkpoint {
  const checkpoint = makeCheckpoint(id, ts)
  ;(checkpoint.channel_values as Record<string, unknown>).messages = messages
  return checkpoint
}

function makeHiddenTailCheckpoint(id: string): Checkpoint {
  const checkpoint = makeCheckpoint(id, "2026-07-08T01:00:02.000Z")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "fork source prompt" },
    { id: "assistant-1", type: "ai", content: "checkpoint final answer" },
    { id: "wf-trigger", type: "human", content: WORKFLOW_NOTIFICATION_TURN_PROMPT }
  ]
  return checkpoint
}

function makeInterruptedToolTailCheckpoint(id: string): Checkpoint {
  const checkpoint = makeCheckpoint(id, "2026-07-08T01:00:02.000Z")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "fork source prompt" },
    {
      id: "assistant-1",
      type: "ai",
      content: "I will inspect the workspace.",
      tool_calls: [{ id: "tool-1", name: "inspect", args: { target: "fork" } }]
    },
    {
      id: "tool-result-1",
      type: "tool",
      content: "partial inspect output before user interrupted",
      tool_call_id: "tool-1",
      name: "inspect"
    }
  ]
  return checkpoint
}

function makeForkBoundaryMetadata(
  checkpointId: string,
  lastVisibleMessageId = "assistant-1"
): CheckpointMetadata {
  return {
    source: "loop",
    step: 1,
    writes: {},
    parents: {},
    cmb_fork_boundary: {
      version: 1,
      kind: "turn_complete",
      boundaryId: `turn_complete:source-thread:${checkpointId}`,
      completedAt: "2026-07-08T01:00:01.000Z",
      source: "agent_run_complete",
      lastVisibleMessageId
    }
  } as CheckpointMetadata
}

function makeInterruptedForkBoundaryMetadata(
  checkpointId: string,
  lastVisibleMessageId = "assistant-1"
): CheckpointMetadata {
  const metadata = makeForkBoundaryMetadata(checkpointId, lastVisibleMessageId) as Record<
    string,
    unknown
  >
  metadata.cmb_fork_boundary = {
    ...(metadata.cmb_fork_boundary as Record<string, unknown>),
    boundaryId: `turn_interrupted:source-thread:${checkpointId}`,
    source: "agent_run_interrupted",
    outcome: "interrupted"
  }
  return metadata as CheckpointMetadata
}

function makePlainMetadata(): CheckpointMetadata {
  return {
    source: "loop",
    step: 1,
    writes: {},
    parents: {}
  } as CheckpointMetadata
}

function registerTestThreadHandlers(
  registerThreadHandlers: (ipcMain: { handle: (channel: string, handler: IpcHandler) => void }) => void
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>()
  registerThreadHandlers({
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    }
  })
  return handlers
}

async function testResolveMessageForkSkipsHiddenRawTailCheckpoint(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, resolveForkCheckpointForMessage } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-hidden-tail-source"
  const boundaryCheckpointId = "fork-boundary-old"
  const hiddenTailCheckpointId = "fork-hidden-tail-new"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Hidden tail source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(boundaryCheckpointId, "2026-07-08T01:00:00.000Z"),
      makeForkBoundaryMetadata(boundaryCheckpointId)
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: boundaryCheckpointId
        }
      },
      makeHiddenTailCheckpoint(hiddenTailCheckpointId),
      makeForkBoundaryMetadata(hiddenTailCheckpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-1"
    })
    assert.equal(
      resolved?.checkpointId,
      boundaryCheckpointId,
      "message resolver should skip newer checkpoints with hidden raw tail messages"
    )

    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          checkpointId: hiddenTailCheckpointId,
          messageId: "assistant-1"
        }),
      /该消息不是稳定完成边界/,
      "explicit message fork should reject checkpoints with hidden raw tails"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveMessageForkReturnsNewestStableCheckpoint(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { resolveForkCheckpointForMessage } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-newest-match-source"
  const olderCheckpointId = "fork-boundary-older"
  const newerCheckpointId = "fork-boundary-newer"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Newest match source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(olderCheckpointId, "2026-07-08T01:00:00.000Z"),
      makeForkBoundaryMetadata(olderCheckpointId)
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: olderCheckpointId
        }
      },
      makeCheckpoint(newerCheckpointId, "2026-07-08T01:00:03.000Z"),
      makeForkBoundaryMetadata(newerCheckpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-1"
    })
    assert.equal(
      resolved?.checkpointId,
      newerCheckpointId,
      "message resolver should return the newest stable checkpoint from SqlJsSaver.list()"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveAndForkRoleCollisionAssistantBoundary(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, resolveForkCheckpointForMessage } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-role-collision-source"
  const checkpointId = "fork-role-collision-cp"
  const sharedId = "fork-shared-provider-id"
  const assistantRenderId = buildMessageRoleCollisionId(sharedId, "assistant")
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Role collision fork source",
      agentMode: "normal"
    })

    const checkpoint = makeCheckpoint(checkpointId)
    ;(checkpoint.channel_values as Record<string, unknown>).messages = [
      {
        id: sharedId,
        type: "human",
        content: "hidden coordinator state",
        additional_kwargs: { cmb_internal_coordinator_notification: true }
      },
      { id: sharedId, type: "human", content: "collision question" },
      { id: sharedId, type: "ai", content: "collision answer" }
    ]
    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      checkpoint,
      makeForkBoundaryMetadata(checkpointId, sharedId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: assistantRenderId,
      message: {
        id: assistantRenderId,
        role: "assistant",
        content: "collision answer"
      }
    })
    assert.equal(resolved?.checkpointId, checkpointId)
    assert.equal(
      resolved?.resolvedMessageId,
      assistantRenderId,
      "message resolver should retain the render id needed to select the exact duplicate occurrence"
    )

    const forked = await forkThread({
      sourceThreadId,
      checkpointId: resolved!.checkpointId,
      messageId: resolved!.resolvedMessageId,
      title: "Fork from role collision assistant"
    })
    targetThreadId = forked.thread.thread_id
    const targetMessages = db.getThreadMessages(targetThreadId)
    assert.deepEqual(
      targetMessages.map((message) => [message.role, message.content]),
      [
        ["user", "collision question"],
        ["assistant", "collision answer"]
      ],
      "forking the synthetic assistant id must not truncate at the earlier user with the same raw id"
    )
    assert.equal(new Set(targetMessages.map((message) => message.id)).size, 2)
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveAndForkSameRoleDuplicateAssistantBoundary(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, resolveForkCheckpointForMessage } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-same-role-duplicate-source"
  const checkpointId = "fork-same-role-duplicate-cp"
  const sharedId = "fork-same-role-provider-id"
  const duplicateRenderId = buildMessageSameRoleDuplicateId(sharedId, "assistant")
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Same-role duplicate fork source",
      agentMode: "normal"
    })

    const checkpoint = makeCheckpoint(checkpointId)
    ;(checkpoint.channel_values as Record<string, unknown>).messages = [
      { id: sharedId, type: "ai", content: "first assistant chunk" },
      { id: sharedId, type: "ai", content: "second assistant chunk" }
    ]
    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      checkpoint,
      makeForkBoundaryMetadata(checkpointId, sharedId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: duplicateRenderId,
      message: {
        id: duplicateRenderId,
        role: "assistant",
        content: "second assistant chunk"
      }
    })
    assert.equal(resolved?.checkpointId, checkpointId)
    assert.equal(resolved?.resolvedMessageId, duplicateRenderId)

    const forked = await forkThread({
      sourceThreadId,
      checkpointId: resolved!.checkpointId,
      messageId: resolved!.resolvedMessageId,
      title: "Fork from same-role duplicate assistant"
    })
    targetThreadId = forked.thread.thread_id
    const targetMessages = db.getThreadMessages(targetThreadId)
    assert.deepEqual(
      targetMessages.map((message) => [message.id, message.content]),
      [
        [sharedId, "first assistant chunk"],
        [duplicateRenderId, "second assistant chunk"]
      ],
      "forking a same-role duplicate boundary must preserve both durable rows"
    )
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveMessageForkMapsLiveSnapshotToCheckpointMessageId(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, resolveForkCheckpointForMessage } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-live-id-snapshot-source"
  const checkpointId = "fork-live-id-snapshot-cp"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Live id snapshot source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "live-assistant-id",
      message: {
        id: "live-assistant-id",
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tool-1", name: "inspect", args: { target: "fork" } }]
      }
    })
    assert.equal(
      resolved?.checkpointId,
      checkpointId,
      "message resolver should use the snapshot when the live UI id differs from checkpoint id"
    )
    assert.equal(
      resolved?.resolvedMessageId,
      "assistant-1",
      "message resolver should return the checkpoint message id for the final fork call"
    )

    const forked = await forkThread({
      sourceThreadId,
      checkpointId: resolved!.checkpointId,
      messageId: resolved!.resolvedMessageId,
      title: "Fork from resolved live id"
    })
    targetThreadId = forked.thread.thread_id
    assert.equal(forked.sourceCheckpointId, checkpointId)
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveMessageForkMatchesSparseToolAssistantSnapshot(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { registerThreadHandlers, resolveForkCheckpointForMessage } = await import(
    "../src/main/ipc/threads.ts"
  )

  const sourceThreadId = "fork-sparse-tool-assistant-source"
  const checkpointId = "fork-sparse-tool-assistant-cp"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Sparse tool assistant source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const listForkableCheckpoints = handlers.get("threads:list-forkable-checkpoints")
    assert(listForkableCheckpoints, "listForkableCheckpoints handler should be registered")
    const listed = (await listForkableCheckpoints(null, sourceThreadId)) as Array<{
      checkpointId: string
    }>
    assert.deepEqual(
      listed.map((checkpoint) => checkpoint.checkpointId),
      [checkpointId],
      "right-click checkpoint list should include the sparse tool assistant checkpoint"
    )

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "live-sparse-tool-assistant",
      message: {
        id: "live-sparse-tool-assistant",
        role: "assistant",
        content: ""
      }
    })
    assert.equal(
      resolved?.checkpointId,
      checkpointId,
      "message resolver should align sparse live assistant snapshots with listed tool checkpoints"
    )
    assert.equal(resolved?.resolvedMessageId, "assistant-1")
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveMessageForkUsesCheckpointModeForInterruptedToolTail(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  const { forkThread, registerThreadHandlers, resolveForkCheckpointForMessage } = await import(
    "../src/main/ipc/threads.ts"
  )

  const sourceThreadId = "fork-interrupted-tool-tail-source"
  const checkpointId = "fork-interrupted-tool-tail-cp"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Interrupted tool tail source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeInterruptedToolTailCheckpoint(checkpointId),
      makeInterruptedForkBoundaryMetadata(checkpointId, "tool-result-1")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const listForkableCheckpoints = handlers.get("threads:list-forkable-checkpoints")
    assert(listForkableCheckpoints, "listForkableCheckpoints handler should be registered")
    const listed = (await listForkableCheckpoints(null, sourceThreadId)) as Array<{
      checkpointId: string
      messageForkMode?: string
    }>
    assert.deepEqual(
      listed.map((checkpoint) => checkpoint.checkpointId),
      [checkpointId],
      "right-click checkpoint list should include the interrupted tool-tail checkpoint"
    )
    assert.equal(
      listed[0].messageForkMode,
      "checkpoint",
      "right-click checkpoint list should mark interrupted tool-tail fork as whole-checkpoint mode"
    )

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-1",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: "I will inspect the workspace.",
        tool_calls: [{ id: "tool-1", name: "inspect", args: { target: "fork" } }]
      }
    })
    assert.equal(
      resolved?.checkpointId,
      checkpointId,
      "message resolver should find the interrupted checkpoint for an assistant tool cluster"
    )
    assert.equal(
      resolved?.messageForkMode,
      "checkpoint",
      "interrupted assistant tool clusters should fork the whole checkpoint instead of truncating"
    )
    assert.equal(
      resolved?.resolvedMessageId,
      undefined,
      "checkpoint-mode message fork should not pass a truncate message id"
    )

    const sparseLiveResolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "live-tool-only-assistant",
      message: {
        id: "live-tool-only-assistant",
        role: "assistant",
        content: ""
      }
    })
    assert.equal(
      sparseLiveResolved?.checkpointId,
      checkpointId,
      "message resolver should align sparse tool-only live assistant snapshots with the interrupted checkpoint"
    )
    assert.equal(sparseLiveResolved?.messageForkMode, "checkpoint")

    const forked = await forkThread({
      sourceThreadId,
      checkpointId: resolved!.checkpointId,
      title: "Fork interrupted tool cluster"
    })
    targetThreadId = forked.thread.thread_id

    const targetMessages = db.getThreadMessages(targetThreadId)
    assert.deepEqual(
      targetMessages.map((message) => message.id),
      ["user-1", "assistant-1", "tool-result-1"],
      "checkpoint-mode interrupted fork should preserve the assistant tool cluster"
    )
  } finally {
    if (targetThreadId) {
      await closeCheckpointer(targetThreadId)
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    await closeCheckpointer(sourceThreadId)
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testResolveAndForkLegacyMessageBeforeFirstMarker(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, resolveForkCheckpointForMessage } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-legacy-before-marker-source"
  const legacyCheckpointId = "fork-legacy-before-marker-old"
  const markedCheckpointId = "fork-legacy-before-marker-marked"
  const currentUnmarkedCheckpointId = "fork-legacy-before-marker-current"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Legacy before marker source",
      agentMode: "normal",
      [FORK_BOUNDARY_THREAD_METADATA_KEY]: FORK_BOUNDARY_MARKER_VERSION
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpointWithVisiblePair({
        id: legacyCheckpointId,
        ts: "2026-07-08T01:00:00.000Z",
        userId: "user-legacy",
        userText: "legacy prompt",
        assistantId: "assistant-legacy",
        assistantText: "legacy answer"
      }),
      makePlainMetadata()
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: legacyCheckpointId
        }
      },
      makeCheckpointWithVisiblePair({
        id: markedCheckpointId,
        ts: "2026-07-08T01:00:02.000Z",
        userId: "user-marked",
        userText: "marked prompt",
        assistantId: "assistant-marked",
        assistantText: "marked answer"
      }),
      makeForkBoundaryMetadata(markedCheckpointId, "assistant-marked")
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: markedCheckpointId
        }
      },
      makeCheckpointWithVisiblePair({
        id: currentUnmarkedCheckpointId,
        ts: "2026-07-08T01:00:03.000Z",
        userId: "user-current",
        userText: "current prompt",
        assistantId: "assistant-current",
        assistantText: "current answer"
      }),
      makePlainMetadata()
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const legacyResolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-legacy"
    })
    assert.equal(
      legacyResolved?.checkpointId,
      legacyCheckpointId,
      "message resolver should allow legacy checkpoints older than the first marker"
    )
    assert.equal(legacyResolved?.boundarySource, "legacy_historical_idle_fallback")

    const currentResolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-current"
    })
    assert.equal(
      currentResolved,
      null,
      "message resolver should still reject unmarked checkpoints newer than a marker"
    )

    const forked = await forkThread({
      sourceThreadId,
      checkpointId: legacyCheckpointId,
      messageId: "assistant-legacy",
      title: "Fork legacy history"
    })
    targetThreadId = forked.thread.thread_id
    assert.equal(forked.sourceCheckpointId, legacyCheckpointId)
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testUnmarkedCheckpointBetweenMarkersIsNotForkable(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, registerThreadHandlers, resolveForkCheckpointForMessage } = await import(
    "../src/main/ipc/threads.ts"
  )

  const sourceThreadId = "fork-unmarked-between-markers-source"
  const olderMarkedCheckpointId = "fork-between-markers-old"
  const unmarkedCheckpointId = "fork-between-markers-unmarked"
  const newerMarkedCheckpointId = "fork-between-markers-new"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Unmarked between markers source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 4
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpointWithVisiblePair({
        id: olderMarkedCheckpointId,
        ts: "2026-07-08T01:00:00.000Z",
        userId: "user-old-marker",
        userText: "old marked prompt",
        assistantId: "assistant-old-marker",
        assistantText: "old marked answer"
      }),
      makeForkBoundaryMetadata(olderMarkedCheckpointId, "assistant-old-marker")
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: olderMarkedCheckpointId
        }
      },
      makeCheckpointWithVisiblePair({
        id: unmarkedCheckpointId,
        ts: "2026-07-08T01:00:01.000Z",
        userId: "user-unmarked",
        userText: "unmarked prompt",
        assistantId: "assistant-unmarked",
        assistantText: "unmarked answer"
      }),
      makePlainMetadata()
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: unmarkedCheckpointId
        }
      },
      makeCheckpointWithVisiblePair({
        id: newerMarkedCheckpointId,
        ts: "2026-07-08T01:00:02.000Z",
        userId: "user-new-marker",
        userText: "new marked prompt",
        assistantId: "assistant-new-marker",
        assistantText: "new marked answer"
      }),
      makeForkBoundaryMetadata(newerMarkedCheckpointId, "assistant-new-marker")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const listForkableCheckpoints = handlers.get("threads:list-forkable-checkpoints")
    assert(listForkableCheckpoints, "listForkableCheckpoints handler should be registered")
    const listed = (await listForkableCheckpoints(null, sourceThreadId)) as Array<{
      checkpointId: string
    }>
    assert.deepEqual(
      listed.map((checkpoint) => checkpoint.checkpointId),
      [newerMarkedCheckpointId, olderMarkedCheckpointId],
      "right-click checkpoint list should not expose unmarked checkpoints between markers"
    )

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-unmarked",
      message: {
        id: "assistant-unmarked",
        role: "assistant",
        content: "unmarked answer"
      }
    })
    assert.equal(
      resolved,
      null,
      "message resolver should not expose unmarked checkpoints between markers"
    )

    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          checkpointId: unmarkedCheckpointId,
          messageId: "assistant-unmarked",
          title: "Unmarked between markers fork"
        }),
      /稳定完成边界/,
      "direct fork should reject unmarked checkpoints between stable markers"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkWaitsForQueuedRendererThreadMutations(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, registerThreadHandlers } = await import("../src/main/ipc/threads.ts")
  const { withThreadRunMutationLock } = await import("../src/main/ipc/thread-run-mutation-lock.ts")

  const sourceThreadId = "fork-waits-renderer-mut-source"
  const checkpointId = "fork-waits-renderer-mut-cp"
  let targetThreadId: string | undefined
  let releaseLock: (() => void) | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Queued mutation source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const appendMessages = handlers.get("threads:appendMessages")
    const mergeThreadValues = handlers.get("threads:mergeThreadValues")
    assert(appendMessages, "appendMessages handler should be registered")
    assert(mergeThreadValues, "mergeThreadValues handler should be registered")

    let lockAcquired!: () => void
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      lockAcquired = resolve
    })
    const releaseLockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const lockHolder = withThreadRunMutationLock(sourceThreadId, async () => {
      lockAcquired()
      await releaseLockPromise
    })
    await lockAcquiredPromise

    const appendPromise = appendMessages(null, {
      threadId: sourceThreadId,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "late renderer transcript",
          goal_id: "goal-after-done",
          created_at: new Date("2026-07-08T01:00:04.000Z")
        } as Message
      ]
    }) as Promise<{ count: number }>
    const mergePromise = mergeThreadValues(null, {
      threadId: sourceThreadId,
      patch: {
        messageTimes: {
          "assistant-1": { created_at: "2026-07-08T01:00:04.000Z" }
        },
        messageTimeOrder: ["assistant-1"]
      }
    }) as Promise<unknown>
    const forkPromise = forkThread({ sourceThreadId, title: "Queued mutation fork" })

    releaseLock?.()
    await lockHolder
    assert.equal((await appendPromise).count, 1, "queued append should run before fork")
    await mergePromise
    const forked = await forkPromise
    targetThreadId = forked.thread.thread_id

    const targetMessages = db.getThreadMessages(targetThreadId)
    const targetAssistant = targetMessages.find((message) => message.id === "assistant-1")
    assert.equal(
      targetAssistant?.goal_id,
      "goal-after-done",
      "fork should see queued renderer message metadata before copying messages"
    )

    const targetValues = JSON.parse(db.getThread(targetThreadId)?.thread_values ?? "{}") as {
      messageTimes?: Record<string, unknown>
      messageTimeOrder?: Array<{ id?: string }>
    }
    assert.equal(
      targetValues.messageTimes,
      undefined,
      "fork should not copy deprecated lifetime message-time maps"
    )
    assert.equal(
      targetValues.messageTimeOrder,
      undefined,
      "durable message rows replace the legacy message-time order"
    )
    assert.equal(
      targetAssistant?.created_at.toISOString(),
      "2026-07-08T01:00:04.000Z",
      "fork should preserve queued renderer row-level message timing"
    )
  } finally {
    releaseLock?.()
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkThreadCopiesCheckpointThreadRowAndTranscript(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-source-thread"
  const checkpointId = "fork-checkpoint-1"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Source thread",
      model: "test-model",
      memoryEnabled: true,
      agentMode: "normal"
    })
    db.updateThread(sourceThreadId, {
      thread_values: JSON.stringify({
        messageTimes: {
          "user-1": { created_at: "2026-07-08T01:00:00.000Z" },
          "assistant-1": { created_at: "2026-07-08T01:00:01.000Z" },
          hidden: { created_at: "2026-07-08T01:00:02.000Z" }
        },
        messageTimeOrder: ["user-1", "assistant-1", "hidden"]
      })
    })
    db.upsertThreadMessages(sourceThreadId, [
      {
        id: "assistant-1",
        role: "assistant",
        content: "checkpoint",
        goal_id: "goal-1",
        active_window_id: "window-1",
        created_at: new Date("2026-07-08T01:00:01.000Z")
      } as Message
    ])

    const sourceCheckpoint = makeCheckpoint(checkpointId)
    ;(sourceCheckpoint.channel_values as Record<string, unknown>)._summarizationSessionId =
      "session_source"
    ;(sourceCheckpoint.channel_values as Record<string, unknown>)._cmbSummarizationOwner =
      "source-owner"
    ;(sourceCheckpoint.channel_values as Record<string, unknown>)._summarizationEvent = {
      cutoffIndex: 1,
      filePath: "/source-thread/conversation_history/session_source.md",
      summaryMessage: {
        type: "human",
        content:
          "The full conversation history has been saved to /source-thread/conversation_history/session_source.md"
      }
    }
    ;(sourceCheckpoint.channel_versions as Record<string, number>)._summarizationSessionId = 1
    ;(sourceCheckpoint.channel_versions as Record<string, number>)._cmbSummarizationOwner = 1
    ;(sourceCheckpoint.channel_versions as Record<string, number>)._summarizationEvent = 1

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      sourceCheckpoint,
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const sourceBeforeForkVerifier = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    const sourceBeforeFork = await sourceBeforeForkVerifier.getTuple({
      configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
    })
    await sourceBeforeForkVerifier.close()
    assert.equal(
      (sourceBeforeFork?.checkpoint.channel_values as Record<string, unknown>)
        ._summarizationSessionId,
      "session_source",
      "test source checkpoint must contain the summarization state being sanitized"
    )

    const forked = await forkThread({ sourceThreadId, title: "Forked thread" })
    targetThreadId = forked.thread.thread_id

    assert.notEqual(targetThreadId, sourceThreadId, "fork should create a distinct target thread")
    assert.equal(forked.sourceThreadId, sourceThreadId, "response should identify the source")
    assert.equal(forked.sourceCheckpointId, checkpointId, "response should identify checkpoint")
    assert.equal(forked.sourceCheckpointNs, "", "fork should stay in the root checkpoint namespace")

    const targetRow = db.getThread(targetThreadId)
    assert(targetRow, "target thread row should exist")
    assert.equal(
      forked.thread.updated_at.toISOString(),
      new Date(targetRow!.updated_at).toISOString(),
      "response thread should match the final target row timestamp"
    )

    const targetSaver = new SqlJsSaver(getThreadCheckpointPath(targetThreadId))
    const targetTuple = await targetSaver.getTuple({
      configurable: { thread_id: targetThreadId, checkpoint_ns: "" }
    })
    await targetSaver.close()
    assert.equal(targetTuple?.checkpoint.id, checkpointId, "target checkpoint should be persisted")
    const targetChannelValues = targetTuple?.checkpoint.channel_values as
      | Record<string, unknown>
      | undefined
    assert.equal(
      targetChannelValues?._summarizationEvent,
      undefined,
      "fork must not retain a summary event that references the source thread history"
    )
    assert.equal(
      targetChannelValues?._summarizationSessionId,
      undefined,
      "fork must create its own summarization session"
    )
    assert.equal(
      targetChannelValues?._cmbSummarizationOwner,
      undefined,
      "fork must not retain source-private summarization ownership"
    )
    assert.equal(
      Array.isArray(targetChannelValues?.messages),
      true,
      "fork must retain the raw messages needed for independent recompaction"
    )

    const sourceVerifier = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    const sourceTuple = await sourceVerifier.getTuple({
      configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
    })
    await sourceVerifier.close()
    assert.equal(
      (sourceTuple?.checkpoint.channel_values as Record<string, unknown>)._summarizationSessionId,
      "session_source",
      "fork sanitization must not mutate the source checkpoint"
    )

    const targetMessages = db.getThreadMessages(targetThreadId)
    assert.deepEqual(
      targetMessages.map((message) => message.id),
      ["user-1", "assistant-1"],
      "fork should copy the visible transcript up to the checkpoint boundary"
    )
    assert.equal(
      targetMessages[1].content,
      "checkpoint final answer",
      "checkpoint content should remain authoritative over stale DB transcript"
    )
    assert.equal(targetMessages[1].goal_id, "goal-1", "DB-only transcript metadata should survive")
    assert.equal(
      targetMessages[1].active_window_id,
      "window-1",
      "active window transcript metadata should survive"
    )
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkCopiesOnlyReferencedLargeToolResults(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  const { getProjectThreadDataDirectory } =
    await import("../src/main/agent/context-history-path.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-large-result-source"
  const checkpointId = "fork-large-result-checkpoint"
  const workspace = await mkdtemp(join(tmpdir(), "cmb-fork-large-result-workspace-"))
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      workspacePath: workspace,
      title: "Large result source",
      [FORK_BOUNDARY_THREAD_METADATA_KEY]: FORK_BOUNDARY_MARKER_VERSION
    })

    const historicalCheckpointId = "fork-large-result-historical-checkpoint"
    const historicalCheckpoint = makeCheckpoint(
      historicalCheckpointId,
      "2026-07-08T01:00:00.000Z"
    )
    ;(historicalCheckpoint.channel_values as Record<string, unknown>).messages = [
      { id: "user-old", type: "human", content: "inspect the older large result" },
      {
        id: "assistant-old-tool-call",
        type: "ai",
        content: "I will inspect the older result.",
        tool_calls: [{ id: "call-old", name: "inspect", args: { target: "older" } }]
      },
      {
        id: "tool-result-old",
        type: "tool",
        tool_call_id: "call-old",
        name: "inspect",
        content:
          "Tool result too large, the result of this tool call call-old was saved in the filesystem at this path: /large_tool_results/call-old\nRead it in chunks."
      },
      { id: "assistant-old-final", type: "ai", content: "The older inspection is complete." }
    ]

    const checkpoint = makeCheckpoint(checkpointId, "2026-07-08T01:00:02.000Z")
    ;(checkpoint.channel_values as Record<string, unknown>).messages = [
      { id: "user-1", type: "human", content: "inspect the large result" },
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "I will inspect it.",
        tool_calls: [{ id: "call-fork", name: "inspect", args: { target: "large" } }]
      },
      {
        id: "tool-result",
        type: "tool",
        tool_call_id: "call-fork",
        name: "inspect",
        content:
          "Tool result too large, the result of this tool call call-fork was saved in the filesystem at this path: /large_tool_results/call-fork\nRead it in chunks."
      },
      { id: "assistant-final", type: "ai", content: "The inspection is complete." }
    ]

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      historicalCheckpoint,
      makeForkBoundaryMetadata(historicalCheckpointId, "assistant-old-final")
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: historicalCheckpointId
        }
      },
      checkpoint,
      makeForkBoundaryMetadata(checkpointId, "assistant-final")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const sourceVerifier = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    const sourceTuple = await sourceVerifier.getTuple({
      configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
    })
    await sourceVerifier.close()
    assert.equal(sourceTuple?.checkpoint.id, checkpointId)
    assert.equal(
      ((sourceTuple?.checkpoint.channel_values as { messages?: unknown[] }).messages ?? []).length,
      4,
      "native checkpoint reopen must hydrate the external tool-result transcript"
    )

    const sourceDataDirectory = await getProjectThreadDataDirectory(workspace, sourceThreadId)
    const sourceLargeResultsDirectory = join(sourceDataDirectory, "large_tool_results")
    const sourceLegacyLargeResultsDirectory = join(
      workspace,
      ".cmbdevclaw",
      "large_tool_results"
    )
    await mkdir(sourceLargeResultsDirectory, { recursive: true })
    await mkdir(sourceLegacyLargeResultsDirectory, { recursive: true })
    await writeFile(join(sourceLargeResultsDirectory, "call-fork"), "complete fork evidence")
    await writeFile(
      join(sourceLegacyLargeResultsDirectory, "call-old"),
      "historical legacy fork evidence"
    )
    await writeFile(join(sourceLargeResultsDirectory, "not-referenced"), "must not be copied")

    const forked = await forkThread({ sourceThreadId, title: "Large result fork" })
    targetThreadId = forked.thread.thread_id
    const targetDataDirectory = await getProjectThreadDataDirectory(workspace, targetThreadId)
    const copiedResultPath = join(targetDataDirectory, "large_tool_results", "call-fork")
    const copiedHistoricalResultPath = join(targetDataDirectory, "large_tool_results", "call-old")
    const unreferencedResultPath = join(targetDataDirectory, "large_tool_results", "not-referenced")

    assert.equal(
      await readFile(copiedResultPath, "utf8"),
      "complete fork evidence",
      "fork must copy the complete result referenced by its checkpoint"
    )
    assert.equal(
      await readFile(copiedHistoricalResultPath, "utf8"),
      "historical legacy fork evidence",
      "fork must copy legacy results referenced only by an older retained checkpoint"
    )
    await assert.rejects(
      access(unreferencedResultPath),
      "fork must not copy large results outside the retained checkpoint history"
    )

    await rm(sourceDataDirectory, { recursive: true, force: true })
    await rm(sourceLegacyLargeResultsDirectory, { recursive: true, force: true })
    assert.equal(
      await readFile(copiedResultPath, "utf8"),
      "complete fork evidence",
      "forked large results must remain readable after the source data is removed"
    )
    assert.equal(
      await readFile(copiedHistoricalResultPath, "utf8"),
      "historical legacy fork evidence",
      "historical legacy fork results must remain readable after the source data is removed"
    )
  } finally {
    if (targetThreadId) {
      await closeCheckpointer(targetThreadId)
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    await closeCheckpointer(sourceThreadId)
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await rm(workspace, { recursive: true, force: true })
    await db.closeDatabase()
  }
}

async function testForkThreadCopiesHistoricalForkableCheckpoints(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  const { forkThread, registerThreadHandlers, resolveForkCheckpointForMessage } = await import(
    "../src/main/ipc/threads.ts"
  )

  const sourceThreadId = "fork-history-source"
  const olderCheckpointId = "fork-history-old"
  const unstableMiddleCheckpointId = "fork-history-unstable-middle"
  const newerCheckpointId = "fork-history-new"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "History source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 4
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpointWithVisiblePair({
        id: olderCheckpointId,
        ts: "2026-07-08T01:00:00.000Z",
        userId: "user-old",
        userText: "old prompt",
        assistantId: "assistant-old",
        assistantText: "old answer"
      }),
      makeForkBoundaryMetadata(olderCheckpointId, "assistant-old")
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: olderCheckpointId
        }
      },
      makeCheckpointWithVisibleMessages(
        unstableMiddleCheckpointId,
        "2026-07-08T01:00:01.000Z",
        [
          { id: "user-old", type: "human", content: "old prompt" },
          { id: "assistant-old", type: "ai", content: "old answer" },
          { id: "user-middle", type: "human", content: "middle prompt" },
          { id: "assistant-middle", type: "ai", content: "middle answer" }
        ]
      ),
      makePlainMetadata()
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: unstableMiddleCheckpointId
        }
      },
      makeCheckpointWithVisibleMessages(newerCheckpointId, "2026-07-08T01:00:02.000Z", [
        { id: "user-old", type: "human", content: "old prompt" },
        { id: "assistant-old", type: "ai", content: "old answer" },
        { id: "user-middle", type: "human", content: "middle prompt" },
        { id: "assistant-middle", type: "ai", content: "middle answer" },
        { id: "user-new", type: "human", content: "new prompt" },
        { id: "assistant-new", type: "ai", content: "new answer" }
      ]),
      makeForkBoundaryMetadata(newerCheckpointId, "assistant-new")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const forked = await forkThread({ sourceThreadId, title: "History fork" })
    targetThreadId = forked.thread.thread_id

    const targetSaver = new SqlJsSaver(getThreadCheckpointPath(targetThreadId))
    const targetCheckpoints: Array<{ id: string; parentId?: string }> = []
    for await (const tuple of targetSaver.list({
      configurable: { thread_id: targetThreadId, checkpoint_ns: "" }
    })) {
      targetCheckpoints.push({
        id: tuple.checkpoint.id,
        parentId: tuple.parentConfig?.configurable?.checkpoint_id
      })
    }
    await targetSaver.close()
    assert.deepEqual(
      targetCheckpoints.map((checkpoint) => checkpoint.id),
      [newerCheckpointId, olderCheckpointId],
      "fork target should retain only stable historical root checkpoints up to the selected checkpoint"
    )
    const targetCheckpointIds = new Set(targetCheckpoints.map((checkpoint) => checkpoint.id))
    assert.equal(
      targetCheckpoints.every(
        (checkpoint) => !checkpoint.parentId || targetCheckpointIds.has(checkpoint.parentId)
      ),
      true,
      "copied checkpoint history must not contain dangling parent references"
    )

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const listForkableCheckpoints = handlers.get("threads:list-forkable-checkpoints")
    assert(listForkableCheckpoints, "listForkableCheckpoints handler should be registered")
    const listed = (await listForkableCheckpoints(null, targetThreadId)) as Array<{
      checkpointId: string
    }>
    assert.deepEqual(
      listed.map((checkpoint) => checkpoint.checkpointId),
      [newerCheckpointId, olderCheckpointId],
      "forked thread right-click checkpoint list should keep previous checkpoints"
    )

    const resolvedOld = await resolveForkCheckpointForMessage({
      threadId: targetThreadId,
      messageId: "assistant-old",
      message: {
        id: "assistant-old",
        role: "assistant",
        content: "old answer"
      }
    })
    assert.equal(
      resolvedOld?.checkpointId,
      olderCheckpointId,
      "message fork in a forked thread should resolve historical assistant checkpoints"
    )

    const resolvedUnstableMiddle = await resolveForkCheckpointForMessage({
      threadId: targetThreadId,
      messageId: "assistant-middle",
      message: {
        id: "assistant-middle",
        role: "assistant",
        content: "middle answer"
      }
    })
    assert.equal(
      resolvedUnstableMiddle,
      null,
      "message fork in a forked thread should not resurrect copied unstable checkpoints"
    )
  } finally {
    if (targetThreadId) {
      await closeCheckpointer(targetThreadId)
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    await closeCheckpointer(sourceThreadId)
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkedBranchesRemainIndependentWhenForkedAgain(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-branch-source"
  const rootCheckpointId = "fork-branch-root"
  const sourceCheckpointId = "fork-branch-source-latest"
  const branchCheckpointId = "fork-branch-child-latest"
  let branchThreadId: string | undefined
  let sourceForkThreadId: string | undefined
  let branchForkThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Fork branch source",
      agentMode: "normal"
    })
    db.upsertThreadMessages(sourceThreadId, [
      {
        id: "user-root",
        role: "user",
        content: "root prompt",
        created_at: new Date("2026-07-08T01:00:00.000Z")
      },
      {
        id: "assistant-root",
        role: "assistant",
        content: "root answer",
        created_at: new Date("2026-07-08T01:00:01.000Z")
      }
    ])

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpointWithVisibleMessages(rootCheckpointId, "2026-07-08T01:00:01.000Z", [
        { id: "user-root", type: "human", content: "root prompt" },
        { id: "assistant-root", type: "ai", content: "root answer" }
      ]),
      makeForkBoundaryMetadata(rootCheckpointId, "assistant-root")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const branch = await forkThread({ sourceThreadId, title: "Fork branch child" })
    branchThreadId = branch.thread.thread_id

    db.upsertThreadMessages(sourceThreadId, [
      {
        id: "user-source-only",
        role: "user",
        content: "source branch prompt",
        created_at: new Date("2026-07-08T01:01:00.000Z")
      },
      {
        id: "assistant-source-only",
        role: "assistant",
        content: "source branch answer",
        created_at: new Date("2026-07-08T01:01:01.000Z")
      }
    ])
    const continuedSourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await continuedSourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: rootCheckpointId
        }
      },
      makeCheckpointWithVisibleMessages(sourceCheckpointId, "2026-07-08T01:01:01.000Z", [
        { id: "user-root", type: "human", content: "root prompt" },
        { id: "assistant-root", type: "ai", content: "root answer" },
        { id: "user-source-only", type: "human", content: "source branch prompt" },
        { id: "assistant-source-only", type: "ai", content: "source branch answer" }
      ]),
      makeForkBoundaryMetadata(sourceCheckpointId, "assistant-source-only")
    )
    await continuedSourceSaver.flushStrict()
    await continuedSourceSaver.close()

    db.upsertThreadMessages(branchThreadId, [
      {
        id: "user-child-only",
        role: "user",
        content: "child branch prompt",
        created_at: new Date("2026-07-08T01:02:00.000Z")
      },
      {
        id: "assistant-child-only",
        role: "assistant",
        content: "child branch answer",
        created_at: new Date("2026-07-08T01:02:01.000Z")
      }
    ])
    const branchSaver = new SqlJsSaver(getThreadCheckpointPath(branchThreadId))
    await branchSaver.put(
      {
        configurable: {
          thread_id: branchThreadId,
          checkpoint_ns: "",
          checkpoint_id: rootCheckpointId
        }
      },
      makeCheckpointWithVisibleMessages(branchCheckpointId, "2026-07-08T01:02:01.000Z", [
        { id: "user-root", type: "human", content: "root prompt" },
        { id: "assistant-root", type: "ai", content: "root answer" },
        { id: "user-child-only", type: "human", content: "child branch prompt" },
        { id: "assistant-child-only", type: "ai", content: "child branch answer" }
      ]),
      makeForkBoundaryMetadata(branchCheckpointId, "assistant-child-only")
    )
    await branchSaver.flushStrict()
    await branchSaver.close()

    const sourceFork = await forkThread({ sourceThreadId, title: "Fork source branch again" })
    sourceForkThreadId = sourceFork.thread.thread_id
    const branchFork = await forkThread({
      sourceThreadId: branchThreadId,
      title: "Fork child branch again"
    })
    branchForkThreadId = branchFork.thread.thread_id

    assert.equal(
      sourceFork.thread.metadata?.forkedFromThreadId,
      sourceThreadId,
      "source branch fork metadata must point to the source branch"
    )
    assert.equal(
      branchFork.thread.metadata?.forkedFromThreadId,
      branchThreadId,
      "child branch fork metadata must point to the child branch"
    )
    assert.deepEqual(
      db.getThreadMessages(sourceForkThreadId).map((message) => message.id),
      ["user-root", "assistant-root", "user-source-only", "assistant-source-only"],
      "forking the source branch must not include child branch messages"
    )
    assert.deepEqual(
      db.getThreadMessages(branchForkThreadId).map((message) => message.id),
      ["user-root", "assistant-root", "user-child-only", "assistant-child-only"],
      "forking the child branch must not include source branch messages"
    )
  } finally {
    for (const threadId of [branchForkThreadId, sourceForkThreadId, branchThreadId, sourceThreadId]) {
      if (!threadId) continue
      await closeCheckpointer(threadId)
      db.deleteThread(threadId)
      await closeAndDeleteThreadCheckpoint(threadId, deleteThreadCheckpoint)
    }
    await db.closeDatabase()
  }
}

async function testInterruptedDurableTailForkIsConsistentAndComplete(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { getDurableRuntimeTail } = await import("../src/main/ipc/thread-runtime-tail.ts")
  const { forkThread, registerThreadHandlers, resolveForkCheckpointForMessage } = await import(
    "../src/main/ipc/threads.ts"
  )

  const sourceThreadId = "fork-durable-tail-source"
  const checkpointId = "fork-durable-tail-cp"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Durable tail source",
      agentMode: "normal"
    })
    db.upsertThreadMessages(sourceThreadId, [
      {
        id: "user-1",
        role: "user",
        content: "fork source prompt",
        created_at: new Date("2026-07-08T01:00:00.000Z")
      },
      {
        id: "assistant-tail",
        provider_source_id: "reused-tail-provider",
        provider_occurrence: 2,
        role: "assistant",
        content: "I will inspect the durable tail.",
        tool_calls: [{ id: "tail-tool-1", name: "inspect", args: { target: "tail" } }],
        created_at: new Date("2026-07-08T01:00:01.000Z")
      },
      {
        id: "tool-tail",
        role: "tool",
        content: "partial output persisted before interruption",
        tool_call_id: "tail-tool-1",
        name: "inspect",
        created_at: new Date("2026-07-08T01:00:02.000Z")
      }
    ])

    const checkpoint = makeCheckpointWithVisibleMessages(
      checkpointId,
      "2026-07-08T01:00:00.000Z",
      [{ id: "user-1", type: "human", content: "fork source prompt" }]
    )
    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      checkpoint,
      makeInterruptedForkBoundaryMetadata(checkpointId, "user-1")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const listForkableCheckpoints = handlers.get("threads:list-forkable-checkpoints")
    assert(listForkableCheckpoints, "listForkableCheckpoints handler should be registered")
    const listed = (await listForkableCheckpoints(null, sourceThreadId)) as Array<{
      checkpointId: string
      messageCount: number
      messageForkMode?: string
    }>
    assert.deepEqual(
      listed.map((entry) => entry.checkpointId),
      [checkpointId],
      "right-click fork should expose the materialized interrupted checkpoint"
    )
    assert.equal(listed[0]?.messageCount, 3, "right-click summary should include the durable tail")
    assert.equal(listed[0]?.messageForkMode, "checkpoint")

    const resolved = await resolveForkCheckpointForMessage({
      threadId: sourceThreadId,
      messageId: "assistant-tail",
      message: {
        id: "assistant-tail",
        role: "assistant",
        content: "I will inspect the durable tail.",
        tool_calls: [{ id: "tail-tool-1", name: "inspect", args: { target: "tail" } }]
      }
    })
    assert.equal(
      resolved?.checkpointId,
      checkpointId,
      "message fork and right-click fork should resolve the same checkpoint"
    )
    assert.equal(resolved?.messageForkMode, "checkpoint")

    const forked = await forkThread({
      sourceThreadId,
      checkpointId,
      title: "Fork complete interrupted tail"
    })
    targetThreadId = forked.thread.thread_id
    assert.deepEqual(
      db.getThreadMessages(targetThreadId).map((message) => message.id),
      ["user-1", "assistant-tail", "tool-tail"],
      "right-click checkpoint fork must not drop durable tail messages"
    )

    const targetSaver = new SqlJsSaver(getThreadCheckpointPath(targetThreadId))
    const targetTuple = await targetSaver.getTuple({
      configurable: { thread_id: targetThreadId, checkpoint_ns: "" }
    })
    await targetSaver.close()
    const targetMessages = (
      targetTuple?.checkpoint.channel_values as
        | {
            messages?: Array<{
              id?: string
              additional_kwargs?: Record<string, unknown>
            }>
          }
        | undefined
    )?.messages
    assert.deepEqual(
      targetMessages?.map((message) => message.id),
      ["user-1", "assistant-tail", "tool-tail"],
      "fork runtime checkpoint must contain the complete transcript"
    )
    const targetAssistantTail = targetMessages?.find(
      (message) => message.id === "assistant-tail"
    )
    assert.equal(
      targetAssistantTail?.additional_kwargs?.[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY],
      "reused-tail-provider",
      "fork runtime checkpoint must preserve durable-tail provider source identity"
    )
    assert.equal(
      targetAssistantTail?.additional_kwargs?.[MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY],
      2,
      "fork runtime checkpoint must preserve durable-tail provider occurrence"
    )
    const targetRuntimeTail = await getDurableRuntimeTail(targetThreadId)
    assert.equal(
      targetRuntimeTail.persistedMessages.length,
      0,
      "materialized fork messages must not be replayed a second time as runtime tail"
    )
    const targetListed = (await listForkableCheckpoints(null, targetThreadId)) as Array<{
      checkpointId: string
      messageCount: number
    }>
    assert.deepEqual(
      targetListed.map((entry) => [entry.checkpointId, entry.messageCount]),
      [[checkpointId, 3]],
      "a forked thread should preserve the materialized boundary for subsequent forks"
    )
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testUnsafeLatestDurableTailDoesNotHideHistoricalForks(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread, registerThreadHandlers } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-unsafe-tail-source"
  const olderCheckpointId = "fork-unsafe-tail-old"
  const latestCheckpointId = "fork-unsafe-tail-latest"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Unsafe durable tail source",
      agentMode: "normal"
    })
    db.upsertThreadMessages(sourceThreadId, [
      {
        id: "user-old",
        role: "user",
        content: "old prompt",
        created_at: new Date("2026-07-08T01:00:00.000Z")
      },
      {
        id: "assistant-old",
        role: "assistant",
        content: "old answer",
        created_at: new Date("2026-07-08T01:00:01.000Z")
      },
      {
        id: "user-new",
        role: "user",
        content: "new prompt",
        created_at: new Date("2026-07-08T01:01:00.000Z")
      },
      {
        id: "assistant-new",
        role: "assistant",
        content: "new answer",
        created_at: new Date("2026-07-08T01:01:01.000Z")
      },
      {
        id: "unsafe-tool-tail",
        role: "tool",
        content: "tool result without tool_call_id",
        created_at: new Date("2026-07-08T01:01:02.000Z")
      }
    ])

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpointWithVisiblePair({
        id: olderCheckpointId,
        ts: "2026-07-08T01:00:00.000Z",
        userId: "user-old",
        userText: "old prompt",
        assistantId: "assistant-old",
        assistantText: "old answer"
      }),
      makeForkBoundaryMetadata(olderCheckpointId, "assistant-old")
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: olderCheckpointId
        }
      },
      makeCheckpointWithVisibleMessages(latestCheckpointId, "2026-07-08T01:01:01.000Z", [
        { id: "user-old", type: "human", content: "old prompt" },
        { id: "assistant-old", type: "ai", content: "old answer" },
        { id: "user-new", type: "human", content: "new prompt" },
        { id: "assistant-new", type: "ai", content: "new answer" }
      ]),
      makeInterruptedForkBoundaryMetadata(latestCheckpointId, "assistant-new")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const handlers = registerTestThreadHandlers(registerThreadHandlers)
    const listForkableCheckpoints = handlers.get("threads:list-forkable-checkpoints")
    assert(listForkableCheckpoints, "listForkableCheckpoints handler should be registered")
    const listed = (await listForkableCheckpoints(null, sourceThreadId)) as Array<{
      checkpointId: string
    }>
    assert.deepEqual(
      listed.map((entry) => entry.checkpointId),
      [olderCheckpointId],
      "an unsafe latest tail should not hide older stable checkpoints"
    )
    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          checkpointId: latestCheckpointId,
          title: "Unsafe latest should reject"
        }),
      /无法安全恢复/,
      "direct API calls must not silently fork an unsafe latest durable tail"
    )

    const forkedOlder = await forkThread({
      sourceThreadId,
      checkpointId: olderCheckpointId,
      title: "Fork older despite unsafe latest"
    })
    targetThreadId = forkedOlder.thread.thread_id
    assert.deepEqual(
      db.getThreadMessages(targetThreadId).map((message) => message.id),
      ["user-old", "assistant-old"],
      "forking a listed historical checkpoint must not be blocked by an unsafe latest tail"
    )
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkLatestAllowsUserInterruptedPendingWritesBoundary(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-interrupted-pending-writes-source"
  const checkpointId = "fork-interrupted-pending-writes-cp"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Interrupted pending writes source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    const savedConfig = await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeInterruptedForkBoundaryMetadata(checkpointId)
    )
    const abandonedWrites: PendingWrite[] = [["messages", { abandonedToolResult: true }]]
    await sourceSaver.putWrites(savedConfig, abandonedWrites, "tools-task-1")
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const forked = await forkThread({
      sourceThreadId,
      title: "Fork interrupted pending writes"
    })
    targetThreadId = forked.thread.thread_id
    assert.equal(
      forked.sourceCheckpointId,
      checkpointId,
      "latest fork should accept a user-interrupted boundary with abandoned pending writes"
    )

    const targetSaver = new SqlJsSaver(getThreadCheckpointPath(targetThreadId))
    const targetTuple = await targetSaver.getTuple({
      configurable: { thread_id: targetThreadId, checkpoint_ns: "" }
    })
    await targetSaver.close()
    assert.equal(
      targetTuple?.pendingWrites?.length ?? 0,
      0,
      "fork target must not copy abandoned source pending writes"
    )
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkLatestRejectsUnmarkedCheckpointAfterMarkerEra(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-unmarked-marker-era-source"
  const markedCheckpointId = "fork-marker-era-marked"
  const unmarkedCheckpointId = "fork-marker-era-unmarked"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Marker era source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 3
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(markedCheckpointId, "2026-07-08T01:00:00.000Z"),
      makeForkBoundaryMetadata(markedCheckpointId)
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: markedCheckpointId
        }
      },
      makeCheckpoint(unmarkedCheckpointId, "2026-07-08T01:00:03.000Z"),
      makePlainMetadata()
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    await assert.rejects(
      () => forkThread({ sourceThreadId, title: "Unmarked latest should fail" }),
      /稳定完成边界/,
      "latest fork should not use legacy fallback after marker-era checkpoints exist"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkLatestRejectsThreadMarkerEraWithoutCheckpointMarker(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-thread-marker-era-source"
  const checkpointId = "fork-thread-marker-era-cp"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Thread marker era source",
      agentMode: "normal",
      [FORK_BOUNDARY_THREAD_METADATA_KEY]: FORK_BOUNDARY_MARKER_VERSION
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makePlainMetadata()
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    await assert.rejects(
      () => forkThread({ sourceThreadId, title: "Thread marker era should fail" }),
      /稳定完成边界/,
      "current-version threads should not use legacy fallback when checkpoint marker is absent"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkOverrideValidationRejectsInconsistentTargetMetadata(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-override-validation-source"
  const checkpointId = "fork-override-validation-cp"

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Override validation source",
      agentMode: "normal"
    })

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          overrides: { agentMode: "workflow" }
        }),
      /workflow\/coordinator 模式必须提供有效工作区/,
      "workflow fork overrides must include a usable workspace"
    )
    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          overrides: { workspacePath: "   " } as unknown as NonNullable<
            Parameters<typeof forkThread>[0]["overrides"]
          >
        }),
      /workspacePath override/,
      "workspacePath override must be a non-empty string or null"
    )
    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          overrides: { agentMode: "invalid-mode" } as unknown as NonNullable<
            Parameters<typeof forkThread>[0]["overrides"]
          >
        }),
      /agentMode override 无效/,
      "agentMode override must be one of the supported modes"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testForkCopiesGoalStateAndEvents(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { createNewGoal, SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-goal-source"
  const checkpointId = "fork-goal-cp"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Goal source",
      agentMode: "normal"
    })
    const goal = createNewGoal({
      threadId: sourceThreadId,
      text: "完成 fork goal 状态复制",
      maxTurns: 4,
      now: new Date("2026-07-08T01:00:00.000Z").getTime()
    })
    const goalStore = new SqlGoalStore()
    goalStore.upsert({
      ...goal,
      turnsUsed: 1,
      ledger: {
        progress: ["fork started"],
        evidence: ["goal state exists"],
        blockers: []
      }
    })
    db.addThreadGoalEvent(
      sourceThreadId,
      "[Goal user message] /goal 完成 fork goal 状态复制",
      goal.goalId,
      new Date("2026-07-08T01:00:00.000Z").getTime(),
      goal.activeWindowId
    )

    const checkpoint = makeCheckpoint(checkpointId)
    ;(checkpoint.channel_values as Record<string, unknown>).messages = [
      {
        id: "goal-internal",
        type: "human",
        content:
          "[Starting active goal]\n<untrusted_objective>完成 fork goal 状态复制</untrusted_objective>\n<completion_condition>目标状态复制完成</completion_condition>"
      },
      { id: "user-1", type: "human", content: "fork source prompt" },
      { id: "assistant-1", type: "ai", content: "checkpoint final answer" }
    ]

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      checkpoint,
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const forked = await forkThread({ sourceThreadId, title: "Goal fork" })
    targetThreadId = forked.thread.thread_id

    const targetGoal = goalStore.get(targetThreadId)
    assert(targetGoal, "fork target should receive goal state")
    assert.equal(targetGoal!.goalId, goal.goalId, "goal id should be preserved for dedupe")
    assert.equal(targetGoal!.threadId, targetThreadId, "goal should belong to target thread")
    assert.equal(targetGoal!.turnsUsed, 1, "goal progress state should be copied")

    const targetEvents = db.getThreadGoalEvents(targetThreadId)
    assert.equal(targetEvents.length, 1, "goal events should be copied to target thread")
    assert.equal(targetEvents[0].goal_id, goal.goalId, "goal event goal id should be preserved")
    assert.equal(
      targetEvents[0].active_window_id,
      goal.activeWindowId,
      "goal event active window id should be preserved"
    )
  } finally {
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testHistoricalForkDoesNotCopyFutureGoalStateAndEvents(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { createNewGoal, SqlGoalStore } = await import("../src/main/agent/goals/goal-store.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { closeCheckpointer } = await import("../src/main/agent/runtime.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-goal-history-source"
  const olderCheckpointId = "fork-goal-history-old"
  const newerCheckpointId = "fork-goal-history-new"
  let targetThreadId: string | undefined

  await db.initializeDatabase()
  try {
    db.createThread(sourceThreadId, {
      title: "Historical goal fork source",
      agentMode: "normal"
    })
    const goalStore = new SqlGoalStore()
    const goal = createNewGoal({
      threadId: sourceThreadId,
      text: "历史 fork 不带入未来 goal 状态",
      maxTurns: 6,
      now: new Date("2026-07-08T01:00:00.000Z").getTime()
    })
    goalStore.upsert({
      ...goal,
      turnsUsed: 3,
      ledger: {
        progress: ["old progress", "future progress"],
        evidence: ["future evidence"],
        blockers: []
      },
      updatedAt: new Date("2026-07-08T01:05:00.000Z").getTime()
    })
    db.addThreadGoalEvent(
      sourceThreadId,
      "[Goal user message] /goal 历史 fork 不带入未来 goal 状态",
      goal.goalId,
      new Date("2026-07-08T01:00:00.000Z").getTime(),
      goal.activeWindowId
    )
    db.addThreadGoalEvent(
      sourceThreadId,
      "未来 checkpoint 之后的 goal 进展",
      goal.goalId,
      new Date("2026-07-08T01:06:00.000Z").getTime(),
      goal.activeWindowId
    )

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId), undefined, {
      maxRootCheckpoints: 2
    })
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpointWithVisiblePair({
        id: olderCheckpointId,
        ts: "2026-07-08T01:02:00.000Z",
        userId: "user-old-goal",
        userText: "old goal prompt",
        assistantId: "assistant-old-goal",
        assistantText: "old goal answer"
      }),
      makeForkBoundaryMetadata(olderCheckpointId, "assistant-old-goal")
    )
    await sourceSaver.put(
      {
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          checkpoint_id: olderCheckpointId
        }
      },
      makeCheckpointWithVisibleMessages(newerCheckpointId, "2026-07-08T01:07:00.000Z", [
        { id: "user-old-goal", type: "human", content: "old goal prompt" },
        { id: "assistant-old-goal", type: "ai", content: "old goal answer" },
        { id: "user-new-goal", type: "human", content: "new goal prompt" },
        { id: "assistant-new-goal", type: "ai", content: "new goal answer" }
      ]),
      makeForkBoundaryMetadata(newerCheckpointId, "assistant-new-goal")
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    const forked = await forkThread({
      sourceThreadId,
      checkpointId: olderCheckpointId,
      title: "Historical goal fork"
    })
    targetThreadId = forked.thread.thread_id

    assert.equal(
      goalStore.get(targetThreadId),
      null,
      "historical fork must not copy a goal state updated after the selected checkpoint"
    )
    const targetEvents = db.getThreadGoalEvents(targetThreadId)
    assert.deepEqual(
      targetEvents.map((event) => event.message),
      ["[Goal user message] /goal 历史 fork 不带入未来 goal 状态"],
      "historical fork should copy only goal events at or before the selected checkpoint"
    )
  } finally {
    if (targetThreadId) {
      await closeCheckpointer(targetThreadId)
      db.deleteThread(targetThreadId)
      await closeAndDeleteThreadCheckpoint(targetThreadId, deleteThreadCheckpoint)
    }
    await closeCheckpointer(sourceThreadId)
    db.deleteThread(sourceThreadId)
    await closeAndDeleteThreadCheckpoint(sourceThreadId, deleteThreadCheckpoint)
    await db.closeDatabase()
  }
}

async function testSessionTranscriptMergeKeepsDurableTailBeyondCheckpoint(): Promise<void> {
  const { mergeCheckpointAndPersistedThreadMessagesForSession } = await import(
    "../src/main/ipc/threads.ts"
  )

  const merged = mergeCheckpointAndPersistedThreadMessagesForSession(makeCheckpoint("cp-old"), [
    {
      id: "assistant-1",
      role: "assistant",
      content: "checkpoint",
      goal_id: "goal-1",
      created_at: new Date("2026-07-08T01:00:01.500Z")
    },
    {
      id: "user-2",
      role: "user",
      content: "question after old checkpoint",
      created_at: new Date("2026-07-08T01:02:00.000Z")
    },
    {
      id: "assistant-2",
      role: "assistant",
      content: "answer after old checkpoint",
      created_at: new Date("2026-07-08T01:02:01.000Z")
    }
  ] as Message[])

  assert.deepEqual(
    merged.map((message) => message.id),
    ["user-1", "assistant-1", "user-2", "assistant-2"],
    "session transcript merge must keep durable messages beyond the checkpoint"
  )
  assert.equal(
    merged[1].content,
    "checkpoint final answer",
    "checkpoint content should remain authoritative for overlapping messages"
  )
  assert.equal(merged[1].goal_id, "goal-1", "durable metadata should enrich checkpoint messages")
}

async function testSessionTranscriptMergeExcludesHiddenCoordinatorIdCollision(): Promise<void> {
  const { mergeCheckpointAndPersistedThreadMessagesForSession } = await import(
    "../src/main/ipc/threads.ts"
  )
  const sharedId = "hidden-coordinator-shared-id"
  const checkpoint = makeCheckpoint("cp-hidden-coordinator-collision")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    {
      id: sharedId,
      type: "human",
      content: "hidden coordinator state",
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    },
    { id: sharedId, type: "ai", content: "visible assistant answer" }
  ]

  const merged = mergeCheckpointAndPersistedThreadMessagesForSession(checkpoint, [])

  assert.deepEqual(
    merged.map((message) => [message.role, message.content]),
    [["assistant", "visible assistant answer"]],
    "session export must filter checkpoint records by their exact raw occurrence"
  )
}

async function testSessionTranscriptMergeRestoresCurrentRunProviderOccurrence(): Promise<void> {
  const { mergeCheckpointAndPersistedThreadMessagesForSession } = await import(
    "../src/main/ipc/threads.ts"
  )
  const providerId = "session-reused-provider"
  const stableId = "current-run-assistant:session-stable"
  const guidedId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)
  const checkpoint = makeCheckpoint("cp-current-run-provider-occurrence")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "session-user-1", type: "human", content: "first" },
    { id: providerId, type: "ai", content: "old answer" },
    { id: "session-user-2", type: "human", content: "second" },
    {
      id: stableId,
      type: "ai",
      content: "first final",
      additional_kwargs: {
        cmb_internal_provider_source_id: providerId,
        cmb_internal_provider_occurrence: 2
      }
    },
    { id: "session-user-3", type: "human", content: "guide" },
    { id: providerId, type: "ai", content: "guided answer" }
  ]
  const persisted = [
    { id: "session-user-1", role: "user", content: "first" },
    { id: providerId, role: "assistant", content: "old answer" },
    { id: "session-user-2", role: "user", content: "second" },
    {
      id: stableId,
      provider_source_id: providerId,
      provider_occurrence: 2,
      role: "assistant",
      content: "first final"
    },
    { id: "session-user-3", role: "user", content: "guide" },
    {
      id: guidedId,
      provider_source_id: providerId,
      provider_occurrence: 3,
      role: "assistant",
      content: "guided answer"
    }
  ].map((message, index) => ({
    ...message,
    created_at: new Date(`2026-07-22T02:00:0${index}.000Z`)
  })) as Message[]

  const merged = mergeCheckpointAndPersistedThreadMessagesForSession(checkpoint, persisted)

  assert.equal(merged.length, 6, "session hydrate must not duplicate the guided provider reply")
  assert.deepEqual(
    merged.map((message) => [message.id, message.provider_occurrence ?? 1]),
    [
      ["session-user-1", 1],
      [providerId, 1],
      ["session-user-2", 1],
      [stableId, 2],
      ["session-user-3", 1],
      [guidedId, 3]
    ],
    "checkpoint and DB transcripts must agree on completed and guided occurrences"
  )
}

async function main(): Promise<void> {
  await withTempHome(async () => {
    await testForkThreadCopiesCheckpointThreadRowAndTranscript()
    await testForkCopiesOnlyReferencedLargeToolResults()
    await testInterruptedDurableTailForkIsConsistentAndComplete()
    await testUnsafeLatestDurableTailDoesNotHideHistoricalForks()
    await testForkLatestAllowsUserInterruptedPendingWritesBoundary()
    await testForkLatestRejectsUnmarkedCheckpointAfterMarkerEra()
    await testForkLatestRejectsThreadMarkerEraWithoutCheckpointMarker()
    await testForkOverrideValidationRejectsInconsistentTargetMetadata()
    await testForkCopiesGoalStateAndEvents()
    await testHistoricalForkDoesNotCopyFutureGoalStateAndEvents()
    await testSessionTranscriptMergeKeepsDurableTailBeyondCheckpoint()
    await testSessionTranscriptMergeExcludesHiddenCoordinatorIdCollision()
    await testSessionTranscriptMergeRestoresCurrentRunProviderOccurrence()
    await testResolveMessageForkReturnsNewestStableCheckpoint()
    await testResolveAndForkRoleCollisionAssistantBoundary()
    await testResolveAndForkSameRoleDuplicateAssistantBoundary()
    await testResolveMessageForkMapsLiveSnapshotToCheckpointMessageId()
    await testResolveMessageForkMatchesSparseToolAssistantSnapshot()
    await testResolveMessageForkUsesCheckpointModeForInterruptedToolTail()
    await testResolveAndForkLegacyMessageBeforeFirstMarker()
    await testUnmarkedCheckpointBetweenMarkersIsNotForkable()
    await testResolveMessageForkSkipsHiddenRawTailCheckpoint()
    await testForkWaitsForQueuedRendererThreadMutations()
    await testForkThreadCopiesHistoricalForkableCheckpoints()
    await testForkedBranchesRemainIndependentWhenForkedAgain()
  })
  console.log("thread-fork-handler.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
