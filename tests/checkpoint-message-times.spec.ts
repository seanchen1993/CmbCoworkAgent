/**
 * Unit tests for checkpoint message time restoration helpers.
 *
 * Run:
 *   npx tsx tests/checkpoint-message-times.spec.ts
 */

import {
  latestPersistedCheckpointMessageAt,
  restoreRawCheckpointMessageTime,
  restoreVisibleCheckpointMessageTimes
} from "../src/renderer/src/lib/checkpoint-message-times.ts"
import { buildMessageRoleCollisionId } from "../src/shared/message-role-collision.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function testInternalGoalPromptUsesInternalTimeById(): void {
  const restored = restoreRawCheckpointMessageTime({
    messageId: "internal-start-1",
    fallbackTime: new Date("2026-05-22T12:00:00.000Z"),
    isInternalGoalPrompt: true,
    internalGoalPromptIndex: 0,
    persistedMessageTimes: {},
    persistedInternalGoalMessageTimes: {
      "internal-start-1": {
        start_at: "2026-05-22T10:00:00.000Z",
        end_at: "2026-05-22T10:00:02.000Z"
      }
    },
    persistedInternalGoalMessageTimeOrder: []
  })

  assertEqual(
    restored.startAt.toISOString(),
    "2026-05-22T10:00:00.000Z",
    "internal goal prompt should restore its persisted start time by id"
  )
  assertEqual(
    restored.endAt.toISOString(),
    "2026-05-22T10:00:02.000Z",
    "internal goal prompt should restore its persisted end time by id"
  )
}

function testInternalGoalPromptUsesInternalOrderFallback(): void {
  const restored = restoreRawCheckpointMessageTime({
    messageId: "changed-checkpoint-id",
    fallbackTime: new Date("2026-05-22T12:00:00.000Z"),
    isInternalGoalPrompt: true,
    internalGoalPromptIndex: 1,
    persistedMessageTimes: {},
    persistedInternalGoalMessageTimes: {},
    persistedInternalGoalMessageTimeOrder: [
      {
        id: "old-internal-start",
        start_at: "2026-05-22T09:59:00.000Z",
        end_at: "2026-05-22T09:59:01.000Z"
      },
      {
        id: "old-internal-continue",
        start_at: "2026-05-22T10:05:00.000Z",
        end_at: "2026-05-22T10:05:01.000Z"
      }
    ]
  })

  assertEqual(
    restored.startAt.toISOString(),
    "2026-05-22T10:05:00.000Z",
    "internal goal prompt should use internal order fallback when checkpoint id changes"
  )
}

function testVisibleMessageDoesNotUseInternalGoalTime(): void {
  const restored = restoreRawCheckpointMessageTime({
    messageId: "visible-user",
    fallbackTime: new Date("2026-05-22T12:00:00.000Z"),
    isInternalGoalPrompt: false,
    internalGoalPromptIndex: -1,
    persistedMessageTimes: {
      "visible-user": {
        start_at: "2026-05-22T11:00:00.000Z",
        end_at: "2026-05-22T11:00:00.000Z"
      }
    },
    persistedInternalGoalMessageTimes: {
      "visible-user": {
        start_at: "2026-05-22T10:00:00.000Z",
        end_at: "2026-05-22T10:00:00.000Z"
      }
    },
    persistedInternalGoalMessageTimeOrder: []
  })

  assertEqual(
    restored.startAt.toISOString(),
    "2026-05-22T11:00:00.000Z",
    "visible checkpoint messages must keep using normal message times"
  )
}

function testMultipleInternalGoalPromptsUseInternalOnlyOrder(): void {
  const internalOrder = [
    {
      id: "old-start",
      start_at: "2026-05-22T10:00:00.000Z",
      end_at: "2026-05-22T10:00:01.000Z"
    },
    {
      id: "old-continue",
      start_at: "2026-05-22T10:05:00.000Z",
      end_at: "2026-05-22T10:05:01.000Z"
    },
    {
      id: "old-next-continue",
      start_at: "2026-05-22T10:10:00.000Z",
      end_at: "2026-05-22T10:10:01.000Z"
    }
  ]

  const firstInternal = restoreRawCheckpointMessageTime({
    messageId: "new-start-id",
    fallbackTime: new Date("2026-05-22T12:00:00.000Z"),
    isInternalGoalPrompt: true,
    internalGoalPromptIndex: 0,
    persistedMessageTimes: {},
    persistedInternalGoalMessageTimes: {},
    persistedInternalGoalMessageTimeOrder: internalOrder
  })
  const visibleBetween = restoreRawCheckpointMessageTime({
    messageId: "visible-assistant",
    fallbackTime: new Date("2026-05-22T12:00:00.000Z"),
    isInternalGoalPrompt: false,
    internalGoalPromptIndex: -1,
    persistedMessageTimes: {
      "visible-assistant": {
        start_at: "2026-05-22T10:02:00.000Z",
        end_at: "2026-05-22T10:02:05.000Z"
      }
    },
    persistedInternalGoalMessageTimes: {},
    persistedInternalGoalMessageTimeOrder: internalOrder
  })
  const secondInternal = restoreRawCheckpointMessageTime({
    messageId: "new-continue-id",
    fallbackTime: new Date("2026-05-22T12:00:00.000Z"),
    isInternalGoalPrompt: true,
    internalGoalPromptIndex: 1,
    persistedMessageTimes: {},
    persistedInternalGoalMessageTimes: {},
    persistedInternalGoalMessageTimeOrder: internalOrder
  })

  assertEqual(
    firstInternal.startAt.toISOString(),
    "2026-05-22T10:00:00.000Z",
    "first internal prompt should use the first internal order entry"
  )
  assertEqual(
    visibleBetween.startAt.toISOString(),
    "2026-05-22T10:02:00.000Z",
    "visible messages should not consume internal prompt order entries"
  )
  assertEqual(
    secondInternal.startAt.toISOString(),
    "2026-05-22T10:05:00.000Z",
    "second internal prompt should use the second internal order entry even with visible messages between"
  )
}

function testVisibleOrderFallbackRestoresEndTimeWhenIdsChange(): void {
  const restored = restoreVisibleCheckpointMessageTimes(
    [
      {
        id: "changed-user-id",
        role: "user",
        content: "hello",
        created_at: new Date("2026-05-22T12:00:00.000Z"),
        start_at: new Date("2026-05-22T12:00:00.000Z"),
        end_at: new Date("2026-05-22T12:00:00.000Z")
      }
    ],
    {},
    [
      {
        id: "old-user-id",
        start_at: "2026-05-22T10:00:00.000Z",
        end_at: "2026-05-22T10:00:05.000Z"
      }
    ]
  )

  assertEqual(
    restored[0].start_at?.toISOString(),
    "2026-05-22T10:00:00.000Z",
    "visible order fallback should restore persisted start time when checkpoint id changes"
  )
  assertEqual(
    restored[0].end_at?.toISOString(),
    "2026-05-22T10:00:05.000Z",
    "visible order fallback should restore persisted end time when checkpoint id changes"
  )
}

function testVisibleInferredTimeDoesNotReuseCurrentFallbackEndTime(): void {
  const restored = restoreVisibleCheckpointMessageTimes(
    [
      {
        id: "changed-user-id",
        role: "user",
        content: "hello",
        created_at: new Date("2026-05-22T12:00:00.000Z"),
        start_at: new Date("2026-05-22T12:00:00.000Z"),
        end_at: new Date("2026-05-22T12:00:00.000Z")
      },
      {
        id: "assistant-id",
        role: "assistant",
        content: "reply",
        created_at: new Date("2026-05-22T12:00:00.000Z"),
        start_at: new Date("2026-05-22T12:00:00.000Z"),
        end_at: new Date("2026-05-22T12:00:00.000Z")
      }
    ],
    {
      "assistant-id": {
        start_at: "2026-05-22T10:00:10.000Z",
        end_at: "2026-05-22T10:00:15.000Z"
      }
    },
    []
  )

  assertEqual(
    restored[0].start_at?.toISOString(),
    "2026-05-22T10:00:09.000Z",
    "unmatched visible user should anchor before the next known response"
  )
  assertEqual(
    restored[0].end_at?.toISOString(),
    "2026-05-22T10:00:09.000Z",
    "inferred visible time should not reuse raw checkpoint fallback end time from history load"
  )
}

function testFinalTranscriptOrderFallbackKeepsGoalUserSlot(): void {
  const restored = restoreVisibleCheckpointMessageTimes(
    [
      {
        id: "goal-user-event-1",
        role: "user",
        created_at: new Date("2026-05-24T12:00:00.000Z"),
        start_at: new Date("2026-05-24T12:00:00.000Z"),
        end_at: new Date("2026-05-24T12:00:00.000Z")
      },
      {
        id: "changed-assistant-id",
        role: "assistant",
        created_at: new Date("2026-05-24T12:00:00.000Z"),
        start_at: new Date("2026-05-24T12:00:00.000Z"),
        end_at: new Date("2026-05-24T12:00:00.000Z")
      }
    ],
    {},
    [
      {
        id: "live-goal-user-id",
        start_at: "2026-05-22T10:00:00.000Z",
        end_at: "2026-05-22T10:00:00.000Z"
      },
      {
        id: "old-assistant-id",
        start_at: "2026-05-22T10:00:05.000Z",
        end_at: "2026-05-22T10:00:08.000Z"
      }
    ]
  )

  assertEqual(
    restored[0].start_at?.toISOString(),
    "2026-05-22T10:00:00.000Z",
    "restored /goal user message should consume the original /goal user time slot"
  )
  assertEqual(
    restored[1].start_at?.toISOString(),
    "2026-05-22T10:00:05.000Z",
    "assistant message should not inherit the hidden/restored /goal user time slot"
  )
  assertEqual(
    restored[1].end_at?.toISOString(),
    "2026-05-22T10:00:08.000Z",
    "assistant message should keep its own persisted end time after goal user insertion"
  )
}

function testFinalTranscriptMixedIdRestoreKeepsAssistantExactTime(): void {
  const restored = restoreVisibleCheckpointMessageTimes(
    [
      {
        id: "goal-user-event-1",
        role: "user",
        created_at: new Date("2026-05-24T12:00:00.000Z"),
        start_at: new Date("2026-05-24T12:00:00.000Z"),
        end_at: new Date("2026-05-24T12:00:00.000Z")
      },
      {
        id: "assistant-id",
        role: "assistant",
        created_at: new Date("2026-05-24T12:00:00.000Z"),
        start_at: new Date("2026-05-24T12:00:00.000Z"),
        end_at: new Date("2026-05-24T12:00:00.000Z")
      }
    ],
    {
      "assistant-id": {
        start_at: "2026-05-22T10:00:05.000Z",
        end_at: "2026-05-22T10:00:08.000Z"
      }
    },
    [
      {
        id: "live-goal-user-id",
        start_at: "2026-05-22T10:00:00.000Z",
        end_at: "2026-05-22T10:00:00.000Z"
      },
      {
        id: "assistant-id",
        start_at: "2026-05-22T10:00:05.000Z",
        end_at: "2026-05-22T10:00:08.000Z"
      }
    ]
  )

  assertEqual(
    restored[0].start_at?.toISOString(),
    "2026-05-22T10:00:04.000Z",
    "unmatched restored /goal user message should anchor before the exact assistant response"
  )
  assertEqual(
    restored[1].start_at?.toISOString(),
    "2026-05-22T10:00:05.000Z",
    "assistant should keep exact id-based start time when /goal event id differs"
  )
  assertEqual(
    restored[1].end_at?.toISOString(),
    "2026-05-22T10:00:08.000Z",
    "assistant should keep exact id-based end time when /goal event id differs"
  )
}

function testPersistedCheckpointMessageLatestIgnoresMessagesOutsideCheckpoint(): void {
  const latest = latestPersistedCheckpointMessageAt(
    [{ id: "user-1" }, { id: "assistant-1" }],
    [
      {
        id: "assistant-1",
        created_at: new Date("2026-05-22T10:00:04.000Z"),
        start_at: new Date("2026-05-22T10:00:05.000Z")
      },
      {
        id: "post-checkpoint-user",
        created_at: new Date("2026-05-22T10:10:00.000Z"),
        start_at: new Date("2026-05-22T10:10:00.000Z")
      }
    ]
  )

  assertEqual(
    latest?.toISOString(),
    "2026-05-22T10:00:05.000Z",
    "pending approval restore gating should ignore persisted messages outside the checkpoint"
  )
}

function testPersistedCheckpointLatestMatchesOppositeRoleCollisionKeepers(): void {
  const sharedId = "checkpoint-time-role-collision"
  const latest = latestPersistedCheckpointMessageAt(
    [
      { id: buildMessageRoleCollisionId(sharedId, "assistant"), role: "assistant" },
      { id: sharedId, role: "system" }
    ],
    [
      {
        id: sharedId,
        role: "assistant",
        created_at: new Date("2026-05-22T10:00:01.000Z")
      },
      {
        id: buildMessageRoleCollisionId(sharedId, "system"),
        role: "system",
        created_at: new Date("2026-05-22T10:00:03.000Z")
      }
    ]
  )

  assertEqual(
    latest?.toISOString(),
    "2026-05-22T10:00:03.000Z",
    "approval gating should use the latest role identity when raw-id keepers differ"
  )
}

function testVisibleRestoreMatchesOppositeRoleCollisionKeepers(): void {
  const sharedId = "visible-time-role-collision"
  const oldUserId = buildMessageRoleCollisionId(sharedId, "user")
  const restoredAssistantId = buildMessageRoleCollisionId(sharedId, "assistant")
  const fallback = new Date("2026-05-22T12:00:00.000Z")
  const restored = restoreVisibleCheckpointMessageTimes(
    [
      { id: sharedId, role: "user", created_at: fallback },
      { id: restoredAssistantId, role: "assistant", created_at: fallback }
    ],
    {
      [oldUserId]: { start_at: "2026-05-22T10:00:01.000Z" },
      [sharedId]: { start_at: "2026-05-22T10:00:10.000Z" }
    },
    [],
    [
      { id: sharedId, role: "assistant", created_at: fallback },
      { id: oldUserId, role: "user", created_at: fallback }
    ]
  )

  assertEqual(
    restored[0].start_at?.toISOString(),
    "2026-05-22T10:00:01.000Z",
    "user time should follow source id plus role when the raw-id keeper changes"
  )
  assertEqual(
    restored[1].start_at?.toISOString(),
    "2026-05-22T10:00:10.000Z",
    "assistant time should follow source id plus role instead of being inferred after the user"
  )

  const canonicalId = "visible-time-canonical"
  const canonicalProviderId = "visible-time-provider"
  const canonicalRestored = restoreVisibleCheckpointMessageTimes(
    [{ id: canonicalProviderId, role: "assistant", created_at: fallback }],
    {
      [canonicalId]: { start_at: "2026-05-22T10:00:20.000Z" }
    },
    [],
    [
      {
        id: canonicalId,
        provider_source_id: canonicalProviderId,
        provider_occurrence: 1,
        role: "assistant",
        created_at: fallback
      }
    ]
  )
  assertEqual(
    canonicalRestored[0].start_at?.toISOString(),
    "2026-05-22T10:00:20.000Z",
    "checkpoint time restore must match canonical and raw ids for one provider occurrence"
  )
}

function run(): void {
  testInternalGoalPromptUsesInternalTimeById()
  testInternalGoalPromptUsesInternalOrderFallback()
  testVisibleMessageDoesNotUseInternalGoalTime()
  testMultipleInternalGoalPromptsUseInternalOnlyOrder()
  testVisibleOrderFallbackRestoresEndTimeWhenIdsChange()
  testVisibleInferredTimeDoesNotReuseCurrentFallbackEndTime()
  testFinalTranscriptOrderFallbackKeepsGoalUserSlot()
  testFinalTranscriptMixedIdRestoreKeepsAssistantExactTime()
  testPersistedCheckpointMessageLatestIgnoresMessagesOutsideCheckpoint()
  testPersistedCheckpointLatestMatchesOppositeRoleCollisionKeepers()
  testVisibleRestoreMatchesOppositeRoleCollisionKeepers()
  console.log("checkpoint-message-times tests passed")
}

run()
