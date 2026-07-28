/**
 * Behavior tests for the current-run message queue (in-flight steering).
 *
 * Covers the electron-free queue module directly: the per-thread store, and the
 * beforeModel / afterModel injection middleware that feeds steered messages into
 * a running model loop. No Electron, no model — the middleware hooks are driven
 * with hand-built runtime/state objects.
 *
 * Run:
 *   npx -y tsx tests/message-queue-runtime.spec.ts
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages"
import {
  queueCurrentRunMessage as queueOwnedCurrentRunMessage,
  deleteCurrentRunQueuedMessage,
  clearCurrentRunMessageQueue,
  assertCurrentRunMessagesDurablyPersisted,
  getCurrentRunInjectedMessageIds,
  isCurrentRunMessageWithdrawn,
  peekCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  registerCurrentRunCompletedAssistantRoute,
  resolveCurrentRunCompletedAssistantIdentity,
  resolveCurrentRunInjectionAnchorId,
  routeCurrentRunCompletedAssistantMessage,
  setCurrentRunInjectionNotifier,
  setCurrentRunMessageQueueOwner,
  type CurrentRunQueuedMessage
} from "../src/main/agent/current-run-message-queue.ts"
import type { Message } from "../src/main/types.ts"
import { mergeIncrementalMessageContent } from "../src/shared/message-role-collision.ts"
import {
  accumulateStreamToolCallChunks,
  mergeStreamToolCallChunks,
  streamToolCallContentModeFromMessageMode
} from "../src/shared/stream-tool-call-chunks.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

const T1 = "thread-1"
const T2 = "thread-2"
const RUN1 = "run-1"
const RUN2 = "run-2"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runBeforeModel(state: any, runtime: any, runToken?: string): Promise<any> {
  const ownerToken = runToken ?? (runtime.configurable?.thread_id === T2 ? RUN2 : RUN1)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mw = createCurrentRunMessageQueueMiddleware(ownerToken) as any
  const hook = typeof mw.beforeModel === "function" ? mw.beforeModel : mw.beforeModel.hook
  return await hook(state, runtime)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAfterModel(state: any, runtime: any, runToken?: string): Promise<any> {
  const ownerToken = runToken ?? (runtime.configurable?.thread_id === T2 ? RUN2 : RUN1)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mw = createCurrentRunMessageQueueMiddleware(ownerToken) as any
  const hook = typeof mw.afterModel === "function" ? mw.afterModel : mw.afterModel.hook
  return await hook(state, runtime)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runWrappedModelCall(response: AIMessage, runtime: any, runToken?: string): Promise<void> {
  const ownerToken = runToken ?? (runtime.configurable?.thread_id === T2 ? RUN2 : RUN1)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mw = createCurrentRunMessageQueueMiddleware(ownerToken) as any
  await mw.wrapModelCall({ runtime }, async () => response)
}

const rt = (threadId?: string): { configurable: Record<string, unknown> } => ({
  configurable: threadId ? { thread_id: threadId } : {}
})

function reset(): void {
  clearCurrentRunMessageQueue(T1)
  clearCurrentRunMessageQueue(T2)
  setCurrentRunMessageQueueOwner(T1, RUN1)
  setCurrentRunMessageQueueOwner(T2, RUN2)
  setCurrentRunInjectionNotifier(() => {})
}

function msg(id: string, content: string, displayContent?: string): CurrentRunQueuedMessage {
  return { id, content, displayContent }
}

function queueCurrentRunMessage(
  threadId: string,
  message: CurrentRunQueuedMessage,
  runToken = threadId === T2 ? RUN2 : RUN1
): boolean {
  return queueOwnedCurrentRunMessage(threadId, message, runToken)
}

function testIncrementalContentBlockTranscriptMerge(): void {
  const prefix = [{ type: "text", text: "hello ", index: 0 }]
  const suffix = [{ type: "text", text: "world", index: 0 }]
  const cumulative = [{ type: "text", text: "hello world", index: 0 }]

  assertEqual(
    JSON.stringify(mergeIncrementalMessageContent(prefix, suffix)),
    JSON.stringify(cumulative),
    "same-index content-block deltas retain their persisted prefix"
  )
  assertEqual(
    JSON.stringify(mergeIncrementalMessageContent(prefix, prefix)),
    JSON.stringify([{ type: "text", text: "hello hello ", index: 0 }]),
    "a repeated content-block delta is not mistaken for a cumulative snapshot"
  )
  assertEqual(
    mergeIncrementalMessageContent("test", "te") as string,
    "testte",
    "a prefix-shaped string delta is still appended"
  )

  const textAndImage = mergeIncrementalMessageContent(prefix, [
    { type: "image", image_url: "data:image/png;base64,AA==", index: 1 }
  ])
  assertEqual(
    JSON.stringify(textAndImage),
    JSON.stringify([
      { type: "text", text: "hello ", index: 0 },
      { type: "image", image_url: "data:image/png;base64,AA==", index: 1 }
    ]),
    "different indexed content blocks are both retained"
  )
}

function testStreamToolCallChunksPersistCompleteArguments(): void {
  const accumulator = { snapshots: [], chunks: [] }
  const partialToolCalls = accumulateStreamToolCallChunks(
    accumulator,
    [{ id: "call-1", name: "lookup", args: {} }],
    [
      {
        id: "call-1",
        name: "lookup",
        args: '{"x":',
        index: 0,
        contentMode: "delta"
      }
    ]
  )
  assertEqual(
    JSON.stringify(partialToolCalls[0]?.args),
    JSON.stringify({}),
    "an incomplete first flush keeps the visible tool call without inventing arguments"
  )
  const toolCalls = accumulateStreamToolCallChunks(
    accumulator,
    [],
    [{ args: "1}", index: 0, contentMode: "delta" }]
  )
  assertEqual(toolCalls.length, 1, "tool-call chunks rebuild one stable call")
  assertEqual(toolCalls[0]?.name, "lookup", "the first chunk supplies the tool name")
  assertEqual(
    JSON.stringify(toolCalls[0]?.args),
    JSON.stringify({ x: 1 }),
    "split JSON arguments survive transcript flush and reload"
  )

  const snapshotArgs = mergeStreamToolCallChunks(
    [{ id: "call-2", name: "write", args: {} }],
    [
      { id: "call-2", args: '{"old":true}', index: 0, contentMode: "delta" },
      { id: "call-2", args: '{"new":true}', index: 0, contentMode: "snapshot" }
    ]
  )
  assertEqual(
    JSON.stringify(snapshotArgs[0]?.args),
    JSON.stringify({ new: true }),
    "an explicit full-message tool-call snapshot replaces prior delta text"
  )

  const chunkMessageToolArgsMode = streamToolCallContentModeFromMessageMode("delta")
  assertEqual(
    chunkMessageToolArgsMode,
    "auto",
    "AIMessageChunk does not overclaim provider tool-args delta semantics"
  )
  const cumulativeArgs = mergeStreamToolCallChunks(
    [{ id: "call-3", name: "task", args: {} }],
    [
      {
        id: "call-3",
        args: '{"subagent_type":"worker","prompt":"Find',
        index: 0,
        contentMode: chunkMessageToolArgsMode
      },
      {
        id: "call-3",
        args: '{"subagent_type":"worker","prompt":"Find usages"}',
        index: 0,
        contentMode: chunkMessageToolArgsMode
      }
    ]
  )
  assertEqual(
    JSON.stringify(cumulativeArgs[0]?.args),
    JSON.stringify({ subagent_type: "worker", prompt: "Find usages" }),
    "a provider cumulative args replay replaces the incomplete prefix"
  )

  const overlapArgs = mergeStreamToolCallChunks(
    [{ id: "call-4", name: "task", args: {} }],
    [
      {
        id: "call-4",
        args: '{"description":"调研',
        index: 0,
        contentMode: "delta"
      },
      {
        args: '调研项目","prompt":"ok"}',
        index: 0,
        contentMode: "delta"
      }
    ]
  )
  assertEqual(
    JSON.stringify(overlapArgs[0]?.args),
    JSON.stringify({ description: "调研调研项目", prompt: "ok" }),
    "an ambiguous boundary overlap fails closed as provider data"
  )

  const legitimateBoundaryRepeat = mergeStreamToolCallChunks(
    [{ id: "call-5", name: "write", args: {} }],
    [
      {
        id: "call-5",
        args: '{"text":"bana',
        index: 0,
        contentMode: chunkMessageToolArgsMode
      },
      { args: 'nana"}', index: 0, contentMode: chunkMessageToolArgsMode }
    ]
  )
  assertEqual(
    JSON.stringify(legitimateBoundaryRepeat[0]?.args),
    JSON.stringify({ text: "bananana" }),
    "explicit deltas preserve legitimate repeated boundary bytes"
  )

  const largeContent = "x".repeat(256 * 1024)
  const largeArgs = JSON.stringify({ path: "large.txt", content: largeContent })
  const largeAccumulator = { snapshots: [], chunks: [] }
  let largeToolCalls: ReturnType<typeof accumulateStreamToolCallChunks> = []
  const chunkSize = 257
  for (let offset = 0; offset < largeArgs.length; offset += chunkSize) {
    largeToolCalls = accumulateStreamToolCallChunks(
      largeAccumulator,
      offset === 0 ? [{ id: "call-large", name: "write_file", args: {} }] : [],
      [
        {
          ...(offset === 0 ? { id: "call-large", name: "write_file" } : {}),
          args: largeArgs.slice(offset, offset + chunkSize),
          index: 0,
          contentMode: "delta"
        }
      ]
    )
  }
  assertEqual(
    (largeToolCalls[0]?.args.content as string | undefined)?.length,
    largeContent.length,
    "large streamed file content is reconstructed without losing bytes"
  )
  assertEqual(
    largeAccumulator.snapshots.length,
    0,
    "incremental accumulation does not retain repeated snapshot history"
  )
  assertEqual(
    largeAccumulator.chunks.length,
    0,
    "incremental accumulation does not retain raw chunk history"
  )
}

function testCompletedAssistantIdentityUsesCurrentProviderOccurrence(): void {
  const providerId = "reused-after-model-provider"
  const secondOccurrenceId = `${providerId}::cmb-same-role-duplicate:assistant:2`
  const baseline = [
    { id: "identity-user-1", role: "user" as const, content: "first question" },
    { id: providerId, role: "assistant" as const, content: "old answer" },
    { id: "identity-user-2", role: "user" as const, content: "second question" },
    {
      id: secondOccurrenceId,
      provider_source_id: providerId,
      provider_occurrence: 2,
      role: "assistant" as const,
      content: "new partial"
    }
  ]
  const completed = {
    id: "current-run-assistant:stable",
    sourceId: providerId,
    content: "new final"
  }

  const resolved = resolveCurrentRunCompletedAssistantIdentity(baseline, completed)
  assertEqual(
    resolved.sourceId,
    secondOccurrenceId,
    "afterModel steer must rekey the current occurrence-scoped row instead of occurrence one"
  )
  assertEqual(resolved.providerSourceId, providerId, "the stable row keeps provider identity")
  assertEqual(resolved.providerOccurrence, 2, "the stable row keeps the current occurrence")

  const resolvedBeforePartial = resolveCurrentRunCompletedAssistantIdentity(
    baseline.slice(0, 3),
    completed
  )
  assertEqual(
    resolvedBeforePartial.sourceId,
    secondOccurrenceId,
    "afterModel steer must reserve the next occurrence even before a partial row is durable"
  )
  assertEqual(
    resolvedBeforePartial.providerOccurrence,
    2,
    "the reserved stable row must carry its provider occurrence"
  )

  const resolvedRetry = resolveCurrentRunCompletedAssistantIdentity(
    [
      ...baseline.slice(0, 3),
      {
        id: completed.id,
        provider_source_id: providerId,
        provider_occurrence: 2,
        role: "assistant" as const,
        content: completed.content
      },
      { id: "identity-steered-user", role: "user" as const, content: "steer" }
    ],
    completed
  )
  assertEqual(
    resolvedRetry.sourceId,
    completed.id,
    "a retry after durable write must reuse the stable row instead of allocating occurrence three"
  )
  assertEqual(
    resolvedRetry.providerOccurrence,
    2,
    "a retry after durable write must retain the stable row provider occurrence"
  )
}

function testInjectionAnchorResolvesProviderRoleAndOccurrence(): void {
  const at = new Date("2026-07-22T08:00:00.000Z")
  const baseline: Message[] = [
    {
      id: "shared-provider",
      provider_source_id: "shared-provider",
      provider_occurrence: 1,
      role: "assistant",
      content: "assistant",
      created_at: at
    },
    {
      id: "shared-provider::cmb-id-collision:tool",
      provider_source_id: "shared-provider",
      provider_occurrence: 1,
      role: "tool",
      content: "tool",
      created_at: at
    },
    {
      id: "shared-provider::cmb-same-role-assistant:2",
      provider_source_id: "shared-provider",
      provider_occurrence: 2,
      role: "assistant",
      content: "second assistant",
      created_at: at
    }
  ]
  assertEqual(
    resolveCurrentRunInjectionAnchorId(baseline, {
      id: "shared-provider",
      role: "tool",
      providerSourceId: "shared-provider"
    }),
    "shared-provider::cmb-id-collision:tool",
    "a raw cross-role provider id resolves to the durable row with the anchor role"
  )
  assertEqual(
    resolveCurrentRunInjectionAnchorId(baseline, {
      id: "shared-provider",
      role: "assistant",
      providerSourceId: "shared-provider",
      providerOccurrence: 2
    }),
    "shared-provider::cmb-same-role-assistant:2",
    "an explicit provider occurrence cannot be stolen by the raw occurrence-one render id"
  )
  assertEqual(
    resolveCurrentRunInjectionAnchorId(baseline, {
      id: "shared-provider",
      role: "assistant",
      providerSourceId: "shared-provider"
    }),
    "shared-provider::cmb-same-role-assistant:2",
    "an implicit tail predecessor resolves to the latest same-role durable occurrence"
  )
}

function testCompletedAssistantRouteHandlesFragmentsAndIsRunScoped(): void {
  reset()
  const rawId = "late-completed-provider"
  const stableId = "current-run-assistant:late-stable"
  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer"
  })
  const routedCompleted = routeCurrentRunCompletedAssistantMessage(T1, {
    id: rawId,
    role: "assistant",
    content: "completed answer"
  })
  assertEqual(
    routedCompleted?.stableId,
    stableId,
    "the delayed completed event must route to the stable id"
  )
  assertEqual(
    routedCompleted?.providerOccurrence,
    2,
    "the delayed completed event must preserve its provider occurrence"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "guided answer"
    }),
    undefined,
    "the completed response route must be consumed before the guided answer"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer"
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "completed "
    })?.stableId,
    stableId,
    "a delayed delta prefix must keep routing to the completed stable row"
  )
  const routedSuffix = routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "answer"
    })
  assertEqual(
    routedSuffix?.stableId,
    stableId,
    "a delayed delta suffix must finish the same completed stable row"
  )
  assertEqual(
    routedSuffix?.content,
    "completed answer",
    "a routed delta exposes cumulative content for snapshot-style transcript replacement"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "guided answer"
    }),
    undefined,
    "the completed response route must be consumed after its final fragment"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer",
    observedContent: "completed "
  })
  const routedAfterDurablePrefix = routeCurrentRunCompletedAssistantMessage(
    T1,
    { id: rawId, role: "assistant", content: "answer" },
    RUN1
  )
  assertEqual(
    routedAfterDurablePrefix?.stableId,
    stableId,
    "a suffix arriving after the prefix was durably flushed keeps the stable route"
  )
  assertEqual(
    routedAfterDurablePrefix?.content,
    "completed answer",
    "the durable prefix and delayed suffix produce one cumulative persisted snapshot"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer"
  })
  routeCurrentRunCompletedAssistantMessage(T1, {
    id: rawId,
    role: "assistant",
    content: "completed "
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "completed answer"
    })?.stableId,
    stableId,
    "a cumulative final snapshot must finish a route started by a prefix snapshot"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: [
      { type: "text", text: "completed " },
      { type: "text", text: "answer" }
    ]
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "completed " }]
    })?.stableId,
    stableId,
    "a text-block array delta prefix must keep the completed route"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "answer" }]
    })?.stableId,
    stableId,
    "a text-block array delta suffix must finish the completed route"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "guided answer" }]
    }),
    undefined,
    "a completed text-block route must be consumed before the guided reply"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: [{ type: "text", text: "completed answer" }]
  })
  routeCurrentRunCompletedAssistantMessage(T1, {
    id: rawId,
    role: "assistant",
    content: [{ type: "text", text: "completed " }]
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "completed answer" }]
    })?.stableId,
    stableId,
    "a cumulative text-block snapshot must finish the same completed route"
  )

  const imageBlock = { type: "image", source: { type: "base64", data: "AA==" }, index: 1 }
  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: [
      { type: "text", text: "completed answer", index: 0 },
      imageBlock
    ]
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "completed ", index: 0 }]
    })?.stableId,
    stableId,
    "a mixed-content text delta must keep the completed route"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "answer", index: 0 }, imageBlock]
    })?.stableId,
    stableId,
    "the merged text suffix and non-text block must finish the completed route"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [{ type: "text", text: "guided answer", index: 0 }]
    }),
    undefined,
    "a completed mixed-content route must be consumed before the guided reply"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: [
      { type: "text", text: "completed answer", index: 0 },
      { type: "tool_use", id: "call-1", name: "lookup", input: "{}", index: 1 }
    ]
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [
        { type: "text", text: "completed ", index: 0 },
        { type: "tool_use", id: "call-1", name: "lookup", input: "{", index: 1 }
      ]
    })?.stableId,
    stableId,
    "a partially merged non-text block must keep the completed route"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: [
        { type: "text", text: "answer", index: 0 },
        { type: "tool_use", input: "}", index: 1 }
      ]
    })?.stableId,
    stableId,
    "LangChain block-index merging must finish the same completed route"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer"
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: stableId,
      role: "assistant",
      content: "completed answer"
    })?.stableId,
    stableId,
    "an already-stable delayed event must consume the same route"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer"
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "different guided answer"
    }),
    undefined,
    "different content must not be mistaken for the completed response"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "completed answer"
    }),
    undefined,
    "a mismatched assistant event must clear the stale completed route"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN1, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "completed answer"
  })
  setCurrentRunMessageQueueOwner(T1, RUN2)
  clearCurrentRunMessageQueue(T1, RUN1)
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(T1, {
      id: rawId,
      role: "assistant",
      content: "completed answer"
    }),
    undefined,
    "cleanup from a replaced run must remove only its completed response route"
  )

  registerCurrentRunCompletedAssistantRoute(T1, RUN2, {
    rawSourceId: rawId,
    stableId,
    providerSourceId: rawId,
    providerOccurrence: 2,
    content: "replacement answer"
  })
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(
      T1,
      { id: rawId, role: "assistant", content: "replacement answer" },
      RUN1
    ),
    undefined,
    "an obsolete physical run cannot consume the replacement run's completed route"
  )
  assertEqual(
    routeCurrentRunCompletedAssistantMessage(
      T1,
      { id: rawId, role: "assistant", content: "replacement answer" },
      RUN2
    )?.stableId,
    stableId,
    "the replacement owner can still consume its route after an obsolete callback"
  )
}

// ── Store ────────────────────────────────────────────────────────────────────

function testQueueAndPeek(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "hello"))
  const q = peekCurrentRunMessageQueue(T1)
  assertEqual(q.length, 1, "one message queued")
  assertEqual(q[0].id, "a", "queued id")
  assertEqual(q[0].content, "hello", "queued content")
}

function testQueueReplacesById(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "first"))
  queueCurrentRunMessage(T1, msg("b", "second"))
  queueCurrentRunMessage(T1, msg("a", "first-edited"))
  const q = peekCurrentRunMessageQueue(T1)
  assertEqual(q.length, 2, "same id replaces, not appends")
  assertEqual(q[0].id, "a", "replaced item keeps its position")
  assertEqual(q[0].content, "first-edited", "replaced content updated")
  assertEqual(q[1].id, "b", "other item untouched")
}

function testQueueRejectsBlank(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "   "))
  queueCurrentRunMessage(T1, msg("", "nonblank"))
  assertEqual(peekCurrentRunMessageQueue(T1).length, 0, "blank content and empty id rejected")
}

function testDeleteRemovesOne(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "one"))
  queueCurrentRunMessage(T1, msg("b", "two"))
  deleteCurrentRunQueuedMessage(T1, "a")
  const q = peekCurrentRunMessageQueue(T1)
  assertEqual(q.length, 1, "one left after delete")
  assertEqual(q[0].id, "b", "correct one left")
}

function testClearEmpties(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "one"))
  queueCurrentRunMessage(T1, msg("b", "two"))
  clearCurrentRunMessageQueue(T1)
  assertEqual(peekCurrentRunMessageQueue(T1).length, 0, "cleared")
}

function testThreadIsolationStore(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "one"))
  assertEqual(peekCurrentRunMessageQueue(T2).length, 0, "other thread's queue is empty")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "own thread's queue intact")
}

function testPeekReturnsCopy(): void {
  reset()
  queueCurrentRunMessage(T1, msg("a", "one"))
  const q = peekCurrentRunMessageQueue(T1)
  q.push(msg("x", "mutated"))
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "peek returns a copy; caller mutation ignored")
}

// ── beforeModel ────────────────────────────────────────────────────────────────

async function testBeforeModelInjectsAndDrains(): Promise<void> {
  reset()
  let anchorMessage: { id: string; role: string } | undefined
  setCurrentRunInjectionNotifier((_threadId, _messages, context) => {
    anchorMessage = context?.anchorMessage
  })
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  const result = await runBeforeModel(
    { messages: [new HumanMessage({ id: "original-user", content: "question" })] },
    rt(T1)
  )
  assert(result && Array.isArray(result.messages), "beforeModel returns messages")
  assertEqual(result.messages.length, 1, "one injected message")
  assert(HumanMessage.isInstance(result.messages[0]), "injected as HumanMessage")
  assertEqual(result.messages[0].id, "a", "injected message keeps queued id")
  assertEqual(result.messages[0].content, "steer me", "injected model content")
  assertEqual(
    `${anchorMessage?.role}:${anchorMessage?.id}`,
    "user:original-user",
    "beforeModel anchors the durable injected batch to its graph predecessor"
  )
  assertEqual(peekCurrentRunMessageQueue(T1).length, 0, "queue drained after injection")
}

async function testInjectedMessagePreservesVisibleAlias(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "hook context\n\nrewritten prompt", "user original"))
  const result = await runBeforeModel({ messages: [] }, rt(T1))
  const injected = result.messages[0] as HumanMessage
  assertEqual(injected.content, "hook context\n\nrewritten prompt", "model receives prepared content")
  assertEqual(
    injected.additional_kwargs?.cmb_visible_user_message,
    "user original",
    "checkpoint restore/export receives the visible user alias"
  )
}

async function testInjectedMessageOmitsRedundantVisibleAlias(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "same content", "same content"))
  const result = await runBeforeModel({ messages: [] }, rt(T1))
  const injected = result.messages[0] as HumanMessage
  assertEqual(
    injected.additional_kwargs?.cmb_visible_user_message,
    undefined,
    "unchanged prompts do not add redundant checkpoint metadata"
  )
}

async function testBeforeModelNoThreadNoop(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  const result = await runBeforeModel({ messages: [] }, rt(undefined))
  assertEqual(result, undefined, "no thread_id → no injection")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "queue untouched without thread_id")
}

async function testBeforeModelEmptyNoop(): Promise<void> {
  reset()
  const result = await runBeforeModel({ messages: [] }, rt(T1))
  assertEqual(result, undefined, "empty queue → undefined")
}

// ── afterModel ─────────────────────────────────────────────────────────────────

async function testAfterModelInjectsOnFinalReply(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  const state = { messages: [new AIMessage({ content: "all done" })] }
  const result = await runAfterModel(state, rt(T1))
  assert(result && Array.isArray(result.messages), "afterModel injects on final reply")
  assertEqual(result.messages.length, 1, "one injected message")
  assertEqual(result.jumpTo, "model", "jumps back to model so the steer is answered")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 0, "queue drained")
}

async function testAfterModelPassesCompletedAssistantToNotifier(): Promise<void> {
  reset()
  let completedAssistant: { id: string; content: unknown } | undefined
  let notifiedRunToken: string | undefined
  let anchorMessage: { id: string; role: string } | undefined
  setCurrentRunInjectionNotifier((_threadId, _messages, context) => {
    completedAssistant = context?.completedAssistantMessage
    notifiedRunToken = context?.runToken
    anchorMessage = context?.anchorMessage
    return {
      completedAssistantIdentity: {
        sourceId: "assistant-final::cmb-same-role-assistant:2",
        providerSourceId: "assistant-final",
        providerOccurrence: 2
      }
    }
  })
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  const finalReply = new AIMessage({ id: "assistant-final", content: "the first reply" })
  await runAfterModel(
    {
      messages: [new HumanMessage({ id: "original-user", content: "question" }), finalReply]
    },
    rt(T1)
  )
  assert(
    completedAssistant?.id.startsWith("current-run-assistant:"),
    "final assistant uses an isolated transcript id"
  )
  assertEqual(
    completedAssistant?.content,
    "the first reply",
    "notifier receives final assistant content before the steer"
  )
  assertEqual(
    finalReply.id,
    completedAssistant?.id,
    "graph state final assistant id is aligned with the durable transcript id"
  )
  assertEqual(notifiedRunToken, RUN1, "the notifier receives the physical run token")
  assertEqual(
    `${anchorMessage?.role}:${anchorMessage?.id}`,
    "user:original-user",
    "afterModel anchors the completed reply and guide before any replacement turn"
  )
  assertEqual(
    finalReply.additional_kwargs.cmb_internal_provider_source_id,
    "assistant-final",
    "graph state records the completed reply provider source"
  )
  assertEqual(
    finalReply.additional_kwargs.cmb_internal_provider_occurrence,
    2,
    "graph state records the completed reply provider occurrence"
  )
}

async function testAfterModelMintsTranscriptIdWhenProviderOmitsOne(): Promise<void> {
  reset()
  let completedAssistant: { id: string; content: unknown } | undefined
  setCurrentRunInjectionNotifier((_threadId, _messages, context) => {
    completedAssistant = context?.completedAssistantMessage
  })
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  await runAfterModel({ messages: [new AIMessage({ content: "id-less provider reply" })] }, rt(T1))
  assert(
    completedAssistant?.id.startsWith("current-run-assistant:"),
    "id-less provider replies receive an isolated transcript id"
  )
  assertEqual(
    completedAssistant?.content,
    "id-less provider reply",
    "id-less provider reply content is still persisted"
  )
}

async function testAfterModelUsesRawWrappedModelResponse(): Promise<void> {
  reset()
  let completedAssistant: { id: string; content: unknown } | undefined
  setCurrentRunInjectionNotifier((_threadId, _messages, context) => {
    completedAssistant = context?.completedAssistantMessage
  })
  await runWrappedModelCall(new AIMessage({ content: "raw provider response" }), rt(T1))
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  await runAfterModel({ messages: [new AIMessage({ content: "" })] }, rt(T1))
  assertEqual(
    completedAssistant?.content,
    "raw provider response",
    "afterModel uses the raw model response instead of its trimmed state copy"
  )
  assert(
    completedAssistant?.id.startsWith("current-run-assistant:"),
    "raw provider response receives an isolated transcript id"
  )
}

async function testAfterModelSkipsWhenToolCalls(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  const state = {
    messages: [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "read_file", args: {} }] })
    ]
  }
  const result = await runAfterModel(state, rt(T1))
  assertEqual(result, undefined, "tool_calls present → afterModel does not inject")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "queue preserved for next beforeModel")
}

async function testAfterModelSkipsWhenLastNotAI(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "steer me"))
  const state = { messages: [new HumanMessage({ content: "user turn" })] }
  const result = await runAfterModel(state, rt(T1))
  assertEqual(result, undefined, "last message not AI → no injection")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "queue preserved")
}

async function testAfterModelEmptyQueueNoop(): Promise<void> {
  reset()
  const state = { messages: [new AIMessage({ content: "done" })] }
  const result = await runAfterModel(state, rt(T1))
  assertEqual(result, undefined, "empty queue → undefined even on final reply")
}

// ── Notifier + content selection ────────────────────────────────────────────────

async function testNotifierReceivesInjected(): Promise<void> {
  reset()
  const seen: Array<{ threadId: string; ids: string[]; contents: string[] }> = []
  setCurrentRunInjectionNotifier((threadId, messages) => {
    seen.push({
      threadId,
      ids: messages.map((m) => m.id),
      contents: messages.map((m) => m.displayContent || m.content)
    })
  })
  queueCurrentRunMessage(T1, msg("a", "model-payload", "display-text"))
  await runBeforeModel({ messages: [] }, rt(T1))
  assertEqual(seen.length, 1, "notifier fired once")
  assertEqual(seen[0].threadId, T1, "notifier got thread id")
  assertEqual(seen[0].ids[0], "a", "notifier got message id")
  assertEqual(seen[0].contents[0], "display-text", "notifier prefers displayContent")
}

async function testNotifierFallsBackToContent(): Promise<void> {
  reset()
  let notifiedContent = ""
  setCurrentRunInjectionNotifier((_t, messages) => {
    notifiedContent = messages[0].displayContent || messages[0].content
  })
  queueCurrentRunMessage(T1, msg("a", "just-model"))
  await runBeforeModel({ messages: [] }, rt(T1))
  assertEqual(notifiedContent, "just-model", "falls back to content when no displayContent")
}

async function testAsyncNotifierCompletesBeforeInjection(): Promise<void> {
  reset()
  let release: (() => void) | undefined
  setCurrentRunInjectionNotifier(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  queueCurrentRunMessage(T1, msg("a", "wait for disk"))

  const injectionPromise = runBeforeModel({ messages: [] }, rt(T1))
  await Promise.resolve()
  assertEqual(
    getCurrentRunInjectedMessageIds(T1).length,
    0,
    "message is not acknowledged as injected before async persistence completes"
  )
  release?.()
  const result = await injectionPromise
  assertEqual(result.messages[0].id, "a", "injection resumes after persistence completes")
}

async function testNotifierFailureRestoresQueueWithoutMarkingInjected(): Promise<void> {
  reset()
  setCurrentRunInjectionNotifier(() => {
    throw new Error("durable write failed")
  })
  queueCurrentRunMessage(T1, msg("a", "must-not-be-lost"))
  let threw = false
  try {
    await runBeforeModel({ messages: [] }, rt(T1))
  } catch {
    threw = true
  }
  assertEqual(threw, true, "a durable acknowledgement failure aborts injection")
  assertEqual(
    peekCurrentRunMessageQueue(T1).length,
    1,
    "failed injection returns the draft to queue"
  )
  assertEqual(
    getCurrentRunInjectedMessageIds(T1).length,
    0,
    "failed durable acknowledgement never marks the id injected"
  )
}

async function testNotifierFailureDoesNotRestoreIntoReplacementRun(): Promise<void> {
  reset()
  let rejectPersistence: ((error: Error) => void) | undefined
  setCurrentRunInjectionNotifier(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectPersistence = reject
      })
  )
  queueCurrentRunMessage(T1, msg("old", "belongs to the replaced run"))

  const oldInjection = runBeforeModel({ messages: [] }, rt(T1), RUN1)
  await Promise.resolve()

  setCurrentRunMessageQueueOwner(T1, RUN2)
  queueCurrentRunMessage(T1, msg("new", "belongs to the replacement run"), RUN2)
  const ownershipError = new Error("old run owner changed after durable write")
  ownershipError.name = "AbortError"
  rejectPersistence?.(ownershipError)

  let threw = false
  let errorName = ""
  try {
    await oldInjection
  } catch (error) {
    threw = true
    errorName = error instanceof Error ? error.name : ""
  }
  assertEqual(threw, true, "the old run still observes its persistence failure")
  assertEqual(errorName, "AbortError", "an ownership fence aborts the old graph")
  assertEqual(
    getCurrentRunInjectedMessageIds(T1).includes("old"),
    false,
    "an old-run message is not acknowledged after ownership changes"
  )
  const remaining = peekCurrentRunMessageQueue(T1)
  assertEqual(remaining.length, 1, "the replacement run keeps only its own queued message")
  assertEqual(remaining[0].id, "new", "the old run's drained message is not restored")
}

function testDurablePersistenceCountMustCoverEveryInjectedMessage(): void {
  assertCurrentRunMessagesDurablyPersisted(2, 2)
  let threw = false
  try {
    assertCurrentRunMessagesDurablyPersisted(2, 1)
  } catch {
    threw = true
  }
  assertEqual(threw, true, "partial/zero-row persistence cannot acknowledge injected messages")
}

// ── Thread isolation during injection (workflow subagent / worker safety) ────────

async function testInjectionThreadIsolation(): Promise<void> {
  reset()
  // A message steered into thread T1 must never be drained by a model loop
  // running under a different thread id (e.g. a workflow subagent `<t1>__wf_...`
  // or a coordinator worker). Different thread_id → different queue.
  queueCurrentRunMessage(T1, msg("a", "for-foreground"))
  queueCurrentRunMessage(T2, msg("b", "for-other"))
  const result = await runBeforeModel({ messages: [] }, rt(T2))
  assertEqual(result.messages.length, 1, "drains only its own thread")
  assertEqual(result.messages[0].id, "b", "drained the correct thread's message")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "foreground thread's steer preserved")
}

// ── Already-injected re-queue guard (checkpoint-corruption regression) ───────────
//
// A renderer's local "已引导" flag can be stale relative to main's actual queue
// state: it's cleared only once the injection-notification round trip lands, but
// the model may have already been shown (and replied to) the message well before
// that. If an edit-then-save landed in that window and re-queued the SAME id,
// the graph's replace-by-id messages reducer would silently rewrite an
// already-persisted HumanMessage the model already responded to. These tests
// lock in that queueCurrentRunMessage refuses that re-queue outright.

async function testQueueRejectsReQueueOfAlreadyInjectedId(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "original"))
  await runBeforeModel({ messages: [] }, rt(T1)) // drains "a" → now tracked as injected
  const accepted = queueCurrentRunMessage(T1, msg("a", "edited-after-injection"))
  assertEqual(accepted, false, "re-queueing an already-injected id is rejected")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 0, "rejected re-queue never enters the queue")
}

async function testQueueAcceptsFreshIdAfterAnotherWasInjected(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "first"))
  await runBeforeModel({ messages: [] }, rt(T1)) // drains "a"
  const accepted = queueCurrentRunMessage(T1, msg("b", "second"))
  assertEqual(accepted, true, "a different id is unaffected by another id's injected status")
  assertEqual(peekCurrentRunMessageQueue(T1).length, 1, "fresh id queued normally")
}

function testAcceptedQueueReturnsTrue(): void {
  reset()
  const accepted = queueCurrentRunMessage(T1, msg("a", "hello"))
  assertEqual(accepted, true, "a normal, first-time queue call is accepted")
}

async function testClearResetsInjectedTracking(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("a", "original"))
  await runBeforeModel({ messages: [] }, rt(T1)) // drains "a", marks it injected
  clearCurrentRunMessageQueue(T1) // run ends
  setCurrentRunMessageQueueOwner(T1, RUN2)
  const accepted = queueCurrentRunMessage(
    T1,
    msg("a", "next run reusing the same id"),
    RUN2
  )
  assertEqual(accepted, true, "a new run on the same thread isn't poisoned by a past run's ids")
}

function testDeleteBeforeAsyncPreparationPreventsLateQueue(): void {
  reset()
  deleteCurrentRunQueuedMessage(T1, "late")
  assertEqual(
    isCurrentRunMessageWithdrawn(T1, "late"),
    true,
    "withdrawal is remembered before async preparation completes"
  )
  assertEqual(
    queueCurrentRunMessage(T1, msg("late", "must not be resurrected")),
    false,
    "late preparation cannot resurrect a withdrawn message"
  )
  clearCurrentRunMessageQueue(T1)
  assertEqual(
    isCurrentRunMessageWithdrawn(T1, "late"),
    false,
    "run cleanup clears withdrawal tombstones"
  )
}

async function testContinuationTransferPreservesAcceptedGuide(): Promise<void> {
  reset()
  queueCurrentRunMessage(T1, msg("guide", "continue with this"))

  setCurrentRunMessageQueueOwner(T1, RUN2)
  assertEqual(
    await runBeforeModel({ messages: [] }, rt(T1), RUN1),
    undefined,
    "the replaced run cannot drain a continuation-owned guide"
  )
  clearCurrentRunMessageQueue(T1, RUN1)
  assertEqual(
    peekCurrentRunMessageQueue(T1).length,
    1,
    "the replaced run's late finally cleanup cannot discard the guide"
  )

  const injection = await runBeforeModel({ messages: [] }, rt(T1), RUN2)
  assertEqual(injection.messages.length, 1, "the continuation receives the preserved guide")
  assertEqual(injection.messages[0].id, "guide", "the preserved guide keeps its id")
}

function testContinuationTransferPreservesWithdrawal(): void {
  reset()
  queueCurrentRunMessage(T1, msg("guide", "remove this"))

  setCurrentRunMessageQueueOwner(T1, RUN2)
  deleteCurrentRunQueuedMessage(T1, "guide")
  clearCurrentRunMessageQueue(T1, RUN1)

  assertEqual(peekCurrentRunMessageQueue(T1).length, 0, "a withdrawn guide stays removed")
  assertEqual(
    isCurrentRunMessageWithdrawn(T1, "guide"),
    true,
    "the continuation keeps the withdrawal tombstone"
  )
  assertEqual(
    queueCurrentRunMessage(T1, msg("guide", "must not return"), RUN2),
    false,
    "late work from the replaced run cannot resurrect the withdrawal"
  )
}

async function main(): Promise<void> {
  const tests = [
    testIncrementalContentBlockTranscriptMerge,
    testStreamToolCallChunksPersistCompleteArguments,
    testCompletedAssistantIdentityUsesCurrentProviderOccurrence,
    testInjectionAnchorResolvesProviderRoleAndOccurrence,
    testCompletedAssistantRouteHandlesFragmentsAndIsRunScoped,
    testQueueAndPeek,
    testQueueReplacesById,
    testQueueRejectsBlank,
    testDeleteRemovesOne,
    testClearEmpties,
    testThreadIsolationStore,
    testPeekReturnsCopy,
    testBeforeModelInjectsAndDrains,
    testInjectedMessagePreservesVisibleAlias,
    testInjectedMessageOmitsRedundantVisibleAlias,
    testBeforeModelNoThreadNoop,
    testBeforeModelEmptyNoop,
    testAfterModelInjectsOnFinalReply,
    testAfterModelPassesCompletedAssistantToNotifier,
    testAfterModelMintsTranscriptIdWhenProviderOmitsOne,
    testAfterModelUsesRawWrappedModelResponse,
    testAfterModelSkipsWhenToolCalls,
    testAfterModelSkipsWhenLastNotAI,
    testAfterModelEmptyQueueNoop,
    testNotifierReceivesInjected,
    testNotifierFallsBackToContent,
    testAsyncNotifierCompletesBeforeInjection,
    testNotifierFailureRestoresQueueWithoutMarkingInjected,
    testNotifierFailureDoesNotRestoreIntoReplacementRun,
    testDurablePersistenceCountMustCoverEveryInjectedMessage,
    testInjectionThreadIsolation,
    testQueueRejectsReQueueOfAlreadyInjectedId,
    testQueueAcceptsFreshIdAfterAnotherWasInjected,
    testAcceptedQueueReturnsTrue,
    testClearResetsInjectedTracking,
    testDeleteBeforeAsyncPreparationPreventsLateQueue,
    testContinuationTransferPreservesAcceptedGuide,
    testContinuationTransferPreservesWithdrawal
  ]

  for (const test of tests) {
    await test()
    console.log(`✓ ${test.name}`)
  }
  console.log(`\n${tests.length} passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
