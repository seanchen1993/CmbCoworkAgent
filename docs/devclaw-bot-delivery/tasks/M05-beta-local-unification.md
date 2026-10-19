# M05 beta UI、本地任务与渠道入口融合

状态：ready，用户 2026-10-19 明确开始实施；后续补充允许后端 mock，真实 Java/IM 合仓延后。设计为 `../reviews/M05-beta-local-unification-design.md`，它覆盖 M04 冲突规则。

## 分工、树与恢复

- root 独占设计、任务单、state/HANDOFF/reviews、集成与最终验收。
- 原 `/root/service_conversation_sol`，gpt-6.1-sol/xhigh，唯一产品写者，不派生子代理。
- integration：`/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`，`codex/devclaw-bot-integration`，起点 `b479d51d700b81871a4c22feaa751484f2488827`。
- 实施：`/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`。当前 HEAD `d9efa226`，有五个未提交 M04 修复文件，先准确核对/保存 WIP，不重放旧任务。再正常合入本轮文档基线，使用 `codex/beta-local-unification-m05` 分支；不 reset/rebase 覆盖既有工作。
- 实施者只改产品、必要测试、窄 package scripts 及本人 `attempts/M05-sol-xhigh.md`。不修改 root 的设计/state/HANDOFF，不写 LF39 工程，不操作用户预览/profile/凭据/真实模型或数据库。

## 任务清单与交付顺序

| ID | 工作 | 状态 | 验收出口 |
| --- | --- | --- | --- |
| M05-01 | beta 能力保留矩阵、旧服务依赖清单、增量工作/thread/执行接口 | ready | 明确所有既有功能对应实现/测试；先报具体扩展点，由 root 审查后实施 |
| M05-02 | 本地独立工作及统一 UI | pending | 普通 Bot 直接使用；任务只在右侧；同一 ChatContainer/详情/附件/工具；无需 Java/MySQL |
| M05-03 | 主对话协调工具、继续/完成、并发与持久恢复 | pending | 真实创建/转达、同任务多轮、不串上下文、主对话不被独立任务堵塞、故障不重跑 |
| M05-04 | 可演示的 mock 个人/群渠道接入 | pending | 真实本地链路，来源隔离、明确绑定/@触发/关联回复、重复投递和离线状态；模拟标识 |
| M05-05 | App 冗余清理、旧数据保留、beta 全能力回归与演示 | pending | 去第二套服务 UI/默认 worker，保留所有 beta 功能、实际 UI/重启/文件闭环，root 验收 |
| M06-IM | LF39 真实群/个人协议、Java 精简合仓、真实招乎联调 | deferred_by_user | 本轮只记录接口与待办，不实施、不作为 MVP 阻塞 |

上表为同一已授权目标的实施顺序，不要求每步重新询问用户。实施者按阶段保存检查点并接受 root 审查，修复后继续下一阶段；未完成不得把部分交付称作本轮完成。

## M05-01 首次接口检查点

报告：新增表/字段及升级幂等策略；BotWorkItem 与既有 BotTask/Thread 关系；Send/Open/Stop 的精确目标；协调工具及请求回执；会话级调度与共享资源冲突；UI 状态/右侧分页；现有 beta 功能保留矩阵；mock 与旧生产 IM 边界；旧服务入口/历史处理清单。允许只读调查和 WIP 保全，root 审接口后再开始产品变更，不需要向用户追加确认。

## 必须覆盖的验收旅程

1. 普通问答不增工作；手动或模型交办建一工作/一独立 thread；失回包/重复工具不会重复创建。
2. 右侧打开工作，中间目标/草稿/附件准确；主对话可返回，后台新工作不抢焦点；小窗/暗色/长标题/IME/滚动/未读/超过六条工作可访问。
3. 多轮修改包含上一助手结果；主对话向指定工作补充；歧义/跨 Bot/跨群/跨个人受众不误路由。
4. 完成/继续同一工作；已结束执行不等于已送达或验收。停止仅当前执行，失败/未知/重启/晚回包正确。
5. 同 Bot 主会话与工作可同时推进；同 thread 串行；共享文件和浏览器冲突受控；不破坏 beta 群协作/后台通知/人工接管。
6. 原 beta 所有功能保留：创建/编辑/模型/标签、附件拖拽导入/资料库/预览导出/交付、浏览器、工具/MCP/技能、记忆、例行任务、群/协作、回复引用、搜索/置顶/未读/归档/删除、流式与恢复。实施列出证据，不用 stub ChatContainer 的测试冒充功能回归。
7. mock 个人/群入口是真实本地执行，正确源渠道回传；去重/权限/断线/引用跟进/附件不可送达不伪成功；生产 IM V1 全回归保持。
8. 既有 beta SQLite/Profile 升级幂等且数据不丢；旧服务数据保留、不重跑 pending/unknown；Java/MySQL 全关闭仍能演示全部本地新流程。

## 检查、提交和资源

- 先执行影响范围内已有 Bot/IPC/Runtime/IM 测试，再补新增行为的必要测试；不删除旧断言来换通过。最终 node/web types、隔离 App build、原生 SQLite/实际 UI/进程重启与 beta 能力矩阵覆盖。
- 测试仅虚构材料、fake 模型和自有临时 profile；不直接使用现有用户 App/服务或秘密。现有用户预览由 root 保护，更新前重新核实真实运行状态，不依赖文档旧 PID。
- 不启动 Java/DB builder：本轮无需后端实施。无必要不操作 Docker/ES/S3。若改 ES 查询，必须给出过滤/聚合/分页/请求数和并发的验证证据。
- 小步可审查提交，候选冻结后停写，由 root 独立复验和正常合入。未 push/deploy，scheduler 保持 PAUSED。
