/**
 * Unit tests for Goal UI event merging.
 *
 * Run:
 *   npx tsx tests/goal-ui-events.spec.ts
 */

import { mergeGoalUiEvents } from "../src/renderer/src/lib/goal-ui-events.ts"
import type { GoalEvent } from "../src/renderer/src/types.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

function event(eventId: number, createdAt: string, message = `event ${eventId}`): GoalEvent {
  return {
    event_id: eventId,
    thread_id: "thread-1",
    goal_id: "goal-1",
    message,
    created_at: new Date(createdAt)
  }
}

function testRestoredEventsDoNotOverwriteLiveEvents(): void {
  const restored = [
    event(1, "2026-05-23T01:00:00.000Z"),
    event(2, "2026-05-23T01:00:01.000Z", "old event 2")
  ]
  const live = [
    event(2, "2026-05-23T01:00:01.000Z", "live event 2"),
    event(3, "2026-05-23T01:00:02.000Z")
  ]

  const merged = mergeGoalUiEvents(restored, live)

  assertEqual(merged.length, 3, "merge should keep restored and live events")
  assertEqual(merged[0]?.event_id, 1, "merge should preserve chronological order")
  assertEqual(merged[1]?.event_id, 2, "merge should dedupe by event_id")
  assertEqual(
    merged[1]?.message,
    "live event 2",
    "live event should win when restored and live share event_id"
  )
  assertEqual(merged[2]?.event_id, 3, "merge should keep live-only event")
}

function testInvalidDatesFallBackToEventIdOrdering(): void {
  const merged = mergeGoalUiEvents(
    [
      {
        ...event(5, "invalid-date"),
        created_at: "invalid-date"
      },
      {
        ...event(4, "invalid-date"),
        created_at: "invalid-date"
      }
    ],
    []
  )

  assertEqual(merged[0]?.event_id, 4, "invalid dates should sort by event_id")
  assertEqual(merged[1]?.event_id, 5, "invalid dates should sort by event_id")
}

const tests: Array<[string, () => void]> = [
  ["testRestoredEventsDoNotOverwriteLiveEvents", testRestoredEventsDoNotOverwriteLiveEvents],
  ["testInvalidDatesFallBackToEventIdOrdering", testInvalidDatesFallBackToEventIdOrdering]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
