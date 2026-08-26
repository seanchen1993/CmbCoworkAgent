# CMBDevClaw 与 DeepSeek Harness：当前源码亮点与端到端交付对比

> 更新：2026-08-25。比较基线为 CMBDevClaw `179162c`（含本地待提交的 Workflow 持久化改动）与 DeepSeek Harness `b150a55`（`dsh-0.1.1-rc.2`，工作区干净）。
>
> DeepSeek Harness 在本机没有比 `rc.2` 更新的提交；但相对前次分析的 `99f6f02`，已经累计 **743 个提交、3,319 个文件变更**。下文只以当前源码为准。

## 汇报结论

**CMBDevClaw 是更完整的端到端企业桌面交付产品；DeepSeek Harness 是更强的 Agent 运行时与可组合基础框架。**

如果目标是“用户交付一个真实、长期、会修改代码并需要审批的任务”，当前应以 CMBDevClaw 为主体：它的可恢复 Workflow、Worktree/Git、审批、模型故障转移、桌面交互、定时/心跳/ChatX 和 Trace 评估已经连成一条产品链路。

DeepSeek Harness 不应被看成较弱的简化版。它在可继续 Agent、Session 事件回放、工具统一执行、Code Mode、跨平台沙箱、模块生命周期、Headless/ACP/SDK 和架构测试门禁上更强；但其中 Agent Teams 等能力仍是 experimental，动态工作流脚本 Run 也不能像 CMBDevClaw Workflow 一样跨进程 journal resume。

## 先修正旧结论

| 旧印象 | 当前源码事实 | 新结论 |
| --- | --- | --- |
| DeepSeek 长子 Agent 不可恢复 | `startContinuable()` 持久化描述符和会话；`followup()` 会冷恢复不驻留 child。 | DeepSeek 已具备可继续、可冷恢复的后台 Agent。 |
| DeepSeek 多 Agent 只是一次性委派 | Agent Teams 有持久成员名册、mailbox、任务 DAG、CAS 更新、等待和恢复协议。 | 协作运行时很强，但为 experimental、默认 bundle 不启用。 |
| DeepSeek CodeExec 只是简单 Worker | Code Mode 支持 TS/Python、空环境、资源预算、强制终止，并让内层工具重走完整管线。 | DeepSeek 在代码编排的运行时一致性上领先。 |
| CMBDevClaw 的 Windows 沙箱明显更强 | DeepSeek 新增 Windows ACL restricted-token runner；Linux bwrap/Landlock、macOS Seatbelt，并在无 runner 时 fail-closed。 | DeepSeek 的跨平台强制执行更体系化；CMBDevClaw 的审批、Git 和桌面交付体验更成熟。 |
| CMBDevClaw 的压缩明显更强 | DeepSeek 已有事件化压缩事务、工具配对边界、溢出恢复和 spill。 | 两者各有强项，不应再做单边结论。 |

## CMBDevClaw 的亮点功能

| 亮点 | 当前实现 | 对端到端交付的价值 |
| --- | --- | --- |
| **可恢复动态 Workflow** | 脚本在确定性 sandbox 执行；Run 原子写入、`.bak` 回退、append-only journal、按 `agent()` 内容哈希重放；具备并发、总 Agent 数、token 和结果大小上限。 | 应用/模型中断后，已完成的子任务不必重复执行；适合长程研发。 |
| **Worktree 原生交付** | Workflow Worker 进入隔离 Git Worktree，原生 `git add/commit`；结合 lease、清理、审批和 Git 策略。 | 并行 Agent 写代码时避免工作区互相污染，结果可审计、可合并。 |
| **Coordinator Worker 产品闭环** | 后台 Worker 有持久终态、结果通知、恢复入口、无活动 watchdog、审批等待豁免。 | 前台对话不被长任务阻塞，任务完成或失败不会静默丢失。 |
| **企业安全与审批** | `safe/needs_approval/forbidden` 命令分级、永久审批规则、危险 Git 操作和敏感路径治理；Windows 限制令牌/提权适配。 | 让真实项目可在可控边界内自动改代码和提交。 |
| **强 Hook 治理** | 全局/工作区/插件/Skill Hook；支持 `updatedInput`、`onBlock`、Pre/PostTool、Subagent、Stop/StopFailure 等生命周期。 | 将合规、质量门禁和企业流程嵌入 Agent 行为，而不只依赖 Prompt。 |
| **多模型与网关韧性** | LangChain Provider、模型路由、错误分类、同模型重试、Failover 与企业网关状态适配。 | 降低单一模型、限流或企业代理异常对长任务的中断。 |
| **上下文容错压缩** | 摘要质量校验、无文本 fallback、overflow 分层重试、初始/最新用户请求锚点、完整历史归档。 | 长任务在异构模型/网关下仍能保住需求、证据和下一步。 |
| **可沉淀的 CodeExec** | 独立 helper 进程经本地 token bridge 调 MCP；脚本可分析输入并提升为 Saved Tool。 | 将一次成功的跨工具编排沉淀为后续可复用能力。 |
| **代码理解与浏览器执行** | Java LSP 暴露定义/引用/实现/诊断/调用层级；内置浏览器支持 Playwright MCP、录制、脚本库和回放。 | 改代码和验证 Web 流程不必只靠文本猜测。 |
| **长期触达能力** | Scheduler、Heartbeat（固定线程与 `HEARTBEAT.md`）、ChatX WebSocket/HTTP 机器人和通知链路。 | Agent 可在用户不在线时巡检、定时执行、从业务入口接收任务并回传。 |
| **自优化底座** | 加密 Trace；Skill 过程/结果评分、产物和测试证据；候选 Skill create/patch；人工审批后写回。 | 已具备从真实交付中抽取可复用经验的产品闭环雏形。 |

## DeepSeek Harness 的亮点功能

| 亮点 | 当前实现 | 对端到端交付的价值 |
| --- | --- | --- |
| **Session 是唯一事实来源** | append-only 事件日志派生模型历史；request header、surface projection、JSONL/SQLite 持久化和 projection 使请求可重建。 | 能准确回答“模型看到了什么、哪一步工具造成偏航”。 |
| **Session Query** | 对授权会话做有界读取、关系/血缘查询、事件关系筛选和 SQLite 全文搜索。 | 长任务出现问题时能从大量历史中定位相关事实，而非只读摘要。 |
| **Continuable Subagent** | 持久 child 描述符、FIFO follow-up、冷恢复、父子权限、结算通知和子级优先回收。 | Agent 可从一次委派升级为可长期唤醒和协作的角色。 |
| **Agent Teams（实验）** | 持久 teammate roster、点对点 mailbox、共享任务 DAG、任务 revision/CAS、等待语义和重启恢复。 | 解决多 Agent 下消息丢失、重复投递、任务归属不清等结构性问题。 |
| **Goal Round 驱动** | 同会话持久 Goal，空闲时按 Round 自动续行；revision、上限、取消和恢复均进入日志。 | 将“继续做直到完成”变成可控状态机，而非无边界循环。 |
| **统一工具执行管线** | 原生工具与 Code Mode 子调用都经过 `pre-execute → guards → execute → post-execute → result`，并记录父子关联。 | 安全、审计、Hook、UI 呈现不会被脚本化调用绕开。 |
| **Code Mode** | 以一个 `run_code` 承载多工具编排；TS/Python runtime，空环境、堆/CPU/墙钟/输出预算、强制终止和统一结果账本。 | 批量调用工具时减少 schema 负担，同时保持治理与可观测性。 |
| **事务化压缩与 spill** | 压缩有 start/summary/replace/end 事务边界，确保工具调用配对；溢出后重试，超大输出进入 spill。 | 崩溃或压缩失败不伪造成功状态，保留可回放证据。 |
| **跨平台 fail-closed 沙箱** | Linux bwrap/Landlock、macOS Seatbelt、Windows ACL restricted-token；不能保证完全隔离时明确标记 partial。 | 运行环境不满足约束时拒绝执行，而不是悄悄降级为无限制。 |
| **能力 seam 与 Cordis 生命周期** | Service Definition/Provider/Consumer 分离；Scope/Effect 约束注册、卸载、rollback 与 HMR；Preset/Profile/Bundle 按会话组装。 | 扩展 Agent 时不易产生残留监听器、服务冲突和不同宿主行为漂移。 |
| **多宿主交付** | Kernel 不绑定 Electron，已有 Web、Headless、ACP、SDK 和客户端 slot 体系。 | 同一能力可部署到桌面、IDE、服务端和自动化环境。 |
| **附件、LSP、PTY 与后台 Jobs** | 附件内容寻址及统一图片请求链路；通用 LSP seam；持久 bash/pwsh PTY；统一 job 控制。 | 支持多模态、代码导航和长命令，而不把每种能力塞进 Agent loop。 |
| **架构测试门禁** | 请求可重建、事件配对、真实组合启动、HMR 清理、生成 catalog/文档和覆盖率分区均有门禁。 | 大规模重构时更容易发现“功能表面正常、运行时契约已破坏”。 |

## 同类亮点逐项对比：谁更强

| 能力维度 | CMBDevClaw 的强项 | DeepSeek Harness 的强项 | 当前胜者 | 原因与边界 |
| --- | --- | --- | --- | --- |
| 长程工程 Workflow | 可恢复 Run、journal replay、Worktree、审批、Git 交付和 UI 结果回传。 | 动态脚本在 Worker Thread 隔离、可取消、有并发/总 Agent 上限。 | **CMBDevClaw** | DeepSeek 的 workflow Run 不跨进程恢复；CMBDevClaw 已把恢复与代码交付绑定。 |
| 长驻 Agent 生命周期 | Coordinator Worker 的终态持久化、通知、watchdog 和 continue。 | continuable subagent 的持久身份、冷恢复、父子授权和生命周期收敛。 | **DeepSeek Harness** | DeepSeek 是更通用、更严格的生命周期模型；CMBDevClaw 更贴近当前 UI 产品。 |
| 多 Agent 协作 | Coordinator/Worker + Worktree 隔离，适合并行改代码。 | 持久 mailbox、任务 DAG、CAS 和 wait 协议。 | **DeepSeek 架构领先；CMBDevClaw 交付领先** | DeepSeek Teams 仍 experimental；CMBDevClaw 的 Worktree 是真实代码交付更需要的隔离。 |
| 会话、观测与排障 | Checkpoint、Trace、历史归档和任务卡。 | 事件源 Session、request header、projection、session-query、关系/血缘。 | **DeepSeek Harness** | DeepSeek 能更精确重放模型请求和运行因果。 |
| 交付质量评估与学习 | Trace/Skill/结果评分、验证产物、外部回归套件、候选 Skill 审批。 | 高质量运行日志和测试不变量，但没有 Trace → Skill 候选产品链。 | **CMBDevClaw** | CMBDevClaw 更接近“从真实交付中学习”。 |
| 工具编排与 CodeExec | MCP bridge、Saved Tool、与业务工具库结合。 | Code Mode 内外同管线、TS/Python、资源账本、子调用关联。 | **各有强项** | CMBDevClaw 更适合沉淀业务编排；DeepSeek 更强在调用不绕过安全和观测。 |
| Hook/审批/业务规则 | `updatedInput`、`onBlock`、更广生命周期、Git 与企业规则。 | typed interception，Claude/Codex bridge；但 bridge 忽略 `updatedInput` 且事件不完整。 | **CMBDevClaw** | 企业治理的表达能力更强。 |
| 上下文压缩 | 模型质量 fallback、多网关 overflow、任务锚点。 | 事件事务、表层 replace、工具配对、token meter、spill。 | **各有强项** | 前者更抗真实模型异常，后者更可回放、可证明。 |
| 沙箱与安全底座 | 命令分类、审批缓存、Git/Worktree 保护、Windows 桌面交互。 | 多平台 runner、策略事件化、fail-closed、Windows ACL 边界显式化。 | **DeepSeek 底层领先；CMBDevClaw 交付治理领先** | 都不是可被简单替换的能力。 |
| 模块化与多宿主 | Electron 桌面和本地产品集成。 | Cordis 生命周期、Preset/Profile/Bundle、Web/Headless/ACP/SDK。 | **DeepSeek Harness** | DeepSeek 更适合把同一 Agent 运行时投放到多种宿主。 |
| 模型与企业网关可用性 | LangChain Provider、路由、Failover、企业状态码适配。 | 声明式 provider/model catalog、凭据和授权 flow。 | **CMBDevClaw** | CMBDevClaw 更贴近企业网关不稳定时的持续交付。 |
| 浏览器与桌面作业 | 内置浏览器、录制/回放、Playwright MCP、文件/PDF 预览、ChatX。 | Web 工具、Web GUI，但无等价的企业桌面工作流产品。 | **CMBDevClaw** | 业务验收需要实际浏览器操作和企业消息回传。 |
| 测试与架构门禁 | Workflow/沙箱/审批/产品行为回归。 | 请求重建、持久化、事件配对、真实组合、HMR 和文档生成门禁。 | **DeepSeek Harness** | DeepSeek 的结构性防回归能力更系统。 |

## 为提升端到端交付，CMBDevClaw 最该借鉴什么

### P0：把现有“自优化”补成可量化的闭环

这是最值得优先投入的方向，因为 CMBDevClaw 已有前半段能力，不需要先迁移架构：

```text
现有：Trace → Skill/结果评分 → 候选 create/patch → 人工审批 → 写回 Skill
补齐：候选版本 → 固定任务集/隔离 Worktree 回放 → 基线对照 → 小流量灰度
      → 达阈值晋升默认版本 → 指标回落自动回滚
```

晋升指标应面向交付，而不是只评模型回答：**任务成功率、构建/测试/浏览器验收证据、返工次数、工具错误率、审批拒绝率、token、耗时、人工接管率**。候选变更先限制在 Skill、Prompt、角色策略、工作流模板；不要让系统自动修改核心执行器、审批策略或沙箱。

**直接收益**：把“某次任务做得不错”变成“下一次同类任务可稳定少返工、少 token、更多验收通过”。

### P1：借鉴 DeepSeek 的持久协作协议，而不是直接搬 Agent Teams

将 CMBDevClaw Coordinator/Worker 补成最小的持久协作控制面：

- 对 Worker 任务使用稳定 id、版本号、owner、依赖和状态迁移；
- 持久化父子消息，并区分“已入队”“已送达”“已消费”；
- 只允许在 Worktree/写入范围不冲突时并行写；
- 应用重启后按日志恢复未完成任务和未送达结果；
- 仍保留 CMBDevClaw 现有 Worktree 隔离与人工审批。

**直接收益**：多 Agent 长任务不会因通知竞态、重启或并行修改而丢任务、重复做或互相覆盖。

### P1：让所有工具路径收敛到同一治理与证据管线

借鉴 DeepSeek Code Mode 的原则：普通工具、MCP、CodeExec、Workflow 子 Agent、后台任务都应生成同一类执行事件，并统一经过策略、审批、Hook、结果留存和 UI 呈现。CMBDevClaw 已经有很强的工具/Hook/审批能力，缺口主要是跨路径的一致关联与可查询证据。

**直接收益**：减少“常规工具受控、脚本/MCP/子 Agent 绕过规则”的隐患；也让自优化可以用同一份高质量 Trace 评分。

### P2：将关键交付事实补成事件投影，而非替换现有 Checkpoint

不必把 CMBDevClaw 全量重写成 DeepSeek 的 Session 架构。应针对长程 Workflow 增加一层 append-only delivery ledger：记录任务输入版本、模型请求摘要/配置、工具决策、审批、Worktree commit、测试/浏览器证据、终态和恢复原因，并生成 UI/Trace 投影。

**直接收益**：支持“为什么失败、从哪一步恢复、哪个 Skill 版本造成回归”的快速定位，也为 P0 自优化提供可信训练数据。

### 暂不建议做的事

- **不要把 Cordis 当成自进化本身。** Cordis/创造模式解决动态组件的定义、运行、停止和回滚；没有候选评测、灰度和指标晋升，就不是自进化。
- **不要直接引入 DeepSeek experimental Agent Teams。** 应借其协议思想，按 CMBDevClaw 的 Worktree/审批模型重建最小版本。
- **不要用 `node:vm` 或 Worker Thread 宣称不可信代码隔离。** 二者只能改善资源收敛；安全仍需要进程/容器/OS 沙箱和审批。
- **不要替换 CMBDevClaw Workflow 为 DeepSeek workflow。** 这会失去当前对端到端交付最关键的 Run journal resume 与 Worktree/Git 闭环。

## 结论：采用策略

短期采用 **“CMBDevClaw 负责交付产品，吸收 DeepSeek 的运行时原则”**：先做 P0 自优化闭环，再做 P1 协作控制面和统一工具证据管线。这样能直接提升长程任务的完成率、验收率和可恢复性，而不会牺牲已成熟的 Worktree、审批和企业桌面链路。

## 复核源码位置

- CMBDevClaw：`README.md`、`src/main/agent/workflow/engine.ts`、`workflow/run-store.ts`、`workflow/subagent.ts`、`coordinator-worker-manager.ts`、`code-exec/runner.ts`、`code-exec/script-runtime.ts`、`tool-hooks.ts`、`context-summarization-middleware.ts`、`optimizer/skill-optimizer.ts`、`skill-eval/`、`local-sandbox.ts`、`ipc/browser.ts`、`ipc/lsp.ts`、`services/scheduler.ts`、`services/heartbeat.ts`、`services/chatx.ts`。
- DeepSeek Harness：`docs/architecture.md`、`packages/subagent/subagent/README.zh.md`、`packages/experimental/agent-team/README.zh.md`、`packages/goal/goal-round-driver/README.zh.md`、`packages/workflow/workflow-worker-thread/README.zh.md`、`packages/code-runtime/code-runtime-worker-thread/README.zh.md`、`packages/core/tools/README.md`、`packages/compaction/compaction/README.zh.md`、`packages/sandbox/sandbox-local/README.zh.md`、`packages/session-query/README.zh.md`、`packages/README.zh.md`。
