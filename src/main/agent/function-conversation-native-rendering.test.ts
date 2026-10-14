import { randomUUID } from "node:crypto"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import { FunctionConversationNativeRendering, fixedFunctionConversationNativeFacts }
  from "./function-conversation-native-rendering"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"

describe("full native rendering without expanding the public Hook budget", () => {
  it("permits only the exact v1 derived content alias while retaining calls and signed execution blocks", () => {
    const rendering = new FunctionConversationNativeRendering()
    const original = new AIMessage({ id: randomUUID(), content: [
      { type: "reasoning", reasoning: "fixed signed reasoning", signature: "actual" },
      { type: "text", text: "old body" }
    ], response_metadata: { output_version: "v1" }, tool_calls: [{
      id: "actual-call", name: "ActualTool", args: { actual: true }, type: "tool_call"
    }] })
    const projected = rendering.project(original)
    if (!Array.isArray(projected.content)) throw Error("ACTUAL_V1_BLOCKS_MISSING")
    const changed = rendering.apply(original, { ...projected, content: projected.content.map(block =>
      block && typeof block === "object" && !Array.isArray(block) && block.type === "text"
        ? { type: "text", text: "new body" } : block) })
    expect(fixedFunctionConversationNativeFacts(serializeFunctionConversationNativeMessage(changed)))
      .toEqual(fixedFunctionConversationNativeFacts(serializeFunctionConversationNativeMessage(original)))
    expect(changed.content).not.toEqual(original.content)
    expect(AIMessage.isInstance(changed) && changed.tool_calls).toEqual(original.tool_calls)
  })

  it.each(["missing", "different", "camel"])("rejects a false v1 derived alias (%s)", kind => {
    const message = new AIMessage({ id: randomUUID(), content: [{ type: "text", text: "body" }],
      response_metadata: { output_version: "v1" } })
    const envelope = JSON.parse(serializeFunctionConversationNativeMessage(message))
    expect(Object.hasOwn(envelope.message.data, "content_blocks")).toBe(true)
    if (kind === "missing") delete envelope.message.data.content_blocks
    if (kind === "different") envelope.message.data.content_blocks = [{ type: "text", text: "other" }]
    if (kind === "camel") envelope.message.data.contentBlocks = envelope.message.data.content_blocks
    expect(() => fixedFunctionConversationNativeFacts(JSON.stringify(envelope))).toThrow()
  })
  it("preserves a complete large native string and the exact default native payload", () => {
    const rendering = new FunctionConversationNativeRendering()
    const body = "完整正文".repeat(300_000)
    const message = new HumanMessage({ id: randomUUID(), content: body,
      additional_kwargs: { source: "actual-source" } })
    const projected = rendering.project(message)
    expect(projected).toEqual({ type: "user", role: "user", content: [{ type: "text", text: body }] })
    expect(serializeFunctionConversationNativeMessage(rendering.apply(message, projected)))
      .toBe(serializeFunctionConversationNativeMessage(message))
  })

  it("keeps ordinary native user input free of an SDK note isMeta stamp", () => {
    const rendering = new FunctionConversationNativeRendering()
    const message = new HumanMessage({ id: randomUUID(), content: "ordinary user" })
    expect(rendering.project(message).isMeta).toBeUndefined()
    const changed = rendering.apply(message, { type: "user", role: "user",
      content: [{ type: "text", text: "actual new body" }] })
    expect(changed.content).toBe("actual new body")
    expect(changed.additional_kwargs.isMeta).toBeUndefined()
  })

  it("projects real AI calls while preserving their exact native default representation", () => {
    const rendering = new FunctionConversationNativeRendering()
    const message = new AIMessage({ id: randomUUID(), content: "body", tool_calls: [
      { id: "call", name: "ActualTool", args: { actual: true }, type: "tool_call" }
    ], usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    response_metadata: { provider: "actual" } })
    const projected = rendering.project(message)
    expect(projected.content).toEqual([{ type: "text", text: "body" },
      { type: "tool_use", id: "call", name: "ActualTool", input: { actual: true } }])
    const changed = rendering.apply(message, { ...projected, content: [
      { type: "text", text: "changed body" },
      { type: "tool_use", id: "call", name: "ActualTool", input: { actual: true } }
    ] })
    expect(changed.content).toBe("changed body")
    expect(AIMessage.isInstance(changed) && changed.tool_calls).toEqual(message.tool_calls)
    expect(serializeFunctionConversationNativeMessage(rendering.apply(message, projected)))
      .toBe(serializeFunctionConversationNativeMessage(message))
  })

  it.each(["new-call", "changed-args", "duplicate", "changed-thinking"])(
    "rejects a fabricated native execution or signed content rewrite (%s)", kind => {
      const rendering = new FunctionConversationNativeRendering()
      const message = new AIMessage({ id: randomUUID(), content: [
        { type: "thinking", thinking: "original", signature: "actual-signature" },
        { type: "text", text: "body" }
      ], tool_calls: [{ id: "call", name: "ActualTool", args: { original: true }, type: "tool_call" }] })
      const actual: ModObject = { type: "tool_use", id: "call", name: "ActualTool", input: { original: true } }
      const blocks: ModObject[] = [
        { type: "thinking", thinking: kind === "changed-thinking" ? "edited" : "original",
          signature: "actual-signature" },
        { type: "text", text: "body" },
        kind === "new-call" ? { ...actual, id: "foreign" }
          : kind === "changed-args" ? { ...actual, input: { changed: true } } : actual,
        ...(kind === "duplicate" ? [actual] : [])
      ]
      expect(() => rendering.apply(message, { type: "assistant", role: "assistant", content: blocks }))
        .toThrow(expect.objectContaining({ code: "MODS_CONVERSATION_NATIVE_RENDERING_INVALID" }))
    }
  )

  it("keeps Tool status/artifact fixed while explicitly transferring the public error bit", () => {
    const rendering = new FunctionConversationNativeRendering()
    const original = new ToolMessage({ id: randomUUID(), content: "actual output",
      tool_call_id: "call", status: "success", artifact: { execution: "actual" } })
    const changed = rendering.apply(original, { type: "user", role: "user", content: [{
      type: "tool_result", tool_use_id: "call", is_error: true,
      content: [{ type: "text", text: "presented error" }]
    }] })
    expect(ToolMessage.isInstance(changed) && changed.status).toBe("success")
    expect(ToolMessage.isInstance(changed) && changed.artifact).toEqual({ execution: "actual" })
    const nextProtected = new ToolMessage({ id: changed.id, content: changed.content,
      tool_call_id: "call", status: "success", artifact: { execution: "actual" } })
    rendering.inheritPresentation(changed, nextProtected)
    expect(rendering.project(nextProtected)).toMatchObject({ content: [{ is_error: true }] })
  })

  it("retains actual system content and rejects role or hidden user upgrades", () => {
    const rendering = new FunctionConversationNativeRendering()
    const message = new SystemMessage({ id: randomUUID(), content: "native notice" })
    expect(rendering.project(message)).toEqual({ type: "system",
      content: [{ type: "text", text: "native notice" }] })
    expect(() => rendering.apply(message, { type: "user", role: "user", isMeta: true,
      content: [{ type: "text", text: "upgraded" }] })).toThrow()
  })

  it("rejects a raw native override before its serializer runs", () => {
    const rendering = new FunctionConversationNativeRendering()
    const message = new HumanMessage({ id: randomUUID(), content: "body" })
    let calls = 0
    Object.defineProperty(message, "toJSON", { value: () => { calls++; return {} } })
    expect(() => rendering.project(message)).toThrow()
    expect(calls).toBe(0)
  })
})
