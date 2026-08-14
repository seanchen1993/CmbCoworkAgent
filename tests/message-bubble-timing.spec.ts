import type { Message } from "../src/renderer/src/types"
import { buildMessageBubbleTimingMeta } from "../src/renderer/src/lib/message-bubble-timing"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function message(id: string, role: Message["role"], start: string, end = start): Message {
  return {
    id,
    role,
    content: id,
    start_at: new Date(start),
    end_at: new Date(end)
  }
}

function testTimingMetadataUsesOneCompleteTurnAtATime(): void {
  const metadata = buildMessageBubbleTimingMeta([
    message("user-1", "user", "2026-08-14T10:00:00.000Z"),
    message("assistant-1", "assistant", "2026-08-14T10:00:01.000Z", "2026-08-14T10:00:02.000Z"),
    message("tool-1", "tool", "2026-08-14T10:00:03.000Z", "2026-08-14T10:00:05.000Z"),
    message("user-2", "user", "2026-08-14T10:01:00.000Z"),
    message("assistant-2", "assistant", "2026-08-14T10:01:02.000Z", "2026-08-14T10:01:04.000Z")
  ])

  assertEqual(
    metadata.assistantDurationMsById.get("assistant-1"),
    5_000,
    "first assistant duration should include the full turn through the tool result"
  )
  assertEqual(
    metadata.assistantDurationMsById.get("assistant-2"),
    4_000,
    "last turn duration should use the final streamed message"
  )
  assertEqual(
    metadata.userSendTimeLabelById.has("user-1"),
    true,
    "user messages with timestamps should retain a display label"
  )
}

function testTimingMetadataSkipsTurnsWithoutUsableTimes(): void {
  const metadata = buildMessageBubbleTimingMeta([
    {
      id: "invalid-user",
      role: "user",
      content: "invalid",
      created_at: "not-a-date"
    },
    message("assistant-after-invalid", "assistant", "2026-08-14T10:00:01.000Z"),
    message("valid-user", "user", "2026-08-14T10:01:00.000Z"),
    message("assistant-after-valid", "assistant", "2026-08-14T10:01:01.000Z")
  ])

  assertEqual(
    metadata.assistantDurationMsById.has("assistant-after-invalid"),
    false,
    "a user turn without a timestamp should not produce a duration"
  )
  assertEqual(
    metadata.assistantDurationMsById.get("assistant-after-valid"),
    1_000,
    "the next valid turn should remain independent"
  )
}

function main(): void {
  const tests = [
    testTimingMetadataUsesOneCompleteTurnAtATime,
    testTimingMetadataSkipsTurnsWithoutUsableTimes
  ]
  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
  console.log(`\n${tests.length} passed`)
}

main()
