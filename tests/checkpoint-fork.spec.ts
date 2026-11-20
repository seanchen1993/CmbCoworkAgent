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
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph"
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple
} from "@langchain/langgraph-checkpoint"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"
import {
  applyForkReplayMessages,
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
  filterMessagesToCheckpointVisibleIds,
  findMessagesAfterCheckpointVisibleIds,
  isCheckpointEmptyAssistantToolCallMessage,
  isWorkflowPlumbingTranscriptContent,
  mergeCheckpointAuthorityTranscriptMessage,
  mergeCheckpointAuthorityTranscriptMessages,
  WORKFLOW_NOTIFICATION_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT,
  truncateCheckpointMessagesAfter
} from "../src/shared/checkpoint-transcript"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId
} from "../src/shared/message-role-collision"
import { buildSubagentTaskInvocationIdentity } from "../src/shared/subagent-invocation-identity"

function config(threadId: string, checkpointId?: string, checkpointNs = ""): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId }
  }
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

function testCheckpointAuthorityMergeKeepsCompleteCheckpointContent(): void {
  const merged = mergeCheckpointAuthorityTranscriptMessage(
    {
      id: "assistant-1",
      role: "assistant",
      content: "complete checkpoint answer",
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }],
      created_at: new Date("2026-07-03T00:00:00.000Z")
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "complete",
      tool_calls: [],
      goal_id: "goal-1",
      created_at: new Date("2026-07-03T00:00:01.000Z")
    }
  )

  assert.equal(merged.content, "complete checkpoint answer")
  assert.deepEqual(merged.tool_calls, [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }])
  assert.equal(merged.goal_id, "goal-1")
  assert.equal(
    merged.created_at instanceof Date ? merged.created_at.toISOString() : merged.created_at,
    "2026-07-03T00:00:01.000Z"
  )

  const upgraded = mergeCheckpointAuthorityTranscriptMessage(
    {
      id: "assistant-2",
      role: "assistant",
      content: "partial",
      created_at: new Date("2026-07-03T00:00:00.000Z")
    },
    {
      id: "assistant-2",
      role: "assistant",
      content: "partial answer completed",
      created_at: new Date("2026-07-03T00:00:01.000Z")
    }
  )
  assert.equal(upgraded.content, "partial answer completed")

  const clearedToolCallDraft = mergeCheckpointAuthorityTranscriptMessage(
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
    },
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: "final answer accidentally persisted on the tool call",
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
    }
  )
  assert.equal(
    clearedToolCallDraft.content,
    "",
    "an empty checkpoint tool-call message must not resurrect persisted streamed content"
  )
  assert.equal(
    isCheckpointEmptyAssistantToolCallMessage(clearedToolCallDraft),
    true,
    "the restore path should identify a checkpoint-confirmed empty tool-call message for repair"
  )

  const cleanedFinalAnswer = mergeCheckpointAuthorityTranscriptMessage(
    {
      id: "assistant-final-answer",
      role: "assistant",
      content: "DUP_TEST_A_20260711 只应该出现一次。",
      tool_calls: []
    },
    {
      id: "assistant-final-answer",
      role: "assistant",
      content: "DUP_TEST_A_20260711 只应该出现一次。",
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
    }
  )
  assert.deepEqual(
    cleanedFinalAnswer.tool_calls,
    [],
    "checkpoint-confirmed text answers must not resurrect polluted persisted tool calls"
  )

  const crossRoleCollision = mergeCheckpointAuthorityTranscriptMessage(
    {
      id: "cross-role-id",
      role: "assistant",
      content: "assistant answer"
    },
    {
      id: "cross-role-id",
      role: "tool",
      content: "tool output",
      tool_call_id: "call-1"
    }
  )
  assert.equal(crossRoleCollision.role, "assistant")
  assert.equal(crossRoleCollision.content, "assistant answer")
  assert.equal(
    crossRoleCollision.tool_call_id,
    undefined,
    "cross-role id collisions must not leak tool linkage onto a visible assistant"
  )

  const preservedCrossRoleCollision = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "shared-provider-id",
        role: "assistant",
        content: "assistant tool call",
        tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
      }
    ],
    [
      {
        id: "shared-provider-id",
        role: "tool",
        content: "tool output",
        tool_call_id: "call-1"
      }
    ]
  )
  assert.equal(preservedCrossRoleCollision.length, 2)
  assert.equal(preservedCrossRoleCollision[0].role, "assistant")
  assert.equal(preservedCrossRoleCollision[1].role, "tool")
  assert.notEqual(
    preservedCrossRoleCollision[0].id,
    preservedCrossRoleCollision[1].id,
    "cross-role records need unique render ids"
  )

  const repeatedCrossRoleSync = mergeCheckpointAuthorityTranscriptMessages(
    preservedCrossRoleCollision,
    [
      {
        id: "shared-provider-id",
        role: "tool",
        content: "tool output with complete metadata",
        tool_call_id: "call-1",
        name: "read_file"
      }
    ]
  )
  assert.equal(repeatedCrossRoleSync.length, 2, "repeated collision syncs must be idempotent")
  assert.equal(repeatedCrossRoleSync[1].name, "read_file")

  const reverseCrossRoleCollision = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "reverse-shared-id",
        role: "tool",
        content: "checkpoint tool output",
        tool_call_id: "call-2"
      }
    ],
    [
      {
        id: "reverse-shared-id",
        role: "assistant",
        content: "durable final answer"
      }
    ]
  )
  assert.equal(reverseCrossRoleCollision.length, 2)
  assert.equal(reverseCrossRoleCollision[0].role, "tool")
  assert.equal(reverseCrossRoleCollision[1].role, "assistant")
  assert.equal(reverseCrossRoleCollision[1].content, "durable final answer")

  const checkpointOnlyCrossRoleCollision = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-shared-id",
        role: "assistant",
        content: "checkpoint assistant"
      },
      {
        id: "checkpoint-shared-id",
        role: "tool",
        content: "checkpoint tool output",
        tool_call_id: "call-3"
      }
    ],
    []
  )
  assert.equal(checkpointOnlyCrossRoleCollision.length, 2)
  assert.equal(
    new Set(checkpointOnlyCrossRoleCollision.map((message) => message.id)).size,
    2,
    "checkpoint-only role collisions also need unique render ids"
  )

  const checkpointSameRoleCollision = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "checkpoint-reused-assistant-id",
        role: "assistant",
        content: "first assistant chunk"
      },
      {
        id: "checkpoint-reused-assistant-id",
        role: "assistant",
        content: "second distinct assistant chunk"
      }
    ],
    []
  )
  assert.equal(checkpointSameRoleCollision.length, 2)
  assert.deepEqual(
    checkpointSameRoleCollision.map((message) => message.content),
    ["first assistant chunk", "second distinct assistant chunk"],
    "same-role checkpoint id reuse must not discard a message"
  )
  assert.equal(
    new Set(checkpointSameRoleCollision.map((message) => message.id)).size,
    2,
    "same-role checkpoint id reuse also needs unique render ids"
  )
  assert.equal(
    checkpointSameRoleCollision[1].id,
    buildMessageSameRoleDuplicateId("checkpoint-reused-assistant-id", "assistant"),
    "same-role duplicates need an identity distinct from cross-role reconciliation ids"
  )
  const updatedSameRoleCollision = mergeCheckpointAuthorityTranscriptMessages(
    checkpointSameRoleCollision,
    [
      {
        id: checkpointSameRoleCollision[1].id,
        role: "assistant",
        content: "second distinct assistant chunk extended"
      }
    ]
  )
  assert.equal(
    updatedSameRoleCollision[0].content,
    "first assistant chunk",
    "cross-source normalization must not redirect an exact same-role collision id"
  )
  assert.equal(updatedSameRoleCollision[1].content, "second distinct assistant chunk extended")

  const crossSourceProviderId = "cross-source-keeper-mismatch"
  const crossSourceDurableMessages = [
    {
      id: crossSourceProviderId,
      role: "tool",
      content: "tool result updated",
      tool_call_id: "call-cross-source"
    },
    {
      id: buildMessageRoleCollisionId(crossSourceProviderId, "assistant"),
      role: "assistant",
      content: "checkpoint assistant expanded",
      tool_calls: [{ id: "call-cross-source", name: "read_file", args: {} }]
    }
  ]
  const crossSourceKeeperMismatch = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: crossSourceProviderId,
        role: "assistant",
        content: "checkpoint assistant",
        tool_calls: [{ id: "call-cross-source", name: "read_file", args: {} }]
      },
      {
        id: buildMessageRoleCollisionId(crossSourceProviderId, "tool"),
        role: "tool",
        content: "tool result",
        tool_call_id: "call-cross-source"
      }
    ],
    crossSourceDurableMessages
  )
  assert.equal(
    crossSourceKeeperMismatch.length,
    2,
    "checkpoint and durable sources must not duplicate a role when their raw-id keeper differs"
  )
  assert.deepEqual(
    crossSourceKeeperMismatch.map((message) => message.role),
    ["assistant", "tool"],
    "cross-source collision reconciliation must preserve checkpoint role order"
  )
  assert.equal(crossSourceKeeperMismatch[0].content, "checkpoint assistant expanded")
  assert.equal(crossSourceKeeperMismatch[1].content, "tool result updated")

  const repeatedCrossSourceSync = mergeCheckpointAuthorityTranscriptMessages(
    crossSourceKeeperMismatch,
    crossSourceDurableMessages
  )
  assert.equal(
    repeatedCrossSourceSync.length,
    2,
    "cross-source collision reconciliation must remain idempotent on repeated durable syncs"
  )
  console.log("PASS DB transcript cannot overwrite complete checkpoint content")
}

function testDurableTranscriptMergeKeepsMessagesAfterCheckpoint(): void {
  const merged = mergeCheckpointAuthorityTranscriptMessages(
    [
      {
        id: "user-1",
        content: "old question",
        created_at: new Date("2026-07-03T00:00:00.000Z")
      },
      {
        id: "assistant-1",
        content: "complete checkpoint answer",
        created_at: new Date("2026-07-03T00:00:01.000Z")
      }
    ],
    [
      {
        id: "assistant-1",
        content: "complete",
        goal_id: "goal-1",
        created_at: new Date("2026-07-03T00:00:01.500Z")
      },
      {
        id: "user-2",
        content: "new question after checkpoint",
        created_at: new Date("2026-07-03T00:01:00.000Z")
      },
      {
        id: "assistant-2",
        content: "new answer after checkpoint",
        created_at: new Date("2026-07-03T00:01:01.000Z")
      }
    ]
  )

  assert.deepEqual(
    merged.map((message) => message.id),
    ["user-1", "assistant-1", "user-2", "assistant-2"],
    "durable transcript messages after the checkpoint must remain visible"
  )
  assert.equal(
    merged[1].content,
    "complete checkpoint answer",
    "checkpoint content stays authoritative for the overlapping message"
  )
  assert.equal(merged[1].goal_id, "goal-1", "durable metadata still enriches checkpoint messages")
  console.log("PASS durable transcript merge keeps messages after checkpoint")
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

function testReplayDoesNotRepeatMessagesAlreadyInTheCheckpoint(): void {
  const tuple = makeTuple({ checkpoint: makeCheckpoint("recovered") })
  const next = { id: "assistant-next", type: "ai", content: "more output" }
  const replay = applyForkReplayMessages(tuple, [
    { id: "assistant-1", type: "ai", content: "hi" },
    next,
    next
  ])
  assert(replay)
  assert.deepEqual(deriveCheckpointTranscriptIndex(replay.checkpoint).visibleMessageIds, [
    "user-1", "assistant-1", "assistant-next"
  ])
  assert.equal(deriveCheckpointTranscriptIndex(tuple.checkpoint).visibleMessageIds.length, 2)
}

function makeInterruptedForkBoundaryMetadata(
  checkpointId: string,
  step = 1,
  lastVisibleMessageId?: string
): CheckpointMetadata {
  const metadata = makeForkBoundaryMetadata(checkpointId, step, lastVisibleMessageId) as Record<
    string,
    unknown
  >
  metadata.cmb_fork_boundary = {
    ...(metadata.cmb_fork_boundary as Record<string, unknown>),
    boundaryId: `turn_interrupted:source:${checkpointId}`,
    source: "agent_run_interrupted",
    outcome: "interrupted"
  }
  return metadata as CheckpointMetadata
}

async function testRetentionAfterFirstInterruptedMarker(dir: string): Promise<void> {
  const filePath = join(dir, "interrupted-boundary-retention.sqlite")
  const thread = "interrupted-retention"
  const options = { maxRootCheckpoints: 3, maxRootForkBoundaryCheckpoints: 2 }
  let saver = new SqlJsSaver(filePath, undefined, options)
  const checkpoint = (step: number): Checkpoint =>
    makeCheckpoint("cp-" + step, new Date(Date.UTC(2026, 6, 8, 1, 0, step)).toISOString())
  const ids = async (): Promise<string[]> => {
    const result: string[] = []
    for await (const tuple of saver.list(config(thread))) result.push(tuple.checkpoint.id)
    return result
  }
  try {
    for (let step = 1; step <= 5; step += 1) {
      await saver.put(config(thread), checkpoint(step), makeMetadata(step))
    }
    await saver.updateCheckpointMetadata(config(thread), () =>
      makeInterruptedForkBoundaryMetadata("cp-5", 5, "assistant-1")
    )
    await saver.close()
    saver = new SqlJsSaver(filePath, undefined, options)
    await saver.put(config(thread), checkpoint(6), makeMetadata(6))
    assert.deepEqual(await ids(), ["cp-6", "cp-5", "cp-4", "cp-3", "cp-2"])

    await saver.put(config(thread), checkpoint(7), makeForkBoundaryMetadata("cp-7", 7))
    await saver.put(config(thread), checkpoint(8), makeMetadata(8))
    await saver.put(config(thread), checkpoint(9), makeMetadata(9))
    await saver.close()
    saver = new SqlJsSaver(filePath, undefined, options)
    assert.deepEqual(
      await ids(),
      ["cp-9", "cp-8", "cp-7", "cp-5", "cp-4"],
      "unmarked checkpoints between markers must not displace the legacy archive"
    )
  } finally {
    await saver.close()
  }
}

async function testRetentionExcludesIntermediateSnapshotsOfFirstInterruptedTurn(
  dir: string
): Promise<void> {
  const file = join(dir, "interrupted-turn-origin.sqlite")
  const thread = "interrupted-turn-origin"
  const options = { maxRootCheckpoints: 3, maxRootForkBoundaryCheckpoints: 2 }
  const older = [
    { id: "user-old", type: "human", content: "older request" },
    { id: "assistant-old", type: "ai", content: "older answer" },
    { id: "user-old-2", type: "human", content: "second older request" },
    { id: "assistant-old-2", type: "ai", content: "second older answer" }
  ]
  // A bounded repair can leave a suffix with no shared raw prefix with the archived checkpoint.
  const recent = [
    { id: "user-recovered", type: "human", content: "recovered request" },
    { id: "assistant-recovered", type: "ai", content: "recovered answer" }
  ]
  const start = { id: "user-new", type: "human", content: "new request" }
  const steer = { id: "user-steer", type: "human", content: "steer within this turn" }
  const partial = {
    id: "assistant-partial", type: "ai", content: "working"
  }
  const stopped = { id: "assistant-stopped", type: "ai", content: "stopped" }
  const snapshots = [
    ["older-safe", older],
    ["graph-input", recent],
    ["new-partial", [...recent, start, partial]],
    ["new-progress", [...recent, start, partial, steer]],
    ["interrupted", [...recent, start, partial, steer, stopped]]
  ] as const
  const save = async (writer: SqlJsSaver, id: string, step: number, messages: readonly unknown[], parent?: string) => {
    const value = makeCheckpoint(id, new Date(Date.UTC(2026, 6, 8, 1, 0, step)).toISOString())
    value.channel_values.messages = [...messages]
    const metadata = makeMetadata(step)
    if (id === "graph-input") {
      metadata.source = "input"
      value.channel_values.__start__ = { messages: [start] }
    }
    await writer.put(config(thread, parent), value, metadata)
  }
  let saver = new SqlJsSaver(file, undefined, options)
  try {
    for (const [index, [id, messages]] of snapshots.entries()) {
      await save(saver, id, index, messages, snapshots[index - 1]?.[0])
    }
    await saver.updateCheckpointMetadata(config(thread), () => {
      const value = makeInterruptedForkBoundaryMetadata("interrupted", 4, "assistant-stopped")
      return {
        ...value,
        cmb_fork_boundary: {
          ...(value as Record<string, unknown>).cmb_fork_boundary as Record<string, unknown>,
          turnId: `resume:${thread}:1760000000000`
        }
      } as CheckpointMetadata
    })
    await saver.close()
    saver = new SqlJsSaver(file, undefined, options)
    await save(saver, "next-input", 5, [
      ...snapshots[4][1], { id: "user-next", type: "human", content: "later request" }
    ], "interrupted")
    const retained: CheckpointTuple[] = []
    for await (const tuple of saver.list(config(thread))) retained.push(tuple)
    assert.deepEqual(retained.map((tuple) => tuple.checkpoint.id), [
      "next-input", "interrupted", "new-progress", "older-safe"
    ])
    assert.equal(await saver.getForkTurnUserId(thread, "interrupted"), undefined)
    const visible = buildVisibleForkableCheckpointList(retained, {
      activeRun: false,
      pendingApproval: false,
      legacyFallbackMode: "older_than_marker"
    })
    assert.deepEqual(visible.map((checkpoint) => checkpoint.checkpointId), [
      "interrupted", "older-safe"
    ])
  } finally {
    await saver.close()
  }
}

async function testRetentionProtectsLegacyCheckpointsBeforeFirstMarker(dir: string): Promise<void> {
  const file = join(dir, "legacy-fork-candidates.sqlite")
  const thread = "legacy-fork-candidates"
  const options = { maxRootCheckpoints: 3, maxRootForkBoundaryCheckpoints: 2 }
  let saver = new SqlJsSaver(file, undefined, options)
  const older = [
    { id: "user-old", type: "human", content: "older request" },
    { id: "assistant-old", type: "ai", content: "older answer" }
  ]
  const save = async (
    id: string, second: number, extra: unknown[] = [], state?: "input" | "interrupted"
  ) => {
    const value = makeCheckpoint(id, new Date(Date.UTC(2026, 6, 8, 1, 0, second)).toISOString())
    value.channel_values.messages = [...older, ...extra]
    const metadata = makeMetadata(second)
    if (state === "interrupted") value.channel_values.__interrupt__ = [{ value: "awaiting approval" }]
    if (state === "input") {
      metadata.source = "input"
      value.channel_values.__start__ = {
        messages: [{ id: "stopped-input", type: "human", content: "stopped before first node" }]
      }
    }
    await saver.put(config(thread), value, metadata)
  }
  try {
    await save("older-safe", 1)
    const secondBoundary = [
      { id: "second-user", type: "human", content: "second completed request" },
      { id: "second-assistant", type: "ai", content: "second completed answer" }
    ]
    await save("second-safe", 2, secondBoundary)
    for (let step = 3; step <= 5; step += 1) {
      await save("legacy-unsettled-" + step, step, secondBoundary, step === 5 ? "input" : "interrupted")
    }
    const openCheckpoint = saver.getTuple.bind(saver)
    let ownsRun = true
    saver.getTuple = async (runnableConfig) => {
      const tuple = await openCheckpoint(runnableConfig)
      ownsRun = false
      return tuple
    }
    await saver.captureLegacyForkCheckpointIds(thread, undefined, () => ownsRun)
    assert.equal(await saver.getLegacyForkCheckpointIds(thread), undefined)
    saver.getTuple = openCheckpoint
    await saver.captureLegacyForkCheckpointIds(thread)
    const working = { id: "user-working", type: "human", content: "working request" }
    for (let step = 6; step <= 13; step += 1) {
      await save("working-" + step, step, [
        ...secondBoundary,
        working,
        { id: "assistant-working-" + step, type: "ai", content: "partial reply" }
      ])
    }
    await saver.close()
    saver = new SqlJsSaver(file, undefined, options)
    await saver.captureLegacyForkCheckpointIds(thread)
    const legacyCheckpointIds = await saver.getLegacyForkCheckpointIds(thread)
    assert.deepEqual(legacyCheckpointIds, new Set(["second-safe", "older-safe"]))
    assert(await saver.hasCheckpoint(thread, "older-safe"), "the first run cannot evict the old point")
    const visible = async () => {
      const tuples: CheckpointTuple[] = []
      for await (const tuple of saver.list(config(thread))) tuples.push(tuple)
      return buildVisibleForkableCheckpointList(tuples, {
        activeRun: false,
        pendingApproval: false,
        legacyCheckpointIds,
        unsafeLatestCheckpointId: "working-13"
      }).map((checkpoint) => checkpoint.checkpointId)
    }
    assert.deepEqual(await visible(), ["second-safe", "older-safe"])
    await saver.updateCheckpointMetadata(config(thread), () =>
      makeInterruptedForkBoundaryMetadata("working-13", 13, "assistant-working-13")
    )
    await save("later-run", 14, [{ id: "user-later", type: "human", content: "later request" }])
    assert.deepEqual(await visible(), ["second-safe", "older-safe"])
  } finally {
    await saver.close()
  }
}

async function testUnusableStopsDoNotDisplaceStableArchive(dir: string): Promise<void> {
  const thread = "unusable-stops"
  const saver = new SqlJsSaver(join(dir, thread + ".sqlite"), undefined, {
    maxRootCheckpoints: 1,
    maxRootForkBoundaryCheckpoints: 1
  })
  try {
    await saver.put(
      config(thread), makeCheckpoint("safe", "2026-07-08T01:00:00.000Z"),
      makeForkBoundaryMetadata("safe")
    )
    const stopped = makeCheckpoint("stopped", "2026-07-08T01:01:00.000Z")
    stopped.channel_values.messages = [{ id: "user-stop", type: "human", content: "request only" }]
    await saver.put(config(thread, "safe"), stopped, makeInterruptedForkBoundaryMetadata("stopped"))
    await saver.put(
      config(thread, "stopped"), makeCheckpoint("new-run", "2026-07-08T01:02:00.000Z"),
      makeMetadata(3)
    )
    assert(await saver.hasCheckpoint(thread, "safe"))
    assert(!(await saver.hasCheckpoint(thread, "stopped")))
  } finally {
    await saver.close()
  }
}

async function testLegacyCompletionSurvivesMissingContinuationOrigin(dir: string): Promise<void> {
  for (const capture of [false, true]) {
    const thread = "legacy-missing-input-" + capture
    const saver = new SqlJsSaver(join(dir, thread + ".sqlite"), undefined, {
      maxRootCheckpoints: 2, maxRootForkBoundaryCheckpoints: 1
    })
    const before = [
      { id: "previous-user", type: "human", content: "completed request" },
      { id: "previous-answer", type: "ai", content: "completed reply" }
    ]
    const current = { id: "current-user", type: "human", content: "resumed request" }
    const stable = makeCheckpoint("stable", "2026-07-08T01:00:00.000Z")
    stable.channel_values = { messages: before, __pregel_tasks: [[], []] }
    const active = makeCheckpoint("active", "2026-07-08T01:01:00.000Z")
    active.channel_values = {
      messages: [...before, current, { id: "partial", type: "ai", content: "still in graph" }],
      __pregel_tasks: [[], []],
      "branch:to:afterModel": null
    }
    try {
      await saver.put(config(thread), stable, makeMetadata(1))
      await saver.put(config(thread, "missing-input"), active, makeMetadata(2))
      if (capture) {
        await saver.captureLegacyForkCheckpointIds(thread, null)
        assert.deepEqual(await saver.getLegacyForkCheckpointIds(thread), new Set(["stable"]))
      }
      const stopped = makeCheckpoint("stopped", "2026-07-08T01:02:00.000Z")
      stopped.channel_values.messages = [
        ...before, current, { id: "stop-reply", type: "ai", content: "stopped reply" }
      ]
      const metadata = makeInterruptedForkBoundaryMetadata("stopped", 3, "stop-reply")
      await saver.put(config(thread, "active"), stopped, {
        ...metadata,
        cmb_fork_boundary: {
          ...(metadata as Record<string, unknown>).cmb_fork_boundary as Record<string, unknown>,
          turnId: `resume:${thread}:1760000000000`
        }
      } as CheckpointMetadata)
      const next = makeCheckpoint("continue", "2026-07-08T01:03:00.000Z")
      next.channel_values.messages = [{ id: "next-user", type: "human", content: "next turn" }]
      await saver.put(config(thread, "stopped"), next, makeMetadata(4))
      assert(await saver.hasCheckpoint(thread, "stable"))
      assert(!(await saver.hasCheckpoint(thread, "active")))
      const tuples: CheckpointTuple[] = []
      for await (const tuple of saver.list(config(thread))) tuples.push(tuple)
      const listed = buildVisibleForkableCheckpointList(tuples, {
        activeRun: false,
        pendingApproval: false,
        legacyFallbackMode: "older_than_marker",
        legacyCheckpointIds: await saver.getLegacyForkCheckpointIds(thread)
      })
      assert.deepEqual(listed.map((point) => point.checkpointId), ["stopped", "stable"])
    } finally {
      await saver.close()
    }
  }
}

async function testDamagedHistoricalReplayDoesNotBlockRetention(dir: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite")
  const thread = "damaged-old-replay"
  const file = join(dir, thread + ".sqlite")
  let saver = new SqlJsSaver(file, undefined, { maxRootCheckpoints: 3 })
  await saver.put(config(thread), makeCheckpoint("damaged", "2026-07-08T01:00:00.000Z"), makeMetadata(1))
  const input = makeCheckpoint("old-input", "2026-07-08T01:01:00.000Z")
  input.channel_values.__start__ = { messages: [
    { id: "durable-reply", type: "ai", content: "replayed output" },
    { id: "new-user", type: "human", content: "new turn" }
  ] }
  await saver.put(config(thread, "damaged"), input, { ...makeMetadata(2), source: "input" })
  await saver.put(config(thread), makeCheckpoint("healthy", "2026-07-08T01:02:00.000Z"), makeMetadata(3))
  await saver.close()
  const database = new DatabaseSync(file)
  try {
    database.prepare("DELETE FROM checkpoint_message_snapshots WHERE checkpoint_id = ?").run("damaged")
  } finally {
    database.close()
  }
  saver = new SqlJsSaver(file, undefined, { maxRootCheckpoints: 3, maxRootForkBoundaryCheckpoints: 2 })
  try {
    assert.equal((await saver.getTuple(config(thread)))?.checkpoint.id, "healthy")
    await saver.captureLegacyForkCheckpointIds(thread)
    assert((await saver.getLegacyForkCheckpointIds(thread))?.has("healthy"))
    for (let minute = 3; minute <= 9; minute += 1) {
      const time = new Date(Date.UTC(2026, 6, 8, 1, minute)).toISOString()
      await saver.put(config(thread), makeCheckpoint("healthy-" + minute, time), makeMetadata(minute))
    }
    const ids: string[] = []
    for await (const tuple of saver.list(config(thread))) ids.push(tuple.checkpoint.id)
    assert(ids.length <= 5, "unreadable historical replay cannot disable root pruning")
    assert(ids.includes("healthy"))
    assert(!ids.includes("damaged") && !ids.includes("old-input"))
  } finally {
    await saver.close()
  }
}

async function testDamagedForkOriginDoesNotBlockGraphResume(dir: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite")
  const file = join(dir, "damaged-fork-origin.sqlite")
  const saver = new SqlJsSaver(file, undefined, { maxRootCheckpoints: 10 })
  const state = Annotation.Root({ messages: Annotation<BaseMessage[]>(), approved: Annotation<string>() })
  const graph = new StateGraph(state)
    .addNode("approval", () => ({ approved: interrupt<string>("approve") }))
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile({ checkpointer: saver })
  try {
    for (const column of ["metadata", "checkpoint"] as const) {
      const threadId = "bad-input-" + column
      const threadConfig = config(threadId)
      await graph.invoke({ messages: [new HumanMessage({ id: "first", content: "request" })] }, threadConfig)
      const latest = await saver.getTuple(threadConfig)
      assert(latest?.parentConfig && latest.pendingWrites?.length)
      const input = await saver.getTuple(latest.parentConfig)
      assert.equal(input?.metadata?.source, "input")
      assert(input)
      assert.equal(await saver.getForkTurnUserId(threadId, latest.checkpoint.id), "first")
      const database = new DatabaseSync(file)
      try {
        database.prepare(`UPDATE checkpoints SET ${column} = ? WHERE thread_id = ? AND checkpoint_id = ?`)
          .run("bad-json", threadId, input.checkpoint.id)
      } finally {
        database.close()
      }
      assert.equal(await saver.getForkTurnUserId(threadId, latest.checkpoint.id), undefined)
      const resumed = await graph.invoke(new Command({ resume: "approved" }), threadConfig)
      assert.equal(resumed.approved, "approved")
    }
  } finally {
    await saver.close()
  }
}

async function testInlineInterruptedMarkersOnlyDecodeWhenChanged(dir: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite")
  const file = join(dir, "inline-interrupted-marker-cache.sqlite")
  const thread = "legacy-inline-marker-cache"
  const saver = new SqlJsSaver(file, undefined, { maxRootCheckpoints: 1, maxRootForkBoundaryCheckpoints: 2 })
  const checkpoint = (id: string, minute: number) =>
    makeCheckpoint(id, new Date(Date.UTC(2026, 6, 8, 1, minute)).toISOString())
  try {
    await saver.initialize()
    // Isolate marker eligibility from old-era boundary inference.
    await saver.recordCopiedLegacyForkCheckpointIds(thread, [])
    const old = checkpoint("inline-stop", 0)
    old.channel_values.messages = [
      { id: "legacy-user", type: "human", content: "request" },
      { id: "legacy-answer", type: "ai", content: "x".repeat(100_000) }
    ]
    const metadata = makeInterruptedForkBoundaryMetadata(old.id, 0, "legacy-answer")
    const [type, payload] = await saver.serde.dumpsTyped(old)
    const [, encodedMetadata] = await saver.serde.dumpsTyped(metadata)
    const database = new DatabaseSync(file)
    try {
      database.prepare(`INSERT INTO checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata, checkpoint_ts, fork_boundary_marker)
        VALUES (?, '', ?, ?, ?, ?, ?, 1)`)
        .run(thread, old.id, type, payload, encodedMetadata, old.ts)
      let blobReads = 0
      const serde = saver.serde
      saver.serde = {
        dumpsTyped: (value) => serde.dumpsTyped(value),
        loadsTyped: (format, value) => {
          if (value.length === payload.length) blobReads += 1
          return serde.loadsTyped(format, value)
        }
      }
      for (let step = 1; step <= 3; step += 1) {
        await saver.put(config(thread), checkpoint("active-" + step, step), makeMetadata(step))
      }
      assert.equal(blobReads, 1, "unchanged inline marker must not deserialize on every root write")
      assert(await saver.hasCheckpoint(thread, old.id))

      // The same row and metadata can receive a new payload on another writer.
      old.channel_values.messages = [
        { id: "legacy-user", type: "human", content: "request without a reply" }
      ]
      const [, invalidPayload] = await serde.dumpsTyped(old)
      database.prepare("UPDATE checkpoints SET checkpoint = ? WHERE checkpoint_id = ?")
        .run(invalidPayload, old.id)
      await saver.put(config(thread), checkpoint("active-4", 4), makeMetadata(4))
      assert(!(await saver.hasCheckpoint(thread, old.id)), "external payload change invalidates cached eligibility")
    } finally {
      database.close()
    }
  } finally {
    await saver.close()
  }
}

async function testLegacyArchiveSurvivesEvictionOfAnOversizedMarker(dir: string): Promise<void> {
  const thread = "oversized-marker-handoff"
  const file = join(dir, thread + ".sqlite")
  let saver = new SqlJsSaver(file, undefined, { maxRootCheckpoints: 3 })
  try {
    await saver.put(config(thread), makeCheckpoint("legacy", "2026-07-08T01:00:00.000Z"), makeMetadata(1))
    const large = makeCheckpoint("large", "2026-07-08T01:01:00.000Z")
    large.channel_values.messages = [
      { id: "new-user", type: "human", content: "new prompt" },
      { id: "large-reply", type: "ai", content: "x".repeat(10_000) }
    ]
    await saver.put(config(thread), large, makeForkBoundaryMetadata("large"))
    await saver.close()
    saver = new SqlJsSaver(file, undefined, {
      maxRootCheckpoints: 1, maxRootForkBoundaryCheckpoints: 2, maxRootForkBoundaryBytes: 1_500
    })
    await saver.put(config(thread), makeCheckpoint("live", "2026-07-08T01:02:00.000Z"), makeMetadata(3))
    assert(!(await saver.hasCheckpoint(thread, "large")))
    assert(await saver.hasCheckpoint(thread, "legacy"))
    assert.deepEqual(await saver.getLegacyForkCheckpointIds(thread), new Set(["legacy"]))
  } finally {
    await saver.close()
  }
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

  const splitRetentionPath = join(dir, "split-retention.sqlite")
  const splitRetentionSaver = new SqlJsSaver(splitRetentionPath, undefined, {
    maxRootCheckpoints: 3,
    maxNonRootCheckpoints: 1
  })
  await splitRetentionSaver.put(config("split"), makeCheckpoint("root-1"), makeMetadata(1))
  await splitRetentionSaver.put(config("split", "root-1"), makeCheckpoint("root-2"), makeMetadata(2))
  await splitRetentionSaver.put(config("split", "root-2"), makeCheckpoint("root-3"), makeMetadata(3))
  await splitRetentionSaver.put(config("split", "root-3"), makeCheckpoint("root-4"), makeMetadata(4))
  await splitRetentionSaver.put(
    config("split", undefined, "tools:workflow-agent"),
    makeCheckpoint("tool-1"),
    makeMetadata(1)
  )
  await splitRetentionSaver.put(
    config("split", "tool-1", "tools:workflow-agent"),
    makeCheckpoint("tool-2"),
    makeMetadata(2)
  )
  await splitRetentionSaver.put(
    config("split", "tool-2", "tools:workflow-agent"),
    makeCheckpoint("tool-3"),
    makeMetadata(3)
  )

  const splitRootIds: string[] = []
  for await (const tuple of splitRetentionSaver.list(config("split"))) {
    splitRootIds.push(tuple.checkpoint.id)
  }
  const splitToolIds: string[] = []
  for await (const tuple of splitRetentionSaver.list(
    config("split", undefined, "tools:workflow-agent")
  )) {
    splitToolIds.push(tuple.checkpoint.id)
  }
  await splitRetentionSaver.close()

  assert.deepEqual(splitRootIds, ["root-4", "root-3", "root-2"])
  assert.deepEqual(splitToolIds, ["tool-3"])

  const forkBoundaryRetentionPath = join(dir, "fork-boundary-retention.sqlite")
  const forkBoundaryRetentionSaver = new SqlJsSaver(forkBoundaryRetentionPath, undefined, {
    maxRootCheckpoints: 2,
    maxRootForkBoundaryCheckpoints: 3,
    maxNonRootCheckpoints: 1
  })
  await forkBoundaryRetentionSaver.put(
    config("fork-retention"),
    makeCheckpoint("boundary-1", "2026-07-03T00:00:01.000Z"),
    makeForkBoundaryMetadata("boundary-1", 1)
  )
  await forkBoundaryRetentionSaver.put(
    config("fork-retention", "boundary-1"),
    makeCheckpoint("boundary-2", "2026-07-03T00:00:02.000Z"),
    makeForkBoundaryMetadata("boundary-2", 2)
  )
  await forkBoundaryRetentionSaver.put(
    config("fork-retention", "boundary-2"),
    makeCheckpoint("boundary-3", "2026-07-03T00:00:03.000Z"),
    makeForkBoundaryMetadata("boundary-3", 3)
  )
  await forkBoundaryRetentionSaver.put(
    config("fork-retention", "boundary-3"),
    makeCheckpoint("temp-4", "2026-07-03T00:00:04.000Z"),
    makeMetadata(4)
  )
  await forkBoundaryRetentionSaver.put(
    config("fork-retention", "temp-4"),
    makeCheckpoint("temp-5", "2026-07-03T00:00:05.000Z"),
    makeMetadata(5)
  )
  await forkBoundaryRetentionSaver.put(
    config("fork-retention", "temp-5"),
    makeCheckpoint("temp-6", "2026-07-03T00:00:06.000Z"),
    makeMetadata(6)
  )

  const retainedForkBoundaryIds: string[] = []
  for await (const tuple of forkBoundaryRetentionSaver.list(config("fork-retention"))) {
    retainedForkBoundaryIds.push(tuple.checkpoint.id)
  }
  await forkBoundaryRetentionSaver.close()

  assert.deepEqual(retainedForkBoundaryIds, [
    "temp-6",
    "temp-5",
    "boundary-3",
    "boundary-2",
    "boundary-1"
  ])
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

function testRepeatedTaskInvocationForkFilteringPreservesSidecarRefs(): void {
  const rawTaskId = "task-reused-at-fork"
  const firstTaskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "verifier", description: "first invocation" }
  }
  const secondTaskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "verifier", description: "second invocation" }
  }
  const firstParent = {
    id: "parent-first-task-invocation",
    type: "ai",
    content: "",
    tool_calls: [firstTaskCall]
  }
  const secondParent = {
    id: "parent-second-task-invocation",
    type: "ai",
    content: "",
    tool_calls: [secondTaskCall]
  }
  const firstInvocationScope = buildSubagentTaskInvocationIdentity({
    parentMessageId: firstParent.id,
    parentOccurrence: 1,
    parentContent: firstParent.content,
    parentToolCalls: firstParent.tool_calls,
    taskToolCallId: rawTaskId,
    taskToolCallIndex: 0,
    taskArgs: firstTaskCall.args
  })
  const secondInvocationScope = buildSubagentTaskInvocationIdentity({
    parentMessageId: secondParent.id,
    parentOccurrence: 1,
    parentContent: secondParent.content,
    parentToolCalls: secondParent.tool_calls,
    taskToolCallId: rawTaskId,
    taskToolCallIndex: 0,
    taskArgs: secondTaskCall.args
  })
  const firstExecutionId = rawTaskId
  const secondExecutionId = `${rawTaskId}::invocation-second`
  const firstContentRef = {
    v: 1,
    sha256: "1".repeat(64),
    bytes: 48_001,
    kind: "content"
  }
  const firstToolCallsRef = {
    v: 1,
    sha256: "2".repeat(64),
    bytes: 48_002,
    kind: "tool_calls"
  }
  const secondContentRef = {
    v: 1,
    sha256: "3".repeat(64),
    bytes: 48_003,
    kind: "content"
  }
  const secondToolCallsRef = {
    v: 1,
    sha256: "4".repeat(64),
    bytes: 48_004,
    kind: "tool_calls"
  }
  const sourceTranscripts = {
    [firstExecutionId]: [
      {
        id: `subagent-prompt-${firstExecutionId}`,
        role: "user",
        content: "first invocation",
        subagent_tool_call_id: rawTaskId,
        subagent_invocation_scope: firstInvocationScope
      },
      {
        id: `subagent-final-${firstExecutionId}`,
        role: "assistant",
        content: "first sidecar preview",
        content_ref: firstContentRef,
        tool_calls_ref: firstToolCallsRef
      }
    ],
    [secondExecutionId]: [
      {
        id: `subagent-prompt-${secondExecutionId}`,
        role: "user",
        content: "second invocation",
        subagent_tool_call_id: rawTaskId,
        subagent_invocation_scope: secondInvocationScope
      },
      {
        id: `subagent-final-${secondExecutionId}`,
        role: "assistant",
        content: "second sidecar preview",
        content_ref: secondContentRef,
        tool_calls_ref: secondToolCallsRef
      }
    ]
  }

  const firstBoundary = makeCheckpoint("cp-first-reused-task-boundary")
  ;(firstBoundary.channel_values as Record<string, unknown>).messages = [
    { id: "user-before-first-task", type: "human", content: "first" },
    firstParent,
    {
      id: "first-task-result",
      type: "tool",
      content: "first result",
      tool_call_id: rawTaskId,
      name: "task"
    }
  ]
  const secondBoundary = makeCheckpoint("cp-second-reused-task-boundary")
  ;(secondBoundary.channel_values as Record<string, unknown>).messages = [
    ...((firstBoundary.channel_values as Record<string, unknown>).messages as unknown[]),
    { id: "user-before-second-task", type: "human", content: "second" },
    secondParent,
    {
      id: "second-task-result",
      type: "tool",
      content: "second result",
      tool_call_id: rawTaskId,
      name: "task"
    }
  ]

  const bothFiltered = buildFilteredThreadValues(
    { subagentTranscripts: sourceTranscripts },
    deriveCheckpointTranscriptIndex(secondBoundary)
  ).subagentTranscripts as Record<string, Array<Record<string, unknown>>>
  assert.deepEqual(Object.keys(bothFiltered), [firstExecutionId, secondExecutionId])
  assert.deepEqual(bothFiltered[firstExecutionId][1].content_ref, firstContentRef)
  assert.deepEqual(bothFiltered[firstExecutionId][1].tool_calls_ref, firstToolCallsRef)
  assert.deepEqual(bothFiltered[secondExecutionId][1].content_ref, secondContentRef)
  assert.deepEqual(bothFiltered[secondExecutionId][1].tool_calls_ref, secondToolCallsRef)

  const firstOnlyFiltered = buildFilteredThreadValues(
    { subagentTranscripts: sourceTranscripts },
    deriveCheckpointTranscriptIndex(firstBoundary)
  ).subagentTranscripts as Record<string, Array<Record<string, unknown>>>
  assert.deepEqual(
    Object.keys(firstOnlyFiltered),
    [firstExecutionId],
    "forking at invocation one must not retain invocation two from the reused raw task ID"
  )
  assert.deepEqual(firstOnlyFiltered[firstExecutionId], sourceTranscripts[firstExecutionId])
  console.log("PASS repeated task invocation fork filtering preserves exact sidecar references")
}

function testIdlessTaskProviderAdoptionKeepsInvocationBucket(): void {
  const rawTaskId = "task-idless-provider-fork"
  const providerParentId = "provider-parent-after-idless-live"
  const taskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "verifier", description: "adopt provider parent" }
  }
  const providerSnapshotParent = {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: providerParentId,
      content: "",
      tool_calls: [taskCall],
      additional_kwargs: {}
    }
  }
  const invocationScope = buildSubagentTaskInvocationIdentity({
    parentMessageId: providerParentId,
    parentOccurrence: 1,
    parentContent: providerSnapshotParent.kwargs.content,
    parentToolCalls: providerSnapshotParent.kwargs.tool_calls,
    taskToolCallId: rawTaskId,
    taskToolCallIndex: 0,
    taskArgs: taskCall.args
  })
  const executionId = `${rawTaskId}::invocation-idless-live`
  const checkpoint = makeCheckpoint("cp-idless-provider-adoption")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [providerSnapshotParent]
  const index = deriveCheckpointTranscriptIndex(checkpoint)
  assert.deepEqual(index.subagentTranscriptInvocations, [
    { toolCallId: rawTaskId, invocationScope }
  ])

  const filtered = buildFilteredThreadValues(
    {
      subagentTranscripts: {
        [executionId]: [
          {
            id: `subagent-prompt-${executionId}`,
            role: "user",
            content: "adopt provider parent",
            subagent_tool_call_id: rawTaskId,
            subagent_invocation_scope: invocationScope
          }
        ]
      }
    },
    index
  ).subagentTranscripts as Record<string, unknown>
  assert.deepEqual(
    Object.keys(filtered),
    [executionId],
    "the values/provider identity adopted after an id-less live parent must keep its bucket"
  )
  console.log("PASS id-less task provider adoption shares the checkpoint invocation identity")
}

function testCrossRoleParentIdCollisionKeepsInvocationBucket(): void {
  const sharedParentId = "shared-human-and-task-parent-id"
  const rawTaskId = "task-cross-role-parent-fork"
  const taskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "verifier", description: "cross-role provider identity" }
  }
  const taskParent = {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: sharedParentId,
      content: "",
      tool_calls: [taskCall],
      additional_kwargs: {}
    }
  }
  const invocationScope = buildSubagentTaskInvocationIdentity({
    parentMessageId: sharedParentId,
    parentOccurrence: 1,
    parentContent: taskParent.kwargs.content,
    parentToolCalls: taskParent.kwargs.tool_calls,
    taskToolCallId: rawTaskId,
    taskToolCallIndex: 0,
    taskArgs: taskCall.args
  })
  const executionId = `${rawTaskId}::invocation-cross-role`
  const checkpoint = makeCheckpoint("cp-cross-role-parent-id")
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: sharedParentId, type: "human", content: "human owns the raw render id" },
    taskParent
  ]
  const index = deriveCheckpointTranscriptIndex(checkpoint)
  assert.notEqual(
    index.visibleMessages[1]?.renderId,
    sharedParentId,
    "the assistant should receive a collision-safe render ID"
  )
  assert.deepEqual(index.subagentTranscriptInvocations, [
    { toolCallId: rawTaskId, invocationScope }
  ])

  const filtered = buildFilteredThreadValues(
    {
      subagentTranscripts: {
        [executionId]: [
          {
            id: `subagent-prompt-${executionId}`,
            role: "user",
            content: "cross-role provider identity",
            subagent_tool_call_id: rawTaskId,
            subagent_invocation_scope: invocationScope
          }
        ]
      }
    },
    index
  ).subagentTranscripts as Record<string, unknown>
  assert.deepEqual(
    Object.keys(filtered),
    [executionId],
    "render-ID collision repair must not change the shared raw parent invocation identity"
  )
  console.log("PASS cross-role parent ID reuse keeps the shared invocation identity")
}

function testPersistedTranscriptFilteringUsesCheckpointBoundary(): void {
  const checkpoint = makeCheckpoint("cp-transcript-filter")
  const index = deriveCheckpointTranscriptIndex(checkpoint)
  const filtered = filterMessagesToCheckpointVisibleIds(
    [
      { id: "user-1", content: "hello" },
      { id: "assistant-1", content: "hi" },
      { id: "future-user", content: "future" },
      { id: "future-assistant", content: "future answer" }
    ],
    index
  )

  assert.deepEqual(
    filtered.map((message) => message.id),
    ["user-1", "assistant-1"],
    "durable transcript merge should ignore messages outside the checkpoint"
  )
  assert.deepEqual(
    filterMessagesToCheckpointVisibleIds([{ id: "future" }], {
      visibleMessageIds: []
    }),
    [],
    "an empty checkpoint transcript should not fall back to all persisted messages"
  )
  console.log("PASS persisted transcript filtering stays inside checkpoint visible ids")
}

function testMessagesAfterCheckpointVisibleIds(): void {
  const messages = [
    { id: "user-1", content: "hello" },
    { id: "assistant-1", content: "hi" },
    { id: "future-user", content: "future" },
    { id: "future-assistant", content: "future answer" }
  ]

  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(messages, ["user-1", "assistant-1"]).map(
      (message) => message.id
    ),
    ["future-user", "future-assistant"],
    "durable tail should start after the last checkpoint-visible id"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(messages, ["user-1", "assistant-1"], {
      excludeMessageIds: ["future-user"]
    }).map((message) => message.id),
    ["future-assistant"],
    "current-turn user ids can be excluded from runtime tail"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds([{ id: "future-user" }], [
      "user-1",
      "assistant-1"
    ]).map((message) => message.id),
    ["future-user"],
    "partial durable transcripts without checkpoint ids are all checkpoint tail"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds([{ id: "future-user" }], []).map(
      (message) => message.id
    ),
    [],
    "empty checkpoint transcripts do not create a runtime tail"
  )
  console.log("PASS durable tail detection follows checkpoint visible ids")
}

function testMessagesAfterCheckpointMatchesRoleScopedCollisionIdentity(): void {
  const sharedId = "checkpoint-role-collision"
  const checkpointMessages = [
    { id: sharedId, role: "user" },
    {
      id: buildMessageRoleCollisionId(sharedId, "assistant"),
      role: "assistant"
    }
  ]
  const persistedMessages = [
    { id: sharedId, role: "assistant", content: "database kept assistant raw" },
    {
      id: buildMessageRoleCollisionId(sharedId, "user"),
      role: "user",
      content: "database kept user synthetic"
    },
    { id: "future-assistant", role: "assistant", content: "durable tail" }
  ]

  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(persistedMessages, checkpointMessages).map(
      (message) => message.id
    ),
    ["future-assistant"],
    "checkpoint tail detection should match source id plus role when keepers differ"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(persistedMessages.slice(0, 2), checkpointMessages),
    [],
    "opposite raw-id keepers alone must not look like a durable tail"
  )

  const excludedUserId = "current-user-collision"
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(
      [
        ...persistedMessages.slice(0, 2),
        {
          id: buildMessageRoleCollisionId(excludedUserId, "user"),
          role: "user",
          content: "current user"
        }
      ],
      checkpointMessages,
      { excludeMessages: [{ id: excludedUserId, role: "user" }] }
    ),
    [],
    "current-turn exclusions should also match a role-scoped synthetic id"
  )
  console.log("PASS durable tail detection matches role-scoped collision identities")
}

function testMessagesAfterCheckpointDistinguishesSameRoleDuplicates(): void {
  const sharedId = "checkpoint-same-role-duplicate"
  const duplicateId = buildMessageSameRoleDuplicateId(sharedId, "assistant")
  const checkpointMessages = [{ id: sharedId, role: "assistant", renderId: sharedId }]
  const persistedMessages = [
    { id: sharedId, role: "assistant", content: "checkpoint assistant" },
    { id: duplicateId, role: "assistant", content: "later durable assistant" }
  ]

  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(persistedMessages, checkpointMessages).map(
      (message) => message.id
    ),
    [duplicateId],
    "a later same-role duplicate must remain a durable tail message"
  )

  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(persistedMessages, [
      ...checkpointMessages,
      { id: sharedId, role: "assistant", renderId: duplicateId }
    ]),
    [],
    "a same-role duplicate included by render id must remain inside the checkpoint boundary"
  )

  const canonicalFirstId = "checkpoint-canonical-first"
  const canonicalPersistedMessages = [
    { id: "checkpoint-canonical-user", role: "user", content: "question" },
    {
      id: canonicalFirstId,
      provider_source_id: sharedId,
      provider_occurrence: 1,
      role: "assistant",
      content: "checkpoint answer"
    },
    { id: "checkpoint-canonical-future-user", role: "user", content: "future" }
  ]
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(canonicalPersistedMessages, [
      { id: "checkpoint-canonical-user", role: "user" },
      { id: sharedId, role: "assistant" }
    ]).map((message) => message.id),
    ["checkpoint-canonical-future-user"],
    "a canonical render id with the same provider occurrence must remain inside the checkpoint"
  )
  const canonicalSecondId = "checkpoint-canonical-second"
  const canonicalOccurrences = [
    canonicalPersistedMessages[0],
    canonicalPersistedMessages[1],
    {
      id: canonicalSecondId,
      provider_source_id: sharedId,
      provider_occurrence: 2,
      role: "assistant",
      content: "later answer"
    }
  ]
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(canonicalOccurrences, [
      { id: "checkpoint-canonical-user", role: "user" },
      { id: sharedId, role: "assistant" }
    ]).map((message) => message.id),
    [canonicalSecondId],
    "a different provider occurrence must remain after an occurrence-one checkpoint boundary"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(canonicalOccurrences, [
      { id: "checkpoint-canonical-user", role: "user" },
      { id: sharedId, role: "assistant" },
      { id: duplicateId, role: "assistant" }
    ]),
    [],
    "checkpoint boundaries that include both provider occurrences must consume both aliases"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(canonicalOccurrences, [
      { id: "checkpoint-canonical-user", role: "user" }
    ], {
      excludeMessages: [{ id: sharedId, role: "assistant" }]
    }).map((message) => message.id),
    [canonicalSecondId],
    "provider-aware exclusions must remove only the matching occurrence"
  )
  assert.deepEqual(
    findMessagesAfterCheckpointVisibleIds(canonicalPersistedMessages, [
      "checkpoint-canonical-user",
      sharedId
    ]).map((message) => message.id),
    [canonicalFirstId, "checkpoint-canonical-future-user"],
    "legacy string boundaries must keep strict render-id semantics"
  )
  console.log("PASS durable tail detection distinguishes same-role duplicate identities")
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

function testRoleCollisionCheckpointForkTarget(): void {
  const sharedId = "fork-shared-provider-id"
  const assistantRenderId = buildMessageRoleCollisionId(sharedId, "assistant")
  const checkpoint = makeCheckpoint("cp-role-collision-fork") as Checkpoint
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: sharedId, type: "human", content: "question" },
    { id: sharedId, type: "ai", content: "answer" }
  ]

  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  assert.deepEqual(transcript.visibleMessageIds, [sharedId, sharedId])
  assert.deepEqual(
    transcript.visibleMessages.map((message) => message.renderId),
    [sharedId, assistantRenderId],
    "checkpoint transcript should expose the same role-scoped ids as the rendered chat"
  )

  const status = describeCheckpointMessageForkTarget(checkpoint, assistantRenderId)
  assert.equal(status.isForkableMessageBoundary, true)
  assert.equal(status.message?.id, sharedId)
  assert.equal(status.message?.rawIndex, 1)
  const filteredThreadValues = buildFilteredThreadValues(
    {
      messageTimes: {
        [sharedId]: { start_at: "2026-07-03T00:00:00.000Z" },
        [assistantRenderId]: { start_at: "2026-07-03T00:00:01.000Z" }
      },
      messageTimeOrder: [
        { id: sharedId, start_at: "2026-07-03T00:00:00.000Z" },
        { id: assistantRenderId, start_at: "2026-07-03T00:00:01.000Z" }
      ]
    },
    transcript
  )
  assert.deepEqual(
    Object.keys(filteredThreadValues.messageTimes as Record<string, unknown>),
    [sharedId, assistantRenderId],
    "fork thread values should retain times for both role-scoped render ids"
  )
  assert.deepEqual(
    (filteredThreadValues.messageTimeOrder as Array<{ id: string }>).map((entry) => entry.id),
    [sharedId, assistantRenderId]
  )
  assert.equal(
    isForkableCheckpointForMessage(
      makeTuple({
        checkpoint,
        metadata: makeForkBoundaryMetadata("cp-role-collision-fork", 1, sharedId)
      }),
      assistantRenderId
    ),
    true,
    "a raw checkpoint boundary marker should accept the assistant render id"
  )

  assert.equal(truncateCheckpointMessagesAfter(checkpoint, assistantRenderId), true)
  assert.equal(
    ((checkpoint.channel_values as Record<string, unknown>).messages as unknown[]).length,
    2,
    "truncating by a synthetic render id must select the assistant occurrence, not the first raw id"
  )
  console.log("PASS role-collision render ids resolve to the exact checkpoint fork boundary")
}

function testSameRoleDuplicateCheckpointForkTarget(): void {
  const sharedId = "fork-same-role-provider-id"
  const duplicateRenderId = buildMessageSameRoleDuplicateId(sharedId, "assistant")
  const checkpoint = makeCheckpoint("cp-same-role-duplicate-fork") as Checkpoint
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: sharedId, type: "ai", content: "first assistant chunk" },
    { id: sharedId, type: "ai", content: "second assistant chunk" }
  ]

  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  assert.deepEqual(
    transcript.visibleMessages.map((message) => message.renderId),
    [sharedId, duplicateRenderId],
    "same-role checkpoint occurrences need stable, independently addressable render ids"
  )
  const status = describeCheckpointMessageForkTarget(checkpoint, duplicateRenderId)
  assert.equal(status.isForkableMessageBoundary, true)
  assert.equal(status.message?.rawIndex, 1)
  assert.equal(truncateCheckpointMessagesAfter(checkpoint, duplicateRenderId), true)
  assert.equal(
    ((checkpoint.channel_values as Record<string, unknown>).messages as unknown[]).length,
    2,
    "fork truncation must resolve the second same-role occurrence by render id"
  )
  console.log("PASS same-role duplicate render ids resolve to exact checkpoint boundaries")
}

function testCurrentRunProviderTupleRestoresThirdOccurrenceForkTarget(): void {
  const providerId = "fork-current-run-provider"
  const stableId = "current-run-assistant:fork-stable"
  const thirdOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)
  const checkpoint = makeCheckpoint("cp-current-run-provider-tuple") as Checkpoint
  ;(checkpoint.channel_values as Record<string, unknown>).messages = [
    { id: "fork-current-user-1", type: "human", content: "first" },
    { id: providerId, type: "ai", content: "old answer" },
    { id: "fork-current-user-2", type: "human", content: "second" },
    {
      id: stableId,
      type: "ai",
      content: "first final",
      additional_kwargs: {
        cmb_internal_provider_source_id: providerId,
        cmb_internal_provider_occurrence: 2
      }
    },
    { id: "fork-current-user-3", type: "human", content: "guide" },
    { id: providerId, type: "ai", content: "guided answer" }
  ]

  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  const assistants = transcript.visibleMessages.filter((message) => message.role === "assistant")
  assert.deepEqual(
    assistants.map((message) => message.renderId),
    [providerId, stableId, thirdOccurrenceId],
    "checkpoint indexing must count the stable completed reply as provider occurrence two"
  )
  assert.equal(assistants[1]?.provider_source_id, providerId)
  assert.equal(assistants[1]?.provider_occurrence, 2)
  const status = describeCheckpointMessageForkTarget(checkpoint, thirdOccurrenceId)
  assert.equal(
    status.isForkableMessageBoundary,
    true,
    "the guided occurrence-three reply must resolve as the checkpoint fork boundary"
  )
  assert.equal(status.message?.rawIndex, 5)
  console.log("PASS current-run checkpoint tuples restore occurrence-three fork boundaries")
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
  assert.equal(status.isForkableMessageBoundary, false)
  assert.equal(status.reason, "not_checkpoint_tail")
  assert.equal(
    isForkableCheckpointForMessage(
      makeTuple({
        checkpoint: hiddenTail,
        metadata: makeForkBoundaryMetadata("cp-hidden-tail", 1, "assistant-1")
      }),
      "assistant-1"
    ),
    false
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
  console.log("PASS message fork requires a visible assistant boundary with no later raw tail")
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

  const interruptedBoundaryMetadata = {
    ...makeMetadata(2),
    cmb_fork_boundary: {
      version: 1,
      kind: "turn_complete",
      boundaryId: "turn_interrupted:source:cp-user-stopped",
      completedAt: "2026-07-03T00:00:02.000Z",
      source: "agent_run_interrupted",
      outcome: "interrupted",
      lastVisibleMessageId: "assistant-1"
    }
  } as CheckpointMetadata
  const userStoppedSummary = buildForkableCheckpointSummary(
    makeTuple({
      checkpoint: makeCheckpoint("cp-user-stopped"),
      metadata: interruptedBoundaryMetadata
    }),
    { activeRun: false, pendingApproval: false }
  )
  assert.equal(userStoppedSummary.isStableTurnBoundary, true)
  assert.equal(userStoppedSummary.boundarySource, "metadata_marker")
  assert.equal(userStoppedSummary.stableTurnId, "turn_interrupted:source:cp-user-stopped")

  const activeRunSummary = buildForkableCheckpointSummary(
    makeTuple({ checkpoint: makeCheckpoint("cp-active-run"), metadata: stableMetadata }),
    { activeRun: true, pendingApproval: false }
  )
  assert.equal(activeRunSummary.isStableTurnBoundary, false)
  assert.equal(activeRunSummary.unstableReason, "in_progress_turn")

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

  const interruptedPendingWritesSummary = buildForkableCheckpointSummary(
    makeTuple({
      checkpoint: makeCheckpoint("cp-user-stopped-pending"),
      metadata: interruptedBoundaryMetadata,
      pendingWrites: [["task-1", "messages", { abandonedByUserStop: true }]]
    }),
    { activeRun: false, pendingApproval: false }
  )
  assert.equal(interruptedPendingWritesSummary.isStableTurnBoundary, true)
  assert.equal(interruptedPendingWritesSummary.boundarySource, "metadata_marker")
  assert.equal(interruptedPendingWritesSummary.hasPendingWrites, true)

  const graphInterrupted = makeCheckpoint("cp-interrupt") as Checkpoint
  ;(graphInterrupted.channel_values as Record<string, unknown>).__interrupt__ = [{ value: {} }]
  const interruptedSummary = buildForkableCheckpointSummary(
    makeTuple({ checkpoint: graphInterrupted, metadata: interruptedBoundaryMetadata }),
    { activeRun: false, pendingApproval: false }
  )
  assert.equal(interruptedSummary.isStableTurnBoundary, false)
  assert.equal(interruptedSummary.unstableReason, "interrupt")
  assert.equal(interruptedSummary.hasInterrupt, true)
  console.log("PASS completed and user-stopped boundaries fork while graph interrupts remain gated")
}

function testVisibleForkableCheckpointList(): void {
  const hiddenTailDupe = makeCheckpoint("cp-dupe-hidden-newer") as Checkpoint
  ;(hiddenTailDupe.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "wf-trigger", type: "human", content: WORKFLOW_NOTIFICATION_TURN_PROMPT }
  ]

  const unique = makeCheckpoint("cp-unique") as Checkpoint
  ;(unique.channel_values as Record<string, unknown>).messages = [
    { id: "user-1", type: "human", content: "hello" },
    { id: "assistant-1", type: "ai", content: "hi" },
    { id: "user-2", type: "human", content: "next" },
    { id: "assistant-2", type: "ai", content: "later" }
  ]
  const interruptedToolTail = makeCheckpoint("cp-interrupted-tool-tail") as Checkpoint
  ;(interruptedToolTail.channel_values as Record<string, unknown>).messages = [
    { id: "user-stop", type: "human", content: "run tool" },
    {
      id: "assistant-stop",
      type: "ai",
      content: "running tool",
      tool_calls: [{ id: "tool-stop", name: "inspect", args: {} }]
    },
    {
      id: "tool-stop-result",
      type: "tool",
      content: "partial result before stop",
      tool_call_id: "tool-stop",
      name: "inspect"
    }
  ]

  const summaries = buildVisibleForkableCheckpointList(
    [
      makeTuple({
        checkpoint: interruptedToolTail,
        metadata: makeInterruptedForkBoundaryMetadata(
          "cp-interrupted-tool-tail",
          6,
          "tool-stop-result"
        )
      }),
      makeTuple({
        checkpoint: hiddenTailDupe,
        metadata: makeForkBoundaryMetadata("cp-dupe-hidden-newer", 5, "assistant-1")
      }),
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
    ["cp-interrupted-tool-tail", "cp-dupe-newer", "cp-unique"]
  )
  assert.ok(summaries.every((summary) => summary.isStableTurnBoundary))
  assert.equal(
    summaries.find((summary) => summary.checkpointId === "cp-interrupted-tool-tail")
      ?.messageForkMode,
    "checkpoint",
    "interrupted tool-tail checkpoints should be listed for whole-checkpoint fork"
  )

  const busySummaries = buildVisibleForkableCheckpointList(
    [
      makeTuple({
        checkpoint: unique,
        metadata: makeForkBoundaryMetadata("cp-unique", 1)
      })
    ],
    { activeRun: true, pendingApproval: false }
  )
  assert.deepEqual(
    busySummaries.map((summary) => summary.checkpointId),
    [],
    "UI forkable list should hide checkpoints while the thread is busy"
  )

  const currentUnmarked = makeCheckpoint("cp-current-unmarked") as Checkpoint
  ;(currentUnmarked.channel_values as Record<string, unknown>).messages = [
    { id: "user-current", type: "human", content: "current" },
    { id: "assistant-current", type: "ai", content: "current answer" }
  ]
  const markerEraBoundary = makeCheckpoint("cp-marker-era") as Checkpoint
  ;(markerEraBoundary.channel_values as Record<string, unknown>).messages = [
    { id: "user-marker", type: "human", content: "marker" },
    { id: "assistant-marker", type: "ai", content: "marker answer" }
  ]
  const legacyBoundary = makeCheckpoint("cp-legacy-history") as Checkpoint
  ;(legacyBoundary.channel_values as Record<string, unknown>).messages = [
    { id: "user-legacy", type: "human", content: "legacy" },
    { id: "assistant-legacy", type: "ai", content: "legacy answer" }
  ]
  const mixedSummaries = buildVisibleForkableCheckpointList(
    [
      makeTuple({ checkpoint: currentUnmarked, metadata: makeMetadata(4) }),
      makeTuple({
        checkpoint: markerEraBoundary,
        metadata: makeForkBoundaryMetadata("cp-marker-era", 3, "assistant-marker")
      }),
      makeTuple({ checkpoint: legacyBoundary, metadata: makeMetadata(2) })
    ],
    { activeRun: false, pendingApproval: false, legacyFallbackMode: "older_than_marker" }
  )
  assert.deepEqual(
    mixedSummaries.map((summary) => [summary.checkpointId, summary.boundarySource]),
    [
      ["cp-marker-era", "metadata_marker"],
      ["cp-legacy-history", "legacy_historical_idle_fallback"]
    ],
    "mixed marker-era lists should keep legacy history forkable but hide newer unmarked checkpoints"
  )
  console.log("PASS visible fork checkpoint list hides internal states and hidden raw tails")
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-fork-"))
  try {
    testCheckpointAuthorityMergeKeepsCompleteCheckpointContent()
    testReplayDoesNotRepeatMessagesAlreadyInTheCheckpoint()
    testDurableTranscriptMergeKeepsMessagesAfterCheckpoint()
    await testTupleCopyToNewThread(dir)
    await testConfigurableCheckpointRetention(dir)
    await testRetentionAfterFirstInterruptedMarker(dir)
    await testRetentionExcludesIntermediateSnapshotsOfFirstInterruptedTurn(dir)
    await testRetentionProtectsLegacyCheckpointsBeforeFirstMarker(dir)
    await testUnusableStopsDoNotDisplaceStableArchive(dir)
    await testLegacyCompletionSurvivesMissingContinuationOrigin(dir)
    await testDamagedHistoricalReplayDoesNotBlockRetention(dir)
    await testDamagedForkOriginDoesNotBlockGraphResume(dir)
    await testInlineInterruptedMarkersOnlyDecodeWhenChanged(dir)
    await testLegacyArchiveSurvivesEvictionOfAnOversizedMarker(dir)
    await testMetadataUpdatePreservesCheckpointShape(dir)
    testThreadValuesFiltering()
    testRepeatedTaskInvocationForkFilteringPreservesSidecarRefs()
    testIdlessTaskProviderAdoptionKeepsInvocationBucket()
    testCrossRoleParentIdCollisionKeepsInvocationBucket()
    testPersistedTranscriptFilteringUsesCheckpointBoundary()
    testMessagesAfterCheckpointVisibleIds()
    testMessagesAfterCheckpointMatchesRoleScopedCollisionIdentity()
    testMessagesAfterCheckpointDistinguishesSameRoleDuplicates()
    testWorkflowPlumbingFilteredFromTranscript()
    testCheckpointMessageTruncation()
    testRoleCollisionCheckpointForkTarget()
    testSameRoleDuplicateCheckpointForkTarget()
    testCurrentRunProviderTupleRestoresThirdOccurrenceForkTarget()
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
