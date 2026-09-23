# PostToolUse 输出效果适配

经典 Function Hook 的 `updatedToolOutput` 现在可以改写传给模型的工具结果；真实 MCP
调用还支持 `updatedMCPToolOutput`，同时提供时优先使用 MCP 专属字段。非 MCP 工具忽略
MCP 专属字段。undefined 表示不改，null、false、0和空字符串均为明确替换。

```ts
on("classic.PostToolUse", async ($, e, next) => {
  const result = await next(e)
  if (e.tool_name !== "read_file") return result
  return { ...result, updatedToolOutput: "经过整理的工具结果" }
})
```

沿用原 ModsManager、FunctionSession、经典 hooks core 和发布过滤。不开启或未返回字段时
沿用原对象及原工具流程。宿主的 halt、取消、failure fuse 和执行回执逻辑仍作用于真实结果。

复用已有结果投影：ToolMessage 保留身份、错误状态与元数据，Command 保留路由和其他消息；
没有 toolCallId 时不改写 Command。进程只替换output，exitCode不变；文件写入保留path/error
和磁盘内容，只附加展示metadata。MCP保留真实isError和capabilityId，替换内容按本应用的
安全文本/JSON投影处理，未实现Claude任意多媒体MCP结果对象的原样替换。

这是本应用的adapted结果效果，不代表classic.PostToolUse所有字段、来源、时序已经完全
兼容。现有传统配置脚本的输出解析器未在本次扩大字段支持。本次只有Function Mod返回
的合法经典结果接入新效果；旧配置hook、异步通知和已有失败策略保持原路径。

模型看见的文字可被插件改写，因此这些文字不能作为可信测试/业务验收证据。完成门禁、
validator和checkpoint继续使用宿主实际捕获的文件及执行证据。宿主revision v42使旧授权
摘要失效，启用该语义前需重新批准插件。

补充验证：真实 Electron 主模型调用本地 MCP stdio 的错误工具，插件返回包含isError:false
的MCP替换内容后，模型确实收到替换文字，原MCP真实执行计数仍为1，宿主audit回执仍为failed。
这证明该字段不会改写执行事实，不代表模型文本可作为业务验收依据。
