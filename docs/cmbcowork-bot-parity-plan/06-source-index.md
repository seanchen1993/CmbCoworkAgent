# 来源索引

日期：2026-09-29。以下是方案中的引用定位，不是端到端完成证明。SHA、版本与文档快照摘要见 [sources.json](sources.json)。临时克隆目录可能被系统清理，开源代码同时提供固定 commit 的在线链接。

## Grok Bot 0.18 重建源码

### GR01 Bot / 群聊 / 主进程 RPC 与协议

- [source/shared/rpc/coordinator.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/coordinator.ts:1)
- [source/shared/rpc/main.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/rpc/main.ts:1)
- [source/shared/agents/agents.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/agents/agents.ts:1)

### GR02 接收去重与发送状态

- [source/host/extensions/transcript/send-pipeline.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/send-pipeline.ts:74)

### GR03 运行调度和代次

- [source/host/extensions/transcript/run-scheduler.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/run-scheduler.ts:53)

### GR04 异步 Bot 信箱

- [source/host/extensions/transcript/agent-to-agent-messaging.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/agent-to-agent-messaging.ts:47)

### GR05 群聊轮次、扇出和协作边界

- [source/host/extensions/transcript/group-chat-orchestrator.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/group-chat-orchestrator.ts:32)
- [source/host/extensions/transcript/send-group-fanout.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/send-group-fanout.ts:1)
- [source/host/groups/group-chat.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/groups/group-chat.ts:1)

### GR06 复制 Bot 的复制/排除规则

- [source/host/agents/agent-clone.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/agents/agent-clone.ts:15)

### GR07 分域记忆和提炼核验

- [source/host/extensions/memory/memory-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/memory/memory-service.ts:50)
- [source/host/extensions/memory/memory-synthesis-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/memory/memory-synthesis-service.ts:1)

### GR08 Teach 录制及持久学习任务

- [source/host/extensions/teach-recording/teach-recording-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/teach-recording/teach-recording-service.ts:1)

### GR09 例程协议、存储与执行

- [source/shared/automations.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/automations.ts:1)
- [source/host/automations/automation.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/automations/automation.ts:1)
- [source/host/automations/automation-store.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/automations/automation-store.ts:1)
- [source/host/extensions/transcript/automation-runtime.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/automation-runtime.ts:1)

### GR10 具体动作自动审核

- [source/host/runner/sand-auto-review.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/sand-auto-review.ts:1)

### GR11 本地权限响应验证

- [source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts:1)

### GR12 宿主状态、数据库恢复、文件同步和升级

- [source/host/extensions/state-backstop/state-backstop-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/state-backstop/state-backstop-service.ts:1)
- [source/host/extensions/session/agent-db-recovery.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/session/agent-db-recovery.ts:1)
- [source/host/extensions/box-store-sync/box-store-sync-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/box-store-sync/box-store-sync-service.ts:1)
- [source/host/extensions/host-upgrade/host-upgrade-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/host-upgrade/host-upgrade-service.ts:1)

### GR13 连接器账号、MCP 工具与技能同步

- [source/host/extensions/mcp/mcp-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/mcp/mcp-service.ts:1)

### GR14 独立云端编码任务

- [source/host/extensions/cloud-agents/cloud-agents-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/cloud-agents/cloud-agents-service.ts:1)

### GR15 部分可读前端及重建边界

- [PROVENANCE.md](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/PROVENANCE.md:1)
- [frontend/README.md](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/README.md:1)
- [frontend/src/recovered/features/conversation/workspace/sidebar.tsx](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/conversation/workspace/sidebar.tsx:1)
- [frontend/src/recovered/features/conversation/workspace/composer.tsx](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/conversation/workspace/composer.tsx:1)
- [frontend/src/recovered/features/conversation/workspace/voice.tsx](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/conversation/workspace/voice.tsx:1)
- [frontend/src/recovered/features/conversation/cards/transcript-card/views/email-draft.tsx](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/conversation/cards/transcript-card/views/email-draft.tsx:1)
- [frontend/src/recovered/features/computer/shell/vnc-webview.tsx](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/src/recovered/features/computer/shell/vnc-webview.tsx:1)
- [frontend/manifests/ui-evidence-anchors.json](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/frontend/manifests/ui-evidence-anchors.json:1)

### GR16 电脑连接、命令、事件及远程画面通道

- [source/electron-main/box/box-host-connector.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/electron-main/box/box-host-connector.ts:74)
- [source/node-agent-coordinator/gateway/gateway-client.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/node-agent-coordinator/gateway/gateway-client.ts:246)
- [source/node-agent-coordinator/gateway/box-vnc-proxy.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/node-agent-coordinator/gateway/box-vnc-proxy.ts:1)
- [source/shared/gateway-wire.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/shared/gateway-wire.ts:1)
- [source/host/gateway-server.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/gateway-server.ts:46)

浏览器工具与实际执行驱动（直接移植主体，Windows 外围适配见第 12 文档）：

- [source/host/runner/tools/sand-browser-tools.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/sand-browser-tools.ts:159)
- [source/host/runner/tools/sand-browser-driver-source.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/sand-browser-driver-source.ts:311)
- [source/host/runner/sand-browser-auto-review.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/sand-browser-auto-review.ts:1)
- [source/host/runner/host-computer-tool-dependencies.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/host-computer-tool-dependencies.ts:314)

### GR17 场景工具组装与同级协作工具

- [source/host/runner/tools/turn-toolset.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/turn-toolset.ts:1153)
- [source/host/runner/tools/sand-agent-management-tools.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/sand-agent-management-tools.ts:45)

### GR18 模型电脑求助与人工归还后续跑

- [source/host/runner/tools/box-help-tool.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/box-help-tool.ts:78)：模型给出一行操作说明，结束当前轮次，同一 Bot 已有求助时不重复发卡。
- [source/host/extensions/session/box-handoff-service.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/session/box-handoff-service.ts:18)：保存待处理求助、有限截图和求助状态；原内存表不能代替 Cmb 已有持久 Interaction。
- [source/host/extensions/transcript/box-handoff-resume.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/box-handoff-resume.ts:95)：归还后自动续跑，先截图核对；拒绝和仅关闭查看器的含义不同，均不能推断用户已完成操作。

2026-10-06 已重新读取以上实际调用链。Cmb 的适配复用现有问题卡、控制权、执行图和恢复入口；浏览器与 Windows 工作应用使用各自目标与本人连接身份。原版此链路不包含可直接移植的 Windows 本地 UIA 密码输入实现。

## Rakazo

### RK01 持久运行、租约和电脑资源

- [packages/adapters/src/executor.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/packages/adapters/src/executor.ts:1136) · [固定版本](https://github.com/elie222/rakazo/blob/60ac790cd9a1bb9560b489c0535deb5db2e1e39f/packages/adapters/src/executor.ts#L1136)

### RK02 领导者对账与恢复

- [packages/adapters/src/job-reconciler.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/packages/adapters/src/job-reconciler.ts:1) · [固定版本](https://github.com/elie222/rakazo/blob/60ac790cd9a1bb9560b489c0535deb5db2e1e39f/packages/adapters/src/job-reconciler.ts#L1)

### RK03 事务内 Bot 消息投递

- [packages/adapters/src/bot-messages.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/packages/adapters/src/bot-messages.ts:1) · [固定版本](https://github.com/elie222/rakazo/blob/60ac790cd9a1bb9560b489c0535deb5db2e1e39f/packages/adapters/src/bot-messages.ts#L1)

### RK04 批准动作和未知外部效果

- [packages/adapters/src/approval-effect.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/packages/adapters/src/approval-effect.ts:1) · [固定版本](https://github.com/elie222/rakazo/blob/60ac790cd9a1bb9560b489c0535deb5db2e1e39f/packages/adapters/src/approval-effect.ts#L1)

### RK05 Teach 事件转步骤的能力边界

- [packages/core/src/teach-playbook.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/packages/core/src/teach-playbook.ts:1) · [固定版本](https://github.com/elie222/rakazo/blob/60ac790cd9a1bb9560b489c0535deb5db2e1e39f/packages/core/src/teach-playbook.ts#L1)

## OpenBot

### OB01 数据库时间与持久工作队列

- [server/src/work/queue.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/openbot/server/src/work/queue.ts:1) · [固定版本](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/server/src/work/queue.ts#L1)

### OB02 服务端目标解析与动作策略网关

- [server/src/computer/gateway.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/openbot/server/src/computer/gateway.ts:1) · [固定版本](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/server/src/computer/gateway.ts#L1)

### OB03 后台例程工具限制

- [server/src/routines/run-turn.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/openbot/server/src/routines/run-turn.ts:371) · [固定版本](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/server/src/routines/run-turn.ts#L371)
- [docs/architecture.md](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/openbot/docs/architecture.md:1) · [固定版本](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/docs/architecture.md#L1)

### OB04 外部 Intelligence 服务依赖

- [server/src/config.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/openbot/server/src/config.ts:887) · [固定版本](https://github.com/CopilotKit/OpenBot/blob/b6932d31a8d6e7896c15139dfc27a6c6911deb27/server/src/config.ts#L887)

## CmbCowork

### CM01 运行服务和 IPC 实现注册

- [src/main/agent/agent-run-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/agent-run-service.ts:1)
- [src/main/ipc/agent.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/ipc/agent.ts:5735)

### CM02 标准 turn 准备

- [src/main/agent/standard-thread-turn.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/standard-thread-turn.ts:1)

### CM03 运行内核及 Electron 依赖

- [src/main/agent/runtime.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/runtime.ts:159)

### CM04 任务内 coordinator / workers

- [src/main/agent/coordinator-worker-manager.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/coordinator-worker-manager.ts:1)

### CM05 桌面调度与内存 lease

- [src/main/services/scheduler.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/services/scheduler.ts:1)
- [src/main/agent/thread-run-lease.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/thread-run-lease.ts:1)

### CM06 招乎/IM 入口与远程执行桥

- [src/main/services/im/manager.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/services/im/manager.ts:1)
- [src/main/services/im/remote-runner.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/services/im/remote-runner.ts:1)
- [src/main/services/im/gateway-ws-client.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/services/im/gateway-ws-client.ts:1)

### CM07 当前记忆作用域与维护

- [src/main/memory/paths.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/memory/paths.ts:1)
- [src/main/agent/post-run-memory-maintenance.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/post-run-memory-maintenance.ts:1)

### CM08 浏览器和录制/回放基础

- [src/main/browser/core/browser-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:1)
- [src/main/browser/record/script-record/script-recording-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/record/script-record/script-recording-service.ts:1)
- [src/main/browser/record/common/browser-script-execution-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/record/common/browser-script-execution-service.ts:1)

### CM09 待审批记录与一次性消费

- [src/main/agent/approval-decision-broker.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/approval-decision-broker.ts:1)

### CM10 流投递与窗口 shim

- [src/main/agent/managed-transport-delivery.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/managed-transport-delivery.ts:1)

### CM11 现有桌面 UI、状态与传输

- [src/renderer/src/App.tsx](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/renderer/src/App.tsx:1)
- [src/renderer/src/lib/store.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/renderer/src/lib/store.ts:1)
- [src/renderer/src/lib/electron-transport.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/renderer/src/lib/electron-transport.ts:1)

### CM12 Mods 身份、grant 和执行收据

- [src/main/mods/v2/host-call.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/mods/v2/host-call.ts:1)

## 官方页面

| 编号 | 页面 |
| --- | --- |
| W-home | [Grok Bot 官网](https://x.ai/bot) |
| W-marketplace | [公开模板市场](https://x.ai/bot/marketplace) |
| W-guides | [Grok Bot Guides](https://x.ai/bot/guides) |
| W-overview | [产品概览](https://docs.x.ai/grok-bot/overview) |
| W-get-started | [账号与入门](https://docs.x.ai/grok-bot/get-started) |
| W-bots | [个人 Bot 管理](https://docs.x.ai/grok-bot/bots) |
| W-chat | [聊天、协作与快捷键](https://docs.x.ai/grok-bot/chat-and-collaboration) |
| W-files | [文件与成果](https://docs.x.ai/grok-bot/files-and-results) |
| W-computer | [电脑与应用](https://docs.x.ai/grok-bot/computer-and-apps) |
| W-mobile | [移动端](https://docs.x.ai/grok-bot/mobile) |
| W-skills | [技能、示范与例程](https://docs.x.ai/grok-bot/skills-routines-and-automations) |
| W-settings | [设置和通知](https://docs.x.ai/grok-bot/settings-and-notifications) |
| W-approvals | [审批与隐私](https://docs.x.ai/grok-bot/approvals-security-and-privacy) |
| W-enterprise | [团队与企业](https://docs.x.ai/grok-bot/teams-and-enterprises) |
| W-troubleshooting | [故障处理](https://docs.x.ai/grok-bot/troubleshooting) |
| W-faq | [常见问题](https://docs.x.ai/grok-bot/faq) |
| W-use-cases | [使用场景](https://docs.x.ai/grok-bot/use-cases) |
| W-security | [安全机制](https://docs.x.ai/grok-bot/security) |
| W-security-faq | [安全问题](https://docs.x.ai/grok-bot/security-faq) |
| W-private-networks | [私有网络](https://docs.x.ai/grok-bot/private-networks) |
| W-proxies | [TLS 与代理](https://docs.x.ai/grok-bot/proxies) |
| W-identity | [身份与访问](https://docs.x.ai/grok-bot/identity-and-access) |
| W-computers | [电脑管理](https://docs.x.ai/grok-bot/computers) |
| W-sign-in | [登录](https://cursor.com/help/grok-bot/sign-in) |
| W-delete-account | [删除账号](https://cursor.com/help/grok-bot/delete-account) |
| W-plans | [计划与用量](https://cursor.com/help/grok-bot/plans) |
| W-faqs | [当前帮助 FAQ](https://cursor.com/help/grok-bot/faqs) |
| W-how-to | [当前操作帮助](https://cursor.com/help/grok-bot/how-to) |
| W-group-chats | [群聊](https://cursor.com/help/grok-bot/group-chats) |
| W-routines | [当前例程与事件触发](https://cursor.com/help/grok-bot/routines) |
| W-connect-plugins | [插件连接](https://cursor.com/help/grok-bot/connect-plugins) |
| W-secrets | [Bot 秘密](https://cursor.com/help/grok-bot/secrets) |
| W-team-bots | [Team Bots](https://cursor.com/help/grok-bot/team-bots) |
| W-voice-chat | [实时语音](https://cursor.com/help/grok-bot/voice-chat) |
| W-cursor-mobile | [当前移动端帮助](https://cursor.com/help/grok-bot/mobile) |
| W-mobile-purchase | [移动购买](https://cursor.com/help/grok-bot/mobile-purchase) |
| W-supergrok | [权益关联](https://cursor.com/help/grok-bot/supergrok) |
| W-recovery | [电脑恢复](https://cursor.com/help/grok-bot/computer-recovery) |
| W-onboarding | [当前引导](https://cursor.com/help/grok-bot/onboarding) |
| W-edit-bot | [编辑 Bot](https://cursor.com/help/grok-bot/edit-bot) |
| W-cursor-teams | [当前团队设置](https://cursor.com/docs/grok-bot/teams) |
| W-deployment | [平台和更新分发](https://cursor.com/docs/grok-bot/deployment) |
| W-admin-api | [团队管理 API 的 Grok Bot 部分](https://cursor.com/docs/account/teams/admin-api) |

## 核对范围说明

对 RPC、发送/执行/恢复、协作、审批、记忆、Teach、插件、电脑和现有 Cmb 入口进行了重点阅读。大文件与生成前端采取相关段落和调用链核对；没有声称每个文件每一行都审计完毕。

本次保存了 52 份官方文档的下载摘要，并参考官网、市场与指南页面。部分文档用于目录/限制检索；文档数不等于已实测功能数。

公开文档中的 Team Bots、实时语音、Webhook 等新行为可能晚于 0.18。本方案对差异单独列项，当前官网与真机基准优先决定产品验收。
