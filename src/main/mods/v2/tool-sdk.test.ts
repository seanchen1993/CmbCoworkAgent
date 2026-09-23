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
    { tool: "execute", command: "echo ok", run_in_background: "true" },
    { tool: "read_file", file_path: "x", offset: -1 },
    { tool: "read_file", file_path: "x", encoding: "base64" },
    { tool: "write_file", file_path: "x", content: 1 },
    { tool: "write_file", file_path: "x", content: "x".repeat(16000) }
  ]
  for (const input of inputs) expect(() => functionToolTarget(input)).toThrow("MODS_TOOL_ARGUMENTS")
  expect(() => functionToolTarget({ tool: "constructor" })).toThrow("MODS_TOOL_UNAVAILABLE")
})

it("accepts the background and polling arguments the native host implements", () => {
  expect(
    functionToolTarget({ tool: "execute", command: "node job.cjs", run_in_background: true })
  ).toEqual({ target: "host:execute", args: { command: "node job.cjs", run_in_background: true } })
  expect(
    functionToolTarget({ tool: "task_output", task_id: "task", block: false, timeout: 0 })
  ).toEqual({ target: "host:task_output", args: { task_id: "task", block: false, timeout: 0 } })
  expect(
    functionToolTarget({ tool: "task_output", task_id: "task", block: true, timeout: 600000 })
  ).toEqual({ target: "host:task_output", args: { task_id: "task", block: true, timeout: 600000 } })
})

it("rejects polling type/range errors and unsupported official fields instead of dropping them", () => {
  const inputs: ModObject[] = [
    { tool: "task_output", task_id: "task", block: 1 },
    { tool: "task_output", task_id: "task", timeout: -1 },
    { tool: "task_output", task_id: "task", timeout: 600001 },
    { tool: "task_output", task_id: "task", timeout: "100" },
    { tool: "execute", command: "echo ok", timeout: 100 },
    { tool: "execute", command: "echo ok", description: "Show output" },
    { tool: "execute", command: "echo ok", dangerouslyDisableSandbox: true },
    { tool: "read_file", file_path: "document.pdf", pages: "1-2" }
  ]
  for (const input of inputs) expect(() => functionToolTarget(input)).toThrow("MODS_TOOL_ARGUMENTS")
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
