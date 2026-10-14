import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { deserializeFunctionConversationNativeMessage as deserialize,
  serializeFunctionConversationNativeMessage as serialize } from
  "./function-conversation-native-message"

describe("canonical native conversation message codec", () => {
  it.each([
    new HumanMessage({ id: "human", content: [{ type: "text", text: "full input" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }],
      additional_kwargs: { isMeta: true, cmb_provider_source_id: "source",
        cmb_provider_occurrence: 2 }, response_metadata: { native: "kept" } }),
    new AIMessage({ id: "ai", content: [{ type: "thinking", thinking: "full reasoning" }],
      tool_calls: [{ id: "call", name: "native-tool", args: { path: "actual" } }],
      usage_metadata: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      response_metadata: { finish_reason: "tool_calls" } }),
    new ToolMessage({ id: "tool", tool_call_id: "call", name: "native-tool",
      content: "complete result", status: "error", artifact: { full: "native artifact" },
      metadata: { native: true }, additional_kwargs: { original: "kept" } }),
    new SystemMessage({ id: "system", content: "display notice" })
  ])("preserves the original native class, payload and metadata for $id", message => {
    const payload = serialize(message)
    const restored = deserialize(payload)
    expect(restored.constructor).toBe(message.constructor)
    expect(restored.id).toBe(message.id)
    expect(serialize(restored)).toBe(payload)
    expect(restored.content).toEqual(message.content)
    expect(restored.additional_kwargs).toEqual(message.additional_kwargs)
    if (ToolMessage.isInstance(restored)) {
      expect(restored.tool_call_id).toBe("call")
      expect(restored.artifact).toEqual({ full: "native artifact" })
      expect(restored.metadata).toEqual({ native: true })
    }
  })

  it("keeps canonical content larger than the public API limit", () => {
    const message = new ToolMessage({ id: "large", tool_call_id: "actual-call",
      content: "x".repeat(1024 * 1024 + 17) })
    expect(deserialize(serialize(message)).content).toBe(message.content)
  })

  it("captures actual final fields added after native construction", () => {
    const message = new HumanMessage("before")
    message.id = "actual-uuid"
    message.content = "protected final content"
    message.additional_kwargs = { actual: true, function_row: { independentlyVerified: true } }
    const restored = deserialize(serialize(message))
    expect(restored.id).toBe("actual-uuid")
    expect(restored.content).toBe("protected final content")
    expect(restored.additional_kwargs).toEqual({ actual: true })
  })

  it.each(["v1-content", "content-blocks"])(
    "preserves an already normalized real AI message without a second append (%s)", mode => {
      const blocks = [{ type: "text" as const, text: "complete body" },
        { type: "reasoning" as const, reasoning: "complete provider reasoning" }]
      const fields = {
        id: "actual-ai-v1", name: "native-provider",
        tool_calls: [{ id: "actual-call", name: "actual-tool", type: "tool_call" as const,
          args: { nested: { path: "actual", count: 4 }, values: [true, null] } }],
        invalid_tool_calls: [{ id: "invalid-call", name: "tool", args: "{",
          type: "invalid_tool_call" as const, error: "actual parse error" }],
        usage_metadata: { input_tokens: 4, output_tokens: 3, total_tokens: 7,
          input_token_details: { cache_read: 2 }, output_token_details: { reasoning: 1 } },
        additional_kwargs: { provider_response: { complete: true },
          cmb_provider_source_id: "native-occurrence", cmb_provider_occurrence: 2 }
      }
      const message = mode === "v1-content"
        ? new AIMessage({ ...fields, content: [...blocks,
          { type: "thinking", thinking: "complete native provider block", signature: "provider-signature" }],
          response_metadata: { output_version: "v1", provider: "actual", finish_reason: "tool_calls" } })
        : new AIMessage({ ...fields, contentBlocks: blocks,
          response_metadata: { provider: "actual", finish_reason: "tool_calls" } })
      const payload = serialize(message), restored = deserialize(payload)
      expect(restored).toBeInstanceOf(AIMessage)
      if (!AIMessage.isInstance(restored)) throw new Error("TEST_WRONG_NATIVE_CLASS")
      expect(restored.content).toEqual(message.content)
      expect(restored.tool_calls).toEqual(message.tool_calls)
      expect(restored.invalid_tool_calls).toEqual(message.invalid_tool_calls)
      expect(restored.usage_metadata).toEqual(message.usage_metadata)
      expect(restored.additional_kwargs).toEqual(message.additional_kwargs)
      expect(restored.response_metadata).toEqual(message.response_metadata)
      expect(restored.contentBlocks).toEqual(message.contentBlocks)
      expect(serialize(restored)).toBe(payload)
      expect(serialize(message)).toBe(payload)
    }
  )

  it.each(["content", "content_blocks", "tool_calls", "invalid_tool_calls",
    "additional_kwargs", "response_metadata"])(
    "does not repair a noncanonical v1 payload missing %s", field => {
      const message = new AIMessage({ id: "actual-v1", content: [{ type: "text", text: "body" }],
        response_metadata: { output_version: "v1", provider: "actual" },
        tool_calls: [{ id: "call", name: "tool", args: { actual: true } }] })
      const envelope = JSON.parse(serialize(message)) as {
        version: number; message: { type: string; data: Record<string, unknown> }
      }
      expect(Object.hasOwn(envelope.message.data, field)).toBe(true)
      delete envelope.message.data[field]
      expect(() => deserialize(JSON.stringify(envelope))).toThrow(expect.objectContaining({
        code: "MODS_CONVERSATION_NATIVE_MESSAGE_INVALID" }))
    }
  )

  it.each(["content-string", "calls-object", "invalid-calls-object", "conflicting-blocks", "both-aliases"])(
    "rejects malformed or conflicting canonical v1 fields (%s)", kind => {
      const message = new AIMessage({ id: "actual-v1", content: [{ type: "text", text: "body" }],
        response_metadata: { output_version: "v1", provider: "actual" },
        tool_calls: [{ id: "call", name: "tool", args: { actual: true } }] })
      const envelope = JSON.parse(serialize(message)) as {
        version: number; message: { type: string; data: Record<string, unknown> }
      }
      if (kind === "content-string") envelope.message.data.content = "not normalized native content"
      else if (kind === "calls-object") envelope.message.data.tool_calls = { id: "call" }
      else if (kind === "invalid-calls-object") envelope.message.data.invalid_tool_calls = {}
      else if (kind === "both-aliases") envelope.message.data.contentBlocks = envelope.message.data.content
      else {
        expect(Object.hasOwn(envelope.message.data, "content_blocks")).toBe(true)
        envelope.message.data.content_blocks = [{ type: "text", text: "different source" }]
      }
      expect(() => deserialize(JSON.stringify(envelope))).toThrow(expect.objectContaining({
        code: "MODS_CONVERSATION_NATIVE_MESSAGE_INVALID" }))
    }
  )

  it("rejects UI payloads, missing native identity and a malformed native tool", () => {
    expect(() => deserialize(JSON.stringify({ type: "user", content: "UI text" }))).toThrow()
    expect(() => serialize(new HumanMessage("no id"))).toThrow()
    expect(() => serialize(new ToolMessage({ id: "bad", tool_call_id: "", content: "bad" })))
      .toThrow()
    const source = serialize(new HumanMessage({ id: "actual", content: "full" }))
    expect(() => deserialize(source.replace('"human"', '"tool"'))).toThrow()
  })
})
