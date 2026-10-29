import { describe, expect, it } from "vitest"
import { isPlausibleToolName } from "./tool-name"

describe("isPlausibleToolName", () => {
  it("accepts every shape a minting path can produce", () => {
    for (const name of [
      "read_file",
      "execute",
      "start_worker",
      "request_user_input",
      // MCP: mcp__<provider>__<tool>, each part through ensureIdentifier
      "mcp__github__search_pull_requests",
      "mcp__inAppBrowser__navigate",
      "mcp__tool",
      // Saved code_exec tools allow a hyphen
      "my-saved-tool",
      "_leading_underscore",
      "tool2"
    ]) {
      expect(isPlausibleToolName(name), name).toBe(true)
    }
  })

  it("rejects the model text that was being recorded as a tool", () => {
    // Both observed verbatim in the usage ranking, from a model that emitted
    // DSML-format tool calls the harness could not parse.
    for (const name of [
      'read_file</think> <|DSML|tool_calls> <|DSML|invoke name="ls',
      'read_file咖啡 <|DSML|parameter name="file_path" string="true'
    ]) {
      expect(isPlausibleToolName(name), name).toBe(false)
    }
  })

  it("rejects anything a name cannot contain", () => {
    for (const name of [
      "",
      " ",
      "read file",
      "read.file",
      "read/file",
      "读文件",
      "tool\n",
      "<think>",
      "a".repeat(129)
    ]) {
      expect(isPlausibleToolName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, 42, {}, ["read_file"]]) {
      expect(isPlausibleToolName(value)).toBe(false)
    }
  })

  it("keeps a name right at the limit", () => {
    expect(isPlausibleToolName("a".repeat(128))).toBe(true)
  })
})
