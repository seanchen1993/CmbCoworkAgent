export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-check",
      description: "查询工具权限，不执行工具",
      argumentHint: '{"tool":"write_file","input":{"file_path":"notes.md","content":"hello"}}'
    })
    return next(e)
  })
  on("command.run", { command: "claw-check" }, async ($, e) => {
    let input
    try {
      input = JSON.parse(e.args)
    } catch {
      return {
        text: '请输入 JSON 参数，例如 {"tool":"read_file","input":{"file_path":"README.md"}}'
      }
    }
    try {
      return { text: JSON.stringify(await $.tool.check(input)) }
    } catch (error) {
      return { text: "权限查询失败：" + error.message }
    }
  })
}
