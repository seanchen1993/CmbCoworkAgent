/**
 * Regression tests for checkpoint fork primitives.
 *
 * Run:
 *   npx tsx tests/checkpoint-fork.spec.ts
 */

import assert from "assert"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { RunnableConfig } from "@langchain/core/runnables"
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple
} from "@langchain/langgraph-checkpoint"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"
import {
  buildForkableCheckpointSummary,
  buildVisibleForkableCheckpointList,
  describeCheckpointForkability,
  isForkableCheckpointForMessage
} from "../src/shared/checkpoint-forkability"
import {
  buildFilteredThreadValues,
  checkpointHasInterrupt,
  describeCheckpointMessageForkTarget,
  deriveCheckpointTranscriptIndex,
  isWorkflowPlumbingTranscriptContent,
  WORKFLOW_NOTIFICATION_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT,
  truncateCheckpointMessagesAfter
} from "../src/shared/checkpoint-transcript"

function config(threadId: string, checkpointId?: string): RunnableConfig {
  return { configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId } }
}

function makeCheckpoint(id: string, ts = "2026-07-03T00:00:00.000Z"): Checkpoint {
  return {
    v: 1,
    id,
    ts,
    channel_values: {
      messages: [
        { id: "user-1", type: "human", content: "hello" },
        { id: "assistant-1", type: "ai", content: "hi" }
      ],
      value: id
    },
    channel_versions: { value: 1 },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

function makeTuple(input: {
  checkpoint: Checkpoint
  metadata?: CheckpointMetadata
  pendingWrites?: [string, string, unknown][]
}): CheckpointTuple {
  const { checkpoint, metadata = makeMetadata(1), pendingWrites = [] } = input
  return {
    config: config("source", checkpoint.id),
    checkpoint,
    metadata,
    pendingWrites
  } as CheckpointTuple
}

function makeMetadata(step: number): CheckpointMetadata {
  return {
    source: "loop",
    step,
    writes: {},
    parents: {}
  } as CheckpointMetadata
}

function makeForkBoundaryMetadata(
  checkpointId: string,
  step = 1,
  lastVisibleMessageId?: string
): CheckpointMetadata {
  const boundary: Record<string, unknown> = {
    version: 1,
    kind: "turn_complete",
    boundaryId: `turn_complete:source:${checkpointId}`,
    completedAt: "2026-07-03T00:00:01.000Z",
    source: "agent_run_complete"
  }
  if (lastVisibleMessageId) boundary.lastVisibleMessageId = lastVisibleMessageId
  return {
    ...makeMetadata(step),
    cmb_fork_boundary: boundary
  } as CheckpointMetadata
}

async function testTupleCopyToNewThread(dir: string): Promise<void> {
  const sourcePath = join(dir, "source.sqlite")
  const targetPath = join(dir, "target.sqlite")
  const sourceSaver = new SqlJsSaver(sourcePath)
  const metadata = {
    source: "loop",
    step: 1,
    writes: {},
    parents: {},
    cmb_fork_boundary: {
      version: 1,
      kind: "turn_complete",
      boundaryId: "turn_complete:source:cp-1",
      completedAt: "2026-07-03T00:00:01.000Z",
      source: "agent_run_complete"
    }
  } as CheckpointMetadata

  await sourceSaver.put(config("source"), makeCheckpoint("cp-1"), metadata)
  await sourceSaver.close()

  const reopenedSource = new SqlJsSaver(sourcePath)
  const tuple = await reopenedSource.getTuple(config("source", "cp-1"))
  assert(tuple, "source tuple should exist")

  const targetSaver = new SqlJsSaver(targetPath)
  await targetSaver.put(
    { configurable: { thread_id: "target", checkpoint_ns: "" } },
    tuple!.checkpoint,
    tuple!.metadata
  )
  await targetSaver.close()

  const reopenedTarget = new SqlJsSaver(targetPath)
  const copied = await reopenedTarget.getTuple(config("target"))
  await reopenedTarget.close()
  await reopenedSource.close()

  assert.equal(copied?.checkpoint.id, "cp-1", "target should restore copied checkpoint")
  assert.equal(copied?.parentConfig, undefined, "forked checkpoint should start without parent")
  assert.deepEqual(copied?.metadata, metadata, "target metadata should match source tuple")
  console.log("PASS checkpoint tuple copies to an independent target thread")
}

async function testConfigurableCheckpointRetention(dir: string): Promise<void> {
  const historyPath = join(dir, "history.sqlite")
  const historySaver = new SqlJsSaver(historyPath, undefined, {
    maxCheckpointsPerNamespace: 3
  })

  await historySaver.put(config("history"), makeCheckpoint("cp-1"), makeMetadata(1))
  await historySaver.put(config("history", "cp-1"), makeCheckpoint("cp-2"), makeMetadata(2))
  await historySaver.put(config("history", "cp-2"), makeCheckpoint("cp-3"), makeMetadata(3))
  await historySaver.put(config("history", "cp-3"), makeCheckpoint("cp-4"), makeMetadata(4))

  const retainedIds: string[] = []
  for await (const tuple of historySaver.list(config("history"))) {
    retainedIds.push(tuple.checkpoint.id)
  }
  await historySaver.close()

  assert.deepEqual(retainedIds, ["cp-4", "cp-3", "cp-2"])

  const latestOnlyPath = join(dir, "latest-only.sqlite")
  const latestOnlySaver = new SqlJsSaver(latestOnlyPath)
  await latestOnlySaver.put(config("latest"), makeCheckpoint("cp-1"), makeMetadata(1))
  await latestOnlySaver.put(config("latest", "cp-1"), makeCheckpoint("cp-2"), makeMetadata(2))
  const latestOnlyIds: string[] = []
  for await (const tuple of latestOnlySaver.list(config("latest"))) {
    latestOnlyIds.push(tuple.checkpoint.id)
  }
  await latestOnlySaver.close()

  assert.deepEqual(latestOnlyIds, ["cp-2"])

  const timestampPath = join(dir, "timestamp-order.sqlite")
  const timestampSaver = new SqlJsSaver(timestampPath, undefined, {
    maxCheckpointsPerNamespace: 2
  })
  await timestampSaver.put(
    config("timestamp"),
    makeCheckpoint("z-old", "2026-07-03T00:00:00.000Z"),
    makeMetadata(1)
  )
  await timestampSaver.put(
    config("timestamp", "z-old"),
    makeCheckpoint("m-mid", "2026-07-03T00:00:01.000Z"),
    makeMetadata(2)
  )
  await timestampSaver.put(
    config("timestamp", "m-mid"),
    makeCheckpoint("a-new", "2026-07-03T00:00:02.000Z"),
    makeMetadata(3)
  )

  const timestampIds: string[] = []
  for await (const tuple of timestampSaver.list(config("timestamp"))) {
    timestampIds.push(tuple.checkpoint.id)
  }
  const latestByTimestamp = await timestampSaver.getTuple(config("timestamp"))
  await timestampSaver.close()

  assert.deepEqual(timestampIds, ["a-new", "m-mid"])
  assert.equal(latestByTimestamp?.checkpoint.id, "a-new")

  const paginationPath = join(dir, "timestamp-pagination.sqlite")
  const paginationSaver = new SqlJsSaver(paginationPath, undefined, {
    maxCheckpointsPerNamespace: 3
  })
  await paginationSaver.put(
    config("timestamp-page"),
    makeCheckpoint("z-old", "2026-07-03T00:00:00.000Z"),
    makeMetadata(1)
  )
  await paginationSaver.put(
    config("timestamp-page", "z-old"),
    makeCheckpoint("m-mid", "2026-07-03T00:00:01.000Z"),
    makeMetadata(2)
  )
  await paginationSaver.put(
    config("timestamp-page", "m-mid"),
    makeCheckpoint("a-new", "2026-07-03T00:00:02.000Z"),
    makeMetadata(3)
  )

  const firstPageIds: string[] = []
  for await (const tuple of paginationSaver.list(config("timestamp-page"), { limit: 1 })) {
    firstPageIds.push(tuple.checkpoint.id)
  }
  const afterFirstPageIds: string[] = []
  for await (const tuple of paginationSaver.list(config("timestamp-page"), {
    before: config("timestamp-page", "a-new")
  })) {
    afterFirstPageIds.push(tuple.checkpoint.id)
  }
  await paginationSaver.close()

  assert.deepEqual(firstPageIds, ["a-new"])
  assert.deepEqual(afterFirstPageIds, ["m-mid", "z-old"])
  console.log("PASS checkpoint retention can keep historical root checkpoints")
}

async function testMetadataUpdatePreservesCheckpointShape(dir: string): Promise<void> {
  const dbPath = join(dir, "metadata-update.sqlite")
  const saver = new SqlJsSaver(dbPath, undefined, { maxCheckpointsPerNamespace: 2 })

  await saver.put(config("source"), makeCheckpoint("cp-1"), makeMetadata(1))
  await saver.put(config("source", "cp-1"), makeCheckpoint("cp-2"), makeMetadata(2))
  await saver.updateCheckpointMetadata(config("source", "cp-2"), (metadata) => ({
    ...(metadata as Record<string, unknown>),
    cmb_fork_boundary: {
      version: 1,
      kind: "turn_complete",
      boundaryId: "turn_complete:source:cp-2",
      completedAt: "2026-07-03T00:00:02.000Z",
      source: "agent_run_complete"
    }
  }))

  const updated = await saver.getTuple(config("source", "cp-2"))
  await saver.close()

  assert.equal(updated?.checkpoint.id, "cp-2")
  assert.equal(updated?.parentConfig?.configurable?.checkpoint_id, "cp-1")
  assert.equal((updated?.metadata as Record<string, unknown>).source, "loop")
  assert.deepEqual((updated?.metadata as Record<string, unknown>).cmb_fork_boundary, {
    version: 1,
    kind: "turn_complete",
    boundaryId: "turn_complete:source:cp-2",
    completedAt: "2026-07-03T00:00:02.000Z",
    source: "agent_run_complete"
  })
  console.log("PASS fork boundary marker updates metadata without rewriting checkpoint shape")
}

function testThreadValuesFiltering(): void {
  const checkpoint = makeCheckpoint("cp-filter")
  const messages = (checkpoint.channel_values as Record<string, unknown>).messages as Array<
    Record<string, unknown>
  >
  messages[1] = {
    ...messages[1],
    tool_calls: [{ id: "task-keep", name: "task", args: { description: "kept" } }]
  }
  const index = deriveCheckpointTranscriptIndex(checkpoint)
  const filtered = buildFilteredThreadValues(
    {
      messageTimes: {
        "user-1": { start_at: "2026-07-03T00:00:00.000Z" },
        "assistant-1": { start_at: "2026-07-03T00:00:01.000Z" },
        "assistant-after-fork": { start_at: "2026-07-03T00:00:02.000Z" }
      },
      messageTimeOrder: [
        { id: "user-1", start_at: "2026-07-03T00:00:00.000Z" },
        { id: "assistant-1", start_at: "2026-07-03T00:00:01.000Z" },
        { id: "assistant-after-fork", start_at: "2026-07-03T00:00:02.000Z" }
      ],
      subagentTranscripts: {
        "task-keep": [{ id: "sub-1", role: "assistant", content: "kept subagent detail" }],
        "task-drop": [{ id: "sub-2", role: "assistant", content: "future subagent detail" }]
      },
      unknownRuntimeState: { shouldNotCopy: true }
    },
    index
  )

  assert.deepEqual(Object.keys(filtered.messageTimes as Record<string, unknown>), [
    "user-1",
    "assistant-1"
  ])
  assert.deepEqual(
    (filtered.messageTimeOrder as Array<{ id: string }>).map((entry) => entry.id),
    ["user-1", "assistant-1"]
  )
  assert.deepEqual(index.subagentTranscriptIds, ["task-keep"])
  assert.deepEqual(Object.keys(filtered.subagentTranscripts as Record<string, unknown>), [
    "task-keep"
  ])
  assert.equal(filtered.unknownRuntimeState, undefined, "unknown thread_values should not copy")
  console.log("PASS fork thread_values are rebuilt from the checkpoint transcript")
}

function testWorkflowPlumbingFilteredFromTranscript(): void {
  const checkpoint = makeCheckpoint("cp-workflow-plumbing") as Checkpoint
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "wf-trigger", type: "human", content: WORKFLOW_NOTIFICATION_TURN_PROMPT },
    {
      id: "wf-expanded",
      type: "human",
      content: `${WORKFLOW_NOTIFICATION_MARKER_PREFIX}wf_run_1]]\n<task-notification />`
    },
    { id: "assistant-2", type: "ai", content: "workflow summary" }
  ]

  assert.equal(isWorkflowPlumbingTranscriptContent(WORKFLOW_NOTIFICATION_TURN_PROMPT), true)
  assert.equal(
    isWorkflowPlumbingTranscriptContent(
      `${WORKFLOW_NOTIFICATION_MARKER_PREFIX}wf_run_1]]\n<task-notification />`
    ),
    true
  )
  const index = deriveCheckpointTranscriptIndex(checkpoint)
  assert.deepEqual(index.visibleMessageIds, ["user-1", "assistant-1", "assistant-2"])
  assert.deepEqual(
    index.visibleMessages.map((message) => message.text),
    ["hello", "hi", "workflow summary"]
  )
  console.log("PASS workflow plumbing is hidden from checkpoint fork transcripts")
}

function testCheckpointMessageTruncation(): void {
  const checkpoint = makeCheckpoint("cp-truncate") as Checkpoint
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "user-2", type: "human", content: "next" },
    { id: "assistant-2", type: "ai", content: "later" }
  ]

  assert.equal(truncateCheckpointMessagesAfter(checkpoint, "assistant-1"), true)
  const index = deriveCheckpointTranscriptIndex(checkpoint)
  assert.deepEqual(index.visibleMessageIds, ["user-1", "assistant-1"])
  assert.equal(truncateCheckpointMessagesAfter(checkpoint, "missing"), false)
  console.log("PASS checkpoint fork can truncate transcript to a selected message")
}

function testMessageForkBoundaryValidation(): void {
  const assistantBoundary = makeCheckpoint("cp-assistant-boundary") as Checkpoint
  let status = describeCheckpointMessageForkTarget(assistantBoundary, "assistant-1")
  assert.equal(status.isForkableMessageBoundary, true)
  assert.equal(
    isForkableCheckpointForMessage(
      makeTuple({
        checkpoint: assistantBoundary,
        metadata: makeForkBoundaryMetadata("cp-assistant-boundary", 1, "assistant-1")
      }),
      "assistant-1"
    ),
    true
  )

  status = describeCheckpointMessageForkTarget(assistantBoundary, "user-1")
  assert.equal(status.isForkableMessageBoundary, false)
  assert.equal(status.reason, "not_assistant")

  const laterVisible = makeCheckpoint("cp-later-visible") as Checkpoint
  ;(laterVisible.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "user-2", type: "human", content: "next" },
    { id: "assistant-2", type: "ai", content: "later" }
  ]
  status = describeCheckpointMessageForkTarget(laterVisible, "assistant-1")
  assert.equal(status.isForkableMessageBoundary, false)
  assert.equal(status.reason, "not_visible_boundary")
  assert.equal(
    isForkableCheckpointForMessage(
      makeTuple({
        checkpoint: laterVisible,
        metadata: makeForkBoundaryMetadata("cp-later-visible", 1, "assistant-2")
      }),
      "assistant-1"
    ),
    false
  )

  const hiddenTail = makeCheckpoint("cp-hidden-tail") as Checkpoint
  ;(hiddenTail.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "wf-trigger", type: "human", content: WORKFLOW_NOTIFICATION_TURN_PROMPT }
  ]
  status = describeCheckpointMessageForkTarget(hiddenTail, "assistant-1")
  assert.equal(status.isForkableMessageBoundary, true)
  assert.equal(
    isForkableCheckpointForMessage(
      makeTuple({
        checkpoint: hiddenTail,
        metadata: makeForkBoundaryMetadata("cp-hidden-tail", 1, "assistant-1")
      }),
      "assistant-1"
    ),
    true
  )

  const visibleRawTail = makeCheckpoint("cp-visible-raw-tail") as Checkpoint
  ;(visibleRawTail.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "tool-1", type: "tool", content: "visible tool output" }
  ]
  status = describeCheckpointMessageForkTarget(visibleRawTail, "assistant-1")
  assert.equal(status.isForkableMessageBoundary, false)
  assert.equal(status.reason, "not_visible_boundary")

  assert.equal(
    isForkableCheckpointForMessage(
      makeTuple({
        checkpoint: assistantBoundary,
        metadata: makeForkBoundaryMetadata("cp-marker-mismatch", 1, "assistant-2")
      }),
      "assistant-1"
    ),
    false
  )
  console.log("PASS message fork requires a visible assistant boundary with no later visible tail")
}

function testInterruptDetection(): void {
  assert.equal(checkpointHasInterrupt(makeCheckpoint("plain")), false)
  const interrupted = makeCheckpoint("interrupt") as Checkpoint
  ;(interrupted.channel_values as Record<string, unknown>).__interrupt__ = [{ value: {} }]
  assert.equal(checkpointHasInterrupt(interrupted), true)
  console.log("PASS checkpoint interrupt detection gates forkability")
}

function testForkabilitySummary(): void {
  const stableMetadata = makeForkBoundaryMetadata("cp-stable")
  const stableSummary = buildForkableCheckpointSummary(
    makeTuple({ checkpoint: makeCheckpoint("cp-stable"), metadata: stableMetadata }),
    { activeRun: false, pendingApproval: false }
  )
  assert.equal(stableSummary.isStableTurnBoundary, true)
  assert.equal(stableSummary.boundarySource, "metadata_marker")
  assert.equal(stableSummary.stableTurnId, "turn_complete:source:cp-stable")
  assert.equal(stableSummary.messageCount, 2)
  assert.equal(stableSummary.lastMessagePreview, "hi")
  assert.equal(stableSummary.lastUserMessagePreview, "hello")

  const missingMarker = describeCheckpointForkability(
    makeTuple({ checkpoint: makeCheckpoint("cp-missing") }),
    {
      allowLegacyLatestFallback: false
    }
  )
  assert.equal(missingMarker.isStableTurnBoundary, false)
  assert.equal(missingMarker.unstableReason, "missing_boundary_marker")

  const legacyLatest = describeCheckpointForkability(
    makeTuple({ checkpoint: makeCheckpoint("cp-legacy") }),
    {
      allowLegacyLatestFallback: true
    }
  )
  assert.equal(legacyLatest.isStableTurnBoundary, true)
  assert.equal(legacyLatest.boundarySource, "legacy_latest_idle_fallback")

  const pendingWritesSummary = buildForkableCheckpointSummary(
    makeTuple({
      checkpoint: makeCheckpoint("cp-pending"),
      metadata: stableMetadata,
      pendingWrites: [["task-1", "messages", { pending: true }]]
    }),
    { activeRun: false, pendingApproval: false }
  )
  assert.equal(pendingWritesSummary.isStableTurnBoundary, false)
  assert.equal(pendingWritesSummary.unstableReason, "pending_writes")
  assert.equal(pendingWritesSummary.hasPendingWrites, true)

  const interrupted = makeCheckpoint("cp-interrupt") as Checkpoint
  ;(interrupted.channel_values as Record<string, unknown>).__interrupt__ = [{ value: {} }]
  const interruptedSummary = buildForkableCheckpointSummary(
    makeTuple({ checkpoint: interrupted, metadata: stableMetadata }),
    { activeRun: false, pendingApproval: false }
  )
  assert.equal(interruptedSummary.isStableTurnBoundary, false)
  assert.equal(interruptedSummary.unstableReason, "interrupt")
  assert.equal(interruptedSummary.hasInterrupt, true)
  console.log("PASS forkability summary matches stable and unstable checkpoint states")
}

function testVisibleForkableCheckpointList(): void {
  const unique = makeCheckpoint("cp-unique") as Checkpoint
  ;(unique.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "user-2", type: "human", content: "next" },
    { id: "assistant-2", type: "ai", content: "later" }
  ]

  const summaries = buildVisibleForkableCheckpointList(
    [
      makeTuple({
        checkpoint: makeCheckpoint("cp-dupe-newer"),
        metadata: makeForkBoundaryMetadata("cp-dupe-newer", 4)
      }),
      makeTuple({
        checkpoint: makeCheckpoint("cp-pending"),
        metadata: makeForkBoundaryMetadata("cp-pending", 3),
        pendingWrites: [["task-1", "messages", { pending: true }]]
      }),
      makeTuple({
        checkpoint: makeCheckpoint("cp-dupe-older"),
        metadata: makeForkBoundaryMetadata("cp-dupe-older", 2)
      }),
      makeTuple({
        checkpoint: makeCheckpoint("cp-missing-marker"),
        metadata: makeMetadata(1)
      }),
      makeTuple({
        checkpoint: unique,
        metadata: makeForkBoundaryMetadata("cp-unique", 1)
      })
    ],
    { activeRun: false, pendingApproval: false }
  )

  assert.deepEqual(
    summaries.map((summary) => summary.checkpointId),
    ["cp-dupe-newer", "cp-unique"]
  )
  assert.ok(summaries.every((summary) => summary.isStableTurnBoundary))
  console.log("PASS visible fork checkpoint list hides internal states and duplicate messages")
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-fork-"))
  try {
    await testTupleCopyToNewThread(dir)
    await testConfigurableCheckpointRetention(dir)
    await testMetadataUpdatePreservesCheckpointShape(dir)
    testThreadValuesFiltering()
    testWorkflowPlumbingFilteredFromTranscript()
    testCheckpointMessageTruncation()
    testMessageForkBoundaryValidation()
    testInterruptDetection()
    testForkabilitySummary()
    testVisibleForkableCheckpointList()
    console.log("checkpoint fork tests passed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
