# Mods V6：关键能力交付与验证

开发位置：`C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
没有在 UAT 工作目录开发，没有提交或推送当前工作区已有的累计改动。
兼容参考固定为本机提取的 Claude Code 2.1.283；不把接口数量或测试数量当作完全兼容证明。

## 现在可以做什么

DIY 的效果是改变真实执行步骤、顺序、角色和门槛，而不只是改变给模型的提示词。
已有 Autobiz Flow 编辑器负责选择、排序、启停业务步骤及人工关卡；本轮让插件作者能在
这些业务流程之下使用真实资源和独立任务，减少每个插件重新编写宿主代码的需求。

| 能力链 | 本轮实际行为 | 关键边界 |
| --- | --- | --- |
| 命令执行 | Hook 改写最终 argv → 原生批准 → 真实进程 → stdout/stderr → 退出码 → 审计 | 默认无 shell；命令按系统用户权限执行，cwd 不是文件沙箱 |
| 后台资源 | 创建 Hook 返回后仍能收输出；主动停止、卸载、撤权会清理进程及定时器 | 不继承旧任务的写入、工具或模型授权；后台展示仅 log/status/toast |
| 定时器 | 可取消的 after/every，每次回调有独立执行帧 | 每次间隔最多 60 秒，资源及回调有配额；不是无限任务调度器 |
| HTTP | 修改请求 → 每跳审批 → 真实 HTTP/HTTPS → 受保护结果 | 有超时、大小限制；不支持凭据句柄、Unix socket、压缩响应 |
| 协作消息 | 插件/子 Agent 发送，接收 Hook 改写或拦截，真实模型读取及可见投递状态 | 仅运行中的目标；不写成人类消息，不构成授权，不自动唤醒闲置会话 |
| 独立子 Agent | 原生批准 → 单独线程/租约/运行时 → 父任务结束后继续 → 完成事件回原插件 | 独立 VM，不共享父插件闭包；继承父权限限制 |
| 自定义角色 | 会话内注册命名角色，显式 spawn 选择其冻结快照 | 工具白名单和轮次上限必须在实际运行时生效；不是任意 Claude agent frontmatter 的直接移植 |
| 只读资料 | 项目根、应用版本、Markdown ancestors/include、有效配置、基础环境变量 | 项目文件边界、内容保护、声明和 allowlist；配置使用本工程命名空间 |
| 标准 JS 环境 | AbortController、组合取消、结构化克隆、随机数/摘要、单调时钟 | 有范围和配额；不是完整浏览器/WebCrypto 环境 |
| 插件开发 | manifest.types 纳入快照；生成声明、真实 TypeScript 检查、示例 | 闭合的本地类型子集；不自动加载任意依赖/tsconfig/Node ambient |

## 直接体验

使用开发分支的应用，在 Autobiz 项目会话中，从本地目录导入并启用
`examples/mods-workspace-audit`，批准当前插件源码。

1. 输入 `/claw-audit status`，只看工作区状态。
2. 输入 `/claw-audit summary,status`，日志顺序应为统计、状态。
3. 输入 `/claw-audit whitespace,summary`，如果补丁存在行尾空白，第二步不会执行。
4. 每个真实命令都有最终参数批准；拒绝时不会启动。运行中可输入 `/claw-audit-stop`。

需要直接体验不同检视角色时，再导入 `examples/mods-review-agent`，配置好实际可用模型：

- `/claw-review concise working`：只检视未暂存的已跟踪差异，关注明显逻辑问题。
- `/claw-review strict working`：选择更全面的正确性、权限和失败路径检视角色。
- `/claw-review strict staged`：只检视暂存区差异。
- `/claw-review-status`：查看独立子任务状态与结果；拒绝、失败、中止与完成分别显示。

这个示例让模型分析真实读到的 diff，但不给模型工具；它不会修改文件或冒充已经运行测试。
冷会话的 `tools: []` 角色可使用线程或默认模型；需要用户显式执行普通命令并持有真实线程租约。
immediate 查询或后台回调不能凭空创建这个启动权限。非空工具清单需真实运行时工具目录。

这组命令已用真实临时 Git 仓库验证，包含非零退出后阻止下一步。
空白检查不是模型代码检视。需要模型检视和人工确认的业务演示，继续使用 Autobiz Flow
对应步骤；详见示例 README 和现有 Flow 使用文档。

插件作者可在 `checks` 增加组件，在 Hook 修改参数/输出/拒绝条件，或调用注册角色、
独立 Agent 和协作消息。用户选择的是实际执行组合；审批、资源清理和审计由宿主提供。

## 对存量功能和性能的处理

- 无工作区时不请求聊天 Mods；关闭时不挂载插件界面、卡片、日志、命令等业务订阅，仅保留必要的开关通知。有工作区且确认开启后才恢复原有界面。
- 同一工作区离开再进入、快速切换线程、关闭期间迟到的开关/命令结果均丢弃；原生界面正常显示，已启用插件的真实绘制错误仍可见。历史只读能力沿用原规则。
- 聊天区共用开关读取与稳定的 Context 值，避免每次模型流式更新通知全部插件界面。
- 消息交付保留插件/Agent 来源，通过单独的受约束上下文供模型读取，不增加用户轮次。
- 实际 Windows 进程树由 Job controller 管理；构建接入协议校验，旧命令模式保留并回归。
- 输出流有背压；资源、回调、队列、游标、注册表均有限额，正常结束也等待审计收尾。
- 普通未声明类型的插件不加载 TypeScript；作者类型工具以延迟构建块和固定 ES 声明资源交付。

## 检视和验证

方案及最终实现分别经 feasibility、quality 两位 agent 复核。评审发现并修复了审批中取消、
迟到批准、进程结束与审计竞态、启动 ACK 与取消墓碑竞态、子任务启动后 Hook 失败泄漏、
撤权后丢失清理句柄，以及协作查询 IPC 参数不一致等问题。
最终 E2E 还发现角色工具白名单误拦截内部上下文控制操作，以及冷会话命令缺少宿主身份。
前者仅对内部控制入口跳过工具白名单，嵌套工具仍完整检查；后者创建短暂、无工具后端的
真实命令身份，并在子任务启动后释放。原物理租约、替换运行时、跨线程隔离均有回归测试。

已经完成的真实验证：

这里的 Electron E2E 运行真实应用、IPC、隔离进程和原生 Agent 运行时，模型端使用本地
受控 HTTP 服务，以稳定验证工具调用、取消和消息顺序；不代表已测试每一家生产模型服务。

- 兼容回归：12 个文件、229 项通过。
- 最终 Mods 专项回归：1682 项全部通过（`output/mods-v6-final-mods.json`）。
- Electron 资源 E2E：网络最终参数批准、后台输出/退出、拒绝零网络、定时器与撤权杀进程。
- Electron 子 Agent 最终 E2E：4 组通过，父先结束、子仍运行、角色工具白名单和 maxTurns 在真实模型调用中生效、peer 后续模型消费、原插件完成回调及审计。
- 冷会话真实 E2E：注册无工具检视角色后直接执行命令即可启动、完成，父会话用户轮次保持 0。
- 真实 utilityProcess：55 项通过，覆盖标准全局、模块通道、流游标与独立 sleep 取消。
- Flow 浏览器：5 组通过；设置/检视/协作记录及聊天启用边界浏览器：13 组通过。
- Autobiz 真实 Electron Flow：7 组通过，包含角色步骤换序/单选、失败阻断、人工确认、阶段提交和重启不重放。
- 标准全局、兼容性 UI、共享命名状态三个最终 Electron E2E 通过；Mods 关闭后普通输入框仍可用。
- 聊天启用判断修复后的生产构建再验共享命名状态 E2E：6 组通过，包含重载、撤权、关闭 Mods 恢复普通输入框。
- 冷命令与绑定定向回归：15 项通过，包含旧租约不能复活、排队后运行时替换、失败释放及父子隔离。
- 启动授权最终复验：20 项通过，包含批准等待中父绑定失效时零启动，启动后释放父身份不终止子任务。
- 作者工具真实 CLI 及禁止外部 TypeScript 模块解析的 Electron 检查通过。

存量回归特别处理：生产 peer 只包装模型请求，其生命周期复用已有节点。
原 `recursionLimit=12` 权限测试 40/40 通过，消息队列原约定 52/52 通过，未提高原测试预算。

全量 Vitest 前一轮 **5151 项：5120 通过、26 失败、5 跳过**，与 V5 基线逐项相同。
最终收尾全量执行 **5167 项：5129 通过、33 失败、5 跳过**，其中新增 7 项均来自
关闭 Mods 时去掉原生界面外层布局结构。已恢复无副作用的静态 section，保留原有断言，
随后重跑整个 renderer/lib：**524 项，522 通过、2 项原有失败**，7 项新增回归全部通过。
同时复跑 13 条浏览器验收及真实开发启动。最后这个静态布局修复后没有再次跑整仓全量；
原始结果均保留，不声称“全仓全绿”。尚未解决的已报告失败仍为基线的 26 项。
逐项修复证据见 `output/mods-v6-final-regression-assessment.json`。

`npm test` 中后续九条子链的 **84 个命令均已拆开执行**，避免前一个失败遮住后续。
原始 79 通过、5 失败；其中工作区 `pwd -W` 用 Git Bash 保持原断言复验通过，消息队列
静态顺序回归已修复并以原 52 项断言通过。剩余是已知的 sandbox 通知静态断言、IM Windows
路径和 IM 本地会话回复格式失败。套件内部首个失败后的未执行用例不算通过。

定向 ESLint 检查 361 个文件，0 error；历史格式/类型风格 warning 仍有 2008 条，未作
无关全仓格式化。Node/Web TypeScript 及生产构建通过。

资源性能单次采样：5 个静默 Windows 进程启动共 136.83 ms；约 2.01 秒等待中宿主
CPU 采样 0 ms、RSS 增加 69632 字节，全部关闭共 12.88 ms。子进程/helper 内存不在该 RSS
数字中，不把单次采样宣称为整个应用零开销。

最后一次角色注册扩展 E2E 已通过；最终证据为
`output/mods-v6-validation/e2e-agent-spawn-final-ui/result.json`，包含最终聊天界面启用判断，
4 组真实 Agent 场景全部通过。旧 `e2e-agent-spawn` 目录保留前几轮故障诊断文件供追溯。
按仓库要求使用 Node 22，实际 `npm run dev` 已通过：开发页面和普通输入框正常加载，Mods 默认关闭，无工作区不触发
`MODS_WORKSPACE_REQUIRED`，不出现插件绘制错误。证据为 `output/mods-v6-dev-smoke.json`、
`output/mods-v6-dev-smoke.png` 和同名日志；测试使用独立临时数据目录。
最终已恢复普通 `npm run build` 产物，确认没有 `out/main/mods-e2e.js` 测试入口。
初次 `npm test` 默认并发导致资源竞争和多项超时，已终止该次运行并以受控并发重新执行；
不将那次结果作为产品回归结论。

## 不能宣称完全对齐的地方

1. `env.set` 未提供：它需要同时改变后续 Bash、MCP、进程环境。当前共享 MCP 连接池与沙箱
   环境快照必须改成会话版本隔离，简单修改全局环境会污染其他任务。每次进程执行可传明确审批的 env。
2. 原生终端 UI、Claude 专属配置层级、凭据保险库及插件依赖类型解析，不等于桌面应用对应能力。
3. 独立 Agent 不实现父子共享插件 VM、fork 全部上下文；注册角色不意味着原生 Agent 工具自动发现它。
4. HTTP、文件读取、时钟、结构化克隆等都有明确支持范围及预算。详情见下列边界文档。
5. `AbortSignal.timeout` 未提供：固定版本声明与提取运行时代码并不一致，本轮没有把声明当成已证实行为。

这些边界会影响依赖对应 API 的第三方 Claude 插件直接迁移，但不阻断本轮的主要 DIY
步骤组合、真实命令/网络、自定义角色、独立子任务和协作链路。兼容检查只检查注册事件范围，
不能据此保证插件所有分支、外部依赖或业务结果完全一致。

## 参考材料

- `docs/mods-v6-key-capability-plan-2026-09-28.md`
- `docs/mods-v6-host-transport-and-read-boundaries-2026-09-28.md`
- `docs/mods-v6-standard-runtime-boundaries-2026-09-28.md`
- `docs/mods-v6-authoring-tooling-2026-09-28.md`
- `docs/mods-v2-compatibility-matrix.json`（历史基线加 V6 更新，保留 partial/bounded）
- `output/claude-code-2.1.283-analysis/`（本地提取参考，不是本工程源码）
- `output/mods-v6-baseline-comparison.json`（全量失败逐项对照）
- `output/mods-v6-delivery-baseline-comparison.json`（最终全量原始 33 项失败对照）
- `output/mods-v6-final-regression-assessment.json`（新增 7 项修复后的逐项复验）
- `output/mods-v6-followup-tests/summary.json`（84 条独立命令记录）
- `output/mods-v6-validation/resource-performance.json`（原始性能样本）
- `examples/mods-workspace-audit/README.md`
- `examples/mods-review-agent/README.md`
- `examples/mods-typed-counter/README.md`
- `docs/mods-v3-diy-flow-hands-on-2026-09-27.md`（Autobiz 图形化编排完整步骤）
