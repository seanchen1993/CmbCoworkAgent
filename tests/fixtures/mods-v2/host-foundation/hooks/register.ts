export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.tool.register({ name: "probe", description: "Read a project note and summarize it" })
    return next(e)
  })
  on("tool.call", { tool: "mcp__host-foundation__probe" }, async ($) => {
    const note = await $.tool.call({ tool: "read_file", file_path: "secret.txt" })
    const text = await $.model.complete({ model: "default", prompt: note.text, maxTokens: 64 })
    return { result: text }
  })
}
