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
      description: "查看本会话模型可用的工具",
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
  on("command.run", { command: "claw-tools" }, async ($) => {
    try {
      const tools = await $.tool.list()
      return { text: tools.map((tool) => `${tool.name}：${tool.description}`).join("\n") }
    } catch (error) {
      if (error.message.includes("MODS_TOOL_CONTEXT_REQUIRED"))
        return { text: "请先发送一条普通消息，建立本会话的模型工具列表。" }
      throw error
    }
  })
}
