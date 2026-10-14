import { AIMessage, ToolMessage, type BaseMessage, type ContentBlock } from "@langchain/core/messages"
import type { ModJson, ModObject } from "../../shared/mods/types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { captureNativeMessage } from "./native-message-capture"
import { deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_RENDERING_INVALID") }
function object(value: unknown): ModObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  return value as ModObject
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
const executionTypes = new Set(["tool_use", "tool_call", "tool_call_chunk", "server_tool_use",
  "thinking", "redacted_thinking", "reasoning"])

/** Pure comparison facts from an already typed/protected strict native codec payload. */
export function fixedFunctionConversationNativeFacts(payload: string): unknown {
  const envelope = object(JSON.parse(payload)), message = object(envelope.message)
  const data = object(message.data)
  const metadata = data.response_metadata
  if (message.type === "ai" && metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) && metadata.output_version === "v1") {
    // AIMessage's known v1 getter returns this.content. Only its exact wire alias is derived;
    // unknown fields and the non-v1 provider translator remain part of the fixed facts.
    if (Object.hasOwn(data, "contentBlocks") || !Object.hasOwn(data, "content") ||
      !Object.hasOwn(data, "content_blocks") || !Array.isArray(data.content) ||
      !Array.isArray(data.content_blocks) || !same(data.content, data.content_blocks)) fail()
    delete data.content_blocks
  }
  const executionContent = message.type === "ai" && Array.isArray(data.content)
    ? data.content.filter(block => block && typeof block === "object" && !Array.isArray(block) &&
      typeof block.type === "string" && executionTypes.has(block.type)) : []
  delete data.content
  return { envelope, executionContent }
}

function content(value: ModJson | undefined): ModObject[] {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) fail()
  return value.map(block => {
    if (typeof block === "string") return { type: "text", text: block }
    const result = object(block)
    if (typeof result.type !== "string" || !result.type) return { type: "unknown", value: result }
    return result
  })
}
function nativeContent(blocks: readonly ModObject[]): ContentBlock[] {
  return blocks.map(block => {
    if (typeof block.type !== "string" || !block.type) fail()
    return { ...clone(block), type: block.type }
  })
}

function nativeData(message: BaseMessage): ModObject {
  // This helper is called only after actual protection provenance. Still reject raw methods,
  // Proxy/accessor/native-class substitutions before asking the full native codec to run.
  captureNativeMessage(message)
  const envelope: unknown = JSON.parse(serializeFunctionConversationNativeMessage(message))
  return object(object(object(envelope).message).data)
}

function calls(data: ModObject): ModObject[] {
  if (!Array.isArray(data.tool_calls)) fail()
  return data.tool_calls.map(raw => {
    const call = object(raw)
    if (typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name ||
      !call.args || typeof call.args !== "object" || Array.isArray(call.args)) fail()
    return { type: "tool_use", id: call.id, name: call.name, input: call.args }
  })
}

function assertCalls(blocks: readonly ModObject[], actual: readonly ModObject[]): void {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (block.type !== "tool_use") continue
    if (typeof block.id !== "string" || ids.has(block.id)) fail()
    const call = actual.find(item => item.id === block.id)
    if (!call || block.name !== call.name || !same(block.input, call.input) ||
      Object.keys(block).some(key => !["type", "id", "name", "input"].includes(key))) fail()
    ids.add(block.id)
  }
}

/** Full native rendering; availability to a public Hook is decided by the Retainer separately. */
export class FunctionConversationNativeRendering {
  private readonly errors = new WeakMap<BaseMessage, boolean>()

  inheritPresentation(original: BaseMessage, safe: BaseMessage): void {
    if (this.errors.has(original)) this.errors.set(safe, this.errors.get(original) === true)
  }

  project(message: BaseMessage): ModObject {
    const data = nativeData(message)
    let blocks = content(data.content)
    if (AIMessage.isInstance(message)) {
      const actual = calls(data)
      assertCalls(blocks, actual)
      blocks = [...blocks, ...actual.filter(call => !blocks.some(block =>
        block.type === "tool_use" && block.id === call.id))]
      return { type: "assistant", role: "assistant", content: clone(blocks) }
    }
    if (ToolMessage.isInstance(message)) return { type: "user", role: "user", content: [{
      type: "tool_result", tool_use_id: message.tool_call_id, content: clone(blocks),
      is_error: this.errors.get(message) ?? message.status === "error"
    }] }
    if (data.isMeta !== undefined) fail()
    const type = message.getType() === "system" ? "system" : "user"
    return { type, ...(type === "user" ? { role: "user" } : {}), content: clone(blocks) }
  }

  apply(message: BaseMessage, rendering: ModObject): BaseMessage {
    const original = this.project(message)
    if (rendering.type !== original.type || rendering.role !== original.role ||
      rendering.isMeta !== original.isMeta || rendering.name !== original.name ||
      Object.keys(rendering).some(key => !["type", "role", "isMeta", "name", "content"].includes(key)))
      fail()
    if (!Array.isArray(rendering.content)) fail()
    const next = rendering.content.map(object)
    const changed = deserializeFunctionConversationNativeMessage(
      serializeFunctionConversationNativeMessage(message))
    if (same(rendering, original)) {
      this.inheritPresentation(message, changed)
      return changed
    }
    let blocks = next
    if (AIMessage.isInstance(message)) {
      const data = nativeData(message), actual = calls(data)
      assertCalls(next, actual)
      const originalNative = content(data.content)
      const fixedTypes = new Set(["tool_call", "tool_call_chunk", "server_tool_use",
        "thinking", "redacted_thinking", "reasoning"])
      if (!same(originalNative.filter(block => fixedTypes.has(String(block.type))),
        next.filter(block => fixedTypes.has(String(block.type))))) fail()
      // Separate calls synthesized for the public projection from actual native content. A
      // text rewrite cannot insert/delete/reorder the provider's native execution blocks.
      const originalCalls = originalNative.filter(block => block.type === "tool_use")
      const nextCalls = next.filter(block => block.type === "tool_use" &&
        originalCalls.some(originalCall => originalCall.id === block.id))
      if (!same(originalCalls, nextCalls)) fail()
      blocks = next.filter(block => block.type !== "tool_use" ||
        originalCalls.some(originalCall => originalCall.id === block.id))
    } else if (ToolMessage.isInstance(message)) {
      if (next.length !== 1 || next[0].type !== "tool_result" ||
        next[0].tool_use_id !== message.tool_call_id || typeof next[0].is_error !== "boolean" ||
        Object.keys(next[0]).some(key => !["type", "tool_use_id", "content", "is_error"].includes(key)))
        fail()
      blocks = content(next[0].content)
      this.errors.set(changed, next[0].is_error)
    }
    changed.content = typeof message.content === "string" && blocks.length === 1 &&
      blocks[0].type === "text" && typeof blocks[0].text === "string" &&
      Object.keys(blocks[0]).length === 2 ? blocks[0].text : nativeContent(blocks)
    return changed
  }
}
