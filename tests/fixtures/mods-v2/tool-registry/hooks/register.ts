export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "registry-probe", description: "Tool registry probe" })
    await $.tool.register({
      name: "echo",
      description: "Echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      }
    })
    return next(e)
  })
  on("command.run", { command: "registry-probe" }, async ($, e) => {
    const result = await $.tool.register({ name: "echo", description: "Echo replaced" })
    const tools = await $.tool.list()
    const answer = await $.tool.call({ tool: "mcp__tool-registry__echo", text: e.args })
    return { text: JSON.stringify({ registered: result, tools, answer }) }
  })
  on("tool.call", { tool: "mcp__tool-registry__echo" }, (_, e, next) => ({
    result: e.text,
    context: [next.origin.plugin]
  }))
}
