import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { expect, it } from "vitest"
import { TURN_COMPLETION_GATE_MARKER_PREFIX } from "../../../shared/checkpoint-transcript"
import {
  countFunctionSessionTurns,
  projectFunctionSessionMessages,
  readLiveFunctionSessionTranscript
} from "./session-transcript"

it("projects real graph messages, joins text blocks, pairs results and omits private metadata", () => {
  const messages = [
    new SystemMessage("private system instructions"),
    new HumanMessage("inspect"),
    new AIMessage({
      content: [
        { type: "text", text: "A" },
        { type: "text", text: "B" }
      ],
      tool_calls: [
        { id: "call", name: "read_file", args: { file_path: "README.md" }, type: "tool_call" }
      ],
      additional_kwargs: { reasoning_content: "private thinking" }
    }),
    new ToolMessage({
      content: [
        { type: "text", text: "C" },
        { type: "text", text: "D" }
      ],
      tool_call_id: "call",
      artifact: { count: 1 },
      status: "success",
      metadata: { private: "host" }
    }),
    new HumanMessage(`${TURN_COMPLETION_GATE_MARKER_PREFIX}empty_response]] internal`),
    new HumanMessage({
      content: "internal notification",
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    }),
    new AIMessage("done")
  ]
  expect(projectFunctionSessionMessages(messages)).toEqual([
    { role: "user", text: "inspect", toolUses: [] },
    {
      role: "assistant",
      text: "AB",
      toolUses: [
        {
          tool_use_id: "call",
          tool: "read_file",
          input: { file_path: "README.md" },
          result: { count: 1 },
          text: "CD"
        }
      ]
    },
    {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "call", text: "CD", isError: false, result: { count: 1 } }]
    },
    { role: "assistant", text: "done", toolUses: [] }
  ])
  expect(countFunctionSessionTurns(messages)).toBe(1)
})

it("matches frozen transcript shape for meta/virtual users and tool result errors", () => {
  const messages = [
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "user", isVirtual: true, message: { content: "virtual" } },
    {
      type: "user",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: { data: "not SDK text" } }
        ]
      }
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "x" } }]
      }
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: [{ type: "text", text: "failed" }],
            is_error: true
          }
        ]
      },
      toolUseResult: "actual failure"
    },
    { type: "progress", text: "not a message" }
  ]
  const value = projectFunctionSessionMessages(messages)
  expect(value).toHaveLength(3)
  expect(value[1].toolUses[0]).toEqual({
    tool_use_id: "call",
    tool: "Read",
    input: { file_path: "x" },
    result: "actual failure",
    text: "failed",
    isError: true
  })
  expect(countFunctionSessionTurns(messages)).toBe(1)
})

it("reads durable constructor envelopes and normal tool calls without duplicating content blocks", () => {
  const ai = new AIMessage({
    content: [{ type: "tool_use", id: "call", name: "read_file", input: { file_path: "x" } }],
    tool_calls: [{ id: "call", name: "read_file", args: { file_path: "x" }, type: "tool_call" }]
  })
  const result = projectFunctionSessionMessages([new HumanMessage("prompt").toJSON(), ai.toJSON()])
  expect(result[0]).toEqual({ role: "user", text: "prompt", toolUses: [] })
  expect(result[1].toolUses).toHaveLength(1)
  expect(result[1].toolUses[0]).not.toHaveProperty("result")
  expect(result[1].toolUses[0]).not.toHaveProperty("text")
})

it("pairs by chronological tool result occurrence and returns a detached data snapshot", () => {
  const input = { item: "original" }
  const messages = [
    new AIMessage({
      content: "first",
      tool_calls: [{ id: "same", name: "tool", args: input, type: "tool_call" }]
    }),
    new ToolMessage({ tool_call_id: "same", content: "old" }),
    new AIMessage({
      content: "second",
      tool_calls: [{ id: "same", name: "tool", args: {}, type: "tool_call" }]
    }),
    new ToolMessage({ tool_call_id: "same", content: "new" })
  ]
  const result = projectFunctionSessionMessages(messages)
  expect(result[0].toolUses[0].text).toBe("old")
  expect(result[2].toolUses[0].text).toBe("new")
  input.item = "changed"
  expect(result[0].toolUses[0].input.item).toBe("original")
  expect(result[0]).not.toHaveProperty("handle")
})

it("returns the newest 4096 eligible messages while turns count the whole source", () => {
  const messages = Array.from({ length: 5000 }, (_, index) => ({
    type: "human",
    content: String(index)
  }))
  const result = projectFunctionSessionMessages(messages)
  expect(result).toHaveLength(4096)
  expect(result[0].text).toBe("904")
  expect(result.at(-1)?.text).toBe("4999")
  expect(countFunctionSessionTurns(messages)).toBe(5000)
})

it("rejects oversized or malformed data without returning a lossy transcript", () => {
  expect(() =>
    projectFunctionSessionMessages([{ type: "user", content: "x".repeat(1048577) }])
  ).toThrow("MODS_JSON_SIZE")
  expect(() => projectFunctionSessionMessages([{ type: "tool", content: "reply" }])).toThrow(
    "MODS_SESSION_MESSAGES_INVALID"
  )
  expect(() =>
    projectFunctionSessionMessages([
      { type: "assistant", content: "", tool_calls: [{ name: "tool", id: "id", args: [] }] }
    ])
  ).toThrow("MODS_SESSION_MESSAGES_INVALID")
  expect(() => countFunctionSessionTurns(new Array(100001))).toThrow(
    "MODS_SESSION_MESSAGE_SCAN_LIMIT"
  )
})

it("yields long live scans, preserves the projection and rejects cancellation before publication", async () => {
  const messages = Array.from({ length: 5000 }, (_, index) => ({
    type: "human",
    content: String(index)
  }))
  const signal = new AbortController().signal
  let ticked = false
  setImmediate(() => {
    ticked = true
  })
  expect(
    await readLiveFunctionSessionTranscript(messages, "session.turns", signal, () => undefined)
  ).toBe(5000)
  expect(ticked).toBe(true)
  expect(
    await readLiveFunctionSessionTranscript(messages, "session.messages", signal, () => undefined)
  ).toEqual(projectFunctionSessionMessages(messages))
  for (const method of ["session.messages", "session.turns"] as const) {
    const controller = new AbortController()
    setImmediate(() => controller.abort(Error("cancelled scan")))
    await expect(
      readLiveFunctionSessionTranscript(messages, method, controller.signal, () => undefined)
    ).rejects.toThrow("cancelled scan")
  }
})
