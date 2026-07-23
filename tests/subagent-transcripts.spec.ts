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
import { buildMessageSameRoleDuplicateId } from "../src/shared/message-role-collision"

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

async function testCrossRoleProviderIdCollisionDoesNotOverwrite(): Promise<void> {
  let transcripts: Record<string, Message[]> = {}
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    assistantMessage({
      id: "shared-provider-id",
      content: "Calling tool",
      toolCalls: [{ id: "call-1", name: "read_file", args: {} }]
    })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
    toolMessage({
      id: "shared-provider-id",
      toolCallId: "call-1",
      content: "result"
    })
  ])

  const messages = transcripts["sub-1"] ?? []
  assert(messages.length === 2, "cross-role subagent messages should both remain")
  assert(
    new Set(messages.map((message) => message.id)).size === 2,
    "cross-role subagent messages should receive unique internal ids"
  )
  assert(
    messages.map((message) => message.role).join(",") === "assistant,tool",
    "cross-role subagent messages should keep their roles"
  )
}

async function testExactToolReplayAfterAssistantIsIdempotent(): Promise<void> {
  let transcripts = mergeSubagentTranscripts({}, "sub-tool-replay", [
    assistantMessage({
      id: "tool-replay-call",
      content: "Calling tool",
      toolCalls: [{ id: "tool-replay-call-id", name: "read_file", args: {} }]
    }),
    toolMessage({
      id: "tool-replay-result",
      toolCallId: "tool-replay-call-id",
      content: "result"
    }),
    assistantMessage({ id: "tool-replay-final", content: "Done" })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-tool-replay", [
    toolMessage({
      id: "tool-replay-result",
      toolCallId: "tool-replay-call-id",
      content: "result"
    })
  ])

  const messages = transcripts["sub-tool-replay"] ?? []
  assert(messages.length === 3, "an exact tool replay after a final assistant must not duplicate")
  assert(
    messages.filter((message) => message.tool_call_id === "tool-replay-call-id").length === 1,
    "an exact replay must retain only one tool result for its call"
  )
}

async function testReusedToolIdentityAfterNewCallAppends(): Promise<void> {
  let transcripts = mergeSubagentTranscripts({}, "sub-tool-reuse", [
    assistantMessage({
      id: "tool-reuse-call-one",
      content: "Calling first path",
      toolCalls: [
        { id: "tool-reuse-call-id", name: "read_file", args: { path: "one" } }
      ]
    }),
    toolMessage({
      id: "tool-reuse-result",
      toolCallId: "tool-reuse-call-id",
      content: "first result"
    }),
    assistantMessage({
      id: "tool-reuse-call-two",
      content: "Calling second path",
      toolCalls: [
        { id: "tool-reuse-call-id", name: "read_file", args: { path: "two" } }
      ]
    })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-tool-reuse", [
    toolMessage({
      id: "tool-reuse-result",
      toolCallId: "tool-reuse-call-id",
      content: "second result"
    })
  ])

  const messages = transcripts["sub-tool-reuse"] ?? []
  assert(messages.length === 4, "a reused tool identity after a new call must append")
  assert(
    messages[1]?.content === "first result" && messages[3]?.content === "second result",
    "a new repeated call must preserve both tool result occurrences"
  )
  assert(
    messages[3]?.id ===
      buildMessageSameRoleDuplicateId("tool-reuse-result", "tool", 2),
    "a reused tool message id after a new call must receive occurrence two"
  )
}

async function testCompleteSnapshotPreservesSameRoleProviderIdOccurrences(): Promise<void> {
  const sharedId = "same-role-subagent-provider-id"
  const transcripts = mergeSubagentTranscripts(
    {},
    "sub-1",
    [
      assistantMessage({ id: sharedId, content: "first independent answer" }),
      assistantMessage({ id: sharedId, content: "second independent answer" })
    ],
    { completeSnapshot: true }
  )
  const messages = transcripts["sub-1"] ?? []

  assert(messages.length === 2, "a complete subagent snapshot must keep same-role occurrences")
  assert(
    messages[1]?.id === buildMessageSameRoleDuplicateId(sharedId, "assistant"),
    "the second subagent occurrence must receive a stable render id"
  )
  assert(
    messages.map((message) => message.content).join("|") ===
      "first independent answer|second independent answer",
    "same-role subagent occurrences must not overwrite each other"
  )
}

async function testCompleteSnapshotRebasesExplicitProviderAlias(): Promise<void> {
  const previous = [
    {
      ...assistantMessage({ id: "subagent-live-alias", content: "draft" }),
      provider_source_id: "subagent-provider-source",
      provider_occurrence: 1
    }
  ]
  const transcripts = mergeSubagentTranscripts(
    { "sub-alias": previous },
    "sub-alias",
    [
      {
        ...assistantMessage({ id: "subagent-snapshot-alias", content: "final" }),
        provider_source_id: "subagent-provider-source",
        provider_occurrence: 1
      }
    ],
    { completeSnapshot: true }
  )
  const messages = transcripts["sub-alias"] ?? []
  assert(
    messages.length === 1 &&
      messages[0]?.id === "subagent-live-alias" &&
      messages[0]?.content === "final",
    "a complete snapshot alias must update the unique matching provider occurrence"
  )
}

async function testCompleteSnapshotRestoresMissingMessageOrder(): Promise<void> {
  const user: Message = {
    id: "subagent-order-user",
    role: "user",
    content: "question",
    created_at: new Date("2026-06-16T10:00:00.000Z")
  }
  const call = assistantMessage({
    id: "subagent-order-call",
    content: "calling",
    toolCalls: [{ id: "subagent-order-tool-call", name: "read_file", args: {} }]
  })
  const final = assistantMessage({ id: "subagent-order-final", content: "done" })
  const tool = toolMessage({
    id: "subagent-order-tool",
    toolCallId: "subagent-order-tool-call",
    content: "result"
  })
  const transcripts = mergeSubagentTranscripts(
    { "sub-order": [user, call, final] },
    "sub-order",
    [user, call, tool, final],
    { completeSnapshot: true }
  )
  assert(
    transcripts["sub-order"]?.map((message) => message.id).join("|") ===
      "subagent-order-user|subagent-order-call|subagent-order-tool|subagent-order-final",
    "a covering complete snapshot must restore a missing message at its authoritative position"
  )
}

async function testSparseCompleteSnapshotPrefersExactImplicitAlias(): Promise<void> {
  const previous = [
    {
      ...assistantMessage({ id: "subagent-sparse-alias-one", content: "one" }),
      provider_source_id: "subagent-sparse-provider",
      provider_occurrence: 1
    },
    {
      ...assistantMessage({ id: "subagent-sparse-alias-two", content: "two" }),
      provider_source_id: "subagent-sparse-provider",
      provider_occurrence: 2
    }
  ]
  const transcripts = mergeSubagentTranscripts(
    { "sub-sparse-alias": previous },
    "sub-sparse-alias",
    [
      {
        ...assistantMessage({
          id: "subagent-sparse-alias-two",
          content: "two updated"
        }),
        provider_source_id: "subagent-sparse-provider"
      }
    ],
    { completeSnapshot: true }
  )
  const messages = transcripts["sub-sparse-alias"] ?? []
  assert(
    messages.length === 2 &&
      messages[0]?.content === "one" &&
      messages[1]?.content === "two updated",
    "an implicit sparse snapshot alias must update its exact provider occurrence"
  )
}

async function testSparseCompleteSnapshotRestoresExplicitOccurrenceOrder(): Promise<void> {
  const userOne: Message = {
    id: "subagent-gap-user-one",
    role: "user",
    content: "question one",
    created_at: new Date("2026-06-16T10:00:00.000Z")
  }
  const userTwo: Message = {
    id: "subagent-gap-user-two",
    role: "user",
    content: "question two",
    created_at: new Date("2026-06-16T10:00:02.000Z")
  }
  const occurrenceTwo = {
    ...assistantMessage({ id: "subagent-gap-two", content: "two" }),
    provider_source_id: "subagent-gap-provider",
    provider_occurrence: 2
  }
  const occurrenceOne = {
    ...assistantMessage({ id: "subagent-gap-one", content: "one" }),
    provider_source_id: "subagent-gap-provider",
    provider_occurrence: 1
  }
  const current = assistantMessage({ id: "subagent-gap-current", content: "current" })
  const transcripts = mergeSubagentTranscripts(
    { "sub-gap": [userOne, occurrenceTwo, userTwo, current] },
    "sub-gap",
    [occurrenceOne],
    { completeSnapshot: true }
  )
  assert(
    transcripts["sub-gap"]?.map((message) => message.content).join("|") ===
      "question one|one|two|question two|current",
    "a sparse complete snapshot must restore global explicit provider occurrence order"
  )
}

async function testCompleteSnapshotKeepsNewUserTurnSegmentIntact(): Promise<void> {
  const providerId = "subagent-turn-owned-provider"
  const userOne: Message = {
    id: "subagent-turn-user-one",
    role: "user",
    content: "question one",
    created_at: new Date("2026-06-16T10:10:00.000Z")
  }
  const answerTwo = {
    ...assistantMessage({ id: "subagent-turn-answer-two", content: "answer two" }),
    provider_source_id: providerId,
    provider_occurrence: 2
  }
  const userTwo: Message = {
    id: "subagent-turn-user-two",
    role: "user",
    content: "question two",
    created_at: new Date("2026-06-16T10:10:02.000Z")
  }
  const answerOne = {
    ...assistantMessage({ id: "subagent-turn-answer-one", content: "answer one" }),
    provider_source_id: providerId,
    provider_occurrence: 1
  }
  const transcripts = mergeSubagentTranscripts(
    { "sub-turn-owned": [userOne, answerTwo] },
    "sub-turn-owned",
    [userTwo, answerOne],
    { completeSnapshot: true }
  )
  assert(
    transcripts["sub-turn-owned"]?.map((message) => message.content).join("|") ===
      "question one|answer two|question two|answer one",
    "a complete snapshot must not detach an answer from its new user turn"
  )
}

async function testSparseSnapshotKeepsMatchedBarrierBeforeNewOccurrence(): Promise<void> {
  const providerId = "subagent-barrier-provider"
  const answerTwo = {
    ...assistantMessage({ id: "subagent-barrier-answer-two", content: "answer two" }),
    provider_source_id: providerId,
    provider_occurrence: 2
  }
  const system: Message = {
    id: "subagent-barrier-system",
    role: "system",
    content: "system barrier",
    created_at: new Date("2026-06-16T10:20:01.000Z")
  }
  const answerOne = {
    ...assistantMessage({ id: "subagent-barrier-answer-one", content: "answer one" }),
    provider_source_id: providerId,
    provider_occurrence: 1
  }
  const transcripts = mergeSubagentTranscripts(
    { "sub-barrier": [answerTwo, system] },
    "sub-barrier",
    [system, answerOne],
    { completeSnapshot: true }
  )
  assert(
    transcripts["sub-barrier"]?.map((message) => message.content).join("|") ===
      "answer two|system barrier|answer one",
    "a matched system anchor must keep a following new occurrence on its right"
  )
}

async function testSparseLeftAnchorDoesNotCrossOmittedTurnTail(): Promise<void> {
  const providerId = "subagent-left-anchor-provider"
  const userOne: Message = {
    id: "subagent-left-anchor-user-one",
    role: "user",
    content: "question one",
    created_at: new Date("2026-06-16T10:30:00.000Z")
  }
  const answerOne = {
    ...assistantMessage({ id: "subagent-left-anchor-answer-one", content: "answer one" }),
    provider_source_id: providerId,
    provider_occurrence: 1
  }
  const userTwo: Message = {
    id: "subagent-left-anchor-user-two",
    role: "user",
    content: "question two",
    created_at: new Date("2026-06-16T10:30:02.000Z")
  }
  const answerTwo = {
    ...assistantMessage({ id: "subagent-left-anchor-answer-two", content: "answer two" }),
    provider_source_id: providerId,
    provider_occurrence: 2
  }
  const userThree: Message = {
    id: "subagent-left-anchor-user-three",
    role: "user",
    content: "question three",
    created_at: new Date("2026-06-16T10:30:04.000Z")
  }
  const transcripts = mergeSubagentTranscripts(
    { "sub-left-anchor": [userOne, answerOne, userTwo, answerTwo] },
    "sub-left-anchor",
    [
      {
        ...answerOne,
        id: "subagent-left-anchor-answer-one-alias",
        content: "answer one expanded"
      },
      userThree
    ],
    { completeSnapshot: true }
  )
  assert(
    transcripts["sub-left-anchor"]?.map((message) => message.content).join("|") ===
      "question one|answer one expanded|question two|answer two|question three",
    "a sparse left anchor must not move a new user across an omitted baseline tail"
  )
}

async function testDuplicateExplicitTupleSnapshotIsIdempotent(): Promise<void> {
  const snapshot = [
    {
      ...assistantMessage({ id: "subagent-tuple-alias-a", content: "d" }),
      provider_source_id: "subagent-tuple-source",
      provider_occurrence: 1
    },
    {
      ...assistantMessage({ id: "subagent-tuple-alias-b", content: "done" }),
      provider_source_id: "subagent-tuple-source",
      provider_occurrence: 1
    }
  ]
  let transcripts: Record<string, Message[]> = {}
  for (let replay = 0; replay < 3; replay += 1) {
    transcripts = mergeSubagentTranscripts(
      transcripts,
      "subagent-tuple",
      snapshot,
      { completeSnapshot: true }
    )
  }
  const messages = transcripts["subagent-tuple"] ?? []
  assert(
    messages.length === 1 && messages[0]?.content === "done",
    "replaying aliases for one explicit provider tuple must remain one subagent row"
  )
}

async function testLegacyCrossRoleBaselineIsNormalizedBeforeUpdate(): Promise<void> {
  const sharedId = "legacy-shared-provider-id"
  const transcripts = mergeSubagentTranscripts(
    {
      "sub-1": [
        assistantMessage({ id: sharedId, content: "old assistant" }),
        toolMessage({ id: sharedId, toolCallId: "call-legacy", content: "tool result" })
      ]
    },
    "sub-1",
    [assistantMessage({ id: sharedId, content: "updated assistant" })]
  )
  const messages = transcripts["sub-1"] ?? []

  assert(messages.length === 2, "legacy cross-role rows must remain distinct after an update")
  assert(
    messages.find((message) => message.role === "assistant")?.content === "updated assistant",
    "the assistant update must not overwrite the legacy tool row"
  )
  assert(
    messages.find((message) => message.role === "tool")?.content === "tool result",
    "normalizing the legacy baseline must preserve the tool result"
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
    {
      ...assistantMessage({
        id: "assistant-live-alias",
        content: "Need tools",
        toolCalls: [{ id: "tool-call-1", name: "read_file", args: { path: "a.ts" } }]
      }),
      provider_source_id: "assistant-provider-source",
      provider_occurrence: 1
    },
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
  assert(
    restored["sub-1"]?.[0]?.provider_source_id === "assistant-provider-source" &&
      restored["sub-1"]?.[0]?.provider_occurrence === 1,
    "persisted provider tuple identity should restore"
  )

  const rebased = mergeSubagentTranscripts(
    restored,
    "sub-1",
    [
      {
        ...assistantMessage({ id: "assistant-snapshot-alias", content: "Final answer" }),
        provider_source_id: "assistant-provider-source",
        provider_occurrence: 1
      }
    ],
    { completeSnapshot: true }
  )
  const assistantMessages = (rebased["sub-1"] ?? []).filter(
    (message) => message.role === "assistant"
  )
  assert(
    assistantMessages.length === 1 &&
      assistantMessages[0]?.id === "assistant-live-alias" &&
      assistantMessages[0]?.content === "Final answer",
    "restored provider tuple should rebase a complete snapshot alias without duplicating it"
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
  await testExactToolReplayAfterAssistantIsIdempotent()
  console.log("PASS subagent exact tool replay after assistant")
  await testReusedToolIdentityAfterNewCallAppends()
  console.log("PASS subagent reused tool identity after new call")
  await testCrossRoleProviderIdCollisionDoesNotOverwrite()
  console.log("PASS subagent transcript cross-role provider id collision")
  await testCompleteSnapshotPreservesSameRoleProviderIdOccurrences()
  console.log("PASS subagent transcript same-role snapshot occurrences")
  await testCompleteSnapshotRebasesExplicitProviderAlias()
  console.log("PASS subagent complete snapshot rebases provider aliases")
  await testCompleteSnapshotRestoresMissingMessageOrder()
  console.log("PASS subagent complete snapshot restores message order")
  await testSparseCompleteSnapshotPrefersExactImplicitAlias()
  console.log("PASS subagent sparse snapshot prefers exact implicit alias")
  await testSparseCompleteSnapshotRestoresExplicitOccurrenceOrder()
  console.log("PASS subagent sparse snapshot restores explicit occurrence order")
  await testCompleteSnapshotKeepsNewUserTurnSegmentIntact()
  console.log("PASS subagent complete snapshot keeps new user turn intact")
  await testSparseSnapshotKeepsMatchedBarrierBeforeNewOccurrence()
  console.log("PASS subagent sparse snapshot keeps matched barrier")
  await testSparseLeftAnchorDoesNotCrossOmittedTurnTail()
  console.log("PASS subagent sparse left anchor keeps omitted turn tail")
  await testDuplicateExplicitTupleSnapshotIsIdempotent()
  console.log("PASS subagent duplicate explicit tuple snapshot is idempotent")
  await testLegacyCrossRoleBaselineIsNormalizedBeforeUpdate()
  console.log("PASS subagent transcript normalizes legacy cross-role baseline")
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
