/**
 * Unit tests for stable stream message IDs.
 *
 * Run:
 *   npx tsx tests/stream-message-ids.spec.ts
 */

import { buildStableValuesMessageId } from "../src/renderer/src/lib/stream-message-ids.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertNotEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    throw new Error(`${message}: both were ${String(actual)}`)
  }
}

function testExplicitIdWins(): void {
  const id = buildStableValuesMessageId({
    explicitId: "provider-id",
    index: 0,
    type: "ai",
    content: "hello"
  })

  assertEqual(id, "provider-id", "provider ids should remain authoritative")
}

function testFallbackIdIsStableForSameValuesMessage(): void {
  const first = buildStableValuesMessageId({
    index: 1,
    type: "tool",
    className: "ToolMessage",
    content: "large tool output",
    toolCallId: "call-1",
    name: "read_file"
  })
  const second = buildStableValuesMessageId({
    index: 1,
    type: "tool",
    className: "ToolMessage",
    content: "large tool output",
    toolCallId: "call-1",
    name: "read_file"
  })

  assertEqual(first, second, "fallback ids should be stable across values snapshots")
}

function testFallbackIdIgnoresGrowingContent(): void {
  const first = buildStableValuesMessageId({
    index: 1,
    type: "tool",
    className: "ToolMessage",
    content: "first output",
    toolCallId: "call-1",
    name: "read_file"
  })
  const second = buildStableValuesMessageId({
    index: 1,
    type: "tool",
    className: "ToolMessage",
    content: "second output",
    toolCallId: "call-1",
    name: "read_file"
  })

  assertEqual(first, second, "fallback ids should update the same id-less values message")
}

function testFallbackIdChangesWhenStructuralIdentityChanges(): void {
  const first = buildStableValuesMessageId({
    index: 1,
    type: "tool",
    className: "ToolMessage",
    content: "same output",
    toolCallId: "call-1",
    name: "read_file"
  })
  const second = buildStableValuesMessageId({
    index: 2,
    type: "tool",
    className: "ToolMessage",
    content: "same output",
    toolCallId: "call-2",
    name: "read_file"
  })

  assertNotEqual(first, second, "fallback ids should separate structurally different messages")
}

const tests: Array<[string, () => void]> = [
  ["testExplicitIdWins", testExplicitIdWins],
  ["testFallbackIdIsStableForSameValuesMessage", testFallbackIdIsStableForSameValuesMessage],
  ["testFallbackIdIgnoresGrowingContent", testFallbackIdIgnoresGrowingContent],
  [
    "testFallbackIdChangesWhenStructuralIdentityChanges",
    testFallbackIdChangesWhenStructuralIdentityChanges
  ]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
