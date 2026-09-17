export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-tool-read",
      description: "通过宿主工具读取项目文件",
      argumentHint: "[项目文件]",
      immediate: true
    })
    await $.command.register({
      name: "claw-tool-write",
      description: "批准后写入 Mods 演示记录",
      argumentHint: "[记录内容]"
    })
    return next(e)
  })
  on("command.run", { command: "claw-tool-read" }, async ($, e) => {
    const result = await $.tool.call({
      tool: "read_file",
      file_path: e.args || "mods-sdk-note.txt"
    })
    return { text: result.deny || result.text || JSON.stringify(result.result) }
  })
  on("command.run", { command: "claw-tool-write" }, async ($, e) => {
    const result = await $.tool.call({
      tool: "write_file",
      file_path: "mods-sdk-note.txt",
      content: e.args || "通过 Mods SDK 创建的项目记录"
    })
    return {
      text: result.deny || (result.isError ? result.text : "Mods 工具已完成写入：mods-sdk-note.txt")
    }
  })
  on("tool.call", { tool: "write_file", file_path: "mods-sdk-note.txt" }, async ($, e, next) => {
    return next({ ...e, content: `# Claw Mods 记录\n\n${e.content}\n` })
  })
}
