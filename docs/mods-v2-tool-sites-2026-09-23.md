# ToolUse / ToolResult 桌面详情适配

工具详情中的格式化输入和结果现在分别接入 `ui.render` 的 `ToolUse`、`ToolResult`。
保留原始消息、模型工具响应、原始详情、状态标签和审批界面。尚待审批的详情完全使用
宿主原生绘制；插件不能借展示改写实际执行参数或审批内容。

```ts
on("ui.render", { component: "ToolResult" }, ($, e, next) =>
  next({ ...e, props: { ...e.props, output: "可读的结果摘要" } })
)
```

`tool_use_id` 和状态事实固定，ToolResult的 `tool` 也固定；不提供终端 `onScreen`。
未改写时沿用现有工具格式化器；改写input/output后用纯文本JSON，或使用插件自己的安全树。
保留模型的原生工具名称，不假装是Claude的Bash/Read输出schema。

状态为 `adapted`：仅宿主已经显示的非审批格式化详情触发，不替换折叠标题、审批或原始
数据块；每类32个owner，输入/结果总JSON最多10000字符。过大、循环或非JSON值恢复原生，
不截断为假的完整结果。不支持此处嵌入Client，也不宣称Claude内建结果schema完全相同。
宿主修订v40要求重新批准摘要。
