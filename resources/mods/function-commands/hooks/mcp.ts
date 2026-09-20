export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-mcp",
      description: "调用已配置的 MCP 服务（执行前审批）",
      argumentHint: '{"server":"服务名称","tool":"工具名称","args":{}}'
    })
    return next(e)
  })
  on("command.run", { command: "claw-mcp" }, async ($, e) => {
    let input
    try {
      input = JSON.parse(e.args)
    } catch {
      return { text: '请输入 JSON 参数，例如 {"server":"服务名称","tool":"工具名称","args":{}}' }
    }
    try {
      const result = await $.mcp.call(input.server, input.tool, input.args ?? {})
      return { text: JSON.stringify(result) }
    } catch (error) {
      return { text: "MCP 调用失败：" + error.message }
    }
  })
}
