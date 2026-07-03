# 上下文压缩对比：Claude Code / Codex / DevClaw

## 1. 按 Feature 对比三个框架

| Feature | Claude Code | Codex | DevClaw / CmbCowork | 更好 | 较弱 |
| --- | --- | --- | --- | --- | --- |
| 自动触发策略 | 接近上限前触发，并预留较大 buffer | 默认约 90% 上下文窗口触发，也会在模型切换时触发 | 默认约 75% 上下文窗口触发，比较积极 | Claude Code | Codex 触发偏晚 |
| 模型最终看到的内容 | compact boundary 后的摘要 + 保留消息 + 恢复现场 | 压缩后的新 session history | summary + 最近 tail 消息 | Claude Code / Codex | DevClaw 可观测性稍弱 |
| 压缩后的历史如何保存/展示 | 插入 compact boundary，UI 能看到这里发生过压缩，模型也按 boundary 后的新内容继续 | 直接把 session history 替换成压缩后的新 history，结构最清晰 | 不直接改完整历史；内部记录 `_summarizationEvent`，每次模型调用时临时拼出 summary+tail | Codex / Claude Code | DevClaw 主要是内部状态，UI/日志里没有天然的一条“压缩边界” |
| 最近上下文保留 | 保留最近消息，并额外恢复最近文件、计划等 | 保留最近用户消息，并注入初始上下文 | 保留 cutoff 后的 tail 原文，包含最近 assistant/tool 消息 | Claude Code / DevClaw | Codex 保留粒度较窄 |
| 压缩后现场恢复 | 很强，会恢复最近文件、计划、技能、工具、MCP 等 | 有 initial context reinjection；因为会保留最近消息，所以不强依赖额外恢复 | 会保留最近 tail，tail 里的工具结果仍在；额外 workset restore 只是增强项 | Claude Code | Codex / DevClaw 缺少 Claude 式额外恢复，但不是核心短板 |
| 大工具结果处理 | 很强，有落盘、预览、路径、整体预算控制 | 有输出截断和历史整理 | 已有大工具结果落盘到 `.cmbdevclaw/large_tool_results` | Claude Code | Codex |
| 历史 offload | 有 transcript / compact boundary 机制 | 主要重建 session history | 被压缩历史保存到 `.cmbdevclaw/conversation_history` | Claude Code / DevClaw | Codex |
| tool_use / tool_result 安全 | 会避免破坏工具调用结构 | 会规范化工具调用和工具结果 | 有 safe cutoff，避免拆开 tool_use/tool_result | 三者都较好 | 无明显弱项 |
| Summary prompt 质量 | 很细，覆盖用户意图、文件、错误、当前任务、下一步 | 相对通用 | DevClaw 自定义工程交接式 summary prompt，贴合编码任务 | Claude Code / DevClaw | Codex |
| prompt-too-long 兜底 | 较细，会按消息组裁旧内容后重试 | 较稳，会逐步移除旧历史后重试 | 已有 emergency summarization，但层级较少 | Claude Code | DevClaw |
| 局部压缩 | 支持 partial compact，可压缩指定范围 | 主要是整体 compact | 暂未看到明确局部压缩能力 | Claude Code | Codex / DevClaw |
| 压缩事件和指标 | 有 boundary、统计和日志，产品感知强 | compact 是明确运行时事件，状态清晰 | 内部有 `_summarizationEvent`，但 UI/日志层还可加强 | Claude Code / Codex | DevClaw |
| 测试覆盖 | 设计完整，但本地源码包测试不一定完整 | 压缩相关测试较多 | DevClaw 定制层专项测试还可以补强 | Codex | DevClaw |
| 整体成熟度 | 功能最完整，体验最好 | 运行时最稳，状态最清晰 | 主干能力已经齐全，但产品化能力还可加强 | Claude Code | DevClaw 仍有提升空间 |

## 2. DevClaw 可以借鉴的地方

| 优先级 | 对应弱项 | 借鉴对象 | DevClaw 建议怎么做 | 价值 |
| --- | --- | --- | --- | --- |
| P0 | 压缩事件不够显式 | Codex + Claude Code | 把每次压缩记录成 compact event，包含触发原因、压缩前 token、保留消息数、summary 路径、工具结果路径、是否触发兜底 | 方便 UI 展示、日志排查和策略调优 |
| P1 | prompt-too-long 兜底层级较少 | Claude Code + Codex | `summary+tail` 还超限时，先压工具结果、缩短 tail、按完整消息组裁旧内容，最后才全量再摘要 | 尽量保留最近上下文原文，减少信息损失 |
| P1 | 测试覆盖偏少 | Codex | 补 tool_use/tool_result 不拆、连续压缩、大工具结果落盘、history 路径可读、fallback 流程等测试 | 防止后续修改破坏核心压缩能力 |
| P2 | 缺少局部压缩 | Claude Code | 支持“压缩此消息之前 / 之后” | 长任务里可以只整理已结束的讨论，不必每次整体压缩 |
| P2 | 缺少额外 workset restore | Claude Code | 只在需要时补一个去重的 post-compact workset restore：tail 里已有的不重复注入；只补已被摘要化但仍重要的文件、todo、错误、落盘路径 | 作为增强项，处理重要信息刚好落在 cutoff 前或二次兜底把 tail 也摘要化的场景 |
| P2 | 压缩指标不足 | Claude Code | 统计压缩前后 token、节省 token、恢复了哪些文件、是否很快再次触发压缩 | 后续调参更有依据 |

建议 DevClaw 的实现顺序：

```text
compact event
-> 专项测试
-> 多级 prompt-too-long 兜底
-> 局部压缩
-> 按需补充 post-compact workset restore
```

核心判断：

> DevClaw 的压缩主干已经接近 Codex 这一类“基础上下文延续”能力；因为 DevClaw 会保留最近 tail，所以不需要把 Claude 式 post-compact workset restore 当成首要改造。更优先的是 compact event、专项测试和更细的 prompt-too-long 兜底。

主要源码参考：

| 框架 | 关键文件 |
| --- | --- |
| DevClaw / CmbCowork | `src/main/agent/runtime.ts` |
| DevClaw / CmbCowork | `node_modules/deepagents/dist/index.js` |
| DevClaw / CmbCowork | `src/main/agent/read-file-tool.ts` |
| Claude Code | `/Users/chenqiang/Desktop/ai/claude-code/src/services/compact/compact.ts` |
| Claude Code | `/Users/chenqiang/Desktop/ai/claude-code/src/utils/toolResultStorage.ts` |
| Claude Code | `/Users/chenqiang/Desktop/ai/claude-code/src/utils/messages.ts` |
| Codex | `/Users/chenqiang/Desktop/ai/codex/codex-rs/core/src/compact.rs` |
| Codex | `/Users/chenqiang/Desktop/ai/codex/codex-rs/core/src/session/turn.rs` |
