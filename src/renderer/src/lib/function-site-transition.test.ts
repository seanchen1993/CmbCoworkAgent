import { expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { retainsFunctionSitePresentation as retains } from "./function-site-transition"

it("allows bounded dock geometry and working progress", () => {
  const before = JSON.stringify({ isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 })
  expect(
    retains("AbovePrompt", before, { isWorking: true, bodyColumns: 80, maxRows: 8, offset: 0 })
  ).toBe(true)
  expect(
    retains("AbovePrompt", before, { isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 })
  ).toBe(false)
  expect(
    retains("AbovePrompt", before, { isWorking: true, bodyColumns: 81, maxRows: 8, offset: 0 })
  ).toBe(true)
  expect(retains("AbovePrompt", before, { isWorking: true, bodyColumns: 80, maxRows: 8 })).toBe(
    false
  )
})
it.each(["AbovePrompt", "ChatHeader"] as const)("retains %s across bounded layout and scroll changes", component => {
  const facts = { isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 }
  const before = JSON.stringify(facts)
  expect(retains(component, before, { ...facts, offset: 20 })).toBe(true)
  expect(retains(component, before, { ...facts, offset: 20, isWorking: true })).toBe(true)
  expect(retains(component, before, { ...facts, bodyColumns: 40, maxRows: 3 })).toBe(true)
  const invalid: ModObject[] = [{ offset: -1 }, { offset: 100001 }, { offset: 0.5 },
    { bodyColumns: 0 }, { bodyColumns: 1001 }, { bodyColumns: 1.5 },
    { maxRows: 0 }, { maxRows: 13 }, { maxRows: 1.5 }, { offset: 20, extra: true }]
  for (const patch of invalid)
    expect(retains(component, before, { ...facts, ...patch })).toBe(false)
})
it("allows assistant tail appends but rejects replacements, rollback and other fact changes", () => {
  const before = JSON.stringify({ text: "protected prefix", isFirstOfReply: true })
  expect(
    retains("AssistantMessage", before, { text: "protected prefix added", isFirstOfReply: true })
  ).toBe(true)
  for (const text of ["protected", "replacement", "", "protected prefix"])
    expect(retains("AssistantMessage", before, { text, isFirstOfReply: true })).toBe(false)
  expect(
    retains("AssistantMessage", before, { text: "protected prefix added", isFirstOfReply: false })
  ).toBe(false)
  expect(
    retains("UserMessage", before, { text: "protected prefix added", isFirstOfReply: true })
  ).toBe(false)
})

it("limits Spinner retention to plain display word and mode updates", () => {
  const before = JSON.stringify({ word: "Thinking", message: null, suffix: "", mode: "thinking" })
  expect(
    retains("Spinner", before, { word: "Working", message: null, suffix: "", mode: "tool-use" })
  ).toBe(true)
  expect(
    retains("Spinner", before, {
      word: "Working",
      message: "new text",
      suffix: "",
      mode: "tool-use"
    })
  ).toBe(false)
  expect(
    retains("Spinner", before, { word: "Working", message: null, suffix: "new", mode: "tool-use" })
  ).toBe(false)
  expect(retains("Spinner", before, JSON.parse(before))).toBe(false)
})

it("limits tool progress to stable ordered identities and inputs without errors or interruption", () => {
  const call = {
    tool_use_id: "tool-1",
    tool: "read_file",
    input: { path: "a" },
    isRunning: true,
    isErrored: false,
    isInterrupted: false
  }
  const before = JSON.stringify({ calls: [call], isActive: true, isExpanded: false })
  const next = {
    calls: [{ ...call, isRunning: false, output: "done" }],
    isActive: false,
    isExpanded: false
  }
  expect(retains("ToolGroup", before, next)).toBe(true)
  for (const patch of [
    { tool_use_id: "tool-2" },
    { tool: "write_file" },
    { input: { path: "b" } },
    { isErrored: true },
    { isInterrupted: true }
  ])
    expect(retains("ToolGroup", before, { ...next, calls: [{ ...next.calls[0], ...patch }] })).toBe(
      false
    )
  expect(retains("ToolGroup", before, { ...next, calls: [...next.calls, next.calls[0]] })).toBe(
    false
  )
  expect(
    retains("ToolGroup", JSON.stringify(next), {
      ...next,
      calls: [{ ...next.calls[0], output: "replacement" }]
    })
  ).toBe(false)
  expect(retains("ToolGroup", before, { ...next, isExpanded: true })).toBe(false)
  expect(retains("ToolGroup", before, JSON.parse(before))).toBe(false)
})

it("lets a protected empty assistant frame settle during the first streamed token", () => {
  const before = JSON.stringify({ text: "", isFirstOfReply: true })
  expect(retains("AssistantMessage", before, { text: "first", isFirstOfReply: true })).toBe(true)
  expect(retains("AssistantMessage", before, { text: "first", isFirstOfReply: false })).toBe(false)
  expect(retains("AssistantMessage", before, { text: "", isFirstOfReply: true })).toBe(false)
  expect(retains("UserMessage", before, { text: "first", isFirstOfReply: true })).toBe(false)
})

it("retains an ordered tool prefix on append but rejects deletion, reorder and duplicate IDs", () => {
  const call = (id: string) => ({ tool_use_id: id, tool: "read_file", input: { path: id },
    isRunning: true, isErrored: false, isInterrupted: false })
  const a = call("a"), b = call("b"), c = call("c")
  const facts = (calls: ModObject[]) => ({ calls, isActive: true, isExpanded: false })
  const before = JSON.stringify(facts([a, b]))
  expect(retains("ToolGroup", before, facts([a, b, c]))).toBe(true)
  for (const calls of [[a], [b, a, c], [a, b, a], [a, b, { ...c, isErrored: true }],
    [a, b, { ...c, extra: true }], [a, { ...b, input: { path: "replacement" } }, c]])
    expect(retains("ToolGroup", before, facts(calls))).toBe(false)
})
