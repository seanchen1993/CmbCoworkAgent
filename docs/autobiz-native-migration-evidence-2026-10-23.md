# AutoBiz 原生迁移证据与缺项（2026-10-23）

这是正在实施的迁移清单，不是完整 AutoBiz 替代版验收证明。仅记录已检查的实际源码与测试路径。

时点说明：以下各轮测试及发布状态保留原记录时点，不代表当前状态。后续正常开发构建、真实试用和修复进展以[2026 年 10 月 26 日动态验收报告](mods-native-runtime-real-validation-2026-10-26.md)为准；完整真实业务链路尚未验收通过。

2026-10-26 补充：通用失败阶段说明 `stageInstructions` 已通过官方 Node、Web 类型检查及正常构建。实际项目前三阶段已推进，Design 前两次明确检查失败；第三次通过真实界面提交并冻结 972 字符说明，模型已修订 Maven 测试方案，随后完成原生审批及两项原检查，经人工 approved 后 transitioned。Plan b068... 的 35,909 字节产物超过原 28,000 UTF-8 字节上限，在输入捕获边界停为 unknown、terminal=null，未进入业务检查或原生进程；不能记为业务检查失败或已恢复。历史操作与原检查不变；这不是完整业务流程、独立 HTTP 或安装包验收通过。具体运行和构建索引集中在上述动态报告，不与本文件的历史模型夹具证据合并。

当前实施进展（2026-10-26）：R4 集合已由 Creator 原生导入、安装授权并经 advance 编译（主包 0.1.6、规则 0.1.4、知识 0.1.0）。项目 abb70da0 的 Convert、PRD、Specs、Design、Plan 前五阶段均已由真实模型完成原 Python 检查及适用原生审批，并 transitioned。Plan 的 HTTP 402、验收引用格式失败及模型修正记录保留。Code 新操作在模型及 Flow 派发前因 Host workflow 动作作用域被普通会话门禁拒绝而成为 unknown；旧记录不改写、不强制重跑。

用户已允许用 Mock 替代模型及昂贵外部依赖来加快后续全流程验证；不再新建 R5 重跑真实前五阶段。增强后的混合回归已通过：1 文件 2 项，AutoBiz 八阶段 418.535 秒、独立供应商 10.565 秒，用例合计 429.102 秒、进程总耗时 455.22 秒（`final-hybrid-eight-stage.json/.log`）。实际阶段模式、provider selection、ClawStore、Guest、Python 检查、Host 状态、工作树、编译与 UT 沿原实现执行；模型作者和人工批准回调使用替身，线程 metadata 由测试映射提供。替身参与的环节必须单独标明，不能据此宣称全真实八阶段、真实外部发布或 HTTP 验收完成。通用修复与分轮结果见[动态验收报告](mods-native-runtime-real-validation-2026-10-26.md)。

2026-10-24 冻结源码后的完整仓库回归中，AutoBiz 八阶段已再次通过（480.135 秒），独立供应商流程通过（11.088 秒），多仓三项集成通过（合计 259.511 秒）。该次包含多仓增量、统一脚本报告校验及修复证据报告字段修正，原 600 秒时限未变。该次整仓回归另发现陈旧断言与测试工作进程通信超时，已分别修正断言并安排带来源诊断的最终复验；这些结果只代表相应业务集成用例，日志为 `output/native-final-full-regression.log`。

本轮新增通用修复只适配原 active/exact Host action scope 的 workflow 复制视图，不改持久 metadata 或普通会话准入；上下文派发标记移至 startSaved 紧前，派发前失败仍需原物理退休证明，派发后未知继续核对。scope 3 文件 36 项、dispatch 2 文件 94 项通过。原 native 12 文件 221 项运行出现 8 项失败，定位为一处测试 VM 漏注入 getThreadRuntimeScope；修正后对应整文件 87 项通过，不将分轮结果拼成全量全绿。

最终复验口径：Plan 原规则 23 个正负样本对应 4 项测试及官方 Node/Web 类型检查通过；364 个改动代码文件的 error 级 lint 为 0 错误（1 个固定原件依配置忽略），**全仓 lint 仍未通过**，未改动 76 文件的 169 条错误保留。正常构建通过；定向 Vitest 实际选中 147 文件、2,042 项，全部通过且运行期间源码摘要不变。16 组 npm 独立回归以分段方式覆盖完成：保留 workflow 首次失败，原前缀 14 条命令已通过，修正过时测试断言后从失败处起 18 条命令全部通过，后 9 组也全部退出 0；不是单次 npm test 全绿，不重跑完整 1,752 文件，各轮重叠结果不相加。最后仅追加两处测试修改，生产运行时未变，改动代码 error 级 lint 再次零错误；CI 尚未触发。当前附件收敛为 6 文件、原 11 文件完整备份保留；规范作者源为主包 0.1.4 / 规则 0.1.3 / 知识 0.1.0，区别于 R4 本机别名版本，应用仍为 2.0.0。详细范围及日志见[动态验收报告](mods-native-runtime-real-validation-2026-10-26.md)。

## D0：实际 Hook 入口逐条归属

知识选择与秘密扫描的等价测试已使用 `tests/fixtures/native-compositions/legacy-reference/` 中固定的原始规则，以及仓库已有且校验摘要的原解析器；不再依赖未跟踪的本地交付目录。2026-10-24 的知识与安全专项 15/15 通过。以下旧源路径是迁移溯源记录，不是这些测试的运行前提。

旧源：`output/deliveries/autobiz-requirements-composition-20261023-r13/revision-2/complete-plugin`。仅读取 hooks/hooks.json 与规则源码；未读取 MCP/凭据文件。

hooks/hooks.json SHA-256：`d6a8f46ca040528e76aa78262fba314b717cb6942ac5d6c745ba1f5985e5a21e`。

下表的“阻断/待迁移”指原插件全语义等价交付的验收缺项，不表示平台已经执行这些旧 Hook 后阻止当前任务。本文验证的是明确限制为 backend_only 的原生路径。时限与性能前置规则已补入本轮增量，并通过最终八阶段、Code 修复和多仓链复验，见文末 r3 证据；未实现部分仍逐项列示。

| 事件/匹配 | 实际入口 | 新归属/迁移状态 |
| --- | --- | --- |
| PreToolUse / * | `utest_deadline_guard.py` | 已接入原工作树持久预算：首次实际命令1800秒、每批UT总时限2700秒、单命令300秒；绑定原代次/操作/命令启动和终态回执，续接不重置时间。小测覆盖过期、冷恢复与迟到效果拒绝；r3 最终八阶段、真实 source_bug/test_bug 修复及多仓链通过。 |
| PreToolUse / task / Task | `augment_explore_task_prompt.py` | 部分：Code Skill明确规范和设计输入，但未迁移原探索证明与全文读取凭据。 |
| PreToolUse / task / Task | `augment_test_engineer_task_prompt.py` | 受限模式已接：独立test-author消费完整task/specs/design。原validate_source_bug闭包从原始失败receipt投影当前taskDigest/target/AC；source_bug/test_bug各至多一次、原命令复跑，未知/环境/契约失败不自动修复。跨模型硬截止使用同一原资源预算，不另建业务状态库。 |
| PreToolUse / write_file / edit_file / apply_patch | `state_checkpoint.py state-done` | 替换：外层阶段由Host操作与检查/成果审批拥有；旧state.json writer不执行。旧业务补充检查逐项按提取provenance核对。 |
| PreToolUse / write_file / edit_file / apply_patch | `state_checkpoint.py autodev-lifecycle` | 替换/部分：外层生命周期由Host拥有；Code批次资源由原workflow/ledger拥有；不是原所有业务检查已迁移。 |
| PreToolUse / write_file / edit_file / apply_patch | `frontend_route_write_guard.py` | 明确不支持：原生Code在实际执行前硬校验IMPLEMENTATION_SCOPE为backend_only；未声明/未授权仓库或非code任务拒绝。原frontend route探索/读取/写入权限链未宣称迁移。 |
| PreToolUse / write_file / edit_file / apply_patch | `check-secrets-new.py` | 已接：保留原check_line及依赖的匹配语义，仅移除stderr整行明文debug。Code capability声明requiredHooks，真实子agent/LocalSandbox的write/edit在执行前调用固定Python。缺Hook、崩溃、来源失效、无可扫描内容及patch表示均拒绝；错误不回显候选值。 |
| PreToolUse / read_file | `check_state_read.py` | 替换：Host只读取保留包与实际产物身份；不再要求先读取旧state.json。 |
| PreToolUse / execute | `code_execution_guard.py` | 受限模式已接：原生产compile argv分类闭包已提取；实现/测试作者使用保留profile硬限制为文件工具、无Shell，评审仅只读。生产编译/UT/E2E由真实process action执行并验证SHA/工作区；原全量调度字段未宣称等价。 |
| PreToolUse / execute | `runtime_artifact_guard.py` | 替换/部分：Host保留包/源码/产物身份及平台权限生效；旧Code内部产物写入所有权全量细则尚未等价迁移。 |
| PreToolUse / execute | `check_state_read.py` | 替换：Host只读取保留包与实际产物身份；不再要求先读取旧state.json。 |
| PreToolUse / execute | `human_gate_design_done.py` | 替换：Host对实际成功产物的resultApproval独立确认；不读取/写入旧approved字段。 |
| PreToolUse / execute | `performance_checker.py` | 已提取原7条规则并核对命中及例外；读取授权Git资源的实际JS/TS/Vue差异，按文件数/字节/HEAD限制扫描，只返回文件摘要、规则ID与行号。原规则15组正反例及真实Git/Python6项通过；真实Guest经受控命令调用实际扫描器的集成也已通过：违规代码阻止后续测试命令，合格代码完成扫描和测试，重放不重复进程。 |
| PostToolUse / task / Task | `critic_review_log_writer.py` | 部分：原workflow journal/子agent结果拥有评审事实，提交边界为原PlatformHub receipt；旧业务critic审计字段尚未完整映射。 |
| PostToolUse / write_file / edit_file / apply_patch | `verified_digest_guard.py` | 替换/部分：Host产物指纹和原生Git HEAD/sealed generation/CAS核对替代外层verified；复杂旧业务派生digest语义未全部导入。 |
| PostToolUse / execute | `verified_digest_guard.py` | 替换/部分：Host产物指纹和原生Git HEAD/sealed generation/CAS核对替代外层verified；复杂旧业务派生digest语义未全部导入。 |

## D1/D2：已运行的主链

需求转换、PRD、规格、设计确认、Plan均使用真实Host操作、真实Function Mod和固定源码Python规则。原始规则22个文件、330个符号的闭包摘要（包含新增性能规则13个符号）详见 `resources/native-compositions/autobiz-rules/checks/provenance.json`。原外层writer没有被调用。

`src/main/plugins/autobiz-native-host.integration.test.ts` 覆盖真实保存/编译/直接使用、前序bundle输入、PRD失败不推进、设计成果审批和供应商独立5步人审归档。模型文档和批准响应是确定性夹具，不是live模型或真实用户批准。真实convert等待→同operation/thread续接→业务检查仅一次及Plan后仅未来Code Skill迁移均在链内，旧operation事实逐字保留。

知识已复用原userConfig目录绑定及独立仅platform.read/act的知识Mod，真实Host材料接口提供相对路径只读list/read。selectedDeployUnits受配置Schema约束为JSON string；保留frontmatter deploy_unit、最近AGENTS边界、common Product Knowledge、Service和前后端Component/Reference选择。`autobiz-native-knowledge.test.ts`用同一虚拟资料集对照原collector结果；真实Guest上下文读取及首轮八阶段Host联合链已通过。新增必需Hook及source_bug真实修复后的完整八阶段已单独复验通过，详见文末最新证据。agentsRepo远程同步、appType远程元数据查询、leanToken沉淀动作未迁移；缺配置/资料/超限明确阻断。

## D3：Code实际已跑路径与限制

`src/main/plugins/autobiz-native-code.integration.test.ts` 使用保存的真实workflow、原引擎/ledger/FunctionMods/PlatformHub，实际创建隔离Git仓库，执行Maven生产编译、Java行为测试、封存、合并及合并后最终E2E一次，再从native.workflow.inspect核对原回执。只有模型作者和人工批准回调确定性；不冒充真实用户批准。

已实现每仓批次DAG串行、独立生产评审及一次评审修复、任务测试、实际提交diff的生产/测试写入分类、封存资源的原生合并审批、最终Code成果独立审批。只支持backend_only及executionMode=code；workspaceRef可为default或通过executionResources和用户配置明确绑定的仓库ID。未声明仓库在任何模型写入前拒绝。实现/测试作者通过保留profile限制文件工具，由原生Git服务commitChanges生成真实SHA，模型不能自报提交。

完整workflow journal重放已验证不重复模型、进程或合并批准；命名资源基于原ledger/实际HEAD身份核对。UT真实失败分支已独立通过：原生inspect读取未截断失败receipt，固定Python以当前计划运行原validate_source_bug，绑定taskDigest、target和验收条件；先只读诊断，再按source_bug/test_bug分别至多一次修改、同命令复跑。重复同类错误、非零退出证据缺失、超时/unknown、契约/环境/偶发/不确定诊断直接停止；不伪造成功。失败回执继续保留且Code检查核对整条修复链。每批最多三次实际测试（初次加两类各一次），这不是三次生产修复许可。多仓按依赖串行与同仓资源复用已接；待完成：插件的并行多工作树合并列车、完整frontend路线。不得把串行受限路径描述成原Code全语义。

## 原生插件实际文件用途与开发路径

| 文件/目录 | 作者应修改的内容 | 实际消费者 |
| --- | --- | --- |
| `resources/native-compositions/autobiz/composition/source.json` | 模块输入/输出、真实业务动作依赖、人工成果确认、配置和上下文声明 | 既有创造者 `project_compile` 的通用native compiler |
| `autobiz/modules/*/SKILL.md` | 模型执行业务任务的规则，直接读取前序bundle并写当前产物 | Host当前阶段Skill；业务检查仍独立运行 |
| `autobiz/workflows/native-code.workflow.js` | 插件自己的Code批次编排 | 原workflow engine、原PlatformHub回执与原Git ledger |
| `autobiz/agents/*` | 实现、只读评审、测试作者的保留profile | 原子agent工具allowlist与Shell硬门禁；提交归原Git服务 |
| `autobiz/devclaw.capabilities.json` / `hooks/*` | Code必需PreToolUse扫描器、固定Python规则与声明 | 原Host requiredHooks与真实LocalSandbox写入前链；不是可选Mod回调 |
| `autobiz/knowledge/*` | 可分发的业务方法、按阶段评审规范、配置迁移说明 | Host受控package materials；不是原组织知识的替身 |
| `autobiz-rules/mods/main.ts` / `code-result.ts` | 真实规则动作、原始workflow证据核对、受控实际命令调用 | 单独安装和授权的Function Mod |
| `autobiz-rules/checks/provenance.json` | 22个原始规则文件、330个符号的来源/提取摘要 | 回归逐字核对；不是新业务状态库 |
| `autobiz-rules/checks/ops.py` / `ops-provenance.json` | 发布准备与归档规则及旧Skill来源摘要 | 私有临时目录中的固定Python源码 |
| `autobiz-knowledge/mods/main.ts` / `selector.ts` | 当前阶段材料读取与部署单元知识筛选 | 独立仅platform.read/act授权、限定context作用域的JS Mod |
| `autobiz-knowledge/mods/frontmatter.cjs` / `provenance.json` | 原gray-matter解析器及禁用Node/执行入口的适配记录 | 纯JS解析；不执行资料中的指令 |
| `tests/support/extract-autobiz-native-rules.py` | 重新静态提取原只读规则并更新嵌入源码和Code脚本摘要 | 开发时使用；运行时不从旧插件加载writer |

修改规则Python或Code workflow后，需要同步更新实际参与提供器digest的嵌入源码，再跑编译/业务反例/真实Host集成。提取脚本用于维护原始规则闭包，依赖本地留存的已审阅旧交付包，并会重写提取目标；它不是随新插件运行的命令。修改原提取规则时应调整提取定义或显式适配，不能直接编辑提取目标后再运行脚本覆盖改动。新适配器可修改后重新嵌入，但不能只改可读源码而让实际执行常量保持旧版本。Code检查固定工作流摘要，不能编辑workflow后继续使用旧规则Mod。

资源目录交付的是可移植作者源，不是可跨机器直接运行的已锁定包。使用时先在目标机器安装并明确批准规则Mod和独立知识Mod，再通过project_actions取得该机器实际catalog，保存组合源并project_compile重新绑定。编译锁包含目标机器安装UUID/digest，不得把开发机锁文件当通用运行包。回归用另一组随机catalog安装ID重编，验证输出不存在旧提供器引用。编译输出的 `devclaw.project-runtime.json`、`devclaw.project-actions.lock.json`、`composition/lock.json` 由通用编译器生成，不作为另一个作者源手工改写。doctor/test输出明确区分契约测试与真正业务动作；前者不能当完整业务通过。

任务通过原配置入口绑定实际 `knowledgeRoot`，填写 `selectedDeployUnits`（既有string字段，知识Mod严格解析非空数组，每项只允许字符串deployUnitId和frontend/backend appType；无作者目录/凭据默认值）。组织资料缺失、未找到对应deploy_unit/最近AGENTS边界或读取超限均阻断，不能降级成仅公共方法成功。

人工确认包含设计/Code/发布准备成果接受，以及Code内部实际Git promotion审批；两类批准对象独立。发布准备只产出 `prepared-only` 文档；没有真实外部提供器和原始回执时，外部发布、unknown成功推断、知识沉淀都不能通过。归档结束由Host完成任务，不调用旧state writer或移动目录。

## D4/D5及用户交付

D4 对应计划演进和隔离调试：后续步骤迁移、已绑定只读检查及材料上下文的调试路径已有验证；AutoBiz 的 Python 进程动作不能据此通用恢复。D5 对应旧项目迁移：已接入目标插件快照内的声明式适配、原材料档案、检查点映射及原锁/Plan字节保留。新导入全部要求真实重验与新的人工确认；未完成验收不能通过分支或修改阶段ID绕过，验收后也不能将调试起点退回导入前缀。冻结记录保存完整方案，关闭或重启后可复核并继续同一目标；不会自动解冻。真实AutoBiz适配和Python设计/Plan检查已覆盖兼容成功与不兼容失败，不冒充在线模型完整迁移。

已加入AutoBiz CI/CD准备与归档声明和真实Python规则。CI/CD仅prepared-only模式，Code原始证据必须通过；外部发布或unknown声明明确拒绝。归档包含七个实际上游产物原文及SHA-256，篡改失败；不搬旧state目录，Host最终状态拥有任务完成。单独真实Code集成已验证这些动作，首轮同一八阶段Host联合2/2已通过（428.01秒，新增必需Hook前）；新Hook加真实UT修复的最终八阶段已通过（AutoBiz 482.319秒，独立供应商11.179秒）。外部流水线发布与知识沉淀没有已绑定提供器，不能将发布准备说成实际发布。已登记的旧AutoBiz文档稳定点通过适配器导入：convert/prd/specs真实重跑，design/plan保留旧字节再检查；旧审批不作为新批准。原始未登记插件没有可安全冻结的管理边界，不能仅扩一个包名就宣称支持直接导入。

创造者新增源码集合入口：选择含 `devclaw.source-set.json` 的作者目录，在同一准备卡逐项安装并通过原生权限界面授权规则 Mod 与知识 Mod，再核对权限、编译和安装衍生插件。仍可使用原作者工具手动完成上述流程。编译读取真实已授权 catalog，不猜安装 ID/digest、不复制同包绕身份；新插件名称与来源分离，原作者源保留。缺失或歧义返回依赖诊断；结果未知必须核对，不自动重装。安装后从原“开始使用”入口配置 knowledgeRoot 与 selectedDeployUnits 并试用。该增量的最终实测结果见文末，不将按钮存在当作完整交付成功。

在该轮记录核对时点，版本2.0.0未改；新方案功能改动尚未提交；仅已本地合并uat-without-mods（afa23c843），当时未构建、打包或推送。测试临时仓库的提交仅用于真实Git行为验证。

最新专项：源重绑/编译/创造者/安全规则与文件64/65边界共64项通过；两条真实UT修复集成通过（165.42秒）；真实子agent写入保护由runtime-parent-scope.integration.test.ts的16项回归覆盖。64文件上限保留单文件64KB和总256KB，不因原生模块资源增加而跳过检查。


合并UAT后的最终单仓基线：`autobiz-native-host.integration.test.ts` 2/2通过，AutoBiz 482.319秒（含postHook包、source_bug实际失败→原receipt证明→一次修复→同命令复跑），独立供应商11.179秒，总进程504.52秒。原600秒预算内完成；900秒只用于该次诊断，现已恢复600秒。日志：`output/autobiz-native-host-postmerge-posthook-r2.log`。convert原operation/thread输入等待续接、PRD失败不推进、Plan后future Skill迁移保留历史facts、设计/Code/发布准备独立成果审批、11次真实Python业务checks、18条原Flow运行及最终Host completed断言全部保留。Code阶段121.451秒；CI/CD准备89.222秒；归档90.791秒，后两阶段仍核对原Code回执和全部来源产物，没有跳过检查以缩短耗时。模型和人工批准回调仍为确定性夹具；实际子agent/LocalSandbox写入前Hook保护由独立16项回归证明，不冒称live模型端到端运行。

恢复来源核验：64个资源源码与stash逐字节一致，文本均为LF，46个来源/提取哈希和25个嵌入Python规则均匹配；固定workflow SHA为`40968e9408a684f227ea6e7b9f2fb7f8a269570e5b7e8a7bef4b6d9964fc4beb`。恢复后安全专项13/13通过，包含原secret谓词等价、write/edit阻断、普通内容及占位符放行、patch/畸形输入拒绝、原UT任务/验收契约反例。此为多仓扩展前冻结基线，后续改workflow或规则须更新摘要并另行验证。

D4范围：通用只读check与材料context的真实恢复链已有独立验证；本AutoBiz固定Python/process业务检查的调试恢复仍需相应adapter，不能宣称任意插件均可直接恢复。普通等待输入续接与计划迁移也不等同于任意已执行业务动作的调试重放。


多仓插件增量：`autobiz-variants/multirepo-source.json` 提供独立作者源变体；按同目录README替换完整autobiz副本的唯一composition/source.json，再经目标机真实catalog编译。默认单仓源没有新增第二仓必填项。多仓配置仍是既有required单目录userConfig，未新造配置或按模型路径授予权限。

`autobiz-native-multirepo.integration.test.ts`三项真实集成通过（274.947秒测试时间）：两仓跨依赖三批任务并复用首仓资源154.987秒、两仓无依赖任务隔离115.483秒、未绑定仓库在任何模型写入和promotion前拒绝4.475秒。实际每仓Maven生产编译、Java正常/失败路径测试、逐仓原生promotion审批路径、源分支最终E2E以及整条journal重放均执行；批准回调仍为确定性夹具。Code检查从原native.workflow.inspect核对每仓resource及verificationResource原回执。过程不代表并行调度；跨仓依赖不是跨仓读写授权，各仓分别提交不具备原子性，部分promotion后失败必须保留事实并对账，不能假称整体完成。

Code内部结果升级为`autobiz.native-code-result/v2`，按repositories列出每仓原resourceId/generation/candidate/integration与最终E2E回执。业务检查对计划workspaceRef、每仓任务覆盖、Host声明资源及原验证scope逐项核对；修复证据回到root读取Host计划，只从原失败receipt取得仓库身份并映射原UT validationLocations，跨仓不匹配拒绝。实际Code产物依旧只保存feature/runId选择，不能手写成功报告。


多仓最后复验：独立双仓用例增加把另一仓真实promoted SHA用于当前仓verificationResource的反例，必须在scope callback与实际进程启动前拒绝；115.930秒通过，正常每仓工作流、journal重放与原证据检查仍成功。日志：`output/autobiz-native-multirepo-cross-scope.log`。当轮多仓workflow固定摘要为`4d801aa848cb08b0b811e12ebc8d86fae4c8dbccd2e59ff7967352f43b4d722b`；25个嵌入Python规则与可读源码一致，21份提取来源/317符号摘要未改变，66个资源文本保持LF。此摘要属于时限和性能规则增量之前的历史验收，不能作为最终源码摘要。

报告退出状态收紧：普通业务阶段、Code的Plan回核、CI/CD、归档、命令策略和修复证明共用严格报告解析；非零退出却声称passed、缺少errors/warnings数组、畸形退出码一律拒绝。实际repair.py成功报告已补规范空数组；2026-10-24 00:00专项37/37通过（13项实际Python安全/修复，24项报告解析反例）。完整仓库回归由主线在源码冻结后统一执行，本文不把此前单仓482秒基线或多仓专项当作全仓最终通过。


测试可移植性修正（2026-10-24 00:18:40前）：移除Code fixture的开发机Maven绝对路径，通用测试resolver按AUTOBIZ_TEST_MAVEN→MAVEN_HOME/M2_HOME→PATH选择实际可执行入口，显式失效配置拒绝，不设本机fallback、不跳过或假编译。Windows/Unix路径、优先级、失效拒绝等9项focused通过，相关ESLint无错误；本机实际解析仍为原执行入口，因此当前主线全量的编译argv证据不变。README已列Python/Git/JDK17+/Maven及离线插件缓存前置。其余新增测试中的C盘路径为mock数据或路径规范化反例，没有第二处实际依赖开发机目录的执行入口。

最终资源静态复核（2026-10-24）：73个资源文件均无CRLF；22份提取记录、330个符号对应的44个来源及目标摘要匹配，27份嵌入Python与可读检查源码逐字一致。workflow SHA为`74d7bac54b5945ac0981ff13d9ba8c28724342b3e445a6ef14d0afb39c9ee523`；主包与独立D5适配描述逐字相同，SHA为`c43874589b034f4c0617561d8c1cc61500ded0ab40bf8b2d90eef47dfd770600`，单仓及多仓源均声明该资源。此项证明交付源码一致性，不替代执行测试。

性能检查实际调用专项：`autobiz-native-performance.integration.test.ts` 通过真实Guest、原受控命令提供器、实际Git和Python验证。违规JS代码在测试命令启动前失败；合格代码完成扫描及真实Python unittest；成功journal重放不重复进程，回执不包含源代码或URL。1项集成通过，测试耗时19.217秒。该验证不表示已实现完整前端Code流程。

## 最终联合回归记录（2026-10-24）

带来源诊断的完整 Vitest r3 运行覆盖 1728 个测试文件：1707 个文件、17421 项断言通过；19 个文件、92 项断言按既有条件跳过。2 个文件共 15 项失败，另有同一并发测试支架引起的 7 条未处理异常。本次没有再次出现此前的工作进程 RPC 通信超时。原始日志保留为 `output/native-final-full-regression-r3.log`，不能将该次命令标记为退出成功。

失败修复没有放宽生产准入或延长超时：阶段调试用例在第二次创建前正确结束首个开发租约，保留“只能从原基线迭代”的断言；并发测试的提取函数注入生产已使用的真实资源准入守卫。专项复验分别 1/1、14/14 通过，后者无未处理异常；对应日志为 `native-final-original-baseline-repair.log` 和 `native-final-runtime-concurrency-repair.log`。该阶段调试文件其余 26 项已在 r3 通过。

r3 的真实业务集成结果如下，模型回答和批准回调仍使用明确的确定性夹具：

| 路径 | 结果 | 实际测试耗时 |
| --- | --- | ---: |
| AutoBiz 八阶段 Host 与独立供应商 | 2/2 通过 | AutoBiz 455.225 秒；供应商 10.439 秒 |
| 多仓依赖、独立仓与未绑定仓拒绝 | 3/3 通过 | 258.721 秒 |
| Code 正常、source_bug、test_bug 修复 | 3/3 通过 | 218.891 秒 |
| 实际 Guest 性能规则调用 | 1/1 通过 | 19.597 秒 |
| 旧项目导入与恢复服务 | 27/27 通过 | 46.629 秒 |
| Host 服务及导入前缀准入 | 40/40 通过 | 44.277 秒 |

导入恢复还验证：只能从声明的重跑/重新检查入口推进，不能借通用 validate 绕过；未知结果核对在成功提交前再次检查原材料字节，修改后保持未知，恢复原字节后才可核对成功。失败、取消或真实重跑结果保留各自恢复路径。

源码集合交付增量已完成真实集成复验：`creator-source-set.integration.test.ts` 4/4 通过（12.463 秒测试时间），包括实际 AutoBiz 依赖安装与逐项授权、当前机器真实 catalog 编译、撤权拒绝、安装后开始使用，以及独立供应商的实际 React 卡片→原服务链。另覆盖结果未知对账、同名不同内容拒绝、源码变化和冷恢复；供应商用例验证未执行、只导出、已安装三种恢复结果，不重复安装。日志为 `output/native-final-source-set-integration-r3.log`。

实测修复了通用交付中的原生组合改名缺陷：仅改 plugin/runtime 会使作者源和生成锁不一致。现在先以真实 catalog 核对原候选，再调用原编译器生成新身份；新旧动作锁必须一致，额外资源保留，原 doctor/test/安装权限继续执行。新名称必须与来源不同，不覆盖原插件。接口、解析、浏览器状态、账号/会话迟到响应和错误说明共 73 项通过；原交付、对账与作者草稿持久化 37 项通过。测试证明安装与控制链，不代表安装后任意模型的业务成果必然合格。

旧“复制插件”入口同步采用同一原生组合重编译机制，并补齐创建、检查、修订与安装时的来源和授权复核。最终 4 文件 64/64 通过（`output/native-final-derivation-regression-r2.log`）：包含真实供应商副本、提供器身份变化拒绝、catalog 查询期间改文件/新增 Hook 注册/新增目录/排除项变化、安装前后来源变化及原生授权撤销。完整有界目录观测拒绝链接与文件身份变化；授权仅绑定动作锁实际引用的提供器，关闭无关 Mod 不使当前制作无故失败。独立只读复核未发现新增阻断。

最终源码集合再验 4/4 通过（`output/native-final-source-set-integration-r4.log`），包括补齐测试宿主类型后的完整路径。复制测试的 lint 修复后，17/17 再验通过（`output/native-final-derivation-native-r3.log`）。229 个变更 TypeScript/脚本文件分批 lint 发现的唯一错误为新增测试未使用参数，修正后该文件检查通过；其余批次零错误。分批检查仍报告 18959 条警告，主要为 Prettier 格式、换行及少量其他规则提示；本轮未全库格式化，不将其记为零警告。

独立脚本回归按 npm test 的 16 组执行；workflow 组的两处陈旧提取断言修复后，87 项单元检查及其余六个尾部脚本通过，其他脚本组通过。对应记录为 `output/native-standalone-results-a.json`、`output/native-standalone-results-b.json` 和 `output/native-sandbox-contract-r2.log`。Windows 当前权限不允许的符号链接用例按原条件显式跳过。未以提高业务超时或删除有效业务校验取得通过。

最后主进程类型检查通过（`output/native-final-typecheck-node-r10.log`），网页端类型检查通过（`output/native-final-typecheck-web-r7.log`）；最终差异格式检查退出 0。版本清单、锁文件根节点及根 package 均为 2.0.0，无未解决 Git 合并项，上线分支 `origin/uat-without-mods` 已是 HEAD 的祖先。在该轮记录核对时点，未构建应用或安装包、未推送、未触发 GitHub Actions。后续已进行正常开发构建；当前验收和交付状态见本文开头链接的动态验收报告。
