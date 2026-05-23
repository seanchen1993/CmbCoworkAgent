/**
 * Unit tests for checkpoint message time restoration helpers.
 *
 * Run:
 *   npx tsx tests/checkpoint-message-times.spec.ts
 */

import { restoreRawCheckpointMessageTime } from "../src/renderer/src/lib/checkpoint-message-times.ts"

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

function run(): void {
  testInternalGoalPromptUsesInternalTimeById()
  testInternalGoalPromptUsesInternalOrderFallback()
  testVisibleMessageDoesNotUseInternalGoalTime()
  testMultipleInternalGoalPromptsUseInternalOnlyOrder()
  console.log("checkpoint-message-times tests passed")
}

run()
