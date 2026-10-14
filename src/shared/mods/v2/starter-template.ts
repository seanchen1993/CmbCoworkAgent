/** The same source is downloaded by the UI and compiled in the installation regression. */
export const MODS_STARTER_FILES: Record<string, string> = {
  "plugin.json": JSON.stringify(
    { name: "my-claw", version: "1.0.0", description: "我的第一个 Mods" },
    null,
    2
  ),
  "hooks/hooks.json": JSON.stringify({ modules: ["./register.ts"] }, null, 2),
  "hooks/register.ts": `export function register(on) {
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "my-claw-info",
      description: "查看我的 Claw 所在项目",
      immediate: true
    })
    return next(event)
  })

  on("command.run", { command: "my-claw-info" }, async ($) => ({
    text: "我的 Claw 已就绪，当前项目：" + await $.session.root()
  }))
}
`,
  "README.md": `# 我的第一个 Mods

1. 在“自定义 → Function Mods”上传此 ZIP；也可以解压后从文件夹安装。
2. 开启应用和当前项目 Mods，在 my-claw 卡片授权当前版本。
3. 回到当前项目聊天，发送 /my-claw-info，确认实际项目路径。
4. 到“DIY 流程”创建代码检视流程，选择 my-claw 作为运行授权来源。
5. 填写目标、配置步骤，保存流程，然后点击“运行已保存版本”。

修改 hooks/register.ts 可添加自己的命令和事件处理；修改源码后重新安装并授权。
此模板只注册一个查询命令，不修改文件、不调用模型。
上传的代码不会自动变成新流程节点。当前流程组合 Agent 任务、真实检查、人工确认、Autobiz 阶段推进四类步骤。
`
}
