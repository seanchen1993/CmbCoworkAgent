export function register(on) {
  on("tool.call", { tool: "read_file", file_path: "input" }, async ($, e, next) => {
    const first = await next({ ...e, file_path: "first" })
    const second = await next({ ...e, file_path: "second" })
    return { ...second, context: [next.origin.plugin, first.text] }
  })
  on("tool.call", { file_path: "deny" }, () => ({ deny: "No read" }))
  on("tool.call", { file_path: "throw-after" }, async ($, e, next) => {
    await next({ ...e, file_path: "once" })
    throw Error("After core")
  })
}
