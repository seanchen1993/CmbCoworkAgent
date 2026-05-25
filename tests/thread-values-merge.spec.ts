import assert from "node:assert/strict"

import { mergeThreadValueObjects } from "../src/shared/thread-values"

function testMergesIndependentMessageTimeWrites(): void {
  const existing = {
    messageTimes: {
      user_1: { start_at: "2026-05-24T01:00:00.000Z", end_at: "2026-05-24T01:00:00.000Z" }
    },
    messageTimeOrder: [
      { id: "user_1", start_at: "2026-05-24T01:00:00.000Z", end_at: "2026-05-24T01:00:00.000Z" }
    ]
  }

  const userPatch = {
    messageTimes: {
      user_2: { start_at: "2026-05-24T01:01:00.000Z", end_at: "2026-05-24T01:01:00.000Z" }
    },
    messageTimeOrder: [
      { id: "user_2", start_at: "2026-05-24T01:01:00.000Z", end_at: "2026-05-24T01:01:00.000Z" }
    ]
  }

  const internalGoalPatch = {
    internalGoalMessageTimes: {
      goal_1: {
        start_at: "2026-05-24T01:01:02.000Z",
        end_at: "2026-05-24T01:01:03.000Z"
      }
    },
    internalGoalMessageTimeOrder: [
      {
        id: "goal_1",
        start_at: "2026-05-24T01:01:02.000Z",
        end_at: "2026-05-24T01:01:03.000Z"
      }
    ]
  }

  const merged = mergeThreadValueObjects(
    mergeThreadValueObjects(existing, userPatch),
    internalGoalPatch
  )

  assert.deepEqual(Object.keys(merged.messageTimes as Record<string, unknown>), [
    "user_1",
    "user_2"
  ])
  assert.deepEqual(Object.keys(merged.internalGoalMessageTimes as Record<string, unknown>), [
    "goal_1"
  ])
  assert.deepEqual(
    (merged.messageTimeOrder as Array<{ id: string }>).map((entry) => entry.id),
    ["user_1", "user_2"]
  )
  assert.deepEqual(
    (merged.internalGoalMessageTimeOrder as Array<{ id: string }>).map((entry) => entry.id),
    ["goal_1"]
  )
}

function testUpdatesExistingOrderEntryWithoutDuplicating(): void {
  const merged = mergeThreadValueObjects(
    {
      messageTimes: {
        assistant_1: { start_at: "2026-05-24T01:00:00.000Z" }
      },
      messageTimeOrder: [{ id: "assistant_1", start_at: "2026-05-24T01:00:00.000Z" }]
    },
    {
      messageTimes: {
        assistant_1: { end_at: "2026-05-24T01:00:10.000Z" }
      },
      messageTimeOrder: [{ id: "assistant_1", end_at: "2026-05-24T01:00:10.000Z" }]
    }
  )

  assert.deepEqual(merged.messageTimes, {
    assistant_1: {
      start_at: "2026-05-24T01:00:00.000Z",
      end_at: "2026-05-24T01:00:10.000Z"
    }
  })
  assert.deepEqual(merged.messageTimeOrder, [
    {
      id: "assistant_1",
      start_at: "2026-05-24T01:00:00.000Z",
      end_at: "2026-05-24T01:00:10.000Z"
    }
  ])
}

function testPatchOverwritesScalarValues(): void {
  const merged = mergeThreadValueObjects(
    { metadataVersion: 1, nested: { keep: true } },
    { metadataVersion: 2, nested: "reset" }
  )

  assert.deepEqual(merged, { metadataVersion: 2, nested: "reset" })
}

function testOnlyKnownOrderArraysUseIdMergeSemantics(): void {
  const replaced = mergeThreadValueObjects(
    {
      arbitraryItems: [
        { id: "item_1", value: "old" },
        { id: "item_2", value: "keep?" }
      ]
    },
    {
      arbitraryItems: [{ id: "item_1", value: "new" }]
    }
  )

  assert.deepEqual(replaced.arbitraryItems, [{ id: "item_1", value: "new" }])

  const cleared = mergeThreadValueObjects(
    {
      arbitraryItems: [{ id: "item_1", value: "old" }]
    },
    { arbitraryItems: [] }
  )

  assert.deepEqual(cleared.arbitraryItems, [])
}

function testEmptyIdArrayPatchDoesNotClearExistingOrder(): void {
  const merged = mergeThreadValueObjects(
    {
      messageTimeOrder: [
        {
          id: "user_1",
          start_at: "2026-05-24T01:00:00.000Z",
          end_at: "2026-05-24T01:00:00.000Z"
        }
      ]
    },
    { messageTimeOrder: [] }
  )

  assert.deepEqual(merged.messageTimeOrder, [
    {
      id: "user_1",
      start_at: "2026-05-24T01:00:00.000Z",
      end_at: "2026-05-24T01:00:00.000Z"
    }
  ])
}

function testLegacyMessageTimesSeedOrderBeforeMergingNewEntries(): void {
  const merged = mergeThreadValueObjects(
    {
      messageTimes: {
        user_1: {
          start_at: "2026-05-24T01:00:00.000Z",
          end_at: "2026-05-24T01:00:00.000Z"
        },
        assistant_1: {
          start_at: "2026-05-24T01:00:05.000Z",
          end_at: "2026-05-24T01:00:15.000Z"
        }
      }
    },
    {
      messageTimes: {
        user_2: {
          start_at: "2026-05-24T01:01:00.000Z",
          end_at: "2026-05-24T01:01:00.000Z"
        }
      },
      messageTimeOrder: [
        {
          id: "user_2",
          start_at: "2026-05-24T01:01:00.000Z",
          end_at: "2026-05-24T01:01:00.000Z"
        }
      ]
    }
  )

  assert.deepEqual(
    (merged.messageTimeOrder as Array<{ id: string }>).map((entry) => entry.id),
    ["user_1", "assistant_1", "user_2"]
  )
}

function testLegacyInternalGoalTimesSeedOrderBeforeMergingNewEntries(): void {
  const merged = mergeThreadValueObjects(
    {
      internalGoalMessageTimes: {
        goal_start_1: {
          start_at: "2026-05-24T01:00:00.000Z",
          end_at: "2026-05-24T01:00:01.000Z"
        }
      }
    },
    {
      internalGoalMessageTimes: {
        goal_continue_1: {
          start_at: "2026-05-24T01:02:00.000Z",
          end_at: "2026-05-24T01:02:01.000Z"
        }
      },
      internalGoalMessageTimeOrder: [
        {
          id: "goal_continue_1",
          start_at: "2026-05-24T01:02:00.000Z",
          end_at: "2026-05-24T01:02:01.000Z"
        }
      ]
    }
  )

  assert.deepEqual(
    (merged.internalGoalMessageTimeOrder as Array<{ id: string }>).map((entry) => entry.id),
    ["goal_start_1", "goal_continue_1"]
  )
}

testMergesIndependentMessageTimeWrites()
testUpdatesExistingOrderEntryWithoutDuplicating()
testPatchOverwritesScalarValues()
testOnlyKnownOrderArraysUseIdMergeSemantics()
testEmptyIdArrayPatchDoesNotClearExistingOrder()
testLegacyMessageTimesSeedOrderBeforeMergingNewEntries()
testLegacyInternalGoalTimesSeedOrderBeforeMergingNewEntries()

console.log("thread-values-merge.spec.ts: all tests passed")
