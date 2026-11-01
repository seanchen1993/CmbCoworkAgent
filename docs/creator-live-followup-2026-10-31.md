# 创造者通用项目插件：续作验证记录

本轮目标：修复此前剩余 5 项失败，使用实际配置的模型验证 AutoBiz 与非 AutoBiz 的从零创建、派生、调整组装和项目运行，并交付可人工试用的模板。候选编译、模型创作、实际运行分别记账，不相互替代。

## 当前结论（2026-10-31，阶段衔接补验通过）

本轮重点是通用流程衔接，不要求逐项完成插件内部全部业务实现、Git 操作、编译、测试和发布准备。验证阶段结束后的状态提交、上游产物传递、下一阶段启动及最终完成；创建、派生和调整组装使用同一标准。

- 流程缺陷：结束后无法推进、推进错误阶段、丢失或错用上游产物、重复启动、错误继承旧版本结果等，计入失败。
- 环境阻塞：本轮隔离 Git 身份缺失、人工审批等待触发动作时限，单独记录，不计作流程衔接失败。审批授权、拒绝或取消处理本身若有程序缺陷，仍属于流程问题。
- 待验证：环境阻塞使后续衔接尚未实际发生时，标为待验证，不把没有观察到的边界写成通过。

此前真实记录已经验证基线→定义→方案→代码启动。本轮已使用实际编译声明和真实 Host/SQLite 补验代码结束→交付→最终完成，以及交付→audit→最终完成。当前五阶段模板、当前模板追加 audit、已保存的真实六阶段派生源码、非 AutoBiz 供应商流程四组均通过；每组最终状态均为 completed。

本次使用最小合法阶段产物及明确受控的业务执行结果、授权和配置身份；状态提交、输入绑定、产物摘要、成果确认、阶段推进和重开持久化走真实实现，不运行整套业务。生产校验和权限不变，原始 failed/unknown 回执不改写。相关三个文件共 55 项回归通过，Node/Web 类型检查及新增文件 lint 通过；代码独立复审通过。完整范围、四组边界与证据见 [阶段衔接补验](project-stage-handoff-verification-2026-10-31.md)。Git 与审批环境事项单列，不作为本轮衔接失败。

## 此前完整业务执行口径的记录（历史，以下未通过不等于当前衔接验收失败）

| 验收项 | 实际状态 |
| --- | --- |
| 原剩余 5 项失败 | 已修复；相关 241 项通过，两位 agent 复审 |
| 非 AutoBiz 从零、替换阶段、调整提示词 | `run-oGKIBt` 完成真实试用、保存和普通项目运行；首次业务校验失败后由模型修正提示词，保留失败记录 |
| 非 AutoBiz 连续两代派生与追加阶段 | `report-derived/run-uj0liK` 两代均完成试用、保存、普通项目运行，并验证原模板未变 |
| AutoBiz 从零创建小型研发准备流程 | `autobiz-from-zero/run-zGK7Sn` 四阶段试用、保存、普通项目运行通过；不等于从零重建完整研发引擎 |
| 完整 AutoBiz 五阶段模板 | `resume-02` 缺任务数组、`resume-03` 设计引用格式不符均由原检查拒绝；两处作者契约表达欠明确已定位。`run-PnlVpg/resume-04` 方案经原检查和人工接受后推进；代码工作流因隔离验收仓库未持久配置 Git 身份而提交失败，保留 unknown/dirty 工作树，未重放。基线/定义/方案通过，代码与交付未通过，完整流程仍未通过 |
| 完整 AutoBiz 派生并增加 audit | `autobiz-derived/run-83dmCV` 候选通过；`run-F1yB4v/resume-03` 基线、定义、方案已通过，真实生产实现提交成功；编译动作在多次人工审批等待中触发原队列 120 秒总时限，实际编译尚未执行。Host 最终 Code failed，未生成成功产物、未重放 unknown 资源；代码/交付/audit 未通过，完整六阶段未通过 |
| 全量 `npm test` 与最终静态检查 | 首跑结束：1,818 文件通过、4 失败、19 跳过；18,934 项通过、10 项默认 5 秒超时、92 跳过，另有一个 Vitest `onTaskUpdate` RPC 超时。4 个失败文件按原时限单 worker 复查 136/136 通过、无 RPC 错误；原 standalone 尾链 18/18 脚本全部通过。最终 Node/Web 类型检查通过；44 个改动源码/测试文件 lint 零错误，保留 1,967 条告警。不将首跑写为全绿 |
| 人工试用模板 | 已放入 `D:\王博闻\AutoBiz-项目模式模板`；补正契约与工作流启动说明后的作者源摘要为 `6e8933e20020dadea4011f62714cb91283c6e180f0409805b1cb0417cbedec5f`，实际中文路径导入通过、与仓库一致。这个新摘要尚未完整真实模型复验；需使用包含本轮修改的应用 |

以下保留各轮过程及失败，历史段落中的“执行中”应以本节最新状态为准。真实模型验收使用公开接口及逐项权限审阅，包含真实人工反馈；不是无人干预成功率测量，也不代替用户完整 GUI 试用。

完整 AutoBiz 的本轮修复使用同项目重试。测试脚本绑定原应用、完整作者源、项目、工作区、请求和插件摘要，逐阶段核对已接受前缀的实际回执；仅通过公开 `prepare.stageInstructions` 将审阅意见交给模型。旧操作和失败证据保留，新证据在 `resume-02` 等目录；最多三次显式反馈重试，不重放 unknown 或正在取消的操作。原生进程审批序号在重启后继续，旧批准不能自动批准新请求。两位 agent 已交叉评审这些测试脚本修改；平台和业务校验没有为重试放宽。

派生版首次定义的 PRD 格式问题由真实运行中反馈修正，随后原校验发现 requirements 错用对象数组；独立审阅另发现 SCN-010 数值矛盾。其原失败见 `run-F1yB4v/evidence.json`，反馈及新尝试见同目录的 `definition-retry-feedback.txt` 和 `resume-02`。已通过真实提问确认的四项设计选择随反馈保留，不改写原请求或上游基线。

## 完整五阶段基础模板：本轮终态（2026-10-31 19:38）

已明确启动同项目第三次尝试 `run-PnlVpg/resume-03`，反馈文件为 run 根目录 `solution-array-feedback.txt`：仅澄清每个任务的三个数组必须存在、当前无完成证据应为空数组，由真实模型修正并接受原检查。它针对已定位的插件契约表达缺口，不覆盖 `resume-02` 的失败、不改变已接受基线与定义、不修改冻结作者源或检查器，也不延长单次截止。运行尚未完成，不增加通过统计。

`output/lean-live-20261031/run-PnlVpg/resume-02/evidence.json` 最终 `passed=false`、`LIVE_solution_failed`，进程 exit 1。这是实际业务规则拒绝，未超时；该失败保留，不由后续尝试覆盖。基线与修复后的定义均已真实检查并推进，原定义失败操作仍保留；代码与交付阶段没有开始，因此完整五阶段验收未通过。

方案经四条真实对话审阅反馈，模型自行修正任务划分、错误类型约定、设计编号、普通对象校验、验收正例和文档大小；模型提议改写 helper 判定及虚报 HTTP 标记的两条命令被逐项拒绝。最终设计为 19,244 字节，包含一个生产任务、14 条需求及 34 个场景；这些人工复核不等于 Host 规则通过或无人干预一次成功。原 `solution.verify` 公开诊断报 `invalid_plan_json`，显示 T001 缺少 `blockers`、`completionEvidenceIds`、`evidenceIds` 三个必需字符串数组；检查摘要标记为截断，不能由此断言其余所有规则均通过。 插件契约的任务字段清单未明确列出两个证据数组，只写“证据数组初始空、blockers如实”，对必需字段与可空数组的表达不足；因此本次结果同时暴露插件作者契约提示欠明确，不能仅归因于模型遗漏。

原生审批第 4 项实际执行的请求摘要为 `9b3e3c50fe333ec162738add6e0931c1d71602895cfc341f34bba365749f7348`，绑定真实产物后由原检查器拒绝。最终 `Solution.json` 为 39,202 字节、SHA256 `17bf924e91f7564294f1527cb536031cae5606c792eccd1b95a5a57055bc9801`。详情在同尝试目录的 `solution-current.json`、`solution-independent-review.json` 及四份 `solution-*-feedback.json`；原生请求与决定在 run 根目录 `native-dialog-reviews/4.*.json`。完整作者源仍为 `b3b9a0df1708b48a8675e1f459e4963aa9f3e224c49d66a74006b398fd129a8c`，应用仍为固定 `5907d4…`，未修改业务检查或手写模型产物。

后续改进应留在插件作者契约与提示中：明确列出任务级必需数组及空数组的含义，区分生产任务与独立测试，说明 D-NNN 决策和 HTTP/SQL 编号的适用范围，并引导在阶段结束前使用已有 `solution.inspect` 自检。此处是插件源码下一轮建议：补精确必填字段及最小合法样例，并增加契约与原检查器的一致性回归。当前冻结源码不变；本轮仅通过公开反馈让模型修复产物，没有由验收者代写字段、降低检查或增加平台 AutoBiz 特例。


第三次尝试 `resume-03` 仅由模型补齐三个空数组，原设计与业务要求未变；真实检查再次失败，完整原结果见 `resume-03/solution-original-check-output.json`。24 条错误均源于 T001 的 12 项 `Design: ...` 描述式引用，分别被两个校验器报告 `invalid_artifact_ref_format` / `invalid_artifact_ref`，无其他错误类型。契约“designRefs 从实际决策/章节取得”没有说明格式，并与原规则只允许 `design.md#API-NNN` / `design.md#DATA-NNN` / `design.md#D-NNN` 不一致；当前无 HTTP/SQL，只能使用现有真实 D 决策锚点。这也是插件作者文档问题，下一轮应补精确格式及正负例一致性回归，平台不加特例。

经完整错误核对后，启动最后允许的同项目 `resume-04`，反馈在 `solution-reference-feedback.txt`：模型只修实际 D-001 至 D-007 的路径锚点，保留设计、锁、上游、需求与检查，继续真实运行。既定四次总尝试上限及单次截止不变，不增加通过统计。

`resume-04` 的方案原 `solution.business` 检查已通过；两位独立审阅者核对真实成果后，精确接受该版本并推进代码阶段。`Solution.json` SHA-256 为 `8843e333656c9b0ee2f67a41995362abb5da03008334828082c431c72bdeca02`，原文设计摘要与已接受上游不变。人工审阅及原检查回执保存在 `resume-04/solution-independent-review.json` 与 `solution-root-independent-review.json`。这是带真实反馈重试的阶段通过，尚非完整五阶段成功。

最终 `resume-04/evidence.json` 为 `passed=false`、`LIVE_code_failed`，进程 exit 1。原工作流 `wf_36c9bb89fd9e` 使用固定完整脚本 SHA-256 `7081a7370f5decffd9575f5b8ba810cfcd3abd5ec977f3fd85026149b47482fa` 启动，原 `solution.inspect` 与 `test.contract` 成功；实现子代理已写本地源码，但原生 Git 提交失败 `Author identity unknown`。根因是验收脚本只在初始化提交时使用临时 `git -c` 身份，隔离仓库未持久设置 local 身份。这不是业务检查通过或业务实现结论：尚未实际编译、独立测试、合并或交付。工作树真实状态为 unknown/recoverable 且 dirty，原错误完整保留于 `resume-04/code-independent-diagnostic.json`，未重放，也未增加四次总尝试上限。新测试夹具已改为仅设置本隔离仓库的固定 local 测试身份，真实独立工作树提交回归通过；不改用户全局 Git 身份或当前失败运行。

调用方式还暴露一处插件说明不足：直接把工作区外包路径传入 workflow.scriptPath 被原安全边界拒绝。模型后续通过逐字 inline 原文实际启动；第一次转录改变空白被审阅拒绝，原摘要检查未放宽。合法替代是受审逐字复制到工作区临时脚本、核对原摘要后使用 scriptPath。此项属于插件调用说明澄清，无需平台特例。

## 5 项失败修复

- 快照引用审计 2 项：Host 新增 `host_branch_inputs` 表未登记在审计清单，当前合法数据库被 fail-closed 拒绝。补齐已知可选表的精确列和严格协议验证，保留未知表、非法字段、摘要及路径拒绝。旧数据库兼容。
- 派生来源 1 项：测试以并发 metadata 调用发生代替文件已经打开，导致时间顺序偶发不成立。增加真实 read-entered 屏障，继续验证最早 DFS 错误、在途句柄和最终关闭。生产读取逻辑未修改。
- SDK 示例 2 项：静态分析遗漏标准 `clock.after/every` 直接回调的 SDK 词法捕获。补齐通用 SDK 回调识别，仅接受已验证来源、直接匿名零参回调；不放行动态/optional 调用、方法转移、返回 SDK 或任意嵌套逃逸。示例没有专属豁免。

Node 22 定向结果：审计及派生 41 项、引用保留及阶段分支 42 项、SDK 分析及平台示例 158 项，共 241 项通过。两位 agent 已交叉审阅相关修复。全量测试另行记录，不能据此宣称全量通过。

## 实际模型记录（进行中）

使用本机配置模型 `claude`（配置模型名 `deepseek-v4-flash`），独立 Electron 数据目录及项目工作区，经真实服务请求；无预写模型输出。运行脚本中的确认由验收人员/脚本执行并保留记录，不冒充人工 UI 验收。

第一轮非 AutoBiz：`output/generic-project-creator-live-20261031/run-OJNAnd/evidence.json`。真实模型从零准备三阶段资料整理候选；替换中间阶段时多次保存消耗草稿修订预算，继而通过 `project_continue` 建立后继草稿。严格身份断言报 `GENERIC_PROJECT_DRAFT_REPLACED`，本轮不通过。外围阶段输出仍兼容，模型额外扩写交付正文并非用户要求。后续完善通用原子修改指引，再以同一标准重试，不增加预算或放宽检查。

AutoBiz 五阶段运行：`output/lean-live-20261030/run-m2IXbD/evidence.json`。该既有脚本仍使用历史日期命名的输出父目录；本次运行于 2026-10-31，独立 run 目录区分。初始构建 SHA256 为 `476289f9c9d3a156d83012645f742abc33ad9bc620c7d9b5a8ddac78fa1d6fd4`。尚在执行，不能标记验收通过。

第二轮非 AutoBiz：`output/generic-project-creator-atomic-live-20261031/run-4hA8sJ/evidence.json`。一次原子补丁保持同一草稿，真实编译及试用准备成功；但 `modules[1].id` 仍为 `review`，仅改标题及 Skill 路径为来源追溯复核。运行阶段身份未按要求替换，严格断言失败，本轮不通过。第三轮仅将试验请求中的模块/阶段 ID 与保留的产物 ID 区分写明，保留相同断言。两轮完整失败证据均保留。

第二、三轮候选构建 SHA256 为 `5907d4e3729d8824f6a31edf7c7018fda59bc5e49663ae1055daf6fbf3aa8fff`，包含通用原子修改指引。该指引相关 24 项测试通过，Node/Web 完整类型检查通过。

第三轮 `output/generic-project-creator-explicit-live-20261031/run-xt00oG` 已通过从零创作、同草稿替换、外围模块和正文保留及新检查断言，进入真实试用。第二阶段模型要求执行 Python 读取两份产物自检，违反该场景明确的“不执行命令”约束；审查人员拒绝精确请求，记录 `LIVE_COMMAND_REVIEW_REJECTED`，本轮运行不通过。第四轮仅进一步解释 Host 自动执行 Schema 检查，模型无需启动进程辅助自检，不改变原验收条件。

AutoBiz 初轮最终为 `LIVE_baseline_unknown`。定位到测试脚本未处理 Function SDK `process.run` 的原生 `dialog.showMessageBox` 权限请求；仅轮询 sandbox 审批不足以覆盖此入口。进程始终为 `not_started/publication=blocked`，Flow 超时取消，没有实际业务检查成功。修复方向是验收脚本完整记录并逐项审核精确原生请求，不调整平台超时、不自动授予所有进程权限、不回写成功状态。

原生审批测试桥现已补齐精确请求、真实工作区、一次性审核和取消边界；4 项新回归与 19 项生产审批回归共 23 项通过，两位 agent 已交叉审阅。新 AutoBiz 五阶段运行：`output/lean-live-20261031/run-d8aNQy`，固定 `5907d4…` 构建并启用 UI journey。

AutoBiz Lean 原生派生及追加阶段候选通过：`output/creator-project-matrix-20261031/autobiz-derived/run-KM2JMc`。实际模型调用原生派生入口并生成新修订 r2→r7，五个原阶段、Skill、配置及依赖保留，追加 audit；原安装包摘要不变。20 次实际模型请求，其中错误参数/fixture 字段由 Host 拒绝后模型自行修正。证据为 `evidence.json` 与 `matrix-1-assembly.json`。此项仅为候选创作验收，未执行或保存六阶段派生插件，不等同于运行通过。

资料模板派生初轮完成三阶段试用，但保存前的作者聊天导航被弹窗遮挡；已修测试导航，保持产品和原验收不变。第二轮矩阵与第四轮资料整理运行中。

## 已完成的真实模型验收

- 非 AutoBiz 资料整理：`output/generic-project-creator-hostchecks-live-20261031/run-oGKIBt` 从零创建，r3→r5 在同一草稿替换中间模块为 trace-review，外围声明和正文保持；真实试用、保存及普通项目运行均完成。首次业务核对发现模型改写 reviewSummary，保留失败记录。随后真实模型仅修改 deliver 正文（r5→r7），声明、检查和其他 Skill 完全不变；重新试用、以独立标识保存新插件、普通项目三阶段运行完成，最终 `continuation-diagnostic-repair.json` 中 `runtime.verified=true`，无 fatal。`generic-project-business-runtime.json` 验证实际原生读取、来源 ID、逐字引文和上游摘要一致性，试用与普通项目各有独立证据。
- 新修订与旧安装插件重名时，使用交付卡“新插件标识”填写候选摘要后缀后保存，未覆盖旧插件。操作记录在 `delivery-name-collision-recovery.json`。验收 helper 也补齐同样的真实 UI 路径和碰撞回归；不是后台改安装记录。
- AutoBiz 从零小型研发需求准备：`output/creator-project-matrix-20261031/autobiz-from-zero/run-zGK7Sn`，模型从空模板创建 baseline/solution/delivery，再追加 audit；四阶段试用、保存和普通项目运行完成。它验证通用研发流程创作，不代表从零复刻完整 AutoBiz 编码交付能力。
- 资料模板派生：`output/creator-project-matrix-20261031/report-derived/run-ZIT9In`，第一代原生派生、追加 audit、试用、保存和普通项目三阶段运行全部完成；从该实际保存的新插件再次派生并追加 audit-again 的候选通过。二代的完整运行另行继续验收，不能用候选结果代替执行。

AutoBiz 完整五阶段新运行 `run-d8aNQy` 因截图采集超时结束（未到业务检查），记录保留。已恢复 public IPC 审批模式重新运行 `output/lean-live-20261031/run-pVraTO`；原生 SDK 进程请求仍逐项审核，不将截图失败标成业务通过。

## 补充检查：候选通过不等于配置可运行

`autobiz-derived/run-KM2JMc` 的初轮通用保留断言通过，但进一步读取真实作者源发现：知识提供器 `contextAction.config.stageTags` 只有旧五阶段，没有新增 audit。该插件的公开知识契约要求每个阶段有显式映射，因此这个六阶段候选尚不可认定可运行。最初测试要求“全部配置不变”过严，阻止了新增阶段必要的增量映射。后续验收请求调整为保留所有旧映射、提供器身份和旧阶段，同时由真实模型按插件契约补新阶段映射；不修改平台、不删除知识能力、不手工代写模型候选。

完整五阶段 `run-pVraTO` 已取得真实 baseline.business 通过回执，但成果批准请求携带了协议只允许拒绝时使用的 feedback 字段，被 Host 拒绝。已修正 test-only 调用并核对后续协议；新一轮为 `output/lean-live-20261031/run-zLrMba`。原生进程审批桥新增真实托管工作树归属校验，8 项正负例及既有 19 项进程审批、15 项 Host 反馈协议回归通过，生产权限不变。

## 最新结果

非 AutoBiz 两代完整端到端通过：`output/creator-project-matrix-20261031/report-derived/run-uj0liK/evidence.json`，进程 exit 0。第一代实际原生派生、追加 audit，试用 3/3 阶段完成，保存后普通项目 3/3 完成；第二作者线程从该真实保存插件 ID 再次原生派生，追加 audit-again，试用 4/4 完成，独立保存后普通项目 4/4 完成。两轮 `runtime.verified=true`，各自有独立 `evidence-matrix-N-runtime.json`，两份组装结果和两次完整运行是最终硬断言，不允许跳过第二代。

两代场景使用完整给定的非研发资料事实做短摘要及审计；此前较长场景中模型尝试未授权命令/越界搜索被拒绝，失败仍保留。中间还修正了测试脚本的跨代 UI handler 生命周期，相关回归验证移除、重挂和作者入口恢复。最终成功不等于任意模型/需求都能一次自主成功。

AutoBiz 基线提示词与契约已澄清 Host 提供的原始正文/项目身份、执行包装与后续反馈的区别，允许临时计算副本，禁止依赖应用内部日志和数据库。17 项插件回归通过，真实原始来源检查仍拒绝拼接包装或反馈后重算的自报摘要。固定材料测量更新为 34,195 字节，说明文档同步；平台没有新增专用来源接口。

更新后的完整作者 bundle digest 为 `b3b9a0df1708b48a8675e1f459e4963aa9f3e224c49d66a74006b398fd129a8c`；D 盘模板已同步，重新通过中文路径下的实际源集合读取。仅 composition/source.json 的锁摘要不足以识别 Skill 修改，因此新验收同时记录完整 bundle、逐文件及编译包摘要。最终新版完整运行：`output/lean-live-20261031/run-MgEG5u`，目前执行中。旧 `run-zLrMba` 经真实追加澄清后证明计算副本可行，但随后公开取消，仅作诊断证据，不算新版验收。

本轮 `npm test` 全量首跑仍在进行，已出现 3 个文件中 8 个超出默认 5 秒时限的用例；没有据此放宽时限。待资源释放后按原限制复查，最终结论另补，不能将首跑写为全绿。

## 模板交付

已准备 `D:\王博闻\AutoBiz-项目模式模板`，其中 `autobiz-lean` 包含 68 个原生作者源文件、源集合清单及三个提供器；另附先读我、通用说明、历史参考文档及 SHA256 文件摘要。原微信插件目录保持不变。

模板为受限五阶段研发脚手架，非旧插件全功能等价迁移。完整支持边界写入包内说明。当前版本仍为 2.0.0；此交付不含应用安装包，不执行推送或发布。

## 最终回归与静态验证（2026-10-31）

使用隔离的 Node v22.23.4，工作目录为 `C:\ai\CmbCoworkAgent-mods-v2`。本节只记录测试与静态检查，不代替上方尚未完成的完整 AutoBiz 真实模型验收。

- 全量首跑完整结束，耗时 5,848.11 秒：1,841 个文件中 1,818 通过、4 失败、19 跳过；19,036 项中 18,934 通过、10 失败、92 跳过。10 个失败均为默认 5 秒超时；另记录一个 Vitest worker `Timeout calling "onTaskUpdate"`，没有将其隐藏为通过。
- 待首跑结束后，对这 4 个完整文件串行复查，使用 `--maxWorkers=1 --no-file-parallelism`，未覆盖测试时限、修改断言或过滤掉同文件其他用例。136/136 项通过，耗时 254.51 秒，exit 0，无 unhandled/RPC 错误。文件为 `function-conversation-native-host.test.ts`、`composition-host-adapter.test.ts`、`native-shared-derived-config.integration.test.ts` 和 `project-creator-host-journey.test.ts`；其中两个原 harness-data 超时用例本次分别为 4,316 和 4,222 毫秒。
- 随后按 `package.json` 中 `test` 的原顺序，串行执行被 Vitest 失败短路的全部 18 个 `npm run` 脚本，18/18 exit 0。覆盖 adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1、Mods recovery/authoring/install/files/evaluation/skill-evaluation/ui-colors、project-entry 和 creator-flow；末组完整执行原有 19 个子套。阶段提示词浏览器证据为 `output/project-stage-prompts-browser/1793443793085`。
- 最终 `npm run typecheck` 完整执行 Node 与 Web TypeScript 项目，exit 0。对本轮改动及新增的 44 个 `src/`、`tests/` 源码/测试文件执行 ESLint，exit 0、0 error、1,967 warnings（1,964 条 `prettier/prettier`、3 条 `react-hooks/exhaustive-deps`）。只检查，未运行 format/fix，未清理告警来改变结果。

准确结论是“首跑保留超时与框架错误；原时限完整文件复查、全部 standalone 尾链及最终类型检查通过，lint 零错误”，不是“单次 `npm test` 全绿”。现有跳过项保持原状，复查结果也不证明首次超时的唯一成因。

本机证据索引：`%TEMP%/creator-next-validation-node22-summary.json`；首跑 `%TEMP%/creator-next-full-node22.log`；原时限复查 `%TEMP%/creator-next-timeout-recheck-node22.log`；18 个尾链脚本的顺序、起止时间、退出码及独立日志路径见 `%TEMP%/creator-next-standalone-node22-summary.json`。最终类型检查日志为 `%TEMP%/creator-next-final-typecheck-node22.log`，lint 文件清单为 `%TEMP%/creator-next-final-lint-files.json`，完整结果为 `%TEMP%/creator-next-final-lint-node22.json`。

## 真实验收发现后的插件契约补正

基础五阶段固定源 b3b9a0df… 的运行已结束后，发布两位 agent 通过的最小插件说明修复：明确任务 blockers/evidenceIds/completionEvidenceIds 为必填字符串数组、设计引用只允许真实 API/DATA/D 编号锚点、跨批整文件写入需唯一所有者（保留原同批及不重叠稳定符号规则），并补充 workflow 的逐字 inline 或授权复制后 workspace scriptPath 启动方式。原业务规则、权限与平台未放宽。Code 工作流首次外部路径被拒及一次 inline 转录字节不符均保留；随后真实提交的原文与固定脚本 25,312 字节完全一致才获准执行。

原生提交因隔离仓库没有持久 Git 身份失败，属于验收夹具初始化缺口。新增 test-only local Git 身份初始化，只能作用于已验证的隔离 run/workspace 仓库；真实关联工作树提交回归 1/1 通过、两位评审确认，不改全局或用户仓库身份。当前失败工作树保持 unknown/dirty，不重复执行。本包 README/先读我提示实际用户预先配置自己的 Git 提交身份。

补正后的 Solution 文档包含明确标注的格式示例。新回归实际调用打包的 Python 原检查器：合法任务通过，缺失/错误类型数组、章节/未知编号引用、跨批同文件写入共 13 个负例被拒；原合法同批和互不重叠 symbols 情况保留。发布到实际 resources 路径后的相关 3 文件 18 项回归通过，日志为 %TEMP%/creator-next-final-contract-tests.log。补充类型检查通过（%TEMP%/creator-next-contract-typecheck-node22.log），新回归文件 lint 零错误。

当前固定材料重新测量为 37,705 UTF-8 字节，相对旧样例 89,485 减少约 57.86%，范围内操作仍为 33 对 50。这里不含模型重试、工作流子代理和执行证据，不能据此声称总 token/费用同比下降；补齐必要契约比继续压缩字节优先。

D 盘 68 个作者源文件摘要已刷新，三个提供器摘要不变。当前作者源完整摘要为 6e8933e20020dadea4011f62714cb91283c6e180f0409805b1cb0417cbedec5f，实际读取中文路径源集合通过，且与仓库作者源相同。导入证据为 output/creator-contract-candidate/published-source-import.json 与交付目录的导入检查.json。这一新源码只具有上述回归/导入证据；进行中的派生运行继续使用其独立冻结源 9067032b…，不能把其结果归给新源码。


## 完整六阶段派生模板：本轮终态（2026-10-31 19:50）

`output/lean-derived-live-20261031/run-F1yB4v/resume-03/evidence.json` 最终为 `passed=false`、`LIVE_code_failed`，进程 session 41168 已 exit 1。此前基线、修复后的定义以及单任务方案均取得实际 Host 通过回执；方案 SHA-256 为 `65a4bae77aa023b07840c22635091662a4810f54dfa84c64b29c3897eb8d25f4`，独立原规则预检与正式 `solution.business` 检查均通过，再经人工语义复核精确接受。旧定义/方案失败及子代理 protection timeout 证据保留；该子代理超时后当前真实运行继续结算，没有修改数据库或伪造成功。

代码模型将原包工作流逐字复制到隔离工作区，经真实 SHA-256 与字节比较后通过公开入口启动 `wf_5ad5c3069cfa`。脚本为 25,312 字节，摘要 `7081a7370f5decffd9575f5b8ba810cfcd3abd5ec977f3fd85026149b47482fa`，提供器身份与冻结锁一致。Code 开始前已核对并仅补齐该隔离仓库的 local Git 测试身份，实际生产提交 `c9b851ff3c5f58830780ad099bdb1c551fac4c2b` 成功，工作树 clean；该提交不是编译或测试通过证据。

阻断发生在编译动作前置检查的人工审批等待期间：公开 `mods.jobs` 的动作 `fb50ceb0-61b8-4fd7-afc3-848832f5eab5` 从 19:45:33.455 至 19:47:33.492 共 120,037 毫秒，最终 unknown。调用链 `src/main/ipc/mods.ts:1784` → `src/main/mods/v2/platform-user-action.ts:18` → `src/main/mods/command-queue.ts:117` 使用原队列固定 120,000 毫秒总时限，包含这一动作内多次逐项审批等待。原生第 7/8/9 项从提案到决定约为 19.5/34.1/26.8 秒；第 10 项在 19:47:18.186 提案后仅 15.3 秒即被父动作取消，记录 `native-aborted`，工作流于 19:47:33.505 记为 error。上述间隔包含调度、人工/工具审阅和审批桥轮询；未单独持久记录审阅者首次打开请求的时刻，不能将全部间隔称为人工阅读时间。

第 10 项是原插件 `performance` 策略检查，尚未执行 `node --check`；验收者进行最终摘要文件核验时，原始请求文件已由生产取消路径清理，因此没有补录批准。冻结提案和取消决定仍在 `native-dialog-reviews/10.*.json`。这是运行时总时限与人工审批等待的边界，不是库存业务规则拒绝或 Node 编译失败。没有修改时限、自动放宽审批、重放 unknown 资源或继续新尝试。工作树保留为 unknown/recoverable。

通过公开 active-run 反馈要求如实结束后，Host 正常结算为 Code operation failed、`code.evidence` failed，终态码 `project_check_input_missing`；模型未生成虚假的 `Code.json`，交付与 audit 未开始。执行线程完成的 `terminal.outcome=success` 只说明线程正常返回，不能覆盖上述阶段失败。完整六阶段验收未通过。实际证据见该尝试目录 `independent-code-abort-audit.json`、`code-abort-public-jobs.json`、`code-abort-settlement-feedback.json`、`code-current.json`、`code-workflow-launch-review.json` 和 `independent-solution-acceptance.json`。

此运行始终使用完整作者源摘要 `9067032b7895e339eca7427855252da1faca861635ce404f7fa52e7ebb37ebe9` 与固定应用 `5907d4…`。后来发布的契约修订源码 `6e8933e2…` 具有独立回归和导入证据，不能继承本次旧冻结源的真实模型结果，也尚未完成完整端到端验收。后续若完善审批等待与执行时限的通用协调，应作为独立平台问题设计及回归；本轮不增加 AutoBiz 特例或复杂 unknown 恢复。

补充收尾检查：最终 Git 身份夹具修改后的完整 Node/Web 类型检查 exit 0，日志 %TEMP%/creator-next-final-fixture-typecheck-node22.log。契约与真实 Git 工作树提交两项回归再次通过；这四个补充源码/测试文件 ESLint exit 0、无告警。原全量首跑及其超时复查记录保持，不把后续定向结果拼成单次全量全绿。应用 package/lock 版本均为 2.0.0，固定主包 SHA256 仍为 5907d4e3729d8824f6a31edf7c7018fda59bc5e49663ae1055daf6fbf3aa8fff。
