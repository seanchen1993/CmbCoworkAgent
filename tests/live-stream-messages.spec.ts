/**
 * Unit tests for live stream message accumulation.
 *
 * Run:
 *   npx tsx tests/live-stream-messages.spec.ts
 */

import { mergeLiveStreamMessages } from "../src/renderer/src/lib/live-stream-messages.ts"

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

const tests: Array<[string, () => void]> = [
  ["testLaterSnapshotDoesNotDropEarlierToolMessage", testLaterSnapshotDoesNotDropEarlierToolMessage],
  [
    "testSameMessageKeepsPreviousUsefulFieldsWhenSnapshotIsSparse",
    testSameMessageKeepsPreviousUsefulFieldsWhenSnapshotIsSparse
  ]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
