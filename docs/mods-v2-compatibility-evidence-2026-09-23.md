# Mods 兼容声明证据检查 — 2026-09-23

按固定 Claude Code 2.1.278 声明检查当前兼容表。修正 engine/operation/SDK/Client 中已经
标为 adapted、但未直接链接测试或说明范围的条目；不修改任何实现状态，不因此宣称更多兼容。

补充 ui.focus/ui.scroll、agent.offer、session.compact/session.usage、model.complete/fork/classify、
Client onFocus/onScroll 的现有测试引用。SDK 与 operation 重复列出的声明分别保留可查证依据。
原生问题和 ToolGroup 已有 notes 范围说明，检查兼容 note/notes 两种既有字段，不重复新增说明。

新检查要求每一项 full/adapted 声明具有非空范围说明、至少一条本地测试证据，并保证本地引用
文件存在。官方 HTTPS 参考与本地测试区分处理，不要求网页在本地文件系统存在。
此检查只是防止证据引用缺失或断链，不能证明任意同名测试覆盖了整个上游 API。

证据按已有行为测试人工核对：焦点及滚动实际 host/guest 路由、主注册表 agent.offer、原生
压缩与提交、实际上下文来源、真实配置 provider、模型预算/撤权/取消与 fork/classify 边界。
最终兼容范围仍以每项 note、行为测试和 Electron 记录为准。
