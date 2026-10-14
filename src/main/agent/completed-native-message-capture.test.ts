import { randomUUID } from "node:crypto"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { captureNativeMessageForCompletedOccurrence } from "./completed-native-message-capture"
import { captureNativeMessage, captureNativeMessageForOccurrence } from "./native-message-capture"
import {
  installFunctionConversationNativeNode,
  readFunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlot
} from "./function-conversation-native-node"
import {
  deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage
} from "./function-conversation-native-message"

class CompletedProvider extends BaseChatModel {
  private index = 0
  constructor(private readonly responses: readonly BaseMessage[]) {
    super({ outputVersion: "v0" })
  }
  _llmType(): string { return "completed-native-capture-fixture" }
  bindTools(): this { return this }
  async _generate(): Promise<ChatResult> {
    const message = this.responses[this.index++]
    if (!message) throw Error("Unexpected extra native model call")
    return { generations: [{ message, text: "native complete output" }] }
  }
}

async function actualSlot(raw: BaseMessage,
  atSlot: (slot: FunctionConversationNativeNodeSlot) => BaseMessage,
  options: { node?: "model_request" | "tools"; withTool?: boolean } = {}) {
  const graph = createAgent({
    model: new CompletedProvider([raw, new AIMessage({ id: randomUUID(), content: "done" })]),
    tools: options.withTool ? [tool(() => "actual tool result", {
      name: "actual_capture_tool", description: "Actual ToolNode fixture",
      schema: z.object({ actual: z.boolean() })
    })] : []
  })
  const signal = new AbortController()
  const installed = installFunctionConversationNativeNode({ graph: graph.graph,
    node: options.node ?? "model_request", assertCurrent: () => signal.signal.throwIfAborted(),
    finalize: async slot => {
      const view = readFunctionConversationNativeNodeSlot(slot)
      return view.message === raw || options.node === "tools" ? atSlot(slot) : view.message
    } })
  try {
    const result = await graph.invoke({ messages: [new HumanMessage("actual native request")] }, {
      configurable: { thread_id: randomUUID() }, signal: signal.signal
    })
    return { result, installed, signal }
  } catch (error) {
    installed.close()
    await installed.whenDrained()
    throw error
  }
}

function completeChunk(): AIMessageChunk {
  return new AIMessageChunk({ id: "same-provider-id", content: [
    { type: "thinking", thinking: "signed reasoning", signature: "actual-signature" },
    { type: "text", text: "complete body" }
  ], tool_call_chunks: [{ type: "tool_call_chunk", index: 0, id: "actual-call",
    name: "actual_capture_tool", args: '{"actual":true}' }],
  usage_metadata: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
  additional_kwargs: { actual_provider: { retained: true } },
  response_metadata: { model_provider: "fixture", actual_provider_field: "retained" } })
}

describe("private completed AI chunk typed conversion", () => {
  it("converts the original completed bound output while preserving all native call facts", async () => {
    const raw = completeChunk(), uuid = randomUUID()
    let copied: ReturnType<typeof captureNativeMessageForCompletedOccurrence> | undefined
    const f = await actualSlot(raw, slot => {
      copied = captureNativeMessageForCompletedOccurrence(slot, uuid)
      return copied.message
    }, { withTool: true })
    try {
      if (!copied) throw Error("Actual completed node did not expose its result")
      expect(Object.getPrototypeOf(copied.message)).toBe(AIMessage.prototype)
      expect(copied.message.id).toBe(uuid)
      expect(copied.originalId).toBe("same-provider-id")
      expect(copied.message.content).toEqual(raw.content)
      expect(copied.message.tool_calls).toEqual(raw.tool_calls)
      expect(copied.message.invalid_tool_calls).toEqual(raw.invalid_tool_calls)
      expect(copied.message.usage_metadata).toEqual(raw.usage_metadata)
      expect(copied.message.additional_kwargs).toEqual(raw.additional_kwargs)
      expect(copied.message.response_metadata).toEqual(raw.response_metadata)
      expect(Object.getOwnPropertyDescriptor(copied.message, "tool_call_chunks")?.value)
        .toEqual(raw.tool_call_chunks)
      const payload = serializeFunctionConversationNativeMessage(copied.message)
      expect(JSON.parse(payload).message.data.tool_call_chunks).toEqual(raw.tool_call_chunks)
      expect(serializeFunctionConversationNativeMessage(
        deserializeFunctionConversationNativeMessage(payload))).toBe(payload)
      expect(copied.snapshot.digest).toBe(captureNativeMessage(copied.message).digest)
      expect(copied.originalDigest).not.toBe(copied.snapshot.digest)
      expect(raw.id).toBe("same-provider-id")
    } finally { f.installed.close(); await f.installed.whenDrained() }
  })

  it("does not append v1 call blocks a second time during full class construction", async () => {
    const raw = completeChunk()
    raw.response_metadata = { ...raw.response_metadata, output_version: "v1" }
    raw.content = [...(Array.isArray(raw.content) ? raw.content : []), {
      type: "tool_call", id: "actual-call", name: "actual_capture_tool", args: { actual: true }
    }]
    const original = JSON.stringify(raw.content)
    const f = await actualSlot(raw, slot => {
      const copied = captureNativeMessageForCompletedOccurrence(slot, randomUUID())
      expect(JSON.stringify(copied.message.content)).toBe(original)
      expect(copied.message.tool_calls).toEqual(raw.tool_calls)
      const payload = serializeFunctionConversationNativeMessage(copied.message)
      expect(JSON.parse(payload).message.data.content_blocks).toEqual(raw.content)
      expect(serializeFunctionConversationNativeMessage(
        deserializeFunctionConversationNativeMessage(payload))).toBe(payload)
      return copied.message
    }, { withTool: true })
    try { expect(JSON.stringify(raw.content)).toBe(original) }
    finally { f.installed.close(); await f.installed.whenDrained() }
  })

  it("keeps ordinary capture closed to partial chunks without a completed slot", () => {
    const raw = new AIMessageChunk({ id: randomUUID(), content: "partial" })
    expect(() => captureNativeMessage(raw)).toThrow()
    expect(() => captureNativeMessageForOccurrence(raw, randomUUID())).toThrow()
    expect(() => captureNativeMessageForCompletedOccurrence(
      {} as FunctionConversationNativeNodeSlot, randomUUID()))
      .toThrow(expect.objectContaining({ code: "MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID" }))
  })

  it("normalizes only the copied occurrence UUID when a completed output has no own ID", async () => {
    const raw = new AIMessageChunk({ id: "provider", content: "complete" }), uuid = randomUUID()
    const f = await actualSlot(raw, slot => {
      // Exercise the missing-ID typed form on the same already completed output object.
      // Slot/callback source joining remains a separate actual host responsibility.
      Reflect.deleteProperty(raw, "id")
      const copied = captureNativeMessageForCompletedOccurrence(slot, uuid)
      expect(copied.originalId).toBeUndefined()
      expect(copied.message.id).toBe(uuid)
      expect(Object.hasOwn(raw, "id")).toBe(false)
      return copied.message
    })
    f.installed.close()
    await f.installed.whenDrained()
  })

  it.each(["conflicting-alias", "wire-alias", "string-content"])(
    "does not repair a malformed v1 completed payload (%s)", async kind => {
      const raw = new AIMessageChunk({ id: randomUUID(), content: [{ type: "text", text: "body" }] })
      await expect(actualSlot(raw, slot => {
        raw.response_metadata = { output_version: "v1" }
        if (kind === "string-content") raw.content = "body"
        else Object.defineProperty(raw.lc_kwargs,
          kind === "wire-alias" ? "content_blocks" : "contentBlocks", {
            value: [{ type: "text", text: "different" }], enumerable: true
          })
        return captureNativeMessageForCompletedOccurrence(slot, randomUUID()).message
      })).rejects.toMatchObject({ code: "MODS_NATIVE_CAPTURE_COMPLETED_INVALID" })
    }
  )

  it("rejects copied, JSON and Proxy slot values without reading their fields", async () => {
    const raw = new AIMessageChunk({ id: randomUUID(), content: "complete" })
    let traps = 0
    const f = await actualSlot(raw, slot => {
      const forged = new Proxy(slot, {
        get() { traps++; throw Error("Slot field was read") },
        getPrototypeOf() { traps++; throw Error("Slot prototype was read") }
      })
      for (const value of [{ ...slot }, JSON.parse(JSON.stringify(slot)), forged])
        expect(() => captureNativeMessageForCompletedOccurrence(value, randomUUID()))
          .toThrow(expect.objectContaining({ code: "MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID" }))
      expect(traps).toBe(0)
      return raw
    })
    try { expect(traps).toBe(0) }
    finally { f.installed.close(); await f.installed.whenDrained() }
  })

  it("does not use a tools result slot to authorize an AI chunk conversion", async () => {
    const raw = completeChunk()
    let rejected = 0
    const f = await actualSlot(raw, slot => {
      const view = readFunctionConversationNativeNodeSlot(slot)
      expect(view.node).toBe("tools")
      expect(() => captureNativeMessageForCompletedOccurrence(slot, randomUUID()))
        .toThrow(expect.objectContaining({ code: "MODS_NATIVE_CAPTURE_COMPLETED_INVALID" }))
      rejected++
      return view.message
    }, { node: "tools", withTool: true })
    try { expect(rejected).toBe(1) }
    finally { f.installed.close(); await f.installed.whenDrained() }
  })

  it("keeps an ordinary full AI class on the ordinary capture path", async () => {
    const raw = new AIMessage({ id: randomUUID(), content: "full AI" })
    const f = await actualSlot(raw, slot => {
      expect(() => captureNativeMessageForCompletedOccurrence(slot, randomUUID())).toThrow()
      expect(captureNativeMessage(raw).type).toBe("ai")
      return raw
    })
    f.installed.close()
    await f.installed.whenDrained()
  })

  it.each(["content-getter", "chunks-getter", "toJSON", "toDict"])(
    "rejects %s on the actual completed object before executing it", async kind => {
      const raw = new AIMessageChunk({ id: randomUUID(), content: "complete" })
      let calls = 0
      await expect(actualSlot(raw, slot => {
        if (kind.endsWith("getter")) Object.defineProperty(raw,
          kind === "content-getter" ? "content" : "tool_call_chunks", {
            configurable: true, enumerable: true, get() { calls++; return "unexpected" }
          })
        else Object.defineProperty(raw, kind, { value: () => { calls++; return {} } })
        return captureNativeMessageForCompletedOccurrence(slot, randomUUID()).message
      })).rejects.toBeInstanceOf(ModFunctionError)
      expect(calls).toBe(0)
    }
  )

  it("rejects nested Proxy metadata before any trap", async () => {
    const raw = new AIMessageChunk({ id: randomUUID(), content: "complete" })
    let traps = 0
    await expect(actualSlot(raw, slot => {
      raw.additional_kwargs = { value: new Proxy({}, {
        getPrototypeOf() { traps++; return Object.prototype },
        ownKeys() { traps++; return [] },
        getOwnPropertyDescriptor() { traps++; return undefined }
      }) }
      return captureNativeMessageForCompletedOccurrence(slot, randomUUID()).message
    })).rejects.toMatchObject({ code: "MODS_NATIVE_CAPTURE_PROXY" })
    expect(traps).toBe(0)
  })

  it("preserves structured suppression from the original chunks rather than clearing it", async () => {
    const raw = new AIMessageChunk({ id: randomUUID(), content: "complete" })
    let toJSONCalls = 0
    const bytes = Buffer.from("original typed bytes")
    Object.defineProperty(bytes, "toJSON", { value: () => { toJSONCalls++; return "leak" } })
    const f = await actualSlot(raw, slot => {
      // This is deliberately damaged execution metadata, after the original model completed.
      // The typed adapter records suppression; this is not authorization to execute it.
      Object.defineProperty(raw, "tool_call_chunks", { configurable: true, enumerable: true,
        writable: true, value: [{ type: "tool_call_chunk", index: 0,
          args: "{}", name: "unused", id: "unused", bytes }] })
      const copied = captureNativeMessageForCompletedOccurrence(slot, randomUUID())
      expect(copied.snapshot.executionSuppressed).toBe(true)
      expect(Object.getOwnPropertyDescriptor(copied.message, "tool_call_chunks")?.value)
        .toEqual([{ type: "tool_call_chunk", index: 0, args: "{}", name: "unused", id: "unused",
          bytes: "[Binary output suppressed]" }])
      expect(toJSONCalls).toBe(0)
      return copied.message
    })
    try { expect(toJSONCalls).toBe(0) }
    finally { f.installed.close(); await f.installed.whenDrained() }
  })

  it("records original mutation independently from the normalized occurrence identity", async () => {
    const raw = new AIMessageChunk({ id: "provider", content: "complete" }), uuid = randomUUID()
    const f = await actualSlot(raw, slot => {
      const first = captureNativeMessageForCompletedOccurrence(slot, uuid)
      raw.id = "another-provider"
      const second = captureNativeMessageForCompletedOccurrence(slot, uuid)
      expect(second.originalDigest).not.toBe(first.originalDigest)
      expect(second.snapshot.digest).toBe(first.snapshot.digest)
      raw.content = "changed body"
      const third = captureNativeMessageForCompletedOccurrence(slot, uuid)
      expect(third.originalDigest).not.toBe(second.originalDigest)
      expect(third.snapshot.digest).not.toBe(second.snapshot.digest)
      return third.message
    })
    f.installed.close()
    await f.installed.whenDrained()
  })

  it("rejects a retired original node even when the old slot still exists", async () => {
    const raw = new AIMessageChunk({ id: randomUUID(), content: "complete" })
    let old: FunctionConversationNativeNodeSlot | undefined
    const f = await actualSlot(raw, slot => { old = slot; return raw })
    f.installed.close()
    await f.installed.whenDrained()
    if (!old) throw Error("Original compiled node did not mint a slot")
    const originalSlot = old
    expect(() => captureNativeMessageForCompletedOccurrence(originalSlot, randomUUID()))
      .toThrow(expect.objectContaining({ code: "MODS_CONVERSATION_NATIVE_NODE_CHANGED" }))
  })

  it("rechecks the original source during typed traversal", async () => {
    const raw = new AIMessageChunk({ id: randomUUID(), content: "complete" })
    let guards = 0
    await expect(actualSlot(raw, slot => captureNativeMessageForCompletedOccurrence(slot,
      randomUUID(), () => {
        if (++guards === 3) throw new ModFunctionError("MODS_CANCELLED")
      }).message)).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    expect(guards).toBe(3)
  })

  it("retains complete text beyond the public JSON byte budget", async () => {
    const text = "完整正文".repeat(100_000)
    const raw = new AIMessageChunk({ id: randomUUID(), content: text })
    const f = await actualSlot(raw, slot => {
      const copied = captureNativeMessageForCompletedOccurrence(slot, randomUUID())
      expect(copied.message.content).toBe(text)
      expect(Buffer.byteLength(serializeFunctionConversationNativeMessage(copied.message)))
        .toBeGreaterThan(1_048_576)
      return copied.message
    })
    f.installed.close()
    await f.installed.whenDrained()
  })
})
