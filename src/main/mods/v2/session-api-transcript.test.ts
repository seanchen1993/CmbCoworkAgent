import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { expect, it } from "vitest"
import type { FunctionConversationTranscriptStamp } from "../../../shared/mods/v2/conversation-transcript"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"

const noteStamp = (): FunctionConversationTranscriptStamp => ({
  conversationId: "actual-conversation", branchId: "actual-branch", uuid: "actual-note",
  sequence: 1, door: "note", messageType: "user", isMeta: true,
  origin: { kind: "plugin", name: "P" }
})

it("preserves actual media, thinking, unknown blocks and tool results without UI summaries", () => {
  const unknown = { type: "future-provider-block", data: { nested: ["a", 7] } }
  const media = { type: "image", source: { type: "base64", media_type: "image/png", data: "pixel" } }
  const document = { type: "document", source: { type: "text", data: "full document" } }
  const messages = [new SystemMessage("system notice"), new HumanMessage({
    content: [{ type: "text", text: "prompt" }, media, document]
  }), new AIMessage({ content: [{ type: "thinking", thinking: "reason" }, unknown],
    tool_calls: [{ id: "t", name: "read_file", args: { path: "a" }, type: "tool_call" }] }),
  new ToolMessage({ tool_call_id: "t", status: "error",
    content: [{ type: "text", text: "failed" }, unknown] })]
  expect(projectFunctionSessionApiMessages(messages)).toEqual([
    { role: "user", content: [{ type: "text", text: "prompt" }, media, document] },
    { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, unknown,
      { type: "tool_use", id: "t", name: "read_file", input: { path: "a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true,
      content: [{ type: "text", text: "failed" }, unknown] }] }
  ])
})

it("joins exact call occurrences while preserving legitimate repeated or different calls", () => {
  const call = { type: "tool_use", id: "same", name: "x", input: { a: 1 } }
  const value = { type: "ai", content: [call], tool_calls: [
    { id: "same", name: "x", args: { a: 1 } },
    { id: "same", name: "x", args: { a: 1 } },
    { id: "same", name: "x", args: { a: 2 } }
  ] }
  expect(projectFunctionSessionApiMessages([value])[0].content).toEqual([
    call, call, { type: "tool_use", id: "same", name: "x", input: { a: 2 } }
  ])
})

it("reads actual constructor envelopes and rejects invalid content instead of truncating", () => {
  const ai = new AIMessage({ content: "answer", additional_kwargs: { reasoning_content: "thought" } })
  expect(projectFunctionSessionApiMessages([ai.toJSON()])).toEqual([
    { role: "assistant", content: [{ type: "text", text: "answer" },
      { type: "thinking", thinking: "thought" }] }
  ])
  expect(() => projectFunctionSessionApiMessages([{ type: "tool", tool_call_id: "", content: "x" }]))
    .toThrow("MODS_SESSION_MESSAGES_INVALID")
  expect(() => projectFunctionSessionApiMessages([new HumanMessage("中".repeat(400000))]))
    .toThrow("MODS_JSON_SIZE")
})

it("returns the bounded latest complete messages without including system or private notices", () => {
  const values = Array.from({ length: 4100 }, (_, index) => new HumanMessage(String(index)))
  const result = projectFunctionSessionApiMessages([...values, new SystemMessage("not a prompt")])
  expect(result).toHaveLength(4096)
  expect(result[0].content).toEqual([{ type: "text", text: "4" }])
  expect(result.at(-1)?.content).toEqual([{ type: "text", text: "4099" }])
  expect(projectFunctionSessionApiMessages([new HumanMessage({ content: "internal",
    additional_kwargs: { cmb_internal_coordinator_notification: true } })])).toEqual([])
})

it("reads a correlated native note and its constructor envelope without treating it as UI input", () => {
  const note = new HumanMessage({ id: "actual-note", content: "literal note",
    additional_kwargs: { isMeta: true, cmb_internal_coordinator_notification: true,
      function_row: noteStamp() } })
  const expected = [{ role: "user", content: [{ type: "text", text: "literal note" }] }]
  expect(projectFunctionSessionApiMessages([note])).toEqual(expected)
  expect(projectFunctionSessionApiMessages([note.toJSON()])).toEqual(expected)
  const notice = new SystemMessage({ id: "actual-note", content: "UI notice",
    additional_kwargs: { function_row: { ...noteStamp(), messageType: "system" } } })
  expect(projectFunctionSessionApiMessages([notice, notice.toJSON()])).toEqual([])
})

it("rejects copied UUIDs and missing native IDs rather than bypassing internal filtering", () => {
  const stamped = (id?: string) => new HumanMessage({ id, content: "private internal text",
    additional_kwargs: { isMeta: true, cmb_internal_coordinator_notification: true,
      function_row: noteStamp() } })
  for (const value of [stamped("other-row"), stamped("other-row").toJSON(), stamped(),
    stamped().toJSON(), { role: "user", content: "x", function_row: noteStamp() },
    { id: "other-envelope", message: { id: "actual-note", role: "user", content: "x",
      function_row: noteStamp() } }])
    expect(() => projectFunctionSessionApiMessages([value]))
      .toThrow("MODS_SESSION_MESSAGES_INVALID")
  // Old provider records need no host stamp or artificial UUID to remain readable.
  expect(projectFunctionSessionApiMessages([new HumanMessage("legacy")])).toEqual([
    { role: "user", content: [{ type: "text", text: "legacy" }] }
  ])
})

it("rejects note and notice stamps on the wrong actual native role", () => {
  const note = noteStamp()
  const notice = { ...note, messageType: "system" as const }
  const wrong = [new AIMessage({ id: note.uuid, content: "answer",
    additional_kwargs: { function_row: note } }),
  new SystemMessage({ id: note.uuid, content: "notice",
    additional_kwargs: { function_row: note } }),
  new HumanMessage({ id: note.uuid, content: "private",
    additional_kwargs: { function_row: notice } }),
  new AIMessage({ id: note.uuid, content: "answer",
    additional_kwargs: { function_row: notice } })]
  for (const value of wrong) {
    expect(() => projectFunctionSessionApiMessages([value]))
      .toThrow("MODS_SESSION_MESSAGES_INVALID")
    expect(() => projectFunctionSessionApiMessages([value.toJSON()]))
      .toThrow("MODS_SESSION_MESSAGES_INVALID")
  }
})
