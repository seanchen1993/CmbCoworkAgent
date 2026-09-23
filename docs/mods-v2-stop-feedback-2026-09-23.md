# Stop 反馈与原完成循环 — 2026-09-23

宿主契约 v53。参考 Claude Code 2.1.278 的 Mods 声明，以及官方 Hook 文档：
https://code.claude.com/docs/en/hooks#stop 。这是桌面适配，兼容矩阵仍标记 partial。

## 行为

开启项目 Mods 时，classic.Stop 的非空 additionalContext 会作为非错误反馈交回原 Agent
完成循环。原 completion gate 仍在后续完成前执行；反馈不能证明测试、业务验收或 checkpoint
通过。显式 block、halt、拒绝、取消和宿主预算仍保留原有优先级。

stop_hook_active 由宿主本次物理完成循环维护：首次为 false，Stop 发起续跑后为 true。
新的物理轮次重置；PostSkillUse 或独立宿主门禁发起修复时重置。last_assistant_message 来自
原响应。两项均固定，插件无法通过 next 改写下层事实。长响应沿用原有总 JSON 大小限制，
不会额外施加 32K 短文本限制。

只有已启用的 Mods 生产桥接会产生宿主内部反馈标志；guest 和传统脚本结果不能设置该标志。
关闭 Mods 后，原传统 Hook 的 additionalContext 保持观察语义，不因此新增模型请求。
传统 Stop 的阻止/修复行为保持原样，传统 stdin 也补充可用的真实 Stop 字段。

## 限制

桌面保留原来的两次修复上限，超限阻止完成；不声称与上游八次续跑上限及终止方式一致。
存在必需完成门禁时，Stop 反馈与其他修复共用其预算。没有新建调度器、模型循环或授权通道。

SubagentStop 的真实子循环续跑、background_tasks/session_crons 的真实注册表投影尚未完成。
未知字段不伪造空数组；预留字段若由宿主提供也会固定，防止插件伪造。
Electron 测试使用实际应用、插件、原模型链路和本地协议服务；不等同于真实 Autobiz 验收。

## 证据

- src/main/agent/skill-lifecycle/completion-stop-state.test.ts
- src/main/agent/skill-lifecycle/mods-stop-completion.integration.test.ts
- src/main/hooks/classic-mods.integration.test.ts
- src/main/mods/v2/classic-session.test.ts
- src/shared/mods/v2/classic.test.ts
- tests/support/mods-stop-feedback-e2e.ts
- output/mods-v2-validation/2026-09-23-stop-feedback.md
