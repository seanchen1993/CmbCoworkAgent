# 组合能力独立验收计划

本文与实现契约配套，先列预期再实现验收。测试运行使用隔离用户目录、临时项目和本地受控模型服务，不读取用户模型密钥。

## 基线与归属

- 修改开始前运行原样 `npm test`，完整输出保存在 `output/mods-composition-baseline-tests.log`。
- 基线失败逐项区分已有缺陷、测试环境/夹具问题以及并发资源超时；不能将原样全量失败描述为全部通过。
- 基线 Vitest 失败会阻断 `&&` 后的独立回归套件，需另行运行这些套件，而不能视作已覆盖。

2026-09-29 实测：原样 `npm test` 的 Vitest 阶段 661 文件，5,177 通过、54 失败、5 跳过，另有 1 项未处理迁移异常，耗时 279.81 秒；命令退出 1。将除既知 IDE、Chrome 扩展、主题策略以外的 16 个失败文件使用 `--maxWorkers=2` 单独复跑，294 项通过、2 跳过，无失败或未处理异常，耗时 167.21 秒，见 `output/mods-composition-baseline-recheck.log`。这些高并发失败未在低并发下复现，不能计作新增生产缺陷，也不能据此声称原样全量命令通过。

上轮交付记录已经列明 11 项稳定基线失败：5 项 macOS IDE 模拟、5 项缺失 `chrome-extension` 源文件、1 项主题策略。独立套件另行串行执行，结果保存在 `output/mods-composition-standalone-results.json` 及各套件日志。

独立补跑结果：adoption、messages、hooks、plugins、task-cards、merge、desktop-agent-baseline、im-v1 共 8 组通过。workflow 组的脚本引擎 32 项、工作流引擎 96 项、worktree 66 项通过；随后旧 `local-sandbox-worktree-isolation.spec.ts` 用 `pwd -W` 假定 Bash，在实际 PowerShell 下报参数歧义。将其后 25 个脚本逐一运行，24 个通过；消息队列源形测试因新增 Flow 防误发送 guard 需要更新断言，修正后 52 项通过，见 `output/mods-composition-queue-plumbing.log`。没有删除或放宽实际队列、停止抑制及共享锁约束。

独立 Electron 回归确认传统 Plugin/Harness 7 组通过，日志 `output/mods-composition-legacy-e2e.log`，机器记录 `output/legacy-plugin-project-e2e/result.json`。初轮组合端到端 9 组已通过：包括真实 A/B 动作与模型请求、冻结 Flow、跨对话应用、最终验收、取消、普通聊天默认模型、撤权零动作执行。后续追加实际 UI 截图与布局断言后需重跑，不能把旧截图当最终界面证明。

完整旧 Flow E2E 捕获真实回归：新单输入流程完成后，“带运行摘要追问”没有切回聊天模式，下一次发送可能误启动流程。已交由界面实现者修复，保留原普通追问不增加运行数的断言，并增加发送按钮恢复“发送消息”的断言；最终结果以修复后重新执行日志为准。

## 本轮最小真实链路

1. 上传两个独立 ZIP，分别声明自己的 `claw.actions` 并注册不同 command。安装、审批、发现和执行都使用生产 API、隔离 QuickJS guest 和真实 IPC。
2. 动作 A 接受任务和配置，输出包含本次 nonce 的结构化数据；动作 B 显式绑定 A 的 output，校验 nonce 与必需字段后输出自己的真实 owner。只检查预置文案不构成此项通过。
3. 两个 Agent 角色分别使用模型 A、B。本地 HTTP 服务捕获真实适配器请求，以 body.model、任务标记验证归属，不能仅检查运行记录中的 modelId。
4. 同目录两个普通对话分别绑定不同 Claw，断言命令集合、默认模型、流程配置均隔离。模板更新后旧绑定副本不变；显式重新应用才改变。
5. 运行中修改绑定被拒绝；另一对话应用配置不应撤销当前对话的合法执行。项目执行互斥仍然有效。
6. 已保存流程或插件版本变化时拒绝过期引用；撤权即时阻止后续动作；失败/取消后不得继续消费旧 output 或推进成功节点。

## UI 验收

- 普通聊天仅有一个主输入框，聊天/流程意图清晰，选择流程本身不启动执行。
- 右侧查看当前 Claw、模型角色、流程状态与结果。关闭右栏不取消任务，重新打开恢复；切线程不会显示别的对话数据。
- 审批或失败保留紧凑可见入口；模型/角色/插件不可用时展示具体原因，不静默切换或假装成功。
- 1366、1024 和 800 宽度检查主输入可达、滚动范围和遮挡，保存真实 Electron 截图；收起、重开右栏后等待审批的运行与审批 nonce 不变。

## 存量与兼容

- 运行 `tests/legacy-plugin-project-e2e.spec.ts`，验证传统 Plugin 项目创建、节点和产物以及 Harness 调用。
- 保留普通未绑定对话的旧行为、关闭 Mods 的快速路径、旧 Flow 数据和斜杠命令入口。
- 原 `tests/mods-flow-e2e.spec.ts` 验证真实业务检查失败、修复、重跑及审批；原 `mods-claw-e2e` 的 A/B 选择验证继续保留，不用新测试替代旧断言。
- 相关单元测试、类型检查、构建和 lint 检查与 E2E 分别报告。

## 证据边界

受控模型服务验证请求归属、数据传递和生产执行链，不证明线上模型分析或编码质量。性能结果只报告测量条件及对比；不把结构调整直接宣称为性能提升。

## 独立代码复核（本轮增量）

复核范围只针对本轮组合链路，未将工作树全部历史未提交改动混入结论。

- `mods-claw.ts`、`claw-store.ts`、`claw-scope.ts`：作用域在异步校验后再次确认；项目模板 revision 做 CAS；绑定保存完整副本，以 thread/incarnation 区分；调用后只关闭本会话资源。内部 Flow 子线程需经过同目录可信父链，传统 Harness、后台和远端模式不进入该选择逻辑。存储有大小、数量与结构上限，损坏时拒绝而非默默使用空配置。
- `flows/manager.ts`、`native-host.ts`：Claw 快照启动不回读被编辑模板；运行 lease 在异步准备前取得，同目录流程互斥保持；输入引用仅允许已通过且未失效的前置动作；插件/模型准备失败不得开始业务节点。模型按节点显式、角色、原 Agent、Claw 默认、宿主默认顺序选择；运行指纹不包含凭据，配置变化使运行失效。
- `v2/loader.ts`、`manager.ts`、`session.ts`、`dispatcher.ts`：动作声明所属 manifest 进入源摘要；命令实际 owner、plugin ID、目录、摘要和 grant 均核对；显式动作锁住 args，原 command 身份由 pinned-input 保护；owner 异常不走静默降级，owner 必须实际执行并成功返回。返回结构、输入 schema、输出 schema 和体积均限制。撤权后的异步准备拒绝已经用两个真实 guest 的持久调用计数验证。
- `ChatContainer.tsx`、`use-chat-flow.ts`、`ClawSidebar.tsx`、`ClawSidebarHost.tsx`：一个输入框显式区分聊天和流程，流程共享发送准备锁；队列自动发送保留 Stop 抑制，并在 Flow 活动或准备中停止。portal 的宿主在收起侧栏时仅隐藏，未关闭宿主运行；thread ID 隔离挂载目标，切线程不复用另一会话的详情。传统模式保留原显示分支。

静态复核未发现额外的 P0/P1 问题；动态验收仍是交付必要条件。摘要追问意图问题已修，最终旧 Flow E2E 9 组通过，见 `output/mods-composition-flow-e2e-final.log`。前端模型预检与 Claw 默认模型的冲突亦已修，新增“原线程保存模型已不存在，但绑定模型 B 有效”的真实对话验证。

追加等待审批状态下刷新真实 Electron 页面时，组合 E2E 连续发现 React #185（最大更新深度）导致整个聊天界面进入错误边界。组件栈落在 `ChatScrollNavigator` 子树，但真实根因由单独组件测试定位为 `ModelSwitcher`：失效的持久模型值反复水合，与有效模型回退互相振荡，不能把表面组件栈当成 Radix 缺陷。实现者已按 thread/mode/metadata 模型身份让水合幂等，组件测试修复前失败、修复后通过。最终构建 `index-C8OxrTE7.js` 的完整组合 E2E 11 组通过，失效旧模型、等待审批刷新以及真实 B 模型请求均保留，故此 P1 已关闭。

性能边界：新版本为了恢复对话绑定，在开启 Mods 的普通对话初次进入时会读取绑定及运行记录，因此不能继续沿用旧报告“普通导航零 Flow IPC”的表述。当前目录扫描只在显式打开侧栏加载完整目录，但 `clawView` 仍会读取插件状态；大量插件/对话下可进一步拆分轻量绑定读取接口。关闭 Mods 的路径与未接入传统模式保留原快速路径。此项为后续优化空间，不构成本次正确性阻塞。

## 最终独立验收结果

最终组合 E2E 命令退出 0，共 11 组通过，`pageErrors` 为空；日志 `output/mods-composition-e2e-final.log`，机器记录 `output/mods-composition-e2e/report.json`。两个独立真实 guest、两个真实 HTTP 模型请求、模型角色和默认模型、冻结流程副本、线程隔离、运行中禁止切换、人工验收、取消、撤权后零业务动作及侧栏关闭/重开均得到验证。撤权启动接口可先返回 queued，随后异步准备转 failed，具有具体原因且 A/B 持久计数不增长；queued 不等于准备通过。

截图均来自真实 Electron：`output/mods-composition-e2e/approval-sidebar-1366.png`、`approval-sidebar-1024.png`、`approval-sidebar-800.png`、`configuration-sidebar.png`、`claw-binding-editor.png`、`bound-default-model-chat.png`。1366 宽度聊天与右栏并列；1024/800 使用覆盖式抽屉，会覆盖输入框右部，需要收起右栏完整聊天。测试验证只有一个输入框、其布局在窗口范围内及收起不取消任务，不将 CSS 可见性冒充窄屏没有遮挡。配置页编辑已有组合需点击左侧已保存名称；默认编辑区是新草稿。

本机同工作区仅有两个小型已授权夹具插件，runtime 已预热、无正在运行任务：各读取 10 次真实 IPC，`clawView` p50 **56.11ms** / p95 **56.71ms**，`flowCatalog` p50 **54.80ms** / p95 **55.62ms**。前后读取两个 guest 持久执行计数并相等，证实这些读取不执行动作。此结果包含 Playwright 调用开销，样本很小、无改造前可比基线，不代表大工作区延迟或已优化提升。

本轮回归测试文件 ESLint 通过。完整 Vitest/Mods 与 typecheck/build 由主实施会话统一运行，需结合其最终报告；本报告保留原样基线失败，不声称 `npm test` 全绿。
