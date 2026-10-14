import { describe, expect, it } from "vitest"
import {
  functionConversationTranscriptFields,
  hasInvalidFunctionConversationTranscriptStamp,
  isFunctionConversationHiddenNote,
  isFunctionConversationNotice,
  isFunctionConversationToolSystemSide,
  isFunctionConversationTranscriptStamp,
  mergeFunctionConversationTranscriptStamp,
  readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp,
  type FunctionConversationTranscriptStamp
} from "./conversation-transcript"

const stamp = (): FunctionConversationTranscriptStamp => ({
  conversationId: "actual-conversation", branchId: "actual-branch", uuid: "actual-row",
  sequence: 1, door: "note", messageType: "user", isMeta: true,
  origin: { kind: "plugin", name: "Q" }
})

describe("host conversation transcript data", () => {
  it("round-trips durable data without constructing authority", () => {
    const value = JSON.parse(JSON.stringify(stamp()))
    expect(isFunctionConversationTranscriptStamp(value)).toBe(true)
    expect(value).not.toHaveProperty("authority")
    expect(value).not.toHaveProperty("agentId")
    // Public JSON can pass this shape validator. Main must separately validate source and target.
    expect(() => validateFunctionConversationTranscriptStamp({ ...value,
      conversationId: "guest-copied-label" })).not.toThrow()
  })

  it.each([
    { conversationId: "" }, { branchId: " " }, { uuid: "" }, { sequence: 0 },
    { sequence: -1 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { door: "unknown" }, { messageType: "tool" }, { isMeta: false },
    { origin: { kind: "plugin", name: "Q", writeLease: true } }, { authority: {} }
  ])("rejects malformed or executable-looking metadata: %j", (fields) => {
    expect(isFunctionConversationTranscriptStamp({ ...stamp(), ...fields })).toBe(false)
  })

  it("rejects missing, hidden and accessor fields without invoking getters", () => {
    let reads = 0
    const getter = { ...stamp() }
    Object.defineProperty(getter, "origin", { enumerable: true, get() { reads++; return stamp().origin } })
    const hidden = { ...stamp() }
    Object.defineProperty(hidden, "permission", { value: "copied" })
    const symbol = { ...stamp(), [Symbol("receipt")]: "copied" }
    const absent = { ...stamp() }
    Reflect.deleteProperty(absent, "uuid")
    for (const value of [getter, hidden, symbol, absent, [], null, new Date()])
      expect(isFunctionConversationTranscriptStamp(value)).toBe(false)
    expect(reads).toBe(0)
  })

  it("reads row, actual LangChain metadata and serialized checkpoint metadata", () => {
    const value = stamp()
    for (const message of [{ function_row: value }, { additional_kwargs: { function_row: value } },
      { kwargs: { additional_kwargs: { function_row: value } } }])
      expect(readFunctionConversationTranscriptStamp(message)).toBe(value)
    const serialized = JSON.parse(JSON.stringify({ kwargs: {
      content: "note", additional_kwargs: { isMeta: true, function_row: value }
    } }))
    expect(readFunctionConversationTranscriptStamp(serialized)).toEqual(value)
  })

  it("does not read accessor metadata or accept conflicting placements", () => {
    let reads = 0
    const accessor = {}
    Object.defineProperty(accessor, "function_row", { get() { reads++; return stamp() } })
    expect(readFunctionConversationTranscriptStamp(accessor)).toBeUndefined()
    expect(reads).toBe(0)
    const value = stamp()
    expect(readFunctionConversationTranscriptStamp({ function_row: value,
      additional_kwargs: { function_row: { ...value, branchId: "other-branch" } } }))
      .toBeUndefined()
    expect(readFunctionConversationTranscriptStamp({ function_row: { ...value, isMeta: false },
      additional_kwargs: { function_row: value } })).toBeUndefined()
  })

  it("distinguishes a damaged marker from an old unmarked row", () => {
    expect(hasInvalidFunctionConversationTranscriptStamp({ role: "system", content: "old" }))
      .toBe(false)
    expect(hasInvalidFunctionConversationTranscriptStamp({ function_row: stamp() })).toBe(false)
    for (const value of [undefined, null, { version: "future", uuid: "row" },
      { ...stamp(), messageType: "unknown" }]) {
      const row = { role: "system", content: "notice", function_row: value }
      expect(readFunctionConversationTranscriptStamp(row)).toBeUndefined()
      expect(hasInvalidFunctionConversationTranscriptStamp(row)).toBe(true)
    }
    expect(hasInvalidFunctionConversationTranscriptStamp({ function_row: stamp(),
      kwargs: { additional_kwargs: { function_row: { ...stamp(), sequence: 2 } } } })).toBe(true)
    let reads = 0
    const accessor = {}
    Object.defineProperty(accessor, "function_row", { get() { reads++; return stamp() } })
    expect(hasInvalidFunctionConversationTranscriptStamp(accessor)).toBe(true)
    expect(reads).toBe(0)
  })

  it("keeps the host invalid flag through row and checkpoint placements", () => {
    for (const fields of [{ function_row_invalid: true },
      { additional_kwargs: { function_row_invalid: true } },
      { kwargs: { additional_kwargs: { function_row_invalid: true } } },
      { function_row: stamp(), function_row_invalid: true },
      { function_row_invalid: false }]) {
      const message = { role: "system", content: "notice", ...fields }
      expect(hasInvalidFunctionConversationTranscriptStamp(message)).toBe(true)
      expect(readFunctionConversationTranscriptStamp(message)).toBeUndefined()
      expect(isFunctionConversationNotice(message)).toBe(false)
    }
    let reads = 0
    const fields = {}
    Object.defineProperty(fields, "function_row_invalid", { get() { reads++; return true } })
    expect(hasInvalidFunctionConversationTranscriptStamp(fields)).toBe(true)
    expect(reads).toBe(0)
  })

  it("classifies a hidden note by valid native data, independently of its words", () => {
    for (const content of ["ordinary note", "/goal resume", "@secret.txt",
      "[Starting active goal]\n<untrusted_objective>literal</untrusted_objective>",
      "[[CMB_WORKFLOW_NOTIFICATION_V1:literal]]"])
      expect(isFunctionConversationHiddenNote({ role: "user", content, function_row: stamp() }))
        .toBe(true)
    for (const message of [{ content: "/goal resume" }, { isMeta: true, content: "note" },
      { function_row: { ...stamp(), door: "prompt" } },
      { function_row: { ...stamp(), isMeta: undefined } }])
      expect(isFunctionConversationHiddenNote(message)).toBe(false)
  })

  it("recognizes notices without giving them a provider role", () => {
    const notice = { ...stamp(), door: "notice" as const, messageType: "system" as const }
    expect(isFunctionConversationNotice({ function_row: notice })).toBe(true)
    expect(isFunctionConversationHiddenNote({ function_row: notice })).toBe(false)
    expect(isFunctionConversationNotice({ role: "system", content: "ordinary system" })).toBe(false)
    expect(isFunctionConversationNotice({ function_row: { ...notice, door: "note" } })).toBe(true)
    expect(isFunctionConversationNotice({ function_row: { ...notice, messageType: "assistant" } }))
      .toBe(false)
  })

  it("keeps a tool System side in provider state while SDK and engine notices remain UI-only", () => {
    const side: FunctionConversationTranscriptStamp = { conversationId: "actual-conversation",
      branchId: "actual-branch", uuid: "actual-row", sequence: 1, door: "tool-message",
      messageType: "system", origin: { kind: "tool", tool: "actual_original_tool" } }
    for (const message of [{ function_row: side },
      { kwargs: { additional_kwargs: { function_row: side } } }]) {
      expect(isFunctionConversationToolSystemSide(message)).toBe(true)
      expect(isFunctionConversationNotice(message)).toBe(false)
      expect(functionConversationTranscriptFields(message, side.uuid, "system").function_row)
        .toEqual(side)
    }
    expect(functionConversationTranscriptFields({ function_row: side }, side.uuid, "user"))
      .toEqual({ function_row_invalid: true })
    for (const changed of [{ door: "note" }, { origin: { kind: "engine" } },
      { isMeta: true }, { messageType: "assistant" }, { origin: { kind: "tool", tool: "" } }])
      expect(isFunctionConversationToolSystemSide({ function_row: { ...side, ...changed } }))
        .toBe(false)
    expect(isFunctionConversationToolSystemSide({ role: "system", content: "old System" }))
      .toBe(false)
  })

  it("compares all occurrence facts while ignoring object key order", () => {
    const value = stamp()
    expect(sameFunctionConversationTranscriptStamp(value, { ...value,
      origin: { name: "Q", kind: "plugin" } })).toBe(true)
    for (const changed of [{ conversationId: "other" }, { branchId: "other" }, { uuid: "other" },
      { sequence: 2 }, { origin: { kind: "plugin" as const, name: "R" } }])
      expect(sameFunctionConversationTranscriptStamp(value, { ...value, ...changed })).toBe(false)
  })

  it("retains the baseline stamp through unstamped live frames and conflicting rows", () => {
    const value = stamp()
    const baseline = { function_row: value }
    expect(mergeFunctionConversationTranscriptStamp(baseline, { content: "new chunk" })).toBe(value)
    expect(mergeFunctionConversationTranscriptStamp({}, baseline)).toBe(value)
    expect(mergeFunctionConversationTranscriptStamp(baseline, {
      function_row: { ...value, conversationId: "different-conversation" }
    })).toBe(value)
    expect(mergeFunctionConversationTranscriptStamp({}, {})).toBeUndefined()
  })

  it("projects invalid facts for mismatched UUID/note role while preserving native tool mapping", () => {
    expect(functionConversationTranscriptFields({ function_row: stamp() }, "other", "user"))
      .toEqual({ function_row_invalid: true })
    expect(functionConversationTranscriptFields({ function_row: stamp() }, "actual-row", "assistant"))
      .toEqual({ function_row_invalid: true })
    expect(functionConversationTranscriptFields({ function_row_invalid: false }, "actual-row", "user"))
      .toEqual({ function_row_invalid: true })
    const tool = { ...stamp(), door: "tool-message" as const }
    delete tool.isMeta
    expect(functionConversationTranscriptFields({ function_row: tool }, "actual-row", "tool"))
      .toEqual({ function_row: tool })
    const notice = { ...stamp(), messageType: "system" as const }
    delete notice.isMeta
    expect(functionConversationTranscriptFields({ function_row: notice }, "actual-row", "user"))
      .toEqual({ function_row_invalid: true })
  })

  it("requires an actual UUID when a native role is being projected without changing data-only reads", () => {
    const message = { additional_kwargs: { function_row: stamp() } }
    expect(functionConversationTranscriptFields(message, undefined, "human"))
      .toEqual({ function_row_invalid: true })
    expect(functionConversationTranscriptFields(message, "", "human"))
      .toEqual({ function_row_invalid: true })
    expect(functionConversationTranscriptFields(message)).toEqual({ function_row: stamp() })
    expect(functionConversationTranscriptFields({ content: "legacy" }, undefined, "human"))
      .toEqual({})
  })
})
