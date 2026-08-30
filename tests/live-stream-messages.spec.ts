/**
 * Unit tests for live stream message accumulation.
 *
 * Run:
 *   npx tsx tests/live-stream-messages.spec.ts
 */

import {
  applyLiveStreamMessageIdAliases,
  liveStreamMessageRole,
  mergeLiveStreamCommitMessages,
  mergeLiveStreamMessages,
  normalizeAppendedLiveStreamMessageIds,
  normalizeLiveStreamMessageEntries,
  normalizeLiveStreamMessageContent,
  replaceLiveStreamMessageId,
  stringifyMessageContentForReport
} from "../src/renderer/src/lib/live-stream-messages.ts"
import {
  liveStreamMessageToStoreMessage,
  mergeDurableTranscriptSnapshot,
  resolveLiveStreamMessageEndAt,
  shouldSkipLiveStreamAccumulatorMessage
} from "../src/renderer/src/lib/live-stream-transcript.ts"
import type { Message } from "../src/renderer/src/types.ts"
import {
  clearChatReportUploadState,
  disableChatReportUploadForThread,
  markChatReportMessageIdsUploaded,
  markChatReportUploadFailed,
  markChatReportUploadSucceeded,
  reserveChatReportMessageIds
} from "../src/renderer/src/lib/chat-report-upload-cache.ts"
import {
  buildMessageSameRoleDuplicateId,
  normalizeAppendedMessageIds
} from "../src/shared/message-role-collision.ts"
import { mergeCheckpointAuthorityTranscriptMessages } from "../src/shared/checkpoint-transcript.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function testLaterSnapshotDoesNotDropEarlierToolMessage(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "tool-1",
        type: "tool",
        content: "read file result",
        tool_call_id: "call-1",
        name: "read_file"
      }
    ],
    [
      {
        id: "assistant-2",
        type: "ai",
        content: "continuing with the next step"
      }
    ]
  )

  assertEqual(merged.length, 2, "later snapshots should not replace earlier live messages")
  assertEqual(merged[0]?.id, "tool-1", "earlier tool message should stay in place")
  assertEqual(merged[1]?.id, "assistant-2", "later assistant message should be appended")
}

function testCrossRoleProviderIdCollisionStaysVisibleDuringStreaming(): void {
  const firstSnapshot = mergeLiveStreamMessages(
    [],
    [
      {
        id: "shared-provider-id",
        type: "ai",
        content: "calling tool",
        tool_calls: [{ id: "call-1", name: "read_file", args: {}, type: "tool_call" }]
      },
      {
        id: "shared-provider-id",
        type: "tool",
        content: "tool result",
        tool_call_id: "call-1",
        name: "read_file"
      }
    ]
  )

  assertEqual(firstSnapshot.length, 2, "cross-role provider ids must keep both live messages")
  assertEqual(
    new Set(firstSnapshot.map((message) => message.id)).size,
    2,
    "cross-role live messages must receive unique render ids"
  )
  assertEqual(
    firstSnapshot.map((message) => liveStreamMessageRole(message.type)).join(","),
    "assistant,tool",
    "cross-role live messages must keep their original roles"
  )

  const repeatedSnapshot = mergeLiveStreamMessages(firstSnapshot, [
    { id: "shared-provider-id", type: "ai", content: "calling tool" },
    {
      id: "shared-provider-id",
      type: "tool",
      content: "tool result updated",
      tool_call_id: "call-1"
    }
  ])

  assertEqual(repeatedSnapshot.length, 2, "repeated snapshots must not duplicate collisions")
  assertEqual(
    repeatedSnapshot.find((message) => message.type === "tool")?.content,
    "tool result updated",
    "the role-scoped collision row should continue receiving streamed updates"
  )
}

function testSameRoleProviderIdCollisionStaysVisibleDuringStreaming(): void {
  const sharedId = "same-role-provider-id"
  const firstSnapshot = mergeLiveStreamMessages(
    [],
    [
      { id: sharedId, type: "ai", content: "first assistant record" },
      { id: sharedId, type: "ai", content: "second assistant record" }
    ]
  )

  assertEqual(firstSnapshot.length, 2, "same-role provider ids must keep both live messages")
  assertEqual(firstSnapshot[0]?.id, sharedId, "the first occurrence should keep the provider id")
  assertEqual(
    firstSnapshot[1]?.id,
    buildMessageSameRoleDuplicateId(sharedId, "assistant"),
    "the second occurrence should receive a stable duplicate id"
  )

  const repeatedSnapshot = mergeLiveStreamMessages(firstSnapshot, [
    { id: sharedId, type: "ai", content: "first assistant record updated" },
    { id: sharedId, type: "ai", content: "second assistant record updated" }
  ])

  assertEqual(repeatedSnapshot.length, 2, "repeated snapshots must not duplicate same-role rows")
  assertEqual(
    repeatedSnapshot.map((message) => message.content).join("|"),
    "first assistant record updated|second assistant record updated",
    "each repeated snapshot occurrence must update its own row"
  )
}

function testSameRoleProviderIdCollisionSurvivesCommit(): void {
  const sharedId = "same-role-commit-id"
  const merged = mergeLiveStreamCommitMessages(
    [],
    [
      {
        id: sharedId,
        role: "assistant",
        content: "first committed assistant record",
        created_at: new Date("2026-07-21T02:00:00.000Z")
      },
      {
        id: sharedId,
        role: "assistant",
        content: "second committed assistant record",
        created_at: new Date("2026-07-21T02:00:01.000Z")
      }
    ]
  )

  assertEqual(merged.length, 2, "commit merging must preserve same-role duplicate records")
  assertEqual(
    merged[1]?.id,
    buildMessageSameRoleDuplicateId(sharedId, "assistant"),
    "the committed duplicate must keep the occurrence-scoped id"
  )
}

function testCommitRebasesAccumulatedMessageAgainstLatestRoleCollision(): void {
  const entries = normalizeLiveStreamMessageEntries(
    [{ id: "shared-commit-id", type: "human", content: "new user turn" }],
    [{ id: "shared-commit-id", type: "ai", content: "accumulated answer" }]
  )

  assertEqual(entries.length, 1, "the accumulated assistant must survive the final rebase")
  assertEqual(entries[0]?.sourceId, "shared-commit-id", "timing must stay keyed by the source id")
  assertEqual(
    entries[0]?.message.id,
    "shared-commit-id::cmb-id-collision:assistant",
    "the final commit id must use the latest committed role baseline"
  )
}

function testCommitMergesLatestContentWhenConcurrentStateAlreadyHasIdentity(): void {
  const sharedId = "concurrent-commit-id"
  const previous = [
    {
      id: sharedId,
      role: "user" as const,
      content: "user turn",
      created_at: new Date("2026-07-21T01:00:00.000Z")
    },
    {
      id: `${sharedId}::cmb-id-collision:assistant`,
      role: "assistant" as const,
      content: "partial answer",
      created_at: new Date("2026-07-21T01:00:01.000Z")
    }
  ]
  const merged = mergeLiveStreamCommitMessages(previous, [
    {
      id: sharedId,
      role: "assistant",
      content: "partial answer completed",
      created_at: new Date("2026-07-21T01:00:02.000Z")
    }
  ])

  assertEqual(merged.length, 2, "a concurrent commit must update instead of duplicate or drop")
  assertEqual(
    merged.find((message) => message.role === "assistant")?.content,
    "partial answer completed",
    "the final stream snapshot must replace the concurrent partial content"
  )
}

function testAuthoritativeCommitOverridesConcurrentDraft(): void {
  const previous = [
    {
      id: "authoritative-commit-id",
      role: "assistant" as const,
      content: "stale streamed draft that is longer than the final answer",
      tool_calls: [{ id: "call-stale", name: "read_file", args: {} }],
      created_at: new Date("2026-07-21T01:00:00.000Z")
    }
  ]
  const shortened = mergeLiveStreamCommitMessages(previous, [
    {
      id: "authoritative-commit-id",
      role: "assistant",
      content: "final",
      tool_calls: [],
      content_priority: 1,
      created_at: new Date("2026-07-21T01:00:01.000Z")
    }
  ])

  assertEqual(
    shortened[0]?.content,
    "final",
    "an authoritative final commit must replace a longer concurrent draft"
  )
  assertEqual(
    shortened[0]?.tool_calls?.length ?? 0,
    0,
    "an authoritative final commit must clear explicitly empty tool calls"
  )

  const cleared = mergeLiveStreamCommitMessages(previous, [
    {
      id: "authoritative-commit-id",
      role: "assistant",
      content: "",
      content_priority: 1,
      created_at: new Date("2026-07-21T01:00:02.000Z")
    }
  ])
  assertEqual(
    cleared[0]?.content,
    "",
    "an authoritative empty commit must clear stale assistant content"
  )
}

function testCommitKeepsSameRoleProviderIdReuseInLaterTurn(): void {
  const providerId = "later-turn-reused-provider-id"
  const merged = mergeLiveStreamCommitMessages(
    [
      {
        id: providerId,
        role: "assistant",
        content: "old answer",
        created_at: new Date("2026-07-21T02:00:00.000Z")
      },
      {
        id: "later-turn-user",
        role: "user",
        content: "new question",
        created_at: new Date("2026-07-21T02:00:01.000Z")
      }
    ],
    [
      {
        id: providerId,
        role: "assistant",
        content: "new answer",
        created_at: new Date("2026-07-21T02:00:02.000Z")
      }
    ]
  )

  assertEqual(merged.length, 3, "a later turn must keep both same-id assistant occurrences")
  assertEqual(
    merged.map((message) => message.content).join("|"),
    "old answer|new question|new answer",
    "the new assistant occurrence must remain after its user boundary"
  )
}

function testIncrementalStreamKeepsSameRoleProviderIdReuseInLaterTurn(): void {
  const providerId = "later-turn-incremental-provider-id"
  const normalized = normalizeAppendedLiveStreamMessageIds(
    [
      { id: providerId, type: "ai", content: "old answer" },
      { id: "later-turn-user", type: "human", content: "new question" }
    ],
    [{ id: providerId, type: "ai", content: "new answer" }]
  )

  assertEqual(normalized.length, 1, "the current incremental assistant should remain visible")
  assertEqual(
    normalized[0]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant"),
    "messages-mode accumulation must target the current turn occurrence"
  )
}

function testIncrementalToolProviderIdReuseAfterAssistantBoundary(): void {
  const providerToolId = "reused-incremental-tool-provider-id"
  const previous = [
    { id: "tool-reuse-user", type: "human", content: "run tools" },
    {
      id: "tool-reuse-assistant-one",
      type: "ai",
      content: "first call",
      tool_calls: [{ id: "tool-reuse-call-1", name: "read_file", args: {} }]
    },
    {
      id: providerToolId,
      type: "tool",
      content: "first result",
      tool_call_id: "tool-reuse-call-1"
    },
    {
      id: "tool-reuse-assistant-two",
      type: "ai",
      content: "second call",
      tool_calls: [{ id: "tool-reuse-call-2", name: "read_file", args: {} }]
    }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    {
      id: providerToolId,
      type: "tool",
      content: "second result",
      tool_call_id: "tool-reuse-call-2"
    }
  ])
  const secondOccurrenceId = buildMessageSameRoleDuplicateId(providerToolId, "tool", 2)

  assertEqual(
    normalized[0]?.id,
    secondOccurrenceId,
    "a reused tool provider id after an assistant boundary must append a new occurrence"
  )
  assertEqual(
    normalized[0]?.provider_occurrence,
    2,
    "the appended tool result must retain its explicit occurrence"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 5, "both reused tool result occurrences must remain visible")
  assertEqual(merged[2]?.content, "first result", "the first tool result must not be overwritten")
  assertEqual(merged[4]?.content, "second result", "the second tool result must append")
}

function testFullReplayUpdatesToolsAcrossAssistantBoundary(): void {
  const providerToolId = "full-replay-tool-provider-id"
  const secondToolId = buildMessageSameRoleDuplicateId(providerToolId, "tool", 2)
  const previous = [
    { id: "full-replay-user", type: "human", content: "run both" },
    { id: "full-replay-assistant-one", type: "ai", content: "first call" },
    {
      id: providerToolId,
      type: "tool",
      content: "old first result",
      tool_call_id: "full-replay-call-1"
    },
    { id: "full-replay-assistant-two", type: "ai", content: "second call" },
    {
      id: secondToolId,
      provider_source_id: providerToolId,
      provider_occurrence: 2,
      type: "tool",
      content: "old second result",
      tool_call_id: "full-replay-call-2"
    }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    { id: "full-replay-user", type: "human", content: "run both" },
    { id: "full-replay-assistant-one", type: "ai", content: "first call" },
    {
      id: providerToolId,
      type: "tool",
      content: "new first result",
      tool_call_id: "full-replay-call-1"
    },
    { id: "full-replay-assistant-two", type: "ai", content: "second call" },
    {
      id: providerToolId,
      type: "tool",
      content: "new second result",
      tool_call_id: "full-replay-call-2"
    }
  ])
  const normalizedTools = normalized.filter((message) => message.type === "tool")
  assertEqual(
    normalizedTools.map((message) => message.id).join("|"),
    `${providerToolId}|${secondToolId}`,
    "a full replay must align both reused tool occurrences across an assistant boundary"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 5, "a full replay must not invent a third tool occurrence")
  assertEqual(merged[2]?.content, "new first result", "the first replayed tool must update")
  assertEqual(merged[4]?.content, "new second result", "the second replayed tool must update")
}

function testSparseUserToolAppendDoesNotMasqueradeAsFullReplay(): void {
  const providerToolId = "sparse-user-tool-provider-id"
  const previous = [
    { id: "sparse-user-tool-user", type: "human", content: "run tools" },
    { id: "sparse-user-tool-assistant-one", type: "ai", content: "first call" },
    {
      id: providerToolId,
      type: "tool",
      content: "first result",
      tool_call_id: "sparse-user-tool-reused-call"
    },
    { id: "sparse-user-tool-assistant-two", type: "ai", content: "second call" }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    { id: "sparse-user-tool-user", type: "human", content: "run tools" },
    {
      id: providerToolId,
      type: "tool",
      content: "second result",
      tool_call_id: "sparse-user-tool-reused-call"
    }
  ])
  const normalizedTool = normalized.find((message) => message.type === "tool")

  assertEqual(
    normalizedTool?.id,
    buildMessageSameRoleDuplicateId(providerToolId, "tool", 2),
    "a sparse user+tool append must not overwrite a tool before an omitted assistant"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 5, "the sparse later tool result must append")
  assertEqual(merged[2]?.content, "first result", "the historical tool result must remain")
  assertEqual(merged[4]?.content, "second result", "the sparse later tool result must be visible")
}

function testDifferentAssistantOccurrenceCannotCoverSparseToolBoundary(): void {
  const providerToolId = "sparse-occurrence-tool-provider-id"
  const assistantProviderId = "sparse-occurrence-assistant-provider-id"
  const previous = [
    { id: "sparse-occurrence-user", type: "human", content: "run tools" },
    {
      id: providerToolId,
      provider_source_id: providerToolId,
      provider_occurrence: 1,
      type: "tool",
      content: "first result",
      tool_call_id: "sparse-occurrence-reused-call"
    },
    {
      id: "sparse-occurrence-assistant-one",
      provider_source_id: assistantProviderId,
      provider_occurrence: 1,
      type: "ai",
      content: "after first result"
    }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    { id: "sparse-occurrence-user", type: "human", content: "run tools" },
    {
      id: "sparse-occurrence-assistant-two",
      provider_source_id: assistantProviderId,
      provider_occurrence: 2,
      type: "ai",
      content: "before second result"
    },
    {
      id: providerToolId,
      type: "tool",
      content: "second result",
      tool_call_id: "sparse-occurrence-reused-call"
    }
  ])
  const normalizedTool = normalized.find((message) => message.type === "tool")

  assertEqual(
    normalizedTool?.id,
    buildMessageSameRoleDuplicateId(providerToolId, "tool", 2),
    "a different assistant occurrence must not cover the boundary after an earlier tool"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 5, "both assistant and tool occurrences must remain visible")
  assertEqual(merged[1]?.content, "first result", "the historical tool result must remain")
  assertEqual(merged[4]?.content, "second result", "the later tool result must append")
}

function testEarlierIncomingAssistantCannotCoverSparseToolBoundary(): void {
  const providerToolId = "ordered-sparse-tool-provider-id"
  const assistantProviderId = "ordered-sparse-assistant-provider-id"
  const previous = [
    { id: "ordered-sparse-user", type: "human", content: "run tools" },
    { id: "ordered-sparse-call", type: "ai", content: "first call" },
    {
      id: providerToolId,
      provider_source_id: providerToolId,
      provider_occurrence: 1,
      type: "tool",
      content: "first result",
      tool_call_id: "ordered-sparse-reused-call"
    },
    {
      id: "ordered-sparse-after",
      provider_source_id: assistantProviderId,
      provider_occurrence: 1,
      type: "ai",
      content: "after first result"
    }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    { id: "ordered-sparse-user", type: "human", content: "run tools" },
    {
      id: "ordered-sparse-after",
      provider_source_id: assistantProviderId,
      provider_occurrence: 1,
      type: "ai",
      content: "after first result"
    },
    {
      id: providerToolId,
      type: "tool",
      content: "second result",
      tool_call_id: "ordered-sparse-reused-call"
    }
  ])
  const normalizedTool = normalized.find((message) => message.type === "tool")

  assertEqual(
    normalizedTool?.id,
    buildMessageSameRoleDuplicateId(providerToolId, "tool", 2),
    "an assistant before the incoming tool cannot prove a full replay across that boundary"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 5, "the sparse later tool occurrence must remain distinct")
  assertEqual(merged[2]?.content, "first result", "the historical tool result must remain")
  assertEqual(merged[4]?.content, "second result", "the sparse later tool result must append")
}

function testExactLiveToolReplayAfterAssistantIsIdempotent(): void {
  const previous = [
    { id: "live-tool-replay-user", type: "human", content: "question" },
    {
      id: "live-tool-replay-call",
      type: "ai",
      content: "calling",
      tool_calls: [{ id: "live-tool-replay-call-id", name: "read_file", args: {} }]
    },
    {
      id: "live-tool-replay-result",
      type: "tool",
      tool_call_id: "live-tool-replay-call-id",
      content: "result"
    },
    { id: "live-tool-replay-final", type: "ai", content: "done" }
  ]
  const replay = normalizeAppendedLiveStreamMessageIds(previous, [
    {
      id: "live-tool-replay-result",
      type: "tool",
      tool_call_id: "live-tool-replay-call-id",
      content: "result"
    }
  ])
  assertEqual(
    replay[0]?.id,
    "live-tool-replay-result",
    "an exact live tool replay after a final assistant must update occurrence one"
  )
  assertEqual(
    mergeLiveStreamMessages(previous, replay).length,
    4,
    "an exact live tool replay must not append a duplicate result"
  )

  const afterRepeatedCall = [
    ...previous.slice(0, 3),
    {
      id: "live-tool-replay-call-two",
      type: "ai",
      content: "calling again",
      tool_calls: [
        { id: "live-tool-replay-call-id", name: "read_file", args: { path: "two" } }
      ]
    }
  ]
  const newResult = normalizeAppendedLiveStreamMessageIds(afterRepeatedCall, [
    {
      id: "live-tool-replay-result",
      type: "tool",
      tool_call_id: "live-tool-replay-call-id",
      content: "second result"
    }
  ])
  assertEqual(
    newResult[0]?.id,
    buildMessageSameRoleDuplicateId("live-tool-replay-result", "tool", 2),
    "a repeated call after the old tool result must append occurrence two"
  )
}

function testExplicitProviderOccurrenceCannotRetargetEarlierAlias(): void {
  const sourceId = "explicit-occurrence-alias-source"
  const sharedNormalized = normalizeAppendedMessageIds(
    [
      {
        id: "explicit-occurrence-alias-one",
        provider_source_id: sourceId,
        provider_occurrence: 1,
        role: "assistant",
        content: "one"
      }
    ],
    [
      {
        id: "explicit-occurrence-alias-two",
        provider_source_id: sourceId,
        provider_occurrence: 2,
        role: "assistant",
        content: "two"
      }
    ]
  )
  const liveNormalized = normalizeAppendedLiveStreamMessageIds(
    [
      {
        id: "explicit-occurrence-alias-one",
        provider_source_id: sourceId,
        provider_occurrence: 1,
        type: "ai",
        content: "one"
      }
    ],
    [
      { type: "ai", content: "id-less prefix" },
      {
        id: "explicit-occurrence-alias-two",
        provider_source_id: sourceId,
        provider_occurrence: 2,
        type: "ai",
        content: "two"
      },
      { type: "ai", content: "id-less middle" },
      {
        id: "explicit-occurrence-alias-three",
        provider_source_id: sourceId,
        provider_occurrence: 3,
        type: "ai",
        content: "three"
      }
    ]
  )

  assertEqual(
    sharedNormalized[0]?.id,
    buildMessageSameRoleDuplicateId(sourceId, "assistant", 2),
    "shared append normalization must not retarget an explicit second occurrence"
  )
  assertEqual(
    sharedNormalized[0]?.provider_occurrence,
    2,
    "shared append normalization must retain the declared occurrence"
  )
  assertEqual(
    liveNormalized[0]?.id,
    buildMessageSameRoleDuplicateId(sourceId, "assistant", 2),
    "live append normalization must not retarget an explicit second occurrence"
  )
  assertEqual(
    liveNormalized[0]?.provider_occurrence,
    2,
    "live append normalization must retain the declared occurrence"
  )
  assertEqual(
    liveNormalized[1]?.id,
    buildMessageSameRoleDuplicateId(sourceId, "assistant", 3),
    "id-less entries must not shift a later declared occurrence"
  )
  assertEqual(
    liveNormalized[1]?.provider_occurrence,
    3,
    "a later declared occurrence must retain its identity after id-less entries"
  )
}

function testExplicitProviderTupleConflictCannotMergeByRenderId(): void {
  const previous: Message[] = [
    {
      id: "tuple-conflict-render-id",
      provider_source_id: "tuple-conflict-provider-a",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer A",
      created_at: new Date()
    }
  ]
  const incoming: Message[] = [
    {
      id: "tuple-conflict-render-id",
      provider_source_id: "tuple-conflict-provider-b",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer B",
      created_at: new Date()
    }
  ]
  const normalized = normalizeAppendedMessageIds(previous, incoming)
  assertEqual(
    normalized[0]?.id !== previous[0]?.id,
    true,
    "an explicit provider tuple conflict must receive a distinct render id"
  )
  const committed = mergeLiveStreamCommitMessages(previous, incoming)
  assertEqual(committed.length, 2, "commit must preserve both conflicting provider tuples")
  assertEqual(
    new Set(committed.map((message) => message.id)).size,
    2,
    "conflicting provider tuples must retain unique render ids"
  )
  assertEqual(
    committed.map((message) => message.content).join("|"),
    "answer A|answer B",
    "commit must not overwrite or concatenate different provider tuples"
  )
  const replayed = mergeLiveStreamCommitMessages(committed, incoming)
  assertEqual(replayed.length, 2, "replaying a conflicting provider tuple must be idempotent")
  assertEqual(
    replayed.map((message) => message.id).join("|"),
    committed.map((message) => message.id).join("|"),
    "provider tuple replay must retain stable render ids"
  )
}

function testExplicitProviderTupleInvariantsAcrossCompleteEntrypoints(): void {
  const duplicateTuple: Message[] = [
    {
      id: "duplicate-tuple-alias-a",
      provider_source_id: "duplicate-tuple-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "draft",
      created_at: new Date()
    },
    {
      id: "duplicate-tuple-alias-b",
      provider_source_id: "duplicate-tuple-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "done",
      created_at: new Date()
    }
  ]
  const liveDuplicateTuple = duplicateTuple.map((message) => ({
    id: message.id,
    provider_source_id: message.provider_source_id,
    provider_occurrence: message.provider_occurrence,
    type: "ai",
    content: message.content
  }))
  assertEqual(
    mergeLiveStreamMessages([], liveDuplicateTuple).length,
    1,
    "live complete snapshots must coalesce aliases for one explicit provider tuple"
  )
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(duplicateTuple, []).length,
    1,
    "checkpoint baselines must coalesce aliases for one explicit provider tuple"
  )
  assertEqual(
    mergeLiveStreamCommitMessages(duplicateTuple, []).length,
    1,
    "commit baselines must coalesce aliases for one explicit provider tuple"
  )

  const reversed: Message[] = [
    {
      id: "reversed-tuple-two",
      provider_source_id: "reversed-tuple-source",
      provider_occurrence: 2,
      role: "assistant",
      content: "two",
      created_at: new Date()
    },
    {
      id: "reversed-tuple-one",
      provider_source_id: "reversed-tuple-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "one",
      created_at: new Date()
    }
  ]
  const expectedOccurrences = "1|2"
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(reversed, [])
      .map((message) => message.provider_occurrence)
      .join("|"),
    expectedOccurrences,
    "checkpoint baseline restore must order explicit provider occurrences"
  )
  assertEqual(
    mergeLiveStreamCommitMessages(reversed, [])
      .map((message) => message.provider_occurrence)
      .join("|"),
    expectedOccurrences,
    "commit baseline restore must order explicit provider occurrences"
  )
  assertEqual(
    mergeLiveStreamMessages(
      reversed.map((message) => ({
        id: message.id,
        provider_source_id: message.provider_source_id,
        provider_occurrence: message.provider_occurrence,
        type: "ai",
        content: message.content
      })),
      []
    )
      .map((message) => message.provider_occurrence)
      .join("|"),
    expectedOccurrences,
    "live baseline restore must order explicit provider occurrences"
  )
}

function testProviderOccurrenceOrderingPreservesUserTurnSegments(): void {
  const providerId = "turn-owned-occurrence-provider"
  const persisted: Message[] = [
    {
      id: "turn-owned-user-one",
      role: "user",
      content: "question one",
      created_at: new Date()
    },
    {
      id: "turn-owned-answer-two",
      provider_source_id: providerId,
      provider_occurrence: 2,
      role: "assistant",
      content: "answer two",
      created_at: new Date()
    },
    {
      id: "turn-owned-user-two",
      role: "user",
      content: "question two",
      created_at: new Date()
    },
    {
      id: "turn-owned-answer-one",
      provider_source_id: providerId,
      provider_occurrence: 1,
      role: "assistant",
      content: "answer one",
      created_at: new Date()
    }
  ]
  const live = persisted.map((message) => ({
    id: message.id,
    provider_source_id: message.provider_source_id,
    provider_occurrence: message.provider_occurrence,
    type: message.role === "user" ? "human" : "ai",
    content: message.content
  }))
  const expected = "question one|answer two|question two|answer one"
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(persisted, [])
      .map((message) => message.content)
      .join("|"),
    expected,
    "checkpoint restore must not move an existing answer across its user boundary"
  )
  assertEqual(
    mergeLiveStreamCommitMessages(persisted, [])
      .map((message) => message.content)
      .join("|"),
    expected,
    "commit restore must not move an existing answer across its user boundary"
  )
  assertEqual(
    mergeLiveStreamMessages(live, [])
      .map((message) => message.content)
      .join("|"),
    expected,
    "live restore must not move an existing answer across its user boundary"
  )

  const earlierTurn = persisted.slice(0, 2)
  const laterTurn = persisted.slice(2)
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(earlierTurn, laterTurn)
      .map((message) => message.content)
      .join("|"),
    expected,
    "checkpoint append must keep a new user/assistant segment intact"
  )
  assertEqual(
    mergeLiveStreamCommitMessages(earlierTurn, laterTurn)
      .map((message) => message.content)
      .join("|"),
    expected,
    "commit append must keep a new user/assistant segment intact"
  )
  const earlierLive = live.slice(0, 2)
  const laterLive = live.slice(2)
  assertEqual(
    mergeLiveStreamMessages(
      earlierLive,
      normalizeAppendedLiveStreamMessageIds(earlierLive, laterLive)
    )
      .map((message) => message.content)
      .join("|"),
    expected,
    "live append must keep a new user/assistant segment intact"
  )

  const tupleDraft = [
    {
      id: "live-tuple-draft",
      provider_source_id: "live-tuple-source",
      provider_occurrence: 1,
      type: "ai",
      content: "draft"
    }
  ]
  const tupleFinal = [
    {
      id: "live-tuple-final",
      provider_source_id: "live-tuple-source",
      provider_occurrence: 1,
      type: "ai",
      content: "done"
    }
  ]
  assertEqual(
    mergeLiveStreamMessages(tupleDraft, tupleFinal).length,
    1,
    "live sparse merge must coalesce aliases for one explicit provider tuple"
  )
  assertEqual(
    mergeLiveStreamMessages([...tupleDraft, ...tupleFinal], []).length,
    1,
    "live empty merge must heal legacy aliases for one explicit provider tuple"
  )

  const lateTurnBase: Message[] = [
    {
      id: "backfill-user-three",
      role: "user",
      content: "question three",
      created_at: new Date()
    },
    {
      id: "backfill-answer-three",
      provider_source_id: "backfill-provider",
      provider_occurrence: 3,
      role: "assistant",
      content: "answer three",
      created_at: new Date()
    }
  ]
  const completeBackfill: Message[] = [
    {
      id: "backfill-user-one",
      role: "user",
      content: "question one",
      created_at: new Date()
    },
    {
      id: "backfill-answer-one",
      provider_source_id: "backfill-provider",
      provider_occurrence: 1,
      role: "assistant",
      content: "answer one",
      created_at: new Date()
    },
    {
      id: "backfill-user-two",
      role: "user",
      content: "question two",
      created_at: new Date()
    },
    {
      id: "backfill-answer-two",
      provider_source_id: "backfill-provider",
      provider_occurrence: 2,
      role: "assistant",
      content: "answer two",
      created_at: new Date()
    },
    ...lateTurnBase
  ]
  const expectedBackfill =
    "question one|answer one|question two|answer two|question three|answer three"
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(lateTurnBase, completeBackfill)
      .map((message) => message.content)
      .join("|"),
    expectedBackfill,
    "checkpoint complete backfill must restore whole-turn snapshot order"
  )
  assertEqual(
    mergeLiveStreamCommitMessages(lateTurnBase, completeBackfill)
      .map((message) => message.content)
      .join("|"),
    expectedBackfill,
    "commit complete backfill must restore whole-turn snapshot order"
  )

  const externalSystem: Message = {
    id: "backfill-external-system",
    role: "system",
    content: "system anchor",
    created_at: new Date()
  }
  const expectedAnchoredBackfill = `system anchor|${expectedBackfill}`
  const liveBackfill = (messages: readonly Message[]) =>
    messages.map((message) => ({
      id: message.id,
      provider_source_id: message.provider_source_id,
      provider_occurrence: message.provider_occurrence,
      type: message.role === "user" ? "human" : message.role === "system" ? "system" : "ai",
      content: message.content
    }))
  assertEqual(
    mergeLiveStreamMessages(
      liveBackfill([externalSystem, ...lateTurnBase]),
      liveBackfill(completeBackfill)
    )
      .map((message) => message.content)
      .join("|"),
    expectedAnchoredBackfill,
    "live complete backfill must preserve a snapshot-external system anchor"
  )
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(
      [externalSystem, ...lateTurnBase],
      completeBackfill
    )
      .map((message) => message.content)
      .join("|"),
    expectedAnchoredBackfill,
    "checkpoint complete backfill must preserve a snapshot-external system anchor"
  )
  assertEqual(
    mergeLiveStreamCommitMessages([externalSystem, ...lateTurnBase], completeBackfill)
      .map((message) => message.content)
      .join("|"),
    expectedAnchoredBackfill,
    "commit complete backfill must preserve a snapshot-external system anchor"
  )

  const checkpointAliasSource = "checkpoint-order-alias-provider"
  const checkpointAliasBase: Message[] = [
    {
      id: "checkpoint-alias-left-system",
      role: "system",
      content: "left system",
      created_at: new Date()
    },
    {
      id: "checkpoint-alias-baseline-answer",
      provider_source_id: checkpointAliasSource,
      provider_occurrence: 1,
      role: "assistant",
      content: "old anchored answer",
      created_at: new Date()
    },
    {
      id: "checkpoint-alias-right-system",
      role: "system",
      content: "right system",
      created_at: new Date()
    }
  ]
  const checkpointAliasIncoming: Message[] = [
    {
      id: "checkpoint-alias-inserted-user",
      role: "user",
      content: "inserted question",
      created_at: new Date()
    },
    {
      id: "checkpoint-alias-incoming-answer",
      provider_source_id: checkpointAliasSource,
      provider_occurrence: 1,
      role: "assistant",
      content: "old anchored answer expanded",
      created_at: new Date()
    }
  ]
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(
      checkpointAliasBase,
      checkpointAliasIncoming
    )
      .map((message) => message.content)
      .join("|"),
    "left system|inserted question|old anchored answer expanded|right system",
    "a unique same-role provider tuple alias must remain a checkpoint order anchor"
  )

  const completeAliasBase: Message[] = [
    {
      id: "complete-alias-user-three",
      provider_source_id: "complete-alias-user-provider",
      provider_occurrence: 3,
      role: "user",
      content: "alias question three",
      created_at: new Date()
    },
    {
      id: "complete-alias-answer-three",
      provider_source_id: "complete-alias-answer-provider",
      provider_occurrence: 3,
      role: "assistant",
      content: "alias answer three",
      created_at: new Date()
    }
  ]
  const completeAliasBackfill: Message[] = [
    ...[1, 2].flatMap((occurrence) => [
      {
        id: `complete-alias-user-${occurrence}`,
        provider_source_id: "complete-alias-user-provider",
        provider_occurrence: occurrence,
        role: "user" as const,
        content: `alias question ${occurrence}`,
        created_at: new Date()
      },
      {
        id: `complete-alias-answer-${occurrence}`,
        provider_source_id: "complete-alias-answer-provider",
        provider_occurrence: occurrence,
        role: "assistant" as const,
        content: `alias answer ${occurrence}`,
        created_at: new Date()
      }
    ]),
    {
      ...completeAliasBase[0],
      id: "complete-alias-user-three-alias"
    },
    {
      ...completeAliasBase[1],
      id: "complete-alias-answer-three-alias"
    }
  ]
  assertEqual(
    mergeCheckpointAuthorityTranscriptMessages(completeAliasBase, completeAliasBackfill)
      .map((message) => message.content)
      .join("|"),
    [
      "alias question 1",
      "alias answer 1",
      "alias question 2",
      "alias answer 2",
      "alias question three",
      "alias answer three"
    ].join("|"),
    "a complete checkpoint backfill must accept unique tuple aliases as order anchors"
  )
}

function testExplicitOccurrenceReplayCanUpdateEarlierTurn(): void {
  const providerId = "cross-turn-explicit-replay-provider"
  const previous = [
    { id: "cross-turn-explicit-user-one", type: "human", content: "question one" },
    {
      id: providerId,
      provider_source_id: providerId,
      provider_occurrence: 1,
      type: "ai",
      content: "old answer"
    },
    { id: "cross-turn-explicit-user-two", type: "human", content: "question two" },
    { id: "cross-turn-explicit-current", type: "ai", content: "current answer" }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    {
      id: "cross-turn-explicit-canonical-one",
      provider_source_id: providerId,
      provider_occurrence: 1,
      type: "ai",
      content: "old answer updated"
    }
  ])
  assertEqual(
    normalized[0]?.id,
    providerId,
    "an explicit occurrence replay must match its unique earlier-turn render id"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 4, "an earlier-turn explicit replay must not append to the latest turn")
  assertEqual(merged[1]?.content, "old answer updated", "the earlier occurrence must be updated")
  assertEqual(merged[3]?.content, "current answer", "the latest turn must remain in place")
}

function testHighGapFullReplayRemainsStable(): void {
  const providerId = "live-high-gap-provider-id"
  const user = { id: "live-high-gap-user", type: "human", content: "question" }
  const previous = [
    user,
    {
      id: providerId,
      provider_source_id: providerId,
      provider_occurrence: 2,
      type: "ai",
      content: "two"
    }
  ]
  const completeReplay = [
    user,
    {
      id: "live-high-gap-canonical-one",
      provider_source_id: providerId,
      provider_occurrence: 1,
      type: "ai",
      content: "one"
    },
    {
      id: "live-high-gap-canonical-two",
      provider_source_id: providerId,
      provider_occurrence: 2,
      type: "ai",
      content: "two"
    }
  ]

  const firstNormalized = normalizeAppendedLiveStreamMessageIds(previous, completeReplay)
  const firstMerged = mergeLiveStreamMessages(previous, firstNormalized)
  assertEqual(firstMerged.length, 3, "a high-gap full replay must fill occurrence one once")
  assertEqual(
    firstMerged.map((message) => message.content).join("|"),
    "question|one|two",
    "a high-gap full replay must restore provider occurrence order"
  )
  const secondNormalized = normalizeAppendedLiveStreamMessageIds(firstMerged, completeReplay)
  const secondMerged = mergeLiveStreamMessages(firstMerged, secondNormalized)
  assertEqual(secondMerged.length, 3, "repeating a high-gap full replay must be idempotent")
  assertEqual(
    secondMerged.map((message) => message.id).join("|"),
    firstMerged.map((message) => message.id).join("|"),
    "repeating a high-gap full replay must retain stable internal ids"
  )

  const sparseNormalized = normalizeAppendedLiveStreamMessageIds(previous, [
    {
      id: "live-high-gap-sparse-one",
      provider_source_id: providerId,
      provider_occurrence: 1,
      type: "ai",
      content: "one"
    }
  ])
  const sparseMerged = mergeLiveStreamMessages(previous, sparseNormalized)
  assertEqual(
    sparseMerged.map((message) => message.content).join("|"),
    "question|one|two",
    "a sparse high-gap replay must insert the lower occurrence within its user turn"
  )
  const committed = mergeLiveStreamCommitMessages(
    previous.map((message) => ({
      ...message,
      role: message.type === "human" ? "user" : "assistant",
      created_at: new Date()
    })) as Message[],
    [
      {
        id: "live-high-gap-commit-one",
        provider_source_id: providerId,
        provider_occurrence: 1,
        role: "assistant",
        content: "one",
        created_at: new Date()
      }
    ]
  )
  assertEqual(
    committed.map((message) => message.content).join("|"),
    "question|one|two",
    "a sparse lower occurrence must retain the same order when committed"
  )
}

function testCrossTurnHighGapReplayRestoresProviderOrder(): void {
  const providerId = "live-cross-turn-high-gap-provider"
  const previous = [
    { id: "live-cross-turn-high-gap-user-one", type: "human", content: "question one" },
    {
      id: "live-cross-turn-high-gap-two",
      provider_source_id: providerId,
      provider_occurrence: 2,
      type: "ai",
      content: "two"
    },
    { id: "live-cross-turn-high-gap-user-two", type: "human", content: "question two" },
    { id: "live-cross-turn-high-gap-current", type: "ai", content: "current" }
  ]
  const incoming = [
    {
      id: "live-cross-turn-high-gap-one",
      provider_source_id: providerId,
      provider_occurrence: 1,
      type: "ai",
      content: "one"
    }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, incoming)
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(
    merged.map((message) => message.content).join("|"),
    "question one|one|two|question two|current",
    "an explicit lower occurrence must insert before a higher occurrence in an older turn"
  )

  const committed = mergeLiveStreamCommitMessages(
    previous.map((message) => ({
      ...message,
      role: message.type === "human" ? "user" : "assistant",
      created_at: new Date()
    })) as Message[],
    [
      {
        id: "live-cross-turn-high-gap-commit-one",
        provider_source_id: providerId,
        provider_occurrence: 1,
        role: "assistant",
        content: "one",
        created_at: new Date()
      }
    ]
  )
  assertEqual(
    committed.map((message) => message.content).join("|"),
    "question one|one|two|question two|current",
    "commit must preserve explicit provider order across user boundaries"
  )
}

function testRepeatedCurrentTurnSnapshotKeepsOccurrenceAlignment(): void {
  const providerId = "repeated-current-turn-provider-id"
  const secondId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)
  const thirdId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)
  const previous = [
    { id: "first-user", type: "human", content: "first question" },
    { id: providerId, type: "ai", content: "old answer" },
    { id: "second-user", type: "human", content: "second question" },
    { id: secondId, type: "ai", content: "first current answer" },
    { id: thirdId, type: "ai", content: "second current answer" }
  ]
  const normalized = normalizeAppendedLiveStreamMessageIds(previous, [
    { id: "second-user", type: "human", content: "second question" },
    { id: providerId, type: "ai", content: "first current answer updated" },
    { id: providerId, type: "ai", content: "second current answer updated" }
  ])

  assertEqual(
    normalized.map((message) => message.id).join("|"),
    `second-user|${secondId}|${thirdId}`,
    "a repeated current-turn snapshot must align each provider occurrence with its existing row"
  )
  const merged = mergeLiveStreamMessages(previous, normalized)
  assertEqual(merged.length, 5, "a repeated snapshot must not invent another occurrence row")
  assertEqual(
    merged.slice(-2).map((message) => message.content).join("|"),
    "first current answer updated|second current answer updated",
    "each current-turn occurrence must receive its own snapshot update"
  )
}

function testSameMessageKeepsPreviousUsefulFieldsWhenSnapshotIsSparse(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-1",
        type: "ai",
        content: "calling tool",
        tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" }, type: "tool_call" }]
      }
    ],
    [
      {
        id: "assistant-1",
        type: "ai",
        content: ""
      }
    ]
  )

  assertEqual(merged.length, 1, "same id should merge into one message")
  assertEqual(merged[0]?.content, "calling tool", "sparse snapshot should not blank content")
  assertEqual(merged[0]?.tool_calls?.length, 1, "sparse snapshot should not drop tool calls")
}

function testSameMessageClearsToolCallsWhenSnapshotExplicitlyHasNone(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-1",
        type: "ai",
        content: "calling tool",
        tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" }, type: "tool_call" }]
      }
    ],
    [
      {
        id: "assistant-1",
        type: "ai",
        content: "final pure text",
        tool_calls: [],
        content_priority: 1
      }
    ]
  )

  assertEqual(merged.length, 1, "same id should merge into one message")
  assertEqual(merged[0]?.content, "final pure text", "replacement snapshot should update content")
  assertEqual(
    merged[0]?.tool_calls?.length ?? 0,
    0,
    "explicit empty tool_calls should clear stale tool cards"
  )
}

function testAuthoritativeEmptySnapshotClearsStaleAssistantContent(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "final answer accidentally attached to the tool call",
        tool_calls: [{ id: "call-1", name: "read_file", args: {}, type: "tool_call" }]
      }
    ],
    [
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "",
        tool_calls: [{ id: "call-1", name: "read_file", args: {}, type: "tool_call" }],
        content_priority: 1
      }
    ]
  )

  assertEqual(merged[0]?.content, "", "an authoritative values snapshot should clear stale content")
}

function testLatestAuthoritativeEmptySnapshotWinsAtSamePriority(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "earlier authoritative content",
        tool_calls: [{ id: "call-1", name: "get_status", args: {}, type: "tool_call" }],
        content_priority: 1
      }
    ],
    [
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "",
        tool_calls: [{ id: "call-1", name: "get_status", args: {}, type: "tool_call" }],
        content_priority: 1
      }
    ]
  )

  assertEqual(
    merged[0]?.content,
    "",
    "the latest authoritative snapshot should replace equal-priority content"
  )
}

function testHigherPrioritySnapshotContentSurvivesLaterReplay(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-1",
        type: "ai",
        content: "final replacement answer",
        content_priority: 1
      }
    ],
    [
      {
        id: "assistant-1",
        type: "ai",
        content: "old streamed draft",
        tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" }, type: "tool_call" }]
      }
    ]
  )

  assertEqual(merged.length, 1, "same id should merge into one message")
  assertEqual(
    merged[0]?.content,
    "final replacement answer",
    "lower-priority stream replays should not overwrite replacement snapshot content"
  )
  assertEqual(
    merged[0]?.tool_calls?.length,
    1,
    "lower-priority stream replays should still merge newly visible tool calls"
  )
}

function testSameMessageKeepsContentBlocksWhenSnapshotArrayIsEmpty(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-blocks",
        type: "ai",
        content: [{ type: "text", text: "hello" }]
      }
    ],
    [
      {
        id: "assistant-blocks",
        type: "ai",
        content: []
      }
    ]
  )

  assertEqual(merged.length, 1, "same id should merge into one message")
  assertEqual(
    Array.isArray(merged[0]?.content),
    true,
    "empty array snapshot should not blank previous content blocks"
  )
  assertEqual(
    Array.isArray(merged[0]?.content) ? merged[0]?.content[0]?.text : undefined,
    "hello",
    "previous text block should be preserved"
  )
}

function testSameMessageKeepsContentBlocksWhenSnapshotArrayHasNoValidBlocks(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-blocks",
        type: "ai",
        content: [{ type: "text", text: "hello" }]
      }
    ],
    [
      {
        id: "assistant-blocks",
        type: "ai",
        content: [{ type: "provider_unknown", value: "ignored" }]
      }
    ]
  )

  assertEqual(merged.length, 1, "same id should merge into one message")
  assertEqual(
    Array.isArray(merged[0]?.content) ? merged[0]?.content[0]?.text : undefined,
    "hello",
    "invalid content block snapshot should not blank previous visible content"
  )
}

function testCompleteSnapshotCanInsertLateMessageInSnapshotOrder(): void {
  const merged = mergeLiveStreamMessages(
    [
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "calling tool"
      },
      {
        id: "assistant-final",
        type: "ai",
        content: "done"
      }
    ],
    [
      {
        id: "assistant-tool-call",
        type: "ai",
        content: "calling tool"
      },
      {
        id: "tool-result",
        type: "tool",
        content: "tool output",
        tool_call_id: "call-1",
        name: "execute"
      },
      {
        id: "assistant-final",
        type: "ai",
        content: "done"
      }
    ]
  )

  assertEqual(
    merged.map((message) => message.id).join(","),
    "assistant-tool-call,tool-result,assistant-final",
    "complete snapshots should restore late-arriving messages to their snapshot position"
  )
}

function testReplacingLiveMessageIdMergesFinalSnapshotWithoutDuplicate(): void {
  const firstReplacement = replaceLiveStreamMessageId(
    [
      {
        id: "live-id",
        type: "ai",
        content: "final answer",
        provider_source_id: "provider-id",
        provider_occurrence: 2
      },
      { id: "final-id", type: "ai", content: "final answer", content_priority: 1 }
    ],
    "live-id",
    "final-id"
  )
  const replaced = replaceLiveStreamMessageId(firstReplacement, "final-id", "later-final-id")

  assertEqual(replaced.length, 1, "message id aliases should collapse into one live message")
  assertEqual(
    replaced[0]?.id,
    "later-final-id",
    "repeated provider id replacements should retain one canonical message"
  )
  assertEqual(replaced[0]?.content, "final answer", "canonical message should preserve content")
  assertEqual(
    replaced[0]?.provider_source_id,
    "provider-id",
    "repeated aliases must preserve the first provider identity in memory"
  )
  assertEqual(
    replaced[0]?.provider_occurrence,
    2,
    "repeated aliases must preserve the exact provider occurrence in memory"
  )
}

function testReplacingLiveMessageIdHandlesBoundariesDeterministically(): void {
  const messages = [
    { id: "before", type: "human", content: "before" },
    { id: "live-id", type: "ai", content: "draft", tool_calls: [{ id: "tool-1" }] },
    { id: "final-id", type: "ai", content: "final", content_priority: 1 },
    { id: "after", type: "tool", content: "after" }
  ]

  assertEqual(replaceLiveStreamMessageId(messages, "", "final-id"), messages, "empty source id")
  assertEqual(replaceLiveStreamMessageId(messages, "live-id", "live-id"), messages, "identical ids")
  assertEqual(
    replaceLiveStreamMessageId(messages, "missing", "final-id"),
    messages,
    "missing source id"
  )

  const replaced = replaceLiveStreamMessageId(messages, "live-id", "final-id")
  assertEqual(
    replaced.map((message) => message.id).join(","),
    "before,final-id,after",
    "replacement should keep the earliest logical position and remove both old rows"
  )
  assertEqual(replaced[1]?.content, "final", "canonical target content should remain authoritative")
  assertEqual(
    replaced[1]?.tool_calls?.[0]?.id,
    "tool-1",
    "fields absent from the canonical target should be preserved from the live source"
  )
}

function testRendererAliasRemovesFallbackFromCumulativeSdkReplay(): void {
  const fallbackId = "values:1:ai:fallback"
  const stableId = "current-run-assistant:stable"
  const replay = applyLiveStreamMessageIdAliases(
    [
      { id: fallbackId, type: "ai", content: "first " },
      {
        id: stableId,
        type: "ai",
        content: "first final",
        provider_source_id: stableId,
        provider_occurrence: 1
      },
      { id: "guided-user", type: "human", content: "guide" }
    ],
    [
      {
        fromId: fallbackId,
        toId: stableId,
        providerSourceId: stableId,
        providerOccurrence: 1
      }
    ]
  )
  const aliasedAccumulator = replaceLiveStreamMessageId(
    [{ id: fallbackId, type: "ai", content: "first " }],
    fallbackId,
    stableId,
    stableId,
    1
  )
  const mergedReplay = mergeLiveStreamMessages(
    aliasedAccumulator,
    normalizeAppendedLiveStreamMessageIds(aliasedAccumulator, replay)
  )
  const assistants = mergedReplay.filter((message) => message.type === "ai")
  assertEqual(assistants.length, 1, "the cumulative SDK replay must collapse the fallback alias")
  assertEqual(assistants[0]?.id, stableId, "the replayed assistant must use the stable id")
  assertEqual(
    assistants[0]?.content,
    "first final",
    "the authoritative stable completion must replace the partial fallback"
  )
}

function testNormalizeContentBlocksDropsInvalidBlocks(): void {
  const normalized = normalizeLiveStreamMessageContent([
    { type: "text", text: "hello" },
    null,
    { type: "unknown", text: "hidden" }
  ])

  assertEqual(Array.isArray(normalized), true, "valid content blocks should be preserved")
  assertEqual(
    Array.isArray(normalized) ? normalized.length : 0,
    1,
    "invalid content blocks should be dropped before rendering"
  )
  assertEqual(
    Array.isArray(normalized) ? normalized[0]?.text : undefined,
    "hello",
    "text block content should survive normalization"
  )
}

function testStringifyMessageContentForReportUsesOnlyVisibleTextBlocks(): void {
  const reportText = stringifyMessageContentForReport([
    { type: "text", text: "visible" },
    { type: "tool_result", content: "secret result" }
  ])

  assertEqual(reportText, "visible", "report upload should not serialize structured tool blocks")
}

function testLiveStreamMessageRoleMapsSystemAndTool(): void {
  assertEqual(liveStreamMessageRole("tool"), "tool", "tool messages should stay tool role")
  assertEqual(liveStreamMessageRole("system"), "system", "system messages should stay system role")
  assertEqual(liveStreamMessageRole("ai"), "assistant", "ai messages should map to assistant")
}

function testLiveToolMessageToStoreMessageKeepsFailureFields(): void {
  const message = liveStreamMessageToStoreMessage({
    id: "tool-result-1",
    type: "tool",
    content: "command failed",
    tool_call_id: "call-1",
    name: "execute_command",
    status: "error",
    is_error: true
  })

  assertEqual(message.role, "tool", "live tool messages should become tool store messages")
  assertEqual(message.tool_call_id, "call-1", "tool call id should be preserved")
  assertEqual(message.name, "execute_command", "tool name should be preserved")
  assertEqual(message.status, "error", "tool status should be preserved")
  assertEqual(message.is_error, true, "tool failure flag should be preserved")
}

function testGoalArtifactsHandleLiveAccumulatorTiming(): void {
  assertEqual(
    shouldSkipLiveStreamAccumulatorMessage({
      id: "goal-notice",
      type: "system",
      content: "Goal 已继续：继续执行"
    }),
    true,
    "hidden goal notices should be baselined before live timing"
  )
  assertEqual(
    shouldSkipLiveStreamAccumulatorMessage({
      id: "internal-goal-prompt",
      type: "human",
      content: "[Continuing active goal]\n\n<untrusted_objective>\n检查实现\n</untrusted_objective>"
    }),
    false,
    "internal goal prompts should stay in the accumulator so internal timing can be persisted"
  )
  assertEqual(
    shouldSkipLiveStreamAccumulatorMessage({
      id: "normal-system",
      type: "system",
      content: "Hook 已执行：检查通过"
    }),
    false,
    "ordinary visible system messages should remain eligible for live transcript"
  )
}

function testResolveLiveStreamMessageEndAtDoesNotMoveBackwards(): void {
  const startAt = new Date("2026-05-28T00:00:03.000Z")
  const earlierNextStartAt = new Date("2026-05-28T00:00:02.000Z")
  const completedAt = new Date("2026-05-28T00:00:04.000Z")

  assertEqual(
    resolveLiveStreamMessageEndAt(startAt, earlierNextStartAt, completedAt).toISOString(),
    startAt.toISOString(),
    "late-inserted messages should not receive an end time before their start time"
  )
}

function testChatReportUploadCacheReservesInFlightIds(): void {
  const threadId = "upload-cache-thread"
  clearChatReportUploadState(threadId)

  const first = reserveChatReportMessageIds(threadId, ["user-1", "assistant-1"])
  const second = reserveChatReportMessageIds(threadId, ["user-1", "assistant-1", "assistant-2"])

  assertEqual(first.join(","), "user-1,assistant-1", "first upload should reserve all ids")
  assertEqual(second.join(","), "assistant-2", "in-flight ids should not be reserved twice")

  markChatReportUploadSucceeded(threadId, first)
  const third = reserveChatReportMessageIds(threadId, ["user-1", "assistant-1", "assistant-2"])
  assertEqual(third.length, 0, "uploaded and in-flight ids should not be reserved")

  markChatReportUploadFailed(threadId, second)
  const retry = reserveChatReportMessageIds(threadId, ["assistant-2"])
  assertEqual(retry.join(","), "assistant-2", "failed upload ids should be retryable")

  clearChatReportUploadState(threadId)
}

function testChatReportUploadCacheLateCallbacksDoNotRecreateClearedState(): void {
  const threadId = "upload-cache-cleared-thread"
  clearChatReportUploadState(threadId)

  const first = reserveChatReportMessageIds(threadId, ["assistant-1"])
  assertEqual(first.join(","), "assistant-1", "first upload should reserve id")

  clearChatReportUploadState(threadId)
  markChatReportUploadSucceeded(threadId, ["assistant-1"])
  markChatReportUploadFailed(threadId, ["assistant-2"])

  const next = reserveChatReportMessageIds(threadId, ["assistant-1"])
  assertEqual(next.join(","), "assistant-1", "late callbacks should not recreate cleared state")

  clearChatReportUploadState(threadId)
}

function testChatReportUploadCacheCanMarkRestoredMessagesUploaded(): void {
  const threadId = "upload-cache-restored-thread"
  clearChatReportUploadState(threadId)

  markChatReportMessageIdsUploaded(threadId, ["user-1", "assistant-1"])
  const reserved = reserveChatReportMessageIds(threadId, ["user-1", "assistant-1", "tool-1"])

  assertEqual(reserved.join(","), "tool-1", "restored history ids should not be uploaded again")

  clearChatReportUploadState(threadId)
}

function testChatReportUploadCacheCanDisableDeletedThread(): void {
  const threadId = "upload-cache-deleted-thread"
  clearChatReportUploadState(threadId)

  const first = reserveChatReportMessageIds(threadId, ["assistant-1"])
  assertEqual(first.join(","), "assistant-1", "thread should reserve before cleanup")

  disableChatReportUploadForThread(threadId)
  markChatReportUploadFailed(threadId, ["assistant-1"])
  const afterCleanup = reserveChatReportMessageIds(threadId, ["assistant-1", "assistant-2"])

  assertEqual(afterCleanup.length, 0, "deleted thread should ignore late upload retries")

  clearChatReportUploadState(threadId)
}

function testDurableTranscriptSnapshotRestoresDatabaseUserOrder(): void {
  const at = new Date("2026-07-22T08:00:00.000Z")
  const assistantA: Message = {
    id: "assistant-a",
    role: "assistant",
    content: "A",
    created_at: at
  }
  const guide: Message = { id: "guide-g", role: "user", content: "G", created_at: at }
  const replacement: Message = {
    id: "replacement-b",
    role: "user",
    content: "B",
    created_at: at
  }
  const localOnly: Message = {
    id: "local-only-x",
    role: "assistant",
    content: "live only",
    created_at: at
  }

  const merged = mergeDurableTranscriptSnapshot(
    [assistantA, guide, replacement],
    [assistantA, replacement, localOnly]
  )
  assertEqual(
    merged.map((message) => message.id).join(","),
    "assistant-a,guide-g,replacement-b,local-only-x",
    "DB ordinals restore a late guided turn before the optimistic replacement while preserving local-only state"
  )
  assertEqual(
    merged.filter((message) => message.id === "local-only-x").length,
    1,
    "durable reconciliation preserves each local-only message exactly once"
  )
}

function testDurableTranscriptSnapshotPreservesRendererReasoning(): void {
  const at = new Date("2026-07-22T08:00:00.000Z")
  const durable: Message = {
    id: "assistant-a",
    provider_source_id: "provider-a",
    provider_occurrence: 2,
    role: "assistant",
    content: "final answer",
    created_at: at
  }
  const local: Message = {
    ...durable,
    content: "stream draft",
    reasoning: "visible reasoning"
  }

  const merged = mergeDurableTranscriptSnapshot([durable], [local])
  assertEqual(merged[0]?.content, "final answer", "durable content remains authoritative")
  assertEqual(
    merged[0]?.reasoning,
    "visible reasoning",
    "durable sync preserves renderer-only reasoning for the same provider occurrence"
  )
}

const tests: Array<[string, () => void]> = [
  [
    "testSameRoleProviderIdCollisionStaysVisibleDuringStreaming",
    testSameRoleProviderIdCollisionStaysVisibleDuringStreaming
  ],
  ["testSameRoleProviderIdCollisionSurvivesCommit", testSameRoleProviderIdCollisionSurvivesCommit],
  [
    "testCrossRoleProviderIdCollisionStaysVisibleDuringStreaming",
    testCrossRoleProviderIdCollisionStaysVisibleDuringStreaming
  ],
  [
    "testCommitRebasesAccumulatedMessageAgainstLatestRoleCollision",
    testCommitRebasesAccumulatedMessageAgainstLatestRoleCollision
  ],
  [
    "testCommitMergesLatestContentWhenConcurrentStateAlreadyHasIdentity",
    testCommitMergesLatestContentWhenConcurrentStateAlreadyHasIdentity
  ],
  [
    "testAuthoritativeCommitOverridesConcurrentDraft",
    testAuthoritativeCommitOverridesConcurrentDraft
  ],
  [
    "testCommitKeepsSameRoleProviderIdReuseInLaterTurn",
    testCommitKeepsSameRoleProviderIdReuseInLaterTurn
  ],
  [
    "testIncrementalStreamKeepsSameRoleProviderIdReuseInLaterTurn",
    testIncrementalStreamKeepsSameRoleProviderIdReuseInLaterTurn
  ],
  [
    "testIncrementalToolProviderIdReuseAfterAssistantBoundary",
    testIncrementalToolProviderIdReuseAfterAssistantBoundary
  ],
  [
    "testFullReplayUpdatesToolsAcrossAssistantBoundary",
    testFullReplayUpdatesToolsAcrossAssistantBoundary
  ],
  [
    "testSparseUserToolAppendDoesNotMasqueradeAsFullReplay",
    testSparseUserToolAppendDoesNotMasqueradeAsFullReplay
  ],
  [
    "testDifferentAssistantOccurrenceCannotCoverSparseToolBoundary",
    testDifferentAssistantOccurrenceCannotCoverSparseToolBoundary
  ],
  [
    "testEarlierIncomingAssistantCannotCoverSparseToolBoundary",
    testEarlierIncomingAssistantCannotCoverSparseToolBoundary
  ],
  [
    "testExactLiveToolReplayAfterAssistantIsIdempotent",
    testExactLiveToolReplayAfterAssistantIsIdempotent
  ],
  [
    "testExplicitProviderOccurrenceCannotRetargetEarlierAlias",
    testExplicitProviderOccurrenceCannotRetargetEarlierAlias
  ],
  [
    "testExplicitProviderTupleConflictCannotMergeByRenderId",
    testExplicitProviderTupleConflictCannotMergeByRenderId
  ],
  [
    "testExplicitProviderTupleInvariantsAcrossCompleteEntrypoints",
    testExplicitProviderTupleInvariantsAcrossCompleteEntrypoints
  ],
  [
    "testProviderOccurrenceOrderingPreservesUserTurnSegments",
    testProviderOccurrenceOrderingPreservesUserTurnSegments
  ],
  [
    "testExplicitOccurrenceReplayCanUpdateEarlierTurn",
    testExplicitOccurrenceReplayCanUpdateEarlierTurn
  ],
  ["testHighGapFullReplayRemainsStable", testHighGapFullReplayRemainsStable],
  [
    "testCrossTurnHighGapReplayRestoresProviderOrder",
    testCrossTurnHighGapReplayRestoresProviderOrder
  ],
  [
    "testRepeatedCurrentTurnSnapshotKeepsOccurrenceAlignment",
    testRepeatedCurrentTurnSnapshotKeepsOccurrenceAlignment
  ],
  [
    "testLaterSnapshotDoesNotDropEarlierToolMessage",
    testLaterSnapshotDoesNotDropEarlierToolMessage
  ],
  [
    "testSameMessageKeepsPreviousUsefulFieldsWhenSnapshotIsSparse",
    testSameMessageKeepsPreviousUsefulFieldsWhenSnapshotIsSparse
  ],
  [
    "testSameMessageClearsToolCallsWhenSnapshotExplicitlyHasNone",
    testSameMessageClearsToolCallsWhenSnapshotExplicitlyHasNone
  ],
  [
    "testAuthoritativeEmptySnapshotClearsStaleAssistantContent",
    testAuthoritativeEmptySnapshotClearsStaleAssistantContent
  ],
  [
    "testLatestAuthoritativeEmptySnapshotWinsAtSamePriority",
    testLatestAuthoritativeEmptySnapshotWinsAtSamePriority
  ],
  [
    "testHigherPrioritySnapshotContentSurvivesLaterReplay",
    testHigherPrioritySnapshotContentSurvivesLaterReplay
  ],
  [
    "testSameMessageKeepsContentBlocksWhenSnapshotArrayIsEmpty",
    testSameMessageKeepsContentBlocksWhenSnapshotArrayIsEmpty
  ],
  [
    "testSameMessageKeepsContentBlocksWhenSnapshotArrayHasNoValidBlocks",
    testSameMessageKeepsContentBlocksWhenSnapshotArrayHasNoValidBlocks
  ],
  [
    "testCompleteSnapshotCanInsertLateMessageInSnapshotOrder",
    testCompleteSnapshotCanInsertLateMessageInSnapshotOrder
  ],
  [
    "testReplacingLiveMessageIdMergesFinalSnapshotWithoutDuplicate",
    testReplacingLiveMessageIdMergesFinalSnapshotWithoutDuplicate
  ],
  [
    "testReplacingLiveMessageIdHandlesBoundariesDeterministically",
    testReplacingLiveMessageIdHandlesBoundariesDeterministically
  ],
  [
    "testRendererAliasRemovesFallbackFromCumulativeSdkReplay",
    testRendererAliasRemovesFallbackFromCumulativeSdkReplay
  ],
  ["testNormalizeContentBlocksDropsInvalidBlocks", testNormalizeContentBlocksDropsInvalidBlocks],
  [
    "testStringifyMessageContentForReportUsesOnlyVisibleTextBlocks",
    testStringifyMessageContentForReportUsesOnlyVisibleTextBlocks
  ],
  ["testLiveStreamMessageRoleMapsSystemAndTool", testLiveStreamMessageRoleMapsSystemAndTool],
  [
    "testLiveToolMessageToStoreMessageKeepsFailureFields",
    testLiveToolMessageToStoreMessageKeepsFailureFields
  ],
  ["testGoalArtifactsHandleLiveAccumulatorTiming", testGoalArtifactsHandleLiveAccumulatorTiming],
  [
    "testResolveLiveStreamMessageEndAtDoesNotMoveBackwards",
    testResolveLiveStreamMessageEndAtDoesNotMoveBackwards
  ],
  ["testChatReportUploadCacheReservesInFlightIds", testChatReportUploadCacheReservesInFlightIds],
  [
    "testChatReportUploadCacheLateCallbacksDoNotRecreateClearedState",
    testChatReportUploadCacheLateCallbacksDoNotRecreateClearedState
  ],
  [
    "testChatReportUploadCacheCanMarkRestoredMessagesUploaded",
    testChatReportUploadCacheCanMarkRestoredMessagesUploaded
  ],
  [
    "testChatReportUploadCacheCanDisableDeletedThread",
    testChatReportUploadCacheCanDisableDeletedThread
  ],
  [
    "testDurableTranscriptSnapshotRestoresDatabaseUserOrder",
    testDurableTranscriptSnapshotRestoresDatabaseUserOrder
  ],
  [
    "testDurableTranscriptSnapshotPreservesRendererReasoning",
    testDurableTranscriptSnapshotPreservesRendererReasoning
  ]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
