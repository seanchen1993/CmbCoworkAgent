/**
 * Run:
 *   npx tsx tests/chatx-stream-message-ids.spec.ts
 */

import {
  getChatXAssistantMessageId,
  getChatXToolCallId,
  getChatXUserMessageId,
  namespaceChatXStreamEventIds
} from "../src/main/services/chatx-stream-ids.ts"
import type { SchedulerEvent } from "../src/main/agent/stream-converter.ts"
import {
  buildFilteredThreadValues,
  deriveCheckpointTranscriptIndex
} from "../src/shared/checkpoint-transcript.ts"

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

function getFirstToolCallId(toolCalls: unknown[] | undefined): string | undefined {
  return getFirstToolCallField(toolCalls, "id")
}

function getFirstToolCallToolCallId(toolCalls: unknown[] | undefined): string | undefined {
  return getFirstToolCallField(toolCalls, "tool_call_id")
}

function getFirstToolCallField(
  toolCalls: unknown[] | undefined,
  field: "id" | "tool_call_id"
): string | undefined {
  const toolCall = toolCalls?.[0]
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return undefined
  const value = (toolCall as Record<string, unknown>)[field]
  return typeof value === "string" ? value : undefined
}

function getFirstSubagentField(
  event: SchedulerEvent,
  field: "id" | "toolCallId"
): string | undefined {
  if (event.type !== "custom") throw new Error("expected custom event")
  const subagents = event.data.subagents
  if (!Array.isArray(subagents)) return undefined
  const subagent = subagents[0]
  if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) return undefined
  const value = (subagent as Record<string, unknown>)[field]
  return typeof value === "string" ? value : undefined
}

function testRepeatedProviderAssistantIdsAreScopedByChatXTurn(): void {
  const rawAssistantId = "provider-reused-id"
  const first = namespaceChatXStreamEventIds(
    { type: "message-delta", id: rawAssistantId, content: "first reply" },
    "msg-1"
  )
  const second = namespaceChatXStreamEventIds(
    { type: "message-delta", id: rawAssistantId, content: "second reply" },
    "msg-2"
  )

  if (first.type !== "message-delta" || second.type !== "message-delta") {
    throw new Error("expected message-delta events")
  }

  assertEqual(
    first.id,
    getChatXAssistantMessageId("msg-1", rawAssistantId),
    "first assistant id should include the first ChatX turn"
  )
  assertEqual(
    second.id,
    getChatXAssistantMessageId("msg-2", rawAssistantId),
    "second assistant id should include the second ChatX turn"
  )
  assertNotEqual(first.id, second.id, "assistant ids from different ChatX turns must differ")
}

function testRepeatedProviderToolCallIdsAreScopedByChatXTurn(): void {
  const rawToolCallId = "call_reused"
  const first = namespaceChatXStreamEventIds(
    {
      type: "message-delta",
      id: "provider-assistant",
      content: "",
      toolCalls: [{ id: rawToolCallId, tool_call_id: rawToolCallId, name: "read_file", args: {} }]
    },
    "msg-1"
  )
  const second = namespaceChatXStreamEventIds(
    {
      type: "message-delta",
      id: "provider-assistant",
      content: "",
      toolCalls: [{ id: rawToolCallId, tool_call_id: rawToolCallId, name: "read_file", args: {} }]
    },
    "msg-2"
  )

  if (first.type !== "message-delta" || second.type !== "message-delta") {
    throw new Error("expected message-delta events")
  }

  const scopedFirstToolCallId = getFirstToolCallId(first.toolCalls)
  const scopedSecondToolCallId = getFirstToolCallId(second.toolCalls)
  const scopedFirstToolCallField = getFirstToolCallToolCallId(first.toolCalls)
  const scopedSecondToolCallField = getFirstToolCallToolCallId(second.toolCalls)

  assertEqual(
    scopedFirstToolCallId,
    getChatXToolCallId("msg-1", rawToolCallId),
    "first tool call id should include the first ChatX turn"
  )
  assertEqual(
    scopedSecondToolCallId,
    getChatXToolCallId("msg-2", rawToolCallId),
    "second tool call id should include the second ChatX turn"
  )
  assertEqual(
    scopedFirstToolCallField,
    scopedFirstToolCallId,
    "first tool_calls tool_call_id should match the namespaced id"
  )
  assertEqual(
    scopedSecondToolCallField,
    scopedSecondToolCallId,
    "second tool_calls tool_call_id should match the namespaced id"
  )
  assertNotEqual(
    scopedFirstToolCallId,
    scopedSecondToolCallId,
    "tool call ids from different ChatX turns must differ"
  )
}

function testToolMessageUsesMatchingToolCallScope(): void {
  const rawToolCallId = "call_1"
  const assistant = namespaceChatXStreamEventIds(
    {
      type: "message-delta",
      id: "provider-assistant",
      content: "",
      toolCalls: [{ id: rawToolCallId, tool_call_id: rawToolCallId, name: "read_file", args: {} }]
    },
    "msg-1"
  )
  const tool = namespaceChatXStreamEventIds(
    {
      type: "tool-message",
      id: "tool-call_1",
      content: "ok",
      toolCallId: rawToolCallId,
      name: "read_file"
    },
    "msg-1"
  )

  if (assistant.type !== "message-delta" || tool.type !== "tool-message") {
    throw new Error("expected message-delta and tool-message events")
  }

  assertEqual(
    tool.toolCallId,
    getFirstToolCallId(assistant.toolCalls),
    "tool-message toolCallId should match assistant tool_calls id"
  )
}

function testFullMessagesUseNearestChatXUserTurn(): void {
  const rawAssistantId = "provider-reused-id"
  const event: SchedulerEvent = {
    type: "full-messages",
    messages: [
      {
        id: getChatXUserMessageId("msg-1"),
        role: "user",
        content: "你好"
      },
      {
        id: rawAssistantId,
        role: "assistant",
        content: "first reply"
      },
      {
        id: getChatXUserMessageId("msg-2"),
        role: "user",
        content: "你好"
      },
      {
        id: rawAssistantId,
        role: "assistant",
        content: "second reply"
      }
    ]
  }

  const namespaced = namespaceChatXStreamEventIds(event, "msg-2")
  if (namespaced.type !== "full-messages") throw new Error("expected full-messages event")

  assertEqual(
    namespaced.messages[1]?.id,
    getChatXAssistantMessageId("msg-1", rawAssistantId),
    "first full snapshot assistant id should use first user turn"
  )
  assertEqual(
    namespaced.messages[3]?.id,
    getChatXAssistantMessageId("msg-2", rawAssistantId),
    "second full snapshot assistant id should use second user turn"
  )
  assertNotEqual(
    namespaced.messages[1]?.id,
    namespaced.messages[3]?.id,
    "full snapshot assistant ids should not collide"
  )
}

function testFullMessagesScopeToolCallPairsByTurn(): void {
  const rawToolCallId = "call_reused"
  const event: SchedulerEvent = {
    type: "full-messages",
    messages: [
      {
        id: getChatXUserMessageId("msg-1"),
        role: "user",
        content: "你好"
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        tool_calls: [
          { id: rawToolCallId, tool_call_id: rawToolCallId, name: "read_file", args: {} }
        ]
      },
      {
        id: "tool-1",
        role: "tool",
        content: "first result",
        tool_call_id: rawToolCallId
      },
      {
        id: getChatXUserMessageId("msg-2"),
        role: "user",
        content: "你好"
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "",
        tool_calls: [
          { id: rawToolCallId, tool_call_id: rawToolCallId, name: "read_file", args: {} }
        ]
      },
      {
        id: "tool-2",
        role: "tool",
        content: "second result",
        tool_call_id: rawToolCallId
      }
    ]
  }

  const namespaced = namespaceChatXStreamEventIds(event, "msg-2")
  if (namespaced.type !== "full-messages") throw new Error("expected full-messages event")

  const firstAssistantToolCallId = getFirstToolCallId(namespaced.messages[1]?.tool_calls)
  const firstAssistantToolCallField = getFirstToolCallToolCallId(namespaced.messages[1]?.tool_calls)
  const firstToolCallId = namespaced.messages[2]?.tool_call_id
  const secondAssistantToolCallId = getFirstToolCallId(namespaced.messages[4]?.tool_calls)
  const secondAssistantToolCallField = getFirstToolCallToolCallId(
    namespaced.messages[4]?.tool_calls
  )
  const secondToolCallId = namespaced.messages[5]?.tool_call_id

  assertEqual(
    firstAssistantToolCallId,
    getChatXToolCallId("msg-1", rawToolCallId),
    "first full snapshot assistant tool call id should use first user turn"
  )
  assertEqual(
    firstToolCallId,
    firstAssistantToolCallId,
    "first full snapshot tool message should point to assistant tool call"
  )
  assertEqual(
    firstAssistantToolCallField,
    firstAssistantToolCallId,
    "first full snapshot assistant tool_call_id should match tool call id"
  )
  assertEqual(
    secondAssistantToolCallId,
    getChatXToolCallId("msg-2", rawToolCallId),
    "second full snapshot assistant tool call id should use second user turn"
  )
  assertEqual(
    secondToolCallId,
    secondAssistantToolCallId,
    "second full snapshot tool message should point to assistant tool call"
  )
  assertEqual(
    secondAssistantToolCallField,
    secondAssistantToolCallId,
    "second full snapshot assistant tool_call_id should match tool call id"
  )
  assertNotEqual(
    firstToolCallId,
    secondToolCallId,
    "full snapshot tool call ids should not collide across ChatX turns"
  )
}

function testFullMessagesPlainUserClearsActiveChatXTurn(): void {
  const event: SchedulerEvent = {
    type: "full-messages",
    messages: [
      {
        id: getChatXUserMessageId("msg-1"),
        role: "user",
        content: "你好"
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "first reply"
      },
      {
        id: "manual-user",
        role: "user",
        content: "manual"
      },
      {
        id: "manual-assistant",
        role: "assistant",
        content: "manual reply",
        tool_calls: [
          { id: "manual-call", tool_call_id: "manual-call", name: "read_file", args: {} }
        ]
      }
    ]
  }

  const namespaced = namespaceChatXStreamEventIds(event, "msg-1")
  if (namespaced.type !== "full-messages") throw new Error("expected full-messages event")

  assertEqual(
    namespaced.messages[3]?.id,
    "manual-assistant",
    "plain user should clear the active ChatX turn for following assistant messages"
  )
  assertEqual(
    getFirstToolCallId(namespaced.messages[3]?.tool_calls),
    "manual-call",
    "plain user should keep following tool calls outside the previous ChatX turn"
  )
  assertEqual(
    getFirstToolCallToolCallId(namespaced.messages[3]?.tool_calls),
    "manual-call",
    "plain user should keep following tool_call_id fields outside the previous ChatX turn"
  )
}

function testRepeatedProviderSubagentIdsAreScopedByChatXTurn(): void {
  const rawToolCallId = "call_reused"
  const first = namespaceChatXStreamEventIds(
    {
      type: "custom",
      data: {
        type: "subagents",
        subagents: [
          {
            id: rawToolCallId,
            toolCallId: rawToolCallId,
            name: "General Purpose Agent",
            description: "first",
            status: "running"
          }
        ]
      }
    },
    "msg-1"
  )
  const second = namespaceChatXStreamEventIds(
    {
      type: "custom",
      data: {
        type: "subagents",
        subagents: [
          {
            id: rawToolCallId,
            toolCallId: rawToolCallId,
            name: "General Purpose Agent",
            description: "second",
            status: "running"
          }
        ]
      }
    },
    "msg-2"
  )

  const firstSubagentId = getFirstSubagentField(first, "id")
  const firstSubagentToolCallId = getFirstSubagentField(first, "toolCallId")
  const secondSubagentId = getFirstSubagentField(second, "id")
  const secondSubagentToolCallId = getFirstSubagentField(second, "toolCallId")

  assertEqual(
    firstSubagentId,
    getChatXToolCallId("msg-1", rawToolCallId),
    "first subagent id should include the first ChatX turn"
  )
  assertEqual(
    firstSubagentToolCallId,
    firstSubagentId,
    "first subagent toolCallId should match the namespaced id"
  )
  assertEqual(
    secondSubagentId,
    getChatXToolCallId("msg-2", rawToolCallId),
    "second subagent id should include the second ChatX turn"
  )
  assertEqual(
    secondSubagentToolCallId,
    secondSubagentId,
    "second subagent toolCallId should match the namespaced id"
  )
  assertNotEqual(
    firstSubagentId,
    secondSubagentId,
    "subagent ids from different ChatX turns must differ"
  )
}

function testSubagentStreamEventsUseMatchingScopedSubagentId(): void {
  const rawToolCallId = "call_reused"
  const subagentCard = namespaceChatXStreamEventIds(
    {
      type: "custom",
      data: {
        type: "subagents",
        subagents: [
          {
            id: rawToolCallId,
            toolCallId: rawToolCallId,
            name: "General Purpose Agent",
            description: "first",
            status: "running"
          }
        ]
      }
    },
    "msg-1"
  )
  const delta = namespaceChatXStreamEventIds(
    {
      type: "message-delta",
      id: "subagent-ai",
      content: "inside",
      subagentId: rawToolCallId
    },
    "msg-1"
  )
  const tool = namespaceChatXStreamEventIds(
    {
      type: "tool-message",
      id: "subagent-tool",
      content: "ok",
      toolCallId: "inner-call",
      subagentId: rawToolCallId
    },
    "msg-1"
  )

  if (delta.type !== "message-delta" || tool.type !== "tool-message") {
    throw new Error("expected subagent stream events")
  }

  const scopedSubagentId = getFirstSubagentField(subagentCard, "id")
  assertEqual(
    delta.subagentId,
    scopedSubagentId,
    "subagent message-delta should use the same scoped id as the subagent card"
  )
  assertEqual(
    tool.subagentId,
    scopedSubagentId,
    "subagent tool-message should use the same scoped id as the subagent card"
  )
}

function testRepeatedProviderSubagentStreamIdsAreScopedByChatXTurn(): void {
  const rawToolCallId = "call_reused"
  const first = namespaceChatXStreamEventIds(
    {
      type: "message-delta",
      id: "subagent-ai",
      content: "first",
      subagentId: rawToolCallId
    },
    "msg-1"
  )
  const second = namespaceChatXStreamEventIds(
    {
      type: "message-delta",
      id: "subagent-ai",
      content: "second",
      subagentId: rawToolCallId
    },
    "msg-2"
  )

  if (first.type !== "message-delta" || second.type !== "message-delta") {
    throw new Error("expected message-delta events")
  }

  assertEqual(
    first.subagentId,
    getChatXToolCallId("msg-1", rawToolCallId),
    "first subagent stream id should include the first ChatX turn"
  )
  assertEqual(
    second.subagentId,
    getChatXToolCallId("msg-2", rawToolCallId),
    "second subagent stream id should include the second ChatX turn"
  )
  assertNotEqual(
    first.subagentId,
    second.subagentId,
    "subagent stream ids from different ChatX turns must differ"
  )
}

function testNonSubagentCustomEventsAreUnchanged(): void {
  const event: SchedulerEvent = {
    type: "custom",
    data: {
      type: "progress",
      id: "provider-id"
    }
  }

  const namespaced = namespaceChatXStreamEventIds(event, "msg-1")
  assertEqual(namespaced, event, "non-subagent custom events should be returned unchanged")
}

function testChatXSubagentStorageIdentitySurvivesForkFiltering(): void {
  const turnId = "fork-turn"
  const rawTaskId = "raw-chatx-task"
  const parentId = "raw-chatx-parent"
  const taskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "verifier", description: "verify fork" }
  }
  const checkpoint = {
    channel_values: {
      messages: [
        {
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            id: parentId,
            content: "",
            tool_calls: [taskCall],
            additional_kwargs: {}
          }
        }
      ]
    }
  }
  const index = deriveCheckpointTranscriptIndex(checkpoint as never)
  const invocation = index.subagentTranscriptInvocations[0]
  if (!invocation) throw new Error("expected checkpoint task invocation")
  const rawExecutionId = `${rawTaskId}::invocation-example`
  const promptEvent = namespaceChatXStreamEventIds(
    {
      type: "custom",
      data: {
        type: "subagent_transcript_message",
        subagentId: rawExecutionId,
        subagentMessage: {
          id: `subagent-prompt-${rawExecutionId}`,
          role: "user",
          content: "verify fork",
          subagent_tool_call_id: rawTaskId,
          subagent_invocation_scope: invocation.invocationScope
        }
      }
    },
    turnId
  )
  if (promptEvent.type !== "custom") throw new Error("expected custom prompt event")
  const scopedExecutionId = promptEvent.data.subagentId as string
  const scopedPrompt = promptEvent.data.subagentMessage as Record<string, unknown>
  assertEqual(
    scopedPrompt.subagent_tool_call_id,
    rawTaskId,
    "ChatX must preserve the provider task id used by checkpoint fork identity"
  )
  assertEqual(
    scopedPrompt.id,
    `subagent-prompt-${scopedExecutionId}`,
    "ChatX prompt render id must still follow the scoped execution bucket"
  )
  const filtered = buildFilteredThreadValues(
    { subagentTranscripts: { [scopedExecutionId]: [scopedPrompt] } },
    index
  ).subagentTranscripts as Record<string, unknown>
  assertEqual(
    Object.keys(filtered)[0],
    scopedExecutionId,
    "a canonical ChatX bucket must survive checkpoint filtering"
  )

  const provisionalEvent = namespaceChatXStreamEventIds(
    {
      type: "custom",
      data: {
        type: "subagent_transcript_message",
        subagentId: rawExecutionId,
        subagentMessage: {
          id: `subagent-prompt-${rawExecutionId}`,
          role: "user",
          content: "verify fork",
          subagent_tool_call_id: rawTaskId,
          subagent_invocation_scope: parentId
        }
      }
    },
    turnId
  )
  if (provisionalEvent.type !== "custom") throw new Error("expected provisional custom event")
  const provisionalId = provisionalEvent.data.subagentId as string
  const provisionalPrompt = provisionalEvent.data.subagentMessage as Record<string, unknown>
  const provisionalFiltered = buildFilteredThreadValues(
    { subagentTranscripts: { [provisionalId]: [provisionalPrompt] } },
    index
  ).subagentTranscripts as Record<string, unknown>
  assertEqual(
    Object.keys(provisionalFiltered)[0],
    provisionalId,
    "a messages-only provisional ChatX prompt must retain its raw-id fork fallback"
  )
}

testRepeatedProviderAssistantIdsAreScopedByChatXTurn()
testRepeatedProviderToolCallIdsAreScopedByChatXTurn()
testToolMessageUsesMatchingToolCallScope()
testRepeatedProviderSubagentIdsAreScopedByChatXTurn()
testSubagentStreamEventsUseMatchingScopedSubagentId()
testRepeatedProviderSubagentStreamIdsAreScopedByChatXTurn()
testNonSubagentCustomEventsAreUnchanged()
testFullMessagesUseNearestChatXUserTurn()
testFullMessagesScopeToolCallPairsByTurn()
testFullMessagesPlainUserClearsActiveChatXTurn()
testChatXSubagentStorageIdentitySurvivesForkFiltering()

console.log("chatx-stream-message-ids.spec.ts passed")
