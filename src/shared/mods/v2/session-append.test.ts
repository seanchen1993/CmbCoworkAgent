import { describe, expect, it } from "vitest"
import type { ModObject } from "../types"
import { MODS_MAX_BYTES } from "../validation"
import {
  FUNCTION_SESSION_APPEND_DOORS,
  normalizeFunctionSessionAppendInput,
  normalizeFunctionSessionMessagesArgs,
  validateFunctionSessionAppendArgs,
  validateFunctionSessionAppendInput,
  validateFunctionSessionAppendResultShape,
  validateFunctionSessionApiMessages,
  type FunctionApiContentBlock,
  type FunctionSessionAppendInput,
  type FunctionSessionAppendOrigin
} from "./session-append"

it("validates full API blocks and rejects hidden/accessor fields without evaluating them", () => {
  expect(() => validateFunctionSessionApiMessages([{ role: "assistant", content: [
    { type: "thinking", thinking: "full" }, { type: "future", data: [1, 2] }
  ] }])).not.toThrow()
  let calls = 0
  const invalid = { role: "user", content: [{ type: "text", text: "x" }] }
  Object.defineProperty(invalid, "authority", { enumerable: false,
    get() { calls++; return "fake" } })
  expect(() => validateFunctionSessionApiMessages([invalid])).toThrow()
  expect(calls).toBe(0)
  expect(() => validateFunctionSessionApiMessages([{ role: "system", content: [] }])).toThrow()
})

const text = (value: string): FunctionApiContentBlock => ({ type: "text", text: value })
const image: FunctionApiContentBlock = { type: "image", source: {
  type: "base64", media_type: "image/png", data: "actual-native-image"
} }
const document: FunctionApiContentBlock = { type: "document", source: {
  type: "url", url: "https://example.test/original.pdf"
} }
function baseline(content: FunctionApiContentBlock[] = [text("original")]): FunctionSessionAppendInput {
  return { door: "note", uuid: "actual-native-row", origin: { kind: "plugin", name: "Q" },
    agentId: "actual-child", message: { type: "user", role: "user", isMeta: true, content } }
}

describe("session.append SDK and read arguments", () => {
  it("allows only text notes and one-block notices, including empty text", () => {
    expect(() => validateFunctionSessionAppendArgs({ message: { type: "user", content: [] } }))
      .not.toThrow()
    for (const type of ["user", "system"])
      expect(() => validateFunctionSessionAppendArgs({ message: { type, content: [text("")] } }))
        .not.toThrow()
  })

  it.each([
    { message: { type: "assistant", content: [text("fake response")] } },
    { message: { type: "user", content: [image] } },
    { message: { type: "user", content: [{ type: "text", text: "note", authority: "fake" }] } },
    { message: { type: "system", content: [] } },
    { message: { type: "system", content: [text("one"), text("two")] } },
    { message: { type: "user", role: "user", isMeta: true, content: [] } },
    { message: { type: "user", content: [] }, origin: { kind: "composer" } },
    { message: { type: "user", content: [] }, uuid: "chosen-by-guest" },
    { message: { type: "user", content: [] }, agentId: "" },
    { message: { type: "user", content: [] }, source: "Q", writeLease: true }
  ])("rejects nontext or guest-selected native facts: %j", (input) => {
    expect(() => validateFunctionSessionAppendArgs(input)).toThrow()
  })

  it("validates agentId only as data and never constructs a child or authority", () => {
    const input = { message: { type: "user", content: [text("note")] }, agentId: "not-running" }
    expect(() => validateFunctionSessionAppendArgs(input)).not.toThrow()
    expect(input).not.toHaveProperty("authority")
    // The actual main registry must deny this selector; schema acceptance is not authorization.
    expect(normalizeFunctionSessionMessagesArgs({ as: "api", agentId: "not-running" }))
      .toEqual({ as: "api", agentId: "not-running" })
  })

  it("keeps default reads and API reads explicit without accepting SDK authority fields", () => {
    expect(normalizeFunctionSessionMessagesArgs(undefined)).toEqual({})
    expect(normalizeFunctionSessionMessagesArgs({})).toEqual({})
    expect(normalizeFunctionSessionMessagesArgs({ as: "api" })).toEqual({ as: "api" })
    for (const input of [{ as: "raw" }, { agentId: "" }, { authority: {} },
      { as: "api", branch: "future" }, { agentId: "child", threadId: "other" }])
      expect(() => normalizeFunctionSessionMessagesArgs(input)).toThrow()
  })

  it("does not invoke accessors or silently ignore hidden, symbolic and sparse fields", () => {
    let reads = 0
    const getter = {}
    Object.defineProperty(getter, "message", { enumerable: true,
      get() { reads++; throw Error("getter ran") } })
    const hidden = { message: { type: "user", content: [] } }
    Object.defineProperty(hidden, "authority", { value: "fake" })
    const symbolic = { message: { type: "user", content: [] }, [Symbol("proof")]: "fake" }
    const sparse = { message: { type: "user", content: new Array(1) } }
    for (const input of [getter, hidden, symbolic, sparse, new Date(),
      { message: { type: "user", content: [{ type: "text", text: undefined }] } }])
      expect(() => validateFunctionSessionAppendArgs(input)).toThrow()
    expect(reads).toBe(0)
  })

  it("enforces actual UTF-8 bytes, 30000 nodes and 32 raw levels rather than a message count", () => {
    expect(() => validateFunctionSessionAppendArgs({ message: { type: "user",
      content: [text("中".repeat(Math.floor(MODS_MAX_BYTES / 3) + 1))] } })).toThrow()
    expect(() => validateFunctionSessionAppendArgs({ message: { type: "user",
      content: Array.from({ length: 10001 }, () => text("")) } })).toThrow()
    let deep: ModObject = { type: "future" }
    for (let index = 0; index < 33; index++) deep = { type: "future", nested: deep }
    expect(() => validateFunctionSessionAppendInput(baseline([deep as FunctionApiContentBlock])))
      .toThrow()
  })
})

describe("session.append immutable native facts and allowed content", () => {
  it.each(FUNCTION_SESSION_APPEND_DOORS)("accepts the declared %s door as projection data", (door) => {
    expect(() => validateFunctionSessionAppendInput({ ...baseline(), door })).not.toThrow()
  })

  it.each<FunctionSessionAppendOrigin>([
    { kind: "composer" }, { kind: "bridge" }, { kind: "sdk" }, { kind: "task-notification" },
    { kind: "scheduled-trigger" }, { kind: "peer" }, { kind: "peer-send-message" },
    { kind: "projects-relay" }, { kind: "coordinator" }, { kind: "observer" },
    { kind: "observer-activity" }, { kind: "auto-continuation" }, { kind: "unclassified" },
    { kind: "slack-ping" }, { kind: "engine" }, { kind: "channel", server: "actual-channel" },
    { kind: "plugin", name: "Q", asUser: true }, { kind: "plugin", event: "tool.call" },
    { kind: "hook", event: "PostToolUse" }, { kind: "model", model: "actual-model" },
    { kind: "tool", tool: "actual-tool" }
  ])("retains the pinned origin spelling %j without minting permission", (origin) => {
    expect(() => validateFunctionSessionAppendInput({ ...baseline(), origin })).not.toThrow()
  })

  it("restores omitted top-level, message and whole-content fields without mutating baseline", () => {
    const source = baseline()
    const before = JSON.stringify(source)
    const output = normalizeFunctionSessionAppendInput({ message: {} }, source)
    expect(output).toEqual(source)
    expect(output).not.toBe(source)
    expect(output.message).not.toBe(source.message)
    expect(JSON.stringify(source)).toBe(before)
    expect(normalizeFunctionSessionAppendInput({}, source)).toEqual(source)
  })

  it.each([
    { uuid: "another-row" }, { door: "response" }, { origin: { kind: "composer" } },
    { agentId: "another-child" }, { message: { type: "assistant" } },
    { message: { name: "invented" } }, { message: { role: "assistant" } },
    { message: { isMeta: false } }, { message: { nativeReceipt: "copied-proof" } }
  ])("rejects an explicitly changed native fact: %j", (candidate) => {
    expect(() => normalizeFunctionSessionAppendInput(candidate, baseline()))
      .toThrow()
  })

  it("allows text changes and inserts while restoring omitted fixed block fields", () => {
    const source = baseline([
      { type: "thinking", thinking: "original thinking", signature: "actual-signature" },
      text("original text"), { type: "tool_use", id: "actual-call", name: "actual-tool",
        input: { file: "original.md" } }, { type: "future", actualData: { preserved: true } }
    ])
    const output = normalizeFunctionSessionAppendInput({ message: { content: [
      { type: "thinking" }, text("new text"), text("extra text"),
      { type: "tool_use", id: "actual-call" }, { type: "future" }
    ] } }, source)
    expect(output.message.content).toEqual([
      source.message.content[0], text("new text"), text("extra text"),
      source.message.content[2], source.message.content[3]
    ])
  })

  it("rejects missing, reordered or changed fixed occurrences instead of guessing reinsertion", () => {
    const source = baseline([
      { type: "thinking", thinking: "first", signature: "signature" },
      { type: "tool_use", id: "call", name: "tool", input: {} },
      { type: "future", value: 7 }
    ])
    const before = JSON.stringify(source)
    for (const content of [[], [text("only text")],
      [source.message.content[1], source.message.content[0], source.message.content[2]],
      [{ type: "thinking", thinking: "changed" }, source.message.content[1], source.message.content[2]],
      [source.message.content[0], { type: "tool_use", id: "other" }, source.message.content[2]]])
      expect(() => normalizeFunctionSessionAppendInput({ message: { content } }, source)).toThrow()
    expect(JSON.stringify(source)).toBe(before)
  })

  it("allows tool result content/error, restores its omitted actual ID and pins other fields", () => {
    const source = baseline([{ type: "tool_result", tool_use_id: "actual-call", content: "original",
      is_error: false, cache_control: { type: "ephemeral" } }])
    const result = normalizeFunctionSessionAppendInput({ message: { content: [
      { type: "tool_result", content: "protected replacement", is_error: true }
    ] } }, source)
    expect(result.message.content).toEqual([{ ...source.message.content[0],
      content: "protected replacement", is_error: true }])
    for (const block of [{ type: "tool_result", tool_use_id: "other" },
      { type: "tool_result", cache_control: { type: "changed" } },
      { type: "tool_result", is_error: "false" }])
      expect(() => normalizeFunctionSessionAppendInput({ message: { content: [block] } }, source))
        .toThrow()
  })

  it("moves or deletes original media but rejects additions, rewrites and duplicated occurrences", () => {
    const source = baseline([text("first"), image, document, text("last")])
    expect(normalizeFunctionSessionAppendInput({ message: { content: [document, text("edited"), image] } },
      source).message.content).toEqual([document, text("edited"), image])
    expect(normalizeFunctionSessionAppendInput({ message: { content: [text("no media")] } }, source)
      .message.content).toEqual([text("no media")])
    for (const content of [[image, image], [{ ...document, source: { type: "url", url: "other" } }],
      [{ type: "image", source: { type: "base64", data: "invented" } }]])
      expect(() => normalizeFunctionSessionAppendInput({ message: { content } }, source)).toThrow()
  })

  it("counts identical media as distinct actual occurrences without allowing a third copy", () => {
    const source = baseline([image, image])
    expect(normalizeFunctionSessionAppendInput({ message: { content: [image, image] } }, source)
      .message.content).toHaveLength(2)
    expect(() => normalizeFunctionSessionAppendInput({ message: { content: [image, image, image] } },
      source)).toThrow()
  })

  it("applies the same content constraints inside a real tool_result", () => {
    const source = baseline([{ type: "tool_result", tool_use_id: "call",
      content: [text("original"), image, { type: "future", fixed: "actual" }] }])
    const result = normalizeFunctionSessionAppendInput({ message: { content: [
      { type: "tool_result", content: [image, text("edited"), { type: "future" }] }
    ] } }, source)
    expect(result.message.content[0].content).toEqual([image, text("edited"),
      { type: "future", fixed: "actual" }])
    for (const content of ["drops fixed block", [image, image, { type: "future" }],
      [text("edit"), { type: "future", fixed: "changed" }]])
      expect(() => normalizeFunctionSessionAppendInput({ message: { content: [
        { type: "tool_result", content }
      ] } }, source)).toThrow()
  })

  it("keeps system notices without a model role and rejects mixed success/deny results", () => {
    const notice = { type: "system", name: "local_command", content: [text("notice")] }
    expect(() => validateFunctionSessionAppendResultShape({ uuid: "actual-row", message: notice }))
      .not.toThrow()
    expect(() => validateFunctionSessionAppendResultShape({ deny: "not stored" })).not.toThrow()
    for (const result of [{ deny: "" }, { deny: "no", uuid: "fake" },
      { uuid: "fake", message: { ...notice, role: "user" } },
      { uuid: "fake", message: { ...notice, content: [] } },
      { uuid: "fake", message: notice, receipt: "fake authority" }])
      expect(() => validateFunctionSessionAppendResultShape(result)).toThrow()
    // A copied JSON success can pass this shape check; only main once/core proof may accept it.
    expect(() => validateFunctionSessionAppendResultShape({ uuid: "copied-json", message: {
      type: "user", role: "user", isMeta: true, content: [text("not proof of storage")]
    } })).not.toThrow()
  })
})
