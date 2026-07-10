/**
 * Unit tests for live stream message accumulation.
 *
 * Run:
 *   npx tsx tests/live-stream-messages.spec.ts
 */

import {
  liveStreamMessageRole,
  mergeLiveStreamMessages,
  normalizeLiveStreamMessageContent,
  replaceLiveStreamMessageId,
  stringifyMessageContentForReport
} from "../src/renderer/src/lib/live-stream-messages.ts"
import {
  liveStreamMessageToStoreMessage,
  resolveLiveStreamMessageEndAt,
  shouldSkipLiveStreamAccumulatorMessage
} from "../src/renderer/src/lib/live-stream-transcript.ts"
import {
  clearChatReportUploadState,
  disableChatReportUploadForThread,
  markChatReportMessageIdsUploaded,
  markChatReportUploadFailed,
  markChatReportUploadSucceeded,
  reserveChatReportMessageIds
} from "../src/renderer/src/lib/chat-report-upload-cache.ts"

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
        tool_calls: [
          { id: "call-1", name: "read_file", args: { path: "a.ts" }, type: "tool_call" }
        ]
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
      { id: "live-id", type: "ai", content: "final answer" },
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
}

function testReplacingLiveMessageIdHandlesBoundariesDeterministically(): void {
  const messages = [
    { id: "before", type: "human", content: "before" },
    { id: "live-id", type: "ai", content: "draft", tool_calls: [{ id: "tool-1" }] },
    { id: "final-id", type: "ai", content: "final", content_priority: 1 },
    { id: "after", type: "tool", content: "after" }
  ]

  assertEqual(replaceLiveStreamMessageId(messages, "", "final-id"), messages, "empty source id")
  assertEqual(
    replaceLiveStreamMessageId(messages, "live-id", "live-id"),
    messages,
    "identical ids"
  )
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

const tests: Array<[string, () => void]> = [
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
  ]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
