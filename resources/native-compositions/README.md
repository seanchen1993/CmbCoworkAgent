# 原生组合源首批实现

`autobiz/composition/source.json` 是需求转换 → PRD → 规格 → 设计确认 → Plan → Code → CI/CD准备 → 归档 的唯一作者源。
这是部分业务语义迁移，不是完整 AutoBiz 替代版。逐条旧 Hook 归属、实际证据和缺项见
`docs/autobiz-native-migration-evidence-2026-10-23.md`。
独立供应商 fixture 位于 `tests/fixtures/native-compositions/vendor`，同一接口已验证真实 Host
资料归一化 → 合规 → 风险 → 人工确认 → 归档；它不是完整供应商合规产品。

## 当前安装与创造者路径

根目录提供 `devclaw.source-set.json`，声明本项目及规则、知识两个独立依赖。新增通用入口位于
创造者的“保存为插件并复用”：选择此目录，逐项安装并通过原入口授权依赖，再核对权限并准备模板，
最后从原交付卡安装和开始使用。该入口已通过真实 AutoBiz 服务链和独立供应商浏览器链验证；不自动批准依赖、不代替业务试用。
安装结果不明时先核对；已安装依赖不会因后续失败被假称回滚。跨机编译使用目标机实际授权身份。

需要逐步使用作者工具时，原路径仍保留：

1. 先通过原插件安装入口安装 `autobiz-rules` 和仅材料读取权限的 `autobiz-knowledge`，在原生权限界面确认实际源码摘要与进程/文件/平台权限。
2. 在创造者项目草稿保存 `autobiz` 的 source 和全部声明资源，包括 Code workflow、保留agent profiles、capabilities与必需Hook/Python依赖。此目录是作者源，不能把开发机已锁定运行包直接用于另一台机器。
3. 在目标机器先用 `project_actions` 检查实际依赖，再运行既有 `project_compile`，它读取真实已安装且授权的公开动作目录，锁定实际安装ID、digest及schema。
   缺失或重复提供器返回结构化依赖诊断。编译不安装、不授权、不执行业务动作，也不允许虚构身份。
4. 查看 doctor/test 结果，再从原项目试用入口创建任务，使用原生配置界面绑定 `knowledgeRoot` 目录。
   目录需包含组织实际 `AGENTS.md` 和带frontmatter的知识资料，并填写 `selectedDeployUnits` JSON string（如 `[{"deployUnitId":"orders-api","appType":"backend"}]`）。包中没有作者机器路径、secret默认值或自动远程同步。
5. 设计、Code、CI/CD准备 的 `resultApproval` 接受已验证成果；Code内部Git合并另经原workflow人工确认。
   两种批准的对象与作用独立，不能互相替代。

三个包仍分别拥有安装身份与权限；源码集合把准备过程放在同一入口，检查Mod的授权不被
项目编译代办。普通工具/观察Mod不依赖项目、Git或此编译器。

## 产物与业务检查

Host固定完整 `NORMALIZED_REQUIREMENTS.json`、`PRD.bundle.json`、`SPECS.bundle.json`、
`DESIGN.bundle.json`、`PLAN.bundle.json` 字节；bundle正文在 `files` 中，后续Skill实际读取bundle。
当前阶段不能覆盖上游正文；禁止越界路径、大小写碰撞和缺失必需文件。Python仅在私有临时目录
物化所需产物，执行从原真实源码静态提取的只读函数。不导入旧board_core/state writer。
`checks/provenance.json` 记录22个规则文件、330个符号的原始/提取摘要（新增原性能规则的13个符号）；提取脚本同步嵌入常量，
实际执行Python源码参与Function Mod的digest，回归逐字核对，不读取可变安装目录脚本。

`CODE_RESULT.json` 只选择已有的 `feature/runId`，不接受模型自报测试成功。Host 项目内的 Code、
CI/CD准备和归档检查通过 `native.project-runtime/project@1.0.0` 的
`inspect-workflow-evidence` 只读动作，按当前绑定选择原阶段和原 run，分页读取实际 workflow
结果、原 PlatformHub 动作回执和 Git 资源。当前阶段须有原 Skill 物理结算成功证明；历史阶段
须有已接受的终态、原产物及必要人工批准。仅在明确没有 Host 项目绑定的独立工作流中，才沿原
`native.workflow.inspect` 读取当前线程；不能借用其他项目、线程或未知结果。检查核对
精确workflow SHA、规则provider身份、计划摘要、任务测试、候选/集成commit及最终E2E。
缺失、unknown、截断、变更或不匹配均阻断。Code当前支持backend_only的受限路径：默认组合源使用单仓库，`autobiz-variants/multirepo-source.json` 显式声明第二仓库绑定并支持跨仓任务依赖；各仓任务串行执行、分别审批和提交，不具备跨仓原子性。真实UT失败必须绑定原平台回执与当前taskDigest/验收条件；source_bug和test_bug各至多一次、同命令复跑，未知或重复失败停止。UT预算保存在原工作树记录：首次真实命令1800秒、每批总时限2700秒、单命令300秒，续接不重置。JS/TS/Vue变更另运行原7条性能规则。原并行合并列车与完整frontend路线尚未等价迁移。

运行需Python 3.10+；Code还需Git和项目真实生产编译/测试工具。Code入口要求干净的Git基线。
初始化工程时由用户决定产物目录及 `.gitignore`（例如受控 `.devclaw/`、编译输出）；插件不会
自动忽略或提交用户文件。当前固定bundle路径与已有Host契约保持一致，作者应在进入Code前
提交这些确认产物或明确自己的忽略策略。

## 测试证据与限制

`native-composition.test.ts`、`project-native-composition.test.ts`验证编译、真实目录锁、资源
保存、doctor和业务规则反例。编译的project-contract仅证明缺产物被阻断，不能视为业务执行。
`autobiz-native-host.integration.test.ts`使用真实Host/Flow/FunctionMods/Python及独立供应商链；
`autobiz-native-code.integration.test.ts`实际运行原engine/ledger、临时Git、Maven编译和调用Java
的行为测试，再检查原始证据。模型作者与批准回调为确定性测试夹具，不声称live用户交付。

独立知识Mod按原frontmatter/AGENTS边界规则选择common、Service、Component/Reference，缺失或超限失败。CI/CD仅准备文档；归档校验七个上游产物原文与SHA-256。组织仓库同步/沉淀、真实外部发布仍未完成，不能由供应商归档fixture或成功的Code单仓库测试代替。

`autobiz/devclaw.legacy-import.json`声明已登记旧包的文档稳定点导入规则：真实重跑convert/prd/specs，design/plan保持原字节和锁摘要重新检查，全部导入阶段重新人工确认。源码参照位于`autobiz-import/`；修改时应同步主包声明。原始未登记插件不具备冻结管理边界，当前不能直接从任意旧目录导入。导入方案随原冻结记录持久保存，中断后复核同一方案续传，不覆盖变化文件或自动解冻。

Code capability将原秘密扫描器声明为必需PreToolUse：write/edit在真实写入前检查yaml/yml/properties；错误不打印候选值，缺失/异常failclosed。保留profile仅允许明确文件工具，patch输入不支持时直接拒绝。普通阶段若已执行命令Hook，不能再把后续输入等待冒称无外部副作用恢复。


### 运行真实集成测试的前置条件

除仓库要求的Node.js版本与npm依赖外，AutoBiz原生集成需要PATH中真实的Git、`python`（Python 3）、`java`与`javac`，以及JDK 17或更新版本。Maven使用的JAVA_HOME应与PATH的Java工具保持一致。测试实际创建临时Git仓、编译Java并运行行为测试；缺少工具会失败，不会跳过、伪造回执或自动安装。

Maven入口按以下顺序解析：

1. `AUTOBIZ_TEST_MAVEN`：明确的现存可执行文件绝对路径，仅路径，不接受附加命令参数。
2. `MAVEN_HOME/bin`，未设置时检查`M2_HOME/bin`。
3. PATH中的实际Maven入口。Windows选择`mvn.cmd`、`mvn.bat`或`mvn.exe`；其他平台选择`mvn`。

显式配置存在但无效时直接报`NATIVE_FIXTURE_EXECUTABLE_MISSING`，不会静默换用另一安装。空PATH项与相对PATH目录不用于解析，源码没有开发机安装目录fallback。

真实编译继续使用`mvn -q -o compile`。CI与开发机必须事先准备Maven及本fixture使用的离线本地仓库缓存：至少包含所用Maven生命周期的resources/compiler插件及其传递依赖。fixture的POM在`src/main/plugins/autobiz-native-code.test-helper.ts`中，使用Java source/target 17，无业务第三方依赖。可在独立准备环境用相同POM和一份真实Java源码完成一次联网compile来预热缓存；测试本身始终离线，不下载插件，不把缺缓存当成功。不同Maven版本可能采用不同的默认插件版本，准备缓存时应使用与测试相同的Maven安装及settings。
