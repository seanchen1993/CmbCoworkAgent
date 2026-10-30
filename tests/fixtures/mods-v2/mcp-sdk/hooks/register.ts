export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "mcp-probe", description: "MCP SDK probe" })
    return next(e)
  })
  on("command.run", { command: "mcp-probe" }, async ($, e) => {
    try {
      const value =
        e.args === "empty"
          ? await $.mcp.call("Company Mail", "send")
          : await $.mcp.call("Company Mail", "send", { text: e.args })
      return { text: JSON.stringify(value) }
    } catch (error) {
      return { text: "caught:" + error.message }
    }
  })
}
