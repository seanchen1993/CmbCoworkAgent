/**
 * Behavior tests for subagent transcript merging and persistence helpers.
 *
 * Run:
 *   npx -y tsx tests/subagent-transcripts.spec.ts
 */

import {
  applyPersistedSubagentTranscriptRefs,
  drainCoalescedSubagentTranscriptChanges,
  getSubagentTranscriptsFromThreadValues,
  getSubagentTranscriptDisplayStats,
  mergePaginatedSubagentTranscript,
  mergeSubagentTranscriptPages,
  mergeSubagentTranscripts,
  reconcileTranscriptToolCallsWithResults,
  restoreSubagentsFromTranscripts,
  selectMergedTranscriptRowsForPersistence,
  serializeSubagentTranscripts
} from "../src/renderer/src/lib/subagent-transcripts"
import type { Message } from "../src/renderer/src/types"
import { mergeSubagentSnapshotWithHistory } from "../src/renderer/src/lib/subagent-state"
import { buildMessageSameRoleDuplicateId } from "../src/shared/message-role-collision"
import { SUBAGENT_TRANSCRIPT_INLINE_BYTES } from "../src/shared/subagent-transcript-storage"

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
      reasoning: "Inspect the repository before choosing the tool",
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
    restored["sub-1"]?.[0]?.reasoning === "Inspect the repository before choosing the tool",
    "persisted assistant reasoning should restore"
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

async function testOversizedContentRemainsLosslessAcrossPersistence(): Promise<void> {
  const huge = "A".repeat(50_000) + "ZZZEND"
  const transcripts = mergeSubagentTranscripts({}, "sub-1", [
    toolMessage({ id: "tool-1", toolCallId: "tc-1", content: huge })
  ])
  const stored = transcripts["sub-1"]?.[0]?.content
  assert(stored === huge, "the complete transcript must retain oversized tool content")
  const restored = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: serializeSubagentTranscripts(transcripts)
  })
  assert(
    restored["sub-1"]?.[0]?.content === huge,
    "oversized transcript content must remain lossless after persistence"
  )
}

async function testPersistDrainCoalescesBurstWhileWriteIsInFlight(): Promise<void> {
  let pendingIds: Set<string> | undefined = new Set(["initial"])
  let releaseFirstWrite: (() => void) | undefined
  const firstWriteBlocked = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  const batches: string[][] = []
  const drain = drainCoalescedSubagentTranscriptChanges(
    () => {
      const batch = pendingIds
      pendingIds = undefined
      return batch
    },
    async (changedIds) => {
      batches.push(Array.from(changedIds).sort())
      if (batches.length === 1) await firstWriteBlocked
    }
  )

  for (let index = 0; index < 100; index += 1) {
    const dirty = pendingIds ?? new Set<string>()
    dirty.add(`burst-${index}`)
    pendingIds = dirty
  }
  releaseFirstWrite?.()
  await drain

  assert(batches.length === 2, "a burst during one deferred write should require at most two IPCs")
  assert(
    batches[1]?.length === 100 &&
      batches[1]?.includes("burst-0") &&
      batches[1]?.includes("burst-99"),
    "the coalesced follow-up write must retain every dirty transcript id"
  )
}

async function testHydratedTranscriptsRestoreClickableSubagentCards(): Promise<void> {
  const executionId = "raw-task::invocation-task-v1-restored"
  const prompt: Message = {
    id: `subagent-prompt-${executionId}`,
    role: "user",
    content: "inspect the complete history",
    content_priority: 1,
    subagent_tool_call_id: "raw-task",
    subagent_invocation_scope: "task-v1-restored",
    subagent_name: "Code Reviewer",
    subagent_description: "Review persistence",
    subagent_type: "code-reviewer",
    created_at: new Date("2026-06-16T10:00:00.000Z")
  }
  const final: Message = {
    id: `subagent-final-${executionId}`,
    role: "assistant",
    content: "review complete",
    content_priority: 1,
    status: "success",
    created_at: new Date("2026-06-16T10:01:00.000Z")
  }
  const revived = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: serializeSubagentTranscripts({ [executionId]: [prompt, final] })
  })
  const cards = restoreSubagentsFromTranscripts(revived)
  assert(cards.length === 1, "one hydrated transcript bucket should restore one card")
  assert(cards[0]?.id === executionId && cards[0]?.toolCallId === "raw-task")
  assert(cards[0]?.name === "Code Reviewer" && cards[0]?.description === "Review persistence")
  assert(cards[0]?.subagentType === "code-reviewer" && cards[0]?.status === "completed")

  const correctedFallback = restoreSubagentsFromTranscripts(revived, [
    {
      id: executionId,
      toolCallId: "raw-task",
      name: "Running fallback",
      description: "waiting for missed done",
      status: "cancelled"
    }
  ])
  assert(
    correctedFallback[0]?.status === "completed",
    "a hydrated stable final must correct a missed-done cancelled fallback"
  )

  const legacyCards = restoreSubagentsFromTranscripts({
    "legacy-task": [
      {
        id: "subagent-prompt-legacy-task",
        role: "user",
        content: "legacy prompt fallback",
        subagent_tool_call_id: "legacy-task",
        created_at: new Date("2026-06-16T11:00:00.000Z")
      }
    ]
  })
  assert(
    legacyCards[0]?.description === "legacy prompt fallback" &&
      legacyCards[0]?.status === "cancelled",
    "legacy prompt-only buckets should remain reachable with a conservative terminal status"
  )
  const liveLegacyCard = restoreSubagentsFromTranscripts(
    { "legacy-task": legacyCards.length ? [{
      id: "subagent-prompt-legacy-task",
      role: "user",
      content: "legacy prompt fallback",
      created_at: new Date("2026-06-16T11:00:00.000Z")
    }] : [] },
    [
      {
        id: "legacy-task",
        name: "Live Agent",
        description: "still running",
        status: "running"
      }
    ]
  )
  assert(
    liveLegacyCard[0]?.status === "running",
    "hydration without a final must not cancel a genuinely live existing card"
  )
}

async function testLiveSnapshotPreservesHydratedTerminalCards(): Promise<void> {
  const historical = {
    id: "historical-execution",
    toolCallId: "historical-task",
    name: "Historical Reviewer",
    description: "completed in an earlier stream",
    status: "completed" as const,
    completedAt: new Date("2026-06-16T09:00:00.000Z")
  }
  const staleRunning = {
    id: "stale-running-execution",
    name: "Stale Agent",
    description: "not present in the authoritative live snapshot",
    status: "running" as const
  }
  const live = {
    id: "new-live-execution",
    toolCallId: "new-task",
    name: "Live Agent",
    description: "current stream",
    status: "running" as const
  }
  const merged = mergeSubagentSnapshotWithHistory(
    [historical, staleRunning],
    [live],
    { parentStreamHasStopped: false }
  )

  assert(
    merged.map((subagent) => subagent.id).join("|") ===
      "historical-execution|new-live-execution",
    "a current-run snapshot must preserve hydrated terminal cards and append the new task"
  )
  assert(
    merged[0]?.status === "completed" && merged[1]?.status === "running",
    "historical terminal and current live statuses must remain distinct"
  )
}

async function testPromptOnlyPlaceholderRevivesOnlyWithCurrentLiveEvidence(): Promise<void> {
  const id = "prompt-only-revival"
  const restored = restoreSubagentsFromTranscripts({
    [id]: [
      {
        id: `subagent-prompt-${id}`,
        role: "user",
        content: "continue current work",
        subagent_tool_call_id: id,
        created_at: new Date("2026-06-16T12:00:00.000Z")
      }
    ]
  })
  assert(
    restored[0]?.status === "cancelled" && restored[0]?.restoredFromPromptOnly === true,
    "a prompt-only historical card must start as a distinguishable conservative placeholder"
  )

  const live = {
    id,
    name: "Live Agent",
    description: "current turn",
    status: "running" as const,
    observedLive: true
  }
  const beforeActive = mergeSubagentSnapshotWithHistory(restored, [live], {
    parentStreamHasStopped: false,
    parentStreamIsActive: false
  })
  assert(
    beforeActive[0]?.status === "cancelled" &&
      beforeActive[0]?.restoredFromPromptOnly === true,
    "observed values arriving before the parent active edge must retain the revival marker"
  )
  const afterActive = mergeSubagentSnapshotWithHistory(beforeActive, [live], {
    parentStreamHasStopped: false,
    parentStreamIsActive: true
  })
  assert(
    afterActive[0]?.status === "running" &&
      afterActive[0]?.restoredFromPromptOnly === undefined,
    "the same current-turn task must revive once the parent stream is confirmed active"
  )

  const realCancelled = [{ ...restored[0], restoredFromPromptOnly: undefined }]
  const protectedCancelled = mergeSubagentSnapshotWithHistory(realCancelled, [live], {
    parentStreamHasStopped: false,
    parentStreamIsActive: true
  })
  assert(
    protectedCancelled[0]?.status === "cancelled",
    "a real persisted cancellation must never be resurrected by a running replay"
  )
}

async function testPaginatedTranscriptMatchesOneShotCanonicalOrder(): Promise<void> {
  const prompt: Message = {
    id: "subagent-prompt-page-order",
    role: "user",
    content: "task prompt",
    subagent_tool_call_id: "page-order",
    created_at: new Date("2026-06-16T13:00:00.000Z")
  }
  const middle = Array.from({ length: 149 }, (_, index): Message => ({
    id: `page-middle-${index}`,
    role: "system",
    content: `row ${index}`,
    created_at: new Date(1_750_000_000_000 + index)
  }))
  const final: Message = {
    ...assistantMessage({ id: "subagent-final-page-order", content: "done" }),
    content_priority: 1,
    status: "success"
  }
  const full = [prompt, ...middle, final]
  const latestPage = full.slice(-100)
  const initial = mergePaginatedSubagentTranscript(latestPage, [prompt, final])
  assert(
    initial[0]?.id === prompt.id && initial[initial.length - 1]?.id === final.id,
    "the pinned startup prompt must remain before the latest persisted page"
  )
  const accumulated = mergeSubagentTranscriptPages(full.slice(0, 51), latestPage)
  const hydrated = mergePaginatedSubagentTranscript(accumulated, [prompt, final])
  assert(
    hydrated.map((message) => message.id).join("|") ===
      full.map((message) => message.id).join("|"),
    "loading earlier pages must reconstruct the exact original order"
  )

  const sharedId = "cross-page-provider-id"
  const collision = mergeSubagentTranscriptPages(
    [assistantMessage({ id: sharedId, content: "assistant" })],
    [toolMessage({ id: sharedId, toolCallId: "inner", content: "tool" })]
  )
  assert(
    collision.length === 2 && collision[0]?.role === "assistant" && collision[1]?.role === "tool",
    "cross-role provider ids split across pages must retain both rows"
  )

  const draft = assistantMessage({ id: "page-draft", content: "draft" })
  const system: Message = {
    id: "page-system",
    role: "system",
    content: "system",
    created_at: new Date("2026-06-16T13:01:00.000Z")
  }
  const tool = toolMessage({ id: "page-tool", toolCallId: "call", content: "result" })
  const replacement: Message = {
    ...assistantMessage({ id: "page-final", content: "draft completed" }),
    content_priority: 1,
    replaced_message_ids: [draft.id]
  }
  const oneShot = mergeSubagentTranscriptPages([], [draft, system, tool, replacement])
  const paged = mergeSubagentTranscriptPages([draft, system], [tool, replacement])
  assert(
    paged.map((message) => message.id).join("|") ===
      oneShot.map((message) => message.id).join("|"),
    "replacement aliases crossing a page boundary must preserve one-shot canonical order"
  )
}

async function testPendingPatchUsesPostMergeStartupRow(): Promise<void> {
  const id = "subagent-final-pending-startup"
  const startup: Message = {
    ...assistantMessage({ id, content: "bounded startup preview" }),
    content_priority: 1,
    content_is_projection: true,
    content_full_length: 10_000,
    content_ref: {
      v: 1,
      sha256: "d".repeat(64),
      bytes: 10_002,
      kind: "content"
    },
    status: "success",
    subagent_startup_projection: true
  }
  const correction: Message = {
    ...assistantMessage({ id, content: "" }),
    content_priority: 1,
    status: "error",
    is_error: true
  }
  const merged = mergeSubagentTranscripts({ task: [startup] }, "task", [correction]).task
  const pending = selectMergedTranscriptRowsForPersistence(merged, [correction])
  assert(
    pending.length === 1 &&
      pending[0]?.content === startup.content &&
      pending[0]?.content_ref?.sha256 === startup.content_ref?.sha256 &&
      pending[0]?.subagent_startup_projection === true &&
      pending[0]?.is_error === true,
    "a status-only delta must enqueue the post-merge startup row, not raw empty content"
  )
}

async function testAuthoritativeContentPrioritySurvivesPersistence(): Promise<void> {
  let transcripts = mergeSubagentTranscripts({}, "sub-priority", [
    assistantMessage({ id: "assistant-priority", content: "long speculative content" })
  ])
  transcripts = mergeSubagentTranscripts(transcripts, "sub-priority", [
    {
      ...assistantMessage({ id: "assistant-priority", content: "final" }),
      content_priority: 1
    }
  ])
  assert(
    transcripts["sub-priority"]?.[0]?.content === "final",
    "authoritative final content should replace a longer speculative stream"
  )

  const restored = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: serializeSubagentTranscripts(transcripts)
  })
  assert(
    restored["sub-priority"]?.[0]?.content_priority === 1,
    "authoritative transcript priority should survive persistence"
  )
  const afterStaleReplay = mergeSubagentTranscripts(restored, "sub-priority", [
    assistantMessage({ id: "assistant-priority", content: "long speculative content replayed" })
  ])
  assert(
    afterStaleReplay["sub-priority"]?.[0]?.content === "final",
    "a stale lower-priority replay must not overwrite the authoritative final content"
  )

  const afterAuthoritativeCorrection = mergeSubagentTranscripts(
    afterStaleReplay,
    "sub-priority",
    [
      {
        ...assistantMessage({ id: "assistant-priority", content: "fin" }),
        content_priority: 1
      }
    ]
  )
  assert(
    afterAuthoritativeCorrection["sub-priority"]?.[0]?.content === "fin",
    "a later equally authoritative replay should be able to shorten corrected content"
  )
}

async function testStableFinalReplacementCollapsesExistingRowsInPlace(): Promise<void> {
  const live = assistantMessage({ id: "live-terminal", content: "final answer" })
  const alreadyStable = assistantMessage({
    id: "subagent-final-task-rebase",
    content: "stale final answer"
  })
  const repair = {
    ...assistantMessage({
      id: "subagent-final-task-rebase",
      content: "short authoritative final"
    }),
    content_priority: 1,
    replaces_message_id: "live-terminal"
  } as Message & { replaces_message_id: string }
  const transcripts = mergeSubagentTranscripts(
    {
      "sub-rebase": [
        { id: "user-before", role: "user", content: "prompt", created_at: new Date() },
        live,
        { id: "system-between", role: "system", content: "marker", created_at: new Date() },
        alreadyStable
      ]
    },
    "sub-rebase",
    [repair]
  )
  const messages = transcripts["sub-rebase"] ?? []
  const finalMessages = messages.filter(
    (message) => message.id === "subagent-final-task-rebase"
  )
  assert(finalMessages.length === 1, "old and stable final ids should collapse into one row")
  assert(
    messages[1]?.id === "subagent-final-task-rebase" &&
      messages[1]?.content === "short authoritative final",
    "stable final replacement should keep the earlier transcript position and authoritative text"
  )
  assert(
    !("replaces_message_id" in (messages[1] as Message & { replaces_message_id?: string })),
    "replacement instructions should not be persisted in transcript messages"
  )

  const batched = mergeSubagentTranscripts({}, "sub-rebase-batch", [
    live,
    { id: "system-in-batch", role: "system", content: "marker", created_at: new Date() },
    repair
  ])["sub-rebase-batch"]
  assert(
    batched?.map((message) => message.id).join(",") ===
      "subagent-final-task-rebase,system-in-batch",
    "a batched replacement should retain the live assistant's original position"
  )
}

async function testStableFinalReplacementDoesNotConsumeToolCallAssistant(): Promise<void> {
  const toolCallAssistant = assistantMessage({
    id: "tool-call-assistant",
    content: "calling tool",
    toolCalls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
  })
  const repair = {
    ...assistantMessage({ id: "subagent-final-task-safe", content: "final answer" }),
    content_priority: 1,
    replaces_message_id: "tool-call-assistant"
  } as Message & { replaces_message_id: string }
  const transcripts = mergeSubagentTranscripts(
    { "sub-safe": [toolCallAssistant] },
    "sub-safe",
    [repair]
  )
  assert(
    transcripts["sub-safe"]?.length === 2 &&
      transcripts["sub-safe"]?.[0]?.id === "tool-call-assistant",
    "a replacement instruction must not consume an assistant that owns tool calls"
  )
}

async function testStableFinalReplacementSurvivesReloadAndLateLiveReplay(): Promise<void> {
  const liveId = "subagent-assistant-task-reset-1"
  const live = assistantMessage({ id: liveId, content: "speculative final suffix" })
  const repair = {
    ...assistantMessage({ id: "subagent-final-task-reset", content: "authoritative final" }),
    content_priority: 1,
    replaces_message_id_prefix: "subagent-assistant-task-reset-"
  } as Message & { replaces_message_id_prefix: string }
  const merged = mergeSubagentTranscripts(
    { "task-reset": [live] },
    "task-reset",
    [repair]
  )
  const restored = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: serializeSubagentTranscripts(merged)
  })
  const afterLateLive = mergeSubagentTranscripts(restored, "task-reset", [live])
  assert(
    afterLateLive["task-reset"]?.length === 1 &&
      afterLateLive["task-reset"]?.[0]?.id === "subagent-final-task-reset" &&
      afterLateLive["task-reset"]?.[0]?.content === "authoritative final",
    "persisted replacement aliases should absorb a late provisional replay after reload"
  )
}

async function testDuplicateStableRepairsCollapseAtLivePosition(): Promise<void> {
  const live = assistantMessage({
    id: "subagent-assistant-task-duplicate-1",
    content: "live draft"
  })
  const system: Message = {
    id: "system-between-repairs",
    role: "system",
    content: "marker",
    created_at: new Date()
  }
  const repair = (content: string): Message & { replaces_message_id: string } => ({
    ...assistantMessage({ id: "subagent-final-task-duplicate", content }),
    content_priority: 1,
    replaces_message_id: live.id
  })
  const messages = mergeSubagentTranscripts(
    {},
    "task-duplicate",
    [live, system, repair("first final"), repair("corrected")],
    { completeSnapshot: true }
  )["task-duplicate"]
  assert(
    messages?.map((message) => message.id).join("|") ===
      "subagent-final-task-duplicate|system-between-repairs" &&
      messages[0]?.content === "corrected",
    "duplicate repairs in one complete snapshot should collapse once at the live position"
  )
}

async function testPrefixReplacementOnlyConsumesLatestProvisionalAssistant(): Promise<void> {
  const first = assistantMessage({
    id: "subagent-assistant-task-prefix-1",
    content: "earlier plain assistant"
  })
  const terminal = assistantMessage({
    id: "subagent-assistant-task-prefix-2",
    content: "terminal draft"
  })
  const repair = {
    ...assistantMessage({ id: "subagent-final-task-prefix", content: "final answer" }),
    content_priority: 1,
    replaces_message_id_prefix: "subagent-assistant-task-prefix-"
  } as Message & { replaces_message_id_prefix: string }
  const merged = mergeSubagentTranscripts(
    { "task-prefix": [first, terminal] },
    "task-prefix",
    [repair]
  )
  assert(
    merged["task-prefix"]?.map((message) => message.id).join("|") ===
      "subagent-assistant-task-prefix-1|subagent-final-task-prefix",
    "a prefix recovery hint should replace only the latest eligible provisional assistant"
  )

  const restored = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: serializeSubagentTranscripts(merged)
  })
  const late = assistantMessage({
    id: "subagent-assistant-task-prefix-3",
    content: "late replay"
  })
  const afterLateReplay = mergeSubagentTranscripts(restored, "task-prefix", [late])
  assert(
    afterLateReplay["task-prefix"]?.length === 2 &&
      afterLateReplay["task-prefix"]?.[0]?.id === first.id &&
      afterLateReplay["task-prefix"]?.[1]?.content === "final answer",
    "a persisted prefix hint should absorb one late replay without deleting earlier turns"
  )
}

async function testCompatibleErrorPrefixOnlyCollapsesMatchingDiagnostic(): Promise<void> {
  const prefix = "subagent-assistant-task-error-prefix-"
  const matchingLive = assistantMessage({ id: `${prefix}1`, content: "same diagnostic" })
  const errorFinal = {
    ...assistantMessage({
      id: "subagent-final-task-error-prefix",
      content: "same diagnostic"
    }),
    content_priority: 1,
    is_error: true,
    replaces_message_id_prefix: prefix,
    replacement_mode: "compatible"
  } as Message & {
    replaces_message_id_prefix: string
    replacement_mode: string
  }
  const matching = mergeSubagentTranscripts(
    { "task-error-prefix": [matchingLive] },
    "task-error-prefix",
    [errorFinal]
  )
  assert(
    matching["task-error-prefix"]?.length === 1 &&
      matching["task-error-prefix"]?.[0]?.id === "subagent-final-task-error-prefix",
    "a compatible error repair should collapse an identical persisted diagnostic"
  )

  const differentLive = assistantMessage({ id: `${prefix}2`, content: "partial output" })
  const different = mergeSubagentTranscripts(
    { "task-error-prefix": [differentLive] },
    "task-error-prefix",
    [errorFinal]
  )
  assert(
    different["task-error-prefix"]?.length === 2,
    "a different partial assistant should remain beside the final error diagnostic"
  )

  const finalFirst = mergeSubagentTranscripts({}, "task-error-prefix", [errorFinal])
  const restoredFinalFirst = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: serializeSubagentTranscripts(finalFirst)
  })
  const afterMatchingLateReplay = mergeSubagentTranscripts(
    restoredFinalFirst,
    "task-error-prefix",
    [matchingLive]
  )
  assert(
    afterMatchingLateReplay["task-error-prefix"]?.length === 1 &&
      afterMatchingLateReplay["task-error-prefix"]?.[0]?.id ===
        "subagent-final-task-error-prefix",
    "a persisted compatible error prefix should absorb a matching late live replay"
  )
  const afterDifferentLateReplay = mergeSubagentTranscripts(
    restoredFinalFirst,
    "task-error-prefix",
    [differentLive]
  )
  assert(
    afterDifferentLateReplay["task-error-prefix"]?.length === 2,
    "a persisted compatible error prefix must not absorb a different late live replay"
  )
}

async function testLargeTranscriptDoesNotDropOldestMessages(): Promise<void> {
  const big = "B".repeat(24_000)
  let transcripts: Record<string, Message[]> = {}
  for (let i = 0; i < 60; i += 1) {
    transcripts = mergeSubagentTranscripts(transcripts, "sub-1", [
      toolMessage({ id: `tool-${i}`, toolCallId: `tc-${i}`, content: big })
    ])
  }
  const messages = transcripts["sub-1"] ?? []
  assert(
    messages.length === 60 &&
      messages[0]?.id === "tool-0" &&
      messages[messages.length - 1]?.id === "tool-59",
    "a complete transcript must retain both its oldest and newest messages"
  )
}

async function testExplicitFalseCannotClearStickyError(): Promise<void> {
  const failed = {
    ...assistantMessage({ id: "subagent-final-sticky-error", content: "actual failure" }),
    content_priority: 1,
    status: "error",
    is_error: true
  }
  const explicitFalse = {
    ...assistantMessage({ id: failed.id, content: "stale success" }),
    content_priority: 1,
    status: "success",
    is_error: false
  }
  const merged = mergeSubagentTranscripts({}, "sticky-error", [failed, explicitFalse])[
    "sticky-error"
  ]?.[0]
  assert(
    merged?.content === "actual failure" &&
      merged.status === "error" &&
      merged.is_error === true,
    "an explicit false replay must not clear a sticky terminal error"
  )
}

async function testPersistedBlobRefsStayCompactAndInvalidateSafely(): Promise<void> {
  const sentinel = "UNIQUE-MIDDLE-SENTINEL"
  const fullContent = `${"头🙂".repeat(8_000)}${sentinel}${"尾🚀".repeat(8_000)}`
  const reasoningSentinel = "UNIQUE-REASONING-MIDDLE-SENTINEL"
  const fullReasoning = `${"思🧠".repeat(8_000)}${reasoningSentinel}${"考🔎".repeat(8_000)}`
  const sentMessage: Message = {
    ...assistantMessage({ id: "large-ref-message", content: fullContent }),
    reasoning: fullReasoning,
    content_priority: 1
  }
  const sent = { "sidecar-task": [sentMessage] }
  const contentRef = {
    v: 1 as const,
    sha256: "a".repeat(64),
    bytes: Buffer.byteLength(JSON.stringify(fullContent), "utf8"),
    kind: "content" as const
  }
  const reasoningRef = {
    v: 1 as const,
    sha256: "b".repeat(64),
    bytes: Buffer.byteLength(JSON.stringify(fullReasoning), "utf8"),
    kind: "reasoning" as const
  }
  const attached = applyPersistedSubagentTranscriptRefs(sent, sent, {
    "sidecar-task": [
      { id: sentMessage.id, content_ref: contentRef, reasoning_ref: reasoningRef }
    ]
  })
  assert(
    attached["sidecar-task"]?.[0]?.content_ref?.sha256 === contentRef.sha256,
    "a matching persist response should attach its content ref without replacing full UI text"
  )
  assert(
    attached["sidecar-task"]?.[0]?.reasoning_ref?.sha256 === reasoningRef.sha256,
    "a matching persist response should attach its reasoning ref"
  )
  const serialized = serializeSubagentTranscripts(attached)
  const serializedMessage = (serialized["sidecar-task"] as Array<Record<string, unknown>>)[0]
  assert(
    Buffer.byteLength(JSON.stringify(serializedMessage.content), "utf8") <=
      SUBAGENT_TRANSCRIPT_INLINE_BYTES,
    "subsequent renderer saves should keep referenced multibyte content byte-bounded"
  )
  assert(
    !JSON.stringify(serializedMessage).includes(sentinel),
    "subsequent saves should not resend the full referenced middle content"
  )
  assert(
    Buffer.byteLength(JSON.stringify(serializedMessage.reasoning), "utf8") <=
      SUBAGENT_TRANSCRIPT_INLINE_BYTES &&
      !JSON.stringify(serializedMessage).includes(reasoningSentinel),
    "subsequent saves should keep referenced reasoning bounded and omit its middle"
  )

  const racedCurrent = {
    "sidecar-task": [
      { ...sentMessage, content: `${fullContent} newer`, content_ref: undefined }
    ]
  }
  const raced = applyPersistedSubagentTranscriptRefs(racedCurrent, sent, {
    "sidecar-task": [
      { id: sentMessage.id, content_ref: contentRef, reasoning_ref: reasoningRef }
    ]
  })
  assert(
    raced["sidecar-task"]?.[0]?.content_ref === undefined,
    "an older persist response must not attach a stale ref after content changes"
  )

  const reasoningRacedCurrent = {
    "sidecar-task": [
      { ...sentMessage, reasoning: `${fullReasoning} newer`, reasoning_ref: undefined }
    ]
  }
  const reasoningRaced = applyPersistedSubagentTranscriptRefs(reasoningRacedCurrent, sent, {
    "sidecar-task": [
      { id: sentMessage.id, content_ref: contentRef, reasoning_ref: reasoningRef }
    ]
  })
  assert(
    reasoningRaced["sidecar-task"]?.[0]?.reasoning_ref === undefined,
    "an older persist response must not attach a stale ref after reasoning changes"
  )

  const projectedReplay: Message = {
    ...assistantMessage({ id: sentMessage.id, content: "bounded projection" }),
    content_is_projection: true,
    content_full_length: fullContent.length,
    reasoning: "bounded reasoning projection",
    reasoning_is_projection: true,
    reasoning_full_length: fullReasoning.length,
    content_priority: 0
  }
  const afterProjection = mergeSubagentTranscripts(attached, "sidecar-task", [
    projectedReplay
  ])["sidecar-task"]?.[0]
  assert(
    afterProjection?.content === fullContent &&
      afterProjection.content_ref?.sha256 === contentRef.sha256,
    "a lower-priority projection must preserve the hydrated content and its ref"
  )
  assert(
    afterProjection?.reasoning === fullReasoning &&
      afterProjection.reasoning_ref?.sha256 === reasoningRef.sha256,
    "a storage reasoning projection must preserve hydrated reasoning and its ref"
  )

  const corrected: Message = {
    ...assistantMessage({ id: sentMessage.id, content: "authoritative correction" }),
    content_priority: 2
  }
  const afterCorrection = mergeSubagentTranscripts(attached, "sidecar-task", [corrected])[
    "sidecar-task"
  ]?.[0]
  assert(
    afterCorrection?.content === "authoritative correction" &&
      afterCorrection.content_ref === undefined,
    "a real authoritative correction must clear the stale content ref"
  )

  const reasoningCorrection: Message = {
    ...sentMessage,
    reasoning: "corrected reasoning",
    reasoning_ref: undefined
  }
  const afterReasoningCorrection = mergeSubagentTranscripts(
    attached,
    "sidecar-task",
    [reasoningCorrection]
  )["sidecar-task"]?.[0]
  assert(
    afterReasoningCorrection?.reasoning === "corrected reasoning" &&
      afterReasoningCorrection.reasoning_ref === undefined,
    "a real reasoning correction must clear the stale reasoning ref"
  )
}

async function run(): Promise<void> {
  await testPersistDrainCoalescesBurstWhileWriteIsInFlight()
  console.log("PASS subagent transcript persist drain coalesces bursts")
  await testHydratedTranscriptsRestoreClickableSubagentCards()
  console.log("PASS hydrated transcripts restore clickable subagent cards")
  await testLiveSnapshotPreservesHydratedTerminalCards()
  console.log("PASS live subagent snapshots preserve hydrated terminal cards")
  await testPromptOnlyPlaceholderRevivesOnlyWithCurrentLiveEvidence()
  console.log("PASS prompt-only cards revive only with current live evidence")
  await testPaginatedTranscriptMatchesOneShotCanonicalOrder()
  console.log("PASS paginated transcript matches one-shot canonical order")
  await testPendingPatchUsesPostMergeStartupRow()
  console.log("PASS pending persistence uses post-merge startup row")
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
  await testOversizedContentRemainsLosslessAcrossPersistence()
  console.log("PASS subagent transcript oversized content remains lossless")
  await testAuthoritativeContentPrioritySurvivesPersistence()
  console.log("PASS subagent transcript authoritative content priority")
  await testStableFinalReplacementCollapsesExistingRowsInPlace()
  console.log("PASS subagent transcript stable final replacement")
  await testStableFinalReplacementDoesNotConsumeToolCallAssistant()
  console.log("PASS subagent transcript replacement protects tool-call assistants")
  await testStableFinalReplacementSurvivesReloadAndLateLiveReplay()
  console.log("PASS subagent transcript replacement aliases survive reload")
  await testDuplicateStableRepairsCollapseAtLivePosition()
  console.log("PASS subagent transcript duplicate repairs preserve order")
  await testPrefixReplacementOnlyConsumesLatestProvisionalAssistant()
  console.log("PASS subagent transcript prefix repair only consumes latest provisional")
  await testCompatibleErrorPrefixOnlyCollapsesMatchingDiagnostic()
  console.log("PASS subagent transcript compatible error prefix is conservative")
  await testLargeTranscriptDoesNotDropOldestMessages()
  console.log("PASS subagent transcript preserves large history")
  await testExplicitFalseCannotClearStickyError()
  console.log("PASS subagent transcript keeps explicit-false errors sticky")
  await testPersistedBlobRefsStayCompactAndInvalidateSafely()
  console.log("PASS subagent transcript blob refs stay compact and invalidate safely")
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
