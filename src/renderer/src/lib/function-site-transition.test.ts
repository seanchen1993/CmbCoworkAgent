import { expect, it } from "vitest"
import { retainsFunctionSitePresentation as retains } from "./function-site-transition"

it("allows only AbovePrompt working progress with identical remaining facts", () => {
  const before = JSON.stringify({ isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 })
  expect(retains("AbovePrompt", before, { isWorking: true, bodyColumns: 80, maxRows: 8, offset: 0 })).toBe(true)
  expect(retains("AbovePrompt", before, { isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 })).toBe(false)
  expect(retains("AbovePrompt", before, { isWorking: true, bodyColumns: 81, maxRows: 8, offset: 0 })).toBe(false)
  expect(retains("AbovePrompt", before, { isWorking: true, bodyColumns: 80, maxRows: 8 })).toBe(false)
})
it("allows assistant tail appends but rejects replacements, rollback and other fact changes", () => {
  const before = JSON.stringify({ text: "protected prefix", isFirstOfReply: true })
  expect(retains("AssistantMessage", before, { text: "protected prefix added", isFirstOfReply: true })).toBe(true)
  for (const text of ["protected", "replacement", "", "protected prefix"])
    expect(retains("AssistantMessage", before, { text, isFirstOfReply: true })).toBe(false)
  expect(retains("AssistantMessage", before, { text: "protected prefix added", isFirstOfReply: false })).toBe(false)
  expect(retains("UserMessage", before, { text: "protected prefix added", isFirstOfReply: true })).toBe(false)
})

it("limits Spinner retention to plain display word and mode updates", () => {
  const before = JSON.stringify({ word: "Thinking", message: null, suffix: "", mode: "thinking" })
  expect(retains("Spinner", before, { word: "Working", message: null, suffix: "", mode: "tool-use" })).toBe(true)
  expect(retains("Spinner", before, { word: "Working", message: "new text", suffix: "", mode: "tool-use" })).toBe(false)
  expect(retains("Spinner", before, { word: "Working", message: null, suffix: "new", mode: "tool-use" })).toBe(false)
  expect(retains("Spinner", before, JSON.parse(before))).toBe(false)
})

it("limits tool progress to stable ordered identities and inputs without errors or interruption", () => {
  const call = { tool_use_id: "tool-1", tool: "read_file", input: { path: "a" },
    isRunning: true, isErrored: false, isInterrupted: false }
  const before = JSON.stringify({ calls: [call], isActive: true, isExpanded: false })
  const next = { calls: [{ ...call, isRunning: false, output: "done" }], isActive: false, isExpanded: false }
  expect(retains("ToolGroup", before, next)).toBe(true)
  for (const patch of [{ tool_use_id: "tool-2" }, { tool: "write_file" }, { input: { path: "b" } },
    { isErrored: true }, { isInterrupted: true }])
    expect(retains("ToolGroup", before, { ...next, calls: [{ ...next.calls[0], ...patch }] })).toBe(false)
  expect(retains("ToolGroup", before, { ...next, calls: [...next.calls, next.calls[0]] })).toBe(false)
  expect(retains("ToolGroup", JSON.stringify(next), { ...next, calls: [{ ...next.calls[0], output: "replacement" }] })).toBe(false)
  expect(retains("ToolGroup", before, { ...next, isExpanded: true })).toBe(false)
  expect(retains("ToolGroup", before, JSON.parse(before))).toBe(false)
})
