import { expect, it } from "vitest"
import { functionToolTarget, validateFunctionToolResult } from "./tool-sdk"
import type { ModObject } from "../../../shared/mods/types"

it("removes host identity fields without permitting arbitrary adapter arguments", () => {
  expect(
    functionToolTarget({
      tool: "edit_file",
      file_path: "x",
      old_string: "a",
      new_string: "b",
      replace_all: false,
      tool_use_id: "ignored",
      agentId: "ignored"
    })
  ).toEqual({
    target: "host:edit_file",
    args: { file_path: "x", old_string: "a", new_string: "b", replace_all: false }
  })
  const inputs: ModObject[] = [
    { tool: "execute", command: "echo ok", run_in_background: true },
    { tool: "read_file", file_path: "x", offset: -1 },
    { tool: "read_file", file_path: "x", encoding: "base64" },
    { tool: "write_file", file_path: "x", content: 1 },
    { tool: "write_file", file_path: "x", content: "x".repeat(16000) }
  ]
  for (const input of inputs) expect(() => functionToolTarget(input)).toThrow("MODS_TOOL_ARGUMENTS")
  expect(() => functionToolTarget({ tool: "constructor" })).toThrow("MODS_TOOL_UNAVAILABLE")
})

it("validates operation results without accepting malformed context or flags", () => {
  const valid: ModObject[] = [
    { deny: "refused" },
    { result: "ok", text: "ok" },
    { result: null, isError: true },
    { result: {}, context: ["reminder"] }
  ]
  for (const result of valid) expect(() => validateFunctionToolResult(result)).not.toThrow()
  const invalid: ModObject[] = [
    { result: "ok", deny: "refused" },
    { text: "missing result" },
    { result: {}, isError: false },
    { result: {}, context: [1] },
    { result: {}, context: ["x".repeat(32001)] }
  ]
  for (const result of invalid)
    expect(() => validateFunctionToolResult(result)).toThrow("MODS_TOOL_RESULT")
})
