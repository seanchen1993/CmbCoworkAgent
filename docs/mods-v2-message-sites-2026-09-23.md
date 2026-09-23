# 消息展示扩展

`ui.render` 现在接入真实聊天记录中的 `UserMessage` 和 `AssistantMessage` 文本块。
插件可以改写 `props.text` 或返回受限的 UI 数据树；模型请求、持久化消息、复制操作仍使用
原始文本。未改写、关闭、无授权和渲染失败时保留原生 Markdown、链接及搜索标记。

```ts
on("ui.render", { component: "AssistantMessage" }, ($, e, next) =>
  next({ ...e, props: { ...e.props, text: "回复：" + e.props.text } })
)
```

这是 Claude Code 2.1.278 声明的桌面适配，状态为 `adapted`：

- UserMessage `origin` 固定 `{ kind: "unclassified" }`，不把普通 user 角色冒认为人工输入。
  `isExpanded` 表示本应用的用户消息展开按钮；未提供终端 verbose 模式、task/from 元数据。
- AssistantMessage `isFirstOfReply` 为只读宿主事实；原应用的头像和消息头仍由宿主绘制。
- 不提供终端 `onScreen` 行几何。系统通知、思考块、工具块及技能/浏览器标签使用各自原流程。
- 每类最多 32 个同时存活的文本块 owner，卸载释放回调。超过容量或 10000 字符的文本
  保留原生展示，不截断后假装是完整消息。流式变动合并刷新，旧请求不能覆盖新文本。
- 这两个位置暂不支持 `Client`；违反只读字段或使用不支持组件会恢复原生内容。
- 修改偏好后调用 `$.ui.invalidate("ui.render")`，已有可见消息也会重画。

宿主修订升级为 v37，已有插件必须批准新摘要。验证记录见
[2026-09-23 消息展示验证](../output/mods-v2-validation/2026-09-23-message-sites.md)。
