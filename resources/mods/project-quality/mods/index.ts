export default {
  register(on) {
    on.context({ id: "conventions" }, async ($) => [
      {
        source: "project-quality",
        text: `项目 ${await $.context.get("project.name")}：修改代码后运行相关测试；不要把凭据写入代码；明确说明未通过的检查。`
      }
    ])
    on.tool(
      { id: "check-file", tools: ["host:write_file", "host:edit_file"] },
      async ($, event, next) => {
        const path = String(event.args.file_path || "").replace(/\\/g, "/")
        if (/(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key)$/i.test(path)) {
          return { kind: "deny", reason: "请通过专用配置流程修改凭据文件。" }
        }
        const result = await next({ args: event.args })
        return { kind: "result", receipt: result.receipt, projection: result.projection }
      }
    )
    on.command({ id: "verify", command: "project-quality:verify" }, async ($, event) => {
      const result = await $.tools.invoke("host:execute", {
        command: "npm test",
        cwd: event.identity.workspace
      })
      return {
        text: `${result.execution === "succeeded" ? "验证完成" : "验证未通过"}\n${result.projection.text}`
      }
    })
    on.ui({ id: "quality-card", slot: "tool.result.after" }, async () => [
      {
        type: "card",
        title: "项目规范助手",
        children: [
          { type: "text", text: "工具操作已结算。可以运行项目测试，检查改动效果。" },
          { type: "button", label: "运行项目测试", command: "project-quality:verify", args: {} }
        ]
      }
    ])
  }
}
