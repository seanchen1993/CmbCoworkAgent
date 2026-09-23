import { expect, it } from "vitest"
import { normalizeFunctionInput } from "./pinned-input"

it("pins model call identity while allowing model selection", () => {
  const original = { turnId: "a", index: 2, messageCount: 5, model: "one" }
  expect(normalizeFunctionInput("turn.step", { ...original, model: "two" }, original)).toEqual({
    ...original,
    model: "two"
  })
  expect(() => normalizeFunctionInput("turn.step", { agentId: "different" }, original)).toThrow(
    "MODS_PINNED_INPUT"
  )
  expect(() => normalizeFunctionInput("turn.step", { index: 3 }, original)).toThrow(
    "MODS_PINNED_INPUT"
  )
  expect(() => normalizeFunctionInput("turn.step", { model: "two" }, original)).toThrow(
    "MODS_PINNED_INPUT"
  )
})

it("compares pinned objects structurally, independently of property insertion order", () => {
  expect(
    normalizeFunctionInput(
      "command.run",
      { origin: { name: "a", kind: "plugin" } },
      { origin: { kind: "plugin", name: "a" } }
    )
  ).toEqual({ origin: { kind: "plugin", name: "a" } })
  expect(() =>
    normalizeFunctionInput(
      "command.run",
      { origin: { kind: "composer" } },
      { origin: { kind: "plugin", name: "a" } }
    )
  ).toThrow("MODS_PINNED_INPUT")
})

it("pins classic tool identities while allowing argument rewrites", () => {
  const original = { tool: "write_file", tool_use_id: "call-1", path: "old.txt" }
  expect(normalizeFunctionInput("classic.PreToolUse", { path: "safe.txt" }, original)).toEqual({
    ...original,
    path: "safe.txt"
  })
  for (const changed of [
    { ...original, tool: "execute" },
    { ...original, tool_use_id: "other" }
  ])
    expect(() => normalizeFunctionInput("classic.PreToolUse", changed, original)).toThrow(
      "MODS_PINNED_INPUT"
    )
})

it("pins classic session and event base fields and restores omitted identities", () => {
  const original = {
    hook_event_name: "Stop",
    session_id: "thread",
    cwd: "/workspace",
    transcript_path: "/transcript",
    prompt_id: "prompt",
    agent_id: "agent",
    agent_type: "reviewer",
    permission_mode: "plan"
  }
  expect(normalizeFunctionInput("classic.Stop", {}, original)).toEqual(original)
  for (const key of Object.keys(original))
    expect(() =>
      normalizeFunctionInput("classic.Stop", { ...original, [key]: "forged" }, original)
    ).toThrow("MODS_PINNED_INPUT")
})


it("pins PostToolBatch execution facts as well as its common host identity", () => {
  const original={hook_event_name:"PostToolBatch",session_id:"thread",cwd:"/workspace",transcript_path:"",tool_calls:[{tool_name:"read_file",tool_use_id:"one",tool_input:{file_path:"a"},tool_response:"actual"}]}
  expect(normalizeFunctionInput("classic.PostToolBatch", {}, original)).toEqual(original)
  expect(()=>normalizeFunctionInput("classic.PostToolBatch",{...original,tool_calls:[]},original)).toThrow("MODS_PINNED_INPUT")
})

it("pins InstructionsLoaded source facts", () => {
  const original = {
    hook_event_name: "InstructionsLoaded",
    session_id: "thread",
    cwd: "/workspace",
    transcript_path: "",
    file_path: "/workspace/AGENTS.md",
    memory_type: "Project",
    load_reason: "session_start"
  }
  expect(normalizeFunctionInput("classic.InstructionsLoaded", {}, original)).toEqual(original)
  for (const key of ["file_path", "memory_type", "load_reason"])
    expect(() =>
      normalizeFunctionInput(
        "classic.InstructionsLoaded",
        { ...original, [key]: "forged" },
        original
      )
    ).toThrow("MODS_PINNED_INPUT")
})

it("pins explicit expansion identity and original command text", () => {
  const original = { hook_event_name: "UserPromptExpansion", session_id: "thread", expansion_type: "slash_command", command_name: "review", command_args: "changes", command_source: "plugin", prompt: "/review changes" }
  expect(normalizeFunctionInput("classic.UserPromptExpansion", {}, original)).toEqual(original)
  for (const key of ["expansion_type", "command_name", "command_args", "command_source", "prompt"]) {
    expect(() => normalizeFunctionInput("classic.UserPromptExpansion", { ...original, [key]: "spoofed" }, original)).toThrow("MODS_PINNED_INPUT")
  }
})

const scroll = {
  component: "Pane",
  requestId: "board",
  offset: 10,
  by: 2,
  bodyRows: 5,
  contentRows: 40,
  origin: { kind: "plugin", name: "owner" }
}
it("only lets an imperative scroll hook rewrite offset and inherits omitted host geometry", () => {
  expect(normalizeFunctionInput("ui.scroll", { offset: 0 }, scroll)).toEqual({
    ...scroll,
    offset: 0
  })
})
it.each<import("../types").ModObject>([
  { by: 0 },
  { bodyRows: 0 },
  { contentRows: 200 },
  { requestId: "other" },
  { origin: { kind: "person" } },
  { pointer: { row: 1 } },
  { offset: "3" }
])("refuses fabricated imperative scroll input %j", (change) => {
  expect(() => normalizeFunctionInput("ui.scroll", { ...scroll, ...change }, scroll)).toThrow()
})
it("preserves the existing legacy wheel observation envelope", () => {
  const before = { plugin: "demo", component: "Pane", value: { deltaY: 1, top: 20 } }
  expect(normalizeFunctionInput("ui.scroll", before, before)).toEqual(before)
})
