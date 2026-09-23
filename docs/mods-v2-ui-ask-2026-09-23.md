# ui.ask 原生问答适配

```ts
on("command.run", { command: "choose" }, async ($) => ({
  text: await $.ui.ask("选择执行方式？", { header: "执行方式", options: ["谨慎", "快速"] })
}))
```

SDK通过原tool.call链调用本工程request_user_input，跳过调用方registration，使用原生问题
schema、对话框、等待状态与取消信号。保留ModsManager、授权、lease、generation和最终
工具审批；需要排队的显式用户动作，即时只读命令不能等待此问答。

默认补齐Yes/No，2–4标签；header最多12字符、问题最多500字符、标签最多80字符。
返回选中标签或自定义文本；跳过、取消、无人响应、自动超时选择都拒绝，不当成真实用户
回答。主Agent原生问答配置仍适用；SDK不启用无renderer的延期提问。关闭/撤权会取消
正在等待的问题。回答不是工具批准、测试证明或业务验收。

对照官方2.1.278为桌面适配：工具名request_user_input，原生单选，明确拒绝multiSelect。
附加说明不合并进返回标签（原生工具结果保留完整数据）。AskUserQuestion渲染site和
ui.notice另外实现，当前不以同名函数宣称完整兼容。host v45要求新的digest授权。

聚焦 Electron 8项、窄测32项通过；完整回归与性能边界见
`output/mods-v2-validation/2026-09-23-ui-ask.md`。

SDK同样执行原classic PreToolUse/PostToolUse。PreToolUse为扁平tool/questions输入，
使用deny拒绝；拒绝原因经过原输出策略后返回，执行账本记录not_started。最终审批展示
Hook改写后的输入。PostToolUse或tool.call把原生JSON结果改成非JSON文本时，ui.ask会
明确报结果格式错误，不把异常文本解释成用户答案。
