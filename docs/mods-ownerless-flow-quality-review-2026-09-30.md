# 无所属 Mods 流程：前端、绑定与迁移质量评估

评审者：composition_quality_review。初始只读评估；双审后负责 shared/schema、UI/chat 和 IPC 门禁。

结论：**正式收敛为 v1 保持原状、v2 显式宿主运行，方案与本 agent 范围的交叉实现评审通过。**
宿主运行授权由根任务与架构 agent 实现并负责相应安全验证。下述初始风险清单仍为验收依据。
这属于本工程的组合体验改进，不据此宣称 Claude 提供相同的可视化流程。

## 推荐交互

新流程默认由应用运行，不要求安装一个空插件或选择“授权来源”。用户只需选择每一步的
Agent/Skill/工具/插件动作和模型。插件动作仍明确显示实际提供者、版本与授权状态；
MCP/Skill 仍明确显示来源，目录加载保持显式，不用模型推测插件能做什么。

旧流程存在 plugin 时保留原绑定，在高级设置显示“旧版流程授权来源”，解释其旧权限及
项目完成规则继续生效；不得静默移除、选择第一个可用插件或填入假的内置插件名称。
如提供转换，应为明确用户操作，形成新 revision，说明已有 Claw 绑定副本不会自动更新。
若本轮不提供转换，旧流程照旧运行，用户新建宿主流程即可体验新方式。

保存不启动，应用只替换当前空闲对话的 Claw 副本；仍需切换到“执行流程”再发送任务。
没有 Function Mods 的组合可包含模型、Skill、MCP 或流程，不能显示为“无能力可用”。
“插件整体事件能力”和“流程中的显式动作”在文案上区分，避免用户误以为每个旧 Hook 都
已成为独立可选步骤。旧插件只作为整体选择，未来拆组件须依赖作者显式导出与独立身份。

## 必改链路与已核实位置

| 链路 | 当前约束 | 本轮要求 |
| --- | --- | --- |
| types/schema/templates | FlowDefinition.plugin 必填；模板从插件目录取第一个 owner | 新 v2 模板显式 host，不含 owner；旧 v1 空串/null 等非法值不偷偷转换 |
| FlowStore + ClawStore | 保存定义和 Claw 冻结副本校验解析后的 JSON digest | 保持所有旧定义的规范化字段顺序和取值；不能添加默认字段使旧摘要全部失效 |
| mods:flow-catalog | 无 ready 插件就提示先安装授权 | 以 Mods 开关、普通本地线程及宿主执行能力判断；零插件不再是阻断原因 |
| FlowsPanel | authorized 仅查 owner 插件，模板默认首插件 | 新流程无 owner 也能保存/启动/到聊天；保留独立 raw dirty/valid 守卫 |
| ChatFlowControls | 无 owner 授权则 option disabled | 统一运行资格 helper，不能只改页面按钮而漏聊天选择器 |
| use-chat-flow | choose 和 submit 分别查 owner | 两处都适配；revision/workspace/显式 intent/单次启动锁保持 |
| mods:claw-change | flow owner 必须在 capabilities 中 | 仅旧 owner 流程保留该检查；启用 action 的真实 provider 仍须加入组合并核对摘要 |
| ClawPanel/ClawSidebar/Guide | 首步要求上传插件，空 capability 提示无插件 | 可从内置任务开始，按需要添加来源；零插件不能误导为组合失效 |
| NativeFlowHost/prepareFlowScope | 首先要求 owner snapshot；MCP、check、stage 借 owner | 宿主流程必须有真实宿主作用域，不能通过伪造插件 grant 绕过 |

Claw parser 允许 capabilities=[]，已有基础可复用；但 flow snapshot 仍调用同一
parseFlowDefinition，schema 修改会直接影响已有绑定的可读取性。FlowStore.list 会验证
整组 rows，因此一个旧定义摘要被改就可能让整个项目流程列表打不开，不能只测新建。

## 授权与行为边界

- 保留 Mods 总开关与项目开关。无插件是合法配置，Mods 被关闭仍应拒绝新运行并停止旧权限。
  保存草稿不授予执行权限；渲染目录不初始化 MCP transport。
- 新宿主 scope 必须有 thread incarnation、workspace、run lease、runtime authority、
  来源/模型/Claw revision pin、取消/撤权及输出保护。它不等于某个 guest 的 grant。
- 插件动作继续用实际 provider 的源码身份和已批准权限，不从宿主流程获得额外 SDK 权限。
  Claw 只含 A 时不能调用 B；旧 owner 消失不能自动转成宿主权限继续执行。
- MCP 精确工具路径当前依赖 withOwnerGrant → invokeFunctionMcp，需要明确宿主调用主体及
  同等工具权限、审计、protected output、无重试规则。不得换成裸 transport 避开现有检查。
- check 的 temporaryPolicy.plugin、Autobiz stage.plugin 目前都依赖旧 owner。宿主路径
  必须仍执行真实检查、生成证据、核对人工确认指纹、保留项目强制规则，不能将 gate 缺失
  当“通过”。初版若不支持某类型，要在目录明确禁用，不能运行到一半才发现只能跳过。
- 运行中修改模板不影响冻结副本；修改 Claw/模型/来源或文件成果仍按现有生命周期拒绝
  陈旧继续和陈旧确认。侧栏关闭、浏览器重载不得卸载流程控制器或取消任务。

## 迁移契约建议

最终采用 schemaVersion=2 + execution:{kind:"host"}，禁止 plugin；v1 保持必填 plugin、
原规范化顺序与 digest。没有自动迁移。v2 的 execution 除 kind 外不接受任何额外字段，
顶层 authority/grant 也拒绝。v1 不接受新增 execution 字段，避免混用两套身份语义。
不要在读取旧行时重算摘要或自动保存；那会掩盖损坏并悄悄改动已应用副本。

新宿主流程不得依赖渲染层传来的 grant、内部 owner 名称或任意权限参数；启动时由宿主
根据可信 SavedFlow 和当前项目生成运行身份。只有合法 v2 声明选择受限宿主编排模式，
绝不能导致 guest 获得应用权限。

## 必须验证的反例

1. 零插件、本地普通线程、Mods 开启：新建 Agent→人工确认流程，可保存、直接运行及
   Claw capabilities=[] 绑定应用后聊天执行；每种启动均只调用一次并获得真实结果。
2. 零插件 + 真实 Skill、真实 MCP、真实 check 分别完成；不额外要求安装“授权壳插件”。
   全局/项目开关关闭、Harness/远端/子线程仍拒绝，普通 Plugin/Harness 请求无额外订阅。
3. 老数据库混合旧 owner 流程与新宿主流程，列表重启可读，旧 digest/revision 不变；
   老 Claw 副本可应用/启动，改原模板不篡改副本；畸形 plugin/null/伪摘要拒绝。
4. 旧 owner 撤权/删除后拒绝旧流程，不退回宿主；新流程 action B 未批准或不在当前
   Claw 时拒绝，不能利用 A 或 host 身份执行 B。禁用未配置节点仍可保存并跳过。
5. 有强制完成规则时空能力组合不能绕过；取消/超时/来源变更/线程替换发生在等待审批、
   MCP 返回、模型返回及发布中，都不允许迟到结果继续；资源/ACL/lease 完整释放。
6. 已保存流程仅输入无效 JSON/数字时，保存/运行/到聊天继续阻断；旧草稿切换/保存 reset
   逻辑不回退。无需 owner 不能误伤已完成的 typed form 与 inputFrom 支持。
7. 非空动作来源自动发现仅做静态目录，不运行插件或连接 MCP；64 步骤输入性能、普通
   聊天零 Flow catalog 扫描、右栏反复开关单 controller 单 subscription 保持。
8. 新建/保存/绑定/应用/聊天显式启动全过程 Electron 实测；截图展示无需安装插件的首用
   路径，以及缺失具体 Skill/MCP/action 时可理解的来源错误，不是“请选择所属 Mods”。

旧流程的 empty/null owner 不能作为历史合法数据迁移：旧 parser 从未接受它们，应该继续
拒绝。此轮也不承诺一键拆解任意第三方插件；未来组件选择以实际导出目录与单独授权模型为准。

## 已完成范围与证据

- FlowDefinition 分为 LegacyFlowDefinition / HostFlowDefinition；另增 createHostReviewFlow，
  旧 createReviewFlow 和 createAutobizFlow 保持 v1。新建代码检视默认 v2；复制保持原版本。
- v2 原生检查仅 unit-test/e2e。代码检视是明确的 Agent 任务，不伪装原生验收证据。
  code-review/autobiz-validator 检查与 autobiz-stage 即使 disabled 也拒绝 v2 导入；
  UI 不提供这些 v2 选项，旧 Autobiz 模板保留显式选择 owner 的旧授权方式。
- FlowCatalog.hostAvailable 只表示界面运行资格；flowRunnableInCatalog 统一页面和聊天门禁。
  新流程零插件可选择与启动，Mods 关闭仍阻断。Claw 只对 v1 要求 owner 在 capabilities 中，
  所有启用 action 的 provider 完整身份检查保留。
- 5 文件 67 单测通过：`output/mods-ownerless-quality-tests.log`。包含 v1 固定 canonical
  字节、存储混合重启与无写回、严格 v2 字段、unsupported 节点、零插件目录、空能力组合
  保存应用以及缺 action 来源拒绝。16 范围文件 lint 为零：`output/mods-ownerless-quality-lint.log`。
- 新真实 React 浏览器 5 组通过：`output/mods-host-flow-browser/report.json`，errors=[]。
  覆盖零插件新建/保存/直接启动、Claw 绑定应用→显式聊天执行、关闭/版本更新拒绝且输入
  保留、旧 v1 owner 不变与撤权门禁、800px 首用界面。已目视
  `output/mods-host-flow-browser/zero-plugins-800.png`，无横向挤出或 owner 安装前置要求。
- architecture agent 已独立读取 shared/schema、IPC、模板和 UI eligibility 代码，结论通过。
  完整生产构建、Electron 真实权限/模型/工具链及最后存量回归由根任务汇总，不以 IPC
  fixture 的浏览器通过代替真实运行授权证明。
- 存量浏览器 20 组通过：`output/mods-ownerless-old-browser.log`；保留普通导航零 Flow IPC、
  100 事件最多两次详情请求、20 次侧栏切换单 controller、旧参数/Skill/MCP 及绑定副本语义。
  64 步骤编辑二帧完成 p95 为 16.7ms，仅是本机浏览器交互指标。
- 参数表单专项 8 组通过：`output/mods-ownerless-forms-browser.log`，包括之前禁用步骤回归、
  未完成草稿、false/0/空串、来源摘要、64 步骤及窄屏。两个浏览器脚本定向 lint 为零：
  `output/mods-ownerless-browser-lint.log`。
- fresh `npm run typecheck:web` 通过：`output/mods-ownerless-web-types.log`。

## 底层授权链独立终检

结论：本次只读交叉检视通过，未发现新增生产阻断。检查范围包括
`flow-authority.ts`、`manager.ts` 的 HostFlowAuthority/审批/发布路径、
`v2/manager.ts` 的 prepareFlowScope/effectiveStatus，以及 `flows/native-host.ts`
和 `flows/native-mcp.ts`。本结论不是最后生产构建、全量测试或 Electron 执行结果的替代。

- 无 owner 不等于免审批。HostFlowAuthority 仅接受 WeakSet 登记的原对象，序列化复制
  不能成为凭证；它绑定真实 runtime authority、线程、runId、定义摘要、Mods 配置 epoch
  和原 lease。重新开关 Mods、替换 lease、失去 runtime、取消都会使旧身份失效。
  hostFlowBinding 还验证真实物理执行 scope 和 main 绑定，嵌套 guest 不能借用宿主身份。
- 原生测试和 MCP 均经既有 ModCallContext/工具执行引擎。identity.flow 进入最终参数
  审批分支，拒绝、只读和非用户主动调用不会获得写授权；审批返回后重新检查 scope。
  host 身份没有伪造 function grant，也没有绕过真实工具执行回执要求。
- MCP 固定 provider/config/schema/connection 身份，只交给当前精确工具一次 transport。
  准备、审批、调用前后均检查来源与运行状态；失败不能通过自动重试或另一个工具补偿。
- 空 capabilities 不能排除应用设置的强制 check/repair 规则：effectiveStatus 仍检查
  clawSelectionIssues。prepareFlowScope 固定已加载 snapshots、配置、运行代数与插件摘要；
  v2 仅取消旧 owner 必填，不取消所有其他来源的 grant 和生命周期检查。
- 原生检查记录实际 executionId/exitCode/outputFingerprint，检查前后重新捕获成果绑定；
  缺回执或成果变化不生成 check.result PASS。finalize 会重跑所选检查和应用强制规则，
  人工确认前后再次核对 fingerprint；不是复用早先通过文字直接完成。
- 结果发布使用原 signal，发布返回后再次 assertPrepared / assertLive；host capability
  异常会 blockPublication。异步调用结束不意味着获准提交迟到结果。

已只读复核新增反例测试：`host-flow.integration.test.ts` 的真实项目脚本、拒绝审批、
伪造 token、开关撤权、lease 替换、审批中取消、MCP 最终参数；`native-mcp.test.ts`
的真实 stdio 零 owner、拒绝/换 scope 无 transport、嵌套 grant 不能借 token；
`native-host.test.ts` 的实际回执、成果变化、mandatory 拒绝、最终重新检查。
本轮未重复运行这些重测试，由根任务统一执行。

## 最后补充验证与残余限制

- 根任务已补“工具已经返回、final publication 期间取消”的真实项目执行反例，并运行
  `host-flow.integration.test.ts`：8/8 通过，日志
  `output/mods-host-flow-authority-tests-final.log`。本评审已只读核对测试实现及日志：
  第 2 次携带 callId 的 manager.publish 返回时取消，实际脚本已写入文件，但调用拒绝，
  账本保留 status=succeeded / publication=blocked。既不把已发生的操作说成没执行，
  也不把已取消结果继续交付，更不会自动重放；此前提出的发布窗口证据缺口已关闭。
- FlowManager 的旧确认挂起问题已由根任务修复，本评审复核通过。decide 在实际 scope
  失效或 fingerprint 捕获失败时取消、拒绝 waiter 并等待 active.done 清理，再返回原错误。
  无关旧 nonce 只拒绝该请求，不取消有效等待；并发回复在 fingerprint 后重查 pending
  对象身份，只消费一次，不因第二条迟到回复取消第一条已接受的运行。
  根任务提供了修前失败日志 `output/mods-host-flow-stale-approval-before.log` 和修后
  30/30 通过日志 `output/mods-host-flow-stale-approval-after.log`，覆盖 terminal 状态、
  pending 清除、后续步骤未运行、dispose 与 lease 释放及并发反例。
- 完整 Node/Web 类型检查通过：`output/mods-host-flow-typecheck-complete.log`。
  根任务报告最新生产 Electron host/表单/存量链共 51 组通过；本评审没有重复启动应用，
  最终全量 npm test 结果仍由根任务记录。
- 使用成本边界保持明确：旧 v1 不自动迁移；Autobiz 专用阶段与检查仍需旧 owner 授权；
  v2 的代码检视仍是模型执行任务，不等同于确定性原生检查；任意插件内部 Hook 不能
  自动拆成独立组件。工具审批目标在部分 MCP 路径仍显示 capabilityId，影响可读性，
  不影响最终参数审批与身份校验；此轮记录后续优化，不扩展实施范围。
