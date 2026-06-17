/**
 * Behavior tests for subagent transcript merging and persistence helpers.
 *
 * Run:
 *   npx -y tsx tests/subagent-transcripts.spec.ts
 */

import {
  getSubagentTranscriptsFromThreadValues,
  getSubagentTranscriptDisplayStats,
  mergeSubagentTranscripts,
  reconcileTranscriptToolCallsWithResults,
  serializeSubagentTranscripts
} from "../src/renderer/src/lib/subagent-transcripts"
import type { Message } from "../src/renderer/src/types"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assistantMessage(input: {
  id: string
  content?: string
  toolCalls?: Message["tool_calls"]
}): Message {
  return {
    id: input.id,
    role: "assistant",
    content: input.content ?? "",
    ...(input.toolCalls ? { tool_calls: input.toolCalls } : {}),
    created_at: new Date("2026-06-16T10:00:00.000Z")
  }
}

function toolMessage(input: {
  id: string
  toolCallId: string
  content: string
  name?: string
}): Message {
  return {
    id: input.id,
    role: "tool",
    content: input.content,
    tool_call_id: input.toolCallId,
    name: input.name ?? "read_file",
    created_at: new Date("2026-06-16T10:00:01.000Z")
  }
}

async function testConsecutiveTranscriptEventsDoNotOverwrite(): Promise<void> {
  let transcripts: Record<string, Message[]> = {}
  transcripts = mergeSubagentTranscripts("sub-1" in transcripts ? transcripts : {}, "sub-1", [
    assistantMessage({ id: "assistant-1", content: "Thinking" })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    toolMessage({ id: "tool-1", toolCallId: "tool-call-1", content: "result" })
  ])

  assert(transcripts["sub-1"]?.length === 2, "consecutive transcript events should both remain")
  assert(
    transcripts["sub-1"]?.some((message) => message.id === "assistant-1") &&
      transcripts["sub-1"]?.some((message) => message.id === "tool-1"),
    "consecutive transcript merge should preserve assistant and tool messages"
  )
}

async function testAssistantToolCallsMergeById(): Promise<void> {
  let transcripts: Record<string, Message[]> = {}
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    assistantMessage({
      id: "assistant-1",
      content: "Need tools",
      toolCalls: [{ id: "tool-call-1", name: "read_file", args: { path: "a.ts" } }]
    })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    assistantMessage({
      id: "assistant-1",
      content: "Need tools",
      toolCalls: [{ id: "tool-call-2", name: "grep", args: { pattern: "foo" } }]
    })
  ])

  const assistant = transcripts["sub-1"]?.find((message) => message.id === "assistant-1")
  const toolCallIds = assistant?.tool_calls?.map((toolCall) => toolCall.id).sort()
  assert(
    toolCallIds?.join(",") === "tool-call-1,tool-call-2",
    "assistant transcript merge should preserve multiple streamed tool calls"
  )
}

async function testAssistantToolCallsBackfillEmptyArgs(): Promise<void> {
  let transcripts: Record<string, Message[]> = {}
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    assistantMessage({
      id: "assistant-1",
      content: "Need tool",
      toolCalls: [{ id: "tool-call-1", name: "read_file", args: {} }]
    })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    assistantMessage({
      id: "assistant-1",
      content: "Need tool",
      toolCalls: [{ id: "tool-call-1", name: "read_file", args: { file_path: "README.md" } }]
    })
  ])

  const args = transcripts["sub-1"]?.[0]?.tool_calls?.[0]?.args
  assert(
    args?.file_path === "README.md",
    "assistant transcript merge should backfill streamed args over an early empty object"
  )
}

async function testDisplayStatsCountVisibleTranscriptEntries(): Promise<void> {
  const messages = [
    assistantMessage({
      id: "assistant-1",
      content: "Need a file",
      toolCalls: [{ id: "tool-call-1", name: "read_file", args: { path: "a.ts" } }]
    }),
    toolMessage({ id: "tool-1", toolCallId: "tool-call-1", content: "file body" }),
    assistantMessage({ id: "assistant-2", content: "Done" })
  ]

  const stats = getSubagentTranscriptDisplayStats(messages)
  assert(stats.visibleMessageCount === 2, "display stats should count visible message bubbles")
  assert(stats.toolResultCount === 1, "display stats should count folded tool results separately")
  assert(stats.toolCallCount === 1, "display stats should count tool calls inside visible bubbles")
}

async function testPersistedTranscriptsRestore(): Promise<void> {
  const transcripts = mergeSubagentTranscripts({}, "sub-1", [
    assistantMessage({
      id: "assistant-1",
      content: "Need tools",
      toolCalls: [{ id: "tool-call-1", name: "read_file", args: { path: "a.ts" } }]
    }),
    toolMessage({ id: "tool-1", toolCallId: "tool-call-1", content: "file body" })
  ])
  const serialized = serializeSubagentTranscripts(transcripts)
  const restored = getSubagentTranscriptsFromThreadValues({ subagentTranscripts: serialized })

  assert(restored["sub-1"]?.length === 2, "persisted transcript messages should restore")
  assert(
    restored["sub-1"]?.[0]?.created_at instanceof Date,
    "persisted transcript dates should revive as Date objects"
  )
  assert(
    restored["sub-1"]?.[0]?.tool_calls?.[0]?.id === "tool-call-1",
    "persisted assistant tool calls should restore"
  )
}

async function testToolCallIdsReconcileWithFollowingResults(): Promise<void> {
  const messages = [
    assistantMessage({
      id: "assistant-1",
      content: "Need a file",
      toolCalls: [{ id: "stream-placeholder-0", name: "read_file", args: { path: "a.ts" } }]
    }),
    toolMessage({
      id: "tool-1",
      toolCallId: "real-tool-call-1",
      name: "read_file",
      content: "file body"
    })
  ]

  const reconciled = reconcileTranscriptToolCallsWithResults(messages)
  assert(
    reconciled[0]?.tool_calls?.[0]?.id === "real-tool-call-1",
    "transcript display should align streamed placeholder tool-call ids to the actual tool result id"
  )
}

async function testToolCallReconcileKeepsMultipleToolResultsDistinct(): Promise<void> {
  const messages = [
    assistantMessage({
      id: "assistant-1",
      content: "Need two tools",
      toolCalls: [
        { id: "placeholder-read", name: "read_file", args: { path: "a.ts" } },
        { id: "placeholder-grep", name: "grep", args: { pattern: "foo" } }
      ]
    }),
    toolMessage({
      id: "tool-1",
      toolCallId: "real-read",
      name: "read_file",
      content: "file body"
    }),
    toolMessage({
      id: "tool-2",
      toolCallId: "real-grep",
      name: "grep",
      content: "matches"
    })
  ]

  const reconciled = reconcileTranscriptToolCallsWithResults(messages)
  const toolCallIds = reconciled[0]?.tool_calls?.map((toolCall) => toolCall.id).join(",")
  assert(
    toolCallIds === "real-read,real-grep",
    `transcript display should align multiple tool results distinctly, got ${toolCallIds}`
  )
}

async function testOversizedContentIsClampedHeadAndTail(): Promise<void> {
  const huge = "A".repeat(50_000) + "ZZZEND"
  const transcripts = mergeSubagentTranscripts({}, "sub-1", [
    toolMessage({ id: "tool-1", toolCallId: "tc-1", content: huge })
  ])
  const stored = transcripts["sub-1"]?.[0]?.content
  assert(typeof stored === "string", "clamped content should remain a string")
  const text = stored as string
  assert(text.length < huge.length, "oversized content should be clamped")
  assert(text.startsWith("AAAA"), "clamped content should keep the head")
  assert(text.includes("省略") && text.endsWith("ZZZEND"), "clamped content should keep a tail marker")
}

async function testPerSubagentByteBudgetDropsOldest(): Promise<void> {
  // Each ~24KB after clamp; many of them should exceed the 512KB budget and
  // evict the oldest while keeping the most recent.
  const big = "B".repeat(24_000)
  let transcripts: Record<string, Message[]> = {}
  for (let i = 0; i < 60; i += 1) {
    transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
      toolMessage({ id: `tool-${i}`, toolCallId: `tc-${i}`, content: big })
    ])
  }
  const messages = transcripts["sub-1"] ?? []
  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0
  )
  assert(totalChars <= 512_000, "per-subagent content should stay within the byte budget")
  assert(messages.length < 60, "oldest messages should be dropped once over budget")
  assert(
    messages[messages.length - 1]?.id === "tool-59",
    "the most recent message must always be kept"
  )
}

async function run(): Promise<void> {
  await testConsecutiveTranscriptEventsDoNotOverwrite()
  console.log("PASS subagent transcript consecutive events")
  await testOversizedContentIsClampedHeadAndTail()
  console.log("PASS subagent transcript oversized content clamp")
  await testPerSubagentByteBudgetDropsOldest()
  console.log("PASS subagent transcript per-subagent byte budget")
  await testAssistantToolCallsMergeById()
  console.log("PASS subagent transcript assistant tool-call merge")
  await testAssistantToolCallsBackfillEmptyArgs()
  console.log("PASS subagent transcript assistant tool-call arg backfill")
  await testDisplayStatsCountVisibleTranscriptEntries()
  console.log("PASS subagent transcript display stats")
  await testPersistedTranscriptsRestore()
  console.log("PASS subagent transcript persistence restore")
  await testToolCallIdsReconcileWithFollowingResults()
  console.log("PASS subagent transcript tool-call/result id reconcile")
  await testToolCallReconcileKeepsMultipleToolResultsDistinct()
  console.log("PASS subagent transcript multi-tool reconcile")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
