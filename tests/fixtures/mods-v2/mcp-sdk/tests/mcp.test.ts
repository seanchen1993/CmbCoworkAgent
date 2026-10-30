import { expect, test, tier } from "claude-code/testing"
tier("user")
test("MCP SDK operation uses named server, default empty arguments and plugin origin", async ($, on) => {
  on("mcp.call", (_, e, next) => {
    expect(e).toEqual({ server: "Company Mail", tool: "send", args: {} })
    expect(next.origin.plugin).toBe("mcp-sdk")
    return {
      value: {
        content: [{ type: "text", text: "ok" }],
        isError: false,
        structuredContent: { id: 1 }
      }
    }
  })
  expect(JSON.parse((await $.command.run({ command: "mcp-probe", args: "empty" })).text)).toEqual({
    content: [{ type: "text", text: "ok" }],
    isError: false,
    structuredContent: { id: 1 }
  })
})
test("MCP SDK preserves error results without converting them into rejected promises", async ($, on) => {
  on("mcp.call", (_, e) => ({
    value: { content: [{ type: "text", text: e.args.text }], isError: true }
  }))
  expect(JSON.parse((await $.command.run({ command: "mcp-probe", args: "failed" })).text)).toEqual({
    content: [{ type: "text", text: "failed" }],
    isError: true
  })
})
test("denying MCP operation rejects the SDK promise before contacting a server", async ($, on) => {
  on("mcp.call", () => ({ deny: "fixture blocked" }))
  expect((await $.command.run({ command: "mcp-probe", args: "deny" })).text).toContain("caught:")
})
