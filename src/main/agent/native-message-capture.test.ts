import { randomUUID, Hash } from "node:crypto"
import { once } from "node:events"
import { Worker } from "node:worker_threads"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import { captureNativeMessage, captureNativeMessageForOccurrence, constructCapturedNativeMessage,
  captureNativePartialMetadata, NATIVE_CAPTURE_MAX_EXPANDED_NODES } from "./native-message-capture"
import * as captureData from "./native-message-capture-data"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { NATIVE_POLICY_WORKER_SOURCE, NATIVE_POLICY_MAX_EXPANDED_NODES,
  NATIVE_POLICY_MIRROR_VERSION } from "./native-policy-worker"

describe("typed native message capture before raw serialization", () => {
  it("keeps the original Main exports identical to the Worker-safe data functions", () => {
    expect(captureNativeMessage).toBe(captureData.captureNativeMessage)
    expect(captureNativeMessageForOccurrence).toBe(captureData.captureNativeMessageForOccurrence)
    expect(captureNativePartialMetadata).toBe(captureData.captureNativePartialMetadata)
    expect(constructCapturedNativeMessage).toBe(captureData.constructCapturedNativeMessage)
    expect(NATIVE_CAPTURE_MAX_EXPANDED_NODES).toBe(captureData.NATIVE_CAPTURE_MAX_EXPANDED_NODES)
  })

  const mapIteratorPrototype = Object.getPrototypeOf(new Map().entries()) as object
  const collectionMethods: ReadonlyArray<readonly [object, PropertyKey, string]> = [
    [Map.prototype, "get", "map get"], [Map.prototype, "set", "map set"],
    [Map.prototype, "keys", "map keys"], [Map.prototype, "entries", "map entries"],
    [Map.prototype, Symbol.iterator, "map iterator"], [mapIteratorPrototype, "next", "map next"],
    [Set.prototype, "has", "set has"], [Set.prototype, "add", "set add"],
    [Set.prototype, "delete", "set delete"]
  ]
  it.each(collectionMethods.flatMap(([prototype, key, label]) =>
    (["getter", "replacement"] as const).map(kind => ({ prototype, key, label, kind }))))(
    "keeps complete raw capture independent of late $label $kind", ({ prototype, key, kind }) => {
      const raw = new AIMessage({ id: "actual-provider", content: "complete \ud800 body",
        tool_calls: [{ id: "actual-call", name: "actual-tool", args: {
          "2": "two", "1": "one", nested: ["\udfff", { actual: true }]
        } }], additional_kwargs: { original: [1, { present: null }] } })
      const uuid = "actual-occurrence", baseline = captureNativeMessageForOccurrence(raw, uuid)
      const original = Object.getOwnPropertyDescriptor(prototype, key)!
      let calls = 0, result: ReturnType<typeof captureNativeMessageForOccurrence> | undefined
      let error: unknown
      const unexpected = () => { calls++; throw Error("LATE_CAPTURE_COLLECTION_MUST_NOT_RUN") }
      Object.defineProperty(prototype, key, kind === "getter"
        ? { configurable: true, get: unexpected } : { ...original, value: unexpected })
      try { result = captureNativeMessageForOccurrence(raw, uuid) }
      catch (caught) { error = caught }
      finally { Object.defineProperty(prototype, key, original) }
      expect(error).toBeUndefined()
      expect(calls).toBe(0)
      expect(result).toEqual(baseline)
      raw.tool_calls![0].args.changed = true
      expect(captureNativeMessageForOccurrence(raw, uuid).originalDigest)
        .not.toBe(baseline.originalDigest)
    })

  it("does not admit an ordinary partial through either full-message typed entry point", () => {
    const raw = new AIMessageChunk({ id: "actual-partial", content: "uncompleted" })
    expect(() => captureNativeMessage(raw)).toThrow("MODS_NATIVE_CAPTURE_INVALID")
    expect(() => captureNativeMessageForOccurrence(raw, randomUUID()))
      .toThrow("MODS_NATIVE_CAPTURE_INVALID")
  })

  it.each(["", "ordinary", "中文", "\u0000", "\u{1f680}", "\ud800", "\udfff",
    "A\ud800\u0000\u{1f680}中\udfffZ"])(
    "preserves the original complete Buffer UTF16 digest for native content and keys (%#)", text => {
      const metadata = { "2": "numeric-second", "1": "numeric-first", [text]: text,
        ordinary: text, nested: [text, { [text]: text }] }
      const messages = [new HumanMessage({ id: "utf16-human", content: text,
        additional_kwargs: metadata }), new ToolMessage({ id: "utf16-tool", content: text,
        tool_call_id: "actual-call", artifact: metadata }),
      new AIMessage({ id: "utf16-ai", content: text, tool_calls: [{ id: "actual-call",
        name: "actual-tool", args: metadata, type: "tool_call" }] })]
      const modern = messages.map(message => ({ full: captureNativeMessage(message),
        occurrence: captureNativeMessageForOccurrence(message, "utf16-occurrence") }))
      const originalUpdate: (this: Hash, data: string | NodeJS.ArrayBufferView,
        encoding?: BufferEncoding) => Hash = Hash.prototype.update
      let originalBuffers = 0
      const spy = vi.spyOn(Hash.prototype, "update").mockImplementation(function(this: Hash,
        data: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) {
        if (typeof data === "string" && encoding === "utf16le") {
          originalBuffers++
          return originalUpdate.call(this, Buffer.from(data, "utf16le"))
        }
        return originalUpdate.call(this, data, encoding)
      })
      try {
        const legacy = messages.map(message => ({ full: captureNativeMessage(message),
          occurrence: captureNativeMessageForOccurrence(message, "utf16-occurrence") }))
        expect(legacy).toEqual(modern)
        expect(originalBuffers).toBeGreaterThan(0)
      } finally { spy.mockRestore() }
      messages[0].content = `${text} changed`
      expect(captureNativeMessage(messages[0]).digest).not.toBe(modern[0].full.digest)
    })

  it("normalizes a missing Tool result ID only in the typed occurrence copy", () => {
    const raw = new ToolMessage({ tool_call_id: "actual-call", content: "result", status: "success",
      artifact: { actual: true } })
    expect(() => captureNativeMessage(raw)).toThrow()
    const uuid = randomUUID(), copy = captureNativeMessageForOccurrence(raw, uuid)
    const safe = constructCapturedNativeMessage(copy.snapshot.type, { ...copy.snapshot.data })
    expect(safe.id).toBe(uuid)
    expect(ToolMessage.isInstance(safe) && safe.tool_call_id).toBe("actual-call")
    expect(ToolMessage.isInstance(safe) && safe.status).toBe("success")
    expect(ToolMessage.isInstance(safe) && safe.artifact).toEqual({ actual: true })
    expect(raw.id).toBeUndefined()
    expect(copy.originalId).toBeUndefined()
    expect(copy.originalDigest).not.toBe(copy.snapshot.digest)
    expect(captureNativeMessage(safe).digest).toBe(copy.snapshot.digest)
  })

  it("separates repeated provider IDs from actual occurrence UUIDs and preserves raw mutation proof", () => {
    const raw = new AIMessage({ id: "provider-repeated", content: "body",
      tool_calls: [{ id: "call", name: "ActualTool", args: { actual: true }, type: "tool_call" }] })
    const first = captureNativeMessageForOccurrence(raw, randomUUID())
    const second = captureNativeMessageForOccurrence(raw, randomUUID())
    expect(first.originalId).toBe("provider-repeated")
    expect(first.originalDigest).toBe(second.originalDigest)
    expect(first.snapshot.digest).not.toBe(second.snapshot.digest)
    expect(first.snapshot.data.tool_calls).toEqual(raw.tool_calls)
    raw.id = "changed-provider"
    const changed = captureNativeMessageForOccurrence(raw, String(first.snapshot.data.id))
    expect(changed.originalDigest).not.toBe(first.originalDigest)
    expect(changed.snapshot.digest).toBe(first.snapshot.digest)
  })

  it("rejects occurrence ID accessors, nonstrings and Proxy without executing raw methods", () => {
    let calls = 0
    for (const kind of ["accessor", "number", "proxy"] as const) {
      const raw = new HumanMessage({ content: "body" })
      if (kind === "accessor") Object.defineProperty(raw, "id", {
        get() { calls++; return "raw" }, configurable: true
      })
      if (kind === "number") Object.defineProperty(raw, "id", { value: 2 })
      const actual = kind === "proxy" ? new Proxy(raw, {
        getPrototypeOf() { calls++; return HumanMessage.prototype }
      }) : raw
      expect(() => captureNativeMessageForOccurrence(actual, randomUUID())).toThrow()
    }
    expect(calls).toBe(0)
  })

  it("includes original ID absence independently from an explicit undefined field", () => {
    const raw = new HumanMessage({ content: "body" }), uuid = randomUUID()
    Object.defineProperty(raw, "id", { value: undefined, writable: true, configurable: true })
    const explicit = captureNativeMessageForOccurrence(raw, uuid)
    Reflect.deleteProperty(raw, "id")
    const missing = captureNativeMessageForOccurrence(raw, uuid)
    expect(explicit.originalDigest).not.toBe(missing.originalDigest)
    expect(explicit.snapshot.digest).toBe(missing.snapshot.digest)
  })

  it("rejects a proxy before any message trap", () => {
    let traps = 0
    const message = new Proxy(new HumanMessage({ id: randomUUID(), content: "body" }), {
      getPrototypeOf() { traps++; return HumanMessage.prototype },
      ownKeys() { traps++; return [] },
      getOwnPropertyDescriptor() { traps++; return undefined }
    })
    expect(() => captureNativeMessage(message)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_PROXY" }))
    expect(traps).toBe(0)
  })

  it.each([{}, [], Buffer.from("bytes")])("rejects a nested proxy without traps (%#)", raw => {
    let traps = 0
    const value = new Proxy(raw, {
      getPrototypeOf() { traps++; return Object.prototype },
      ownKeys() { traps++; return [] },
      getOwnPropertyDescriptor() { traps++; return undefined }
    })
    const message = new HumanMessage({ id: randomUUID(), content: "body",
      additional_kwargs: { value } })
    expect(() => captureNativeMessage(message)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_PROXY" }))
    expect(traps).toBe(0)
  })

  it("does not execute payload getters or a raw message toJSON", () => {
    let calls = 0
    const value = Object.defineProperty({}, "body", { enumerable: true,
      get() { calls++; return "leak" } })
    const message = new HumanMessage({ id: randomUUID(), content: "body",
      additional_kwargs: { value } })
    expect(() => captureNativeMessage(message)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_ACCESSOR" }))
    Object.defineProperty(message, "toJSON", { value: () => { calls++; return {} } })
    expect(() => captureNativeMessage(message)).toThrow(expect.objectContaining({
      code: "MODS_NATIVE_CAPTURE_TYPE" }))
    expect(calls).toBe(0)
  })

  it("classifies actual binary before Buffer.toJSON and observes later byte mutation", () => {
    let calls = 0
    const bytes = Buffer.from("native binary")
    Object.defineProperty(bytes, "toJSON", { value: () => { calls++; return "leak" } })
    const view = new DataView(new Uint8Array([8, 9, 10]).buffer, 1, 2)
    const message = new ToolMessage({ id: randomUUID(), tool_call_id: "actual-call",
      content: "body", status: "success", artifact: { bytes, view,
        typed: new Uint16Array([1, 2]), buffer: new Uint8Array([3]).buffer } })
    const captured = captureNativeMessage(message)
    expect(captured.data.artifact).toEqual({ bytes: "[Binary output suppressed]",
      view: "[Binary output suppressed]", typed: "[Binary output suppressed]",
      buffer: "[Binary output suppressed]" })
    bytes[0] = 77
    expect(captureNativeMessage(message).digest).not.toBe(captured.digest)
    expect(calls).toBe(0)
  })

  it("uses own media/truncated facts and preserves a complete ordinary text block", () => {
    const message = new HumanMessage({ id: randomUUID(), content: [
      { type: "image_url", image_url: { url: "private media" } },
      { type: "text", text: "Complete ordinary text" }
    ], additional_kwargs: { output: { truncated: true, exitCode: 7, output: "partial" } } })
    const captured = captureNativeMessage(message)
    expect(captured.data.content).toEqual([
      { type: "text", text: "[Non-text output suppressed by project policy]" },
      { type: "text", text: "Complete ordinary text" }
    ])
    expect(captured.data.additional_kwargs).toEqual({ output: {
      truncated: true, exitCode: 7, output: "[Incomplete output suppressed by project policy]" } })
  })

  it("rejects cycles, unsupported objects and shared bytes without raw coercion", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [cycle, new Date(), new SharedArrayBuffer(8)]) {
      const message = new HumanMessage({ id: randomUUID(), content: "body",
        additional_kwargs: { value } })
      expect(() => captureNativeMessage(message)).toThrow()
    }
  })

  it.each(["subclass", "altered-prototype", "outside-length", "noncanonical-index"])(
    "rejects unsupported array structure without discarding it (%s)", kind => {
      const value: unknown[] = ["ordinary"]
      if (kind === "subclass") {
        class NativeArraySubclass extends Array<unknown> {}
        Object.setPrototypeOf(value, NativeArraySubclass.prototype)
      } else if (kind === "altered-prototype") Object.setPrototypeOf(value, null)
      else Object.defineProperty(value, kind === "outside-length" ? "4294967295" : "01", {
        value: "unobserved execution value", enumerable: true })
      const message = new AIMessage({ id: randomUUID(), content: "body", tool_calls: [
        { id: "call", name: "tool", type: "tool_call", args: { value } }
      ] })
      expect(() => captureNativeMessage(message)).toThrow(expect.objectContaining({
        code: "MODS_NATIVE_CAPTURE_TYPE" }))
    }
  )

  it("keeps normal array length and holes while recording structured suppression", () => {
    const value: unknown[] = new Array(3)
    value[2] = "last"
    const message = new HumanMessage({ id: randomUUID(), content: "body",
      additional_kwargs: { value } })
    const captured = captureNativeMessage(message)
    expect(captured.data.additional_kwargs).toEqual({ value: [undefined, undefined, "last"] })
    expect(captured.executionSuppressed).toBe(false)
    const ai = new AIMessage({ id: randomUUID(), content: "body", tool_calls: [
      { id: "call", name: "tool", type: "tool_call", args: { value } }
    ] })
    expect(captureNativeMessage(ai).executionSuppressed).toBe(true)
  })

  it.each([NATIVE_CAPTURE_MAX_EXPANDED_NODES, 4_294_967_295])(
    "rejects sparse expansion before enumerating its missing entries (%i)", length => {
      const sparse: unknown[] = new Array(length)
      sparse[length - 1] = "actual final field"
      const message = new HumanMessage({ id: randomUUID(), content: "complete body",
        additional_kwargs: { sparse } })
      let guards = 0
      expect(() => captureNativeMessage(message, () => { guards++ }))
        .toThrow(expect.objectContaining({ code: "MODS_NATIVE_CAPTURE_EXPANSION" }))
      expect(guards).toBeLessThan(100)
      expect(sparse.length).toBe(length)
      expect(sparse[length - 1]).toBe("actual final field")
    }
  )

  it.each([NATIVE_CAPTURE_MAX_EXPANDED_NODES, 4_294_967_295])(
    "uses the same pre-allocation expansion bound in a real policy Worker (%i)", async length => {
      expect(NATIVE_POLICY_MAX_EXPANDED_NODES).toBe(NATIVE_CAPTURE_MAX_EXPANDED_NODES)
      // Construct the sparse value inside the real Worker, without asking a main-thread
      // structured clone to expand its holes before the policy guard can examine it.
      const worker = new Worker(`${NATIVE_POLICY_WORKER_SOURCE}\n
const sparse=new Array(${length});sparse[${length - 1}]="actual final field";
require("node:worker_threads").parentPort.emit("message",{
  id:"sparse-expansion",version:"${NATIVE_POLICY_MIRROR_VERSION}",literals:[],value:{sparse}
});`, { eval: true })
      const exit = once(worker, "exit")
      try {
        const [response] = await once(worker, "message")
        expect(response).toEqual({ id: "sparse-expansion", version: NATIVE_POLICY_MIRROR_VERSION,
          ok: false, code: "MODS_NATIVE_CAPTURE_EXPANSION" })
        const [code] = await exit
        expect(code).toBe(0)
      } finally { await worker.terminate() }
    }
  )

  it("records suppression of execution args independently from the copied value", () => {
    const message = new AIMessage({ id: randomUUID(), content: "body", tool_calls: [
      { id: "call", name: "tool", type: "tool_call", args: { bytes: Buffer.from("raw") } }
    ] })
    const captured = captureNativeMessage(message)
    expect(captured.executionSuppressed).toBe(true)
    expect(captured.data.tool_calls).toEqual([
      { id: "call", name: "tool", type: "tool_call", args: { bytes: "[Binary output suppressed]" } }
    ])
  })

  it("preserves full UTF-16 mutation identity rather than collapsing unpaired surrogates", () => {
    const message = new HumanMessage({ id: randomUUID(), content: "\ud800" })
    const first = captureNativeMessage(message).digest
    message.content = "\ud801"
    expect(captureNativeMessage(message).digest).not.toBe(first)
  })

  it("rebuilds an already normalized AI v1 message without duplicate calls", () => {
    const message = new AIMessage({ id: randomUUID(), content: [{ type: "text", text: "body" }],
      tool_calls: [{ id: "call", name: "tool", args: { ordinary: "value" }, type: "tool_call" }],
      response_metadata: { output_version: "v1", provider: "actual-provider" },
      usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } })
    const captured = captureNativeMessage(message)
    const copied = constructCapturedNativeMessage(captured.type, { ...captured.data })
    expect(copied).toBeInstanceOf(AIMessage)
    expect(copied.content).toEqual(message.content)
    expect(captureNativeMessage(copied).data.tool_calls).toEqual(message.tool_calls)
    expect(serializeFunctionConversationNativeMessage(copied))
      .toBe(serializeFunctionConversationNativeMessage(message))
  })
})
