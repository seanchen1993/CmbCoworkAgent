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

1. 打开“自定义设置 → 灵件与使用设置 → 我已添加”上传此 ZIP，也可以解压后从文件夹安装。聊天工作台也提供同名设置入口。
2. 点击“启用应用和当前项目灵件”，启用插件并在 my-claw 卡片授权当前版本。项目目录开关由同目录的聊天共用；应用开关还会恢复其他已经批准的灵件。
3. 回到当前项目聊天，发送 /my-claw-info，结果会显示实际项目路径。
4. 如需限制该聊天使用哪些插件，可在“搭配管理”选择 my-claw，保存组合后确认应用到所选聊天。
5. 如需组合聊天任务，可在高级自定义的“聊天任务模板”创建流程；仅保存和应用不会自动执行，回到聊天明确选择本次任务模板并发送任务。

修改 hooks/register.ts 可添加自己的命令和事件处理；源码更新后重新安装并授权。
此模板只注册一个查询命令，不修改文件、不调用模型，也没有声明可编排的公开动作。
查询命令不会自动变成新流程节点。需要将插件能力用于组合步骤时，先按当前公开动作契约声明输入、输出与校验，再从动作目录选择。
插件授权仅属于当前项目与源码版本，不能通过复制组合或导出转移到其他项目。
`
}
