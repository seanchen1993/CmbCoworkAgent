import { expect, it } from "vitest"
import { Command } from "@langchain/langgraph"
import { ToolMessage } from "@langchain/core/messages"
import { applyClassicToolOutput } from "./tool-output"
import type { HookResult } from "./types"

const hook = (value: unknown): HookResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  blocked: false,
  updatedToolOutput: value
})

it("leaves the original object unchanged when no output effect exists", () => {
  const original = { output: "real", exitCode: 1 }
  expect(applyClassicToolOutput(original, null)).toBe(original)
  expect(applyClassicToolOutput(original, { ...hook("x"), updatedToolOutput: undefined })).toBe(
    original
  )
})

it("replaces model-facing text while preserving execution failure and graph routing", () => {
  const other = new ToolMessage({ content: "unrelated", tool_call_id: "other" })
  const original = new Command({
    update: {
      flag: "host",
      messages: [
        other,
        new ToolMessage({
          content: "failure",
          tool_call_id: "call",
          id: "original",
          status: "error"
        })
      ]
    },
    goto: "host-route",
    graph: Command.PARENT,
    resume: { approved: false }
  })
  const result = applyClassicToolOutput(original, hook("display"), { toolCallId: "call" })
  expect(result.goto).toEqual(original.goto)
  expect(result.resume).toEqual(original.resume)
  expect(result.graph).toBe(original.graph)
  const update = result.update as { flag: string; messages: ToolMessage[] }
  expect(update.flag).toBe("host")
  expect(update.messages[0]).toBe(other)
  expect(update.messages[1]).toMatchObject({ content: "display", status: "error", id: "original" })
  expect(applyClassicToolOutput(original, hook("display"))).toBe(original)
})

it("preserves native write and process facts even when replacement claims success", () => {
  const write = { path: "/actual", error: "permission denied" }
  expect(applyClassicToolOutput(write, hook({ path: "/forged", error: null }))).toMatchObject(write)
  const process = { output: "stderr", exitCode: 7, truncated: false }
  expect(applyClassicToolOutput(process, hook("looks successful"))).toEqual({
    ...process,
    output: "looks successful"
  })
})

it("uses MCP-specific output only for MCP and retains actual host error identity", () => {
  const effects = {
    ...hook("generic"),
    updatedMCPToolOutput: { text: "mcp replacement", isError: false }
  }
  expect(applyClassicToolOutput("native", effects)).toBe("generic")
  const original = { capabilityId: "mcp:test", isError: true, text: "failed", contentBlocks: [] }
  const result = applyClassicToolOutput(original, effects, { mcp: true })
  expect(result.isError).toBe(true)
  expect(result.capabilityId).toBe(original.capabilityId)
  expect(result.text).toContain("mcp replacement")
  expect(original.text).toBe("failed")
})

it("treats null, false, zero and empty string as explicit replacements", () => {
  for (const value of [null, false, 0, ""])
    expect(applyClassicToolOutput("original", hook(value))).toBe(
      typeof value === "string" ? value : JSON.stringify(value)
    )
})
