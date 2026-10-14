import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { Send } from "@langchain/langgraph"
import { MemorySaver } from "@langchain/langgraph-checkpoint"
import { describe, expect, it } from "vitest"
import {
  canonicalCheckpointValueDigest,
  canonicalDisplayValueDigest
} from "./function-conversation-canonical-display-worker"

const invalid = "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"
const nativeBrand = Symbol.for("langchain.message")
const body = "完整 checkpoint body\u0000\ud800\udfff last field"

function nativeMessages(): BaseMessage[] {
  return [
    new HumanMessage({ id: "actual-human", name: "human", content: body }),
    new AIMessage({ id: "actual-ai", name: "assistant", content: body }),
    new SystemMessage({ id: "actual-system", name: "system", content: body }),
    new ToolMessage({ id: "actual-tool", name: "tool", content: body, tool_call_id: "actual-call" })
  ]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("The actual serializer must return a record")
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("The actual serializer must preserve its array")
  return value
}

describe("checkpoint-only native value fingerprint", () => {
  it("fingerprints real Send task and start messages after the official serializer roundtrip", async () => {
    const messages = nativeMessages()
    const checkpoint = {
      channel_values: {
        __pregel_tasks: [false, [new Send("model", { messages, original: body })]],
        __start__: { messages: [messages[0]] },
        messages
      }
    }
    // BaseCheckpointSaver's default is the installed official JsonPlusSerializer.
    const serializer = new MemorySaver().serde
    expect(serializer.constructor.name).toBe("JsonPlusSerializer")
    const [type, bytes] = await serializer.dumpsTyped(checkpoint)
    expect(type).toBe("json")
    const restored: unknown = await serializer.loadsTyped(type, bytes)
    const channels = record(record(restored).channel_values)
    const send = record(array(array(channels.__pregel_tasks)[1])[0])
    expect(Object.getPrototypeOf(send)).toBe(Object.prototype)
    expect(send.node).toBe("model")
    expect(record(send.args).original).toBe(body)
    const restoredMessages = array(record(send.args).messages)
    expect(restoredMessages.map((message) => Object.getPrototypeOf(record(message)))).toEqual(
      messages.map((message) => Object.getPrototypeOf(message))
    )
    expect(restoredMessages.map((message) => record(message).content)).toEqual(
      messages.map(() => body)
    )
    expect(Object.getPrototypeOf(array(record(channels.__start__).messages)[0])).toBe(
      HumanMessage.prototype
    )
    const again: unknown = await serializer.loadsTyped(type, bytes)
    expect(canonicalCheckpointValueDigest(restored)).toMatch(/^[a-f0-9]{64}$/)
    expect(canonicalCheckpointValueDigest(restored)).toBe(canonicalCheckpointValueDigest(again))
    expect(() => canonicalDisplayValueDigest(restored)).toThrow(invalid)
  })

  it("keeps all four exact native types stable and distinct from their plain own-field copies", () => {
    const messages = nativeMessages()
    const digests = messages.map((message) => canonicalCheckpointValueDigest(message))
    expect(new Set(digests).size).toBe(4)
    for (const [index, message] of messages.entries()) {
      expect(canonicalCheckpointValueDigest(message)).toBe(digests[index])
      const plain = Object.defineProperties({}, Object.getOwnPropertyDescriptors(message))
      Reflect.deleteProperty(plain, nativeBrand)
      expect(canonicalCheckpointValueDigest(plain)).not.toBe(digests[index])
      expect(() => canonicalDisplayValueDigest(message)).toThrow(invalid)
    }
  })

  it("includes complete own extras, names, contents and nested metadata without projecting them away", () => {
    for (const message of nativeMessages()) {
      const extra = { complete: body, nested: { last: "original" } }
      Object.defineProperty(message, "checkpointExtra", { value: extra, enumerable: false })
      const before = canonicalCheckpointValueDigest(message)
      extra.nested.last = "changed at the final own field"
      const changedExtra = canonicalCheckpointValueDigest(message)
      expect(changedExtra).not.toBe(before)
      message.name = "changed name"
      const changedName = canonicalCheckpointValueDigest(message)
      expect(changedName).not.toBe(changedExtra)
      message.response_metadata = { provider: { complete: body, last: "changed" } }
      const changedMetadata = canonicalCheckpointValueDigest(message)
      expect(changedMetadata).not.toBe(changedName)
      message.content = body + " actual new tail"
      expect(canonicalCheckpointValueDigest(message)).not.toBe(changedMetadata)
    }
  })

  it("rejects native and nested accessors or own serialization methods with callback zero", () => {
    let callbacks = 0
    const accessor = new HumanMessage({ id: "actual-accessor", content: body })
    Object.defineProperty(accessor, "content", {
      get() {
        callbacks++
        return body
      }
    })
    expect(() => canonicalCheckpointValueDigest(accessor)).toThrow("MODS_NATIVE_CAPTURE_ACCESSOR")
    const nested = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        callbacks++
        return body
      }
    })
    const metadata = new HumanMessage({ id: "actual-metadata", content: body })
    Object.defineProperty(metadata, "checkpointExtra", { value: nested })
    expect(() => canonicalCheckpointValueDigest(metadata)).toThrow(invalid)
    for (const method of ["getType", "toJSON", "toDict"] as const) {
      const message = new HumanMessage({ id: `actual-${method}`, content: body })
      Object.defineProperty(message, method, {
        value: () => {
          callbacks++
          return "human"
        }
      })
      expect(() => canonicalCheckpointValueDigest(message)).toThrow("MODS_NATIVE_CAPTURE_TYPE")
    }
    expect(callbacks).toBe(0)
  })

  it("rejects proxies, subclasses and incomplete chunks without inspecting caller traps", () => {
    let traps = 0
    const proxy = new Proxy(new HumanMessage({ id: "actual-proxy", content: body }), {
      get() {
        traps++
        throw Error("No proxy get may run")
      },
      getPrototypeOf() {
        traps++
        throw Error("No proxy reflection may run")
      },
      ownKeys() {
        traps++
        throw Error("No proxy keys may run")
      }
    })
    expect(() => canonicalCheckpointValueDigest(proxy)).toThrow(invalid)
    class DerivedHuman extends HumanMessage {}
    expect(() =>
      canonicalCheckpointValueDigest(
        new DerivedHuman({
          id: "actual-subclass",
          content: body
        })
      )
    ).toThrow(invalid)
    expect(() =>
      canonicalCheckpointValueDigest(
        new AIMessageChunk({
          id: "actual-partial",
          content: body
        })
      )
    ).toThrow(invalid)
    expect(traps).toBe(0)
  })

  it("requires the fixed own native brand and rejects unknown symbols with getter zero", () => {
    let getters = 0
    for (const kind of ["missing", "false", "accessor"] as const) {
      const message = new HumanMessage({ id: `actual-brand-${kind}`, content: body })
      if (kind === "missing") Reflect.deleteProperty(message, nativeBrand)
      else
        Object.defineProperty(
          message,
          nativeBrand,
          kind === "false"
            ? { value: false }
            : {
                get() {
                  getters++
                  return true
                }
              }
        )
      expect(() => canonicalCheckpointValueDigest(message)).toThrow(
        kind === "accessor" ? "MODS_NATIVE_CAPTURE_ACCESSOR" : "MODS_NATIVE_CAPTURE_INVALID"
      )
    }
    const message = new HumanMessage({ id: "actual-extra-symbol", content: body })
    Object.defineProperty(message, Symbol("unknown checkpoint symbol"), { value: true })
    expect(() => canonicalCheckpointValueDigest(message)).toThrow("MODS_NATIVE_CAPTURE_INVALID")
    expect(getters).toBe(0)
  })

  it("fingerprints repeated subtrees but rejects an actual cycle through a native own extra", () => {
    const shared = { complete: body }
    const repeated = { kind: "exit", object: shared, repeated: shared }
    expect(canonicalCheckpointValueDigest(repeated)).toBe(
      canonicalCheckpointValueDigest(structuredClone(repeated))
    )
    const message = new HumanMessage({ id: "actual-cycle", content: body })
    Object.defineProperty(message, "checkpointExtra", { value: { back: message } })
    expect(() => canonicalCheckpointValueDigest(message)).toThrow(invalid)
  })

  it("keeps the global expanded-node limit for repeated checkpoint subtrees beside native messages", () => {
    let subtree: unknown = { original: body }
    for (let depth = 0; depth < 20; depth++) subtree = { left: subtree, right: subtree }
    const value = { message: new HumanMessage({ id: "actual-budget", content: body }), subtree }
    expect(() => canonicalCheckpointValueDigest(value)).toThrow(invalid)
  })

  it("preserves the existing fingerprint of ordinary checkpoint data and real Dates", () => {
    const date = new Date(123)
    const value = { nested: [body, undefined, null, true, 4], date, repeated: date }
    expect(canonicalCheckpointValueDigest(value)).toBe(canonicalDisplayValueDigest(value))
    expect(canonicalCheckpointValueDigest(value)).toBe(
      canonicalCheckpointValueDigest({
        ...value,
        date: new Date(123),
        repeated: new Date(123)
      })
    )
  })
})
