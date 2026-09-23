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
