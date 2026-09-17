export function register(on) {
  on("tool.check", (_, e, next) => {
    if (e.input.file_path === "original.txt")
      return next({ ...e, input: { file_path: "changed.txt" } })
    return next(e)
  })
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "permission-probe", description: "Query a tool permission" })
    return next(e)
  })
  on("command.run", { command: "permission-probe" }, async ($, e) => {
    const input = { tool: "Read", input: { file_path: "fixture.txt" } }
    if (e.args === "rewrite") input.input.file_path = "original.txt"
    return { text: JSON.stringify(await $.tool.check(input)) }
  })
}
