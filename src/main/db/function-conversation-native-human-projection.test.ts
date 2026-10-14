import { describe, expect, it } from "vitest"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import { assertFunctionNativeHumanProjectionVariant,
  captureFunctionNativeHumanProjectionVariant, functionNativeHumanProjectionFreshColumns }
  from "./function-conversation-native-human-projection"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS,
  type FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"
import { captureFunctionNativeToolHumanProjectionVariant, functionNativeHumanProjectionKind } from
  "./function-conversation-native-human-projection"

/** Interface unit tests only; the presentation suite uses real Manager/AppDB/physical leases. */
function fixture() {
  const target: FunctionConversationRef = { logicalSessionId: "session", conversationId: "main",
    branchId: "branch", threadId: "thread", workspace: "workspace", kind: "main",
    checkpointNamespace: "", incarnation: { token: "actual-inc", legacyCreatedAt: 1 } }
  const context = { producer: {}, run: {}, occurrence: {}, target, threadId: "thread", uuid: "user" }
  let current = 0, candidates = 0, live = true
  const row: FunctionConversationRow = { uuid: "user", sequence: 1, receiptId: "receipt",
    branchId: "branch", inputDigest: "digest", door: "prompt", origin: { kind: "composer" },
    message: { type: "user", content: [{ type: "text", text: "safe" }] }, nativePayload: "native",
    orderAnchor: { kind: "unit" }, createdAt: 1, inbox: false, bytes: 6 }
  const token = captureFunctionNativeHumanProjectionVariant({ ...context,
    assertCurrent() { current++; if (!live) throw Error("ORIGINAL_SOURCE_CLOSED") },
    assertCandidate(value) { candidates++; if (value !== row) throw Error("FOREIGN_CANDIDATE") } })
  return { context, token, row, counts: () => ({ current, candidates }), close: () => { live = false } }
}

describe("private data-only native Human projection adapter", () => {
  function columns(): FunctionConversationProjectionColumns {
    return Object.freeze(Object.fromEntries(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key =>
      [key, key === "thread_id" ? "thread" : key === "message_id" ? "user" : key === "role" ? "user"
        : key === "content_json" ? JSON.stringify("original") : key === "created_at" ? 1
          : key === "ordinal" || key === "stream_authority" ? 0 : null]))) as
      FunctionConversationProjectionColumns
  }
  it("does not give an ordinary variant fresh-write permission", () => {
    const f = fixture()
    expect(functionNativeHumanProjectionFreshColumns(f.token, f.context, undefined)).toBeUndefined()
  })
  it("does not turn a public kind label into a real Tool-Human producer", () => {
    const f = fixture(), input = { ...f.context, kind: "tool-side",
      assertCurrent: () => undefined, assertCandidate: () => undefined }
    const ordinary = captureFunctionNativeHumanProjectionVariant(input)
    expect(functionNativeHumanProjectionKind(ordinary)).toBe("input")
    expect(functionNativeHumanProjectionFreshColumns(ordinary, f.context, undefined)).toBeUndefined()
    expect(() => functionNativeHumanProjectionKind({ ...ordinary })).toThrow()
  })
  it("requires an actual private ToolReturn source before opening the specialized fresh branch", () => {
    const f = fixture()
    const source = {} as Parameters<typeof captureFunctionNativeToolHumanProjectionVariant>[0]["source"]
    expect(() => captureFunctionNativeToolHumanProjectionVariant({ ...f.context, source,
      assertCurrent: () => undefined, assertCandidate: () => undefined }))
      .toThrow("MODS_CONVERSATION_TOOL_HUMAN_INVALID")
    expect(f.counts()).toEqual({ current: 1, candidates: 0 })
  })
  it("pins the original existing baseline and rejects any later differing source column", () => {
    const f = fixture(), baseline = columns()
    const token = captureFunctionNativeHumanProjectionVariant({ ...f.context,
      transcript: { baseline, freshColumns: undefined }, assertCurrent: () => undefined,
      assertCandidate: () => undefined })
    expect(functionNativeHumanProjectionFreshColumns(token, f.context, baseline)).toBeUndefined()
    expect(() => functionNativeHumanProjectionFreshColumns(token, f.context,
      { ...baseline, stream_authority: 7 })).toThrow()
    expect(() => functionNativeHumanProjectionFreshColumns(token, f.context, undefined)).toThrow()
  })
  it("copies exact private skipped-input columns without accepting a present UI baseline", () => {
    const f = fixture(), freshColumns = columns()
    const token = captureFunctionNativeHumanProjectionVariant({ ...f.context,
      transcript: { baseline: undefined, freshColumns }, assertCurrent: () => undefined,
      assertCandidate: () => undefined })
    const value = functionNativeHumanProjectionFreshColumns(token, f.context, undefined)
    expect(value).toEqual(freshColumns)
    expect(value).not.toBe(freshColumns)
    expect(Object.isFrozen(value)).toBe(true)
    expect(() => functionNativeHumanProjectionFreshColumns(token, f.context, columns())).toThrow()
    expect(() => functionNativeHumanProjectionFreshColumns({ ...token }, f.context, undefined)).toThrow()
  })
  it("pins the exact factory identities and calls the original source before and after candidate", () => {
    const f = fixture()
    assertFunctionNativeHumanProjectionVariant(f.token, f.context, f.row)
    expect(f.counts()).toEqual({ current: 3, candidates: 1 })
    expect(Object.isFrozen(f.token)).toBe(true)
  })

  it.each(["producer", "run", "occurrence", "threadId", "uuid"] as const)(
    "rejects replacement %s without borrowing the original source", key => {
      const f = fixture(), replacement = ["threadId", "uuid"].includes(key) ? "other" : {}
      expect(() => assertFunctionNativeHumanProjectionVariant(f.token,
        { ...f.context, [key]: replacement })).toThrow()
      expect(f.counts()).toEqual({ current: 1, candidates: 0 })
    })

  it("does not allow a cloned private token or a new branch", () => {
    const f = fixture()
    expect(() => assertFunctionNativeHumanProjectionVariant({ ...f.token }, f.context)).toThrow()
    expect(() => assertFunctionNativeHumanProjectionVariant(f.token,
      { ...f.context, target: { ...f.context.target, branchId: "future-branch" } })).toThrow()
  })

  it("propagates the original source error and never calls the candidate after it", () => {
    const f = fixture()
    f.close()
    expect(() => assertFunctionNativeHumanProjectionVariant(f.token, f.context, f.row))
      .toThrow("ORIGINAL_SOURCE_CLOSED")
    expect(f.counts()).toEqual({ current: 2, candidates: 0 })
  })

  it.each(["context-getter", "context-proxy", "kind-coercion"] as const)(
    "rejects %s with zero foreign behavior", kind => {
      const f = fixture()
      let behavior = 0
      if (kind === "context-getter") {
        Object.defineProperty(f.context, "producer", {
          enumerable: true, get: () => { behavior++; return {} } })
        expect(() => assertFunctionNativeHumanProjectionVariant(f.token, f.context)).toThrow()
      } else if (kind === "context-proxy") {
        const proxy = new Proxy(f.context, { ownKeys: () => { behavior++; return [] },
          get: () => { behavior++; return {} } })
        expect(() => assertFunctionNativeHumanProjectionVariant(f.token, proxy)).toThrow()
      } else {
        const target = { ...f.context.target }
        Object.defineProperty(target, "kind", { enumerable: true,
          value: { toString: () => { behavior++; return "main" } } })
        expect(() => captureFunctionNativeHumanProjectionVariant({ ...f.context, target,
          assertCurrent: () => undefined, assertCandidate: () => undefined })).toThrow()
      }
      expect(behavior).toBe(0)
    })

  it("rejects an asynchronous source result without invoking a then getter", () => {
    const f = fixture()
    let thenReads = 0
    const thenable = Object.defineProperty({}, "then", {
      get: () => { thenReads++; return () => undefined } })
    expect(() => captureFunctionNativeHumanProjectionVariant({ ...f.context,
      assertCurrent: () => thenable, assertCandidate: () => undefined })).toThrow()
    expect(thenReads).toBe(0)
  })
})
