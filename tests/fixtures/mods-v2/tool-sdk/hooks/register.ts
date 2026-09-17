export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "tool-probe", description: "Tool probe" })
    return next(e)
  })
  on("command.run", { command: "tool-probe" }, async ($, e) => {
    const answer = await $.tool.call({ tool: "read_file", file_path: e.args })
    return { text: JSON.stringify(answer) }
  })
  on("tool.call", { tool: "read_file", file_path: "deny" }, () => ({ deny: "No read" }))
  on("tool.call", { tool: "read_file", file_path: "input" }, async ($, e, next) => {
    const answer = await next({ ...e, file_path: "rewritten" })
    return { ...answer, context: [next.origin.plugin] }
  })
}
