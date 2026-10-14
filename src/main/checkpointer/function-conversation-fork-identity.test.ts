import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import { describe, expect, it } from "vitest"
import { functionConversationForkIdentity } from "./function-conversation-fork-identity"

function checkpoint(frontier = 6) {
  const value = emptyCheckpoint()
  value.channel_values = {
    cmbFunctionConversation: { version: 1, logicalSessionId: "session",
      conversationId: "conversation", branchId: "branch", frontier },
    messages: [new HumanMessage({ id: "user", content: "same visible question" }),
      new AIMessage({ id: "assistant", content: "same visible answer" })]
  }
  return value
}

function stamp(origin = "engine") {
  return { conversationId: "conversation", branchId: "branch", uuid: "assistant",
    sequence: 8, door: "response", messageType: "assistant",
    origin: origin === "model" ? { kind: "model", model: "actual-provider-model" }
      : { kind: origin } }
}

describe("actual conversation fork history identity", () => {
  it("leaves ordinary legacy history on its existing deduplication path", () => {
    expect(functionConversationForkIdentity(emptyCheckpoint())).toBeUndefined()
  })

  it("keeps identical visible messages with different note consumption frontiers", () => {
    expect(functionConversationForkIdentity(checkpoint(6)))
      .not.toBe(functionConversationForkIdentity(checkpoint(9)))
  })

  it("keeps identical UUIDs and content with different saved branches", () => {
    const first = checkpoint()
    const second = checkpoint()
    second.channel_values.cmbFunctionConversation = {
      ...first.channel_values.cmbFunctionConversation as Record<string, unknown>, branchId: "fork"
    }
    expect(functionConversationForkIdentity(first)).not.toBe(functionConversationForkIdentity(second))
  })

  it("includes the full stamp although the native codec excludes its placement", () => {
    const first = checkpoint(), second = checkpoint()
    const a = (first.channel_values.messages as AIMessage[])[1]
    const b = (second.channel_values.messages as AIMessage[])[1]
    a.additional_kwargs.function_row = stamp("engine")
    b.additional_kwargs.function_row = stamp("model")
    expect(functionConversationForkIdentity(first)).not.toBe(functionConversationForkIdentity(second))
  })

  it("keeps full native tool artifacts and metadata in the identity", () => {
    const first = checkpoint(), second = checkpoint()
    first.channel_values.messages = [new ToolMessage({ id: "tool", tool_call_id: "call",
      content: "same", artifact: { full: "first" }, metadata: { occurrence: 1 } })]
    second.channel_values.messages = [new ToolMessage({ id: "tool", tool_call_id: "call",
      content: "same", artifact: { full: "second" }, metadata: { occurrence: 1 } })]
    expect(functionConversationForkIdentity(first)).not.toBe(functionConversationForkIdentity(second))
  })

  it("rejects a damaged marker rather than treating it as old history", () => {
    const value = checkpoint()
    const message = (value.channel_values.messages as AIMessage[])[1]
    message.additional_kwargs.function_row = { ...stamp(), sequence: -1 }
    expect(() => functionConversationForkIdentity(value)).toThrow()
  })

  it("includes metadata set on the actual native message after construction", () => {
    const first = checkpoint(), second = checkpoint()
    const message = (second.channel_values.messages as AIMessage[])[1]
    message.response_metadata = { provider_occurrence: 2 }
    expect(functionConversationForkIdentity(first)).not.toBe(functionConversationForkIdentity(second))
  })

  it("keeps post-construction artifacts on legacy native ToolMessages without an ID", () => {
    const first = checkpoint(), second = checkpoint()
    const a = new ToolMessage({ tool_call_id: "call", content: "same" })
    const b = new ToolMessage({ tool_call_id: "call", content: "same" })
    a.artifact = { full: "one" }
    b.artifact = { full: "two" }
    first.channel_values.messages = [a]
    second.channel_values.messages = [b]
    expect(functionConversationForkIdentity(first)).not.toBe(functionConversationForkIdentity(second))
    expect(a.id).toBeUndefined()
    expect(b.id).toBeUndefined()
  })

  it("keeps post-construction usage on legacy native AI messages without an ID", () => {
    const first = checkpoint(), second = checkpoint()
    const a = new AIMessage({ content: "same" }), b = new AIMessage({ content: "same" })
    a.usage_metadata = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    b.usage_metadata = { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    first.channel_values.messages = [a]
    second.channel_values.messages = [b]
    expect(functionConversationForkIdentity(first)).not.toBe(functionConversationForkIdentity(second))
  })

  it("rejects a stamp UUID that differs from its actual native occurrence", () => {
    const value = checkpoint()
    const message = (value.channel_values.messages as AIMessage[])[1]
    message.additional_kwargs.function_row = { ...stamp(), uuid: "other" }
    expect(() => functionConversationForkIdentity(value)).toThrow()
  })

  it("deduplicates the same complete saved state independently of checkpoint ID", () => {
    const first = checkpoint(), second = checkpoint()
    first.id = "original-id"
    second.id = "another-id"
    expect(functionConversationForkIdentity(first)).toBe(functionConversationForkIdentity(second))
  })
})
