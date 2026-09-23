# ui.notice 原生问题说明适配

当前 host v47，参考 Claude Code v2.1.278 的 Mods 声明。SDK 为 void 方法：

```ts
$.ui.notice(toolUseId, "请先核对执行范围")
$.ui.notice(toolUseId, undefined) // 仅移除当前插件的说明
```

仅允许给已被 renderer 确认显示的原生 request_user_input 添加一行上下文。宿主从原工具调用
捕获 workspace、thread、toolCallId/callId、插件归属和原 requestId；插件不能自行提供对话框
绑定。模型发起的问题允许多个插件分别提供说明；SDK 发起的问题只允许所属插件添加。
问题结束、取消、全局关闭、撤权和 session 关闭均清理说明，旧请求不能用于新 runtime。

说明不修改原问题、答案、工具批准或完成证据。原生选项、自定义回答、跳过和提交继续由
原控件处理。文本最多 10,000 字符，UI 单行截断并提供完整 title；最多 8 个插件行、32 个
未完成发布，40ms 合并通知，没有空闲轮询。异步发布不能用较早结果覆盖新说明。输出经过
既有保护策略，snapshot 固定插件归属、类型、requestId、toolUseId，不能改为另一对话框。

桌面兼容标为 adapted：目前支持原生问题对话框；操作系统权限弹窗的动态说明、无 renderer
的 headless 对话框不支持。ui.notice 不是 ui.toast，也不能用作批准或业务验收。

本轮实际 Electron 检测并修复：原生 SDK 桥接丢失 FunctionSession 工具 ID；guest 的组件
清单遗漏 ToolGroup / AskUserQuestion。现在传递宿主生成的 ID，guest 与 host 共用 site 清单。
SDK 传入的伪造 tool_use_id 仍在原 Session 边界删除，原 authority、lease、generation 和
最终审批未改变。

验证及剩余限制见 `output/mods-v2-validation/2026-09-23-ui-notice.md`。
