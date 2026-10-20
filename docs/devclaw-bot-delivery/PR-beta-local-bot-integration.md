# PR：扩展 beta Bot 的独立任务、本机会话关联和模拟 IM 接入

本文供 `devclaw-bot-beta` 开发者审阅和接手 `codex/devclaw-bot-integration`，描述截至 **2026-10-20** 的最终实现。早期 integration 中的服务专家、需求文档版本和 Java 主导任务流已退出当前 App 主流程；历史设计不能替代本文的现状说明。

## 变更摘要

在 beta 原有 Bot 界面、Thread、模型配置、本地数据和执行引擎之上，增加可持续处理的独立任务：在右侧创建和查找任务，在中间原有聊天界面交办、修改、完成或继续；同一个任务也能从本机「对话模式」打开。普通问答继续留在 Bot 主对话。

新增本地模拟个人/群 IM 接入，用真实本地执行链验证渠道来消息、创建任务、修改、确认及回传。当前演示无需 Java/MySQL；真实 IM 网关接入延后。新建 Bot 与配置了专业职责的 Bot 使用同一套能力，不再维护两套产品入口。

变更类型：功能扩展、问题修复、旧链路清理、设计与验收文档。没有关联的 Issue 编号。

## 比较基线与合并注意事项

| 项目 | 提交 / 状态 |
| --- | --- |
| 最初实际合入的 beta | `91554cbc7df0b78e37c48d31b72628c16662911a` |
| 本文核对的 integration 快照 | `c35daaef35bc3d4c82a406d1cdf008b699ae58a7` |
| 最终产品候选 / 集成 merge | `bbe06f47` / `301a99a7` |
| 2026-10-20 定向 fetch 核对的远端 beta | `650c6ba3013b150bb17279d779b5d5f7747fe259` |

**当前分支尚未包含 beta 在 `91554cbc` 之后的 3 个提交。** 因此，“保留 beta 能力”的实现及验收基线是最初合入的版本，不能理解为已经同步最新 beta。后续合并必须保留下面这些新增能力：

| beta 后续提交 | 提交主题 |
| --- | --- |
| `b22bff09` | `feat(bots): align conversation flows and bounded group collaboration` |
| `7d97a7fd` | `fix(bots): preserve group member links and report interrupted work` |
| `650c6ba3` | `feat(bots): support inline group questions and composer replies` |

两边共同修改了 Bot Host/Store、Runtime、IPC、聊天容器和 Bot UI。最新 beta 中的 `group-discussion.ts`、`continuation.ts`、`BotGroupQuestion.tsx` 等文件尚不在 integration 中；它们在两端快照比较中显示为删除，**并非本次要求删除的冗余功能**。需做语义合并，不能整文件选用 integration 覆盖 beta。

建议使用两种视角：

```sh
# 本分支自共同基线以来的增量，先聚焦当前 App
git diff 91554cbc..codex/devclaw-bot-integration -- src tests package.json

# 双方当前快照差异，识别 beta 后续能力尚未同步的部分
git diff origin/devclaw-bot-beta codex/devclaw-bot-integration -- src tests package.json
git log --oneline 91554cbc..origin/devclaw-bot-beta
```

三点比较 `origin/devclaw-bot-beta...codex/devclaw-bot-integration` 只展示共同祖先之后本分支的变化，不能证明已包含 beta 后续提交。全仓差异还包含 integration 原有的 `playwright-main/` 等大目录、需求/原型能力、历史 Java 服务、契约和开发脚本；不要把这些全部计作本次 Bot 扩展，也不要据此批量删除。接手时应先按下文模块审查，再决定历史目录的最终归属。

### 分支还携带哪些早期增量

这些内容同样存在于与 beta 的全仓差异中，但应与本次本地 Bot 融合分开审查：

| 早期增量 | 当前定位与审阅入口 |
| --- | --- |
| 需求模式、需求历史、原型设计/批注、设计系统与模板 | integration 先前合入的业务能力，当前保留；入口包括 `src/renderer/src/components/requirement/`、`components/design/`、`src/main/ipc/requirements.ts`、`design.ts`。它们是独立模式，不代表所有 Bot 工作都要走需求流程 |
| 需求服务凭据与发布边界 | 凭据留在主进程，通过受控 IPC 查询/发布，避免向模型提供凭据；见 [F02 验收](reviews/F02-acceptance.md)。真实发布连接器仍缺失，不能将接口及 mock 验证理解为生产发布已通 |
| Java/MySQL 任务、节点授权、执行租约、专家/团队记忆及契约 | 旧服务架构的历史成果保留在 `services/bot-control/`、`contracts/bot/` 和对应测试中；当前 Bot 本地闭环不使用它们，不应恢复成另一套业务任务权威 |
| 开发环境与契约工具 | `deploy/dev/` 及契约生成脚本服务于早期独立服务开发，不是本地 Bot 演示的启动前提 |
| 浏览器扩展与大目录 | `chrome-extension/` 为已有 Windows Cookie 导入扩展；`playwright-main/`、`.playwright-mcp/` 等也会扩大仓库 diff。当前验收没有重新验证 Windows 导入或逐项审查这些历史目录的分发必要性 |

本次清理针对旧专家 App 链路；上述早期增量没有被统一删除或全部重新验收。beta 开发者若只接收当前 Bot 扩展，应显式决定其余模块和资源的接收范围。

## 相比已合入 beta，新增了什么

| 维度 | beta 已有能力 | 本分支增加或修正 |
| --- | --- | --- |
| Bot 产品界面 | Bot 列表、主对话、右侧详情/资料库/电脑、职责、例行任务等 | 独立任务放入右侧详情；统一新建 Bot 和专家 Bot，移除旧服务专家专区 |
| 工作组织 | 对话消息和逐次执行记录、最近工作 | 增加持续存在的业务任务，跨多轮修改保持同一会话；最近执行活动与独立任务分开 |
| 任务完成 | 单次执行的运行/结束状态 | 独立的业务完成/继续状态；回复成功不自动等于用户验收完成 |
| 会话关系 | Bot 与普通对话各有入口 | 一个真实 Thread 可从 Bot 任务和本机对话双向打开；可显式关联既有普通会话 |
| 模型 | 用户默认模型及显式模型选择 | 显式模型缺配置或凭据时明确报错，避免静默换供应商造成“选择未保存”的错觉 |
| 渠道 | 原有 IM 接线 | 增加本地模拟个人/群绑定及消息流，补齐来源、受众、去重、离线、撤销和回传边界 |
| 运行可靠性 | 本地 Host、队列、执行、工具和通知 | 将目标任务贯穿发送、文件、浏览器、停止、协作回传、未读与恢复，防止串会话 |

原有文件交付、浏览器操作、审批、技能、Bot 私有记忆、调度和本地数据体系继续复用。新的任务能力没有要求所有任务生成 PRD，也没有新增强制成果文件、成果版本下拉框或退回表单。

## 产品行为与数据关系

### 1. 主对话负责交流，独立任务承载持续工作

- 左侧保持 beta 的 Bot/群入口；选择 Bot 后，中间默认显示主对话。
- 日常提问直接回复。明确交办时，可通过右侧「独立任务」或主对话中的任务工具创建工作。
- 右侧列表支持搜索、分页、状态和未读展示；点击任务后中间切换到它的会话，随时可返回主对话。
- 修改意见就是该任务中的下一条消息。文本、文件或实际操作都可以是结果，不要求固定文档格式。
- 「完成任务」与「继续任务」操作同一项工作；继续后保留原会话和历史。

例如：主对话交办“写一条读书会通知”→右侧出现任务→任务会话产出正文→发送“改为周日下午四点”→同会话修改→用户确认完成→右侧显示完成；需要再改时继续原任务。

### 2. 区分业务任务、执行和对话

| 概念 | 职责 |
| --- | --- |
| `BotWorkItem` | 一件持续工作的标题、目标、归属、完成状态及会话引用 |
| `BotTask` | 一次排队/运行/失败/结束的执行；同一工作可以发生多次执行 |
| `Thread` | 实际消息历史、草稿、工作目录和模型等会话设置 |
| 渠道回执 | 输入是否接收、回复是否送达；不代替上述业务或执行状态 |

本地工作当前对应一个固定 Thread。`BotWorkItem.version` 用于并发更新校验，**不是成果文档版本管理**。

Agent 可以通过 `bot_work_list/create/send/complete/continue` 工具管理工作，但完成/继续遵循明确的用户意图；普通回复结束或正文写着“完成了”不会直接关闭业务任务。主进程还检查当前版本及在途协作/后台工作，避免未结束的执行被错误确认。

### 3. Bot 任务与本机对话使用同一份数据

- 任务中的「在对话模式打开」和普通会话中的「返回 Bot 任务」指向同一 Thread，消息、草稿、附件、目录和模型设置共用。
- 可显式关联已有普通本机会话；保留原消息和设置，不复制历史，不因关联自动执行。
- 关联后的发送仍经过 Bot Host，不能从另一入口绕过已完成状态、来源约束或队列。
- 关联/解除使用持久握手记录，覆盖两套本地存储之间的中断恢复。一个会话同一时刻只关联一项工作。
- 解除关联保留会话历史；删除 Bot 时区分“关联的既有会话”和“任务创建的会话”，保护前者。
- 新建任务通常使用 Bot 的共享工作目录；关联已有会话时保留它原来的目录。**目前不会自动为每个任务创建独立文件夹或 Git worktree。**
- `local_thread` 已实现；`project_session`、`cloud_session` 仅预留引用类型，不会静默降级为本地会话。

## 模拟 IM 接入与后端边界

入口为 Bot 更多操作中的「模拟 IM 接入」。新建个人或群绑定，设置渠道标识、名称和允许的模拟用户，再发送文字；在弹窗查看输入/回复，在 Bot 右侧继续相应任务。

| 场景 | 当前行为 |
| --- | --- |
| 个人绑定 | 限定一个模拟用户；普通问答留在该渠道会话 |
| 群绑定 | 指定允许的用户；通过结构化提及 Bot，或引用同绑定的 Bot 已发送消息触发；正文包含 `@` 本身不构成授权 |
| 创建独立任务 | 明确交办后创建同受众任务；任务显示在 Bot 右侧 |
| 桌面继续渠道任务 | 保留原渠道来源；回复仍回原渠道，不因从桌面打开就升级成本机权限 |
| 模拟离线 | 输入排队，恢复后按既有队列处理 |
| 撤销绑定 | 拒绝新输入、取消未开始执行并阻止后续发送；不把撤销当作删除历史 |
| 丢失接收回执 | 根据原事件身份和内容指纹核对；不能换一个 ID 盲目重发 |
| 送达结果未知 | 保留可核对状态，不当作已送达或自动重发 |

模拟的是**接入渠道**，执行仍使用本地 Bot 和当前配置的模型。正常使用该界面可能真实调用模型；自动化验收使用隔离 profile 和 localhost 固定模型，两者不要混淆。

当前外部受众仅开放文字与同受众的五个工作工具，不提供本机文件、shell、浏览器、MCP、技能、私人记忆、配置或子代理能力。主进程验证来源与目标，工具实际执行也检查权限，不能只靠模型提示或 UI 隐藏。外部文字中的 `/goal`、coordinator 前缀不会启动桌面控制；内部保留协议串在持久化前拒收，用户可修改后重发。

**后端目标保持为接入层：** 后续在 `LF39_devclaw_im_gateway_0821` 中承接个人唤起、群绑定、身份/授权、路由、事件与回执；会话、任务、模型执行和业务状态仍由 App 本地管理。生产认证、WSS、断线补发和真实平台群消息尚未联调。模拟 DTO 与生产 `RemoteImEventV1` 分离，不能直接将模拟用户 ID 当作真实认证结果。

## 可靠性与性能优化

| 改动 | 解决的问题 / 验证依据 |
| --- | --- |
| 操作 ID、工具调用身份、持久回执与版本校验 | 创建/发送/完成失回包后可核对，避免重复任务、重复模型执行或迟到操作覆盖当前状态 |
| 固定 Thread 与精确执行目标 | 文件、浏览器、通知、草稿、未读和补充消息跟随对应工作，切换 UI 不改变归属 |
| 队列及资源范围 | 默认 Host 并发仍为 2；按会话串行，工作及其协作限流；共享目录复用锁，停止只处理对应任务族 |
| 已完成工作的迟到结果处理 | 不因历史协作/后台回包自动重新打开或运行工作 |
| 列表只读摘要、批量补齐 | 不逐任务读取完整消息正文；目录测试覆盖 45 项、单批上限 40、最多一个列表请求在途 |
| 模拟历史稳定游标 | 覆盖 171 条历史、超过一页的突发消息及切绑定后的迟到响应，发现窗口缺口后明确重载 |
| 恢复扫描高水位、索引及分批 | 每批最多 40 条元数据，批间让出事件循环；105 条按 40/40/25 恢复，不做无界读取 |
| 恢复完成后才清理旧记录 | 防止长期积压的未补回执被保留策略提前清除；验证 105 条旧记录均先补回执再清理 |
| 共用校验与执行入口 | 弹窗/主进程共用文字校验，普通对话入口也执行 Bot 关联门禁，减少两条路径行为漂移 |

以上是结构性优化和本地测试结果；本轮没有 ES 查询改动，也没有生产耗时或吞吐实测结论。

## 清理范围与保留内容

已经清理：

- 旧服务专家专属会话、成果卡片、专家配置/记忆面板、独立设置入口和相关旧 UI 测试。
- App 启动/退出中的旧 Partner 服务注册、活跃运行检测、停止逻辑。
- preload 的旧 `partnerDev` / `serviceConversation` API、旧服务适配器和默认 input-only Runtime 注册。
- 旧 Java 预览作为默认启动路径的安排；`dev:bot-preview` 现在启动普通 Electron App。

仍然保留：

- beta 的普通 Bot、IM、记忆、工具、审批等现有模块，以及 integration 原有的 requirements/设计模式。
- `services/bot-control/`、`contracts/bot/`、开发环境及历史服务测试：属于 integration 既有后端成果，尚未按新接入层定位合并进 IM 仓库，不是当前 App 的运行依赖。
- `src/main/services/bot/` 中必要历史协议/测试实现，说明见其 [README](../../src/main/services/bot/README.md)。默认 App 不导入这些构造器，也不恢复旧 worker。
- 用户旧表、旧 profile 和 Java 数据；按本轮决定不迁移、不提供旧专家历史查看，也不主动删除。

最终依赖检查从 App 入口分析了 1,251 个可达模块，旧 `services/bot` 模块为 0，同时确认正常 Bot、requirements 和生产 IM 仍可达。旧预览查询/停止脚本改为 `status:legacy-bot-preview` / `stop:legacy-bot-preview`，避免与新默认入口混用。

## 模型配置与凭据

沿用用户配置：未显式指定时使用现有默认模型选择逻辑；指定了模型的 Bot/会话使用对应配置，关联已有会话保留它自己的模型设置。

此前预览缺少所选模型对应的凭据，而运行时静默回退到其他模型，导致 `fetch failed` 且看起来选择未保持。产品修复增加 `SelectedModelUnavailableError`：明确选中的模型缺配置/凭据时，在构造 provider 前报出可操作错误，不静默换供应商；未指定/auto 的既有行为保留。补齐预览凭据是本机环境操作，不是代码中内置 DeepSeek 配置或 Key。

用户本地 Key、模型配置和预览 profile 不作为本次交付文件。已对读取到的本地凭据做内存中的精确匹配审计，未在所查 Git 对象中发现匹配值；审计不输出凭据。仓库既有 `.env` 是已跟踪的 `CMBENV1` 加密文件，本轮没有修改；不能仅因存在 `.gitignore` 就认为它未被跟踪。

## 关键代码审阅入口

以下按业务关系阅读，比按全部提交时间顺序回放更直接：

| 模块 | 入口 |
| --- | --- |
| 工作与会话契约 | [work.ts](../../src/shared/bots/work.ts)、[conversation.ts](../../src/shared/bots/conversation.ts)、[contracts.ts](../../src/shared/bots/contracts.ts) |
| 本地权威状态/调度/工具 | [store.ts](../../src/main/bots/store.ts)、[host.ts](../../src/main/bots/host.ts)、[work-tools.ts](../../src/main/bots/work-tools.ts)、[runtime-adapter.ts](../../src/main/bots/runtime-adapter.ts) |
| 双入口关联与恢复 | [conversation-link-service.ts](../../src/main/bots/conversation-link-service.ts)、[conversation-link-store.ts](../../src/main/bots/conversation-link-store.ts)、[agent IPC](../../src/main/ipc/agent.ts)、[threads IPC](../../src/main/ipc/threads.ts) |
| Bot UI 与普通对话 | [BotsWorkspace.tsx](../../src/renderer/src/components/bots/BotsWorkspace.tsx)、[BotWorkPanel.tsx](../../src/renderer/src/components/bots/BotWorkPanel.tsx)、[LinkedBotConversation.tsx](../../src/renderer/src/components/bots/LinkedBotConversation.tsx)、[ConversationTaskControls.tsx](../../src/renderer/src/components/bots/ConversationTaskControls.tsx) |
| IPC / preload | [bots IPC](../../src/main/ipc/bots.ts)、[bots preload](../../src/preload/bots.ts) |
| 模拟渠道 | [mock-channel.ts](../../src/shared/bots/mock-channel.ts)、[mock-channel-store.ts](../../src/main/bots/mock-channel-store.ts)、[mock-runtime-policy.ts](../../src/main/bots/mock-runtime-policy.ts)、[BotMockChannelDialog.tsx](../../src/renderer/src/components/bots/BotMockChannelDialog.tsx) |
| Runtime 权限与模型 | [standard-thread-turn.ts](../../src/main/agent/standard-thread-turn.ts)、[runtime-tool-allowlist.ts](../../src/main/agent/runtime-tool-allowlist.ts)、[selection-error.ts](../../src/main/models/selection-error.ts)、[routing/index.ts](../../src/main/routing/index.ts) |
| 旧链路断开证明 | [bots-legacy-disconnection.spec.ts](../../tests/bots-legacy-disconnection.spec.ts) |

## 验证结果与复现入口

已完成的主要验证如下；不同批次有重叠，不能把数量相加当作独立总量。

| 层次 | 已有证据 |
| --- | --- |
| beta 核心、IPC、shared、renderer 回归 | root 独立 65 文件、623 项通过；覆盖范围以验收记录为准 |
| 会话关联 | root 独立 113 项；实际 App 覆盖既有 Thread 关联、双入口修改、完成/继续、解除保留历史 |
| 模型选择 | 17 项定向检查；另一次获授权的真实 DeepSeek 短回复验证选择保持及 HTTP 200，不等于所有模型兼容验收 |
| 现有生产 IM 实现回归 | 19 个脚本通过，使用 localhost/隔离环境；不是生产平台联调 |
| 模拟渠道实际 App | 真实 preload/IPC/SQLite/Runtime/ChatContainer；个人/群交办、修改、完成/继续、离线、撤销、原渠道回传 |
| 审查发现问题的修复 | 积压恢复与清理 96 项、控制前缀边界 69 项及架构脚本、最终共享校验 13 项；实际弹窗补验失回执和无效输入 |
| 编译与界面 | Node/Web 类型检查、正常 main/preload/renderer 构建；明暗/窄宽布局、同 profile 原生界面与两入口切换检查 |
| 用户数据保持 | 升级前备份；重开后原 Bot、任务、消息、目录、模型与凭据配置保持，未代用户完成任务 |

验收使用 Node 22。常用检查入口：

```sh
npm run typecheck
npm run build
node node_modules/vitest/vitest.mjs run src/main/bots src/main/ipc/bots.test.ts --maxWorkers=2
node --import tsx tests/bots-legacy-disconnection.spec.ts
node --import tsx tests/desktop-agent-runtime-entrypoints.spec.ts
node --import tsx tests/standard-thread-turn-architecture.spec.ts
```

实际 App 夹具需独立构建目录和隔离 profile，不能直接借用正在演示的构建/profile。重点入口为 [本地任务旅程](../../tests/bots-local-work-app.spec.ts)、[会话关联旅程](../../tests/bots-conversation-link-app.spec.ts)、[模拟渠道旅程](../../tests/bots-mock-channel-app.spec.ts)、[模拟弹窗](../../tests/bots-mock-dialog-browser.spec.ts)。部分夹具仍依赖约定的 `/tmp` 构建路径/路径文件，例如 `M05_MOCK_APP_OUT`；接入 CI 前需统一成可配置入口，当前不声称可一键在任意机器完整重跑。

详细设计与证据：

- [统一 Bot 与本地任务设计](reviews/M05-beta-local-unification-design.md)、[本地任务阶段验收](reviews/M05-acceptance.md)。
- [本机会话关联设计](reviews/M05-local-conversation-link-design.md)、[关联验收](reviews/M05-local-conversation-link-acceptance.md)。
- [模型选择修复](reviews/M05-model-selection-fix.md)。
- [最终渠道模拟与旧链路清理验收](reviews/M05-channel-cleanup-acceptance.md)、[实施记录](attempts/M05-sol-xhigh.md)。

这些记录按阶段保留了当时的暂停、失败和待办；最终渠道状态以最后一份验收为准。本文整理时仅更新文档，未重新运行整套产品测试或调用模型。

## 接手后的待完成项

1. **先与最新 beta 做语义合并及联合回归。** 特别关注群内提问、成员链接、协作续接/中断、Host 调度和 `ChatContainer`；本文现有验收不覆盖尚未合入的 beta 后续三次提交。
2. **真实 IM 接入。** 在 `LF39_devclaw_im_gateway_0821` 实现并验证身份、个人/群授权、绑定撤销、路由、事件去重、离线恢复、回执和真实群触发；不能直接把本地模拟当作生产接入。
3. **后端精简合仓。** 按接入层的新职责筛选 `services/bot-control` 的可复用部分，停止沿用服务端作为业务任务/成果权威的旧设计，之后再清理历史 Java、协议和脚本。
4. **项目和云端会话适配。** 当前只有类型扩展口，需单独实现归属、工作区、执行/停止、权限、消息同步与生命周期，不能只增加 UI 选项。
5. **关联状态下的高级模式。** 当前受管任务使用 `/goal`、Mods 前需解除关联；如需直接共存，应单独设计调度和状态语义。
6. **测试工程化。** 将实际 App 夹具的临时路径、构建/profile 准备统一为可复现命令，再纳入 CI。

另一个已确认的 beta 既有体验问题：全局长期记忆关闭时，Agent 仍可能调用记忆工具并收到“长期记忆已在设置中关闭”。本分支没有更改该开关或重做记忆系统；如后续改善，应调整工具可见性/提示并补回归。

当前可交接的是：**统一 beta UI、本地任务与会话闭环、可运行的渠道模拟、旧 App 链路清理，以及对应设计/验收证据。** 最新 beta 合并、真实 IM/Java 合仓及项目/云端能力仍需后续实施。
