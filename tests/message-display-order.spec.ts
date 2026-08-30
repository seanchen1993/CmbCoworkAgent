import { reconcileMessageDisplayOrder } from "../src/renderer/src/lib/message-display-order.ts"
import { mergeCheckpointAuthorityTranscriptMessages } from "../src/shared/checkpoint-transcript.ts"
import {
  buildVisibleMessageLayout,
  messageHasVisibleRow,
  messageRendersNothing,
  messageVisibleReasoningLength,
  shouldAutoCollapseReasoning
} from "../src/renderer/src/lib/message-display-visibility.ts"
import {
  areMessageRenderFieldsEqual,
  areMessageToolRenderInputsEqual,
  areToolDerivationMessagesEqual,
  createToolDerivationMessageSelector,
  selectToolDerivationMessages
} from "../src/renderer/src/lib/message-render-stability.ts"
import { getWorkerToolUiKey } from "../src/renderer/src/lib/worker-tool-result-key.ts"
import {
  normalizeHookLogTurnId,
  resolveHookLogUserMessage
} from "../src/renderer/src/lib/hook-log-turn-id.ts"
import { normalizeSchedulerMessageSnapshot } from "../src/renderer/src/lib/scheduler-message-snapshot.ts"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageRoleCollisionIdentity,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds,
  normalizeMessageRoleCollisionIds,
  preserveAssistantReasoningByRoleCollisionIdentity
} from "../src/shared/message-role-collision.ts"
import type { Message } from "../src/renderer/src/types.ts"

interface TestMessage {
  id: string
  role: "user" | "assistant" | "tool" | "system"
  type?: "human" | "user" | "ai" | "assistant" | "tool" | "system"
  startAt: number
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  tool_call_id?: string
  start_at?: Date
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function ids(messages: TestMessage[]): string {
  return messages.map((message) => message.id).join(",")
}

function testLateToolResultUsesSnapshotOrderInsteadOfArrivalTime(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    { id: "assistant-call", role: "assistant", startAt: 1 },
    { id: "assistant-final", role: "assistant", startAt: 2 },
    { id: "tool-result", role: "tool", startAt: 3 }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call" },
    { id: "tool-result" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-call,tool-result,assistant-final",
    "a late tool result should return to its authoritative transcript position"
  )
}

function testLateToolCallAndResultMoveTogetherBeforeFinalAnswer(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    { id: "assistant-final", role: "assistant", startAt: 1 },
    { id: "assistant-call", role: "assistant", startAt: 2 },
    { id: "tool-result", role: "tool", startAt: 3 }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call" },
    { id: "tool-result" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-call,tool-result,assistant-final",
    "late snapshot messages should not leave the visible tool card after the final answer"
  )
}

function testMessagesMissingFromSnapshotRemainAnchored(): void {
  const messages: TestMessage[] = [
    { id: "user-1", role: "user", startAt: 0 },
    { id: "assistant-1", role: "assistant", startAt: 1 },
    { id: "user-2", role: "user", startAt: 2 },
    { id: "assistant-final", role: "assistant", startAt: 3 },
    { id: "tool-result", role: "tool", startAt: 4 },
    { id: "assistant-call", role: "assistant", startAt: 5 }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-1" },
    { id: "assistant-call" },
    { id: "tool-result" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user-1,assistant-1,user-2,assistant-call,tool-result,assistant-final",
    "ordinary user messages omitted from values snapshots should keep their transcript anchors"
  )
}

function testPersistedTranscriptOrderWinsWithoutLiveSnapshot(): void {
  const persistedMessages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    { id: "assistant-call", role: "assistant", startAt: 1 },
    { id: "tool-result", role: "tool", startAt: 3 },
    { id: "assistant-final", role: "assistant", startAt: 2 }
  ]

  const reconciled = reconcileMessageDisplayOrder(persistedMessages, undefined)

  assertEqual(
    ids(reconciled),
    "user,assistant-call,tool-result,assistant-final",
    "persisted DB ordinal order should survive even when arrival timestamps are non-monotonic"
  )
}

function testPersistedMergePreservesDatabaseOrdinalOrder(): void {
  const merged = mergeCheckpointAuthorityTranscriptMessages<TestMessage>(
    [{ id: "user", role: "user", startAt: 0 }],
    [
      {
        id: "assistant-call",
        role: "assistant",
        startAt: 1,
        start_at: new Date("2026-07-17T00:00:03.000Z")
      },
      {
        id: "tool-result",
        role: "tool",
        startAt: 2,
        start_at: new Date("2026-07-17T00:00:02.000Z")
      },
      {
        id: "assistant-final",
        role: "assistant",
        startAt: 3,
        start_at: new Date("2026-07-17T00:00:01.000Z")
      }
    ]
  )

  assertEqual(
    ids(merged),
    "user,assistant-call,tool-result,assistant-final",
    "checkpoint/persisted merging must preserve the database ordinal order"
  )
}

function testSameRoleProviderIdReuseAfterUserBoundaryGetsNewOccurrence(): void {
  const providerId = "reused-assistant-provider-id"
  const appended = normalizeAppendedMessageIds(
    [
      { id: providerId, role: "assistant" },
      { id: "next-user", role: "user" }
    ],
    [{ id: providerId, role: "assistant" }]
  )
  assertEqual(
    appended[0]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant"),
    "the same assistant provider id after a user boundary must start a new occurrence"
  )

  const complete = normalizeCompleteMessageIds([
    { id: providerId, role: "assistant" },
    { id: "next-user", role: "user" },
    { id: providerId, role: "assistant" }
  ])
  assertEqual(
    complete[2]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant"),
    "a complete snapshot must assign the same occurrence id"
  )
}

function testAssistantProviderIdReuseAfterToolBoundaryGetsNewOccurrence(): void {
  const providerId = "tool-boundary-reused-assistant-id"
  const baseline = [
    { id: "tool-boundary-user", role: "user" },
    { id: providerId, role: "assistant" },
    { id: "tool-boundary-result", role: "tool" }
  ]
  const laterFlush = normalizeAppendedMessageIds(
    baseline,
    [{ id: providerId, role: "assistant" }],
    { splitAssistantAfterTool: true }
  )
  assertEqual(
    laterFlush[0]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant"),
    "main persistence must split a reused assistant provider id after a tool boundary"
  )

  const sameFlush = normalizeAppendedMessageIds(
    [{ id: "tool-boundary-user", role: "user" }],
    [
      { id: providerId, role: "assistant" },
      { id: "tool-boundary-result", role: "tool" },
      { id: providerId, role: "assistant" }
    ],
    { splitAssistantAfterTool: true }
  )
  assertEqual(
    sameFlush.map((message) => message.id).join("|"),
    `${providerId}|tool-boundary-result|${buildMessageSameRoleDuplicateId(providerId, "assistant")}`,
    "one persistence batch must keep both assistant occurrences around a tool result"
  )

  const crossRoleProviderId = "tool-owned-provider-id"
  const crossRoleBaseline = [
    { id: "cross-role-tool-boundary-user", role: "user" },
    { id: crossRoleProviderId, role: "tool" },
    {
      id: buildMessageRoleCollisionId(crossRoleProviderId, "assistant"),
      role: "assistant",
      provider_source_id: crossRoleProviderId
    },
    { id: "cross-role-later-tool-boundary", role: "tool" }
  ]
  const crossRoleIncoming = normalizeMessageRoleCollisionIds(crossRoleBaseline, [
    { id: crossRoleProviderId, role: "assistant" }
  ])
  const crossRoleLaterFlush = normalizeAppendedMessageIds(
    crossRoleBaseline,
    crossRoleIncoming,
    { splitAssistantAfterTool: true }
  )
  assertEqual(
    crossRoleLaterFlush[0]?.id,
    buildMessageSameRoleDuplicateId(crossRoleProviderId, "assistant"),
    "a cross-role synthetic assistant id must still split after a later tool boundary"
  )
}

function testReasoningGrowthChangesScrollLength(): void {
  assertEqual(
    messageVisibleReasoningLength({ reasoning: "<think>one</think>" }),
    3,
    "the scroll signature helper should measure visible reasoning"
  )
  assertEqual(
    messageVisibleReasoningLength({ reasoning: "<think>one two</think>" }),
    7,
    "streamed reasoning growth should change the scroll signature"
  )
}

function testStreamingReasoningCollapsesWhenToolCallStarts(): void {
  assertEqual(
    shouldAutoCollapseReasoning({
      isStreaming: true,
      reasoningText: "thinking",
      hasVisibleAssistantContent: false,
      hasToolCalls: false
    }),
    false,
    "reasoning should stay open while it is the only streaming output"
  )
  assertEqual(
    shouldAutoCollapseReasoning({
      isStreaming: true,
      reasoningText: "thinking",
      hasVisibleAssistantContent: false,
      hasToolCalls: true
    }),
    true,
    "the first tool call should collapse the preceding reasoning"
  )
}

function testQueuedCrossRoleUpdatesUsePersistedKeeperOrder(): void {
  const providerId = "queued-cross-role-provider-id"
  const baseline = [
    { id: "queued-user", role: "user" },
    { id: providerId, role: "assistant" },
    { id: buildMessageRoleCollisionId(providerId, "tool"), role: "tool" }
  ]
  const queued = normalizeMessageRoleCollisionIds(baseline, [
    { id: providerId, role: "tool" },
    { id: providerId, role: "assistant" }
  ])
  const normalized = normalizeAppendedMessageIds(baseline, queued)

  assertEqual(
    normalized.map((message) => message.id).join("|"),
    `${buildMessageRoleCollisionId(providerId, "tool")}|${providerId}`,
    "a tool-first later flush must preserve the persisted cross-role keeper assignments"
  )
}

function testDurableSyncMissingToolTailUsesFinalSnapshotOrder(): void {
  const mergedAfterDurableSync: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    { id: "assistant-final", role: "assistant", startAt: 1 },
    { id: "assistant-call", role: "assistant", startAt: 2 },
    { id: "tool-result", role: "tool", startAt: 3 }
  ]

  const reconciled = reconcileMessageDisplayOrder(mergedAfterDurableSync, [
    { id: "assistant-call" },
    { id: "tool-result" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-call,tool-result,assistant-final",
    "durable transcript sync should not append a missing tool call after the final answer"
  )
}

function testStableHistoryWithoutLiveHintKeepsAssistantPreamble(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    { id: "assistant-preamble", role: "assistant", startAt: 1 },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 2,
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    {
      id: "tool-result",
      role: "tool",
      startAt: 3,
      tool_call_id: "call-1"
    },
    { id: "assistant-final", role: "assistant", startAt: 4 }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, undefined)

  assertEqual(
    ids(reconciled),
    "user,assistant-preamble,assistant-call,tool-result,assistant-final",
    "stable history without a live hint should not move an assistant preamble"
  )
}

function testSoloToolCallGroupKeepsEarlierAssistantPreamble(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-preamble",
      role: "assistant",
      startAt: 1,
      start_at: new Date("2026-07-17T00:00:01.000Z")
    },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 2,
      start_at: new Date("2026-07-17T00:00:02.000Z"),
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    {
      id: "tool-result",
      role: "tool",
      startAt: 3,
      start_at: new Date("2026-07-17T00:00:03.000Z"),
      tool_call_id: "call-1"
    },
    {
      id: "assistant-final",
      role: "assistant",
      startAt: 4,
      start_at: new Date("2026-07-17T00:00:04.000Z")
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-preamble" },
    { id: "assistant-call" },
    { id: "tool-result" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-preamble,assistant-call,tool-result,assistant-final",
    "SOLO tool-call correction should not move an earlier assistant preamble"
  )
}

function testSoloToolCallGroupKeepsLateTimestampAssistantPreamble(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-preamble",
      role: "assistant",
      startAt: 5,
      start_at: new Date("2026-07-17T00:00:05.000Z")
    },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 2,
      start_at: new Date("2026-07-17T00:00:02.000Z"),
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    {
      id: "tool-result",
      role: "tool",
      startAt: 3,
      start_at: new Date("2026-07-17T00:00:03.000Z"),
      tool_call_id: "call-1"
    },
    {
      id: "assistant-final",
      role: "assistant",
      startAt: 6,
      start_at: new Date("2026-07-17T00:00:06.000Z")
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-preamble" },
    { id: "assistant-call" },
    { id: "tool-result" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-preamble,assistant-call,tool-result,assistant-final",
    "an authoritative snapshot should win when assistant timestamps are non-monotonic"
  )
}

function testMultipleToolGroupsKeepMiddleAssistantInPlace(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-call-1",
      role: "assistant",
      startAt: 1,
      start_at: new Date("2026-07-17T00:00:01.000Z"),
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    {
      id: "tool-result-1",
      role: "tool",
      startAt: 2,
      start_at: new Date("2026-07-17T00:00:02.000Z"),
      tool_call_id: "call-1"
    },
    {
      id: "assistant-middle",
      role: "assistant",
      startAt: 5,
      start_at: new Date("2026-07-17T00:00:05.000Z")
    },
    {
      id: "assistant-call-2",
      role: "assistant",
      startAt: 3,
      start_at: new Date("2026-07-17T00:00:03.000Z"),
      tool_calls: [{ id: "call-2", name: "read_file", args: { path: "b.ts" } }]
    },
    {
      id: "tool-result-2",
      role: "tool",
      startAt: 4,
      start_at: new Date("2026-07-17T00:00:04.000Z"),
      tool_call_id: "call-2"
    },
    {
      id: "assistant-final",
      role: "assistant",
      startAt: 6,
      start_at: new Date("2026-07-17T00:00:06.000Z")
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call-1" },
    { id: "tool-result-1" },
    { id: "assistant-middle" },
    { id: "assistant-call-2" },
    { id: "tool-result-2" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-call-1,tool-result-1,assistant-middle,assistant-call-2,tool-result-2,assistant-final",
    "multiple tool-call groups should not move a middle assistant to the end"
  )
}

function testParallelToolResultsKeepSnapshotOrder(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 1,
      start_at: new Date("2026-07-17T00:00:01.000Z"),
      tool_calls: [
        { id: "call-1", name: "read_file", args: { path: "a.ts" } },
        { id: "call-2", name: "read_file", args: { path: "b.ts" } }
      ]
    },
    {
      id: "tool-result-2",
      role: "tool",
      startAt: 2,
      start_at: new Date("2026-07-17T00:00:02.000Z"),
      tool_call_id: "call-2"
    },
    {
      id: "tool-result-1",
      role: "tool",
      startAt: 3,
      start_at: new Date("2026-07-17T00:00:03.000Z"),
      tool_call_id: "call-1"
    },
    {
      id: "assistant-final",
      role: "assistant",
      startAt: 4,
      start_at: new Date("2026-07-17T00:00:04.000Z")
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call" },
    { id: "tool-result-2" },
    { id: "tool-result-1" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-call,tool-result-2,tool-result-1,assistant-final",
    "parallel tool results should keep the snapshot order instead of tool declaration order"
  )
}

function testToolResultMovesNextToHeadWithoutReorderingAssistantPrefix(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-middle",
      role: "assistant",
      startAt: 3,
      start_at: new Date("2026-07-17T00:00:03.000Z")
    },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 1,
      start_at: new Date("2026-07-17T00:00:01.000Z"),
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    {
      id: "assistant-final",
      role: "assistant",
      startAt: 4,
      start_at: new Date("2026-07-17T00:00:04.000Z")
    },
    {
      id: "tool-result",
      role: "tool",
      startAt: 2,
      start_at: new Date("2026-07-17T00:00:02.000Z"),
      tool_call_id: "call-1"
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-middle" },
    { id: "assistant-call" },
    { id: "assistant-final" },
    { id: "tool-result" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-middle,assistant-call,tool-result,assistant-final",
    "tool grouping should not reorder an assistant prefix when moving a late result"
  )
}

function testMultipleToolGroupsReconcileWithoutReorderingAssistantPrefix(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-middle",
      role: "assistant",
      startAt: 3,
      start_at: new Date("2026-07-17T00:00:03.000Z")
    },
    {
      id: "assistant-call-1",
      role: "assistant",
      startAt: 1,
      start_at: new Date("2026-07-17T00:00:01.000Z"),
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    {
      id: "assistant-call-2",
      role: "assistant",
      startAt: 4,
      start_at: new Date("2026-07-17T00:00:04.000Z"),
      tool_calls: [{ id: "call-2", name: "read_file", args: { path: "b.ts" } }]
    },
    {
      id: "tool-result-2",
      role: "tool",
      startAt: 5,
      start_at: new Date("2026-07-17T00:00:05.000Z"),
      tool_call_id: "call-2"
    },
    {
      id: "tool-result-1",
      role: "tool",
      startAt: 2,
      start_at: new Date("2026-07-17T00:00:02.000Z"),
      tool_call_id: "call-1"
    },
    {
      id: "assistant-final",
      role: "assistant",
      startAt: 6,
      start_at: new Date("2026-07-17T00:00:06.000Z")
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-middle" },
    { id: "assistant-call-1" },
    { id: "assistant-call-2" },
    { id: "tool-result-2" },
    { id: "tool-result-1" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-middle,assistant-call-1,tool-result-1,assistant-call-2,tool-result-2,assistant-final",
    "multiple tool groups should reconcile in one pass without reordering an assistant prefix"
  )
}

function testReconciliationIsIdempotentWithSnapshotExternalSystemAnchor(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 1,
      tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
    },
    { id: "system-anchor", role: "system", startAt: 2 },
    { id: "assistant-final", role: "assistant", startAt: 3 },
    { id: "tool-result", role: "tool", startAt: 4, tool_call_id: "call-1" }
  ]
  const hint = [{ id: "assistant-call" }, { id: "assistant-final" }, { id: "tool-result" }]

  const once = reconcileMessageDisplayOrder(messages, hint)
  const twice = reconcileMessageDisplayOrder(once, hint)

  assertEqual(
    ids(once),
    "user,assistant-call,tool-result,system-anchor,assistant-final",
    "tool grouping should preserve a snapshot-external system anchor"
  )
  assertEqual(ids(twice), ids(once), "reconciliation should be idempotent")
}

function testDuplicateMessageIdsFailClosedWithoutDroppingMessages(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 1,
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
    },
    { id: "tool-result", role: "tool", startAt: 2, tool_call_id: "call-1" },
    { id: "duplicate", role: "assistant", startAt: 3 },
    { id: "duplicate", role: "system", startAt: 4 }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call" },
    { id: "tool-result" }
  ])

  assertEqual(reconciled.length, messages.length, "duplicate ids must not drop a message")
  assertEqual(
    reconciled[3],
    messages[3],
    "an ambiguous duplicate-id transcript should keep its original objects"
  )
  assertEqual(
    reconciled[4],
    messages[4],
    "an ambiguous duplicate-id transcript should preserve the second duplicate"
  )
}

function testNonToolToolCallIdDoesNotMoveVisibleAssistant(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 1,
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
    },
    { id: "system-anchor", role: "system", startAt: 2 },
    {
      id: "assistant-final",
      role: "assistant",
      type: "tool",
      startAt: 3,
      tool_call_id: "call-1"
    }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call" },
    { id: "system-anchor" },
    { id: "assistant-final" }
  ])

  assertEqual(
    ids(reconciled),
    "user,assistant-call,system-anchor,assistant-final",
    "role must take precedence over a conflicting type/tool_call_id payload"
  )
}

function testHintedMessagesNeverCrossUserTurnBoundary(): void {
  const messages: TestMessage[] = [
    { id: "user-1", role: "user", startAt: 0 },
    {
      id: "assistant-call",
      role: "assistant",
      startAt: 1,
      tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
    },
    { id: "user-2", role: "user", startAt: 2 },
    { id: "tool-result", role: "tool", startAt: 3, tool_call_id: "call-1" },
    { id: "assistant-final", role: "assistant", startAt: 4 }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "tool-result" },
    { id: "assistant-call" },
    { id: "assistant-final" },
    { id: "user-2" },
    { id: "user-1" }
  ])

  assertEqual(
    ids(reconciled),
    "user-1,assistant-call,user-2,tool-result,assistant-final",
    "snapshot hints must not move messages across locally owned user turn boundaries"
  )
}

function testAmbiguousRepeatedToolCallIdPreservesOriginalOrder(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    {
      id: "assistant-call-1",
      role: "assistant",
      startAt: 1,
      tool_calls: [{ id: "call-reused", name: "read_file", args: {} }]
    },
    {
      id: "assistant-call-2",
      role: "assistant",
      startAt: 2,
      tool_calls: [{ id: "call-reused", name: "read_file", args: {} }]
    },
    { id: "assistant-final", role: "assistant", startAt: 3 },
    { id: "tool-result", role: "tool", startAt: 4, tool_call_id: "call-reused" }
  ]

  const reconciled = reconcileMessageDisplayOrder(messages, [
    { id: "assistant-call-1" },
    { id: "assistant-call-2" },
    { id: "assistant-final" },
    { id: "tool-result" }
  ])

  assertEqual(
    ids(reconciled),
    ids(messages),
    "a repeated call id should not attach its result to an arbitrary assistant"
  )
}

function testCrossRoleCollisionToolResultStaysAttachedToItsAssistant(): void {
  const merged = mergeCheckpointAuthorityTranscriptMessages<TestMessage>(
    [
      { id: "user", role: "user", startAt: 0 },
      {
        id: "shared-provider-id",
        role: "assistant",
        startAt: 1,
        tool_calls: [{ id: "call-1", name: "read_file", args: {} }]
      },
      { id: "assistant-final", role: "assistant", startAt: 3 }
    ],
    [
      {
        id: "shared-provider-id",
        role: "tool",
        startAt: 2,
        tool_call_id: "call-1"
      }
    ]
  )

  const reconciled = reconcileMessageDisplayOrder(merged, [
    { id: "shared-provider-id" },
    { id: "assistant-final" }
  ])

  assertEqual(
    reconciled.map((message) => message.role).join(","),
    "user,assistant,tool,assistant",
    "a preserved cross-role tool result should remain attached to its assistant head"
  )
  assertEqual(
    new Set(reconciled.map((message) => message.id)).size,
    reconciled.length,
    "cross-role collision repair must provide unique render ids"
  )
}

function testRandomizedReconciliationInvariants(): void {
  let seed = 0x12345678
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }

  for (let run = 0; run < 5_000; run += 1) {
    const messageCount = 2 + Math.floor(random() * 18)
    const messages: TestMessage[] = []
    const callIds: string[] = []
    for (let index = 0; index < messageCount; index += 1) {
      const roleRoll = random()
      const role: TestMessage["role"] =
        roleRoll < 0.18
          ? "user"
          : roleRoll < 0.55
            ? "assistant"
            : roleRoll < 0.78
              ? "tool"
              : "system"
      const message: TestMessage = { id: `message-${run}-${index}`, role, startAt: index }
      if (role === "assistant" && random() < 0.35) {
        const callId = `call-${run}-${callIds.length}`
        callIds.push(callId)
        message.tool_calls = [{ id: callId, name: "test_tool", args: {} }]
      }
      if (role === "tool" && callIds.length > 0 && random() < 0.8) {
        message.tool_call_id = callIds[Math.floor(random() * callIds.length)]
      }
      messages.push(message)
    }

    const shuffled = [...messages]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1))
      const current = shuffled[index]
      shuffled[index] = shuffled[swapIndex]
      shuffled[swapIndex] = current
    }
    const hint = shuffled.filter(() => random() < 0.8).map((message) => ({ id: message.id }))
    const once = reconcileMessageDisplayOrder(messages, hint)
    const twice = reconcileMessageDisplayOrder(once, hint)

    assertEqual(once.length, messages.length, `random run ${run} should preserve message count`)
    assertEqual(
      new Set(once.map((message) => message.id)).size,
      messages.length,
      `random run ${run} should preserve unique ids`
    )
    assertEqual(ids(twice), ids(once), `random run ${run} should be idempotent`)
  }
}

function testVisibleMessageLayoutSkipsToolResultsForAdjacencyAndTail(): void {
  const messages: TestMessage[] = [
    { id: "user", role: "user", startAt: 0 },
    { id: "assistant-call", role: "assistant", startAt: 1 },
    { id: "tool-result-1", role: "tool", startAt: 2 },
    { id: "system-notice", role: "system", startAt: 3 },
    { id: "tool-result-2", role: "tool", startAt: 4 },
    { id: "assistant-final", role: "assistant", startAt: 5 },
    { id: "tool-result-tail", role: "tool", startAt: 6 }
  ]

  const layout = buildVisibleMessageLayout(messages, (message) => message.role !== "tool")

  assertEqual(
    layout.previousVisibleMessageByIndex[3]?.id,
    "assistant-call",
    "a system notice should see the previous visible assistant across a tool result"
  )
  assertEqual(
    layout.previousVisibleMessageByIndex[5]?.id,
    "system-notice",
    "a final assistant should see the previous visible system notice"
  )
  assertEqual(
    layout.lastVisibleMessageIndex,
    5,
    "a trailing tool result should not replace the last visible message"
  )
}

function testMessageVisibilityMatchesMessageBubbleBranches(): void {
  const createdAt = new Date("2026-07-20T00:00:00.000Z")
  const toolMessage: Message = {
    id: "tool",
    role: "tool",
    content: "visible only inside its tool card",
    created_at: createdAt
  }
  const emptySystemMessage: Message = {
    id: "empty-system",
    role: "system",
    content: "",
    created_at: createdAt
  }
  const reasoningMessage: Message = {
    id: "reasoning",
    role: "assistant",
    content: "",
    reasoning: "working",
    created_at: createdAt
  }
  const emptyWrappedReasoningMessage: Message = {
    id: "empty-wrapped-reasoning",
    role: "assistant",
    content: "",
    reasoning: " <think>   </think> ",
    created_at: createdAt
  }
  const toolCallMessage: Message = {
    id: "tool-call",
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", name: "read_file", args: {} }],
    created_at: createdAt
  }
  const emptyHookUserMessage: Message = {
    id: "empty-hook-user",
    role: "user",
    content: "",
    created_at: createdAt
  }

  assertEqual(messageRendersNothing(toolMessage), true, "tool results render inside tool cards")
  assertEqual(messageRendersNothing(emptySystemMessage), true, "empty system messages render null")
  assertEqual(messageRendersNothing(reasoningMessage), false, "assistant reasoning is visible")
  assertEqual(
    messageRendersNothing(emptyWrappedReasoningMessage),
    true,
    "reasoning removed by MessageBubble cleanup must not own a visible row"
  )
  assertEqual(messageRendersNothing(toolCallMessage), false, "assistant tool calls are visible")
  assertEqual(
    messageHasVisibleRow(emptyHookUserMessage, true),
    true,
    "an empty user message with a Hook chip still owns a visible row"
  )
  assertEqual(
    buildVisibleMessageLayout([reasoningMessage, emptyHookUserMessage], (message) =>
      messageHasVisibleRow(message, message.id === emptyHookUserMessage.id)
    ).lastVisibleMessageIndex,
    1,
    "a Hook-only user row must remain the final scroll and streaming boundary"
  )
}

function testReasoningUpdatesKeepToolDerivationsAndHistoryBubblesStable(): void {
  const createdAt = new Date("2026-07-20T00:00:00.000Z")
  const toolCallMessage: Message = {
    id: "assistant-tool-call",
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", name: "read_file", args: { path: "README.md" } }],
    created_at: createdAt
  }
  const messages: Message[] = [
    { id: "user", role: "user", content: "inspect", created_at: createdAt },
    toolCallMessage,
    {
      id: "tool-result",
      role: "tool",
      content: { ok: true },
      tool_call_id: "call-1",
      created_at: createdAt
    },
    {
      id: "active-reasoning",
      role: "assistant",
      content: "",
      reasoning: "first snapshot",
      created_at: createdAt
    }
  ]
  const updatedMessages = messages.map((message) => ({
    ...message,
    created_at: new Date(message.created_at?.getTime() ?? 0)
  }))
  updatedMessages[3] = { ...updatedMessages[3], reasoning: "second snapshot" }

  const selectStableToolMessages = createToolDerivationMessageSelector()
  const initialToolMessages = selectStableToolMessages(messages)
  const updatedToolMessages = selectStableToolMessages(updatedMessages)

  assertEqual(
    areToolDerivationMessagesEqual(
      selectToolDerivationMessages(messages),
      selectToolDerivationMessages(updatedMessages)
    ),
    true,
    "reasoning-only updates must not invalidate global tool derivations"
  )
  assertEqual(
    updatedToolMessages === initialToolMessages,
    true,
    "the tool derivation selector should preserve its array identity across reasoning updates"
  )
  assertEqual(
    areMessageRenderFieldsEqual(messages[1], updatedMessages[1]),
    true,
    "a cloned but unchanged history message should keep its memo boundary"
  )
  assertEqual(
    areMessageRenderFieldsEqual(messages[3], updatedMessages[3]),
    false,
    "the actively growing reasoning message must still render"
  )

  const toolKey = getWorkerToolUiKey(toolCallMessage.id, "call-1", 0)
  const previousInputs = {
    toolResults: new Map([[toolKey, { content: { ok: true }, is_error: false }]]),
    toolCallStates: new Map([
      [
        toolKey,
        {
          id: "call-1",
          status: "completed" as const,
          name: "read_file",
          args: { path: "README.md" },
          updatedAt: new Date("2026-07-20T00:00:01.000Z")
        }
      ]
    ]),
    pendingApprovalToolCallKeys: new Set<string>()
  }
  const nextInputs = {
    toolResults: new Map([[toolKey, { content: { ok: true }, is_error: false }]]),
    toolCallStates: new Map([
      [
        toolKey,
        {
          id: "call-1",
          status: "completed" as const,
          name: "read_file",
          args: { path: "README.md" },
          updatedAt: new Date("2026-07-20T00:00:02.000Z")
        }
      ]
    ]),
    pendingApprovalToolCallKeys: new Set<string>()
  }
  assertEqual(
    areMessageToolRenderInputsEqual(toolCallMessage, previousInputs, nextInputs),
    true,
    "new global map identities must not rerender a history bubble when its own tool state is unchanged"
  )
}

function testSchedulerSnapshotNormalizesRoleCollisionsBeforeDeltas(): void {
  const createdAt = new Date("2026-07-20T00:00:00.000Z")
  const sharedId = "scheduler-shared-id"
  const snapshot = normalizeSchedulerMessageSnapshot(
    [
      { id: sharedId, role: "user", content: "scheduled question" },
      { id: sharedId, role: "assistant", content: "scheduled answer" }
    ],
    createdAt
  )

  assertEqual(new Set(snapshot.map((message) => message.id)).size, 2, "snapshot ids must be unique")
  const normalizedDelta = normalizeMessageRoleCollisionIds(snapshot, [
    { id: sharedId, role: "assistant" as const }
  ])[0]
  assertEqual(
    snapshot.some(
      (message) => message.id === normalizedDelta.id && message.role === normalizedDelta.role
    ),
    true,
    "a later assistant delta must resolve to the assistant already stored by the snapshot"
  )
}

function testHookLogTurnIdFollowsUserRoleCollisionId(): void {
  const providerId = "shared-user-assistant-id"
  const assistantBaseline = [{ id: providerId, role: "assistant" }]
  const normalizedTurnId = normalizeHookLogTurnId(assistantBaseline, providerId)

  assertEqual(
    normalizedTurnId === providerId,
    false,
    "a user hook bucket must not reuse an assistant render id"
  )
  assertEqual(
    normalizeHookLogTurnId(
      [...assistantBaseline, { id: normalizedTurnId!, role: "user" }],
      providerId
    ),
    normalizedTurnId,
    "later raw hook events must resolve to the same normalized user turn id"
  )
}

function testPendingHookLogOpenUsesCommittedCollisionId(): void {
  const providerId = "batched-shared-id"
  const staleBaseline: Array<{ id: string; role: "user" | "assistant" }> = []
  const pendingAssistant = normalizeMessageRoleCollisionIds(staleBaseline, [
    { id: providerId, role: "assistant" as const }
  ])[0]
  const pendingUser = normalizeMessageRoleCollisionIds(staleBaseline, [
    { id: providerId, role: "user" as const }
  ])[0]
  const committedAssistant = normalizeMessageRoleCollisionIds(staleBaseline, [pendingAssistant])[0]
  const committedUser = normalizeMessageRoleCollisionIds([committedAssistant], [pendingUser])[0]
  const committedMessages = [committedAssistant, committedUser]

  assertEqual(
    pendingUser.id,
    providerId,
    "a batched user append can initially retain the provider id"
  )
  assertEqual(
    resolveHookLogUserMessage(committedMessages, providerId)?.id,
    committedUser.id,
    "the pending bucket open must use the id assigned by the committed state"
  )
  assertEqual(
    committedUser.id === providerId,
    false,
    "the regression setup must exercise a second-pass id change"
  )
}

function testRoleCollisionIdentityMatchesOppositeSourceKeepers(): void {
  const providerId = "opposite-source-keepers"
  const uiMessages = normalizeMessageRoleCollisionIds(
    [],
    [
      { id: providerId, role: "user" as const },
      { id: providerId, role: "assistant" as const }
    ]
  )
  const persistedMessages = normalizeMessageRoleCollisionIds(
    [],
    [
      { id: providerId, role: "assistant" as const },
      { id: providerId, role: "user" as const }
    ]
  )
  const persistedByIdentity = new Map(
    persistedMessages.map((message) => [getMessageRoleCollisionIdentity(message), message])
  )

  for (const uiMessage of uiMessages) {
    const persistedMessage = persistedByIdentity.get(getMessageRoleCollisionIdentity(uiMessage))
    assertEqual(
      persistedMessage?.role,
      uiMessage.role,
      "cross-source matching must follow source id plus role instead of the render id keeper"
    )
  }
}

function testReasoningSurvivesOppositeRoleCollisionKeepers(): void {
  const providerId = "reasoning-opposite-source-keepers"
  const existingMessages = mergeCheckpointAuthorityTranscriptMessages(
    [
      { id: providerId, role: "user", content: "question" },
      {
        id: providerId,
        role: "assistant",
        content: "answer",
        reasoning: "preserved reasoning"
      }
    ],
    []
  )
  const incomingMessages = mergeCheckpointAuthorityTranscriptMessages(
    [
      { id: providerId, role: "assistant", content: "answer" },
      { id: providerId, role: "user", content: "question" }
    ],
    []
  )
  const existingAssistant = existingMessages.find((message) => message.role === "assistant")
  const incomingAssistant = incomingMessages.find((message) => message.role === "assistant")
  const preserved = preserveAssistantReasoningByRoleCollisionIdentity(
    existingMessages,
    incomingMessages
  )

  assertEqual(
    existingAssistant?.id === incomingAssistant?.id,
    false,
    "the regression setup must choose different render-id keepers"
  )
  assertEqual(
    preserved.find((message) => message.role === "assistant")?.reasoning,
    "preserved reasoning",
    "reasoning restore must match source id plus role instead of the render id"
  )

  const canonicalPreserved = preserveAssistantReasoningByRoleCollisionIdentity(
    [
      {
        id: "reasoning-canonical-id",
        provider_source_id: providerId,
        provider_occurrence: 1,
        role: "assistant",
        content: "answer",
        reasoning: "canonical reasoning"
      }
    ],
    [{ id: providerId, role: "assistant", content: "answer" }]
  )
  assertEqual(
    canonicalPreserved[0]?.reasoning,
    "canonical reasoning",
    "reasoning restore must match canonical and raw ids for the same provider occurrence"
  )
}

function testRoleCollisionNormalizationTrimsProviderIds(): void {
  const normalized = normalizeMessageRoleCollisionIds(
    [],
    [{ id: "  padded-provider-id  ", role: "assistant" as const }]
  )[0]

  assertEqual(
    normalized.id,
    "padded-provider-id",
    "render ids should use the same trimming contract as durable storage"
  )
  assertEqual(
    getMessageRoleCollisionIdentity({
      id: "  padded-provider-id::cmb-id-collision:assistant  ",
      role: "assistant"
    }),
    getMessageRoleCollisionIdentity({ id: "padded-provider-id", role: "assistant" }),
    "synthetic and raw identities should stay aligned after trimming"
  )
}

const tests: Array<[string, () => void]> = [
  [
    "testLateToolResultUsesSnapshotOrderInsteadOfArrivalTime",
    testLateToolResultUsesSnapshotOrderInsteadOfArrivalTime
  ],
  [
    "testLateToolCallAndResultMoveTogetherBeforeFinalAnswer",
    testLateToolCallAndResultMoveTogetherBeforeFinalAnswer
  ],
  ["testMessagesMissingFromSnapshotRemainAnchored", testMessagesMissingFromSnapshotRemainAnchored],
  [
    "testPersistedTranscriptOrderWinsWithoutLiveSnapshot",
    testPersistedTranscriptOrderWinsWithoutLiveSnapshot
  ],
  [
    "testPersistedMergePreservesDatabaseOrdinalOrder",
    testPersistedMergePreservesDatabaseOrdinalOrder
  ],
  [
    "testSameRoleProviderIdReuseAfterUserBoundaryGetsNewOccurrence",
    testSameRoleProviderIdReuseAfterUserBoundaryGetsNewOccurrence
  ],
  [
    "testAssistantProviderIdReuseAfterToolBoundaryGetsNewOccurrence",
    testAssistantProviderIdReuseAfterToolBoundaryGetsNewOccurrence
  ],
  ["testReasoningGrowthChangesScrollLength", testReasoningGrowthChangesScrollLength],
  [
    "testStreamingReasoningCollapsesWhenToolCallStarts",
    testStreamingReasoningCollapsesWhenToolCallStarts
  ],
  [
    "testQueuedCrossRoleUpdatesUsePersistedKeeperOrder",
    testQueuedCrossRoleUpdatesUsePersistedKeeperOrder
  ],
  [
    "testDurableSyncMissingToolTailUsesFinalSnapshotOrder",
    testDurableSyncMissingToolTailUsesFinalSnapshotOrder
  ],
  [
    "testStableHistoryWithoutLiveHintKeepsAssistantPreamble",
    testStableHistoryWithoutLiveHintKeepsAssistantPreamble
  ],
  [
    "testSoloToolCallGroupKeepsEarlierAssistantPreamble",
    testSoloToolCallGroupKeepsEarlierAssistantPreamble
  ],
  [
    "testSoloToolCallGroupKeepsLateTimestampAssistantPreamble",
    testSoloToolCallGroupKeepsLateTimestampAssistantPreamble
  ],
  [
    "testMultipleToolGroupsKeepMiddleAssistantInPlace",
    testMultipleToolGroupsKeepMiddleAssistantInPlace
  ],
  ["testParallelToolResultsKeepSnapshotOrder", testParallelToolResultsKeepSnapshotOrder],
  [
    "testToolResultMovesNextToHeadWithoutReorderingAssistantPrefix",
    testToolResultMovesNextToHeadWithoutReorderingAssistantPrefix
  ],
  [
    "testMultipleToolGroupsReconcileWithoutReorderingAssistantPrefix",
    testMultipleToolGroupsReconcileWithoutReorderingAssistantPrefix
  ],
  [
    "testReconciliationIsIdempotentWithSnapshotExternalSystemAnchor",
    testReconciliationIsIdempotentWithSnapshotExternalSystemAnchor
  ],
  [
    "testDuplicateMessageIdsFailClosedWithoutDroppingMessages",
    testDuplicateMessageIdsFailClosedWithoutDroppingMessages
  ],
  [
    "testNonToolToolCallIdDoesNotMoveVisibleAssistant",
    testNonToolToolCallIdDoesNotMoveVisibleAssistant
  ],
  ["testHintedMessagesNeverCrossUserTurnBoundary", testHintedMessagesNeverCrossUserTurnBoundary],
  [
    "testAmbiguousRepeatedToolCallIdPreservesOriginalOrder",
    testAmbiguousRepeatedToolCallIdPreservesOriginalOrder
  ],
  [
    "testCrossRoleCollisionToolResultStaysAttachedToItsAssistant",
    testCrossRoleCollisionToolResultStaysAttachedToItsAssistant
  ],
  ["testRandomizedReconciliationInvariants", testRandomizedReconciliationInvariants],
  [
    "testVisibleMessageLayoutSkipsToolResultsForAdjacencyAndTail",
    testVisibleMessageLayoutSkipsToolResultsForAdjacencyAndTail
  ],
  [
    "testMessageVisibilityMatchesMessageBubbleBranches",
    testMessageVisibilityMatchesMessageBubbleBranches
  ],
  [
    "testReasoningUpdatesKeepToolDerivationsAndHistoryBubblesStable",
    testReasoningUpdatesKeepToolDerivationsAndHistoryBubblesStable
  ],
  [
    "testSchedulerSnapshotNormalizesRoleCollisionsBeforeDeltas",
    testSchedulerSnapshotNormalizesRoleCollisionsBeforeDeltas
  ],
  ["testHookLogTurnIdFollowsUserRoleCollisionId", testHookLogTurnIdFollowsUserRoleCollisionId],
  [
    "testPendingHookLogOpenUsesCommittedCollisionId",
    testPendingHookLogOpenUsesCommittedCollisionId
  ],
  [
    "testRoleCollisionIdentityMatchesOppositeSourceKeepers",
    testRoleCollisionIdentityMatchesOppositeSourceKeepers
  ],
  [
    "testReasoningSurvivesOppositeRoleCollisionKeepers",
    testReasoningSurvivesOppositeRoleCollisionKeepers
  ],
  ["testRoleCollisionNormalizationTrimsProviderIds", testRoleCollisionNormalizationTrimsProviderIds]
]

for (const [name, test] of tests) {
  test()
  console.log(`PASS ${name}`)
}
