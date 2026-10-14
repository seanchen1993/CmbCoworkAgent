# 宿主管理 Flow 架构评审

结论：**通过以下增量方案**。本结论是设计与现有源码审查结果，实施测试另附证据。工作目录为 C:/ai/CmbCoworkAgent-mods-v2，保留累计未提交改动，不操作 UAT。

## 真实 owner 职责与必须保留的边界

1. `v2/manager.prepareFlowScope` 的插件 owner 目前保证存在已授权 snapshot，冻结整个 session、所有 selected grants、应用完成策略和 review-mode/target；fingerprint 重新编译已加载插件并捕获项目产物。等待审批期间也不能丢掉这个 scope。
2. `native-mcp` 通过 withOwnerGrant → invokeFunctionMcp → invokeFunctionCapability 进入真正 ModCallContext、权限、Hooks、保护和账本。删掉 owner 字段再直接调 transport 会绕过这些检查。
3. `completionGate.temporaryPolicy` 必须属于真实 snapshot，unit-test/e2e 的 projectCheck 也依赖真实 grant。code-review 的证据来自真实插件 completion handler，不能创建虚假的 host 插件或把空完成钩子当成检视通过。
4. FlowManager 的同项目互斥、线程租约 incarnation、冻结 saved revision/digest、审批 nonce与产物fingerprint、迟到结果禁止发布、历史运行中状态转interrupted必须维持。MCP一轮最多一次、禁止回退跨MCP、最终参数重授权和结果白名单不变。

## schema 和最小可交付闭环

- v1保留必填plugin、现有字段序列和摘要，缺plugin的schema1仍错误。现有保存Flow、Claw frozen flow和历史无需迁移。
- 新v2明确 `execution:{kind:"host"}`，禁止同时携带plugin，拒绝未知执行主体。不是把旧plugin设空或隐式降为host。
- v2支持Agent、Skill、真实plugin-action、MCP、approval，以及宿主unit-test/e2e检查。code-review用明确Agent检视步骤；autobiz-validator/stage继续留在v1并在v2 schema保存前拒绝。不能运行半截后才发现没有主体。
- host scope可以零snapshot，仍固定Function session、Claw选择、现有配置、撤权生命周期和项目fingerprint；保留当前全局Mods开关语义。真实plugin-action继续由真实owner grant执行。
- 宿主主体是仅主进程可构造的opaque HostFlowAuthority，固定workspace/thread/run/definition/runtime authority/lease，并校验取消、scope及配置变化。不可通过IPC、存储或guest传入；不能伪造ModGrant、批准host插件或放宽assertFunctionGrant。
- 宿主MCP与projectCheck复用原生dispatch与ModCallContext权限/审计/保护。无modId不是写权限；必须保留最终实参权限判定、ask/deny与用户拒绝，并对hook更新参数重验。MCP只允许已固定的唯一工具，没有fallback/辅助调用或自动重试。
- v2选中插件的强制应用完成规则仍执行completionGate，不因没有owner跳过；显式宿主检查作为额外检查，不覆盖应用规则。项目检查保留真实shell执行receipt，不能让hook伪造成功。

## 文件边界与验证要求

底层manager负责host authority和受保护的MCP/projectCheck入口；v2 manager只解耦scope owner，不引入虚拟插件；native-host/native-mcp区分真实插件主体与宿主主体。共享schema/types/templates/UI/IPC采用显式v2并将授权状态和参数提示区分，不展示占位所属插件。

验证包含旧v1 digest逐字节兼容、错误schema1缺owner、v2混合主体拒绝、零插件纯Agent/Skill/MCP/approval/check完整链；有真实动作则检查授权与摘要；等待审批撤权/取消/同ID线程重建；最终输入权限变化；MCP真实transport零重试；projectCheck真实receipt；已有mandatory gate阻断；历史interrupted与租约互斥；旧Plugin/Harness普通入口回归。

## 后续组件选择与Plugin/Harness

Claw当前capabilities选中整个Function包，不能把勾选action误称为只加载该action。未来应使用带kind+owner插件id/name/digest+稳定组件id的显式声明，并区分包级生命周期/审计hook与可调用动作；旧包未声明时仍整体加载。不应从运行时反射出来的任意hook推断组件或静默禁用session.start等动作注册依赖。Skill和MCP继续使用已实现的源码/配置摘要身份，MCP工具再pin schema和connection。

当前ordinary-only scope明确排除Harness项目、内部工作流、IM、远程线程。宿主Flow解耦不要求改变该范围，因而不与历史Plugin/Harness冲突。后续接入需明确不同workspace执行根、Plugin active hooks、Harness stage与checkpoint单一提交权、lease归属和child继承；本轮不能仅放宽isOrdinaryFlowMetadata就宣称可用于这些模式。


## 实施与最终交叉检视

已阅读最终 `mods-host-flow-contract-2026-09-30.md`，结论仍为通过。实施与上述边界一致：

- prepareFlowScope允许仅由v2分支传入undefined owner；空snapshot仍有session/generation/config/撤权生命周期。withOwnerGrant在没有真实owner时明确拒绝。captureBinding复用原指纹捕获，不改变v1证据含义。
- 原生host check记录check.started、真实validator.result及check.result，包含executionId、exitCode、outputFingerprint；运行前后CompletionEvidenceBinding不一致则记stale并拒绝PASS；finalize沿原路重跑所选检查并运行真实应用mandatory gate。
- MCP新增互斥hostAuthority getter，只在执行时取已发放token；原v1 withOwnerGrant路径保留。仍固定来源/工具/schema/连接，限制一次调用，结果仅保留保护后的text/structuredContent。
- 独立检视根线程manager中的opaque token、registry归属、lease incarnation、FunctionExecution主线程身份、配置epoch、取消与publish前后校验。flow identity使宿主写操作继续走审批，最终参数缓存和projectCheckInput仍检查真实实参，不借无modId豁免。
- 共享schema/UI交叉检视通过：旧v1canonical序列化不变，显式v2拒绝混合身份；hostAvailable仅控制UI eligibility，不能替代实际授权；旧模板和存储不静默升级。组件粒度与Plugin/Harness边界没有越界承诺。

真实测试曾暴露两个生产问题并闭环：宿主liveness再次调用ambient caller校验造成递归；无保护时成功调用的审计publication仍pending。原始失败日志保留，修复后保留原断言重测通过。后续又补充嵌套子ModCallContext的反例：父liveness固定原FunctionExecution和binding，不因合法子能力而误拒；子上下文若借host token调用入口仍拒绝。该反例通过真实stdio MCP路径运行且远端仅一次调用。

验证证据：

- `output/mods-host-flow-backend-tests.log`：首次74项中72通过，1个真实递归问题、1个fixture缺少实际policy名前缀的断言错误。
- `output/mods-host-flow-backend-tests-final.log`：递归修复后73/74通过，唯一真实publication状态问题。
- `output/mods-host-flow-backend-tests-publication-fixed.log`：新增v2主体验证后75/75通过。
- `output/mods-host-flow-backend-tests-final-guard.log`：最终3文件76项全部通过，maxWorkers=2，涵盖真实MCP、scope/mandatory和原生Flow检查。
- 定向lint无错误，累计大文件仍有格式warnings，没有整文件重排manager。两份新增native专项测试文件独立lint通过。

当前最终独立结论：**实现与交叉检视通过，无残余生产阻断**。完整类型/构建、浏览器、Electron和全仓回归由主线程统一记录，不能将以上后端专项证据等同于全量验收。

## 等待确认失效后的终态清理复核

真实 Electron 在 Skill 来源发生变更后点击旧确认，正确拒绝 `CLAW_SKILL_SOURCE_CHANGED`，但运行仍 waiting 并持有租约直到超时。这是共用 FlowManager 的真实生命周期缺陷，不能只把拒绝响应当作完成。

只读复核最终修复通过：`decide` 仅对初始 scope 活性检查以及 fingerprint/再次活性检查的异常调用 `invalidateApproval`；该方法中止本次 controller、拒绝本次 approval waiter、等待本次 `active.done` 完成清理，然后重抛原异常。清理由既有 finally 释放具体 runId 的租约并移除 pending，避免提前释放仍有执行活动的项目锁。旧 nonce、重复提交的 CAS 以及合法产物变更后重新发确认均位于异常清理分支之外，不会误杀有效运行。

保留修复前反例：`output/mods-host-flow-stale-approval-before.log` 为 27 通过、1 失败（运行未进入终态）。修复后 `output/mods-host-flow-stale-approval-after.log` 为 30/30 通过，覆盖来源失效、初始 scope 失效、旧 nonce 保持有效等待，以及并发同 nonce 仅一次成功。构建日志 `output/mods-host-flow-build-approval-fix.log` 已完成。该专项结论为通过；真实 Electron 复跑与全量测试结论另由最终交付记录提供，不以本节代替。
## 独立后续回归链完成

全量 npm test 结束后，独立顺序执行其后的 adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1 九条原始 npm 链。Node v22.23.2、worker 环境上限 2，仅 workflow 进程显式设置本机 Git Bash；没有修改源码、断言、命令顺序或超时。**9/9 链全部 exit 0，84 条原始串联命令全部完成**，包括 workflow-engine 96 项与真实 workflow-worktree 66 项。完整时间、命令与每链日志见 `output/mods-host-flow-standalone/report.json`、`report.md`、`inventory.json`。

主线程全量 Vitest 为 684 文件、5510 通过/11 失败/5 跳过；`output/mods-host-flow-baseline-comparison.json` 逐项确认 11 失败全部为既有基线，additionalFailures 为空。本轮独立后端与后续回归没有新增阻断，不将历史基线失败描述为全量全绿。