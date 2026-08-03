/**
 * Unit tests for stable stream message IDs.
 *
 * Run:
 *   npx tsx tests/stream-message-ids.spec.ts
 */

import {
  buildStableValuesMessageId,
  buildSyntheticCheckpointBaselineIds
} from "../src/renderer/src/lib/stream-message-ids.ts"
import {
  ElectronIPCTransport,
  transformSerializedValuesMessages,
  type TransformedValuesMessage
} from "../src/renderer/src/lib/electron-transport.ts"
import { isSerializedSummarizationMessage } from "../src/shared/context-compaction-messages.ts"
import {
  mergeLiveStreamMessages,
  normalizeAppendedLiveStreamMessageIds,
  replaceLiveStreamMessageId,
  type LiveStreamMessage
} from "../src/renderer/src/lib/live-stream-messages.ts"
import {
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId
} from "../src/shared/message-role-collision.ts"

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

function testSummarizationMessagesUseStructuralFiltering(): void {
  const canonicalSummary = {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: {
      id: "context-summary",
      content: "You are in the middle of a conversation that has been summarized.\nsummary",
      additional_kwargs: { lc_source: "summarization" }
    }
  }
  const deserializedSummary = {
    additional_kwargs: { lc_source: "summarization" },
    content: "Here is a summary of the conversation to date:\nsummary"
  }
  const ordinaryAssistant = {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: "ordinary-assistant",
      content: "Here is a summary of the conversation to date:\n用户要求原样输出"
    }
  }

  assertEqual(
    isSerializedSummarizationMessage(canonicalSummary),
    true,
    "canonical serialized summary should be identified by lc_source"
  )
  assertEqual(
    isSerializedSummarizationMessage(deserializedSummary),
    true,
    "deserialized checkpoint summary should be identified by top-level lc_source"
  )
  assertEqual(
    isSerializedSummarizationMessage(ordinaryAssistant),
    false,
    "visible assistant prose should not be classified without lc_source"
  )

  const transformed = transformSerializedValuesMessages([
    canonicalSummary,
    ordinaryAssistant
  ] as never)
  assertEqual(transformed.length, 1, "values conversion should drop only marked summaries")
  assertEqual(
    transformed[0]?.id,
    "ordinary-assistant",
    "values conversion should preserve ordinary assistant prose"
  )
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

function testSystemFallbackIdIsDistinctFromAssistant(): void {
  const assistant = buildStableValuesMessageId({
    index: 1,
    type: "ai",
    className: "SystemMessage",
    content: "Goal 已继续"
  })
  const system = buildStableValuesMessageId({
    index: 1,
    type: "system",
    className: "SystemMessage",
    content: "Goal 已继续"
  })

  assertNotEqual(
    system,
    assistant,
    "system values messages should not share assistant fallback ids"
  )
}

function testMessagesAndValuesFallbackIdsAlignForAssistantAndTool(): void {
  const transport = new ElectronIPCTransport()
  const processStreamEvent = (
    transport as unknown as {
      processStreamEvent: (event: unknown) => Array<{ event: string; data: unknown }>
    }
  ).processStreamEvent.bind(transport)

  const assistantEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          content: "checking",
          tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
        }
      },
      { langgraph_node: "agent" }
    ]
  })
  const toolEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          content: "tool output",
          tool_call_id: "call-1",
          name: "read_file"
        }
      },
      { langgraph_node: "tools" }
    ]
  })

  const assistantMessage = assistantEvents.find((event) => event.event === "messages")?.data as
    | [{ id: string }]
    | undefined
  const toolMessage = toolEvents.find((event) => event.event === "messages")?.data as
    | [{ id: string }]
    | undefined
  const valuesMessages = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        content: "checking",
        tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
      }
    },
    {
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        content: "tool output",
        tool_call_id: "call-1",
        name: "read_file"
      }
    }
  ])

  assertEqual(
    assistantMessage?.[0]?.id,
    valuesMessages[0]?.id,
    "id-less assistant messages should use the same fallback id in messages and values mode"
  )
  assertEqual(
    toolMessage?.[0]?.id,
    valuesMessages[1]?.id,
    "id-less tool messages should use the same fallback id in messages and values mode"
  )
}

function testSyntheticCheckpointBaselineIncludesCoordinatorCurrentTurnIds(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const toolCalls = [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { content: "Inspect a.ts" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              content: "checking",
              tool_calls: toolCalls
            }
          },
          {
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: {
              content: "tool output",
              tool_call_id: "call-1",
              name: "read_file"
            }
          }
        ]
      }
    },
    "thread-1",
    "coordinator"
  )
  const emittedIds = events
    .filter((event) => event.event === "messages")
    .map((event) => (event.data as Array<{ id?: string }>)[0]?.id)
    .filter((id): id is string => !!id)

  const assistantBaselineIds = buildSyntheticCheckpointBaselineIds({
    index: 0,
    type: "ai",
    className: "AIMessage",
    content: "checking",
    toolCalls
  })
  const toolBaselineIds = buildSyntheticCheckpointBaselineIds({
    index: 0,
    type: "tool",
    className: "ToolMessage",
    content: "tool output",
    toolCallId: "call-1",
    name: "read_file"
  })

  assertEqual(emittedIds.length, 2, "coordinator values snapshot should emit AI and tool messages")
  assertEqual(
    assistantBaselineIds.includes(emittedIds[0]),
    true,
    "synthetic checkpoint baseline should include coordinator AI current-turn fallback id"
  )
  assertEqual(
    toolBaselineIds.includes(emittedIds[1]),
    true,
    "synthetic checkpoint baseline should include coordinator tool current-turn fallback id"
  )
}

function testCoordinatorCurrentTurnValuesUpdatesGrowingAssistantContent(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const emitValuesSnapshot = (content: string): Array<{ id?: string; content?: string }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "values",
        data: {
          messages: [
            {
              id: ["langchain_core", "messages", "HumanMessage"],
              kwargs: { content: "Inspect a.ts" }
            },
            {
              id: ["langchain_core", "messages", "AIMessage"],
              kwargs: { content }
            }
          ]
        }
      },
      "thread-1",
      "coordinator"
    )
      .filter((event) => event.event === "messages")
      .map((event) => (event.data as Array<{ id?: string; content?: string }>)[0])
      .filter((message): message is { id: string; content?: string } => !!message?.id)

  const firstMessages = emitValuesSnapshot("partial handoff")
  const secondMessages = emitValuesSnapshot("partial handoff with more detail")

  assertEqual(firstMessages.length, 1, "first coordinator values snapshot should emit assistant")
  assertEqual(
    secondMessages.length,
    1,
    "growing coordinator values snapshot should update assistant"
  )
  assertEqual(
    secondMessages[0]?.id,
    firstMessages[0]?.id,
    "growing id-less coordinator assistant values snapshots should reuse the same message id"
  )
  assertEqual(
    secondMessages[0]?.content,
    " with more detail",
    "growing coordinator values snapshot should only carry the appended assistant delta"
  )
}

function testNormalValuesSnapshotAliasesChangedProviderMessageId(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-ai-id", content: "final answer" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { content: "question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-ai-id", content: "final answer" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )

  const alias = events.find(
    (event) =>
      event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
  )?.data as { fromId?: string; toId?: string } | undefined
  assertEqual(alias?.fromId, "live-ai-id", "normal values should identify the live message id")
  assertEqual(alias?.toId, "final-ai-id", "normal values should adopt the final provider id")
}

function testNormalValuesSnapshotsCollapseRepeatedProviderIdChanges(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-ai-id", content: "final answer" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const valuesEvent = (id: string): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "values",
        data: {
          messages: [
            {
              id: ["langchain_core", "messages", "HumanMessage"],
              kwargs: { content: "question" }
            },
            {
              id: ["langchain_core", "messages", "AIMessage"],
              kwargs: { id, content: "final answer" }
            }
          ]
        }
      },
      "thread-1",
      "normal"
    )

  const firstEvents = valuesEvent("final-ai-id-1")
  const secondEvents = valuesEvent("final-ai-id-2")
  const thirdEvents = valuesEvent("final-ai-id-3")
  const aliases = [firstEvents, secondEvents, thirdEvents].map(
    (events) =>
      events.find(
        (event) =>
          event.event === "custom" &&
          (event.data as { type?: string }).type === "message_id_alias"
      )?.data as { fromId?: string; toId?: string } | undefined
  )

  assertEqual(aliases[0]?.fromId, "live-ai-id", "first snapshot should replace the live id")
  assertEqual(aliases[0]?.toId, "final-ai-id-1", "first snapshot should adopt its provider id")
  assertEqual(
    aliases[1]?.fromId,
    "final-ai-id-1",
    "second snapshot should migrate the already adopted id"
  )
  assertEqual(aliases[1]?.toId, "final-ai-id-2", "second snapshot should adopt its provider id")
  assertEqual(
    aliases[2]?.fromId,
    "final-ai-id-2",
    "third snapshot should continue the alias chain"
  )
  assertEqual(aliases[2]?.toId, "final-ai-id-3", "third snapshot should adopt its provider id")

  const finalValues = thirdEvents.find((event) => event.event === "values")?.data as
    | { messages?: Array<{ id?: string }> }
    | undefined
  assertEqual(
    finalValues?.messages?.at(-1)?.id,
    "final-ai-id-3",
    "the emitted values snapshot should use the latest canonical id"
  )

  const lateChunkEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-ai-id", content: "final answer!" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )
  const lateChunk = lateChunkEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined
  assertEqual(
    lateChunk?.[0]?.id,
    "final-ai-id-3",
    "late chunks using an old provider id should resolve to the latest canonical id"
  )
}

function testCurrentRunCompletedAliasSealsProviderOccurrenceAcrossDelayedChunk(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const providerId = "reused-provider-id"
  const completedOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)
  const stableCompletedId = "current-run-assistant:stable"

  const streamAssistant = (
    id: string,
    content: string,
    providerOccurrence?: number
  ): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id,
              content,
              ...(providerOccurrence
                ? {
                    additional_kwargs: {
                      cmb_internal_provider_source_id: providerId,
                      cmb_internal_provider_occurrence: providerOccurrence
                    }
                  }
                : {})
            }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  streamAssistant(providerId, "new")
  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "message_id_alias",
        fromId: completedOccurrenceId,
        toId: stableCompletedId,
        role: "assistant",
        currentRunCompleted: true,
        providerSourceId: providerId,
        providerOccurrence: 2
      }
    },
    "thread-1",
    "normal"
  )
  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        messages: [{ id: "guided-user", content: "guide" }]
      }
    },
    "thread-1",
    "normal"
  )

  const delayedEvents = streamAssistant(stableCompletedId, "new final", 2)
  const delayedMessage = delayedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertEqual(
    delayedMessage?.[0]?.id,
    stableCompletedId,
    "the delayed completed chunk should update the sealed stable slot"
  )
  assertEqual(
    delayedMessage?.[0]?.content,
    " final",
    "the delayed completed chunk should emit only the suffix of the sealed reply"
  )

  const guidedEvents = streamAssistant(providerId, "guided answer")
  const guidedMessage = guidedEvents.find((event) => event.event === "messages")?.data as
    | [
        {
          id?: string
          content?: string
          provider_source_id?: string
          provider_occurrence?: number
        }
      ]
    | undefined
  const guidedOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)
  assertEqual(
    guidedMessage?.[0]?.id,
    guidedOccurrenceId,
    "the guided reply should allocate a new provider occurrence after the sealed reply"
  )
  assertEqual(
    guidedMessage?.[0]?.content,
    "guided answer",
    "the guided reply should not reuse completed reply text state"
  )
  assertEqual(
    guidedMessage?.[0]?.provider_source_id,
    providerId,
    "the guided reply should expose its provider source"
  )
  assertEqual(
    guidedMessage?.[0]?.provider_occurrence,
    3,
    "the guided reply should expose occurrence three"
  )

  const valuesEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: providerId, content: "old" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: stableCompletedId,
              content: "new final",
              additional_kwargs: {
                cmb_internal_provider_source_id: providerId,
                cmb_internal_provider_occurrence: 2
              }
            }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: providerId, content: "guided answer" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )
  const values = valuesEvents.find((event) => event.event === "values")?.data as
    | {
        messages?: Array<{
          id: string
          type: string
          provider_source_id?: string
          provider_occurrence?: number
        }>
      }
    | undefined
  const assistants = values?.messages?.filter((message) => message.type === "ai") ?? []
  assertEqual(assistants.length, 3, "values replay should retain all three assistant replies")
  assertEqual(assistants[0]?.id, providerId, "the historical provider occurrence should stay first")
  assertEqual(
    getMessageProviderOccurrence(assistants[0] ?? { id: providerId, type: "ai" }) ?? 1,
    1,
    "the historical reply should remain provider occurrence one"
  )
  assertEqual(assistants[1]?.id, stableCompletedId, "the completed reply should keep its stable id")
  assertEqual(
    getMessageProviderSourceId(assistants[1]),
    providerId,
    "the stable reply should reload with the provider source"
  )
  assertEqual(
    getMessageProviderOccurrence(assistants[1]),
    2,
    "the stable reply should reload as provider occurrence two"
  )
  assertEqual(assistants[2]?.id, guidedOccurrenceId, "the guided reply should remain occurrence three")
  assertEqual(
    getMessageProviderOccurrence(assistants[2]),
    3,
    "the guided reply should reload as provider occurrence three"
  )
  const unexpectedAliases = valuesEvents.filter((event) => {
    if (event.event !== "custom") return false
    const data = event.data as { type?: string; fromId?: string; toId?: string }
    return (
      data.type === "message_id_alias" &&
      ((data.fromId === providerId && data.toId === stableCompletedId) ||
        (data.fromId === stableCompletedId && data.toId === completedOccurrenceId))
    )
  })
  assertEqual(
    unexpectedAliases.length,
    0,
    "values replay must not create a provider-wide alias into the completed slot"
  )
}

function testCurrentRunCompletedAliasReservesSlotBeforeFirstAssistantChunk(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const providerId = "reused-provider-id-before-first-chunk"
  const stableCompletedId = "current-run-assistant:stable-before-first-chunk"
  const completedOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)

  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "message_id_alias",
        fromId: completedOccurrenceId,
        toId: stableCompletedId,
        role: "assistant",
        currentRunCompleted: true,
        providerSourceId: providerId,
        providerOccurrence: 2
      }
    },
    "thread-1",
    "normal"
  )
  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        messages: [{ id: "guided-user-before-first-chunk", content: "guide" }]
      }
    },
    "thread-1",
    "normal"
  )
  const streamAssistant = (
    id: string,
    content: string,
    providerOccurrence?: number
  ): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id,
              content,
              ...(providerOccurrence
                ? {
                    additional_kwargs: {
                      cmb_internal_provider_source_id: providerId,
                      cmb_internal_provider_occurrence: providerOccurrence
                    }
                  }
                : {})
            }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  const delayedEvents = streamAssistant(stableCompletedId, "new final", 2)
  const delayedMessage = delayedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertEqual(
    delayedMessage?.[0]?.id,
    stableCompletedId,
    "a delayed first chunk should fill the reserved completed slot"
  )
  assertEqual(
    delayedMessage?.[0]?.content,
    "new final",
    "a delayed first chunk should retain its complete content"
  )

  const guidedEvents = streamAssistant(providerId, "guided answer")
  const guidedMessage = guidedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string; provider_occurrence?: number }]
    | undefined
  assertEqual(
    guidedMessage?.[0]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant", 3),
    "the guided reply should allocate occurrence three after a reserved completed slot"
  )
  assertEqual(
    guidedMessage?.[0]?.content,
    "guided answer",
    "the guided reply should not append into the delayed completed slot"
  )
  assertEqual(
    guidedMessage?.[0]?.provider_occurrence,
    3,
    "the guided reply should retain occurrence three after the no-chunk boundary"
  )
}

function testSparseValuesKeepsCurrentRunProviderOccurrences(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const providerId = "sparse-values-reused-provider"
  const stableCompletedId = "current-run-assistant:sparse-values-stable"
  const completedOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)
  const guidedOccurrenceId = buildMessageSameRoleDuplicateId(providerId, "assistant", 3)

  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "message_id_alias",
        fromId: completedOccurrenceId,
        toId: stableCompletedId,
        role: "assistant",
        currentRunCompleted: true,
        providerSourceId: providerId,
        providerOccurrence: 2
      }
    },
    "thread-sparse-values",
    "normal"
  )
  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        messages: [{ id: "guided-user-sparse-values", content: "guide" }]
      }
    },
    "thread-sparse-values",
    "normal"
  )
  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: providerId, content: "guided" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-sparse-values",
    "normal"
  )

  const valuesEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: stableCompletedId,
              content: "completed",
              additional_kwargs: {
                cmb_internal_provider_source_id: providerId,
                cmb_internal_provider_occurrence: 2
              }
            }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: guidedOccurrenceId,
              content: "guided",
              additional_kwargs: {
                cmb_internal_provider_source_id: providerId,
                cmb_internal_provider_occurrence: 3
              }
            }
          }
        ]
      }
    },
    "thread-sparse-values",
    "normal"
  )
  const values = valuesEvents.find((event) => event.event === "values")?.data as
    | { messages?: TransformedValuesMessage[] }
    | undefined
  const assistants = values?.messages?.filter((message) => message.type === "ai") ?? []
  assertEqual(assistants.length, 2, "the sparse snapshot must keep both assistant replies")
  assertEqual(assistants[0]?.id, stableCompletedId, "the completed reply must keep its stable id")
  assertEqual(
    assistants[0]?.provider_occurrence,
    2,
    "the completed reply must keep occurrence two"
  )
  assertEqual(assistants[1]?.id, guidedOccurrenceId, "the guided reply must keep occurrence three")
  assertEqual(
    assistants[1]?.provider_occurrence,
    3,
    "a sparse snapshot must not overwrite the guided provider occurrence"
  )

  const guidedOnlyEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: providerId, content: "rewritten guided" }
          }
        ]
      }
    },
    "thread-sparse-values",
    "normal"
  )
  const guidedOnlyValues = guidedOnlyEvents.find((event) => event.event === "values")?.data as
    | { messages?: TransformedValuesMessage[] }
    | undefined
  const guidedOnly = guidedOnlyValues?.messages?.filter((message) => message.type === "ai") ?? []
  assertEqual(guidedOnly.length, 1, "a compacted tail snapshot must keep its guided reply")
  assertNotEqual(
    guidedOnly[0]?.id,
    stableCompletedId,
    "a tuple-less rewritten tail must not alias into the completed slot"
  )
  assertEqual(
    guidedOnly[0]?.provider_occurrence,
    3,
    "a tuple-less compacted tail must retain the guided provider occurrence"
  )
}

function testCurrentRunCompletedAliasAcceptsStableSourceIdForKnownSlot(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const providerId = "stable-source-provider-id"
  const previousStableId = "provider-final-stable-id"
  const stableCompletedId = "current-run-assistant:stable-source"
  const streamAssistant = (
    id: string,
    content: string,
    providerOccurrence?: number
  ): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id,
              content,
              ...(providerOccurrence
                ? {
                    additional_kwargs: {
                      cmb_internal_provider_source_id: providerId,
                      cmb_internal_provider_occurrence: providerOccurrence
                    }
                  }
                : {})
            }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  streamAssistant(previousStableId, "new")
  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "message_id_alias",
        fromId: previousStableId,
        toId: stableCompletedId,
        role: "assistant",
        currentRunCompleted: true,
        providerSourceId: providerId,
        providerOccurrence: 2
      }
    },
    "thread-1",
    "normal"
  )
  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        messages: [{ id: "guided-user-stable-source", content: "guide" }]
      }
    },
    "thread-1",
    "normal"
  )
  const delayedEvents = streamAssistant(stableCompletedId, "new final", 2)
  const delayedMessage = delayedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertEqual(
    delayedMessage?.[0]?.content,
    " final",
    "a stable source alias should migrate existing assistant text state"
  )

  const guidedEvents = streamAssistant(providerId, "guided answer")
  const guidedMessage = guidedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertEqual(
    guidedMessage?.[0]?.id,
    buildMessageSameRoleDuplicateId(providerId, "assistant", 3),
    "a stable source alias should still reserve provider occurrence two"
  )
  assertEqual(
    guidedMessage?.[0]?.content,
    "guided answer",
    "a stable source alias should keep the guided reply independent"
  )
}

function testIdlessCurrentRunCompletionReservesStableSlot(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const stableCompletedId = "current-run-assistant:stable-no-provider"
  const streamAssistant = (
    id: string,
    content: string
  ): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { id, content }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        completedAssistantId: stableCompletedId,
        messages: [{ id: "guided-user-no-provider", content: "guide" }]
      }
    },
    "thread-1",
    "normal"
  )
  const delayedEvents = streamAssistant(stableCompletedId, "first final")
  const delayedMessage = delayedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertEqual(
    delayedMessage?.[0]?.id,
    stableCompletedId,
    "an id-less completion should fill its reserved stable slot"
  )

  const guidedEvents = streamAssistant("guided-provider-id", "guided answer")
  const guidedMessage = guidedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertEqual(
    guidedMessage?.[0]?.id,
    "guided-provider-id",
    "a guided reply should not reuse the reserved id-less completion slot"
  )
  assertEqual(
    guidedMessage?.[0]?.content,
    "guided answer",
    "a guided reply should not append to the id-less completed content"
  )
}

function testIdlessCurrentRunCompletionRekeysPreBoundaryPartial(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const streamIdless = (content: string): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { content }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-pre-boundary",
      "normal"
    )

  const partialEvents = streamIdless("first ")
  const partialMessage = partialEvents.find((event) => event.event === "messages")
    ?.data as [LiveStreamMessage] | undefined
  const fallbackId = partialMessage?.[0]?.id
  assertNotEqual(fallbackId, undefined, "the pre-boundary partial should have a fallback id")

  const stableId = "current-run-assistant:pre-boundary-stable"
  const boundaryEvents = convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        completedAssistantId: stableId,
        completedAssistantContent: "first final",
        completedAssistantProviderIdless: true,
        messages: [{ id: "guided-user-pre-boundary", content: "guide" }]
      }
    },
    "thread-pre-boundary",
    "normal"
  )
  const aliasData = boundaryEvents.find(
    (event) =>
      event.event === "custom" &&
      (event.data as { type?: string }).type === "message_id_alias"
  )?.data as
    | {
        fromId?: string
        toId?: string
        providerSourceId?: string
        providerOccurrence?: number
        rendererOnlyAlias?: boolean
      }
    | undefined
  assertEqual(
    aliasData?.fromId,
    fallbackId,
    "the boundary must expose the already-emitted fallback id as an alias source"
  )
  assertEqual(
    aliasData?.toId,
    stableId,
    "the boundary must expose the durable completed id as the alias target"
  )
  assertEqual(
    aliasData?.rendererOnlyAlias,
    true,
    "the renderer fallback alias must bypass durable id migration"
  )

  let liveMessages: LiveStreamMessage[] = []
  const appendMessage = (message: LiveStreamMessage): void => {
    liveMessages = mergeLiveStreamMessages(
      liveMessages,
      normalizeAppendedLiveStreamMessageIds(liveMessages, [message])
    )
  }
  if (partialMessage?.[0]) appendMessage(partialMessage[0])
  for (const event of boundaryEvents) {
    if (
      event.event === "custom" &&
      (event.data as { type?: string }).type === "message_id_alias"
    ) {
      const alias = event.data as {
        fromId: string
        toId: string
        providerSourceId?: string
        providerOccurrence?: number
      }
      liveMessages = replaceLiveStreamMessageId(
        liveMessages,
        alias.fromId,
        alias.toId,
        alias.providerSourceId,
        alias.providerOccurrence
      )
      continue
    }
    if (event.event === "messages" && Array.isArray(event.data) && event.data[0]) {
      appendMessage(event.data[0] as LiveStreamMessage)
    }
  }

  const assistants = liveMessages.filter((message) => message.type === "ai")
  assertEqual(
    assistants.length,
    1,
    "the live merge layer must not retain both fallback partial and stable completion"
  )
  assertEqual(assistants[0]?.id, stableId, "the sole completed bubble should use the durable id")
  assertEqual(
    assistants[0]?.content,
    "first final",
    "the stable completed bubble should replace the pre-boundary partial"
  )
}

function testFragmentedIdlessCurrentRunCompletionKeepsStableSlot(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)
  const stableCompletedId = "current-run-assistant:fragmented-idless"
  const streamIdlessAssistant = (
    content: string
  ): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { content }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  const injectionEvents = convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        completedAssistantId: stableCompletedId,
        completedAssistantContent: "first final",
        completedAssistantProviderIdless: true,
        messages: [{ id: "guided-user-fragmented-idless", content: "guide" }]
      }
    },
    "thread-1",
    "normal"
  )
  const syntheticCompleted = injectionEvents.find(
    (event) =>
      event.event === "messages" &&
      (event.data as [{ id?: string }])?.[0]?.id === stableCompletedId
  )?.data as [{ id?: string; content?: string }] | undefined
  assertEqual(
    syntheticCompleted?.[0]?.content,
    "first final",
    "an id-less completion must render durably before delayed transport chunks arrive"
  )

  const prefix = streamIdlessAssistant("first ").find(
    (event) => event.event === "messages"
  )?.data as [{ id?: string; content?: string }] | undefined
  const suffix = streamIdlessAssistant("final").find(
    (event) => event.event === "messages"
  )?.data as [{ id?: string; content?: string }] | undefined
  assertEqual(
    prefix,
    undefined,
    "an ambiguous id-less prefix must stay buffered until its identity is known"
  )
  assertEqual(
    suffix,
    undefined,
    "the final id-less delayed fragment must not duplicate the synthetic completed slot"
  )

  const guided = streamIdlessAssistant("guided answer").find(
    (event) => event.event === "messages"
  )?.data as [{ id?: string; content?: string }] | undefined
  assertNotEqual(
    guided?.[0]?.id,
    stableCompletedId,
    "the guided id-less reply must start a new logical slot"
  )
  assertEqual(
    guided?.[0]?.content,
    "guided answer",
    "the guided id-less reply must not append to the completed reply"
  )

  const ambiguousTransport = new ElectronIPCTransport()
  const convertAmbiguous = (
    ambiguousTransport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(ambiguousTransport)
  const ambiguousStableId = "current-run-assistant:ambiguous-idless"
  convertAmbiguous(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        completedAssistantId: ambiguousStableId,
        completedAssistantContent: "same target",
        completedAssistantProviderIdless: true,
        messages: [{ id: "guided-user-ambiguous-idless", content: "guide" }]
      }
    },
    "thread-2",
    "normal"
  )
  const ambiguousChunk = (content: string): Array<{ event: string; data: unknown }> =>
    convertAmbiguous(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { content }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-2",
      "normal"
    )
  assertEqual(
    ambiguousChunk("same ").find((event) => event.event === "messages"),
    undefined,
    "a guided reply sharing a completed prefix must not leak into the completed bubble"
  )
  const resolvedGuided = ambiguousChunk("different").find(
    (event) => event.event === "messages"
  )?.data as [{ id?: string; content?: string }] | undefined
  assertNotEqual(
    resolvedGuided?.[0]?.id,
    ambiguousStableId,
    "a mismatched buffered prefix must be released into a new guided slot"
  )
  assertEqual(
    resolvedGuided?.[0]?.content,
    "same different",
    "a mismatched buffered prefix must be preserved in the guided reply"
  )

  const stableReplayTransport = new ElectronIPCTransport()
  const convertStableReplay = (
    stableReplayTransport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(stableReplayTransport)
  const replayStableId = "current-run-assistant:idless-stable-replay"
  convertStableReplay(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        completedAssistantId: replayStableId,
        completedAssistantContent: "same target",
        completedAssistantProviderIdless: true,
        messages: [{ id: "guided-user-idless-stable-replay", content: "guide" }]
      }
    },
    "thread-3",
    "normal"
  )
  const stableReplayChunk = (
    content: string,
    id?: string
  ): Array<{ event: string; data: unknown }> =>
    convertStableReplay(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { ...(id ? { id } : {}), content }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-3",
      "normal"
    )
  assertEqual(
    stableReplayChunk("same target", replayStableId).find(
      (event) => event.event === "messages"
    ),
    undefined,
    "a stable delayed replay must be deduplicated after the synthetic completion"
  )
  const guidedAfterStableReplay = stableReplayChunk("same").find(
    (event) => event.event === "messages"
  )?.data as [{ id?: string; content?: string }] | undefined
  assertNotEqual(
    guidedAfterStableReplay?.[0]?.id,
    replayStableId,
    "a stable delayed replay must clear the id-less pending route before guided output"
  )
  assertEqual(
    guidedAfterStableReplay?.[0]?.content,
    "same",
    "a guided prefix after a stable delayed replay must remain visible"
  )

  const terminalTransport = new ElectronIPCTransport()
  const convertTerminal = (
    terminalTransport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(terminalTransport)
  const terminalStableId = "current-run-assistant:idless-terminal"
  convertTerminal(
    {
      type: "custom",
      data: {
        type: "current_run_user_injected",
        completedAssistantId: terminalStableId,
        completedAssistantContent: "same target",
        completedAssistantProviderIdless: true,
        messages: [{ id: "guided-user-idless-terminal", content: "guide" }]
      }
    },
    "thread-4",
    "normal"
  )
  assertEqual(
    convertTerminal(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { content: "same" }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-4",
      "normal"
    ).find((event) => event.event === "messages"),
    undefined,
    "an ambiguous terminal prefix must wait for the stream boundary"
  )
  const terminalGuided = convertTerminal(
    { type: "done" },
    "thread-4",
    "normal"
  ).find((event) => event.event === "messages")?.data as
    | [{ id?: string; content?: string }]
    | undefined
  assertNotEqual(
    terminalGuided?.[0]?.id,
    terminalStableId,
    "the stream boundary must flush a buffered guided prefix to a new slot"
  )
  assertEqual(
    terminalGuided?.[0]?.content,
    "same",
    "the stream boundary must not drop a buffered guided prefix"
  )
}

function testNormalValuesSnapshotAliasesFullyRewrittenAnswerByLogicalSlot(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "draft-ai-id", content: "A tentative streamed draft." }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { content: "question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: "rewritten-ai-id",
              content: "The provider replaced every word in the final answer."
            }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )

  const alias = events.find(
    (event) =>
      event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
  )?.data as { fromId?: string; toId?: string } | undefined
  assertEqual(alias?.fromId, "draft-ai-id", "the streamed logical slot should be migrated")
  assertEqual(
    alias?.toId,
    "rewritten-ai-id",
    "a full text rewrite should still retain the same logical message"
  )
}

function testNormalStreamingProviderIdChangesStayInOneLogicalSlot(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const emitChunk = (id: string, content: string): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { id, content }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  const firstEvents = emitChunk("chunk-ai-id-1", "hello")
  const secondEvents = emitChunk("chunk-ai-id-2", " world")
  const firstMessage = firstEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined
  const secondMessage = secondEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined

  assertEqual(firstMessage?.[0]?.id, "chunk-ai-id-1", "the first chunk should establish the slot id")
  assertEqual(
    secondMessage?.[0]?.id,
    "chunk-ai-id-1",
    "later chunks must reuse the slot when the current assistant has not called a tool"
  )
}

function testNormalStreamingProviderIdChangeAfterZeroArgumentToolCallStartsNewLogicalSlot(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const emitChunk = (
    id: string,
    content: string,
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  ): Array<{ event: string; data: unknown }> =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: { id, content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  const firstEvents = emitChunk("tool-call-ai-id", "", [
    { id: "call-1", name: "get_status", args: {} }
  ])
  const aliasEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: "canonical-tool-call-ai-id",
              content: "",
              tool_calls: [{ id: "call-1", name: "get_status", args: {} }]
            }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )
  const secondEvents = emitChunk("final-ai-id", "final answer")
  const firstMessage = firstEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined
  const secondMessage = secondEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined
  const alias = aliasEvents.find(
    (event) =>
      event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
  )?.data as { fromId?: string; toId?: string } | undefined

  assertEqual(firstMessage?.[0]?.id, "tool-call-ai-id", "the tool call should keep its provider id")
  assertEqual(alias?.fromId, "tool-call-ai-id", "the values snapshot should migrate the live id")
  assertEqual(
    alias?.toId,
    "canonical-tool-call-ai-id",
    "the values snapshot should establish the canonical tool-call id"
  )
  assertEqual(
    secondMessage?.[0]?.id,
    "final-ai-id",
    "a provider id after a tool call must start a new assistant slot before the result is observed"
  )

  const snapshotEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: "canonical-tool-call-ai-id",
              content: "",
              tool_calls: [{ id: "call-1", name: "get_status", args: {} }]
            }
          },
          {
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: {
              id: "tool-result-id",
              content: "file contents",
              tool_call_id: "call-1",
              name: "get_status"
            }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-ai-id", content: "final answer" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )
  const snapshot = snapshotEvents.find((event) => event.event === "values")?.data as
    | {
        messages?: Array<{
          id?: string
          content?: string
          content_priority?: number
        }>
      }
    | undefined
  assertEqual(
    snapshot?.messages?.[0]?.id,
    "canonical-tool-call-ai-id",
    "the snapshot must retain the tool-call slot"
  )
  assertEqual(snapshot?.messages?.[0]?.content, "", "the tool-call slot must remain empty")
  assertEqual(
    snapshot?.messages?.[2]?.id,
    "final-ai-id",
    "the snapshot must retain the final-answer slot"
  )
  assertEqual(
    snapshot?.messages?.[2]?.content,
    "final answer",
    "the final answer must stay separate"
  )
  assertEqual(
    snapshot?.messages?.[0]?.content_priority,
    1,
    "values content should be authoritative over speculative live content"
  )
}

function testNormalStreamingProviderIdChangesDuringSameToolCallStayInOneLogicalSlot(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const emitToolCall = (id: string, args: Record<string, unknown>) =>
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id,
              content: "",
              tool_calls: [{ id: "call-1", name: "read_file", args }]
            }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )

  emitToolCall("tool-call-ai-id-1", {})
  const continuedEvents = emitToolCall("tool-call-ai-id-2", { path: "a.ts" })
  const continuedMessage = continuedEvents.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined

  assertEqual(
    continuedMessage?.[0]?.id,
    "tool-call-ai-id-1",
    "provider id churn within the same tool call must not split the assistant message"
  )
}

function testNewToolCallWithIdlessContinuationStartsNewLogicalSlot(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            id: "tool-call-ai-id-1",
            content: "",
            tool_calls: [{ id: "call-1", name: "get_status", args: {} }]
          }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const nextEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            id: "tool-call-ai-id-2",
            content: "",
            tool_call_chunks: [
              { id: "call-2", name: "get_status", args: "", index: 0 },
              { args: "{}", index: 0 }
            ]
          }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )
  const toolCallEvent = nextEvents.find(
    (event) =>
      event.event === "custom" && (event.data as { type?: string }).type === "tool_call"
  )?.data as { messageId?: string } | undefined

  assertEqual(
    toolCallEvent?.messageId,
    "tool-call-ai-id-2",
    "an explicit new tool-call id must win over id-less continuation chunks in the same batch"
  )
}

function testNormalCorruptToolCallsDoNotBreakMessageBoundaryDetection(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  let events: Array<{ event: string; data: unknown }> = []
  try {
    events = convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [
          {
            id: ["langchain_core", "messages", "AIMessageChunk"],
            kwargs: {
              id: "corrupt-tool-calls-ai-id",
              content: "answer",
              tool_calls: { not: "an array" }
            }
          },
          { langgraph_node: "agent" }
        ]
      },
      "thread-1",
      "normal"
    )
  } catch (error) {
    throw new Error(`corrupt tool_calls must not break boundary detection: ${String(error)}`)
  }

  const message = events.find((event) => event.event === "messages")?.data as
    | [{ id?: string }]
    | undefined
  assertEqual(
    message?.[0]?.id,
    "corrupt-tool-calls-ai-id",
    "valid assistant content should survive corrupt tool-call metadata"
  )
}

function testNormalSparseEmptyValuesMessageIsNotContentAuthoritative(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "sparse-ai-id", content: "" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )
  const values = events.find((event) => event.event === "values")?.data as
    | { messages?: Array<{ content_priority?: number }> }
    | undefined

  assertEqual(
    values?.messages?.[0]?.content_priority,
    undefined,
    "an ordinary sparse empty values message must not clear useful streamed content"
  )
}

function testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundary(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const emitMessage = (message: unknown, node: string): void => {
    convertToSDKEvents(
      {
        type: "stream",
        mode: "messages",
        data: [message, { langgraph_node: node }]
      },
      "thread-1",
      "normal"
    )
  }

  emitMessage(
    {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: {
        id: "live-ai-before-tool",
        content: "calling a tool",
        tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
      }
    },
    "agent"
  )
  emitMessage(
    {
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        id: "live-tool-id",
        content: "file contents",
        tool_call_id: "call-1",
        name: "read_file"
      }
    },
    "tools"
  )
  emitMessage(
    {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: { id: "live-ai-after-tool", content: "final streamed answer" }
    },
    "agent"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { content: "question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: "final-ai-before-tool",
              content: "rewritten tool request",
              tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
            }
          },
          {
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: {
              id: "final-tool-id",
              content: "file contents",
              tool_call_id: "call-1",
              name: "read_file"
            }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-ai-after-tool", content: "rewritten final response" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )

  const aliases = events
    .filter(
      (event) =>
        event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
    )
    .map((event) => event.data as { fromId?: string; toId?: string })
  assertEqual(aliases.length, 2, "both assistant slots should be reconciled independently")
  assertEqual(
    aliases[0]?.fromId,
    "live-ai-before-tool",
    "the pre-tool answer should keep its own logical slot"
  )
  assertEqual(aliases[0]?.toId, "final-ai-before-tool", "the pre-tool slot should adopt its id")
  assertEqual(
    aliases[1]?.fromId,
    "live-ai-after-tool",
    "the post-tool answer should keep a separate logical slot"
  )
  assertEqual(aliases[1]?.toId, "final-ai-after-tool", "the post-tool slot should adopt its id")
}

function testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundaryAfterHistory(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            id: "live-tool-call-ai-id",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "execute",
                args: { command: "git status --short" }
              }
            ]
          }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "ToolMessage"],
          kwargs: {
            id: "tool-result-id",
            content: " M src/renderer/src/App.tsx",
            tool_call_id: "call-1",
            name: "execute"
          }
        },
        { langgraph_node: "tools" }
      ]
    },
    "thread-1",
    "normal"
  )

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-final-ai-id", content: "DUP_TEST_A_20260711 only once" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "history-ai-id", content: "hello history" }
          },
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { id: "current-user-id", content: "current question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              id: "final-tool-call-ai-id",
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  name: "execute",
                  args: { command: "git status --short" }
                }
              ]
            }
          },
          {
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: {
              id: "tool-result-id",
              content: " M src/renderer/src/App.tsx",
              tool_call_id: "call-1",
              name: "execute"
            }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-answer-ai-id", content: "DUP_TEST_A_20260711 only once" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )

  const aliases = events
    .filter(
      (event) =>
        event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
    )
    .map((event) => event.data as { fromId?: string; toId?: string })

  assertEqual(aliases.length, 2, "current turn assistant slots should both reconcile")
  assertEqual(
    aliases[0]?.fromId,
    "live-tool-call-ai-id",
    "the tool-call slot should keep its own live id"
  )
  assertEqual(
    aliases[0]?.toId,
    "final-tool-call-ai-id",
    "the tool-call slot should adopt the checkpoint id"
  )
  assertEqual(
    aliases[1]?.fromId,
    "live-final-ai-id",
    "the final-answer slot should keep its own live id"
  )
  assertEqual(
    aliases[1]?.toId,
    "final-answer-ai-id",
    "the final-answer slot should adopt the checkpoint id"
  )
}

function testNormalValuesSnapshotMissingToolCallAssistantDoesNotStealToolSlot(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: {
            id: "live-tool-call-ai-id",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "execute",
                args: { command: "git status --short" }
              }
            ]
          }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "ToolMessage"],
          kwargs: {
            id: "tool-result-id",
            content: " M src/renderer/src/App.tsx",
            tool_call_id: "call-1",
            name: "execute"
          }
        },
        { langgraph_node: "tools" }
      ]
    },
    "thread-1",
    "normal"
  )

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-final-ai-id", content: "DUP_TEST_A_20260711 only once" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "history-ai-id", content: "hello history" }
          },
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { id: "current-user-id", content: "current question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-answer-ai-id", content: "DUP_TEST_A_20260711 only once" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )

  const aliases = events
    .filter(
      (event) =>
        event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
    )
    .map((event) => event.data as { fromId?: string; toId?: string })

  assertEqual(
    aliases.some(
      (alias) =>
        alias.fromId === "live-tool-call-ai-id" && alias.toId === "final-answer-ai-id"
    ),
    false,
    "a text-only final snapshot must not alias the earlier tool-call assistant slot"
  )
}

function testNormalValuesSnapshotDoesNotAliasToLaterAssistantThatQuotesLiveText(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-ai-id", content: "final answer" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { content: "question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-ai-id", content: "final answer" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "later-ai-id", content: "Quoting: final answer. New response." }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )

  const alias = events.find(
    (event) =>
      event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
  )?.data as { fromId?: string; toId?: string } | undefined
  assertEqual(alias?.toId, "final-ai-id", "quoted live text should not steal the message alias")
}

function testGoalSubturnCompleteResetsAssistantFallbackId(): void {
  const transport = new ElectronIPCTransport()
  const processStreamEvent = (
    transport as unknown as {
      processStreamEvent: (event: unknown) => Array<{ event: string; data: unknown }>
    }
  ).processStreamEvent.bind(transport)
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  const firstAssistantEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { content: "first subturn" }
      },
      { langgraph_node: "agent" }
    ]
  })
  convertToSDKEvents(
    { type: "custom", data: { type: "goal_subturn_complete", messages: [] } },
    "thread-1"
  )
  const secondAssistantEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { content: "second subturn" }
      },
      { langgraph_node: "agent" }
    ]
  })

  const firstAssistantMessage = firstAssistantEvents.find((event) => event.event === "messages")
    ?.data as [{ id: string }] | undefined
  const secondAssistantMessage = secondAssistantEvents.find((event) => event.event === "messages")
    ?.data as [{ id: string }] | undefined

  assertNotEqual(
    firstAssistantMessage?.[0]?.id,
    secondAssistantMessage?.[0]?.id,
    "goal subturn boundaries should prevent id-less assistant chunks from reusing the previous subturn id"
  )
}

function testTransformSerializedValuesMessagesForSubturnFlush(): void {
  const transformed = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "HumanMessage"],
      kwargs: { id: "user-1", content: "ignored local user bubble" }
    },
    {
      id: ["langchain_core", "messages", "HumanMessage"],
      kwargs: {
        id: "internal-goal-1",
        content:
          "[Continuing active goal]\n\n<untrusted_objective>\n检查实现\n</untrusted_objective>"
      }
    },
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        content: "checking",
        tool_calls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
      }
    },
    {
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        content: "tool output",
        tool_call_id: "call-1",
        name: "read_file"
      }
    },
    {
      id: ["langchain_core", "messages", "SystemMessage"],
      kwargs: { content: "Goal 已继续" }
    }
  ])

  assertEqual(
    transformed.length,
    4,
    "subturn flush messages should filter normal human messages but keep internal goal prompts"
  )
  assertEqual(transformed[0].type, "human", "internal goal prompts should stay human")
  assertEqual(
    transformed[0].id,
    "internal-goal-1",
    "internal goal prompts should preserve provider ids for internal timing"
  )
  assertEqual(transformed[1].type, "ai", "assistant values messages should map to ai")
  assertEqual(
    transformed[1].tool_calls?.[0]?.id,
    "call-1",
    "assistant values messages should preserve tool calls"
  )
  assertEqual(transformed[2].type, "tool", "tool values messages should map to tool")
  assertEqual(
    transformed[2].tool_call_id,
    "call-1",
    "tool values messages should preserve tool_call_id"
  )
  assertEqual(transformed[3].type, "system", "system values messages should map to system")
}

function testLateInsertedToolDoesNotChangeLaterAssistantFallbackId(): void {
  const firstSnapshot = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        content: "calling tool",
        tool_calls: [{ id: "call-1", name: "execute", args: { command: "echo hi" } }]
      }
    },
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content: "done" }
    }
  ])

  const completeSnapshot = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        content: "calling tool",
        tool_calls: [{ id: "call-1", name: "execute", args: { command: "echo hi" } }]
      }
    },
    {
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        content: "tool output",
        tool_call_id: "call-1",
        name: "execute"
      }
    },
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content: "done" }
    }
  ])

  assertEqual(
    firstSnapshot[1]?.id,
    completeSnapshot[2]?.id,
    "late-inserted tool messages should not shift id-less assistant fallback ids"
  )
}

function testMessagesFallbackIdsContinueAfterExistingThreadMessages(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const processStreamEvent = (
    transport as unknown as {
      processStreamEvent: (event: unknown) => Array<{ event: string; data: unknown }>
    }
  ).processStreamEvent.bind(transport)

  const liveAssistantEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { content: "second turn" }
      },
      { langgraph_node: "agent" }
    ]
  })
  const liveAssistantMessage = liveAssistantEvents.find((event) => event.event === "messages")
    ?.data as [{ id: string }] | undefined
  const valuesMessages = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content: "first turn" }
    },
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { content: "second turn" }
    }
  ])

  assertEqual(
    liveAssistantMessage?.[0]?.id,
    valuesMessages[1]?.id,
    "id-less live messages should continue after existing thread messages"
  )
}

function testNormalValuesLogicalSlotAlignsAfterExistingHistory(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 1, tool: 0, system: 0, human: 0 })
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string,
        agentMode?: "normal" | "coordinator" | "workflow"
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "live-current-id", content: "current streamed answer" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1",
    "normal"
  )

  const events = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "history-ai-id", content: "an older answer" }
          },
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { id: "current-user-id", content: "current question" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "final-current-id", content: "completely rewritten current answer" }
          }
        ]
      }
    },
    "thread-1",
    "normal"
  )
  const aliases = events
    .filter(
      (event) =>
        event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
    )
    .map((event) => event.data as { fromId?: string; toId?: string })

  assertEqual(aliases.length, 1, "history slots should not be mistaken for the current answer")
  assertEqual(aliases[0]?.fromId, "live-current-id", "the current streamed slot should be selected")
  assertEqual(aliases[0]?.toId, "final-current-id", "the matching current snapshot should be adopted")
}

function testSystemFallbackIdsContinueAfterHiddenCheckpointArtifacts(): void {
  const transport = new ElectronIPCTransport()
  transport.setFallbackIndexBaselines({ ai: 0, tool: 0, system: 1, human: 0 })
  const processStreamEvent = (
    transport as unknown as {
      processStreamEvent: (event: unknown) => Array<{ event: string; data: unknown }>
    }
  ).processStreamEvent.bind(transport)

  const liveSystemEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "SystemMessage"],
        kwargs: { content: "System notice after hidden goal artifact" }
      },
      { langgraph_node: "agent" }
    ]
  })
  const liveSystemMessage = liveSystemEvents.find((event) => event.event === "messages")?.data as
    | [{ id: string }]
    | undefined
  const valuesMessages = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "SystemMessage"],
      kwargs: { content: "Goal 已继续" }
    },
    {
      id: ["langchain_core", "messages", "SystemMessage"],
      kwargs: { content: "System notice after hidden goal artifact" }
    }
  ])

  assertEqual(
    liveSystemMessage?.[0]?.id,
    valuesMessages[1]?.id,
    "id-less system messages should continue after hidden checkpoint system artifacts"
  )
}

function testGoalSubturnCompleteAdvancesSystemFallbackIndex(): void {
  const transport = new ElectronIPCTransport()
  const processStreamEvent = (
    transport as unknown as {
      processStreamEvent: (event: unknown) => Array<{ event: string; data: unknown }>
    }
  ).processStreamEvent.bind(transport)
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "goal_subturn_complete",
        messages: [
          {
            id: ["langchain_core", "messages", "SystemMessage"],
            kwargs: { content: "Goal 已继续" }
          }
        ]
      }
    },
    "thread-1"
  )

  const liveSystemEvents = processStreamEvent({
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "SystemMessage"],
        kwargs: { content: "Visible system notice after goal subturn" }
      },
      { langgraph_node: "agent" }
    ]
  })
  const liveSystemMessage = liveSystemEvents.find((event) => event.event === "messages")?.data as
    | [{ id: string }]
    | undefined
  const valuesMessages = transformSerializedValuesMessages([
    {
      id: ["langchain_core", "messages", "SystemMessage"],
      kwargs: { content: "Goal 已继续" }
    },
    {
      id: ["langchain_core", "messages", "SystemMessage"],
      kwargs: { content: "Visible system notice after goal subturn" }
    }
  ])

  assertEqual(
    liveSystemMessage?.[0]?.id,
    valuesMessages[1]?.id,
    "goal subturn snapshots should advance system fallback ids for later live system messages"
  )
}

function testStreamRetryResetRestoresStableValuesAndClearsPartialDeltaState(): void {
  const transport = new ElectronIPCTransport()
  const convertToSDKEvents = (
    transport as unknown as {
      convertToSDKEvents: (
        event: unknown,
        threadId: string
      ) => Array<{ event: string; data: unknown }>
    }
  ).convertToSDKEvents.bind(transport)

  convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "retry-ai", content: "partial" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1"
  )

  const resetEvents = convertToSDKEvents(
    {
      type: "custom",
      data: {
        type: "stream_retry_reset",
        discardedMessageIds: ["retry-ai"],
        messages: [
          {
            id: ["langchain_core", "messages", "SystemMessage"],
            kwargs: { id: "stable-system", content: "stable checkpoint" }
          }
        ]
      }
    },
    "thread-1"
  )
  const resetValues = resetEvents.find((event) => event.event === "values")?.data as
    | { messages?: Array<{ id?: string }> }
    | undefined
  assertEqual(
    resetValues?.messages?.[0]?.id,
    "stable-system",
    "retry reset should restore stable values"
  )

  const retryEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "messages",
      data: [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "retry-ai-2", content: "complete" }
        },
        { langgraph_node: "agent" }
      ]
    },
    "thread-1"
  )
  const retryMessage = retryEvents.find((event) => event.event === "messages")?.data as
    | [{ content?: string }]
    | undefined
  assertEqual(
    retryMessage?.[0]?.content,
    "complete",
    "retry should not subtract or append the discarded partial content"
  )

  const finalEvents = convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: {
        messages: [
          {
            id: ["langchain_core", "messages", "SystemMessage"],
            kwargs: { id: "stable-system", content: "stable checkpoint" }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "retry-ai-final", content: "complete" }
          }
        ]
      }
    },
    "thread-1"
  )
  const alias = finalEvents.find(
    (event) =>
      event.event === "custom" && (event.data as { type?: string }).type === "message_id_alias"
  )?.data as { fromId?: string; toId?: string } | undefined
  assertEqual(alias?.fromId, "retry-ai-2", "retry should reuse the discarded logical slot")
  assertEqual(alias?.toId, "retry-ai-final", "retry values should adopt the checkpoint id")
}

const tests: Array<[string, () => void]> = [
  ["testExplicitIdWins", testExplicitIdWins],
  [
    "testSummarizationMessagesUseStructuralFiltering",
    testSummarizationMessagesUseStructuralFiltering
  ],
  ["testFallbackIdIsStableForSameValuesMessage", testFallbackIdIsStableForSameValuesMessage],
  ["testFallbackIdIgnoresGrowingContent", testFallbackIdIgnoresGrowingContent],
  [
    "testFallbackIdChangesWhenStructuralIdentityChanges",
    testFallbackIdChangesWhenStructuralIdentityChanges
  ],
  ["testSystemFallbackIdIsDistinctFromAssistant", testSystemFallbackIdIsDistinctFromAssistant],
  [
    "testMessagesAndValuesFallbackIdsAlignForAssistantAndTool",
    testMessagesAndValuesFallbackIdsAlignForAssistantAndTool
  ],
  [
    "testSyntheticCheckpointBaselineIncludesCoordinatorCurrentTurnIds",
    testSyntheticCheckpointBaselineIncludesCoordinatorCurrentTurnIds
  ],
  [
    "testCoordinatorCurrentTurnValuesUpdatesGrowingAssistantContent",
    testCoordinatorCurrentTurnValuesUpdatesGrowingAssistantContent
  ],
  [
    "testNormalValuesSnapshotAliasesChangedProviderMessageId",
    testNormalValuesSnapshotAliasesChangedProviderMessageId
  ],
  [
    "testNormalValuesSnapshotsCollapseRepeatedProviderIdChanges",
    testNormalValuesSnapshotsCollapseRepeatedProviderIdChanges
  ],
  [
    "testCurrentRunCompletedAliasSealsProviderOccurrenceAcrossDelayedChunk",
    testCurrentRunCompletedAliasSealsProviderOccurrenceAcrossDelayedChunk
  ],
  [
    "testCurrentRunCompletedAliasReservesSlotBeforeFirstAssistantChunk",
    testCurrentRunCompletedAliasReservesSlotBeforeFirstAssistantChunk
  ],
  [
    "testSparseValuesKeepsCurrentRunProviderOccurrences",
    testSparseValuesKeepsCurrentRunProviderOccurrences
  ],
  [
    "testCurrentRunCompletedAliasAcceptsStableSourceIdForKnownSlot",
    testCurrentRunCompletedAliasAcceptsStableSourceIdForKnownSlot
  ],
  [
    "testIdlessCurrentRunCompletionReservesStableSlot",
    testIdlessCurrentRunCompletionReservesStableSlot
  ],
  [
    "testIdlessCurrentRunCompletionRekeysPreBoundaryPartial",
    testIdlessCurrentRunCompletionRekeysPreBoundaryPartial
  ],
  [
    "testFragmentedIdlessCurrentRunCompletionKeepsStableSlot",
    testFragmentedIdlessCurrentRunCompletionKeepsStableSlot
  ],
  [
    "testNormalValuesSnapshotAliasesFullyRewrittenAnswerByLogicalSlot",
    testNormalValuesSnapshotAliasesFullyRewrittenAnswerByLogicalSlot
  ],
  [
    "testNormalStreamingProviderIdChangesStayInOneLogicalSlot",
    testNormalStreamingProviderIdChangesStayInOneLogicalSlot
  ],
  [
    "testNormalStreamingProviderIdChangeAfterZeroArgumentToolCallStartsNewLogicalSlot",
    testNormalStreamingProviderIdChangeAfterZeroArgumentToolCallStartsNewLogicalSlot
  ],
  [
    "testNormalStreamingProviderIdChangesDuringSameToolCallStayInOneLogicalSlot",
    testNormalStreamingProviderIdChangesDuringSameToolCallStayInOneLogicalSlot
  ],
  [
    "testNewToolCallWithIdlessContinuationStartsNewLogicalSlot",
    testNewToolCallWithIdlessContinuationStartsNewLogicalSlot
  ],
  [
    "testNormalCorruptToolCallsDoNotBreakMessageBoundaryDetection",
    testNormalCorruptToolCallsDoNotBreakMessageBoundaryDetection
  ],
  [
    "testNormalSparseEmptyValuesMessageIsNotContentAuthoritative",
    testNormalSparseEmptyValuesMessageIsNotContentAuthoritative
  ],
  [
    "testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundary",
    testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundary
  ],
  [
    "testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundaryAfterHistory",
    testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundaryAfterHistory
  ],
  [
    "testNormalValuesSnapshotMissingToolCallAssistantDoesNotStealToolSlot",
    testNormalValuesSnapshotMissingToolCallAssistantDoesNotStealToolSlot
  ],
  [
    "testNormalValuesSnapshotDoesNotAliasToLaterAssistantThatQuotesLiveText",
    testNormalValuesSnapshotDoesNotAliasToLaterAssistantThatQuotesLiveText
  ],
  [
    "testGoalSubturnCompleteResetsAssistantFallbackId",
    testGoalSubturnCompleteResetsAssistantFallbackId
  ],
  [
    "testTransformSerializedValuesMessagesForSubturnFlush",
    testTransformSerializedValuesMessagesForSubturnFlush
  ],
  [
    "testLateInsertedToolDoesNotChangeLaterAssistantFallbackId",
    testLateInsertedToolDoesNotChangeLaterAssistantFallbackId
  ],
  [
    "testMessagesFallbackIdsContinueAfterExistingThreadMessages",
    testMessagesFallbackIdsContinueAfterExistingThreadMessages
  ],
  [
    "testNormalValuesLogicalSlotAlignsAfterExistingHistory",
    testNormalValuesLogicalSlotAlignsAfterExistingHistory
  ],
  [
    "testSystemFallbackIdsContinueAfterHiddenCheckpointArtifacts",
    testSystemFallbackIdsContinueAfterHiddenCheckpointArtifacts
  ],
  [
    "testGoalSubturnCompleteAdvancesSystemFallbackIndex",
    testGoalSubturnCompleteAdvancesSystemFallbackIndex
  ],
  [
    "testStreamRetryResetRestoresStableValuesAndClearsPartialDeltaState",
    testStreamRetryResetRestoresStableValuesAndClearsPartialDeltaState
  ]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
