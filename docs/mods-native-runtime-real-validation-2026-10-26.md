# Mods 原生运行时与 AutoBiz 真实验收记录

**最新状态：R4 项目 abb70da0 的 Convert、PRD、Specs、Design、Plan 前五阶段均已通过真实模型、原 Python 检查及适用原生审批并 transitioned。Code 操作 `64c4e42b-8bb8-427e-9800-8872900db655` 在上下文准备时成为 unknown，尚未执行 Code 模型、Flow、进程或检查；原 unknown 保留。用户现允许模型及昂贵外部依赖使用 Mock 加快全流程验证，不再新建真实 R5。增强后的混合八阶段与独立供应商 2/2 已通过，模型作者及人工回调使用替身，不宣称全真实八阶段完成。**

本记录截至 2026 年 10 月 26 日本轮更新时。应用版本保持 **2.0.0**；R4 主作者包为 **0.1.6**、规则 **0.1.4**、知识 **0.1.0**，已通过 Creator 原生目录导入、依赖安装授权、advance 编译和安装。原 native 12 文件 221 项运行有 8 项失败，定位为测试 VM 漏注入 getThreadRuntimeScope；修正后对应整文件 87 项通过。新混合回归 1 文件 2 项通过；最终 Plan 引用契约 4 项通过。官方 Node/Web 类型检查已通过；全仓 lint 仍失败，改动代码的 error 级规则检查通过。最终正常构建与改动范围定向复验通过：实际 147 文件、2,042 项全通过，运行期间源码不变。16 组 npm 独立回归以分段复验覆盖完成，workflow 首次失败及修复后尾链通过均保留；不是单次 npm test 全绿。本轮不重跑整个 1,752 文件集合，CI 尚未触发。旧 r2 整库及后续隔离复验按各自时点保留，不拼接为全量全绿。

本报告不收录凭据、私人日志正文、模型完整输入、验证数据库或本机工作区绝对路径。证据文件名仅是验收负责人本机的留存索引，除特别说明外位于 `output/autobiz-live-recovery-20261024/`，不随源码提交。阶段状态以对应原 Host 记录为准，测试结果不回写业务历史。

## 当前 R4 项目的原生执行证据

作者集合 `native-closure-source-set-r4-0.1.6/` 通过 Creator 的真实目录选择入口导入，sourceSet 为 `5883b158...`；规则 0.1.4 已沿原安装与授权路径就绪，主包 0.1.6 经 advance 原编译及安装，安装标识为 `f2513c11-9d03-40ae-a82e-a33d9f845348`。本项目标识为 `abb70da0-af2c-4c3f-8d24-b84c96795c98`。此前复制的上游材料仅作待检查输入，没有复制旧状态、回执或批准；新安装和新项目不恢复旧 r3 unknown。

| 阶段 | 当前原生事实 | 验收边界 |
| --- | --- | --- |
| Convert、PRD、Specs | 真实连续执行后各有 2 项成功检查、1 次原检查进程，均 transitioned。 | 不借用旧项目回执。 |
| Design `b55d0e06...` | 2 项检查通过，原生进程审批及原项目界面人工成果接受完成，已 transitioned。 | 属于前五阶段真实完成记录。 |
| Plan `230441...` | 模型服务 HTTP 402 余额不足后正式 failed/provider_error、terminal=error，没有执行检查。 | 不是 unknown，也不是业务检查失败。 |
| Plan 后续尝试 | 补充余额及阶段说明后继续；验收项引用与 designRefs 非法标题锚点曾被原检查拒绝，模型修正后最终通过原生检查并 transitioned。 | 14 REQ、37 SCN、4 API、16 D 和原限额、pipeline 契约保留；失败不覆盖。 |
| Code `64c4e42b...` | 原线程 `47e334ef...` 为 workflow 模式；上下文动作选择被 ordinary guard 拒绝，终态为 unknown / project_context_provider_unverified。 | 0 Flow、0 进程、0 检查，Code 模型未执行；这些零记录不自动构成历史解锁证明。 |
| Code、CICD、Archive 后续全流程验证 | 改以明确标注模型/昂贵外依赖替身的混合回归加速，增强后的八阶段与独立供应商 2/2 通过，沿实际模式及选择路径执行。 | 不回写 R4 状态，不启动 R5，不将替身回归称为全真实业务验收。 |

最新第一手状态证据为 `readonly-verification-abb70da0-af2c-4c3f-8d24-b84c96795c98-2026-10-26T08-53-20.739Z.json`：前五阶段 transitioned、Code unknown；它包含之前三次 Plan failed 与最终 `740ddce1...` transitioned 的完整区分。较早的 `08-00-11.226Z`、`08-12-53.582Z` 同项目前缀快照仅保留历史时点，不能代表最终阶段状态。`r4-prd-hook-actual-execution-evidence.json` 留存 PRD 原 PreToolUse command Hook 的一次真实允许路径：exitCode=0，之后发生同线程产物编辑；本次没有验证秘密拒绝负例，不能据此宣称全部 Hook 路径已通过。

### 本次 Code 入口修复及记录边界

原日志在 `2026-10-26T08:53:20.324Z` 报 `PROJECT_ACTION_SCOPE_CHANGED`。真实线程的 agentMode 为 workflow；原 projectActionFlowMetadata 只移除 Host 字段，随后普通 Flow 谓词要求 normal，导致 provider selection 在 Flow 派发前拒绝。修复只在原 active、精确线程/绑定与当前权限检查之后，对复制视图的 workflow 模式投影为 normal；不改 DB、模型模式、共享 ordinary 谓词或 remote/parent 等排除条件。

另将 providerStarted 标记从准备阶段移至原 startSaved 调用紧前。未尝试派发的 selection、材料或定义准备失败，仍须原精确 owner 与物理退休守卫通过后才能记录 failed；尝试派发后异常、取消结算不明或退休失败继续 unknown。既有 inspector/cancel/reconcile 的历史规则不变，不能据此补判 R4 旧操作或解除其占用。

此前只读 Plan 审阅验证了引用目标存在，却漏验 designRefs 的编号锚点语法，“无剩余阻断”结论已更正。完整原纯 checker 对当时字节报告 5 个非法标题引用、两层合计 10 条错误；内存替换为已锁 API/D 编号仅用于确认修法，未写业务产物或成功回执。后续成功以模型实际修订及原生检查、推进记录为准。只读报告索引为仓库 `output/r4-plan-readonly-final-review.json` 与 `output/r4-plan-original-checker-diagnostic.json`。

用户授权的 Mock 仅用于测试中明示的模型及昂贵外部依赖。增强用例移除了 prepareSelection 的 no-op 和 clawApplicable 恒 true：真实 stage.executionMode 进入线程 metadata，沿原 ClawStore、catalog、精确 Host scope 和选择入口执行。此轮已通过 1 文件 2 项：AutoBiz 418,535 毫秒、独立供应商 10,565 毫秒，用例合计 429.102 秒、进程总耗时 455.22 秒。`final-hybrid-eight-stage.json/.log` 记录八阶段均 succeeded。原 ClawStore、Guest、Python、Flow/Host 状态、工作树、编译及 UT 实际执行；模型作者、人工批准回调和线程 metadata 映射仍为测试替身，不是 Electron 真实模型全链。未真实运行的外部服务、人工业务判断和在线模型质量继续保持未验证标记。

## 一、证据层级与验收范围

本轮验证项目声明的 Skill、业务检查、知识、配置和执行资源，能否通过原生来源绑定、权限审批、实际执行、物理结算、成果验收及阶段推进共同工作。

| 证据层级 | 能证明什么 | 不能代替什么 |
| --- | --- | --- |
| 实际应用、真实模型、原生审批与原 Host 回执 | 指定项目、指定源码版本的实际阶段结果及审批行为。 | 未运行的后续阶段、其他电脑环境或外部发布。 |
| 实际运行时、进程、数据库及 utility transport 集成回归 | 对应原执行链、来源、取消、持久化、进程及传输边界。 | 自动化中由夹具提供的模型创作、人工业务判断。 |
| 生产 React 组件与确定性 IPC 浏览器夹具 | 原界面交互、过期响应、确认与导航条件。 | Electron 主进程执行、真实授权落盘或模型业务结果。 |
| 作者源码编译、静态检查与缺产物负例 | 声明可解析、来源可核对、指定错误应被拒绝。 | 运行通过、安装授权或完整业务验收。 |

测试组及多轮复验存在重叠，**不相加为唯一测试总数**。

## 二、76b 项目的真实执行与保留状态

本节留存项目标识 `76b03253-ae0b-4298-be34-ed344fb15795`，作者包版本 `0.1.5`。通过原生入口完成安装、项目创建、依赖授权、知识及部署单元配置；本次配置检查为零问题。该结果只适用于本机已核对的配置，不携带到其他电脑，也不转记给后续独立验收项目。

刷新后的原项目记录为 `stageIndex = 2`、`version = 3`：

| 阶段 | 本次真实结果 | 限制 |
| --- | --- | --- |
| Convert | 真实模型执行完成，原生 shape 与业务检查通过，原操作为 `transitioned`。 | 只证明该阶段完成，不代表后续业务通过。 |
| PRD | 首次因缺少来源快照被原业务检查拒绝；再次通过原入口执行，真实模型依据诊断补齐快照与来源描述，原检查通过并 `transitioned`。 | 未手工补写业务成果或修改失败回执。 |
| Specs | 真实模型提出原生选项卡；正常关闭并重启应用后，原卡可显示，真实界面选择及提交成功。 | 续接进入模型之前触发 `MODS_SCOPE_CHANGED`，原操作保留为 unknown；回答为 answered、尚未 claimed。不能计为阶段成功。 |
| Design、Plan、Code、CICD、Archive | 尚未完成本项目真实验收。 | 不使用旧项目结果或自动化夹具补齐。 |

### 超过两分钟的真实原生审批

Convert 中首次规则进程的原审计记录为：`approval-waiting` 时间戳 `1792966118272`，`allowed` 时间戳 `1792966291973`，相差 **173,701 毫秒**。审批由原生对话框完成；随后 **1 次派发、1 次启动、1 次关闭**，进程执行约 **396 毫秒**，原进程状态为 `succeeded`。原请求摘要与规则包 27 个文件及 Bootstrap 来源已单独核对。

这条记录证明本次真实原生许可等待超过 120 秒后，所属调用仍可继续且未重复派发。它不证明所有长模型调用均不会超时，也不能反推用户此前未知结果一定由同一原因造成。

本机索引：

- `project-76b03253-ae0b-4298-be34-ed344fb15795.json`：刷新后的阶段与操作状态。
- `native-closure-author-compiled-receipt-0.1.5.json`、`native-closure-project-created.json`：作者包及项目准备记录。
- `native-closure-save-knowledge.json`、`native-closure-save-units.json`：本次配置操作记录。
- `native-closure-first-approval-result.json`：由原进程审计生成的审批时长、派发及结算摘要。
- `native-closure-first-process-review.json`：原请求与规则来源核对索引。

### 独立 b241 项目的后续真实验证

只读上下文修复后，另建独立项目 `b24129df-e0e0-4544-91b3-24c1a12d661b` 继续真实验收。独立项目身份不等于所有输入均从零创作，不能概括为“完全无复制”；原成功、审批或 unknown 回执没有转记。该项目已实际完成冷启动后的原输入认领（claimed）和真实模型续接；随后检查失败的事实必须与输入续接本身分开记录。该项目 Specs 检查 Flow 的原总预算为 **300,000 毫秒，包含等待确认**。原记录从 `00:38:21.610Z` 至 `00:43:21.848Z`，实际耗时 **300,238 毫秒**，原 attempt 记录总时间用完。此前“审批取消”的归因不准确：这是原 Flow 硬预算耗尽，**不是用户拒绝或取消**。

所属进程从 `00:38:27.441Z` 进入审批等待，至 `00:43:21.632Z` 记为 `not_started`，等待 **294,191 毫秒**；原进程启动数为 **0**。这能证明该子进程没有启动，不能单独证明整个 JavaScript 检查动作及其他资源没有副作用。Guest 的可信审批等待豁免不延长更早的 Flow 硬期限，两者不可混为同一个 120 秒边界。

原 operation 与 terminal 的未知历史继续保留。现有证据尚不足以安全解锁整段动作，本轮不扩大对账、不补造成功或无副作用证明，也不修改数据库强制重放。后续验证实例须另行保留原模型执行、全部检查和必要人工批准的实际证据，不能转记本次 unknown 为成功。

本机索引为 `resume-fixed-project-created.json`、`project-b24129df-e0e0-4544-91b3-24c1a12d661b.json`。该轮尚未形成完整真实八阶段结论，旧项目记录继续保留。

### 独立 r2（d5d72）项目的保留结果

该轮独立验收项目完整标识为 `d5d72b2a-fb18-46db-81e0-9c430063a9a4`，使用应用 2.0.0 与业务作者包 0.1.5。创建前明确复制了先前真实模型的 `NORMALIZED_REQUIREMENTS.json`、`PRD.bundle.json`、`SPECS.bundle.json`，连同 README、Maven 与忽略配置，作为待校验输入。`closure-r2-initial-inputs.json` 留存初始文件摘要；没有复制 state、receipt 或 approval，也没有把这些输入当作成功权威。当前目标允许模型复用确实满足契约的材料，不满足的必须在本项目修正并通过全部检查。因此准确表述是“新项目重新执行和验收已有输入”，不是“从零且不复制成果”，也不是旧 unknown 的恢复或 legacy import。

| 阶段 | 当前实际结果 | 尚未完成的部分 |
| --- | --- | --- |
| Convert | 当前真实模型和原检查完成，原操作 `transitioned`。 | 不替代后续检查。 |
| PRD | 首次原业务检查失败，随后经正常入口真实重试、补齐契约并 `transitioned`。 | 原失败记录保留，没有手写成功回执。 |
| Specs | 当前真实流程检查和推进完成，原操作 `transitioned`。 | 上游场景文字仍需在设计审核中按主要求裁决，机器检查通过不等于每条业务语义均正确。 |
| Design | 原 `1338...` 操作的两项检查成功；用户经原生入口保存修改意见并拒绝，再 cancel 后启动新 `2613...` 操作。 | 新操作触及单次输出 30 秒保护后为 `unknown`，没有到后置检查，未推进。原成功检查与拒绝记录保留，新修订草稿也保留，不能计作修订通过。 |
| Plan、Code、CICD、Archive | 尚未完成当前项目真实验收。 | 不使用自动化模型夹具或其他项目结果补齐。 |

成果修改意见入口已在这个真实 Design 上完成意见保存、拒绝、取消原已结算操作及启动新操作；这证明入口实际可用，不证明新修订成功。原审查意见涉及非法 UTF-8、非原子移动回退、设计锁时间与测试命令。新操作的保护超时及 unknown 保留；当时退休日志没有记录底层 cause，不能据现有日志补断言某个清理部件必然失败，也不能把后续诊断增强当作旧原因已查清。新项目的结果不改写 76b、b241 或其他旧 Design 的未知历史。

本机索引：`closure-r2-initial-inputs.json`、`closure-r2-project-created.json`、`project-d5d72b2a-fb18-46db-81e0-9c430063a9a4.json`。

### 当前独立 r3（def525）项目

项目完整标识为 `def52587-0402-4a92-be11-362754f11636`。创建时复用先前三个上游产物及未完成修订草稿作为待校验输入，未复制 state、receipt 或 approval，亦非旧 unknown 恢复或 legacy import。初始输入见 `closure-r3-initial-inputs.json`。本轮真实模型已更新需求、PRD 和 Specs：`NORMALIZED_REQUIREMENTS.json` 现为 rev3、21 项需求，不能说前三阶段一直沿用原文件字节。

新工作区首次执行因依赖未授权失败，原失败记录保留。负责人通过原设置入口真实授权规则与知识依赖后，再沿正常项目执行入口继续；这不是后来新增项目内依赖卡的实跑证据。

Convert、PRD、Specs 已分别通过两项原检查并 `transitioned`。此前在 `stageIndex = 3`、`version = 4` 按连续执行原预算正常停止并关闭应用。新构建于日志时间 04:18 恢复同一 profile；完成下述依赖界面验证后，负责人显式点击连续执行，启动 Design operation `e7647309-fa67-4ff7-a210-f9f84264db56`、thread `9af83a81-89d1-4e80-bfd4-7e3bd178a429`。该次真实模型已成功结算并退休，27 项原规则经原生审批运行后明确失败，Host 为 `failed / project_checks_failed`，不是 unknown，阶段未推进。

只读运行原检查器的诊断确认：`design.md` 为 **22,482 UTF-8 字节**，超过原每个内层文本 **20,000 字节**；整个 bundle 为 **23,376 字节**，虽低于 **28,000 字节**仍不满足内层限制。原 Design Skill 第 23 行已经声明两项限制，不能归因为缺少约束。原检查器抛出 `ARTIFACT_BUNDLE_CONTENT_INVALID`，冻结旧 provider 的适配器却将其折叠为 `ARTIFACT_REFERENCE_READ_OR_CHECK_FAILED`，使界面丢失具体业务错误；诊断没有改写产物或原失败回执。证据为 `closure-r3-design-business-failure-diagnostic.log`。

随后正常构建恢复同一 profile，先点击连续执行只返回 `stopped`，没有自动重试失败操作。负责人再显式开始当前阶段，创建 Design retry `8555b289-97dd-4eb4-90a1-9fa325365d98`、thread `8f01f30d-c06b-4d66-8020-24af18502416`。其 expectedVersion 仍为 4、输入指纹仍为 `419ce480...`，与失败操作相同，沿既有 `previousCheckDiagnostics` 路径重试。该操作已实际执行 1 次原检查进程，仍返回同一笼统诊断并明确 failed；当时内层 20,000 字节与 Maven 相关问题尚未修好，不能将该次失败记为自纠通过。只读证据为 `readonly-verification-def52587-0402-4a92-be11-362754f11636-2026-10-26T05-10-22.645Z.json`。随后负责人在真实项目界面提交 972 字符阶段补充说明，创建第三次 Design 操作 `ac4ef9bf-d79f-4bba-bab4-9080e3231976`。说明已冻结在新操作，历史操作未变；模型实际把测试方案改为通过生产 POM 的 Maven test 绑定独立 Java 检查 Main。该次修订随后完成原生审批与两项原检查，经人工成果确认 approved 后 transitioned。前两次 Design 明确失败记录保留；Plan b068... 的 35,909 字节产物超过原 28,000 UTF-8 字节上限，在输入捕获边界停为 unknown、terminal=null，未进入业务检查或原生进程；不能记为业务检查失败或已恢复。Plan、Code、CICD、Archive 尚未在此项目完成，不以此前自动化或其他项目补齐。

本机索引：`closure-r3-initial-inputs.json`、`closure-r3-project-created.json`、`closure-r3-rules-granted-ui.log`、`closure-r3-knowledge-granted-ui.log`、`project-def52587-0402-4a92-be11-362754f11636.json`、`readonly-verification-def52587-0402-4a92-be11-362754f11636-2026-10-26T03-43-19.727Z.json`。
## 三、旧项目状态保持不变

旧项目曾真实完成 Convert、PRD 和 Specs 的检查及推进；其中 PRD 经真实业务拒绝、诊断与重试，Specs 经原生选项提交续接。这些结果属于当时加载的旧项目版本，不转记为当前新项目的阶段成功。

旧 Design 在实际执行后被人工取消，原操作仍为 `unknown`，原项目停留在 `stageIndex = 3`、`version = 5`。不得改写成功、强制解除未知或盲目重放。该次人工取消不是此前所述“120 秒 unknown”问题的原因证据。

本机索引：`project-prd-passed.json`、`project-specs-passed.json`、`project-design-cancelled-original.json`、`specs-input-continuation.log`、`prd-original-flow-runs.json`。失败诊断只用于说明和重试上下文，不充当成功回执。

## 四、本轮新增及保留的共用平台机制

以下能力依照通用声明、原运行来源和原资源账本执行，不按 AutoBiz 名称建立平台特例。

### 1. 原生审批等待与绝对期限

可信主进程只对实际原生许可等待及受控策略队列等待登记暂停，绑定原调用及其祖先逻辑链；同一链累计最多 15 分钟，重叠等待按并集计时，子调用不能刷新额度。主进程、实际 Guest 帧和相关软期限通过私有确认协议保持一致。过期或旧代次票据不能复活调用，取消和撤权仍及时生效。

Guest CPU 配额、进程执行超时和更早的硬期限不因此延长。Flow、资源预算等原硬边界优先。业务 UT 时间数值由插件声明，平台沿原资源账本执行绝对期限；重启、重放或修复不能重置。自动化传输回归与本次 173,701 毫秒的真实审批分别保留证据。

### 2. 声明工作流模式及原 Host 结果轮

阶段可显式声明 `executionMode: "workflow"`；未声明的普通阶段维持原模式。声明经冻结 manifest、原来源令牌及运行入口核对，不向所有普通会话默认开放工作流工具。

Host 使用原工作流实际执行身份和物理结算通知，进入同 operation、同来源的结果模型轮；通知认领需匹配原 run 和启动身份。初始轮与结果轮的取消证明累积核对，后到的成功标签不能覆盖未确认的副作用。工作流启动后的用户输入只支持原 live 续接，不承诺应用重启后自动重放；未知结算保持未知。

### 3. 当前及前序阶段的只读工作流证据

`native.project-runtime` 的 `inspect-workflow-evidence` 只读动作从当前 Host 绑定选择指定阶段和原 run，不接受调用者任意指定项目、线程、路径或 operation。历史阶段仍要求原已接受的持久化成功、成果字节、检查及必要人工审核。

当前 Code 检查发生在整个阶段最终成功之前。为避免提前写入成功，主进程仅在原 Skill 的模型轮、所属工作流及 MCP 已物理结算成功后，为后续动作和检查提供短期成功证明。证明绑定原 project、operation、stage、thread、来源摘要和输入摘要；原身份、输入及权限继续核对。证明随作用域退出失效，不写成回执、不向 Guest 暴露。作用域随机身份只进入原缓存访问摘要，防止旧请求借用新作用域。

实际 utility 回归使用作用域外预热的 session，验证真实 Guest 平台调用经原主进程回调取得证明；关闭作用域、旧请求键、新作用域以及异步期间撤权均有拒绝覆盖。这不是依赖跨进程传递内存作用域的假设。

### 4. 已结算 Host 阶段的会话退休

实际检查发现独立阶段线程残留 Function session 会占满原 6 槽限制。仅标记空 Host 来源结算，或仅释放 Flow 执行租约，并不足以归还槽位。

修复在完整阶段最外层、最终 terminal 写入之前，捕获并退休原静止会话：先完成 context 只读证明、模型及结果轮、工作流和 MCP 结算、检查 Flow 与原事实核对，再沿原 Mods owner、队列及 Function 物理清理链退出。容量在实际退出确认后释放；清理失败转为 unknown 并保留占用。输入等待、未知结果、活动资源和实例替换不得被当作可回收对象。

上限仍为 6，普通会话不被自动驱逐；不新增 SessionEnd 业务调用，不在 context Flow 内提前退休。恢复后的原线程也沿相同身份检查收尾。整阶段最终 terminal 保持一次提交，临时 Skill 证明不成为第二份持久状态。

### 5. 来源、取消、诊断与读取性能

- 首次 Host 准入与原生界面读取沿原原子交接保留精确来源；未获准的实际 Functions 源不得缓存成已准备空图。真实无处理器或仅配置的来源仍保持原空 Host 身份。
- 取消“可确认无副作用”的范围只覆盖可证明未派发效果的原执行。实际 Guest 调用、工具、SDK 或 Hook 派发均否决该证明；原物理清理失败仍是 unknown。旧业务状态不因修复改变。
- 失败检查诊断绑定原 Flow 私有事实、来源及输入，有界展示；安全文本保护仍保留。历史只读诊断不制造新验收回执。
- 专用 Host 绑定读取保留最近 20 条操作及坏数据拒绝语义；`getThreadRuntimeScope` 只移除 metadata 顶层文件采用历史，不回写完整记录。父子身份、撤权、删除重建及原流式 guard 保留。
- 快照优化减少逐文件重复整树核对，保留捕获和发布边界的完整输入字节检查、逐项权限检查及拒绝覆盖语义。查询微比较不等于端到端性能验收。

### 6. 持久化提问卡的身份一致性

原输入服务每次读取 SQLite 都创建新的对象，而原界面站点使用对象身份校验挂载请求，导致恢复后的原卡被误判为过期。服务现在对同一存储实例、原完整记录及恢复标记提供有界、冻结的稳定视图；每次读取仍重新检查原数据库记录与准入条件。答复、撤销、配置或来源变化均使旧视图失效，不缓存执行授权，也不放宽界面身份检查。

76b 项目真实重启后的原卡已能显示、选择及提交，但运行时重建暴露只读上下文证明绑定旧 session 的问题；该原记录回答完整保存、`claimed = false`，失败和回答均保留。修复后的独立 b241 项目已取得原输入 claimed 和真实模型续接的证据，但其后 Specs 检查触及原五分钟总预算，整段操作仍为 unknown。二者不得混写为同一操作，也不清账、改终态或强制重放。

### 7. 冷续接的只读上下文守卫

恢复预检先核对知识 provider，随后原 Host 准入会合法退休该普通 provider 会话，建立原 Host 来源。旧守卫把只读证据的有效性与旧 VM 实例存活混在一起，导致最终 checkpoint 认领前误报 `MODS_SCOPE_CHANGED`。

修复仅改变已完成上下文的只读证据守卫：保留原实际编译结果、导出与权限检查，在每次使用时重新核对来源字节及文件身份、原授权、配置版本、线程身份与 owner、工作区代次及取消信号。它不依赖已合法退休的 VM；检查或动作的执行守卫仍要求原会话身份，不能借历史只读证据执行新动作。原 checkpoint、输入指纹、上下文回执和未启动后续阶段的检查均保留。

新增回归覆盖真实普通会话至空 Host 的交接，以及源码变化、授权撤销再授予、配置保存、线程替换、owner 撤销、工作区变化和取消。针对性通过不等于旧失败已恢复：`answered`、未 `claimed` 和原 interrupt 只能证明 checkpoint 尚未消费，不能单独证明之前的恢复准备没有副作用。本轮不补造该历史证明，也不对所有 `provider_error` 开放重试。后续采用独立项目验证。b241 已验证实际冷输入认领和模型续接，后续检查预算失败仍保留；d5d72 明确复用前述已有模型材料作为待校验输入，再执行当前模型、检查及人工确认，没有复制状态、回执或审批。不能把“新项目”写成“全部材料从零创作”，也不能把它当作旧 unknown 恢复。

### 8. 本次整库后确认的三项修正

- **新鲜线程身份读取的派生索引。** 保持原 `getThreadRuntimeScope` 投影表达式，只为线程 ID 与该表达式建立 SQLite 索引。每次身份读取仍执行原查询；索引由数据库在原写事务内维护，不缓存授权、不新增业务账本。旧库在正常初始化时建立索引，坏 JSON 和非对象值保留原投影语义；必需索引缺失时拒绝读取，不回退为空身份。首次建索引有启动 I/O 与磁盘成本，合成比较不能代表端到端提升；验证未修改运行应用的数据库。
- **支持发现页的文案预算。** 阶段调试单项页原为 8592 字符，即使缩为一项仍超过既有严格小于 8000 的限制，导致正常游标遍历失败。只压缩重复说明，保留能力、操作、权限条件、机器枚举、原游标及测试断言；最大页现为 7883 字符，仅余 117，不能称为留有充分空间。这里沿用 JavaScript 序列化字符串长度口径，不是 UTF-8 字节上限，后续新增能力仍须通过完整分页回归。
- **后台定时器的独立等待上下文。** 第二周期在进入 Guest 前实际报 `MODS_TRUSTED_WAIT_STALE`，不是根据耗时猜测 CPU 配额耗尽。原清除 helper 使用 `AsyncLocalStorage.exit()`；其内部同步新建 scope 会重新启用存储并恢复旧命令上下文，之后的异步周期继承了已关闭 owner。修复只在既有明确的新执行边界使用 `run(undefined, ...)` 隔离上下文。普通嵌套调用仍共享祖先等待额度，原关闭 owner 仍拒绝；15 分钟上限、硬截止、CPU、进程与回调数量配额不变。正反生命周期用例先复现失败再通过，原定时器拒绝和清理断言保留。

### 9. 成果修改意见与显式重新执行

成果确认界面可在拒绝前填写最多 4,000 字符的修改意见。拒绝经原 `approve-result` 保存，意见绑定原 project、stage、version、来源及成果审核记录；已拒决定和意见只读展示，不允许二次接受或改写。普通接受成果不需要反馈字段，原审批兼容。

用户须另行点击“按修改意见重新执行”。界面先调用原 cancel；仅确认同项目、版本、阶段与来源的旧 succeeded 操作已 settled 并转为 cancelled，才沿原 prepare 创建新 operation，随后按原 start 流程执行。需要执行或上下文确认时仍会停下，不隐式批准。旧终态、检查回执、拒绝记录继续保留；unknown、不明确取消、跨页面迟到结果不会触发重跑。意见作为本阶段修订输入传给新操作，不增加权限或放宽检查。

未保存文本按项目、阶段、版本和 operation 隔离，切换时清空；已保存意见仍可查看。导入后仅验证已有字节的阶段不显示这个执行 Skill 的新入口，避免把 validate-imported 说成按意见重写。

本轮后端 5 文件 132 项和生产 React 浏览器脚本通过，官方 Node、Web 类型检查通过。r2 Design 已实际提交意见、拒绝并启动新操作，但新操作进入 unknown；入口闭环和业务修订验收须分开记录。

失败阶段另有可选 `stageInstructions`：仅当前明确 failed 且无活动或 unknown 操作时，填写“本次阶段补充说明（可选）”，显式点击“开始当前阶段”随原 prepare 保存到新操作。非空说明禁用连续执行，准备失败保留输入、成功后清空，历史仅显示所属操作的实际说明。原记录、goal、来源、审批及检查不变，子代理不继承主阶段修订目标；不能用于强制重跑 unknown。后端原时限 4 文件 129 项通过，增强后的原冷续接 3 模式另次 3/3、10.48 秒，后者与前组重叠、不相加；真实 React 浏览器脚本通过。官方 Node、Web 类型检查和原 npm run build 均已通过；真实项目已提交 972 字符说明，说明绑定和历史不变已有实际证据。第三次 Design 随后已完成两项原检查、原生审批与人工接受并推进；此为该阶段的真实修订闭环，不代表后续 Plan 或完整八阶段通过。

### 10. 子任务上下文与项目内依赖授权

主阶段的执行目标、写产物和修订反馈要求不再自动传播为 `task` 子代理的目标。Host 为子代理提供冻结的背景、知识与约束，系统提示及 Mods 任务贡献两条通道使用相同边界；子代理执行明确委派，AGENTS、必需上下文、来源及工具权限继续生效。只读角色仍不能写入或执行被禁止的命令，普通非 Host 会话行为保持。针对性回归 4 文件 71 项通过，不能据此反推旧 Design 的绕圈或超时已恢复。

项目权限界面现在按原保留动作锁展示主包及各项实际依赖，支持逐项确认原授权和保存必填配置。仅配置主包不运行 VM，不等于依赖已授权；只有主包、所有依赖、配置及相关开关全部就绪，才允许继续启动。缺失、停用、来源变化或无效依赖仍需经原入口处理，不自动替换或批准。批准依赖不代替具体命令许可、Git 集成确认或成果接受。

该入口后端 4 文件 47 项、preload 1 项及生产 React 浏览器夹具通过；官方 Node、Web 类型检查、正常构建及来源摘要核对均已通过。新构建中同一 r3 项目的两依赖最初均为 ready。负责人只通过原 Settings 撤销 R3 规则权限，未停用或卸载插件、未改变全局开关；项目卡随即明确显示规则未授权，两个开始按钮均 disabled，未产生新 operation。随后在项目卡显式确认同一 digest 的规则授权，恢复 ready，但没有自行启动；负责人另行点击连续执行后才创建 Design 新操作。首次工作区准备的原设置授权与这次新卡片验证分别保留证据。

本机界面证据：`closure-r3-project-dependencies-ready-ui.txt`、`closure-r3-project-dependencies-missing-ui.log`、`closure-r3-project-dependency-approval-ui.log`、`closure-r3-project-dependency-restored-ui.log`。批准依赖没有替代具体命令许可、成果审核或启动决定。

日志时间 04:26:12，Design e764... 的真实 Explore 子任务返回 Java、Maven、Python 的环境事实，没有承担父阶段的 Design 制件任务。其中 `Python --version` 被只读门拒绝，子代理如实区分从安装文件推断的信息与实际命令执行；不能记成 Python 版本命令成功，也不能据此宣称父阶段已通过。

### 11. 精准身份投影与退休诊断

实际 Design 线程测得完整 metadata 为 127,560 字节，其中 `llmFileHistory` 为 126,191 字节；身份投影为 1,351 字节。只将三个不消费文件历史的实时守卫路径改为既有 `getThreadRuntimeScope`：conversation coordinator 的 owner 校验、原生会话输入准入与事实检查、transcript flush 的 incarnation 校验。仍每次读数据库，不缓存授权；其他完整 metadata 的复制和写回保持原样。

5 文件 119 项回归覆盖真实数据库、大历史、畸形数据、删除重建、工作区或 lease 变化及来源撤销；这证明指定读取路径及拒绝边界，不证明实际会话所有 30 秒保护已根治，也不能把跨轮 threadRead 计数全归于当轮 describeTools。退休诊断增强另有 50 项通过，只增加后续可观测依据，不补造旧 unknown 的原因或结算证明。

### 12. 内层产物业务错误的安全诊断

本次只改作者源适配器、Design Skill 及相应测试。适配器仅在原 `check.run` 抛出精确 `ValueError`、且完整消息命中原检查器固定业务代码白名单时保留该 code；未知异常、错误类型、子类或附带路径及正文的消息仍返回笼统错误，不泄漏详情。原提取规则、来源摘要、rules bundle、通过条件与尺寸上限均未修改。

Design Skill 增加结束前读取实际已保存 bundle 的 UTF-8 自检，逐内层文本不超过 20,000 字节、整个文件不超过 28,000 字节；不写业务产物、不重算批准、不替代原检查。真实 Python 回归覆盖大段中文和非 BMP 字符的按字节拒绝、未知异常脱敏、原规则摘要及现有负例。**当前项目仍使用其冻结的旧 provider 和 Skill，作者源修复或应用新构建不代表该插件已升级。** 不偷换当前项目的规则，也不另建反馈机制；当前显式重试仍依据原失败事实和既有诊断路径。

## 五、回归矩阵与构建记录

| 验证组 | 实际结果 | 口径与本机索引 |
| --- | --- | --- |
| 完整基线 | 1,752 文件：1,728 通过、5 失败、19 跳过；17,740 项：17,620 通过、28 失败、92 跳过；另报告 8 个未处理错误。 | `full-vitest-final.log`。保留原失败结果，不能宣称该轮全绿。未处理错误包括过时 VM 测试支架缺少 `getThreadRuntimeScope` 及其后续断言错误。 |
| 基线失败修复 A 组 | 最终 6 文件、90 项通过。 | `final-native-a90-regression.log`。覆盖对应 5 个失败文件的修复及相关来源回归；包含真实未授权来源空图缓存修复与测试支架适配。不是重新执行整库。 |
| B 组及 deadline 最终针对性复验 | 28 文件、366 项通过、1 项跳过。 | `deadline-workflow-native-closure-final.log`、`deadline-workflow-targeted-final-evidence.json`；其中真实 utility 传输 4 个场景通过。保留跳过项，不改为通过。 |
| 独立回归脚本链 | 16 组退出码均为 0。 | `remaining-regression-results.json` 及各 `standalone-test-*.log`。不将组数当作测试用例数。 |
| 浏览器界面 | 7 文件最终全部通过。 | `native-browser-regression-results.json`。全部是生产 React 组件与确定性 IPC 夹具，不启动真实模型。项目面板修复过时标题及无效 manifest/API 夹具后 r4 通过，前 3 轮失败日志保留。 |
| Code 与多仓原集成组 | Code 3 项、多仓 3 项通过。 | 原工作流、进程与业务检查集成证据；作者模型由夹具替代，不视为当前新项目 Code 真实通过。 |
| Host 阶段退休与临时证明 | 3 文件、86 项通过。 | `host-operation-retirement-proof-final.log`。覆盖原会话物理退休、unknown 与输入保留、上下文及终态边界。 |
| 工作流证据消费 | 6 文件组共 71 项，首轮 69 通过、2 失败；失败所在文件修正后 11 项全部通过。 | `evidence-live-skill-regression.log`、`evidence-live-skill-regression-r2.log`。属于原组失败文件复验，不相加为 82 项或称单次 71 项全绿。 |
| 临时证明的真实 utility transport | 通过。 | `host-proof-utility-final.log`：实际 utility、客户端、Guest 与原平台 provider；作用域外预热、关闭及缓存隔离、异步撤权均通过。 |
| Host 八阶段重型集成 | r3 两项通过，沿用原始时间预算。 | `native-business-host-retirement-regression-r3.log`。AutoBiz 八阶段约 407 秒，独立 supplier 场景约 11 秒；Code、CICD、Archive 原业务检查均完成。仍有模型夹具，不替代真实模型验收。先前容量、夹具与重复全量校验失败记录保留。 |
| 输入与证明发布边界 | 8 文件、123 项通过；真实 utility 传输回归通过。 | `evidence-boundary-guards-regression.log`、`host-proof-content-utility-final.log`。完整字节核对留在读证据及每个异步发布边界；即时撤权检查保留。局部追踪全量输入核对从 140 次降至 15 次，不将微比较表述为端到端提升。 |
| 持久化原生提问卡 | 3 文件、33 项通过。 | `persistent-question-identity-final-r2.log`。真实 SQLite、原站点挂载及提交，包含撤权、记录变化和配置重新绑定。真实卡已提交；提交后的独立守卫问题另列，不将其算作续接成功。 |
| 冷续接上下文守卫与原交接 | 2 文件、33 项通过：上下文 18 项、原交接 15 项。 | `context-resume-handoff-regression-r2.log`。真实 manager 会话交接、只读与执行权限分离、配置版本及 owner 撤销反例；不含真实模型八阶段。 |
| 已构建应用预览集成 | 工作流、上下文、阶段调试三项最终通过。 | `final-built-preview-and-regression-index.json`、`final-built-preview-workflow.log`、`final-built-preview-context.log`、`final-built-preview-debug-r2.log`。对应旧 `58d4` 构建，保留调试首轮失败日志；不能作为本次新构建或真实模型的验收。 |
| Node、Web 类型检查及修改文件 lint | 最终通过。 | `typecheck-native-boundary-and-input-final-r2.log`、`lint-all-changed-final.log`。332 个修改代码文件 lint 退出 0；成功退出不额外解释为业务测试覆盖。 |
| 冷续接修复的类型检查及 lint | 官方 Node、Web 类型检查与修改文件 lint 通过。 | `typecheck-context-resume-handoff.log`、`lint-context-resume-handoff.log`。不代替真实续接验证。 |
| 正常应用构建 | 冷续接修复后 2.0.0 正常构建成功，冻结源码与产物已核对。 | 该轮 `build-context-resume-handoff.log`、`build-context-resume-handoff-verified.json`；此前 `build-native-boundary-and-input-final-verified.json` 保留为历史。不代表安装包、跨电脑验收或最终发布。 |
| 首轮整库并行回归 | 1,751 文件：1,728 通过、4 失败、19 跳过；17,620 项：17,523 通过、5 失败、92 跳过；另有 1 个 worker RPC 错误。 | `full-vitest-closure-parallel.log/.json`。失败为支持发现页 2 项、定时器 1 项、Git Hook 并发安装与导入后校验各 1 项超时；另报 `Timeout calling "onTaskUpdate"`。该轮不是全绿，原报告保留。 |
| 线程作用域索引 | 6 文件、60 项通过；新增文件格式化后 14 项复验通过。 | `scope-index-regression.log`、`scope-index-new-test-final.log`；Node 类型检查及对应 lint 通过。覆盖旧库初始化/重开、真实 SQLite 执行计划、坏数据、跨连接更新/回滚、同 ID 重建及缺索引拒绝。14 项是复验，不相加为 74 项。 |
| 支持发现页修复 | 2 文件、20 项通过；单文件 lint 零错误、零警告。 | `support-page-regression-final.log/.json`、`support-page-lint-final.log`、`support-page-fix-draft/applied-result.json`。原 development-catalog 13 项与 creator-support 7 项，原时限和断言不变；293 个非文案机器叶节点保持一致。 |
| 定时器与可信等待修复 | 4 文件、38 项通过。 | `trusted-wait-timer-fix-regression.log`。helper 14 项、timer 17 项、真实 Guest 3 项、transport 4 项；保留原预算、拒绝及资源清理断言。`timer-refusal-isolated-r2.log` 与 `trusted-wait-fresh-boundary-before.log` 留存修复前稳定复现。 |
| 两个超时文件隔离复验 | 单 worker、原预算下 2 文件 59 项通过。 | `parallel-timeouts-isolated.log`。原 Git Hook 并发安装和导入后校验均通过；不提高 5 秒限制，也不凭隔离通过宣称整库并发条件下的超时根因已经消除。 |
| 完整并行回归 r2 | 1,752 文件：1,731 通过、2 失败、19 跳过；17,636 项：17,542 通过、2 失败、92 跳过；无 Vitest 未处理错误汇总。 | `full-vitest-closure-r2-final-index.json`、`full-vitest-closure-r2-parallel.log/.json`。startup 原 15 秒最大样本断言失败，实际 15,636.7216 毫秒；creator journey 的 harness-data 正向用例触及原 5 秒预算，实际 5,149 毫秒。原预算和失败记录保留；2 worker，源前后 5,173 文件摘要完全一致。较首轮新增线程作用域索引测试文件，无删除原文件。此轮未运行 native 12 组，不把旧 native 结果拼成全库全绿。 |
| 成果修改意见后端 | 5 文件、132 项通过。 | `result-feedback-regression.log`。原拒绝意见持久化、精确来源绑定、新操作提示和原取消/准备/执行流程；真实 Design 新操作的 unknown 另列，不与自动化通过混写。 |
| 成果修改意见浏览器及静态检查 | 原浏览器脚本最终通过，相关两文件 lint 零错误；官方 Node、Web 类型检查通过。 | `result-feedback-browser-final.log`、`result-feedback-renderer-eslint-final.log`、`typecheck-result-feedback.log`。覆盖保存意见、新操作顺序、原人工审批停点、unknown 拒重跑、busy、卸载与阶段/操作变化；IPC 仍为有界夹具；实际 r2 意见提交与重执行另列。 |
| r2 剩余两个失败文件隔离复验 | 单 worker、原时限，2 文件 23 项通过。 | `startup-journey-isolated-final.log/.json`、`startup-journey-isolated-final-execution.json`、`startup-journey-isolated-final-performance.json`。startup 四次样本为 5,777.5581、7,169.5652、6,573.1924、6,597.3725 毫秒，最大值低于原 15 秒；journey 对应原失败正向用例 3,757 毫秒，低于原 5 秒。只更新 startup 的真实物理 stopAndDrain 测试替身，保留 128 文件、4 请求及 legacy 无确认反例；不改生产、不提高预算、不循环择优。 |
| 精准 metadata 身份投影 | 5 文件、119 项通过。 | `metadata-scope-hot-guards-regression.log`、`runtime-thread-metadata-sizes-2026-10-26T03-07-49.862Z.json`。真实大小测量与指定路径回归，不作为所有超时根治证据。 |
| Host 子任务上下文边界 | 4 文件、71 项通过。 | `host-subagent-context-regression.log`。主阶段目标与委派目标隔离，背景和只读限制保留。 |
| 退休原因诊断 | 50 项通过。 | `retirement-diagnostic-regression-r2.log`。不把新增诊断追认为旧日志已经存在的 cause。 |
| 项目内依赖授权 | 后端 4 文件 47 项、preload 1 项及浏览器脚本通过。 | `project-dependency-consent-final-r2.log`、`project-dependency-consent-preload.log`、`project-dependency-consent-browser-r2.log`。后端包含真实 manager、Guest、配置和逐项工作区授权；该浏览器脚本用确定性 IPC，后续同项目实际界面验证另见下行，不混作同一证据。 |
| 项目依赖新构建及实际界面 | 正常构建成功，真实同项目撤权、拒绝启动与显式同 digest 授权恢复就绪通过。 | `build-project-dependencies-real-r3-verified.json`：2.0.0、4,245 源文件、586 输出；界面证据见本节上方四份 ready/missing/approval/restored 索引。授权后无自动启动，随后由负责人另行开始 Design；该操作后来明确业务检查失败，不因授权验证通过而计为阶段通过。 |
| 四处等价轻量读取 | 4 文件、207 项通过。 | `native-projection-scope-read-regression-r2.log`。限定原读取路径的等价投影及守卫回归，不作为全部性能或超时根治证明。 |
| 产物引用业务诊断与 Design 自检 | 真实 Python standalone 11 组、Guest/文档 2 文件 10 项通过；相关 TS lint 无错误。 | `artifact-reference-business-diagnostics-regression-r2.log`、`artifact-reference-guest-document-regression.log`、`artifact-reference-business-diagnostics-eslint.log`。首轮过时 standalone 查询夹具失败日志保留，补原只读查询后复验；原业务负例未删除，原 28 份规则摘要未改。 |
| 轻量读取与诊断后的正常构建 | 官方 Node 类型检查与正常构建成功。 | `typecheck-node-native-scope-read-design-diagnostics-r3.log`、`build-native-scope-read-design-diagnostics-r3-verified.json`：2.0.0、4,245 源文件、586 输出。Web 沿用此前同一 UI 源码的官方通过记录，本轮没有重跑；不称为新的双端检查或插件升级。 |
| Host workflow 动作作用域 | 3 文件、36 项通过。 | 仅主进程 active/exact scope 复制视图适配，普通 workflow、晚到调用、撤权及其他排除条件继续拒绝。 |
| 上下文派发边界 | 2 文件、94 项通过。 | 派发前错误须物理退休后 failed，startSaved 尝试后异常及退休失败仍 unknown；不修订历史。 |
| 本轮 native 组与测试支架复验 | 原 12 文件 221 项运行有 8 项失败；补一处 VM 的 getThreadRuntimeScope 注入后，对应整文件 87 项通过。 | 保留原运行失败，不将整文件专项通过改写为原 12 文件全绿。 |
| 增强后的混合八阶段与独立供应商 | 1 文件 2 项全部通过；用例 429.102 秒，进程总耗时 455.22 秒。 | `final-hybrid-eight-stage.json/.log`；AutoBiz 418.535 秒、供应商 10.565 秒。实际 mode/selection/ClawStore/Guest/Python/Host/worktree/compile/UT；模型作者、人工回调及线程 metadata 映射为替身，不转记 R4 成功。 |
| 最终 Plan 引用契约 | 原规则 23 个正负样本，4 项测试通过。 | `final-plan-reference-contract.json`。不替代实际项目原检查或人工批准。 |
| 最终官方类型检查 | Node、Web 均通过。 | `final-hybrid-typecheck.log`；应用 2.0.0。 |
| 全仓 lint 与改动代码检查 | 全仓 npm lint 原报告 186 errors；本轮 17 项范围内问题处理后，364 个暂存改动代码文件按 error 级规则检查为 0 错误，1 个原件依配置忽略。 | `final-changed-source-lint.json/.log`。工作流声明实际注入的 action/worktree 全局；legacy-reference 原始 CJS 作为固定原件忽略，不重写来源。剩余 169 条位于未改动的 76 个文件，未扩散修复；**全仓 lint 未通过**。error 级检查不等于零 warning。 |
| 最终正常构建 | 退出码 0，应用 2.0.0，4,245 源文件、586 输出文件。 | `final-hybrid-build.log`、`build-final-hybrid-verified.json`。正常构建，不是安装包或 CI 发布。 |
| 最终定向 Vitest | 实际选择 147 文件、2,042 项，全部通过，退出码 0；sourceUnchanged=true。 | `final-changed-tests-hybrid-r2-parallel.json`、`final-changed-tests-hybrid-r2-parallel-execution.json`，UTC 09:56:47–10:05:45。前后源码摘要均为 `90aec5d379271af5887080c4642e9362117f83e78635140071098613935b3935`。147 是实际选择数，不使用预计数；parallel 排除 native 范围，已复验 native 的 2/87 项等分别保留，不拼接为整库全绿。 |
| 最终 npm 独立回归分段覆盖 | 16 组覆盖完成；前 6 组退出 0，第 7 组 workflow 首次失败保留，后 9 组退出 0。workflow 原前缀 14 条命令通过，修正测试断言后从失败处起 18 条命令全部退出 0。 | `final-remaining-regression-results.json`、`final-post-workflow-regression-results.json`、`final-workflow-tail-results.json`。runtimeUnchanged=true；已通过的 66 项 Git 检查不重复运行。不是单次 npm test 全绿，命令数、组数和测试项数不混加。 |
| 通知认领测试支架复验 | coordinator 6 组、desktop 10 项、sandbox 88/88 通过；随后完整 18 条尾链也通过。 | `final-coordinator-notification-claim-retest.log`、`final-desktop-notification-claim-retest.log`、`final-sandbox-notification-claim-retest.log`。与尾链重叠，不相加为独立总数。 |
| 测试支架修订后的改动代码 lint | 364 文件，error 级规则 0 错误，1 个固定原件依配置忽略。 | `final-changed-source-lint-post-notification.json`；全仓既存 169 条错误仍保留，不称全仓 lint 通过。 |
| 失败阶段补充说明 | 后端 4 文件 129 项、增强后冷续接 3/3（10.48 秒）、真实 React 浏览器脚本通过。 | `stage-instructions-regression.log`、`stage-instructions-cold-resume-regression.log`、`stage-instructions-browser-regression.log`。冷续接为重叠复验，不累加；`typecheck-stage-instructions-real-r3.log` 的官方 Node、Web 检查通过，原 npm run build 通过；`build-stage-instructions-real-r3-verified.json` 确认 2.0.0、4,245 源文件及 586 输出。真实 972 字符说明已提交并冻结；第三次 Design 两项原检查、原生审批及人工接受完成并推进，Plan b068... 后续在产物输入捕获时成为 unknown，详见本报告当前事实。 |

最终 workflow 首次失败是过时的 owner-only 正则断言：原 IPC 的 claim 接口已增加 `expected: {runId, startedAt}`，**不是函数被移到 helper**。仅两个测试文件适配实际调用形式，保留原 ack/release 与至少一次投递语义；sandbox 的第 85 项新增 AST 行为用例，执行实际 IPC claim 表达式和原 manager 的 find/claim/release，核对 owner/expected、并发唯一认领、lookup 未知不得标 delivered 或残留 in-flight、失败后可重新认领。生产代码没有随此测试修正改动；尾链报告核对运行时摘要未变。原失败日志继续保留，不以复验成功覆盖首次失败。

本轮项目依赖功能官方类型检查已通过，日志为 `typecheck-project-dependencies-real-r3-fixed.log`（Node）及 `typecheck-web-project-dependencies-real-r3-retry.log`（Web）。首次 Web 命令因误用 D 盘工具路径未启动 tsc，其原调用日志保留，不作为类型检查结果；通过结论只依据随后实际执行的官方命令。随后正常构建成功，`build-project-dependencies-real-r3-verified.json` 记录退出码 0、版本 2.0.0、4,245 个冻结源文件及 586 个输出摘要；这不是打包或完整业务验收。

早期取消结算 22 项、Host 49 项，以及 scope、UTF-8、作者契约等局部回归仍作为历史证据保留，但不与表中有重叠的最终组累计。当前准确结论是：支持页与定时器的确定缺陷已修复并复验，新索引边界通过；r2 没有报告此前 worker RPC 未处理错误，但这不反推首轮错误根因已经消除。r2 的 startup 性能和 creator journey 原预算失败保留；后续一次单 worker 隔离复验两文件通过，不证明整轮竞争条件下的性能已解决。**没有在最后补丁后重新完成一次全量全绿运行**。

Plan 作者契约已补齐精确枚举、结构、完整教学例及首批生产配置与独立测试作者边界；通用输入边界修复与相关回归共4文件120项通过（`plan-input-boundary-regression-r2.log`），真实 React 输入准备界面通过（`plan-input-preparation-ui-browser-regression.log`）。教学例执行原 Python checker 与命令策略，不等于新作者版已经过真实模型验证，也不改变旧 r3 unknown。

## 六、作者包、迁移与剩余实际验收

当前 R4 真实验收主包为 0.1.6，规则为 0.1.4、知识为 0.1.0，保留原八阶段顺序、Python 业务规则、知识选择器、配置、适用 Hooks 和原检查要求。阶段工作流能力通过显式声明使用，不绕过审批或降低业务检查。

此前 `portable-final-source-set/` 的 72 文件清单及编译记录属于当时准备的源码集合，不能自动代表当前 R4 版本的最终可交付包。最终交付前必须依据冻结版本重新核对源码、依赖及逐文件摘要；不带安装 UUID、审批数据库、私人知识目录或凭据。此前 `portable-native-closure-source-set-0.1.5/` 为同步后的作者草案：共 75 文件，清单覆盖其余 74 文件（含 README 和描述文件，仅排除清单自身）；未编译、安装、授权或打包，不与实际项目绑定的冻结插件混同。当前独立验收使用 `native-closure-source-set-r4-0.1.6/`：主包 `autobiz-full-reference-r4` 0.1.6、规则 0.1.4、知识 0.1.0，同为75文件/74清单项；该集合已通过 Creator 原生导入、依赖安装授权、advance 编译与主包安装，无旧项目状态/回执/批准。安装完成不等于完整业务或最终交付验收完成。

本轮交付附件已收敛为 **6 个文件**，原 11 文件完整备份保留。规范作者源版本为 **主包 0.1.4、规则 0.1.3、知识 0.1.0**；应用仍为 **2.0.0**。这些交付版本与 R4 本机验收别名的主包 0.1.6、规则 0.1.4、知识 0.1.0 分别记录，不把本机安装身份、别名或授权数据当作可移植交付事实。附件收敛不改变 R4 的成功或 unknown 历史，也不等于安装包或外部发布已验证。

目标电脑仍需安装依赖、绑定真实知识目录及部署单元、提供适用规范，按当地来源摘要完成授权和原编译检查。当前 Code 范围为 `backend_only`；工作树、进程、成果与 Git 合并等独立审批仍须照常完成。本机配置为零问题不代表换机无需配置。

以下项目仍待验收负责人补充原证据：

1. 增强后的混合八阶段与独立供应商 2/2 已通过，官方 Node/Web 类型检查及改动代码 error 级 lint 通过，全仓 lint 失败仍保留。正常构建、实际选中的 147 文件/2,042 项定向复验及 16 组 standalone 的分段覆盖均已完成；原失败及后续复验分别保留，已复验 native 与 parallel 排除范围分开记录，不宣称重跑整库或单次 npm test 全绿。R4 前五阶段真实通过，Code unknown 保留；不新建 R5 重跑，不把测试结果写回旧项目，不跳检查或写数据库补状态。旧 r3 Plan、r2 Design、b241 检查 unknown 与 76b 失败和答案继续保留。
2. 按当前新构建和混合回归的实际证据区分已验证入口与尚未验证的真实业务。项目内依赖卡的正常构建和实际撤权、恢复授权界面验证已完成；成果反馈也已实际用于 r2 Design，但修订未通过，不能用入口可操作代替业务验收。工作流、上下文和阶段调试的三项已构建预览集成对应旧 `58d4` 构建，不将其转记为最新构建通过。
3. 最终业务实现的独立真实 HTTP 验收，包括合法请求 201、非法请求 400 不写入、Unicode 码点与内容原样保留、唯一完整记录、重启持久性及运行中保存故障 500。已准备的脚本不能当作已执行通过；已补正文原始 1,002 码点但 trim 后 1,000 的拒绝场景，百分号解码和原始 HTTP body 非法 UTF-8 的 400/不保存案例，以及合法字面 U+FFFD 的 201/保真正例。脚本尚未实际调用服务，不能把已编写案例计为 HTTP 验收通过；最终启动参数和存储格式须依据实际 Code/Design 绑定。
4. 外部 Actions 的实际运行、结果和适用发布约束。生成配置或本地检查通过不等于远端执行成功。
5. 最终版本的源码集合及打包验收。当前只有正常构建；负责人依据约定的混合验证范围与必要回归决定后续打包。包生成不补足未执行的真实模型、HTTP 或外部发布验收。

原 Design unknown、76b 项目的 Specs 失败与已保存答案、b241 项目的 Specs unknown 均保留。阶段调试、分支接受或新项目都不得被描述为旧操作已经成功或已经安全重放。

## 七、后续更新栏

- 当前应用：**2.0.0，已有正常构建与摘要核验；运行和回归证据按各自时点保留，不将旧构建测试转记为新构建通过**。
- 当前真实作者包与项目：**R4 主包 0.1.6、规则 0.1.4、知识 0.1.0 已经 Creator 原导入、安装、授权与编译；abb70da0 前五阶段已 transitioned，Code 原操作 unknown 保留。HTTP 402、Plan 引用失败及模型修正轨迹保留**。
- 76b 项目阶段：**Convert、PRD transitioned；Specs 回答已保存，续接失败历史保留；其余未完成**。
- b241 独立项目：**原冷输入已 claimed、真实模型续接成功；随后 Specs 检查 Flow 含审批等待的 300,000 毫秒预算耗尽，进程 not_started、启动数 0，整段操作仍 unknown。非用户拒绝/取消，历史保持不变**。
- r2 d5d72 项目：**前三阶段 transitioned；原 Design 1338... 两项检查成功后经原生拒绝和 cancel，新 2613... 按意见运行触及单次输出 30 秒保护而 unknown，未到后置检查；旧成功检查、拒绝和新草稿保留**。
- 历史 r3 def525 项目：**复制三上游及未完成草稿仅作输入，无 state/receipt/approval 复制；首次缺依赖失败保留，经原设置真实授权后，Convert、PRD、Specs 各两项检查通过并 transitioned。本轮真实模型已更新 NORMALIZED（rev3、21 需求）、PRD 与 Specs；此前连续预算正常停，新构建恢复并完成依赖界面验证后，Design e7647309... 模型成功结算、原检查明确 failed；内层文本22,482字节超原20,000限制，retry 8555b289... 也在实际执行 1 次原检查进程后明确 failed；第三次 ac4ef9bf... 已按真实补充说明修改 Maven 测试方案，完成原生审批和两项原检查，经人工 approved 后 transitioned；Plan b068... 35,909 字节超过原28,000字节上限，捕获边界为 unknown、terminal=null，未进入业务检查，未记恢复或完成**。
- 冷续接修复：**33 项针对性回归、类型检查及前次正常构建通过；b241 已有真实输入续接证据，但不能把其后检查 unknown 记为阶段通过**。
- 超过两分钟原生审批：**173,701 毫秒，1 次进程派发并确认成功关闭**。
- 自动化：**旧 r2 完整 parallel 及失败记录保留；最终定向实际 147 文件/2,042 项全通过，sourceUnchanged=true。16 组独立回归分段覆盖完成，workflow 首次失败与前缀 14 条、修复后尾部 18 条通过分别记录；各轮重叠不相加，不称单次 npm test 或整库全绿**。
- 新反馈入口：**后端 5 文件 132 项、浏览器脚本与官方类型检查通过；真实 Design 已拒绝并启动按意见的新操作，该操作未通过验收**。
- 新增窄测：**精准投影 119 项、子任务边界 71 项、退休诊断 50 项通过；项目依赖授权后端 47 项、preload 1 项及浏览器脚本通过。整库两失败文件原预算单次隔离 23 项通过，不改写 r2 整轮结果**。
- Host 八阶段混合验证：**既有 r3 两项通过；新增强用例使用真实 mode/selection 路径，1 文件 2 项通过（429.102 秒；总耗时 455.22 秒）。原 native 组 8 项失败及对应整文件 87 项复验分别保留；后续为改动范围定向复验，不重跑新一轮完整 parallel**。
- 真实模型八阶段：**未完成；用户已改用明示 Mock 的混合验证，不再新开 R5**。独立 HTTP、真实外部 Actions、跨电脑与最终包：**尚无完成证据**。
- 构建与提交边界：**最终正常构建、官方 Node/Web 类型检查、改动代码 error 级 lint 及约定的定向/分段回归通过；全仓 lint 既存错误保留。CI 尚未触发，提交、推送及 Actions 结果由负责人随后记录，未执行的真实外部发布不记成功**。
- 最终交付结论：**本轮约定的混合验证已完成，完整真实模型八阶段及尚未执行的 HTTP、外部发布、跨机和最终包仍不作成功结论**。
