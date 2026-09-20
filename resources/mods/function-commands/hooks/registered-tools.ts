export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.tool.register({
      name: "project_brief",
      description: "查看当前 Claw 项目的文件概览和已保存的项目备注",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
        additionalProperties: false
      }
    })
    await $.command.register({
      name: "claw-brief",
      description: "调用自定义项目概览工具",
      immediate: true
    })
    await $.command.register({
      name: "claw-tools",
      description: "查看工具目录；填写工具名可查看完整说明",
      immediate: true
    })
    return next(e)
  })
  on("tool.call", { tool: "mcp__function-commands__project_brief" }, async ($, e) => {
    const entries = await $.fs.list()
    return {
      result: {
        note: (await $.store.get("last-note")) || "",
        files: entries
          .slice(0, e.limit || 10)
          .map((entry) => ({ name: entry.name, kind: entry.kind }))
      },
      context: ["项目概览来自当前项目目录和用户保存的备注。"]
    }
  })
  on("command.run", { command: "claw-brief" }, async ($) => {
    const answer = await $.tool.call({ tool: "mcp__function-commands__project_brief", limit: 10 })
    return { text: answer.deny || JSON.stringify(answer.result, null, 2) }
  })
  on("command.run", { command: "claw-tools" }, async ($, e) => {
    const tools = await $.tool.list()
    const name = e.args.trim()
    if (name) {
      const tool = tools.find((entry) => entry.name === name)
      return { text: tool ? `${tool.name}\n${tool.description}` : `未找到工具：${name}` }
    }
    const lines = tools.map((tool) => {
      const description = tool.description.replace(/\s+/g, " ").trim()
      return `${tool.name}：${description.slice(0, 120)}${description.length > 120 ? "…" : ""}`
    })
    return {
      text: `${tools.length} 个工具。使用 /claw-tools <工具名> 查看完整说明。\n\n${lines.join("\n")}`
    }
  })
}
