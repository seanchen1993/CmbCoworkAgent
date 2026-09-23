# InstructionsLoaded 异步观察适配

Host v49。此事件只用于记录本次主 runtime 实际注入的指令来源，不是执行门禁。

```ts
on("classic.InstructionsLoaded", async ($, event, next) => {
  $.ui.log(`${event.memory_type}: ${event.file_path}`)
  return next(event)
})
```

宿主使用原 AGENTS 加载器经过预算裁剪后的来源，不重新扫描文件，不把“请自行读取”占位提示
报告成已注入内容。全局来源是 User，项目来源是 Project，项目 AGENTS.override.md 是 Local。
文件路径、来源类型、加载原因及公共会话身份由宿主固定；插件不能修改后传给下游。

每个 main runtime 只通知一次来源列表；通知异步执行，不延迟原模型。返回的 block、
preventContinuation 等决策被忽略，观察失败也不阻止任务。传统配置的 matcher 匹配 load_reason。
当前真实来源只有 session_start；最多运行 10 秒，任务完成、原模型失败、取消、撤权及
runtime 失效会结束或拒绝旧观察。关闭且没有独立 legacy 规则时不安装观察 middleware。

兼容状态为 adapted，来源有明确差异：[官方运行时说明](https://code.claude.com/docs/en/hooks#instructionsloaded)
针对 CLAUDE.md 与规则文件，不为直接加载 AGENTS.md 触发。本工程映射自身的 AGENTS 指令加载器，
不声明官方文件发现规则、动态嵌套/include、Managed、压缩再加载或子 Agent 全覆盖。
Mods 类型允许通用决策字段出现，不代表该观察事件会消费它们；以实际运行语义为准。

项目完成检查、自动修复和 checkpoint 推进仍走原有完成流程，不能根据此日志认定业务通过。
验证与限制见 `output/mods-v2-validation/2026-09-23-instructions-loaded.md`。
