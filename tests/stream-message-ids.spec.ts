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
  transformSerializedValuesMessages
} from "../src/renderer/src/lib/electron-transport.ts"

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
    "later chunks must reuse the slot even when their provider id changes"
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

const tests: Array<[string, () => void]> = [
  ["testExplicitIdWins", testExplicitIdWins],
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
    "testNormalValuesSnapshotAliasesFullyRewrittenAnswerByLogicalSlot",
    testNormalValuesSnapshotAliasesFullyRewrittenAnswerByLogicalSlot
  ],
  [
    "testNormalStreamingProviderIdChangesStayInOneLogicalSlot",
    testNormalStreamingProviderIdChangesStayInOneLogicalSlot
  ],
  [
    "testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundary",
    testNormalValuesLogicalSlotsDoNotMergeAcrossToolBoundary
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
  ]
]

for (const [name, fn] of tests) {
  fn()
  console.log(`✓ ${name}`)
}
