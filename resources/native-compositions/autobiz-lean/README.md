# AutoBiz 五阶段作者源

这是与 `../autobiz` 并存的新作者源。使用现有 Native Composition 编译、Host 阶段运行器、公开 Mod 动作、原 workflow 与 Git 资源 API；不读取或写入旧 AutoBiz 状态机，也没有旧 checkpoint 导入。

本目录也作为创造者模式的受限研发参考脚手架。编译安装并保留作者源后，可以通过通用原生项目派生流程建立独立草稿；已派生的新插件仍使用同一流程继续派生。阶段正文可在创作工作区的“阶段提示词”中编辑，保存后重新编译并从头试用，不自动改变检查、依赖或已运行项目。用法见 [通用项目插件创作说明](../../../docs/creator-generic-project-guide-2026-10-30.md)。这不是旧插件的自动迁移或全功能等价改造。

| 阶段 | 用户得到的结果 | 机械验收与确认 |
| --- | --- | --- |
| baseline | RequestBaseline.json：Host 原始请求、逐项需求和决策 | 对照 Host 固定的请求来源检查原文、字节摘要与需求引用；Host 人工接受需求基线 |
| definition | 一个 Definition.json：原始需求、来源、范围、提案、逐项验收场景和 UI 引用 | 完整需求覆盖、来源快照、能力/规格双向对应、REQ/SCN 唯一、UI 引用 |
| solution | 一个 Solution.json：设计、设计字节锁、批次计划 | 重验定义，检查设计锁/追踪、计划范围、场景覆盖、依赖 DAG、批次闭环与验证归属；Host 人工接受整个方案 |
| code | Code.json 选择一个实际原生工作流 run | 独立实现/评审/测试、实际编译与测试回执、Git 封存与人工合并、最终 E2E；检查实际证据后 Host 人工接受 |
| delivery | Delivery.json：准备清单、PR 正文草稿、基线、定义、方案、代码选择四份产物逐字节归档 | 重验业务内容和 Code 证据，逐字节核对归档；Host 人工接受交付准备成果 |

当前以需求基线、定义、方案、代码、交付五阶段组织流程，Definition/Solution 使用原生 JSON 对象字段，避免模型在多个 bundle 中反复序列化同一份内层 JSON。业务文档仍有明确的来源、场景和设计引用。当前交付边界仍是发布准备；真实远端发布需要另一个已安装并授权的发布能力。

依赖能力分为三个可独立安装、审查、替换的 Mod：

- `providers/knowledge`：`autobiz-lean-knowledge/context`，通过 Host 已绑定材料 API 只读选择组织知识。
- `providers/rules`：`autobiz-lean-rules`，独立验证 RequestBaseline/Definition/Solution/Delivery 内容；`solution.inspect` 供 workflow 校验实际工作区方案并取得原始字节摘要。
- `providers/delivery`：`autobiz-lean-delivery`，执行和检查实际代码交付证据。

先通过原 Mod 开发/安装流程编译并授权依赖，再在原组合作者入口编译 `project/composition/source.json`。编译器从真实 action catalog 解析安装 ID 与代码 digest，不在作者源写入本机安装 ID、默认知识路径或凭据。替换能力时改其公开 provider 绑定并重新编译；已有运行继续使用其原固定包与依赖身份。源码本身不授予动作、Git 合并或发布许可。

运行代码阶段前，确认项目 Git 仓库已有可用的 `user.name` 和 `user.email`；工作流需要真实本地提交，缺少身份会使提交失败。使用自己的提交身份，可按仓库配置，无需为试用修改全局身份。

安装后，在该项目插件的配置中把 `knowledgeRoot` 设为自己的知识目录绝对路径。
`selectedDeployUnits` 当前是 JSON 字符串字段，可直接粘贴下面内容（不是额外包一层引号）：

```json
[{"deployUnitId":"orders-api","appType":"backend"}]
```

最小知识目录包含根文件 `AGENTS.md` 和一份部署单元知识文件。`AGENTS.md` 例如写入
“订单领域：保留权限、数据完整性及查询时限要求；缺失事实必须核对。”
`orders.md` 可直接使用以下结构；`deploy_unit` 必须和上面的 ID 完全一致：

```markdown
---
type: Service Knowledge
deploy_unit: orders-api
title: 订单服务
---
订单查询必须保留正常、缺失订单和无权限的验收场景。
```

这个未标注阶段的知识在五阶段及新增的相关阶段均保留。只有明确需要限定阅读时，知识作者才在
frontmatter 中增加例如 `autobiz_stages: [solution, code]`；不能用该字段隐去全局约束。
真实项目还需在工作区提供现有源码和构建入口；上述配置只绑定知识，不会生成业务代码、
授权进程执行或批准 Git 合并。

`contextArtifactIds` 是通用的初始阅读列表，必须是声明 `inputs` 的子集。它只影响技能/Host 的模型阅读指引，不能缩小业务检查的 artifact references、文件指纹、权限或已有模型历史。Code 初始只读方案，必要时仍可沿真实引用读取定义。Host 始终固定并核对全部声明输入。检查 Mod 用 `config.artifactRoles` 选择其职责内的产物，不要求每个 Mod 解析所有额外业务文档；任何已声明输入变化仍使旧检查、批准或状态转换失效。

知识选择保持部署单元、frontmatter 类型与最近 AGENTS 边界；新增实际 AGENTS 正文。没有 `autobiz_stages` 的知识在所有相关阶段保留。只有知识作者显式给出非空合法阶段数组时才按阶段过滤，省略路径也会出现在结果中；不使用模型相似度或摘要推断删除资料。阶段与标签的对应关系位于 `contextAction.config.stageTags`：当前 baseline 对应 baseline，definition 对应 definition/convert/prd/specs，solution 对应 solution/design/plan，code 对应 code，delivery 对应 delivery/cicd/archive。插入新阶段时必须显式增加映射；缺少映射、错误标注、缺资料、分页/大小超限明确失败。`knowledgeRoots` 可显式指定已绑定知识根内的子树；每次重新列举所选子树，并保留祖先 AGENTS，新增未标注文档不会被过期索引遗漏。未选择子树的正文不会读取，结果注明覆盖范围；省略时仍读取整个已绑定知识根。详见 [知识提供器说明](providers/knowledge/README.md)。

设计锁和计划验证归属由包内纯 Python helper 确定性派生；归档由 helper 读取原始字节生成。helper 不产生测试成功、批准或状态推进事实。`providers/rules/provenance.json` 记录复用的原只读规则源摘要；规则仅在私有 scratch 运行，新版不调用旧 Host 阶段或业务 writer。

验证命令：

```text
npx vitest run src/main/plugins/autobiz-lean.test.ts
npx vitest run src/main/plugins/autobiz-lean-delivery.test.ts src/main/plugins/autobiz-lean-code.integration.test.ts
npx vitest run src/main/plugins/autobiz-lean-authoring.test.ts src/main/plugins/autobiz-lean-knowledge.test.ts
npx vitest run src/main/plugins/lean-composability.integration.test.ts
npx vitest run src/main/mods/devtools/dependency-source-reuse.integration.test.ts
npx vitest run src/main/plugins/autobiz-lean-host.integration.test.ts
npx vitest run src/main/harness-board/host-skill-executor.test.ts -t "prepares the declared initial reading"
```

测试执行真正的依赖编译、作者源编译/doctor、公开业务 callback 和 Python 规则，并包含材料篡改与覆盖缺失等负例。确定性样例通过不代表真实模型已经完成某个用户项目；实际代码运行与原生证据链另外由交付能力测试验证。

`autobiz-lean-host.integration.test.ts` 覆盖五阶段实际 Host/SQLite 状态、基线与定义反例、上游字节变更、Node/Git/workflow、Code/Delivery 原证据与独立成果批准。模型写作和用户决定由受控测试夹具提供；业务检查、流程回执、批准接口和状态提交执行原实现，不代表人工点击 UI 或真实用户项目已经交付。

`lean-composability.integration.test.ts` 独立覆盖 Lean 前缀 `convert → baseline → definition → e2e`，以及仅使用 knowledge 与 evidence-validation 的非 AutoBiz 报告流程。它验证阶段知识映射、产物衔接、额外输入变化阻断、独立末尾检查先失败后修订通过、旧回执不可用以及人工接受后的 SQLite 完成状态。此前缀用例不代替完整五阶段尾部测试，也不重复耗时的代码工作树流程。

创造者可以从 `project-dependencies` 目录发现三个提供器的 Host `sourceId`，不用猜目录或安装 ID。knowledge、delivery 与 `worktree-changes` 可走真实 `dependency_prepare` → 保存 → 严格 SDK/作者类型预检 → 原生确认 → 安装授权链。`availability: authoring-prepare` 表示来源满足作者预算，实际预检诊断仍必须处理。

rules 当前保留的业务规则源码超过 Function 作者源的单文件/整体预算，目录明确给出 `native-source-set-required`，不能对它直接调用 `dependency_prepare`。需在原 Creator source-set 导入入口选择本目录的 `devclaw.source-set.json`：入口会快照整个集合并建立项目草稿，再可只选择 rules 依赖沿原生确认链安装，不推进项目；确认集合已结算后可取消准备，已安装依赖保留。也可继续完成整个项目的编译和安装。这是完整 source-set 导入的回退，有额外准备成本，不是单个大型 Mod 的一键准备，也不会静默扩大预算。project 与 providers 是互不重叠的兄弟路径，无须新增平台特例。

前插、后接或替换必须修改作者源的 module、输入/输出契约、检查与必要的角色/知识映射，再重新编译和验收。`artifact-reference-v1` 每次检查最多携带 **8 个产物（当前产物 + 最多 7 个上游输入）**；编译器会在超限时拒绝。默认 delivery 已有 4 个上游输入，可再声明至多 3 个。此限制与 JSON 包络、文件大小、权限和全部依赖失效规则一起保留；跨越预算应重新设计阶段契约，不能截断输入或复用旧批准。

规则替换只改变独立 rules 提供器的行为；delivery 不重复裁决其业务模板。执行框架替换则要提供完整执行与证据 Mod，保持版本化 `devclaw.execution-evidence/v1` 的动作/输入/结果契约，并在项目配置中声明新 adapter。编译器绑定实际提供器身份、相关规则动作身份和声明 workflow 文件的字节摘要；变更资源或提供器须重新编译，不能手填 digest 绕过。当前 delivery 实现支持的 adapter 仍限于下述 Node 与 Java/Maven 路线，独立新提供器可以实现其他框架。

当前 Code 工作流仅接受 `backend_only` 实现范围。默认 Node 适配器从实际 Git 跟踪清单枚举生产 `.js/.cjs/.mjs` 模块（每仓最多 8 个），逐个执行 `node --check` 并记录各文件退出码；入口文件合法也不能跳过另一个模块的语法错误。每次最多 4 个测试文件、8 个被测生产文件，要求真实用例非零、全部通过且无跳过，测试与被测文件字节在执行前后保持一致。超过上述有界范围的 Node 项目须先提供满足公开契约的替代执行 Mod。Java/Maven 路线通过下述显式配置提供；Gradle/Go/Cargo 等仍需要相应适配器。

执行配置 `executionAdapter` 默认 `node-test/v1`。Java/Maven 项目须在项目配置中显式选择 `python-unittest/v1`：实际 Maven compile 产出 Java 类，独立 Python unittest 调用已编译的 Java 业务，固定报告器记录真实非零用例统计。每次最多 4 个 test_*.py、64 个 Java/POM 源文件（仍受 1024 字节 argv 总参数限制）；拒绝未知混合生产语言。Maven 命令限定为根工程 compile，可带 quiet/offline/batch/no-transfer-progress 选项；拒绝跳过编译、模块筛选、替代 POM、includes/excludes、自定义目标及 clean 等其他目标。编译前后原始源码 SHA 必须一致；每批测试、修复重跑及最终 E2E 的 subjects 必须按字典序等于最近同仓同任务编译的完整 Java/POM 清单，摘要也必须相同。Node/Python 均禁止跳过测试，测试和被测文件在执行前后保持一致。两种执行路径由同一锁定 delivery Mod 的公开契约派发，workflow不猜语言。Code/Delivery 检查从Host真实配置绑定选择；更换配置后旧执行回执不能通过。其他测试栈需替换公开执行与证据契约并重新编译锁定。

当前工作流仅支持 backend_only、code 任务、最多 8 批且每批不超过 3 项，不能把通过这个样例等同于覆盖所有原 AutoBiz 项目。

需求基线绑定当前 Host 项目身份。新身份的阶段调试分支不能直接继承原基线并从中段执行；当前需从基线重新开始。通用阶段分支的文件来源校验不等于 Lean 业务基线的跨项目迁移批准，后续需明确协议，不能手工修改基线身份绕过。

当前五阶段固定样例的编译 Skill、知识正文和必读契约合计为 37,705 UTF-8 字节，旧八阶段同口径为 89,485 字节（减少约 57.86%）；范围内操作为 33 次，旧版为 50 次。测量不含 Host 消息封装、产物正文、workflow、子代理、工具返回和重试，不能当作总 token 或费用比例。逐项来源见测试 `autobiz-lean.test.ts` 及 [新版说明](../../../docs/mods-lean-plugin-explained-2026-10-30.md)。

历史四阶段固定样例曾记录准备材料从 89,485 降到 25,211 UTF-8 字节、知识 API 调用从 42 降到 20；这些数值不包含本轮新增基线及必要上下文，不是当前五阶段数据，也不是端到端 token、耗时或费用。测量范围和本轮记录见 [验证说明](../../../docs/autobiz-lean-verification-2026-10-30.md)。未标注的组织知识仍必须保留。

查看工作树 diff 使用独立的 `worktree-changes` Mod。创造者可通过
`dependency_prepare(sourceId: "worktree-changes")` 的正常安装确认流程取得该能力，
然后在扩展视图查看工作树变更。此能力不属于 AutoBiz 私有平台分支，
也不以查看 diff 代替实际代码验证、Git 合并批准或 Host 成果接受。

执行适配契约由 `test.contract` 给出输入 schema，`prepare-test` 返回将被原生时限绑定的实际 argv，`execute-command` 执行后返回真实统计及测试/被测字节摘要。替换必须提供完整公开执行与证据契约并重新编译锁定身份，不能只改安装 ID。只有 `source_bug` 可以有限自动修复，保留原证据与时限限制。真实 Node 回归中首次 2 项测试有 1 项失败，受控实现者仅修生产代码，原测试重跑 2 项通过，再验证最终编译、E2E 与原始证据。修复准入绑定原始失败回执的 argv、文件、源码/测试摘要、非零统计以及任务/spec/AC；空测试、跳过、统计矛盾和绑定不匹配均有负例。

`test_bug` 诊断会停止自动流程，保留失败回执与失败提交中的测试，不执行自动改测试、重跑、E2E 或合并。人工审查测试变更及原验收要求后进入新运行，旧失败记录不会回写为成功；该停止路径已有真实测试失败回归。

默认 Node 编译动作会拒绝实际跟踪/改动或计划声明中的 TS、JSX、Vue、Java 等未支持生产源码及未知生产扩展，要求替换执行适配器；JSON、Markdown 等非代码资源不受此编译扩展限制。
