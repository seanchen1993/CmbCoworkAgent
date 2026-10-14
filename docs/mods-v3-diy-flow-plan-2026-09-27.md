# DIY Claw 业务流程：迭代方案与验收合同

日期：2026-09-27；工作树 `C:\ai\CmbCoworkAgent-mods-v2`，开发分支 `codex/mods-v2`。
状态：两位独立 agent 已批准修订方案，进入实现；方案批准不等于实现或测试通过。

## 1. 用户目标

用户不写主工程代码，即可选择业务步骤、调整顺序、选择每步 Agent/模型、配置条件分支、失败回到修复步骤、设置人工确认，并看到实际执行与证据。Autobiz 是第一份业务模板，底层为通用 Mods 流程能力。

具体闭环：需求分析（可选）→方案（可选）→编码→独立评审→真实测试→人工确认（可选）→Autobiz 验收/当前阶段推进。关闭步骤必须零执行；排序必须改变执行顺序；失败回退必须真实调用指定修复步骤，随后复检。回退不表示撤销已经修改的文件。

不把现有完成门禁改名为完整 DIY；不宣称复制了 Claude 官方可视化业务编排器。列表式编辑、上移/下移即可满足排序，复杂拖拽画布、任意 JS 条件、并行图编辑不作为本轮阻断项。

## 2. 最新 Claude 证据

2026-09-27 npm registry 和官方 releases/latest 均为 2.1.283。本机全局 CLI 仍是 2.1.272，本次在忽略目录单独获取最新 Windows x64 包，没有覆盖全局 CLI。

- 官方版本：https://github.com/anthropics/claude-code/releases/tag/v2.1.283
- 本地提取根：`output/claude-code-2.1.283-analysis/`
- 二进制：244960928 字节；SHA256 `9dbe16dafed59da5cdabbfe11ad0335738c753fad794989b47f9446accd6de3a`。
- PE/Bun 容器提取 2368 模块、44276588 字节内容；没有 sourcemap，2134 项附带 bytecode。不是恢复原始 TypeScript，也不是还原 Bun 原生机器码。
- `extract_bun.py` 校验 PE、Bun section、offset/length、路径范围并保存逐文件指纹 `manifest.json`。
- `readable/claude-code.d.ts-8ef3f324.txt`：内嵌声明 530697 字节；比之前公开声明更晚，提到插件目录自动类型生成。不能仅凭旧公开 main 声明判断最新二进制。
- `formatted/chunk-0w5kpsps.js`：hook dispatcher、tier、next/trace、engine.create；`next.to` 限制在受管理插件层级，不能把流程跳转实现成绕过权限层。
- `formatted/chunk-gbtzpa3e.js`：静态分析 register、engine.create、next.to 的使用边界。
- `formatted/chunk-7dvkmj58.js`：workflow journal、agentType、恢复与 Agent 执行。脚本恢复不能证明外部副作用恰好一次。
- `formatted/src/plugins/functionHooks/hooks-worker/hooks-worker.js`：worker 调用协议。
- `readable/reference-2ccb611f.md`：模块注册、插件配置、重载、组合与声明契约。

借鉴行为与约束，不复制提取源码进产品。流程 IR、编辑器、业务账本是本工程产品设计，不写成 Claude 原有界面。

## 3. 产品交互

当前普通本地项目会话在「自定义」中提供与 Mods 安装/完成规则分开的「DIY 流程」页签；任务区域提供返回当前运行的入口。首版拒绝 Harness/远端/子线程上下文，以免放宽其文件根和权限。未保存草稿必须先保存才能启动，运行中的冻结版本不随草稿变化。安装/授权留在 Function Mods 管理中。

1. 从 Autobiz 模板创建/复制流程，输入 Feature 和任务目标。
2. 步骤卡编辑名称、启用、类型、Agent、模型、目标；上下移动、添加、删除。
3. 条件使用有限类型：始终；某个已执行步骤通过/业务不通过。成功后默认下一步，也可指向后面的步骤；业务不通过时停止、转向后面的替代步骤或回到前面的修复步骤，最多 N 次。禁用目标、悬空引用、前向条件依赖、不可达必需检查应明确拒绝保存。执行异常、未知副作用、取消和拒绝不能伪装成业务不通过走替代路线。
4. 人工确认是一种真实等待步骤，展示先前结果、版本与执行编号；同意/拒绝为业务决定，与 shell/file 权限审批分开。
5. 保存生成递增 revision 和内容 digest。运行冻结定义与角色配置，显示执行预览；运行中编辑只影响下次运行。
6. 运行页显示逐步结果、跳过原因、失败路线、修复次数、等待确认、输出与测试/验收证据；取消在同一位置。
7. 历史只读保留；重启后活动运行标记 interrupted，不自动重放。提供明确的重新运行入口（新 run，重新验证全部检查），不伪称从未知副作用处无损恢复。

## 4. 架构与契约

### 4.1 版本化定义

新增共享纯 TypeScript `src/shared/mods/flows/`：schemaVersion=1、id/name、plugin、revision、步骤稳定 id、顺序数组、enabled、有限条件、success/failure 路由、重试次数、总时间/执行次数上限。

步骤类型：`agent`（目标、角色、模型）；`check`（code-review/unit-test/e2e/autobiz-validator）；`approval`（确认说明）；`autobiz-stage`（固定 compiler 推导的单阶段终点，禁止任意写状态）。agent 的结构化业务判断和实际测试结果分别展示。

最多 64 步、最大 256 次节点执行、失败回退最多 10 次；输入/结果/历史有字节上限。条件不执行 JS，不使用 eval，不接受动态 shell 字符串作为流程检查。单元测试/E2E 由原有计划器选择项目脚本。

### 4.2 原生 FlowManager 与账本

新增 `src/main/mods/flows/` 宿主状态机，UI 通过可信 IPC 直接启动冻结后的定义；不让主模型重新生成脚本决定实际顺序。

FlowManager 使用原有 `claim/capture/releaseLocalThreadRunLease`，owner=mods，runId 为唯一 physical flow；同 thread 不能与普通聊天/IM/scheduler 并行写。相同 workspace 的 DIY flow 首版互斥，其他原生写入仍以最终证据指纹/CAS 检出，不能声称整个工作区事务隔离。

定义和独立运行账本由宿主持久化（复用 mods-control 的 settings/SQLite 存储能力，命名空间隔离、容量边界）；每个步骤 effect 前先存 running，effect 后保存 receipt/result。禁止把 workflow agent journal 或模型自述当成业务 PASS。

状态：queued/running/waiting/complete/failed/cancelled/interrupted。步骤：pending/running/passed/failed/skipped/waiting/unknown。未知写入结果阻断后续，不走失败回退。持久化失败须停止，不能补发可能已经完成的副作用。

审批回复绑定 thread/workspace/runInstance/stepId/attempt/definitionDigest/decisionNonce/approvalInputDigest，后者包含当前有效前序结果版本、展示摘要、项目产物/需求/Feature state 指纹。决策前重新捕获输入；变化则标 stale、生成新 nonce 与待确认摘要，不能消费旧同意。先持久化 CAS 消费再继续。后续修复使已批准的成果变化时，确认失效，终端提交前重新展示并确认。迟到、重复、旧窗口、改项目后的回复拒绝。新进程不会用旧 pending 按钮恢复旧执行权限。

业务状态转换合同：

| 本次结果 | 后续处理 | 可供条件读取 |
| --- | --- | --- |
| Agent 返回结构化业务通过 / 原生检查通过 | success 路由 | 当前 executionId 的 passed |
| Agent 返回业务不通过 / 原生测试真实非零或 validator 明确不通过 | 配置的 failure 路由，递增有界计数 | 当前 executionId 的 failed |
| 用户明确拒绝工具/输入、模型/有类型宿主异常、存储异常、cancel、unknown | 终止，不走业务分支 | 否 |
| enabled=false 或条件明确不满足 | skipped 并解释原因 | 既不是 passed 也不是 failed |
| 条件来源未执行、已跳过或被失效 | 条件未满足并记录 unavailable | 不可当作 failed |

每次节点执行有独立 executionId/attempt/resultEpoch。向后回到修复节点时，清除该目标及其后各节点的 current-result 和批准凭据，保留历史；此前检查/确认如果对应产物已变也失效。条件只读取仍有效的 current-result。终态不仅看指针：实际选中路径的检查必须有当前产物有效 PASS；历史失败可被后续同一检查成功覆盖，未解决检查失败不能显示全部通过。替代分支处理过的 Agent 业务失败在报告保留，不伪装为该 Agent 成功。

### 4.3 原有执行能力的复用

- Agent adapter 复用 `runWorkflowSubagent` 与 `createAgentRuntime` 的现有子 Agent 创建/清理策略。共享 helper 或等价显式参数不得漏掉 approvalThreadId、工具限制、工作区根、取消、队列及 ACL 清理。新路径不默认 autoApproveFileEdits，不静默升级权限。Flow 使用可选 singleAttempt 禁用 runner 内部整次自动重试，修复由 Flow 计数；结构化输出纠正仍受节点时间及明确次数限制，并在记录中说明。
- 每个节点/重试使用新 physical agent identity；角色在启动时解析并冻结。未知 Agent/模型失败，不静默替换默认全权限角色。显式模型默认禁止自动 fallback；必须修改现有 runner 的可选严格策略，保持旧 workflow 默认行为。
- Flow 自身使用新宿主 factory：从可信 thread metadata 解析真实普通本地 workspace，拒绝 Harness/远端/子线程；调用 `manager.createRuntimeAuthority` 创建唯一实例，将同一对象传给 `LocalSandbox.modRuntimeAuthority`，再放入 `withFunctionExecution`，leased=true 绑定捕获的原生租约。不拿旧会话 binding 或字段对象充当 authority。继续使用原 queryTool/权限链。退出时释放同一 authority/binding、取消并等待后台工具、清理 ACL。长流程不复用固定 120 秒 ModCommandQueue。
- 检查继续走 `ModsManager.runCompletionProjectCheck` 原生权限/执行 receipt。Autobiz 校验/提交继续走 FunctionModsManager 的证据与 CAS 链。
- 给 completionGate 增加仅宿主调用的临时 step policy context：严格 parser 校验，只对指定插件执行该节点声明检查，不写入/覆盖项目保存策略；flow digest/step/attempt 纳入证据上下文。插件未加载/未授权/缺少所选能力必须失败，undefined gate 不是 PASS。无需暴露新的 guest SDK 权限。
- 唯一提交顺序：业务步骤与修复 → 原应用已启用的强制完成规则（check-only，禁用隐式 automaticStage）→ 必要人工成果确认 → 重新验证所有必需检查/批准成果指纹 → 唯一 Autobiz 提交 → 仅记录/展示。autobiz-stage 最多一个且必须为最后启用节点；应用规则若自带阶段推进，与 Flow 阶段合并成一个终端 owner，目标不一致则启动失败。没有显式阶段节点但应用规则要求推进时，显示宿主追加的终端动作。所有检查/重新确认须在写状态前完成；之后不再运行会改变业务验收结论的 gate。
- 最终规则不会被删除 DIY 节点绕过，不在每个子 Agent 内重复触发。修复使产物变化就使旧检查/人工确认失效，重新验证后才可提交。流程总执行次数与单步回退上限共同约束，未配置回退时明确失败。流程图不能绕过最后的宿主验收。
- 禁用 Mods、插件撤权/替换、线程删除、workspace 改变都撤销 Flow authority；前后 await 与消费结果时重验。取消、拒绝、权限失效、未知结果是终止错误，不沿业务 failure 路线继续。

### 4.4 Autobiz 模板

模板步骤可选需求分析/方案、编码、评审、单元测试、可选 E2E、可选人工验收、Autobiz 阶段验收与推进。编码目标包含真实业务产物要求。Feature 与当前 stage 从项目真实状态读取，无法识别时提示选择/修复，不填虚假状态。

保留 Autobiz 固定上游 compiler/validator 的合法约束；用户可调整本地业务执行步骤，不能通过拖动绕过该 Feature 的合法 checkpoint 转移。单个 stage 的自动推进是原子边界；不宣称从任何阶段自动贯通 Autobiz 全部生命周期。

## 5. 实施批次（连续完成）

1. 证据、方案、双评审；修订阻断项后记录明确通过。
2. 共享定义/校验/模板、持久化与纯状态机；边界/取消/人工确认/失败路由测试先落地。
3. 原生执行 adapter、IPC、preload，接入真实 Agent/原生检查/Autobiz 提交；保留旧 workflow 和完成规则。
4. DIY 编辑与运行界面、历史和过程证据；用户可以不写代码完成完整配置和启动。
5. 两位 agent 代码复核；窄测、typecheck/build、存量回归、真实 Electron E2E、性能复检；修复新增问题并交付使用文档与 Autobiz 包/项目。

## 6. 必须通过的验收

- 启用/关闭评审的实际调用次数不同；互换两个独立步骤，真实调用顺序随之改变，重启配置仍在。
- 条件两分支均覆盖，未选路径零调用；失败→指定修复 Agent→原检查重跑；持续失败到上限停止。
- 角色/模型选择到真实 adapter，受限角色工具被限制；未知角色/模型不降级。
- 人工确认前后续零执行；拒绝、双击、旧 nonce、取消后回包不会继续。
- 取消/撤权/重载/删除/项目切换、持久化失败、重启中断、未知副作用均有回归测试。
- 真实测试以退出码/宿主 receipt 为准；Autobiz 推进要真实 validator 和文件指纹；失败不得出现完整通过。
- 未开启 DIY 时零新增流程探测/轮询/外部进程；编辑器按需加载，运行期间只订阅当前 thread/run，历史有界。
- E2E 至少覆盖真实 Electron → IPC → manager →受控模型 Agent →真实文件/测试→条件回退→人工确认→Autobiz 推进；UI fixture 不替代生产链。另做配置/交互浏览器测试。
- 现有 npm test 失败基线单独列出，不将本次全套通过伪装为全库零失败。保留已知 TTFT 与长稳未达标事实，新增编排性能单独测。

## 7. 评审记录

首轮两位均要求修订：提交先后顺序、真实 authority 工厂、人工成果指纹、回退结果代次。第二轮 `mods_compat_review` 与 `mods_perf_ux_review` 均明确批准，无剩余方案阻断。产品实现从第二轮通过后开始。

补充强制验收：最终应用规则失败时 checkpoint 不变；确认等待期间改文件或同意后修复须重新确认；回退后旧 PASS/跳过来源不能驱动条件。性能使用最大 64 步/256 次执行样例，编辑响应 p95 目标 100ms，关闭页面后监听数回到基线；不增加普通聊天的流程读取/外部探测。

## 8. 实施后的明确约定与最终评审

- 保存流程是普通业务任务配置，不要求管理口令；不能通过保存授予插件权限或改写应用强制规则。
- 末尾人工验收延迟到最终原生检查之后，一般只确认一次。中间人工步骤仍原位暂停；其后的成果/结果改变时最终需要重新确认。
- 最终检查结果进入业务记录并绑定产物指纹，旧指纹结果失效。等待确认期间产物变化时，最多重新执行三轮最终检查、记录与确认，持续变化终止；不是拿旧验收套新指纹。
- 真正的子 Agent 注册独立内部线程和物理租约，保留原生权限校验；普通任务目录与分组批量操作仅隐藏明确的宿主内部线程标记。清理前后核对身份，逐项清理并聚合报错，不误删替代实例。
- 现有部分只读/文件边界 guard 返回普通工具错误，模型可能把它判为业务失败后进入用户配置的回退。工具本身仍被阻止，角色/权限不会提升。本轮严格的“拒绝终止”承诺覆盖实际用户拒绝、取消及有类型的宿主异常；不扩围重写全部旧沙箱错误协议。
- 两位 agent 的最终代码评审均通过。检视提出的拒绝即停、外部改动失效、最终证据入账、单次尾确认、内部线程身份、清理故障隔离全部修复，并有回归。

最终验证数字与仍保留的历史测试/性能边界，以[交付报告](mods-v3-delivery-report-2026-09-27.md)为准。
