export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.tool.register({ name: "probe", description: "Read a project note and summarize it" })
    await $.command.register({ name: "foundation-mcp", description: "Nested MCP identity probe" })
    return next(e)
  })
  on("command.run", { command: "foundation-mcp" }, async ($) => ({
    text: JSON.stringify(await $.tool.call({ tool: "mcp__host-foundation__probe", mode: "mcp" }))
  }))
  on("tool.call", { tool: "mcp__host-foundation__probe" }, async ($, e) => {
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
