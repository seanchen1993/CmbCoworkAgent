# Claude Code 2.1.290 tool.check 对齐设计

开发工作树为 `C:\ai\CmbCoworkAgent-mods-v2`。Root 独占实际测试、原版 probe 和性能。
真实 addon 后两票精度设计已通过；首五文件已实现并冻结，实际调用来源第二窗待独立
Source 审与真实门。以下记录原边界及阶段状态，不将局部结果称为全量兼容。

## 真实原版证据与使用效果

依据真实 2.1.290 包提取的
`output/claude-code-2.1.290-alignment-analysis-2026-10-06/readable/claude-code.d.ts`
12448–12555 行的 `ToolCheckArgs/Input/Result`，不是公开 tag 的旧类型副本。

| 场景 | 问题字段 | 返回字段 |
| --- | --- | --- |
| `$.tool.check({tool,input})` 查询 | 只有 tool/input；调用者传 id、agentId、ceiling 也被剥掉 | 裸 decision/reason/rule，可保字符串 hook；不执行 classic Hook、工具或审批 |
| 主循环真实调用 | 原 tool/input/tool_use_id，agentId 缺省 | 每一层结果携带这次问题的原 ceiling（如果存在） |
| 子代理或队友循环真实调用 | 同一次 tool.call 的实际 loop agentId | agentId 表示循环，next.origin 表示发起插件/engine，两者独立 |
| 组织配置了 connector tool 上限 | engine 从该工具取得 ceiling，问题字段固定 | Hook 自己写的 ceiling 丢弃；core/每层 Hook 结果均用 e.ceiling |

上游 `decision` 仍是 allow/ask/deny；ask 交给当前模式的 decider。上游声明允许
Hook 改变任一方向的 decision。DevClaw 既有 D01 有明确区别：最终宿主的强制
deny/ask 不能被可选插件改成 allow。本稿保留 D01，不把新增 ceiling 当成移除该门的许可。

`tool`, `input`, `tool_use_id`, `agentId`, `ceiling` 全是问题身份。
`next` 中省略原有字段须补回原值；改变或添加不存在的身份字段按现有 pinned 错误与
可选 Hook recovery 规则处理。省略没有产生第二次工具调用或新的循环身份。

`hook?: string` 是原版结果中的信息字段。实际 addon 中 Hook 自填 `PreToolUse` 与
`OtherHook` 均保留，query 自填 `PreToolUse` 也保留，而 classicCalls 全部为 0。因此它
不能证明 classic Hook 运行，不能用于 Harness 或任何来源准入。当前工程没有名为
`EngineToolResult` 的公开类型；此稿所说的 engine result
parser 是 `FunctionDispatcher` core 出口和 Hook 出口的权限结果解析，并非 tool.call
返回正文的 `validateFunctionToolResult`。不得把这两个解析器混为一个权限凭据。
非字符串 hook 使该可选 Hook recovery；首批仅保存有界字符串，不伪造 classic 来源。

## 当前实际路径

| 位置 | 已有事实与调用 |
| --- | --- |
| `src/main/mods/v2/tool-check.ts` | query 严格 tool/input；realCall 仅再接受 tool_use_id；结果仅 decision/reason/rule，因此拒绝 290 新字段 |
| `src/shared/mods/v2/pinned-input.ts` | tool.check 固定 tool/input/tool_use_id；原字段省略恢复，改变拒绝，须补 agentId/ceiling |
| `src/main/mods/v2/dispatcher.ts` | Hook validate 前可 normalizeResult；core 只有 validate，保护后的结果也只有 validate，不能只在最外返回补 ceiling |
| `src/main/mods/v2/session.ts` | checkTool 是真实事件入口；SDK query 的 host query、mandatory 再查和最终 publish 都独立；不会因短路 allow 绕过 mandatory |
| `src/main/mods/manager.ts` | toolPermissionHooks 对实际最终参数做 mandatory 前后检查，经 lifecycle.toolCheck 后 constrain；当前真实输入缺 agentId/ceiling |
| `src/main/mods/adapters.ts` | 模型 tool.call 从 binding.runtimeAuthority 固定 agentId，删除 trace metadata 的身份，tool_use_id 与实际 callId 固定 |
| `src/main/mods/v2/host-call.ts` | functionCallIdentity/Authority 用真实 ALS、ModCallContext 与 runtime authority 对照；SDK caller 不能用参数选择 loop |
| `src/main/mods/v2/registered-tools.ts` | registered call 的真实 identity 与 tool.call agentId 相等才 admit；准入先于 guest 执行和 durable claim |
| `src/main/mods/v2/tool-permission-host.ts` | query 使用实际原生路径/现有 MCP 元数据/真实注册 owner/schema；不 connect MCP、不执行工具、不调用 classic Hook |
| `src/shared/tool-permission.ts` | constrain 返回更严格的实际 mandatory 或 proposed；当前没有 ceiling 字段归一，必须保获胜 reason/rule 与原问题 ceiling 独立 |
| `src/main/ipc/mods.ts` | toolCheck 连接实际 Manager/FunctionModsManager；原 registered admit/publish 和现有单次 Electron 确认继续保留 |

主模型、shared child、独立 SDK agent 的实际 authority 都已存在。`agentId="main"` 是工程
内部路由，事件主循环应省略该字段。真实子调用用其原 authority.agentId，与已经固定的
tool.call 同一个值。不能用配方名、session id、公开参数、trace metadata 或插件名推测。
本稿不新增 teammate 权限模型；当前真实 agent 路径可提供 loop id，尚不存在的宿主类型
不能通过字符串模拟成实际 teammate。

### 查询和实际执行的区别

SDK query 在 `session.ts` 独立检查 tool owner/schema/live，再次调用 host.checkTool，
最后才 publication。query 即使从子代理 Hook 内发起，事件本身仍不带 agentId/ceiling/id；
实际工具选择与权限查验仍使用原真实 ALS，并不通过删事件 metadata 转成主循环权限。
不启动一个尚未激活的 FunctionSession，不消耗 approval cache，不领取执行账本。

真实 native/MCP 调用在 `manager.ts` request.authorize 的最终参数处走 toolPermissionHooks。
managed policy admission、runtime allow/block、readOnly/user action、实际原生权限查询均保留。
registered tool 在 `authorizeRegisteredTool` 中同样校验 grant/owner/runtime，再 admit。
其中 identity 来源为 actual host-call，而不是待解析的 tool.check e.agentId。

## 已审实现合同

### 1. 输入与原循环身份

保留 `functionToolCheckInput(value, realCall=false)` 的调用结构：query 先验证 JSON 输入，
对已观测的 tool_use_id/agentId/ceiling 做固定字段剥离，只产生 tool/input；其它未知字段
仍按现有严格规则拒绝，不从三个已观测字段推导任意键均可忽略。realCall allowed keys
为 tool/input/tool_use_id/agentId/ceiling。
新可选字段仅 own JSON data；agentId 非空字符串，ceiling 严格 allow/ask/deny，不做 String
强制转换。现有长度/预算继续沿用宿主 JSON 输入门；具体 agentId 长度与原实际 authority
上限一致，不能另设短于真实 id 的上限。真实不合格输入拒绝，不能剥字段后继续执行。

Manager 在首次 tool-check dispatch 前固定这次真实 loop 事实。模型路径读原 binding 的
genuine runtimeAuthority；registered/SDK 路径读 `functionCallAuthority/Identity` 与实际
binding 的既有对照。只有原非 main agent 才加入 agentId，并核对同一次 actual tool.call
id/loop；每个原 async 前后 authority/grant/binding/epoch/signal 检查保留。
无真实 loop 的 SDK call 仍可按现有宿主能力工作，但不从可疑 binding.agentId 自行造字段。

`normalizeFunctionInput` 为 tool.check 增加 agentId/ceiling。它只守问题身份，不提供执行
授权。省略恢复/恶意改写 recovery 必须使用同一原问题，不重新查找循环或生成新 callId。

### 2. 专用权限结果 parser

新增 data-only helper（名称可定为 `parseFunctionToolCheckResult(value, question)`）：

- 接受裸结果，不接受 value 外层；decision 严格三个值，reason/rule 保现有 8000 字符门。
- 结果 allowed keys 补 hook/ceiling；先按原 JSON/data 门取字段，不执行 caller getter。
- ceiling 从 original question 的 own 字段固定；不读下游 result 作为 baseline。
- Hook 的 own ceiling 先删除，包括不同合法值、错误字符串、数字、null 或 query 上
  自己添加；真实 addon 已确认这些值不会让该 Hook 失效。随后只恢复原问题 ceiling。
- 输入没有 ceiling 的结果最终也没有 ceiling；不把 mandatory.decision 复制为 ceiling。
- hook 在 query/core/Hook 均允许有界字符串，包括 PreToolUse/OtherHook；不把该值当作
  classic.PreToolUse 的运行来源，非字符串按原结果错误与可选 recovery 处理。
- unknown keys 与其余无效字段仍按原可选 Hook recovery/strict 规则拒绝，不宽放结果正文。

同一个原问题绑定到整个 dispatch。该 parser 必须在 core 结果、每层 Hook 正常结果、
catch/recovery 结果、保护后的结果和最终 return 处执行。每个 upstream next 都须看到原
ceiling；仅在 checkTool 最外补字段无法满足 290，也会让中间 Hook 观察到假 ceiling。
parser closure 在该 dispatch 首次进入前固定 originalQuestion 的完整 JSON snapshot；
不能由后来的当前 e、下游返回、mandatory verdict 或 normalizer baseline 重选问题。

最窄 dispatcher 接缝是加显式可选 `parseResult?(event, result): ModJson`，在既有每次
validateResult 前统一运行，现有 normalizeResult 的 baseline 与其它事件语义不改。
只 session tool.check 提供它；generic dispatcher /其它事件保持原路径。具体是否复用
现有 normalizer 需按 core/Hook/protect 全出口对照，不能顺带改变 prompt/session.append。

`ToolPermissionResult` 增加原版结果可选字段。`constrainToolPermission` 本身保原三项排序；
获胜的 verdict reason/rule/hook 保实际原值，question.ceiling 在 parser 中独立恢复。
query 的 mandatory/published 返回同样经 query question parser；host 强制 verdict 不会
因为选中 mandatory 而丢原 ceiling，也不会继承 Hook 的伪 ceiling。

这些字段都是声明式结果，不是缓存许可。最终真实 authorize 仍重新检查 mandatory，
实际审批后继续原 signal/epoch/grant/target/binding 校验；不能以先前 tool.check 返回 allow
跳过当前 deny/ask。

### 3. ceiling 的真实来源边界

当前 `McpCapabilityTool`、ManagedModPolicy、ApprovalStore、runtime allow/block 与 Harness
入口没有 organization-admin connector tool ceiling。ManagedModPolicy 的 denyTools 是本
工程托管保护，readOnly/YOLO/审批规则/项目 human_gate 也不是上游 organization ceiling。
首批生产事件 ceiling 因无来源而缺省。支持 parser、pin 与内层观察不等于接入组织政策。

不增加任意 caller `permissionCeiling`、public setter、插件结果 register 或由字符串构成的
组织身份。若以后产品接入真实 connector admin policy，须独立设计 tool definition 的
私有来源与每次 fresh mandatory 再查。该真实政策必须按自己的强制权限门执行；此稿不
凭 synthetic e.ceiling 代替政策执行，也不猜上游 raw final decision 与组织 decider 的次序。

原版 testing.Engine 允许 `tool.check` 用整个 Args<ToolCheckInput> 构造 event，可以测解析
契约；它是测试 engine 输入，不是真管理员配置的组织工具证明。

## 原审批/readOnly/Harness链保持

1. `LocalSandbox.createPermissionProbe/queryToolPermission` 使用真实沙箱路径、命令安全、
   工作树隔离、敏感目录与只读；`ToolOrchestrator.queryExecute/queryFileOp` 使用真实模式、
   permanent/session cache 的 peek。query 不 ask dialog、不 consume approval、不运行分类器。
2. request.authorize 中 deny 在 invoke 之前拒绝。ask 若 adapter 本身不负责审批才走原
   `confirmToolOperation`；adapterAsks 保留，不能因新 ceiling 重复弹两个对话框。
3. `src/main/ipc/mods.ts` 原 Electron dialog 原 signal、原参数和保护后的理由、一操作批准
   仍真实执行。mod/flow 非 read 无 user action 或 readOnly 时仍拒绝。
4. 普通原生 `ToolOrchestrator` 继续走 `runtime.ts` requestApproval、真实 broker/IPC
   `approval:request:<thread>` 与 `src/main/ipc/sandbox.ts` 的 actual response 校验。
   request 无自动超时，取消拒绝；多调用独立 resolver，审批缓存/one-shot 原样。
5. classic PreToolUse 在原真实工具执行链保留。`LocalSandbox` 对 post-hook 实际命令再做
   readOnly/sensitive/worktree 检查；tool.check allow 不允许 Hook 改参数绕过这些门。
6. Harness `requestHumanGateForExecute` 只接受原当前项目插件 PreToolUse(execute) 的
   decisionSource/hookId，actual project/feature/runtime/signal 门保留。SDK query 不运行它；
   普通 ask 不伪装该 human_gate，也不把该门记录成组织 ceiling。

本批不改 `src/main/ipc/agent.ts`、审批 broker、Harness human_gate、MCP连接、Task/Tool
执行账本或 native conversation/Model/CP保护路径。相同能力通过现有入口继续运行。

## 原版 contract probe addon（Root CPU）

新增独立 probe 文件和注册模块，置于现有真实 290 extracted-package probe plugin 下；
默认 5000 ms，使用 `claude-code/testing` 的 Engine 和实际 plugin SDK，不调用外部网络。
原 `contracts.test.ts` 保留；不使用测试 engine 构造字段冒称真实子循环或组织 policy。

1. SDK query：command Hook 调 `$.tool.check({tool,input})`，记录整个 e 与 next.origin；
   无 id/agentId/ceiling，tool.call/classic计数0；结果裸类型。
2. SDK query caller 注入 id/agentId/ceiling 各一项：真实 290 静默剥字段。DevClaw 只对
   这三个已观测身份字段同步剥离，不将其作为事件事实或实际 loop 来源。
3. testing Engine real-shaped event：原 tool/id/agentId/ceiling，两个 inline plugin 层和
   bottom Hook；每层 next/result 严格 whole-object 比较，分别 own ceiling=allow/deny/错误值，
   观察 parser 是否先删除，全部应以原问题字段为准才按证据定断言。
4. 原 agentId/ceiling 在 next 中 omission 两项分别保留；改变、伪新增、删除 tool/id 的
   strict/fallback次序，以及 tool/input完整原值、bottom actual calls1。
5. 无 ceiling 问题＋Hook自填 ceiling：所有层结果无 ceiling；core样式同测。
6. query/real-shaped 结果 hook string/错误类型，reason/rule、unknown字段、value外层，
   收集 parser 对可选 result hook 的行为；不声称 actual classic execution。
7. same model tool.call 的真 loop agentId 需要实际 agent/subagent engine 运行入口；若测试
   kit不能驱动真实 loop，标为该项未测，转真实 app child fixture验证，不用手填代替。
8. 真 organization connector 管理员配置当前宿主不存在：明确 unsupported/unrun；
   不能把synthetic Engine event或MCP返回payload变成组织 policy验收。

probe日志只固定字段名、decision/事件模式、计数和错误码；测试参数为本地 fixture常量。
保实际版本、runner命令、各失败日志和默认时间限制，Root统一运行。

## DevClaw 真实回归及生产窗口

第一窗建议生产 5 files：shared/tool-permission、shared/mods/v2/pinned-input、
main/mods/v2/tool-check、main/mods/v2/dispatcher、main/mods/v2/session。
第二窗仅 actual-loop 来源：main/mods/manager 的 toolPermissionHooks 与必要 host-call
actual身份读取；不改 IPC agent，不新增 authority。现有 adapters 的 tool.call事实原样消费。
原版 hook/ceiling 的 32 项观测已收齐；实现遵循下述实测表，组织来源另项，不进入两窗。

真实 tests 首用现有 `tool-check.test.ts` 的 QuickJS/FunctionSession 多plugin层；保原5。
新增精确输入pin/omit、各层ceiling与querynone/core/protect/recovery、protectedreason、
mandatory allow不能放宽deny/ask、foreign/no-loop与原once计数。
实际 loop 用现有 Manager/AppDB/runtime-authority 与真实 adapters/registered fixture：
main字段缺、shared非main原authority+tool.call/check id一致、nested SDK与origin独立、
旧authority/取消/审批间binding替换拒，body/tool effect1/后续模型/CP原门不减。
具体复用 `src/main/mods/runtime-authority.test.ts` 的
`serves a registered tool and nested file SDK inside a real deepagents task with the role's authority`
已存在实际子模型/ToolNode/registered/SDK准入链，新增对原 tool.call/check 的 id/agentId
整值比较及该 Hook 内 SDK query 字段缺省断言。保此 fixture 原真实工具过滤/owner、
正文/模型/账本/租约断言，不再复制另一套 child fixture。
`src/main/mods/manager.test.ts` 的实际 model ask/deny/allow 与审批间绑定替换、
`src/main/mods/v2/tool-sdk.integration.test.ts` 的真实 sandbox/authority/query 路径作为
普通主循环、无 authority 旧能力和真实只读/撤销对照；不能将这些旧门的已通过替新改动验收。

审批回归复用 `src/main/agent/tool-permission.test.ts`、既有实际 ModManager权限/Electron
工具权限回归：query dialog0/hook0/effect0，ask只原decider一次，deny0effect，readOnly写拒、
真实 Harness human_gate 保 original source；不复制几百行假Manager夹具、不加超时。
原代码变化每项要有真正行为回归，Root先窄门后 type/build、原版 addon、原真实Electron门。
若要改宿主兼容摘要须单独核当前资源摘要来源，不伪造原approval；当前稿不修改配置摘要。

没有框架不可能的证据。新增字段/pin/parser属于可落小链；当前组织 policy 没有宿主
来源，真实 actual-loop 和 DevClaw 回归尚未运行，不把它们报告成已完整实现 290。

Root DESIGN1 与 Official 正式独立 DESIGN2 已通过这两窗方向，保留原版 parser 两个未决
分支先 probe 的条件。Root 已授权准备独立 ignored addon；现 32 项观察和 runner 已冻结，
路径见 `output/claude-code-2.1.290-alignment-analysis-2026-10-06/tool-check-addon-plan.md`。
Root 已实际运行 addon：32 unique、0 conflict、completeCapture=true；32 项 intentional
observation error 导致 exit 1。这是完整观测，不是测试合同 PASS；真实 loop/组织来源不在
synthetic Engine 输入的证明范围内。设计票不是实际 loop/Electron 门通过。

## 真实 290 addon 的逐项结论

证据为同目录 `tool-check-addon-observations.unique.json` 与原 stdout/stderr/summary。
26 项 Engine full-args 和 6 项实际插件 SDK query 分开计数，所有 toolCalls/classicCalls=0。

| 观察组 | 实际行为 | 实现约束 |
| --- | --- | --- |
| baseline absent/allow/ask/deny | 各层 ceiling 始终原问题值；synthetic deny 问题仍可得到 allow decision | ceiling 归一与 decision 强制门独立，不能新增推测 clamp |
| own ceiling 5 种值及短路 2 项 | allow/deny/错误字符串/17/null 均先丢，恢复原 ask；短路 bottomCalls=0 | parse 在 validate 前执行，不能先拒错误 own ceiling |
| omission 4 项 | id/agentId/ceiling/all 省略均补原值，bottom 原问题一次 | 增补 pinned 字段，使用同一原 question |
| rewrite/add 5 项 | 改 agentId/ceiling/input、无字段时新加 agentId/ceiling 导致该 Hook recovery，下游仍原问题 | 原 recovery 不授新身份，不重新生成 id |
| own hook 3 项 | PreToolUse/OtherHook 保留，17 使该 Hook recovery | hook 仅有界信息字符串，不是 classic proof |
| nested query | 嵌套问题仅 tool/input，origin 为实际插件；随后外问题原 id/agentId/ceiling 完整 | query 不继承父事件 metadata，权限域仍原 actual ALS |
| controlled bottom ceiling/hook | bottom ceiling 被原问题覆盖；bottom hook 字符串保留 | core/recovery/protect/final 全出口同 parser |
| SDK query caller metadata 3 项 | caller id/agentId/ceiling 静默剥离，Hook/bottom 只见 tool/input | 投影三个已观测字段，绝不接受伪 loop/ceiling |
| SDK query own hook/ceiling | hook PreToolUse 保留，own ceiling 消失 | query parser 固定无 ceiling，同时允许信息 hook |

controlled bottom 是 addon Hook，不是组织 core；输入 agentId 与 ceiling 是测试常量，
不提供真实子代理或 connector 管理来源。第一窗的 parser 采用原 question snapshot
closure；每次 validate 前归一，最终保护后也重做。原审批、D01 和每次实际 mandatory
查询保留。Root/Official 已对本精度增量正式两票通过。

## 当前实现与验收范围

首五文件已接入。`createToolCheckResultParser` 在每次 dispatch 首 Source callback 前
深复制原 JSON question；Dispatcher 的四个 validate 出口前、Session 最终 publish 后、
SDK query 的真实 host 查询/mandatory/constrain/publication 出口均以原 question 归一。
原必查权限与可选恢复保留，其他事件没有 parseResult 时执行原路径。

`tool-check.test.ts` 旧5＋新21＝26定义。首次24通过/2创建失败，日志
`output/stage23-claude-290-tool-core-compat-current.log`：两个 fixture 错在同一个 guest
重复同 pattern 注册，尚未执行 parser。两票只修为真实 demo/user 与 inner/append 两个
独立 GuestRuntime，创建失败清理已成功 guest；全原断言保留。Root重跑报告26全部通过、
405ms，原失败日志保留。不能据此声称真实 OS loop、组织政策或完整审批已通过。

第二窗 Manager 仅 `toolPermissionHooks`：在首 mandatory query 前固定原 binding 的
runtimeAuthority 与真正 ALS `functionCallAuthority`；并存须同对象。每个原前/后守卫
核原地址及完整 workspace/thread/identity.agent/turn，不在 await 后重新选来源。
只有真实非main authority 加 agentId，旧无证路径省略。id仍实际 original identity。
最终 constrain 后用同原问题 parser；未接入 organization ceiling 不从 query/mandatory
返回或 readOnly/YOLO/Harness 推造。原 source/grant/epoch/审批/D01 异步检查保留。

真实回归复用原 runtime-authority deepagents Task/ToolNode/registered/LocalSandbox fixture，
比较每个 check 与实际 call 的完整 id/agent，嵌套 SDK 查询的两次真实 host query 仅有
tool/input，保原模型4次、audit3项、隔离checkout、实际childauthority/租约/最终结果。
另新增 genuine main allow/release/foreign-binding replace3定义；旧 Manager model
allow/deny/ask 三项仅加主问题缺agent/ceil断言。第二窗实际尚未运行，等待Source2和Root。
