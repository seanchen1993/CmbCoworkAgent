export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({ name: "kanban-review", description: "用模型审阅一个项目文件", argumentHint: "相对文件路径" })
    return next(e)
  })
  on("command.run", { command: "kanban-review" }, async ($, e) => {
    const path = e.args.trim()
    if (!path || path.includes("..") || path.startsWith("/") || path.includes("\\")) return { text: "请输入当前项目内的相对文件路径。" }
    try {
      const source = await $.fs.read(path)
      if (source.length > 12000) return { text: "文件超过 12000 字符，请选择更小的文件。" }
      const review = await $.model.complete({
        model: "default", maxTokens: 1800,
        system: "你是代码检视助手，只审阅给定文件，列出具体问题、行号、原因和建议。禁止声称执行过测试或读取了其他文件。用中文回答。",
        prompt: `文件：${path}\n<source>\n${source}\n</source>`
      })
      return { text: `模型单文件审阅：${path}\n${review}\n\n未执行测试，未推进 checkpoint。` }
    } catch (error) {
      return { text: `单文件审阅未完成：${error.message}` }
    }
  })
}
