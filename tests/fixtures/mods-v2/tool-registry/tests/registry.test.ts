import { expect, test, tier } from "claude-code/testing"
tier("user")
test("registration defaults, replacement, namespaced serving and list operation", async ($, on) => {
  const registered = new Map()
  on("tool.register", (_, e) => {
    expect(e.inputSchema).toEqual({ type: "object" })
    const name = `mcp__tool-registry__${e.name}`
    registered.set(name, { name, description: e.description, mcp: true })
    return { value: { tool: name } }
  })
  on("tool.list", () => ({ value: [...registered.values()] }))
  const answer = JSON.parse(
    (await $.command.run({ command: "registry-probe", args: "hello" })).text
  )
  expect(answer).toEqual({
    registered: { tool: "mcp__tool-registry__echo" },
    tools: [{ name: "mcp__tool-registry__echo", description: "Echo replaced", mcp: true }],
    answer: { result: "hello", context: ["tool-registry"] }
  })
})
