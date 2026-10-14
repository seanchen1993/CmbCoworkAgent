# 插件组件选择架构评审

结论：**最终契约及当前后端实现通过，未发现新增阻断**。本评审在
`C:/ai/CmbCoworkAgent-mods-v2`、`codex/mods-v2` 完成，不操作 UAT，保留累计修改。
对应设计见 `mods-component-selection-contract-2026-09-30.md`；真实 Electron 与全量验收
仍由主任务统一记录，以下专项证据不代替全量。

## 设计收敛

原 loader 将模块合并成一个 bundle，单包单 guest；在注册 Hook 后过滤不能阻止未选模块的
顶层代码。最终采用仅 native manifest opt-in 的独立组件入口，每个入口单独编译，完整包摘要
覆盖全部组件源码；运行时仅组装选中入口，禁止直接或经 helper 导入其他组件入口。依赖必须
由用户显式加入，宿主按稳定拓扑顺序注册，不通过自动添加依赖扩大选择。

未声明组件的旧包保持原编译、摘要和整包行为。组件包禁止混用原 entry，公共初始化由作者
声明为依赖组件。组件不产生独立 grant，不隔离同包状态或权限；公共 helper 跨独立 bundle
也不承诺模块单例。首次批准与主动兼容检查保留既有独立全包注册探针，因此“未选入口不执行”
特指业务实例，不能扩张成批准阶段也零执行。

配置只进入所属组件的 register 参数。每个 action 通过唯一 actionIds 归属组件；静态目录
可以展示全部已批准动作，但实际准备与调用必须在当前投影内。旧包摘要不是选集摘要，两者
在数据结构、授权判定和审计中保持区分。

## 实施检视

- `v2/manager` 的 Snapshot 同时保存完整 compiled、真实 grant 和运行 projection。
  code/options/environment/clients/actions 都取投影；原 loadClient 读取全包资源的路径已收窄。
- 主进程在保存/应用前和加载业务实例前检查显式依赖闭包及组件配置，真实动作准备与运行
  再次检查动作属于当前投影。组件切换或仅修改配置，都使旧命令和 prepared action 失效。
- 宿主 check/repair 强制策略要求 all 或缺省 whole；selected 即使列出当前全集也拒绝。
  设置强制规则读取可信线程 identity 的绑定，不读取旧项目 active。所有同项目实例仍按原有
  语义取消完成证据并标记 freshness；仅新增 check/repair 下缺少目标包或显式 selected 的线程
  实例关闭，防止旧部分投影继续执行。whole/legacy 与 off/report 不被无谓中止。
- `control-store.getGrant` 每次返回独立对象。新的宿主 WeakMap 在该 session 的真实 grant
  对象上关联有效 ids、selectionDigest、workspace/thread 及 liveness；不修改 grant，
  不创建虚假授权。`functionCallIdentity` 统一附加可信审计字段，模型与工具链均复用该入口。
  审计记录有效组件集合，不声称每次调用精准归属于其中一个组件，也不记录配置明文。
- Flow 完成证据配置和指纹包含有效组件及选集摘要，pluginDigests 仍为完整批准摘要。
  `native-host` 实际将 scope.components 克隆进入持久化 executionPlan，旧包不新增空字段。
- 独立复核质量 agent 的 shared/ClawComponentSelector/ClawPanel/IPC 通过：版本与身份
  检查、依赖提示、明确加入操作、未解析草稿阻断与移除确认、线程切换代际、CAS 与保存后冻结
  语义均保留。UI 可用状态不替代宿主授权。质量 agent 也独立复核了本评审者的后端实现。

## 专项证据与失败记录

- 首轮 `output/mods-components-manager-tests.log` 保留 19 通过、3 失败：测试将批准时
  全包注册探针误计为业务 guest 加载，并在探针阶段使用了必抛错入口。按真实契约修正 fixture：
  保留完整批准，使用未选入口的顶层 marker 证明业务实例不执行它，没有放宽生产或授权。
- 随后的 `output/mods-components-manager-tests-final.log` 保留一次新增 native-host
  测试误用 prepare 参数的失败；修正 fixture 为现有四参接口。
- `output/mods-components-backend-tests.log`：6 文件 **143 项通过**，包括旧 manager、
  completion-policy、真实 QuickJS action config、host-call 和 native-host 回归。
- 补充与实际 IPC 一致的单线程 closeThread 绑定切换，以及 config-only 重绑反例后，
  `output/mods-components-backend-fresh.log`：3 文件 **57 项通过**。7 项组件专项覆盖
  未选顶层零副作用、依赖一次初始化、配置输入、真实动作拒绝、两线程不同选集的账本身份不串、
  A 换组合不重建 B 实例、旧 action/grant/Flow scope 拒绝以及强制规则不能绕过。
- `output/mods-components-backend-typecheck.log`：Node 类型检查退出 0。之后仅增强测试
  与局部格式；最终统一类型检查由主任务执行。定向 lint 退出 0，无错误；保留累计大文件既有
  格式警告，没有为了本轮改动整份重排 manager。

## 保留边界

本轮不是自动拆解任意旧插件，也不是组件权限沙箱；当前 ordinary 本地对话边界不变，不能据此
宣布已开放传统 Plugin/Harness 的组件级组合。独立编译组件仍受整包授权、原会话资源上限、
模型协议、内容保护与取消约束。任何后续扩展都应保留这些真实执行边界。

## 根任务实现的最终只读复核

再次逐段读取 `loader.ts`、`component-projection.ts` 和 `examples/mods-component-kit` 后，
结论通过，无新增阻断，未重跑已通过的旧测试。

完整包 digest 输入仍是 name/profile/既有 modelProtocol 条件字段/hostRevision/compiler
version/code/clients/environment/captured sources。组件包的 code 包含全部声明入口，客户端
与环境取全包联合，raw manifest 和全部实际源码保存在同次 captured Map，公共 helper 不会在
多个组件编译时重新读出不同版本。legacy 路径不新增组件字段到 hash 输入。运行投影仅选择
已捕获的 componentModules，另计算包含包 digest、拓扑 ids 和规范化配置的 selectionDigest，
没有把投影摘要当成批准摘要，也没有投影时从磁盘重编译。

跨入口导入检查在真实 resolve 后执行，覆盖 helper 转引入和省略扩展名；所有组件合计受
源码、bundle、client 与环境数量限制。示例使用显式 matcher 保留原重复注册规则，review 依赖
context，report 可独立选择；检视和整理真实调用默认模型，返回动作 envelope 可消费的 output。
说明文档清楚区分保存/应用、目录/业务实例/批准探针，明确不自动读取仓库、不伪称执行了测试。

九条独立回归 runner 已准备于 `output/mods-components-standalone/run.mjs`，Node 22 语法检查
通过，核对原 84 条串联命令不变。等待全量 Vitest 结束通知后启动，当前未执行。

## 全量发现的真实回归与精确修复

首次全量为 15 失败，其中 11 项匹配历史基线，4 项为本轮新增，不能归为基线或忽略。
`output/mods-components-baseline-comparison.json` 保留逐项差异。根因是最初
setCompletionPolicy 无条件 invalidate(workspace)，中止了仍合法的旧整包操作并删除其
completionGate；此前通过的专项范围没有覆盖到这一组合，初次“无阻断”结论不足以替代全量。

修复前，原封不动运行 application-completion-policy 与 autobiz-completion.integration
两文件，得到 **41 通过/4 失败**，见 `output/mods-components-policy-regression-before.log`。
四项分别为 kanban-mode/kanban-target 的应用 ownership 竞争，以及关闭后重启完成规则和
只读项目验证。没有修改这四项既有测试的断言。

最终修复保留既有 completionChecks.abort、freshness.changed 和更新通知；只在新规则为
check/repair 时，逐个检查已加载或正在加载线程的真实 Claw 选择。缺少目标包或 selected
模式才关闭该线程，其余保留原 epoch、实例和命令生命周期。读取某线程绑定失败时，该线程
按失效处理并继续检查后续线程，不能让坏 scope 阻断其他实例撤权。off/report 不额外关实例。

验证证据：

- `output/mods-components-policy-regression-after.log`：6 文件 **155 项通过**，包含原
  两文件及组件、completion manager、native-host、FlowManager 核心回归。
- `output/mods-components-policy-regression-final.log`：最终补充后 2 文件 **34 项通过**，
  覆盖 whole 在 off/report/check 下保留旧命令、partial 在 off/report 下保留实例、另一
  workspace 不误伤、空组合失效、真实 guest create 前/首个 snapshot 前的加载窗口拒绝，
  以及首线程 scope 抛错仍关闭后续 partial 实例。所有原四项失败恢复通过。
- `output/mods-components-policy-regression-lint.log`：零错误，七条累计大文件格式警告。
  质量评审者与根任务对精确失效范围及最后两个反例的交叉检查均通过。

当前修复再次冻结，结论为**上述真实回归已闭环，专项未发现残余阻断**。主任务将重新构建、
运行 Electron 与全量；九条独立链继续等待统一调度，未与全量重叠运行。

## 最终动态验收与独立链完成

上述待测状态现已完成。主任务最终类型检查与生产构建通过；七套真实 Electron 合计
**61 组全部通过**。最终全量 Vitest 为 **687 文件、5568 用例：5552 通过、11 失败、5 跳过**。
已实际读取 `output/mods-components-baseline-comparison-final.json`，确认 11 项失败逐项
匹配既有基线，additionalFailures=[]、baselineNotObserved=[]，本轮新增四项回归全部消除。
这仍不是“全仓全绿”，历史失败原样保留。

全量结束后按统一通知串行执行九条原始后续 npm 链，**9/9 全部 exit 0，84 条串联命令全部
完成，runner exit 0**。adoption、messages、hooks、plugins、task-cards、merge、workflow、
desktop-agent-baseline、im-v1 均通过；其中 workflow-engine 96 项和真实 workflow-worktree
66 项通过。Node v22.23.2、Vitest worker 环境上限 2，仅 workflow 显式使用 Git Bash。
未修改生产代码、断言、命令序列或超时，没有与全量测试重叠运行。

完整命令清单、起止时间和逐链日志位于 `output/mods-components-standalone/inventory.json`、
`report.json`、`report.md` 及各链 `.log`。最终评审结论：**本轮组件选择实现通过，无新增残余
阻断；保留本文说明的整包授权、批准探针、非独立沙箱与 ordinary 对话范围限制。**
