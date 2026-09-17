export function register(on) {
  let mcpRouteName
  on("session.start", async ($, e, next) => {
    await $.tool.register({ name: "probe", description: "Read a project note and summarize it" })
    await $.command.register({ name: "foundation-mcp", description: "Nested MCP identity probe" })
    await $.command.register({
      name: "foundation-mcp-direct",
      description: "Direct MCP tool probe"
    })
    await $.command.register({
      name: "foundation-native",
      description: "Concurrent native identity probe"
    })
    return next(e)
  })
  on("command.run", { command: "foundation-mcp" }, async ($) => ({
    text: JSON.stringify(await $.tool.call({ tool: "mcp__host-foundation__probe", mode: "mcp" }))
  }))
  on("command.run", { command: "foundation-native" }, async ($) => ({
    text: JSON.stringify(await $.tool.call({ tool: "mcp__host-foundation__probe", mode: "native" }))
  }))
  on("command.run", { command: "foundation-mcp-direct" }, async ($) => ({
    text: JSON.stringify({
      permission: await $.tool.check({ tool: mcpRouteName, input: { text: "direct" } }),
      answer: await $.tool.call({ tool: mcpRouteName, text: "direct" })
    })
  }))
  on("tool.call", async ($, e, next) => {
    if (!e.tool.endsWith("__mods_route")) return next(e)
    mcpRouteName = e.tool
    if (e.text === "deny") return { deny: "MCP route fixture denied" }
    const note = await $.tool.call({ tool: "read_file", file_path: "secret.txt" })
    if (!note.text.includes("[REDACTED]")) throw Error("Unprotected native read")
    return next({ ...e, text: `${e.text}:${next.origin.plugin}:rewritten` })
  })
  on("tool.check", (_, e, next) => {
    if (e.tool === "mcp__function-commands__project_brief" && e.input.limit === 13)
      return {
        decision: "deny",
        reason: "Permission fixture rejected registered tool sk-permission-fixture-123456789"
      }
    if (e.input.file_path === "permission-blocked.txt")
      return { decision: "deny", reason: "Permission fixture refused this read" }
    if (e.input.file_path === "permission-asked.txt")
      return { decision: "ask", reason: `Permission fixture asks ${next.origin.plugin}` }
    return next(e)
  })
  on("tool.call", { tool: "mcp__host-foundation__probe" }, async ($, e) => {
    if (e.mode === "native")
      return {
        result: await Promise.all([
          $.tool.call({ tool: "read_file", file_path: "secret.txt" }),
          $.tool.call({ tool: "read_file", file_path: "secret.txt" })
        ])
      }
    if (e.mode === "mcp")
      return {
        result: await Promise.all([
          $.mcp.call("Mods SDK fixture", "mods_echo"),
          $.mcp.call("Mods SDK fixture", "mods_echo")
        ])
      }
    const note = await $.tool.call({ tool: "read_file", file_path: "secret.txt" })
    const text = await $.model.complete({ model: "default", prompt: note.text, maxTokens: 64 })
    return { result: text }
  })
}
