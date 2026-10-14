import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from
  "@langchain/core/messages"
import { messagesStateReducer } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import { captureNativeSharedOrdinaryMessageData } from "./native-shared-ordinary-message-data"
import { captureNativeMessage } from "./native-message-capture"

function kwargs(message: BaseMessage): Record<string, unknown> {
  const value: unknown = Object.getOwnPropertyDescriptor(message, "lc_kwargs")?.value
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture")
  return value as Record<string, unknown>
}
function assigned(message: BaseMessage) {
  const raw = captureNativeSharedOrdinaryMessageData(message)
  messagesStateReducer([], [message])
  raw.assertInitialDataCurrent()
  return { raw, current: raw.captureCurrentData() }
}

describe("Shared ordinary native raw input data", () => {
  it.each(["undefined", "absent"] as const)("accepts the actual reducer ID assignment from %s",
    initial => {
      const message = new HumanMessage({ content: "original input", additional_kwargs: {
        complete: ["\u0000\ud800\ud83d\ude00", { nested: true }] } })
      if (initial === "absent") {
        Reflect.deleteProperty(message, "id")
        Reflect.deleteProperty(kwargs(message), "id")
      }
      const raw = captureNativeSharedOrdinaryMessageData(message)
      raw.assertOriginalDataCurrent()
      raw.assertInitialDataCurrent()
      const actual = messagesStateReducer([], [message])
      expect(actual[0]).toBe(message)
      expect(message.id).toEqual(expect.any(String))
      expect(message.id).not.toBe("")
      expect(kwargs(message).id).toBe(message.id)
      raw.assertInitialDataCurrent()
      const current = raw.captureCurrentData()
      current.assertDataCurrent()
      expect(captureNativeMessage(message).data.content).toBe("original input")
      expect(Object.keys(raw)).toEqual([
        "message", "assertOriginalDataCurrent", "assertInitialDataCurrent", "captureCurrentData"
      ])
      expect(raw.message).toBe(message)
    })

  it.each(["undefined", "absent"] as const)(
    "rejects a normal-looking early %s ID before the actual reducer boundary", initial => {
      const message = new HumanMessage("original input")
      if (initial === "absent") {
        Reflect.deleteProperty(message, "id")
        Reflect.deleteProperty(kwargs(message), "id")
      }
      const raw = captureNativeSharedOrdinaryMessageData(message)
      raw.assertOriginalDataCurrent()
      message.id = "early-looking-reducer-id"
      kwargs(message).id = message.id
      expect(() => raw.assertOriginalDataCurrent())
        .toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
      expect(() => raw.assertInitialDataCurrent())
        .toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
    })

  it.each([
    () => new HumanMessage({ id: "human-input", content: "h" }),
    () => new AIMessage({ id: "ai-input", content: "a", tool_calls: [
      { id: "original-call", name: "original-tool", args: { complete: [1, true] }, type: "tool_call" }
    ] }),
    () => new SystemMessage({ id: "system-input", content: "s" }),
    () => new ToolMessage({ id: "tool-input", content: "t", tool_call_id: "original-call" })
  ])("keeps the actual native class and complete data for an existing ID", create => {
    const message = create(), original = captureNativeMessage(message)
    const raw = captureNativeSharedOrdinaryMessageData(message)
    messagesStateReducer([], [message])
    raw.assertInitialDataCurrent()
    raw.captureCurrentData().assertDataCurrent()
    expect(captureNativeMessage(message)).toEqual(original)
  })

  it.each(["root", "kwargs"] as const)("rejects a one-sided %s ID assignment", target => {
    const message = new HumanMessage("original input")
    const raw = captureNativeSharedOrdinaryMessageData(message)
    if (target === "root") message.id = "one-sided"
    else kwargs(message).id = "one-sided"
    expect(() => raw.assertInitialDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  })

  it.each(["root", "kwargs", "both"] as const)("does not refresh a selected final %s ID", target => {
    const message = new HumanMessage("original input"), { current } = assigned(message)
    if (target !== "kwargs") message.id = "later-id"
    if (target !== "root") kwargs(message).id = "later-id"
    expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  })

  it.each(["body", "kwargs", "tool-calls", "flags", "key-order"] as const)(
    "rejects complete original %s mutation and remains failed", target => {
      const message = new AIMessage({ content: "original input", additional_kwargs: {
        complete: ["one", { two: true }] }, tool_calls: [
        { id: "call", name: "tool", args: { complete: [1, 2] }, type: "tool_call" }
      ] })
      const { current } = assigned(message)
      if (target === "body") message.content = "changed input"
      else if (target === "kwargs") kwargs(message).extra = "changed"
      else if (target === "tool-calls") {
        if (!message.tool_calls) throw new Error("fixture")
        message.tool_calls[0].args.complete = [1, 3]
      } else if (target === "flags") Object.defineProperty(message, "content", { enumerable: false })
      else {
        const original = Object.getOwnPropertyDescriptor(message, "content")!
        Reflect.deleteProperty(message, "content")
        Object.defineProperty(message, "content", original)
      }
      expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
      message.content = "original input"
      expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
    })

  it("rejects replacing the original kwargs address even with identical data", () => {
    const message = new HumanMessage("original input"), { current } = assigned(message)
    const original = kwargs(message)
    Object.defineProperty(message, "lc_kwargs", { value: { ...original } })
    expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  })

  it("reads late ID accessors zero times and locks the failure", () => {
    const message = new HumanMessage("original input"), { current } = assigned(message)
    const original = Object.getOwnPropertyDescriptor(message, "id")!
    let getters = 0
    Object.defineProperty(message, "id", { configurable: true, get() { getters++; return original.value } })
    expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
    Object.defineProperty(message, "id", original)
    expect(getters).toBe(0)
    expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  })

  it("rejects a Proxy without running its traps", () => {
    let traps = 0
    const message = new Proxy(new HumanMessage("original"), {
      getOwnPropertyDescriptor() { traps++; throw new Error("unreachable") },
      getPrototypeOf() { traps++; throw new Error("unreachable") }
    })
    expect(() => captureNativeSharedOrdinaryMessageData(message))
      .toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
    expect(traps).toBe(0)
  })

  it("checks full binary bytes and repeated original values without an identity shortcut", () => {
    const bytes = new Uint8Array([0, 1, 255]), repeated = { complete: [1, "two"] }
    const message = new HumanMessage({ content: "original input", additional_kwargs: {
      bytes, first: repeated, second: repeated } })
    const { current } = assigned(message)
    current.assertDataCurrent()
    bytes[1] = 2
    expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  })

  it("does not pretend a nullable ID is a supported absent ID", () => {
    const message = new HumanMessage("original input")
    Object.defineProperty(message, "id", { value: null })
    expect(() => captureNativeSharedOrdinaryMessageData(message))
      .toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
  })

  it.each(["getter", "replacement"] as const)("keeps binary pure tails on the original %s byte length",
    kind => {
      const bytes = new Uint8Array([0, 1, 255])
      const message = new HumanMessage({ content: "original", additional_kwargs: { bytes } })
      const { current } = assigned(message)
      const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object
      const original = Object.getOwnPropertyDescriptor(prototype, "byteLength")!
      let getters = 0, failed = false, failure: unknown
      try {
        Object.defineProperty(prototype, "byteLength", kind === "getter"
          ? { configurable: true, get() { getters++; throw new Error("unreachable") } }
          : { configurable: true, value: 0 })
        current.assertDataCurrent()
      } catch (error) { failed = true; failure = error }
      finally { Object.defineProperty(prototype, "byteLength", original) }
      if (failed) throw failure
      expect(getters).toBe(0)
      bytes[1] = 2
      expect(() => current.assertDataCurrent()).toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
    })
})
