import { reconcileMessageDisplayOrder } from "../src/renderer/src/lib/message-display-order.ts"

interface TestMessage {
  id: string
  role: "user" | "assistant" | "tool"
  startAt: number
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
    "testDurableSyncMissingToolTailUsesFinalSnapshotOrder",
    testDurableSyncMissingToolTailUsesFinalSnapshotOrder
  ]
]

for (const [name, test] of tests) {
  test()
  console.log(`PASS ${name}`)
}
