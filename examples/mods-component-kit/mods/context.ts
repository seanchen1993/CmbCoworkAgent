export function register(on) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "component-help",
      description: "查看组件示例使用说明",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "component-help" }, () => ({
    text: "在我的 Claw 中选择代码检视及其依赖，保存并应用后输入 /component-review 加代码。未选汇报整理时 /component-report 不会注册。示例只处理给定文本，不自动读取仓库，也不把模型结论作为测试证明。"
  }))
}
