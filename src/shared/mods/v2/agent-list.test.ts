import { expect, it } from "vitest"
import { validateFunctionAgentList, validateFunctionAgentListInput } from "./agent-list"
import type { ModJson } from "../types"
const row = { id: "actual-id", description: "Inspect", type: "Explore", status: "running" }
it("accepts observed agent states and optional provenance without inventing fields", () => {
  expect(() => validateFunctionAgentList([])).not.toThrow()
  expect(() =>
    validateFunctionAgentList([{ ...row, parentId: "parent", spawnedBy: "plugin", name: "worker" }])
  ).not.toThrow()
  expect(() => validateFunctionAgentList([{ ...row, status: "waiting-for-input" }])).not.toThrow()
})
it.each(
  (
    [
      null,
      {},
      [row, row],
      [{ ...row, id: "" }],
      [{ ...row, parentId: 2 }],
      [{ ...row, description: "x".repeat(4001) }],
      [{ ...row, type: "" }],
      [{ ...row, status: "" }],
      [{ ...row, spawnedBy: "" }],
      Array.from({ length: 101 }, (_, i) => ({ ...row, id: String(i) }))
    ] as ModJson[]
  ).map((value) => ({ value }))
)("rejects malformed, ambiguous or over-budget instance metadata", ({ value }) => {
  expect(() => validateFunctionAgentList(value)).toThrow("MODS_AGENT_LIST_RESULT")
})
it("does not allow guest-selected target threads or projects in a no-argument operation", () => {
  expect(() => validateFunctionAgentListInput({})).not.toThrow()
  expect(() => validateFunctionAgentListInput({ threadId: "other" })).toThrow(
    "MODS_AGENT_LIST_ARGUMENTS"
  )
  expect(() => validateFunctionAgentListInput({ workspace: "other" })).toThrow(
    "MODS_AGENT_LIST_ARGUMENTS"
  )
})
