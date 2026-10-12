# 代码复用与移植计划

**当前部署基线（按用户 2026-10-02 补充）：首版支持 macOS 与纯 Windows 原生本机运行；Windows 禁止依赖 WSL2/Linux 容器，后续服务端为 Linux K8s。** 平台适配、存储与迁移以 [当前实施基线](12-windows-local-first.md) 为准；公共执行、恢复和授权契约继续适用。本文全量扩展保留为后续参考，不自动纳入本机首版。

## 1. 用户明确的实施原则

**已有源码里可用的实现直接拿来改造使用，包括 Grok Bot 和其他框架。优先写适配层与缺失部分。** 不把“研究源码”止于借鉴思路，也不先设计一套新实现再去找参考。

核心范围的最终接入约束见 [复核第 11 节](11-core-final-review.md)：移植前核对依赖闭包、原测试、Node/原生 ABI 与来源授权；Grok 内存调度和 Cmb 本地 checkpoint 不能直接当作跨 Host 持久运行能力。手机、语音和 Team Bots 等候选仅留档，本次不移植。

选择顺序：

1. Cmb 已有代码满足要求，直接复用或扩展。
2. 其他项目已有完整模块，优先连同必要依赖和测试移植，保留有用的模块结构。
3. 完整模块依赖过重，提取实际可用的子模块，替换输入、存储、事件和工具适配。
4. 现有代码确实缺失、不完整，或接入会破坏必要行为，再补写相应部分。

下面是基于已读代码的取用方向，不是已经成功集成的声明。来源编号可在 [源码索引](06-source-index.md) 定位到具体文件和固定版本。

## 2. 优先移植清单

| 能力 | 优先取用的已有代码 | 主要改造 | 确实需要补齐的部分 |
| --- | --- | --- | --- |
| Agent 内核与标准任务准备 | Cmb CM01～03：agent-run-service、standard-thread-turn、runtime | 抽出 Electron/路径/通知/存储依赖，注入服务端适配器 | 独立 Host 启动和远程运行身份 |
| 单 Bot 任务优先级与调度 | Grok GR03：run-scheduler.ts | 保留 user/agent/background、代次和中断逻辑，接入 Cmb 执行函数 | 与持久任务领取/恢复衔接 |
| 持久任务、lease 和恢复 | Rakazo RK01、RK02：executor.ts、job-reconciler.ts | 提取租约/对账执行链，替换模型执行入口与存储类型；避免带入第二套 Agent 内核 | Cmb checkpoint、数据库时间和部署适配 |
| 长期 Bot 消息 | Grok GR04 + Rakazo RK03：agent-to-agent-messaging.ts、bot-messages.ts | 使用 Grok 消息/优先级语义，移植 Rakazo 的事务投递机制，统一 Bot/会话 ID | Team Bot ACL、跨宿主投递和回执 |
| 群聊组织 | Grok GR05：group-chat-orchestrator.ts、send-group-fanout.ts | 沿用 responder、轮次、epoch 和扇出控制，替换消息和执行适配 | Cmb 群聊存储/展示、成员权限 |
| Bot 资料与复制 | Grok GR06：agent-clone.ts；Cmb 现有实体与存储代码 | 保留复制/排除规则，替换身份分配和存储路径 | 长期 Bot Registry、多端同步和团队发布 |
| 长期记忆 | Grok GR07：memory-service.ts、memory-synthesis-service.ts；Cmb CM07 | 移植显式事实、证据核验、删除标记等可用代码，接入 Cmb 检索/模型接口 | 成员私有和 Team Bot 公共作用域 |
| 示范录制与学习 | Grok GR08：teach-recording-service.ts；Cmb CM08 录制代码；原版受管学习配方观察 | 复用会话、队列与恢复逻辑；Windows 替换采集/进程部分，Linux 后续另行适配 | 自动保存/修改交互、模型能力与异输入验证；配方观察不等于学习链已移植 |
| 技能步骤结构 | Rakazo RK05：teach-playbook.ts | 复用事件归一化和步骤结构，接入上述学习链 | 视频理解、分支提取和泛化，不以坐标转文字代替 |
| 例程定义和运行 | Grok GR09：automation-store.ts、automation-runtime.ts；Cmb CM05；Rakazo RK02 | 迁移配置/触发/运行记录规则，替换落盘与执行入口 | 当前官方新增事件源、持久去重与恢复 |
| 具体动作审批 | Grok GR10、GR11；Rakazo RK04；Cmb CM09、CM12 | 保留动作绑定、epoch/过期和 effect receipt 等实现，接入单一授权链 | 持久 Interaction、多端竞争与恢复 |
| 动作网关与审计 | OpenBot OB02：computer/gateway.ts | 移植目标解析、执行前策略和审计边界，替换身份、数据库及 ComputerPort | Cmb 策略接入；不引入其必需 Intelligence 服务作为运行内核 |
| 持久队列辅助实现 | OpenBot OB01：work/queue.ts | 取用数据库时间、领取与有限重试相关代码，合入选定队列实现 | 与 Run/lease/outbox 统一；不并行维护两套权威队列 |
| 命令、事件和重连 | Grok GR02、GR16：send-pipeline.ts、gateway-client.ts、gateway-wire.ts；Cmb CM10 | 保留接收去重、错误分类、重连等代码，改接自己的 endpoint/身份/事件 | 多端 cursor、snapshot 和部署代理适配 |
| 电脑管理与查看 | Grok GR12、GR16 电脑连接/恢复及 GR15 viewer；Cmb CM08 | 复用可独立的生命周期、查看器及工具适配，替换官方 broker | 自有电脑 provisioning、持久盘、共享 profile 与多屏集成 |
| 浏览器工具与实际动作 | Grok GR16：sand-browser-tools.ts、sand-browser-driver-source.ts、sand-browser-auto-review.ts | 以 Grok 的工具定义、页面快照/ref、点击、输入、滚动、拖动、截图和标签操作为主体直接移植；替换驱动投递、box-chrome、DISPLAY、Linux 路径与连接配置，接入 Cmb 单一审批链 | Browser Broker 提供按 Bot 校验的目标注册、接管和持久 Session；改造原驱动按 URL 恢复、全 context 枚举及锁失败继续执行等不适合共享多 Bot 环境的分支 |
| 插件/MCP | Cmb 已有插件、MCP、Mods；Grok GR13 | 复用 Cmb 执行与权限；迁移可用的目录/账号/技能同步代码 | 自有 OAuth、凭据服务、真实 provider 接入 |
| 桌面 UI | Cmb CM11 + Grok GR15 可读 React 组件 | 能工作且适合接入的组件及交互逻辑直接迁移；替换 props、事件、状态和样式资源，按交互规格 §1.1 接入 Bot 切换、持续任务、协作、接管和审批 | 空回调、未恢复交互、当前版本差异；Team Bots 按延期范围保留 |
| Windows 本机执行 | Cmb CM06、CM12 与 Grok GR11/GR16 相应桥接代码 | 复用本地工具/权限/执行收据，接独立 Host；远端访问员工设备延期 | 本机进程身份、离线、撤回和恢复处理 |

原则上保留上游已有的有效测试，用它们验证移植前后行为，再增加跨模块接入的必要用例。不要为了迎合新目录结构重写已经可用的核心逻辑。

Host 的实际抽离位置与 Node 版本约束已补入 [当前实施基线 §2.1](12-windows-local-first.md#21-已核实的-host-抽离工作)，不能仅复制 agent-run-service 转发入口。静态依赖构建及初始化诊断见 [证据记录](host-boundary-review.json)。

## 3. 还不能宣称可直接移植的部分

**Windows/Linux 分工：** Grok 的 x11grab、/proc、Linux 文件锁与信号不能直接在本机首版使用，保留为后续 Linux Provider 候选。Cmb 浏览器当前是全局 activeSession、固定 Session 与主窗口依赖；要抽为独立 Browser Broker，并集中路由 Session 权限，不能只增加多 Bot 实例。公共内核、模型和任务状态共用，电脑、Shell、录屏及进程管理按 OS 适配；参见 [源码与平台边界](12-windows-local-first.md)。

浏览器动作实现优先移植 Grok 现有代码，Cmb 提供可复用的浏览器承载、会话和界面接入。Grok 驱动已使用 Playwright/CDP 执行页面操作，不能因外围依赖 Linux 就将整个驱动改为重写；也不能将原版按 display 划分的目标范围直接当作同一共享 Session 下的 Bot 归属。可复用代码、平台适配和目标管理修改分别登记，Windows 接入仍需实测。

**持续复核补充：** Rakazo 的电脑脚本及现有测试明确使用独立 Bot/profile，不能原样满足同用户共享登录。Grok 本地代码可见镜像 start-window 调用，但没有据此证明完整镜像显示/浏览器实现已获得。电脑模块仍按子模块择取，禁止把 profile 隔离当共享登录的完成替代。具体路径及 checkpoint/克隆语义修订见 [最终复核第 15 节](11-core-final-review.md)。

| 范围 | 当前依据 | 接下来怎样处理 |
| --- | --- | --- |
| Team Bots 的当前完整行为 | 官方帮助比 0.18 覆盖更广 | 复用 Registry、消息、资源、审批基础，补齐成员私聊和资源/电脑归属；发现现成对应实现时继续优先采用 |
| 实时语音 | 已读可读前端主要证明听写 | 保留听写和音频组件，检查其他项目及成熟实时媒体组件，再补 Bot 工具调用与状态衔接 |
| 手机端 | Cmb 尚未确认有完整对应客户端；Rakazo 有移动端目录 | 单独审核其屏幕、状态、媒体、授权依赖后决定整块或组件移植；不预先决定整端重写，也不把目录存在当作功能完整 |
| 企业部署与 VM 控制面 | 原版 broker 调用可见，完整托管平台缺失 | 先采用现有虚拟化/存储/身份设施及可用 provider adapter，补控制面的业务逻辑 |
| 当前完整 UI | 重建可读前端覆盖有限，部分回调不执行效果 | 按组件检查实际行为；可用的直接改造，缺失的补写，维持原版路径和状态 |

## 4. 每次移植的工作方式

1. **定位真实实现。** 从入口追到处理函数、状态存储、外部效果和 UI 回调，记录完整与缺失部分。
2. **列出依赖。** 包括被导入的类型/工具、数据库表、文件布局、后台服务和模型接口；不只复制一个表面函数。
3. **确定主体。** 同一职责选一份实现为主体，避免双队列、双审批、双记忆权威状态；其他实现按子能力合入。
4. **先跑通最小接入。** 保留核心代码，通过适配器接 Cmb；用已有测试和真实接入场景验证。
5. **只修改必要部分。** 身份、存储、传输、模型、工具、路径与 UI 框架差异逐项替换；保留仍然适用的业务逻辑。
6. **补齐差异并验收。** 对照功能矩阵，确认复用的代码既能运行，也能达到目标版本的行为。
7. **登记来源。** 保存原路径、版本/hash、许可证/授权状态、修改说明和测试证据。已有来源限制如实记录，不把它泛化为所有代码都需要重写。

每个工作包交付记录四项：**采用了哪些现成代码、适配了哪些依赖、补写了哪些缺口、通过了哪些验收。** 只有已验证的模块才计入实际复用结果，不事先给出没有依据的复用百分比。

## 5. 对原方案的具体调整

- P0 增加 B06 代码移植验证，先确定可用实现和依赖，不停留在功能调研。
- P1 的运行服务和后台可靠性，从 Cmb 与 Rakazo 的实际代码开始接入。
- P2/P3 的调度、群聊、记忆、录制、例程、审批，优先按上表迁移已有实现。
- P4 的手机/语音继续检查候选代码；仅对确认的缺口安排新开发。
- 架构中的新增目录可以放移植模块与适配代码，目录新增不等于算法和实现重新编写。
- 260 项功能与验收范围保持完整；实施路径改为明确的代码复用与移植优先。

以上为制定方案时的取用方向；目前已进入源码移植和产品接入，实际完成范围见下方记录及第 15 文档。

## 6. Windows 专项组件补充

按 [第 14 文档](14-windows-computer-feasibility.md) 的固定 commit 核查了 Microsoft UFO 与 WinApp CLI。它们仅作为 UIA、捕获、目标校验和桌面仲裁的移植候选；尚未验证集成。UFO PiP 未能确认完整实现，WinApp 仲裁不提供独立多屏；禁止以新增参考替代原 G2B 验收。


## 7. 已发生的复用（2026-09-30 续写）

| 来源 | 实际处理 | 当前接入点 |
| --- | --- | --- |
| Cmb `agent/local-sandbox.ts` | 原执行器抽为共用 `local-sandbox-core.ts`，桌面包装注入原 Mods/Hook/通知/Windows 设置服务；Bot 注入无界面配置，不复制第二套 Shell 执行逻辑 | 每次命令独立 worker、具体动作审批、持久收据、超时/取消/进程树清理、输出留存；仅 Mac 实测 |
| Cmb `ipc/sandbox.ts`、`agent/failover.ts` | 提取实际 Windows 状态/路径校验和纯错误分类，桌面旧路径继续导出；阻断后台执行器对 Electron 的间接加载 | `windows-sandbox-state.ts`、`api-errors.ts`；构建依赖图验证无 Electron/桌面存储依赖 |
| Cmb `mcp/capability-service.ts` | 将原实现拆为共用 `capability-core.ts`、桌面配置适配 `desktop-sources.ts`，原入口保留 Mods 授权/结果发布与原重试策略；Bot 使用同一内核，外部效果不自动重试 | `bots/mcp-tools.ts`；每 Bot 连接器选择、发现/检查/调用、动作审批、配置变化拒绝、执行收据 |
| Cmb `ipc/mcp.ts` | 原 `buildMcpServerConfig` 移至 `mcp/server-config.ts`，旧路径继续导出 | 桌面和 Bot 配置同步共用，不再通过 IPC 模块加载后台连接代码 |
| Cmb `tool-search/search-strategy.ts`、`mcp/result-utils.ts` | 直接导入已有搜索排序和结果提取/投影 | Bot 连接器工具及较大结果文件交付 |
| Cmb `stable-file-handle.ts`、`agent/replace.ts` | 直接导入稳定文件句柄与既有编辑匹配 | Bot 项目文件读写、精确差异审批、修改前备份和并发版本校验 |
| Rakazo `teach-recording.ts`、`teach-playbook.ts` | 提取真实坐标映射及技能试跑提示函数，保留来源与原几何测试 | 浏览器人工操作、指定技能版本的试跑 |
| Grok Teach 服务 | 参考其生命周期，没有冒充源码移植 | Chromium 编码、SQLite 录制状态/学习事务为平台适配新增；原 Linux 录屏命令不在 Windows 执行 |

MCP 共用模块已通过真实 SDK 子进程联调：授权前不调用、授权后实际执行、配置变更阻止未开始的调用、调用后断线不自动重复。Shell 已通过实际命令、审批、取消/超时及 Host 强杀恢复验证。模型决策来自受控本地服务；这不是外部真实模型或 Windows 平台验收。完整 `createAgentRuntime`、Mods 和工作流接入仍未完成，不能因若干共用模块已接入而归为整体完成。


### 共用图执行器接入

已将 Cmb `runtime.ts` 的实际 `assembleDeepAgent` 和相关工具并发、角色约束、错误处理等约 2,000 行实现移动到 `deep-agent-core.ts`。桌面原入口调用同一内核，并注入原 Mods、任务记忆和预览服务；Bot 通过自己的持久审批工具及检查点接入。没有另写一套替代 Cmb 的任务收尾逻辑。

新增适配包括收尾判定/重试预算写入图检查点、持久 Bot 租约的外层约束，以及致命错误后停止同一工具批次。修复原待办收尾中间件没有声明 `todos` 状态而无法在真实图中读取待办的问题。项目上下文直接复用 `agents-md.ts` 的发现、稳定读取、覆盖文件与预算规则，限定在 Bot 配置的项目根目录。

这一步完成的是共用图执行链；标准任务准备、完整 Mods/工作流仍是后续工作，不标记整体完成。


### 群聊复用

`upstream/grok-group-chat.ts` 直接保留原版回应者选择、@ 解析、轮次顺序、pass 和群聊提示构造。`group-store.ts` 将原 `GroupChatOrchestrator` 的有界轮流发言改接 SQLite，补入 epoch、收据与恢复；没有保留不适合后台重启的纯内存游标。当前实测包括原规则、持久恢复、改口失效、真实模型适配器和页面接线。
