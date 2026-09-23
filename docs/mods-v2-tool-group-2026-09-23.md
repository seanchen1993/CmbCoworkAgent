# ToolGroup 桌面适配

```ts
on("ui.render", { component: "ToolGroup" }, ($, event, next) =>
  next({ ...event, props: { ...event.props, isExpanded: true } })
)
```

同一 assistant 消息中的工具调用构成一组，保持模型给出的顺序和真实工具名称。
`calls`、`isActive` 和调用 id/输入/输出/状态固定；只允许改写布尔 `isExpanded`。
展开后显示现有 ToolUse/ToolResult 详情，也经过已有详情扩展。用户仍可逐项折叠。
关闭模块恢复宿主原来折叠状态；执行结果、消息存储和模型上下文不受展示扩展影响。

自定义树在工具组之前展示补充内容；原生工具标题、真实错误标签、原始详情和操作保留。
有任意待审批调用时整组跳过插件展示，以保留原有审批语义。最多32调用、总10000 JSON
字符，每个session最多32组owner；过大、重复id或无法序列化时保留原生界面，不做截断。

状态为 adapted：CMB按消息分组，不模拟终端跨消息 Read/Grep 聚合和单行计数折叠；
`isExpanded:false` 表示宿主的默认详情折叠，单项手动选择仍由原有UI管理。
`isActive` 对应当前消息的流式状态。不提供终端onScreen，也不支持此处Client。
宿主修订v44，新增能力要求按新摘要授权。
