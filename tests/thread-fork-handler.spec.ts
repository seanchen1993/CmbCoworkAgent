/**
 * Regression tests for the threads:fork handler path.
 *
 * Run:
 *   npx tsx tests/thread-fork-handler.spec.ts
 */

import assert from "assert"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { Message } from "../src/main/types.ts"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../src/shared/checkpoint-transcript.ts"
import {
  FORK_BOUNDARY_MARKER_VERSION,
  FORK_BOUNDARY_THREAD_METADATA_KEY
} from "../src/shared/checkpoint-forkability.ts"

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
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(home, { recursive: true, force: true })
  }
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

function makeHiddenTailCheckpoint(id: string): Checkpoint {
  const checkpoint = makeCheckpoint(id, "2026-07-08T01:00:02.000Z")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "fork source prompt" },
    { id: "assistant-1", type: "ai", content: "checkpoint final answer" },
    { id: "wf-trigger", type: "human", content: WORKFLOW_NOTIFICATION_TURN_PROMPT }
  ]
  return checkpoint
}

function makeForkBoundaryMetadata(checkpointId: string): CheckpointMetadata {
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
      lastVisibleMessageId: "assistant-1"
    }
  } as CheckpointMetadata
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
    deleteThreadCheckpoint(sourceThreadId)
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
    deleteThreadCheckpoint(sourceThreadId)
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
    assert.deepEqual(
      targetValues.messageTimes,
      { "assistant-1": { created_at: "2026-07-08T01:00:04.000Z" } },
      "fork should see queued renderer thread_values before filtering"
    )
    assert.deepEqual(
      targetValues.messageTimeOrder?.map((entry) => entry.id),
      ["user-1", "assistant-1"],
      "fork should preserve queued renderer message time order"
    )
  } finally {
    releaseLock?.()
    if (targetThreadId) {
      db.deleteThread(targetThreadId)
      deleteThreadCheckpoint(targetThreadId)
    }
    db.deleteThread(sourceThreadId)
    deleteThreadCheckpoint(sourceThreadId)
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

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

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
      deleteThreadCheckpoint(targetThreadId)
    }
    db.deleteThread(sourceThreadId)
    deleteThreadCheckpoint(sourceThreadId)
    await db.closeDatabase()
  }
}

async function testForkLatestRejectsDurableTailBeyondCheckpoint(): Promise<void> {
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { deleteThreadCheckpoint, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { forkThread } = await import("../src/main/ipc/threads.ts")

  const sourceThreadId = "fork-durable-tail-source"
  const checkpointId = "fork-durable-tail-cp"

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
        id: "assistant-1",
        role: "assistant",
        content: "checkpoint final answer",
        created_at: new Date("2026-07-08T01:00:01.000Z")
      },
      {
        id: "user-2",
        role: "user",
        content: "durable tail question after checkpoint",
        created_at: new Date("2026-07-08T01:01:00.000Z")
      }
    ])

    const sourceSaver = new SqlJsSaver(getThreadCheckpointPath(sourceThreadId))
    await sourceSaver.put(
      { configurable: { thread_id: sourceThreadId, checkpoint_ns: "" } },
      makeCheckpoint(checkpointId),
      makeForkBoundaryMetadata(checkpointId)
    )
    await sourceSaver.flushStrict()
    await sourceSaver.close()

    await assert.rejects(
      () => forkThread({ sourceThreadId, title: "Fork should wait for checkpoint" }),
      /checkpoint 之后的已恢复历史/,
      "latest fork should not silently drop durable tail messages beyond checkpoint"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    deleteThreadCheckpoint(sourceThreadId)
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
    deleteThreadCheckpoint(sourceThreadId)
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
    deleteThreadCheckpoint(sourceThreadId)
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
          overrides: { workspacePath: "   " } as any
        }),
      /workspacePath override/,
      "workspacePath override must be a non-empty string or null"
    )
    await assert.rejects(
      () =>
        forkThread({
          sourceThreadId,
          overrides: { agentMode: "invalid-mode" } as any
        }),
      /agentMode override 无效/,
      "agentMode override must be one of the supported modes"
    )
  } finally {
    db.deleteThread(sourceThreadId)
    deleteThreadCheckpoint(sourceThreadId)
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
      deleteThreadCheckpoint(targetThreadId)
    }
    db.deleteThread(sourceThreadId)
    deleteThreadCheckpoint(sourceThreadId)
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

async function main(): Promise<void> {
  await withTempHome(async () => {
    await testForkThreadCopiesCheckpointThreadRowAndTranscript()
    await testForkLatestRejectsDurableTailBeyondCheckpoint()
    await testForkLatestRejectsUnmarkedCheckpointAfterMarkerEra()
    await testForkLatestRejectsThreadMarkerEraWithoutCheckpointMarker()
    await testForkOverrideValidationRejectsInconsistentTargetMetadata()
    await testForkCopiesGoalStateAndEvents()
    await testSessionTranscriptMergeKeepsDurableTailBeyondCheckpoint()
    await testResolveMessageForkReturnsNewestStableCheckpoint()
    await testResolveMessageForkSkipsHiddenRawTailCheckpoint()
    await testForkWaitsForQueuedRendererThreadMutations()
  })
  console.log("thread-fork-handler.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
