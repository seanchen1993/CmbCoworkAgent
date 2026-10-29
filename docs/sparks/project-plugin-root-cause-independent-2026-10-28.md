# 项目模式插件改造：独立根因审查（2026-10-28）

本报告由新建、无前序讨论历史的审查 agent 独立完成。先阅读本工作区的 `AGENTS.md`，再追踪生产代码；没有沿用其他诊断报告的结论。范围仅为 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`，应用版本 `2.0.0`。读取时 HEAD 为 `657606f9e464aaa3f64403fb0a571dcdf834b421`；工作区有大量尚未提交的在研修改，因此这里的行号指本次读取的工作区，不能用 HEAD 单独复现所有结论。只新增本报告，没有修改代码、启动 Electron、执行测试或构建。

## 直接结论与主责排序

**最主要的问题是平台与实施的契约闭环，而不是“Mods 天生不适合项目插件”。** 原插件的紧耦合增加了迁移成本，但不能解释为什么在已经原生化的项目后面追加一个独立 E2E 阶段，还要多轮补发现、依赖准备、源码修改、配置投影和后台结果续接。这些多数是平台应当一次提供、业务扩展反复使用的公共接线。

按对反复返工的解释力排序，不作没有数据依据的责任百分比：

1. **平台的公共能力曾经有零件、缺少经过真实创作流程检验的组合契约。** 进程、workflow、动作、配置、源码、权限分别存在，不等于创作者能完成“发现已有能力→准备依赖→原子修改项目→配置→执行→校验→推进”。曾需要模型自己跨命名空间取源码、转抄文件、识别不同 provider 身份、区分 config/input、猜怎样等待后台 workflow。当前补丁已经收敛了若干缺口，不能继续称它们“完全没有实现”，但真实创作的易用性尚未由静态接口存在来证明。
2. **实施与验收把几种不同目标叠加了。** 保留原 Python 插件语义、重设计 Host 原生业务流程、自然语言创作成功、安装后普通用户可用、真实业务内容合格，是不同的承诺。一个受控模型夹具可以验证运行链，却不能证明自由创作者能选对链；合同样例通过也不能证明业务动作已经执行。新场景才暴露平台缺口，于是每次局部修好后，下一个生命周期边界又失败。
3. **原 AutoBiz 插件确实是一个紧耦合的业务执行包，不是几份可任意重排的 Skill 文本。** 路由、record-specific 图、Python 校验器、状态写入、Hook、文件布局、知识选择、仓库配置相互引用。把它模块化必须显式化这些依赖；但这是移植性不足和迁移成本，并不等于原业务规则本身不合理。
4. **Mods 的适用范围需要限制。** 它适合业务校验、知识选择、独立测试适配器、可编程界面等业务扩展；权限、状态事务、审批、后台运行所有权、取消和证据来源属于原生平台。把这些宿主生命周期也交给 Mod 再实现一遍，才是过度 Mods 化。

因此应保留已形成的 Host 原生方向，收敛交付闭环与验收口径；不应因为尚未全链通过就再启动一轮状态机或插件框架重写。

## 真实链路和状态所有权

### 原插件路径：业务图与业务状态归插件

保留样本 `output/deliveries/autobiz-requirements-composition-20261023-r12/revision-2/baseline/complete-plugin/` 展示了原协议的实际组织方式：

- `skills/autobiz/SKILL.md:17-33` 要求每次读取实际 checkpoint，再运行 `resolve_next_skill.py`；静态提示不得覆盖 `board_config` 派生结果。`:48-54` 要求脚本校验，不能以 Markdown 勾选代替。
- `board_core/state_store.py:30-48` 从插件相对根加载 `board_config.json`，定义 `.autobizdevops/state.json` 和 `STATE.md`；`:118-129` 按 feature record 的 profile/template/decisions/skipped nodes 编译图。
- `board_core/state.py:26-51` 明确 JSON 是主状态，`STATE.md` 是生成视图；读接口仍可触发同步修复。这是一个权威状态加一个投影，不应数成两个状态机。
- `board_core/board_config.json:29-70` 同时保存三平台命令、路径变量替换、创建项目/特性、知识同步及 session context 注入；`:73` 后才是 workflow。它兼具产品接入协议与业务定义，不能只截取 `nodes` 就视为可移植模块。

这里读的是仓库内保留样本，不声称它等于未经任何处理的原始发布 ZIP；未在此次审查中重新校验外部上游仓库或全包来源摘要。以上观察另由当前生产适配器约束交叉验证：`src/main/plugins/business-mod-adapter-autobiz.ts:26-31` 明确 `mode=legacy/stateOwner=plugin`；`:54-90` 要求初次迁移保留完整节点、动态路由顺序和原配置，不仅保留字段子集。`src/main/plugins/autobiz-composition-protocol.ts:17-49` 校验实际 Python 资源集合与命令摘要，而不是相信一个“autobiz”名称。

### 兼容层：复杂，但不是任意新增的第二业务状态

`src/main/harness-board/project-runtime/composition-autobiz-bridge.ts:106-119` 调用原 `update_checkpoint.py` 的准备与业务后验检查；`:138` 后处理受控 transition。兼容流程必须知道原 checkpoint、完整资源闭包和旧 writer，不是通用 Host 项目可以推测的事实。

旧可选 AutoBiz 模块还保留 journal/CAS 提交协议，例如 `src/main/mods/v2/autobiz-state-commit.ts:48-82`。仅凭这些文件存在，不能断言一个当前 native 项目同时被三套 writer 修改；journal 在这里用来记录原 writer 的物理结果和未知态。是否能删掉这些兼容代码，需要使用方清单，不应为追求表面简洁直接删除。

### 原生路径：Host 唯一拥有阶段提交，已经存在

`src/main/plugins/native-composition.ts:327-335` 根据顺序和前序产物契约编译模块；`:405-431` 生成阶段 Skill 契约；`:435-439` 固定 `mode=host/stateOwner=host`。它不是把旧 `board_config` 的动态状态图直接装进新 runtime。

`src/main/harness-board/project-runtime/host-store.ts:596-650` 在事务中核对当前 operation、输入、审批、校验回执、成果审批，再以 version 条件更新 `stageIndex` 并记录唯一 transition 结果。`host-service.ts:1150-1182` 在提交前重新核验实际产物/动作证据及当前输入；重复 transition 返回已存结果，而不是重新执行。

普通入口也已分流：

- `src/main/ipc/project-runtime.ts:581-638` 只把 `mode=host` 的安装包列为原生项目模板，并检查真实安装身份、声明和源码。
- `src/main/harness-board/catalog-reader.ts:1164-1170` 对 Host 包不读取或广告旧 board 命令；`:1239-1247` 保留旧项目边界，不因同 id/name 出现 Host 模板就把旧项目升级为 Host。
- `src/main/harness-board/project-runtime/workspace-mode-guard.ts:13-46` 使用共享 SQLite mutex，在两个数据库间拒绝同工作区相反的 Host/Legacy 绑定。

**结论：本次没有发现“当前 native 项目缺乏唯一状态 owner”的证据。** 多代协议共存造成认知、入口、兼容测试与维护成本；现有代码已主动阻止它们在同一工作区混用。不能把这两件事混为一谈，也不该再建议新增一个“统一状态中心”来解决已经由 Host 拥有的状态。

## 为什么追加一个 E2E 阶段也反复出问题

对最终用户，它只是“最后再测一下”。对一个可发布、换机器使用、不能伪造 PASS 的插件，它至少包含五个边界。关键不是这些边界存在，而是哪些应该由模型手工接线。

| 边界 | 必要业务/安全语义 | 当前代码已经提供的收敛点 | 反复返工揭示的缺口 |
|---|---|---|---|
| 找到测试能力 | 真实安装且获准的 action 与内置但未安装的源码不同 | `development-dependency-catalog.ts:16-30,59-85`；`native-composition-dependencies.ts:49-83` | “已绑定依赖”“搜索新 action”“读取目录资源”原来需要创作者自行分辨。把不存在的 provider 当能力缺失，容易重复生成 runner |
| 复用依赖 | 精确源码检查、安装和授权是不同操作 | `development-dependency-prepare.ts:68-81,88-149` 复用原 save/check/requestReuse，并非另一套安装器 | 仅提供源码分页和低层 save，容易让模型转抄大型依赖、填错 digest；这是平台操作封装不足，不能归咎于 E2E 业务复杂 |
| 修改项目 | 加阶段仍须保留旧 Skill/Hook/知识/配置/检查 | `project-authoring-session.ts:530-558` 用 sourceDigest/revision、JSON Pointer 与原 save/CAS 做原子 patch | 让模型为追加一项重写整份快照，会丢闭包、混入生成文件、浪费版本；sourcePatch 是合理的小修，不是需要另造框架的理由 |
| 配置贯通 | 用户选择的测试与被测对象必须独立于模型自报结果 | `native-composition.ts:170-190`；`project-runtime/action-input.ts:219-231,320-324`；`project-action-executor.ts:145-184` | 原配置系统存在，不代表执行 Skill 和检查 action 已有相同的明确投影。若改知识 Mod 来中转 E2E 参数，会把公共缺口变成 AutoBiz 特例 |
| 后台执行结算 | `workflow start` 的 launched 不是完成；不能提前校验或再 start | `host-workflow-continuation.ts:5-16,20-38,49-82` 只持有原 run-manager 句柄；`host-skill-executor.ts:476-499` 在同操作消费原结果通知 | 通用 workflow 能力存在，不代表 Host Skill 的物理运行、通知、产物封口已衔接。此处应平台一次修好，不应让每个 Mod 自己轮询/重启 |

这几项不是同一类问题。依赖发现、不可丢资源的编辑、配置的受控投影、原运行的完成通知，是通用平台问题；怎样选择测试、什么断言足够、哪些文件是真实被测对象，是业务扩展问题。此前将二者混在创作者提示和个别插件脚本里，会让“修插件”不断扩大成“修平台”。

当前 `src/main/agent/mod-authoring-runtime.ts:56-59` 已明确 native source 应走 `project_read/patch/compile`，真实 business manifest 才走 `mod_business`；`:83` 明确 project_dev、pack 和 trial 的不同意义。它说明方向已经在收敛，也暴露了过多协议选择曾经依赖长提示解释。不能把新提示存在当作真实模型已经稳定遵循的证据。

### 为什么 E2E 校验本身不能简化成一句“运行成功”

`resources/native-compositions/test-verification/mods/main.ts:232-279` 的执行 action 记录真实运行；`:279-438` 的检查 action 再对当前项目/阶段/操作、provider、配置和原执行证据进行核对。`workflows/verify.workflow.js:20-54` 验证三个实际配置字段，`:56-71` 调用原 action 并返回原执行 selection。

这套独立检查是必要成本：否则模型可以跑另一个成功测试、改被测文件后复用旧 PASS，或者直接手写报告。但“执行与检查分开”不意味着作者必须再写一层 wrapper、再造一个 provider、再做一份运行状态。应保留业务适配器与原生证据链，减少人工转抄接线。

另一个实际边界是配置所有权。`src/main/mods/v2/platform-project-runtime-provider.ts:133-152` 的公开 read 是项目/操作摘要，没有任意读取全部用户配置。不能让 agent 猜它会返回配置。现在按 `configurationKeys` 向当前阶段发布必要标量，并在 checker 侧独立读同一原生配置，是有边界的修复；把所有配置或凭据塞进提示不是修复。

## 原插件的哪些设计增加了迁移成本

1. **路径既是实现细节又是协议。** 插件相对根、工作区、feature 目录、知识目录不是同一个 root。原 `board_config.json:36-42,64-70` 通过字符串模板把它们注入命令和上下文。快照、安装、试用和工作树都会改变其中一部分路径。把旧脚本原样搬到纯函数 sandbox，或把作者机绝对路径复制到包里，都不会自动正确。
2. **配置、路由、运行资源集中在 board，而 Skill 又需要读取其派生值。** `board_config.json:100-188` 有 profiles/dynamicStages；例如 `:356-363`、`:471-478` 引用实际 agent 文件。模块化只保留 Skill 会失去 agent、校验器和动态路由闭包。当前 `business-adapters/autobiz-package-admission.ts:108-125` 专门检查这份资源闭包，是有原因的兼容成本。
3. **部分“只读”依赖实际包含物理副作用。** 旧 `state.py:26-31` 可按需同步视图；原知识命令 `board_config.json:41,69` 可拉取并写回配置。Host 只读 context 与这种操作不等价，不能靠换名字解决。
4. **知识是一套选择算法，不是简单拼 Markdown。** 保留样本 `hooks/collect-knowledge.js:256-266,349-401` 搜索最近 AGENTS 边界、遍历 frontmatter 与知识分类。当前 `autobiz-knowledge/mods/main.ts:26-37,56-66,90-101` 则通过宿主绑定 roots 与显式 selectedDeployUnits 读取。数据来源改变后，必须明确保留了什么、什么要安装后重新绑定。
5. **Hook 同时承担业务门禁和运行时保护。** 原 `hooks/hooks.json:36-80` 包含状态、生命周期、密钥与状态先读检查。迁移不能把所有 Hook 一概删除，也不能在 Host 已拥有阶段后继续运行旧 checkpoint Hook。应按职责抽出纯业务校验，保留安全保护，舍弃重复的旧阶段推进。

这些问题说明原插件不适合“自动拆文本即得到等价插件”，并不说明其全部规则应重写。把稳定的纯业务规则保留为校验器，比反复让模型重新生成规则更容易评审。

## 原生重设计目前是一个明确子集，不能冒充全量等价迁移

生产代码支持这个判断，而不只是文档自述：

- `resources/native-compositions/autobiz/workflows/native-code.workflow.js:23-24` 明确只支持 `backend_only`；`:31-40` 限制批次和任务类型。业务 DAG 在该工作流内部执行，外层 Host 仍负责阶段提交。
- `modules/code/SKILL.md:8-18` 依赖原 workflow、真实 rules provider、原运行及 Git 资源证据，不写旧 checkpoint。
- `modules/cicd/SKILL.md:7-11` 仅生成 `prepared-only` 发布准备，不提供实际 push/PR/部署 provider。
- `modules/archive/SKILL.md:6-10` 归档实际产物、交由 Host 终结，不移动旧目录、不写旧 state、不声称外部发布。
- `native-composition.ts:332-335` 要求输入来自先前生产者；`host-store.ts:636-638` 的外层推进是阶段数组索引加一。它不是已经实现任意旧 checkpoint 图的通用引擎。

所以“保留八阶段原生流程并追加/替换业务能力”可以作为当前目标；“无损迁移所有旧动态路由、前后端类型、外部知识沉淀与发布”是更大的独立承诺。若每次验收又补回后者的一个角落，改造会无限扩散。代码中的显式阻断应被当作范围边界，而不是必须马上再扩框架的缺陷。

## 合理成本、冗余成本与层次边界

| 应保留的原生成本 | 应由业务 Mods/资源承担 | 应收敛或停止新增的胶水 |
|---|---|---|
| 唯一 Host 状态、事务/CAS、幂等、未知态核对 | AutoBiz 文档/领域规则、交付内容契约 | Mod 私有 checkpoint writer、复制 Host 状态机 |
| 来源固定、权限撤销、原生审批、配置绑定 | 知识选择算法及非敏感业务材料 | 每个插件分别实现安装、授权、配置转发 |
| 真实进程/workflow/run/worktree 所有权、物理停止、原通知 | E2E 的执行适配器、断言与被测对象契约 | 每个插件自造 runner、循环轮询、重启 workflow 当续接 |
| 产物/配置/provider/操作绑定及成果审批 | 新业务阶段的 Skill、产物 schema、检查 action | 平台写死 AutoBiz 阶段或 E2E 的业务字段 |
| 普通项目创建、入口分流、包安装/导出 | 原生支持范围内的业务流程脚本 | 同一 native source 先模块化 legacy、再包一层业务 kernel |

`src/main/agent/workflow-child-mods-context.ts:60-112` 对父配置来源和子任务文件权限做不同绑定，并不等于多余状态机；直接删掉会混淆授权根。`host-workflow-continuation.ts:5` 明确没有新增第二运行记录。判断“胶水是否冗余”应看它有没有重复 authority/store/runner，而不是看文件名多或 guard 多。

另一方面，可复用测试模块不应依赖 AutoBiz 的 feature、plan、知识选择器。公共平台也不应因为某个业务模块叫 E2E 就认识它的三个字段。当前 `configurationKeys` 的声明投影比平台硬编码字段更合适；继续增加业务特例反而会把新方向重新做成单体。

## 为什么已有很多测试，仍然不断发现问题

### 四类通过不能互相替代

1. **静态源码/契约检查。** `project-authoring-session.ts:382-414` 编译后运行 doctor 和 artifact tests，并明确 `businessActionsExecuted:false`。`project-contract.ts:299-338` 直接执行隔离 Host 产物校验，明确没有 Skill、模型或业务脚本，action 回执保持 unknown。负例失败符合预期，可以令测试 valid，但没有产生业务成功回执。
2. **受控原生组合测试。** 能真实跑创作、审批、安装、项目、Hook、产物与 transition，同时用受控模型生成正确工具调用。它证明接线，不证明自由模型在真实提示下能发现接线方法。
3. **真实模型创作与普通使用。** 目录分页、候选版本、依赖确认、续接、安装后换工作区、实际配置都可能暴露前两层没有经过的边界。
4. **业务内容验收。** 产物 schema 和脚本通过、Host completed，仍不自动说明需求内容正确、测试断言足够或系统满足用户业务目标。

保留证据 `output/creator-journey-recheck-20261027/validation-summary.json:1-5,24-60` 已把技术链路通过与业务内容验收区分开；`:71-76` 记录真实模型样本 `needs-revision`。这是正确的证据表述，不能把这个样本转述为全部业务成功。

### 真实追加尝试暴露的仍是创作闭环，不只是业务校验

`output/autobiz-e2e-complete-20261028/append-third.log:1` 记录真实模型在 native 项目后进入 `mod_business:inspect_raw`、多次读取旧资产而耗尽总时限；工具调用没有异常也没有形成候选。第五、七、八轮摘要记录 `PROJECT_DRAFT_FILE_MISSING`、`DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED`、`NATIVE_COMPOSITION_ACTION_REQUIRED`、`PROJECT_DRAFT_FILE_UNSUPPORTED`、`DEVELOPMENT_TURN_BUDGET` 等。第九轮是 `UPSTREAM_NETWORK_ERROR`；`append-ninth-network-resume.log` 又记录转向纯函数 scaffold/submit、静态检查失败、修复预算结束且没有准备好原生候选。

这些结果只能证明对应构建和输入下的真实障碍。不能把网络故障归为 Mods 架构错误；不能把读取分页本身计为失败；也不能把“无异常但时间耗尽”说成创作者已经可用。首次到第九次的 `*-exit.json` 包含不同 `mainSha256`，意味着各轮可能已改变平台，不能直接当成同一构建的稳定成功率/性能样本。此次也未重新验证最终当前源码是否与这些历史构建相同。

测试基础设施过度并发、UI 选择器和导航假设、总时限与模型网络波动还会污染结果。它们必须单独分类复验，不能用全套失败数推导业务架构失效，也不能用单线程重跑变绿证明业务已经通过。

已有一个具体反证说明不能把旧回归失败全部当成业务退化：`vitest.config.ts:102` 现在全局限制两个 worker；`output/autobiz-e2e-complete-20261028/worker-cap-runtime-probe.log` 记录四个真实 fixture 下 peak=2、5000ms 预算的探针通过。相邻 `worker-cap-context-identity-recheck.log` 记录实际原 AutoBiz 两种包的五项上下文/知识/部署单元/旧包准入检查全过，未通过放宽这类 5000ms 预算来掩盖问题。这说明有测试调度层的归因问题；五项窄测仍没有覆盖自由创作、追加 E2E、安装和普通业务全链。

**核心验收问题是先覆盖了横向零件，再用真实纵向任务发现缺失接缝。** 修复每个接缝是必要的；每修一次就扩大抽象范围、改变测试模型或换成功口径，则会让下一次失败无法可靠归因。

## 按收益排序的最小收敛路线

### 1. 固定一个产品承诺与唯一新建路径

把当前交付目标写成可审查事实：在 `native-composition` 的已支持范围内，保留原包业务契约，完成“追加独立 E2E”和“替换中间 Skill”两条普通用户链路。保留已存在的 Host owner、manifest 分流与 workspace 互斥。旧插件继续走明确 legacy 兼容入口，迁移是显式操作。

不再把远程知识同步、外部发布、任意旧动态图与全部前端类型默认为这两条任务的前置重构。已发现的明确阻断如 `backend_only` 应在使用入口提前展示；支持这些能力需要单独业务范围和真实 provider。

### 2. 把现有公共契约收尾，不再另建框架

继续使用已有 `dependency_prepare`、`project_patch`、`project_compile`、原生配置卡和 Host trial。让返回数据明确来源种类、真实 revision/digest、可调用的下一步及缺失字段；失败返回可定位的路径和正确命名空间。不要让模型为不改动的依赖分页转抄，也不要用更多长提示补偿含糊返回。

这是对现有工具的操作封装与诊断整理，不是增加一套通用状态 SDK、依赖安装器或业务流程 DSL。已经补齐的 helper 应被复用；不能每次新增业务再建同义入口。

### 3. 以业务无关的最小样本固定剩余生命周期契约

只保留一条确有必要的公共管道：已批准 action 来源进入原 workflow；当前阶段读取必要配置；同 operation 等待原运行结算；checker 读取独立 Host 配置与原证据；原 Host transition 提交。该样本应能在不依赖 AutoBiz 名称/知识/plan 的项目中成立。

以后新模块只添加业务 Skill、workflow 资源、输入输出与 checker。若仍需平台改动，先用此最小业务无关反例证明公共缺口，再修一次；不把 AutoBiz 或 test-verification 的字段硬编码进平台。

### 4. 固定候选与证据，补最小纵向验收

每条真实旅程固定候选源码摘要、当前构建、模型条件、输入、配置和依赖身份。依次记录：自由创作确实得到候选；原生试用实际执行；真实检查通过并推进；安装/导出后由普通入口在新工作区重新配置并执行。修复平台后旧结果只作历史，不能代替新候选验证。

同时保留针对性的失败样本：改上游产物、改 subjects、换测试、换配置、拒绝/撤销、后台等待、取消、未知态。验收证据应显示“检查失败/尚未推进”等具体状态；不需要再铺一套与实现逐行同构的测试框架。

业务内容另作复核。真实 E2E 对某个样本通过，只证明那些断言和声明的被测对象，不应扩大成所有系统业务通过。

### 5. 在使用证据充分后隔离兼容面

保留 legacy 必需资源与原 writer；新 native 项目不再进入首次模块化、旧 board discovery 或旧 checkpoint 回写。可以逐步降低 UI 与 creator 中旧能力的误入概率，但不要在这次收尾中顺带删除全部兼容系统。

停止扩大的实用标志是：在相同平台接口上完成上述两种扩展，不再为业务名称增加平台特例；若不能达到，报告确切缺口，而不是宣布“再做一个更统一的框架”。

## 明确反例与停止标准

- **一追加普通 E2E 就必须让知识 Mod 转发 E2E 配置：** 层次错误，应使用已存在的当前阶段配置投影。
- **需要新建 Mod 状态图或写旧 state 才能让 native 项目推进：** 偏离 Host owner，应停止该实现；检查原 Host operation/receipt/approval，而不是再加 writer。
- **可以通过删除原检查、调松业务规则、手写 PASS 或换成功测试完成验收：** 不是修复，不接受。
- **静态 compile/test 返回 valid，但 action 检查 unknown 或没有原生 transition：** 不能称阶段业务完成，进入原生授权试用验证。
- **后台 run、进程或外部效果结果未知：** 保留原身份核对，不重启初始 Skill/工作流重放副作用。
- **同一问题只在并发压力或旧测试导航下失败：** 先分离基础设施与业务反例，不能因此扩大插件重构。
- **需求实际需要任意旧动态状态图、未支持的前端交付或外部发布：** 保留当前支持范围并明确缺少的业务能力；继续 legacy 或单独设计该业务 workflow，不能声称已有原生子集全量等价。
- **没有能复现的公共缺口，却准备再新增 SDK/runner/store：** 停止。先用现有合同完成实际垂直任务。

## 仍未证明的事项

此次为只读架构审查，没有重新运行任何端到端旅程。当前代码表明关键公共能力与唯一所有权已存在，但未证明最新在研构建下，自由模型可以一次或稳定地完成“追加 E2E→确认依赖→编译→真实试用→保存/安装→普通项目重跑”。历史追加失败也不能证明最新补丁仍以相同方式失败。

未证明 native 八阶段与原插件所有模式完全等价；生产代码反而明确限定了支持范围。未证明 E2E 断言覆盖全部业务需求、未声明的源文件和外部服务器状态。未测量改造带来的整体时延、Token、维护人力或长期故障率收益，不给出这些数字。

可做出的决策是：**保留原生 Host 生命周期与业务 Mods 的分工，完成现有两条纵向交付并固定证据；兼容路线维持边界，不继续把每个业务场景扩张成下一轮平台重构。**

## 审查后的最新实测补充

以下是独立审查完成后 **root agent 提供的运行反馈**，不是本报告审查 agent 亲自执行或独立复验的结果，也不修改前文的独立结论。

- 最新完整本地 build11 的主摘要为 `0da93538bf77b1ae02e568c3f7932454d68807b33dcc24356ff760b1df1ff23d`。类型检查和完整本地 compile 通过；没有打安装包，也没有触发 GitHub Actions。
- 真实追加 E2E 尝试 `run-mKmJxb` 已物理结束，见[原始 evidence.json](../../output/autobiz-e2e-complete-20261028/append/run-mKmJxb/evidence.json)：HTTP 请求 49 次、工具调用 48 次；原生依赖确认 1 次且成功；可试用候选 0 个、repair 3 次；依赖确认后的 32 操作上限被触及，最终为 `LIVE_TOTAL_TIME_LIMIT`。因此这次运行不能证明自由创作或完整业务链成功。
- root 已精确定位 r4 的首个错误：`configuration.userConfig.e2eTimeoutMs` 使用了 JSON Schema 的 `minimum/maximum`，但实际 [FunctionUserConfig 解析器](../../src/shared/mods/v2/user-config.ts) 接受的是 `min/max`。生产 parser 原本提供不暴露值、只指出字段的安全错误消息，但 [mod_authoring 的 catch](../../src/main/agent/tools/mod-authoring-tool.ts) 丢掉了该消息，只返回错误 code 和泛化 hint。这一处同时包含模型首次生成错误与平台修复诊断丢失，不能全部归因于模型。
- r6 作者源码为 38 个文件、246716 字节，低于作者源的限额，compile 仍返回 `AUTHORING_SOURCE_LIMIT`。展开资源闭包的精确计算还在进行，尚不预判是闭包真实超限、限额口径不一致或其他原因；不能仅凭作者源大小断言限额检查有错。
- root 另报告 115 项关键窄测、5 项旧 AutoBiz identity 检查与 1 项 composition-example 检查通过。它们支持局部契约和保护的正确性，不等价于上述真实追加任务、安装后普通使用或业务内容全链通过。

这个新案例支持“模型首错 → 平台未返回可修复诊断 → 后续盲修与预算耗尽”的因果解释。它支持保留原安全检查并修复诊断和契约可用性；不支持用删除检查或增加预算来宣布成功。
