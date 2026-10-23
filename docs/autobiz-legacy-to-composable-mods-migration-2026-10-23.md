# AutoBiz 原始插件向可组合 Mods 插件的迁移说明与文件清单

日期：2026-10-23。本文件记录原始插件到 r13 受审插件候选的逐文件变化、执行关系和验证范围。配套清单覆盖全部 259 个交付文件，包含用途、原始与目标大小、非敏感文件摘要及内核归属。

相关文档：[创造、修改与使用](mods-composable-workflow-creator-guide-2026-10-23.md)、[实现与联合验收记录](mods-composable-workflow-validation-2026-10-23.md)、[整体优化与后续边界](mods-plugin-project-systematic-optimization-analysis-2026-10-23.md)、[259 文件清单 CSV](autobiz-legacy-to-composable-mods-file-inventory-2026-10-23.csv)。

**发布状态：本地源码和插件候选已完成下述验收，新的 Windows 应用包尚未确认构建及包内验证成功。** 本文不代表新安装包已经可用。应用版本固定为 2.0.0，应使用提交、Actions 运行编号及文件摘要确认某个构建是否包含本轮改造。

## 1. 对照对象与结论

- 原始插件：`C:\ai\说明附件\附件\autobiz_kanban_workspace.zip`，原元数据名称`AutobizDevOps_Plugin_Kanban_latest`、版本`1.0.87`，实际 **234个文件**。
- 新版受审插件候选：`C:\ai\CmbCoworkAgent-mods-v2\output\deliveries\autobiz-requirements-composition-20261023-r13\revision-2\complete-plugin`，实际 **259个文件**，插件版本 **1.1.0**；DevClaw应用版本固定 **2.0.0**。
- 新版包摘要：`0af1b0492be9f9164b5ef48b32646048a2b3be3f59e971318fa3187ecf6807ea`。
- 插件候选ZIP SHA256：`35a4cd76deaa9e02313a3d35b4fc1c3ec647d3e4e4d9450e83fc6b8dcbbe0a45`。此摘要属于插件ZIP，不属于Windows安装包。
- 全部原文件路径均仍存在；**227个原文件已按字节确认不变，6个原文件修改，1个敏感配置只核对存在/大小，新增25个文件，排除0个原文件**。

| 目录分组 | 原文件数 | 新文件数 |
| --- | --- | --- |
| [root] | 4 | 9 |
| agents | 10 | 10 |
| board_core | 10 | 10 |
| hooks | 120 | 120 |
| mods | 0 | 19 |
| skills | 89 | 90 |
| workflows | 1 | 1 |

应用版本2.0.0、外部插件版本1.1.0、原作者元数据版本1.0.87以及受审baseline内核契约版本1.0.3属于不同对象，不可混为同一版本序列。其他中间版本未纳入本次逐文件比较，应依据对应来源摘要另行核对。

原包的`.mcp.json`按敏感连接配置处理：本次没有读取其正文或计算单独内容摘要；新旧均存在且大小均为200字节，因此只记录存在性及大小，不推断字节相等。配套CSV不包含连接地址、密码或配置正文。

### “189个原内核文件不变”的准确含义

`autobiz.original-234-kernel`是目录中沿用的内核标识，名称里的234不是当前锁定内核文件数量。r13组装锁实际钉住 **189个内核文件**。

此前r13完整验收已经确认这189个文件与本轮受审baseline一致；本报告重新核对其中 **188个非敏感文件**，1个`.mcp.json`不重新读取。**这个结论相对于r13的受审baseline，不等于相对于最初234文件压缩包完全未改。** 原压缩包到受审baseline已经包含下列4处Hook脚本修复；它们不能被描述成“原始234文件全部原样保留”。

本轮受审baseline摘要为`d11383b99b02b8fb2f945f1c0ec6e50e0d7592f1509802c2c63f88b92fa27ae2`。本报告不把内核189文件等同为完整插件259文件；模块Skill、模块参考资源、生成配置和新扩展也属于交付闭包。

## 2. 原文件中实际修改的6项

| 文件 | 具体变化 |
| --- | --- |
| plugin.json | 声明autobiz-converted-requirements/1.1.0、Mods入口、knowledgeRoot配置与两个辅助Skill根；原hooks、skills主目录和MCP入口保留。 |
| board_core/board_config.json | apiVersion从1升为2；重生成workflow，前插biz.convert、追加PRD归一化需求输入与lineage校验，并保留可选详细设计目录。其他六个顶层配置区块语义完全相同。 |
| hooks/evidence_integrity_gate.py | 为_check_completion显式传入feature_dir，保证Code完成证据在正确Feature目录核对；属于已有受审基线修复。 |
| hooks/parallel_batch_stage.py | isolated模式的repository_base证据绑定batch.startSha；原共享仓模式仍用headSha/baseSha，避免worktree批次起点与主仓HEAD混淆。 |
| hooks/parallel_evidence_aggregate.py | 聚合核对相同isolated起点；只有passed且无deferred问题时才投影finalVerification，失败时删除旧成功投影，防复用陈旧完成结果。 |
| hooks/plan_writer.py | 新增只读_verified_parallel_batch_merge；把Plan批次done投影绑定真实批次证据、merge train/promote回执及Git祖先关系，不仅相信task.status或调用者SHA；完成时间使用真实mergedAt。 |

四处Hook修复已经存在于r13的受审原业务基线中；新增需求步骤与状态Mod组装没有再次修改这四个脚本。它们属于原业务正确性修复，不是平台专门为AutoBiz增加的通用API。

## 3. 25个新增文件：用途及运行关系

| 新增文件 | 用途/实际调用关系 |
| --- | --- |
| devclaw.business-assembly.json | 完整组装锁：记录来源摘要、精确替换、步骤顺序、内核与全部资源闭包；安装/运行前核对真实来源，避免依赖丢失或跨版本错配。 |
| devclaw.capabilities.json | 原生项目能力目录：声明 project-flow、项目用途及必须保留的原 Hook 编号；用于平台准入与入口识别，不是运行结果。 |
| devclaw.portability.json | 可迁移性说明：声明运行时/Board版本、必需协议与需重新绑定的knowledgeRoot；明确不携带用户值、授权和运行状态。 |
| devclaw.project-runtime.json | 通用项目运行时契约：声明插件状态归属、阶段视图及知识上下文provider协议；当前保留legacy业务内核，原生runtime.actions/checks为空，不等于状态Mod未提供工具。 |
| devclaw.stage-checks.json | 原生阶段检查适配器声明：选择既有autobiz-v1兼容入口；不实现业务校验，不授予执行权限。 |
| mods/business/autobiz.knowledge/collector-THIRD-PARTY-NOTICES.md | 离线知识解析依赖的第三方许可及归属声明，随依赖交付，不是运行入口。 |
| mods/business/autobiz.knowledge/collector-gray-matter.cjs | 离线打包的gray-matter解析依赖；供原collect-knowledge.js按原语义处理知识元信息，避免会话读取时再安装npm依赖。 |
| mods/business/autobiz.knowledge/provider.py | 插件侧知识/上下文适配器：复用原agents_repo、render_session_context、render_collected_session_context和sync_agents，统一绑定宿主分配的知识/可变数据/运行配置目录；限制只读知识同步与采集预算，不改原脚本。 |
| mods/business/autobiz.knowledge/register.ts | 知识扩展的Function组件入口，不注册guest Hooks；实际知识和上下文由插件声明的provider执行，知识同步Skill也通过契约声明。 |
| mods/business/autobiz.knowledge/skills/knowledge-sync/SKILL.md | 知识同步操作说明Skill：指引使用受控provider和宿主分配目录；不是外部目录的任意写入授权。 |
| mods/business/autobiz.knowledge/validate-knowledge-draft.py | 知识草稿结构校验工具；在发布/同步前检查草稿及目标约束，不把草稿自动等同为有效业务知识。 |
| mods/business/autobiz.state-machine/adapter.py | 读取/预检/推进/只读对账的Python入口：检查规范双文件、实际源码策略摘要、工作区有效流程与原业务门禁，管理操作日志并调度持锁提交子进程；stdout保留结构化协议。 |
| mods/business/autobiz.state-machine/commit.py | 插件侧双文件提交器：保留Windows NTFS独占句柄、原prepare与序列化校验；准备/确认后复核契约与候选摘要，再写state.json和STATE.md，记录实际物理回执。 |
| mods/business/autobiz.state-machine/compiled_contract.py | 有效组合契约适配：调用原workflow compiler；校验可支持JSON Schema、加载声明的业务校验器、核对已提交上游文件及当前完整生产步骤契约，阻止换内容/换schema/降级复用旧证据。 |
| mods/business/autobiz.state-machine/graph.ts | 隔离JavaScript状态边判定：读取当前Feature有效allowedNext与workflow摘要，不固定阶段数量，不以提示词猜测合法跳转。 |
| mods/business/autobiz.state-machine/hook_checks.py | 显式业务门禁适配：调用相应原Hook规则，补齐SDK进程不会自动触发普通工具Hook时的只读候选digest核对；当前或目标已验证状态均核验，锁内不执行原回退副作用。 |
| mods/business/autobiz.state-machine/journal.py | 插件私有操作日志与只读恢复：绑定请求键、源码策略、真实文件结果与物理回执；unknown不得自动重放，不冒充平台批准或宿主权威状态。 |
| mods/business/autobiz.state-machine/register.ts | 真实可执行Function Mod入口：注册state_read/preflight/advance/reconcile工具与4个slash命令、PreSkillUse状态规则、受控process能力与设计确认，并识别拦截本插件明确的旧writer直接调用。 |
| mods/business/autobiz.state-machine/skills/state-control/SKILL.md | 状态工具使用说明：读取真实状态、预检、明确推进、只读对账及失败处理规则；不替代各原Skill的业务内容。 |
| mods/business/autobiz.state-machine/stage_checks.py | 围绕原postcheck采集实际产物证据：公共stage-check/v1保持6字段，摘要绑定完整raw node；strict衔接节点由真实检查结果派生，保存于提交器私有物理回执。 |
| mods/business/biz.convert/check.py | 新增需求转换步骤的插件业务校验器：实际读取NORMALIZED_REQUIREMENTS.json，核对feature与当前slug一致；内容结构/版本等由节点JSON Schema同时校验。 |
| mods/business/biz.prd/requirements_lineage.py | PRD衔接业务校验器：实际读取归一化需求和PRD，要求逐条原文及来源可追踪；附加于原ui_context_json等校验之后，漏需求/漏来源不能done。 |
| mods/business/manifest.json | 可组合业务目录：声明9个业务模块、2个常驻扩展、原内核、每步Skill、输入输出、schema、依赖、校验器及保留资源。组装器据此生成插件及有效board流程。 |
| mods/manifest.json | Function Mods入口目录：把知识扩展与状态扩展列为可选项目组件，引用各自register.ts，供已有隔离Mods加载器读取。 |
| skills/requirements-convert-v2/SKILL.md | 新增模型执行技能：从state_read有效契约读取schema，生成结构化需求并通过状态工具推进；这是运行用Skill提示词，不是测试helper，也不是独立确定性需求转换算法。 |

## 4. 配置、模板变量与知识上下文的保留机制

`board_core/board_config.json`只有`apiVersion`和`workflow`两个顶层字段发生变化。以下区块与原包解析后的结构和值完全相等：

| 原配置区块 | 对照结果 |
| --- | --- |
| agentsRepo | 完全相等 |
| knowledge_config | 完全相等 |
| artifact_sync | 完全相等 |
| supported_deploy_units | 完全相等 |
| inspectCommands | 完全相等 |
| checkpointSuffixState | 完全相等 |

原`inspectCommands`的darwin、linux、win32三组均保留12个入口：knowledge_path、project_status、feature_status、create_project、create_feature、system_prompt_inject、plugin_dir_hook、dialog_tips、dynamic_workflow、skip_node、pull_knowledge、session_context_inject；三组共36项，未用空命令替代。

原配置保留的模板占位符名称为：`feature`、`leanToken`、`nodeId`、`pluginPath`、`pluginWorkspace`、`projectCode`、`projectDir`、`projectDirs...`、`selectedDeployUnits`、`sessionWorkspacePath`、`workflowNodes`、`workflowTemplate`。这些是运行时模板变量，不是制作插件时已经写死的本机路径或凭据；仅比较占位符名称，不披露用户配置值。

实际链路分工如下：

1. 原`inspect_state.py`、`hooks/render_session_context.py`、`hooks/render_collected_session_context.py`、`hooks/collect-knowledge.js`、`hooks/sync_agents.py`继续承担原项目检查、提示词渲染、知识采集与同步语义，原文件按字节保留。
2. 新`devclaw.project-runtime.json.extensionContract.context`通过通用上下文协议声明`provider.py`，不是把所有知识硬编码到state Mod提示词。`autobiz.knowledge/register.ts`没有注册guest Hook，真实知识工作由provider和契约驱动。
3. 宿主解析本机`knowledgeRoot`、运行配置和插件私有数据根，再给provider传入受控的`DEVCLAW_PLUGIN_DATA_ROOT`、`DEVCLAW_KNOWLEDGE_ROOT`、`DEVCLAW_RUNTIME_CONFIG_PATH`等绑定。provider把原模块统一绑定到同一知识根和运行配置，避免新步骤用一套知识、原步骤用另一套。
4. 原安装源码保持只读；同步缓存、离线collector工具副本及运行配置写入宿主分配的数据目录。用户选择的已有知识目录按只读约束处理，不因为“同步”而清空外部目录。
5. 跨电脑安装需重新绑定本机知识目录、凭据和授权。`devclaw.portability.json`明确不导出用户配置值、grants或运行状态；保留变量表达式不代表自动携带另一台电脑的秘密或目录。

## 5. Skill、Hooks、workflow与状态写入器的职责

原包共23个`SKILL.md`；新版共26个，原Skill路径与内容全部保留，新增需求转换、知识同步、状态控制3个Skill。两个原空Skill文件也原样保留，只能认定为兼容占位，不能宣称它们具有完整能力。

原`hooks/`目录共120文件，新版仍为120文件；事件注册表`hooks/hooks.json`逐字节相同。保留注册表不代表每个状态动作会自动重放全部Hooks：普通工具调用按原事件/匹配器执行；SDK process调用的必要状态门禁由插件适配器显式复用。

原Code阶段`workflows/code-batched-execution.workflow.js`及worktree、batch、merge train、测试/证据脚本保留。状态Mod对原Python业务逻辑进行受控调度，继续使用原编译器、业务校验和写入器；尚未将全部执行逻辑改写为统一原生引擎。

状态推进原来由Skill通过CLI调用`hooks/update_checkpoint.py`等入口；现在推荐链路为：

`原业务Skill → state_read → state_preflight → state_advance → adapter.py → 原有效workflow compiler/产物与Hooks校验 → commit.py持锁准备及确认 → 原prepare_checkpoint_update及序列化语义 → state.json + STATE.md → 私有物理回执 → state_reconcile只读核对`。

原writer源码保留。state Mod在识别到本插件明确的旧writer直接工具调用时进行拦截并引导新工具；这不是对任意脚本和直接文件写入的绝对隔离。初始化和新建Feature仍走原`init_workspace.py`，它读取新生成workflow的起点，因此新Feature从需求转换开始。

新增主线是8步：`biz.convert → biz.prd → dev.specs → dev.design → dev.plan → dev.code → ops.cicd → ops.archive`。业务目录还包含`dev.detail_design`可选模块，实际是否启用由原有效流程编译规则决定；不是所有项目都固定为9步，更不是依旧固定七阶段。

## 6. 需求转换步骤的输入输出与校验契约

- `biz.convert`绑定真实运行Skill `requirements-convert-v2`，声明输出`NORMALIZED_REQUIREMENTS.json`、schemaVersion、JSON Schema及feature业务校验。
- `biz.prd`声明该文件为必需输入，依赖`biz.convert`，保留原`ui_context_json`等校验，再追加`requirements_lineage.py`。本示例要求PRD保留每条归一化需求原文及来源；漏项或缺来源不能done。
- 状态Mod按实际编译后的allowedNext选择相邻状态，缺产物、坏schema、上游文件被改、生产步骤契约被改均不应复用旧成功证据。
- 已发布严格衔接的节点不能通过删除schema/validatorBindings或同时改checkpointPrefix降级；公共阶段回执仍保持6字段，历史strict标识位于插件私有物理回执并与实际stageChecks绑定。
- 这组断言验证具体输入输出与业务契约。需求的业务完整性、方案质量和实际收益仍需对应的验收标准、评测及业务审阅。

## 7. 交付实现与测试辅助文件

下列文件位于工程测试目录，**没有进入259文件交付插件**：

- `tests/support/autobiz-composable-fixture.ts`：受控作者/组装验收fixture，不是终端插件依赖。
- `tests/support/autobiz-composable-prd-sample.py`：测试中生成完整样例PRD的helper，不是插件自动生成PRD的运行实现。
- `src/main/mods/v2/autobiz-composable-state.integration.test.ts`：真实guest/原内核集成验收脚本，不会随插件安装。
- `tests/support/autobiz-upstream-contract.py`及对应Vitest：边界与跨语言公共回执校验，不是插件运行文件。

实际进入交付的是上文25个新增文件，包括`requirements_lineage.py`与转换Skill；文件清单中不存在`tests/`或`src/main/`目录。r13回执标明`controlledAuthor=true`、`remoteModelVerified=false`：已验证受控候选的真实本地执行、校验、知识上下文与状态提交，尚未验证任意远程模型能够独立完成全部创作工作。

## 8. 本地执行验收、模型质量与应用包状态

r13两候选真实SDK集测2/2通过。需求转换修改版的专项主流程包含50次实际process调用、20项检查，另有19次动态工作区Schema变更及重新打开会话检查；这份专项回执的终点是`specs_in_progress`。

在此之外，已分别执行两套完整本地业务旅程：

| 候选 | 实际执行范围 | 本地结果 |
| --- | --- | --- |
| 基础版1.1.0 | 原需求、规格、设计、计划、代码、集成及归档链路 | `archived`；102次状态Mod进程调用；真实代码集成成功 |
| 需求转换版1.1.0 | 需求转换及全部保留的原业务链路，使用修改后的`requirements-convert-v2` | `archived`；120次状态Mod进程调用；真实代码集成成功 |

完整旅程执行原Python脚本、原Hook runner、业务校验、真实本地Git工作树及本地构建测试。原Hook runner的兼容探测由测试显式调用，因此完整旅程通过并不意味着SDK进程会自动重放全部普通工具Hooks。完整记录及来源摘要见[实现与联合验收记录](mods-composable-workflow-validation-2026-10-23.md)；本地机器汇总保留在`output/workflow-composition-full-journeys.json`。

这些测试控制业务样例、模型响应与外部应用元数据，证明本地执行和契约边界的正确性。远程LLM创作质量、企业知识库真实连接、用户电脑环境以及实际业务效果仍需分别验收。

本地验收与应用安装包交付是不同结论。本文定稿时，新的Windows应用包尚未确认构建及包内验证成功；插件候选摘要和ZIP摘要不能作为Windows应用包已发布的证据。相同2.0.0版本号的历史构建也不必然包含本轮改造。

新增严格跨步骤认证当前限不超过256KiB的普通文件/结构化JSON；目录、大产物、任意历史流程迁移不在本轮认证范围。双文件持锁提交实现针对Windows本地NTFS；不据此宣称其他平台具有同等写入保证。

## 9. 原234文件逐项状态与职责

| 原文件路径 | 新版状态 | 职责 |
| --- | --- | --- |
| .mcp.json | 保留（敏感正文未比对） | 原MCP连接配置入口；按敏感连接配置处理，本报告只记录存在性/大小，不读取正文、连接地址或凭据。 |
| agents/analyst.md | 保留（字节一致） | 原子agent角色定义：analyst；被原流程或节点agent声明引用。 |
| agents/critic.md | 保留（字节一致） | 原子agent角色定义：critic；被原流程或节点agent声明引用。 |
| agents/critic_autodev_design_zh.md | 保留（字节一致） | 原子agent角色定义：critic_autodev_design_zh；被原流程或节点agent声明引用。 |
| agents/critic_autodev_plan_zh.md | 保留（字节一致） | 原子agent角色定义：critic_autodev_plan_zh；被原流程或节点agent声明引用。 |
| agents/critic_autodev_zh.md | 保留（字节一致） | 原子agent角色定义：critic_autodev_zh；被原流程或节点agent声明引用。 |
| agents/explore.md | 保留（字节一致） | 原子agent角色定义：explore；被原流程或节点agent声明引用。 |
| agents/explore_spec.md | 保留（字节一致） | 原子agent角色定义：explore_spec；被原流程或节点agent声明引用。 |
| agents/reviewer.md | 保留（字节一致） | 原子agent角色定义：reviewer；被原流程或节点agent声明引用。 |
| agents/test-engineer.md | 保留（字节一致） | 原子agent角色定义：test-engineer；被原流程或节点agent声明引用。 |
| agents/verification.md | 保留（字节一致） | 原子agent角色定义：verification；被原流程或节点agent声明引用。 |
| board_core/__init__.py | 保留（字节一致） | 原Python业务模块：board_core — AutoBizDevOps shared core logic. |
| board_core/artifact_paths.py | 保留（字节一致） | 原Python业务模块：Filesystem helpers for workflow artifact paths. |
| board_core/artifacts.py | 保留（字节一致） | 原Python业务模块：Artifact scanning — check file existence per node. |
| board_core/board_config.json | 修改 | 原项目配置与生成后的有效流程：保留配置/知识/命令模板，更新API2及组合后的workflow。 |
| board_core/contracts.py | 保留（字节一致） | 原Python业务模块：Workflow contract helpers backed by effective workflow config. |
| board_core/state.py | 保留（字节一致） | 原Python业务模块：State loading + feature directory lookup. |
| board_core/state_store.py | 保留（字节一致） | 原Python业务模块：JSON-backed state store with STATE.md as a generated view. |
| board_core/workflow.py | 保留（字节一致） | 原Python业务模块：Workflow node resolution — checkpoint→node mapping, status derivation. |
| board_core/workflow_closure.py | 保留（字节一致） | 原Python业务模块：Dependency closure solver for custom workflow node selections. |
| board_core/workflow_compiler.py | 保留（字节一致） | 原Python业务模块：Effective workflow compiler for base config plus profile overlays. |
| hooks/agents_repo.py | 保留（字节一致） | 原Python业务模块：Shared helpers for the agents knowledge-base repo (deploy units + AGENTS.md). |
| hooks/artifact_ref_validator.py | 保留（字节一致） | 原Python业务模块：Validate immutable Design -> Plan references early in the draft phase. |
| hooks/augment_explore_task_prompt.py | 保留（字节一致） | 原Python业务模块：PreToolUse(task) hook: augment Explore-autodev task prompts. |
| hooks/augment_test_engineer_task_prompt.py | 保留（字节一致） | 原Python业务模块：PreToolUse(task) hook: constrain post-implementation UTest assignments. |
| hooks/batch_lease_manager.py | 保留（字节一致） | 原Python业务模块：CLI façade for durable parallel batch leases. |
| hooks/batch_merger.py | 保留（字节一致） | 原Python业务模块：Deterministic, guarded merging of parallel Code batch worktrees. |
| hooks/blocker_registry.py | 保留（字节一致） | 原Python业务模块：阻断规则的举证登记表。 |
| hooks/candidate_digest.py | 保留（字节一致） | 原Python业务模块：Compute the code candidate digest bound to verification decisions. |
| hooks/candidate_manager.py | 保留（字节一致） | 原Python业务模块：CLI for resolving and managing conflicted merge candidates. |
| hooks/check-secrets-new.py | 保留（字节一致） | 原Hook/业务支持模块：check-secrets-new；由原事件注册、CLI或其他业务脚本按条件调用。 |
| hooks/check_plugin_read.py | 保留（字节一致） | 原Python业务模块：Pre-tool guard that validates workspace init before reading plugin files. |
| hooks/check_skill_artifact_drift.py | 保留（字节一致） | 原Python业务模块：Check Autodev SKILL.md files for stale formal artifact gate references. |
| hooks/check_state_read.py | 保留（字节一致） | 原Python业务模块：Pre-tool guard that blocks direct reads of checkpoint state sources. |
| hooks/code_execution_guard.py | 保留（字节一致） | 原Python业务模块：Enforce Code production compilation and Batch UTest validation boundaries. |
| hooks/code_shell_analysis.py | 保留（字节一致） | 原Python业务模块：Static analysis of foreground build scripts; never evaluates shell code. |
| hooks/code_task_context.py | 保留（字节一致） | 原Python业务模块：Resolve a code task's plan/spec/design context from artifact workspace. |
| hooks/collect-knowledge.js | 保留（字节一致） | 原Hook/业务支持模块：collect-knowledge；由原事件注册、CLI或其他业务脚本按条件调用。 |
| hooks/commit_message.py | 保留（字节一致） | 原Python业务模块：Build production Git commit messages for an AutoBiz workflow run. |
| hooks/conflict_resolution_agent.py | 保留（字节一致） | 原Python业务模块：Intelligent conflict resolution using AI models to preserve both sides' logic. |
| hooks/conflict_types.py | 保留（字节一致） | 原Python业务模块：Type definitions for conflict resolution in optimistic parallel execution. |
| hooks/critic_review_log_writer.py | 保留（字节一致） | 原Python业务模块：PostToolUse(task): archive the raw review-agent response as an optional log. |
| hooks/design_contract_lock.py | 保留（字节一致） | 原Python业务模块：Design-owned immutable contract lock used by the Plan stage. |
| hooks/e2e_quality_check.py | 保留（字节一致） | 原Python业务模块：Deterministic Playwright false-green scan and attributed resolutions. |
| hooks/e2e_result_writer.py | 保留（字节一致） | 原Python业务模块：Incrementally write and mechanically finalize E2E_RESULT.json. |
| hooks/e2e_trust_common.py | 保留（字节一致） | 原Python业务模块：Shared E2E trust-gate hashing and validation helpers. |
| hooks/engineering_cache.py | 保留（字节一致） | 原Python业务模块：Short per-key claims for dependency inspection; producers run outside locks. |
| hooks/engineering_context.py | 保留（字节一致） | 原Python业务模块：Bound, demand-driven context for Code, Review, UTest and repairs. |
| hooks/engineering_contract.py | 保留（字节一致） | 原Python业务模块：Audit the actual agent, Workflow, policy and Runtime deployment together. |
| hooks/engineering_dependencies.py | 保留（字节一致） | 原Python业务模块：Shared, bounded dependency inspection for Code, UTest and repairs. |
| hooks/engineering_diagnostics.py | 保留（字节一致） | 原Python业务模块：Read-only engineering/dispatch diagnostics. Never prepare, schedule or migrate. |
| hooks/engineering_environment.py | 保留（字节一致） | 原Python业务模块：Content identities and structured outputs for shared read-only diagnostics. |
| hooks/engineering_facts.py | 保留（字节一致） | 原Python业务模块：Content-bound engineering facts shared by the worktrees of one Feature. |
| hooks/engineering_observability.py | 保留（字节一致） | 原Python业务模块：Bounded, sharded cache telemetry. No queries, claims, or business writes. |
| hooks/engineering_paths.py | 保留（字节一致） | 原Python业务模块：One path contract for native Batch roots and nested task/module directories. |
| hooks/evidence_audit.py | 保留（字节一致） | 原Python业务模块：Audit evidence artifacts and optionally reset untrusted completed tasks. |
| hooks/evidence_integrity_gate.py | 修改 | 原Python业务模块：Integrity and completion gates for Autodev evidence streams. |
| hooks/evidence_kernel.py | 保留（字节一致） | 原Python业务模块：Shared filesystem primitives for evidence artifacts. |
| hooks/evidence_store.py | 保留（字节一致） | 原Python业务模块：Append-only evidence stream helpers for Autodev feature runs. |
| hooks/frontend_route_write_guard.py | 保留（字节一致） | 原Python业务模块：Block business-code writes until task and route gates authorize them. |
| hooks/hooks.json | 保留（字节一致） | 原Hook事件/匹配器/命令注册表；保留普通工具生命周期、安全与产物校验入口，执行仍取决于真实事件和条件。 |
| hooks/human_gate_design_done.py | 保留（字节一致） | 原Python业务模块：Request a Human Gate before an Auto feature advances past technical design. |
| hooks/implementation_scope.py | 保留（字节一致） | 原Python业务模块：Read and write the Feature-level implementation scope contract. |
| hooks/init_validate.py | 保留（字节一致） | 原Python业务模块：Workspace 初始化前置校验脚本 |
| hooks/init_workspace.py | 保留（字节一致） | 原Python业务模块：autobizdevops Workspace 初始化脚本 |
| hooks/inspect_skill_contract.py | 保留（字节一致） | 原Python业务模块：Render a skill contract from board_config.json as Markdown. |
| hooks/inspect_test_environment.py | 保留（字节一致） | 原Python业务模块：Read-only inspection of supported UTest project environments. |
| hooks/inspect_workflow_templates.py | 保留（字节一致） | 原Python业务模块：Expose the workflow template + node catalog and closure solving for the UI. |
| hooks/json_writer_common.py | 保留（字节一致） | 原Python业务模块：Shared helpers for JSON artifact writer scripts. |
| hooks/merge_resolution.py | 保留（字节一致） | 原Python业务模块：Git identity and file scope shared by merge resolution and its write guard. |
| hooks/merge_resolution_context.py | 保留（字节一致） | 原Python业务模块：Prepare immutable, indexed reading material for a conflict editing agent. |
| hooks/package.json | 保留（字节一致） | 原Hook/业务支持模块：package；由原事件注册、CLI或其他业务脚本按条件调用。 |
| hooks/parallel_batch_dag.py | 保留（字节一致） | 原Python业务模块：Operator diagnostics for the staged parallel Batch DAG. |
| hooks/parallel_batch_lifecycle.py | 保留（字节一致） | 原Python业务模块：Lifecycle operations for durable parallel Code runs. |
| hooks/parallel_batch_scheduler.py | 保留（字节一致） | 原Python业务模块：Plan-aware scheduler commands for parallel Code batch runs. |
| hooks/parallel_batch_stage.py | 修改 | 原Python业务模块：Durable stage state machine for staged parallel Batch execution. |
| hooks/parallel_dispatch.py | 保留（字节一致） | 原Python业务模块：Durable lifecycle grants. A scheduler poll never creates a new generation. |
| hooks/parallel_evidence_aggregate.py | 修改 | 原Python业务模块：Read-only completion gate for the staged parallel pipeline. |
| hooks/parallel_failure.py | 保留（字节一致） | 原Python业务模块：Classify recovery preconditions without rewriting legacy artifacts. |
| hooks/parallel_failure_classifier.py | 保留（字节一致） | 原Python业务模块：Deterministic first-pass classification for staged Batch failures. |
| hooks/parallel_final_verify.py | 保留（字节一致） | 原Python业务模块：Compatibility-free name for the staged pipeline's evidence-only finalizer. |
| hooks/parallel_integration.py | 保留（字节一致） | 原Python业务模块：Feature integration worktrees and explicitly confirmed local promotion. |
| hooks/parallel_merge_train.py | 保留（字节一致） | 原Python业务模块：Build and promote immutable parallel Batch merge candidates. |
| hooks/parallel_repair.py | 保留（字节一致） | 原Python业务模块：Record Plan-approved, review-required repair Batch contracts. |
| hooks/parallel_runtime.py | 保留（字节一致） | 原Python业务模块：Durable runtime state for parallel Code batch execution. |
| hooks/parallel_validation_ownership.py | 保留（字节一致） | 原Python业务模块：Plan-owned validation ownership for the staged parallel workflow. |
| hooks/paths.py | 保留（字节一致） | 原Python业务模块：Path helpers for autobizdevops workspace bootstrap hooks. |
| hooks/performance_checker.py | 保留（字节一致） | 原Python业务模块：前端性能编码规范检测脚本（Hook 模式） |
| hooks/plan_granularity.py | 保留（字节一致） | 原Python业务模块：The one Plan-v2 guard that protects scenario coverage accounting. |
| hooks/plan_json.py | 保留（字节一致） | 原Python业务模块：Machine-readable plan helpers for Autodev. |
| hooks/plan_scope.py | 保留（字节一致） | 原Python业务模块：Resolve the slice of specs, Design and source requirements this round delivers. |
| hooks/plan_write_ownership.py | 保留（字节一致） | 原Python业务模块：Ownership helpers for plans that already have observed write paths. |
| hooks/plan_writer.py | 修改 | 原Python业务模块：Prepare a machine Plan v2 for review, then emit its Markdown projection. |
| hooks/query_json_fields.py | 保留（字节一致） | 原Python业务模块：Read selected fields from a JSON file without emitting the full document. |
| hooks/render_collected_session_context.py | 保留（字节一致） | 原Python业务模块：通过 collect-knowledge.js 恢复 session_context_inject JSON。 |
| hooks/render_frontend_test_reference.py | 保留（字节一致） | 原Python业务模块：Render bounded Vue3/React test guidance by framework and domain. |
| hooks/render_session_context.py | 保留（字节一致） | 原Python业务模块：session_context_inject 动态提示词注入（createFeature 选中部署单元 -> sessionContext）。 |
| hooks/render_spring_test_reference.py | 保留（字节一致） | 原Python业务模块：按测试域渲染 Spring Boot 2/3 单测参考。 |
| hooks/repository_snapshot.py | 保留（字节一致） | 原Python业务模块：Shared Git repository snapshot helpers. |
| hooks/resolve_frontend_html_route.py | 保留（字节一致） | 原Python业务模块：Resolve and record the required frontend HTML route for autodev-code. |
| hooks/resolve_next_skill.py | 保留（字节一致） | 原Python业务模块：Resolve the next workflow skill from the plugin-provided session context. |
| hooks/result_writer_common.py | 保留（字节一致） | 原Python业务模块：Shared helpers for result JSON writers. |
| hooks/rollback_stage.py | 保留（字节一致） | 原Python业务模块：Rollback a feature to a selected workflow stage state. |
| hooks/route_checkpoint.py | 保留（字节一致） | 原Python业务模块：Resolve the next action for a feature checkpoint from the effective workflow. |
| hooks/run_advisory_smoke.py | 保留（字节一致） | 原Python业务模块：Run advisory smoke tests and record non-blocking smoke evidence. |
| hooks/run_e2e_command.py | 保留（字节一致） | 原Python业务模块：Run one Playwright Test verdict command and commit auditable E2E facts. |
| hooks/run_utest_command.py | 保留（字节一致） | 原Python业务模块：Run or record one UTest command inside its assigned repository. |
| hooks/runtime_artifact_guard.py | 保留（字节一致） | 原Python业务模块：PreToolUse ownership guard for Runtime-owned Feature artifacts. |
| hooks/runtime_guidance.py | 保留（字节一致） | 原Python业务模块：Machine-readable CLI contracts generated from the actual argparse parsers. |
| hooks/skip_node.py | 保留（字节一致） | 原Python业务模块：UI 专用：以参数方式定位并跳过工作流节点（不依赖环境变量）。 |
| hooks/smoke_plan_writer.py | 保留（字节一致） | 原Python业务模块：Incrementally write SMOKE_TEST_PLAN.json. |
| hooks/source_context.py | 保留（字节一致） | 原Python业务模块：Read and validate the compact, PRD-owned external source context. |
| hooks/source_references.py | 保留（字节一致） | 原Python业务模块：Parse stable external-source references from a Feature PRD. |
| hooks/spec_contract.py | 保留（字节一致） | 原Python业务模块：Shared Specs heading grammar for Plan validation and Code context. |
| hooks/specs_hook_context.py | 保留（字节一致） | 原Python业务模块：Minimal environment and checkpoint routing for dev.specs hooks. |
| hooks/stage_gate.py | 保留（字节一致） | 原Python业务模块：Run the exact board_config artifact postcheck for a workflow node. |
| hooks/state_checkpoint.py | 保留（字节一致） | 原Python业务模块：Shared checkpoint parsing, transition, and guard helpers. |
| hooks/sync_agents.py | 保留（字节一致） | 原Python业务模块：拉取 agents 知识库仓库（UI 触发），产出 service units 供宿主合并进 board.json。 |
| hooks/task_run_integrity.py | 保留（字节一致） | 原Python业务模块：Stable integrity seal for immutable task-run baseline fields. |
| hooks/task_runner.py | 保留（字节一致） | 原Python业务模块：Transactional execution entrypoint for structured code tasks. |
| hooks/ui_context.py | 保留（字节一致） | 原Python业务模块：Helpers for the feature UI scope machine fact source. |
| hooks/ui_context_writer.py | 保留（字节一致） | 原Python业务模块：Incrementally write UI_CONTEXT.json. |
| hooks/unit_test_result_writer.py | 保留（字节一致） | 原Python业务模块：Write plan-bound UNIT_TEST_RESULT.json without caller-authored verdicts. |
| hooks/update_checkpoint.py | 保留（字节一致） | 原Python业务模块：Safely update one Feature checkpoint in .autobizdevops/state.json. |
| hooks/utest_assignment_router.py | 保留（字节一致） | 原Python业务模块：Build stable UTest assignments from root and Batch plans. |
| hooks/utest_blocked_writer.py | 保留（字节一致） | 原Python业务模块：Persist a plan-bound UTest blocked handoff from inspector facts. |
| hooks/utest_control.py | 保留（字节一致） | 原Python业务模块：Cooperative UTest stop requests; keep ownership until assets are sealed. |
| hooks/utest_deadline_guard.py | 保留（字节一致） | 原Python业务模块：Stop ordinary tools at the UTest deadline while permitting exact closure. |
| hooks/utest_plan_contract.py | 保留（字节一致） | 原Python业务模块：Authoritative plan contract shared by the UTest router, runner, and writer. |
| hooks/utest_policy.py | 保留（字节一致） | 原Python业务模块：One durable UTest policy shared by stages, scheduler, tools and Workflow. |
| hooks/utest_presets.py | 保留（字节一致） | 原Python业务模块：Finite, version-aware test choices. Plan V2 owns behavior, not tooling. |
| hooks/utest_runtime.py | 保留（字节一致） | 原Python业务模块：Bounded UTest preparation, test-only POM writes and durable execution plans. |
| hooks/utest_test_environment.py | 保留（字节一致） | 原Python业务模块：Semantic ownership of test-only Maven changes, shared by guard and sealer. |
| hooks/utest_workspace_binding.py | 保留（字节一致） | 原Python业务模块：Resolve trusted UTest workspaces from the current Plan contract. |
| hooks/validate_utest_source_bug.py | 保留（字节一致） | 原Python业务模块：Validate that a source_bug claim is anchored by current failing test evidence. |
| hooks/validation_policy.py | 保留（字节一致） | 原Python业务模块：Shared validation-command policy for plan, writer, and runner gates. |
| hooks/verified_digest_guard.py | 保留（字节一致） | 原Python业务模块：Invalidate a verified candidate when its code digest changes. |
| hooks/verify_decision_writer.py | 保留（字节一致） | 原Python业务模块：Incrementally write VERIFY_DECISION.json. |
| hooks/workflow_launcher.py | 保留（字节一致） | 原Python业务模块：Select the fixed, plan-aware Code batch workflow. |
| hooks/workflow_sandbox_contract.py | 保留（字节一致） | 原Python业务模块：Conservative publication checks for the fixed Workflow sandbox. |
| hooks/worktree_manager.py | 保留（字节一致） | 原Python业务模块：Lifecycle operations for plugin-owned native Git worktrees. |
| inspect_state.py | 保留（字节一致） | 原项目检查/看板与Feature有效流程读取入口，供原inspectCommands调用。 |
| plugin.json | 修改 | 插件安装元数据与入口：新版名称/版本、skills、hooks、MCP、Mods入口及可选knowledgeRoot配置声明。 |
| read_state_json.py | 保留（字节一致） | 原state.json只读查询辅助入口，仍供原流程/脚本复用。 |
| skills/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills；保留原业务说明及引用资源。 |
| skills/autobiz/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autobiz；保留原业务说明及引用资源。 |
| skills/autobiz/autobiz-requirement-discuss/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autobiz/autobiz-requirement-discuss；保留原业务说明及引用资源。 |
| skills/autobiz/autobiz-requirement-discuss/references/analysis-guide.md | 保留（字节一致） | 原技能参考/规范/许可资源：analysis-guide.md；按原Skill资源引用使用。 |
| skills/autobiz/autobiz-requirement-discuss/references/default-rules.md | 保留（字节一致） | 原技能参考/规范/许可资源：default-rules.md；按原Skill资源引用使用。 |
| skills/autobiz/autobiz-requirement-discuss/references/prd-formatter.md | 保留（字节一致） | 原技能参考/规范/许可资源：prd-formatter.md；按原Skill资源引用使用。 |
| skills/autobiz/autobiz-requirement-discuss/references/prd_module.md | 保留（字节一致） | 原技能参考/规范/许可资源：prd_module.md；按原Skill资源引用使用。 |
| skills/autobiz/autobiz-requirement-discuss/references/source-context.md | 保留（字节一致） | 原技能参考/规范/许可资源：source-context.md；按原Skill资源引用使用。 |
| skills/autobiz/hooks/biz_validate.py | 保留（字节一致） | 原Python业务模块：autobiz 统一校验脚本 |
| skills/autobiz/hooks/prd_rules.py | 保留（字节一致） | 原Python业务模块：正式 PRD 的结构规则与 Markdown 标题解析。 |
| skills/autobiz/references/ui-context.md | 保留（字节一致） | 原技能参考/规范/许可资源：ui-context.md；按原Skill资源引用使用。 |
| skills/autobizdevops-artifact-sync/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autobizdevops-artifact-sync；保留原业务说明及引用资源。 |
| skills/autobizdevops-artifact-sync/config/artifact-sync.json | 保留（字节一致） | 原插件支持资源：skills/autobizdevops-artifact-sync/config/artifact-sync.json；随原引用闭包保留。 |
| skills/autobizdevops-artifact-sync/references/feature-api-detail.md | 保留（字节一致） | 原技能参考/规范/许可资源：feature-api-detail.md；按原Skill资源引用使用。 |
| skills/autobizdevops-artifact-sync/references/sync-runtime.md | 保留（字节一致） | 原技能参考/规范/许可资源：sync-runtime.md；按原Skill资源引用使用。 |
| skills/autobizdevops-artifact-sync/scripts/artifact_sync_utils.py | 保留（字节一致） | 原Python业务模块：产物同步工具模块：配置、产物扫描、目录与状态管理，供 sync_artifacts.py 调用。 |
| skills/autobizdevops-artifact-sync/scripts/sync_artifacts.py | 保留（字节一致） | 原Python业务模块：Command-line entrypoint and HTTP transport for the artifact sync skill. |
| skills/autobizdevops-rollback/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autobizdevops-rollback；保留原业务说明及引用资源。 |
| skills/autobizdevops-rollback/agents/openai.yaml | 保留（字节一致） | 原插件支持资源：skills/autobizdevops-rollback/agents/openai.yaml；随原引用闭包保留。 |
| skills/autodev/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev；保留原业务说明及引用资源。 |
| skills/autodev/autodev-code/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-code；保留原业务说明及引用资源。 |
| skills/autodev/autodev-code/references/batch-workflow-guide.md | 保留（字节一致） | 原技能参考/规范/许可资源：batch-workflow-guide.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/references/assets-processing-guide.md | 保留（字节一致） | 原技能参考/规范/许可资源：assets-processing-guide.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/references/html-post-review.md | 保留（字节一致） | 原技能参考/规范/许可资源：html-post-review.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/scripts/html_static_checker.py | 保留（字节一致） | 原Python业务模块：Static HTML-result review checks for generated frontend code. |
| skills/autodev/autodev-code/references/frontend-html/scripts/review_runner.py | 保留（字节一致） | 原Python业务模块：Unified review runner for generated frontend code. |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-code/references/frontend-html/with-absolute-html；保留原业务说明及引用资源。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/component-slot-map.md | 保留（字节一致） | 原技能参考/规范/许可资源：component-slot-map.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/components-match-rules.md | 保留（字节一致） | 原技能参考/规范/许可资源：components-match-rules.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/html-parser.md | 保留（字节一致） | 原技能参考/规范/许可资源：html-parser.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/html-templates/llm-prompt-template.md | 保留（字节一致） | 原技能参考/规范/许可资源：llm-prompt-template.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/html-templates/pure-div-converter.md | 保留（字节一致） | 原技能参考/规范/许可资源：pure-div-converter.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/html-templates/pure-div-core.md | 保留（字节一致） | 原技能参考/规范/许可资源：pure-div-core.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/interaction-contracts.md | 保留（字节一致） | 原技能参考/规范/许可资源：interaction-contracts.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/references/page-archetypes.md | 保留（字节一致） | 原技能参考/规范/许可资源：page-archetypes.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/scripts/analyze_absolute_html.py | 保留（字节一致） | 原Python业务模块：Analyze large absolute-position HTML exports before LLM conversion. |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/scripts/prepare_html_analysis.py | 保留（字节一致） | 原Python业务模块：Run HTML analysis and write a compact Stage 1 handoff. |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/scripts/process_assets.py | 保留（字节一致） | 原Python业务模块：Process assets from high-fidelity HTML and generate mapping table. |
| skills/autodev/autodev-code/references/frontend-html/with-absolute-html/scripts/render_react_antd_preview.py | 保留（字节一致） | 原Python业务模块：Render a manifest-backed React + AntD CDN preview HTML. |
| skills/autodev/autodev-code/references/frontend-html/with-standard-html/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-code/references/frontend-html/with-standard-html；保留原业务说明及引用资源。 |
| skills/autodev/autodev-code/references/frontend-html/with-standard-html/references/ant-design-conversion.md | 保留（字节一致） | 原技能参考/规范/许可资源：ant-design-conversion.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-standard-html/references/standard-html-parser.md | 保留（字节一致） | 原技能参考/规范/许可资源：standard-html-parser.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-code/references/frontend-html/with-standard-html/scripts/audit_antd_coverage.py | 保留（字节一致） | 原Python业务模块：Audit React source for native UI controls that may need Ant Design conversion. |
| skills/autodev/autodev-design/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-design；保留原业务说明及引用资源。 |
| skills/autodev/autodev-design/templates/design.md | 保留（字节一致） | 原产物模板：design.md；供所属Skill生成对应产物。 |
| skills/autodev/autodev-detail-design/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-detail-design；保留原业务说明及引用资源。 |
| skills/autodev/autodev-detail-design/reference/template.md | 保留（字节一致） | 原产物模板：template.md；供所属Skill生成对应产物。 |
| skills/autodev/autodev-e2e/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-e2e；保留原业务说明及引用资源。 |
| skills/autodev/autodev-e2e/reference/e2e-quality-gate.md | 保留（字节一致） | 原技能参考/规范/许可资源：e2e-quality-gate.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-e2e/reference/test-playwright-script.md | 保留（字节一致） | 原技能参考/规范/许可资源：test-playwright-script.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-e2e/reference/testcase-generation.md | 保留（字节一致） | 原技能参考/规范/许可资源：testcase-generation.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-e2e/templates/smoke_test_plan.json | 保留（字节一致） | 原产物模板：smoke_test_plan.json；供所属Skill生成对应产物。 |
| skills/autodev/autodev-frontend/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-frontend；原文件为空，保持兼容占位，不宣称已实现该技能。 |
| skills/autodev/autodev-frontend/route/with-absolute-html/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-frontend/route/with-absolute-html；原文件为空，保持兼容占位，不宣称已实现该技能。 |
| skills/autodev/autodev-plan/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-plan；保留原业务说明及引用资源。 |
| skills/autodev/autodev-plan/references/task-planning.md | 保留（字节一致） | 原技能参考/规范/许可资源：task-planning.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-plan/templates/plan.md | 保留（字节一致） | 原产物模板：plan.md；供所属Skill生成对应产物。 |
| skills/autodev/autodev-plan/templates/task-groups.json | 保留（字节一致） | 原产物模板：task-groups.json；供所属Skill生成对应产物。 |
| skills/autodev/autodev-reviewer/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-reviewer；保留原业务说明及引用资源。 |
| skills/autodev/autodev-reviewer/references/schemas.md | 保留（字节一致） | 原技能参考/规范/许可资源：schemas.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-specs/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-specs；保留原业务说明及引用资源。 |
| skills/autodev/autodev-specs/templates/proposal.md | 保留（字节一致） | 原产物模板：proposal.md；供所属Skill生成对应产物。 |
| skills/autodev/autodev-specs/templates/spec.md | 保留（字节一致） | 原产物模板：spec.md；供所属Skill生成对应产物。 |
| skills/autodev/autodev-utest/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-utest；保留原业务说明及引用资源。 |
| skills/autodev/autodev-utest/reference/LICENSE.spring-testing-skills-Apache-2.0.txt | 保留（字节一致） | 原技能参考/规范/许可资源：LICENSE.spring-testing-skills-Apache-2.0.txt；按原Skill资源引用使用。 |
| skills/autodev/autodev-utest/reference/LICENSE.vuejs-ai-MIT.txt | 保留（字节一致） | 原技能参考/规范/许可资源：LICENSE.vuejs-ai-MIT.txt；按原Skill资源引用使用。 |
| skills/autodev/autodev-utest/reference/frontend-test-patterns.md | 保留（字节一致） | 原技能参考/规范/许可资源：frontend-test-patterns.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-utest/reference/legacy-static-test-patterns.md | 保留（字节一致） | 原技能参考/规范/许可资源：legacy-static-test-patterns.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-utest/reference/spring-test-patterns.md | 保留（字节一致） | 原技能参考/规范/许可资源：spring-test-patterns.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-utest/reference/test-engineer-task-protocol.md | 保留（字节一致） | 原技能参考/规范/许可资源：test-engineer-task-protocol.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-utest/reference/test-environment-profiles.md | 保留（字节一致） | 原技能参考/规范/许可资源：test-environment-profiles.md；按原Skill资源引用使用。 |
| skills/autodev/autodev-verify/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/autodev-verify；保留原业务说明及引用资源。 |
| skills/autodev/hooks/artifact_check.py | 保留（字节一致） | 原Python业务模块：Run Autodev artifact checks from board_config.json. |
| skills/autodev/hooks/common.py | 保留（字节一致） | 原Python业务模块：Shared helpers for Autodev board_config artifact checks. |
| skills/autodev/hooks/password-encrypt/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autodev/hooks/password-encrypt；保留原业务说明及引用资源。 |
| skills/autodev/hooks/password-encrypt/scripts/password-encrypt.py | 保留（字节一致） | 原Python业务模块：password-encrypt.py - 密码加密工具 |
| skills/autodev/hooks/password-encrypt/scripts/password-encrypt.sh | 保留（字节一致） | 原插件支持资源：skills/autodev/hooks/password-encrypt/scripts/password-encrypt.sh；随原引用闭包保留。 |
| skills/autodev/hooks/repair_registry.py | 保留（字节一致） | 原Python业务模块：产物契约预检的修复信息注册表。 |
| skills/autoops/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autoops；保留原业务说明及引用资源。 |
| skills/autoops/autoops-archive/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autoops/autoops-archive；保留原业务说明及引用资源。 |
| skills/autoops/autoops-cicd/SKILL.md | 保留（字节一致） | 原运行Skill/子技能规则：skills/autoops/autoops-cicd；保留原业务说明及引用资源。 |
| skills/autoops/autoops-cicd/hooks/poll_pipeline_status.py | 保留（字节一致） | 原Python业务模块：流水线构建状态轮询脚本 |
| skills/references/ask-user-question.md | 保留（字节一致） | 原技能参考/规范/许可资源：ask-user-question.md；按原Skill资源引用使用。 |
| skills/references/domain-context.md | 保留（字节一致） | 原技能参考/规范/许可资源：domain-context.md；按原Skill资源引用使用。 |
| skills/references/review-protocol-design.md | 保留（字节一致） | 原技能参考/规范/许可资源：review-protocol-design.md；按原Skill资源引用使用。 |
| skills/references/review-protocol-plan.md | 保留（字节一致） | 原技能参考/规范/许可资源：review-protocol-plan.md；按原Skill资源引用使用。 |
| skills/references/review-protocol-specs.md | 保留（字节一致） | 原技能参考/规范/许可资源：review-protocol-specs.md；按原Skill资源引用使用。 |
| skills/references/test-quality.md | 保留（字节一致） | 原技能参考/规范/许可资源：test-quality.md；按原Skill资源引用使用。 |
| skills/references/ui-continuation-guide.md | 保留（字节一致） | 原技能参考/规范/许可资源：ui-continuation-guide.md；按原Skill资源引用使用。 |
| workflows/code-batched-execution.workflow.js | 保留（字节一致） | 原Code阶段多worktree批次执行workflow；实现原并行调度与交付链，不由新增state Mod重写。 |

## 10. 文件清单的使用与复核

- [配套CSV文件](autobiz-legacy-to-composable-mods-file-inventory-2026-10-23.csv)为UTF-8 BOM编码，共259行文件记录，按路径排序。
- 每行提供`status`、`originalExists`、`targetExists`、原始与目标大小、非敏感文件SHA256、`inPinnedKernel`和`purpose`。筛选`修改`可查看6个变更文件，筛选`新增`可查看25个新增实现与声明文件。
- 敏感路径的原/新内容摘要为空，`sensitiveBodyNotRead=True`。该状态明确表示未读取正文，不能推断内容摘要相同。
- 本文第2节解释全部原文件修改，第3节解释全部新增文件，第9节列出原234文件的逐项状态和职责；文件安装、创造者操作与重新验证步骤见[创造、修改与使用](mods-composable-workflow-creator-guide-2026-10-23.md)。

文件数量不包含目录条目、测试工程源码、运行项目状态或宿主授权数据。可复核对象为第1节所列来源与候选摘要；后续更新插件时应重新生成对照，不沿用本次统计证明不同版本。
