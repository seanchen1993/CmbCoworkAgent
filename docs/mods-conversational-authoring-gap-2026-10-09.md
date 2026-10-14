# Mods 对话式创作复核与后续方案

日期：2026-10-09。目录：`C:/ai/CmbCoworkAgent-mods-v2`，分支：`codex/mods-v2`。
本文保留实施前的官方资料差距复核与经两名medium评审的方案；下方“当前源码核对”是当时基线，不是最终实现状态。
本轮约定的受限实现与本地验收现已完成，包括最后补齐的一体化正式复用工作台和展开工具结果时的更新。本文设计愿景中的通用动态评测、任意插件自动转换、外部能力开发授权不属于已经实现的能力。最终范围与证据见 `mods-conversational-authoring-delivery-2026-10-09.md`；下表对应本轮六项验收，后文继续保留历史方案。

| 本轮验收场景 | 最终证据与限制 |
| --- | --- |
| 1. 工具调用次数 | 最新真实桌面在实际工具调用后精确显示 tools=1；坏代码检查后仍为旧版 tools=3。 |
| 2. 按钮、明细与更新 | 实际点击明细；坏代码保旧；保持工具卡片展开，源码修订3实际生效且 V2 画面和命令成功。整轮116.7秒，不声称即时。 |
| 3. 存量插件适配 | migration/RESULT.md：真实仓库计数器的旧/适配入口单次输出一致、各一次写入、原源码不变。确定性示例，不是任意插件或真实模型语义迁移验收。 |
| 4. 工具摘要及停止恢复 | 实际 ToolResult 摘要生效，停止后消失；原始检查因未展开卡片失败，同隔离历史重开后实际展开原生结果补验通过。 |
| 5. 生命周期与隔离 | 最终404项受影响回归覆盖开发状态、授权、真实排空、旧历史和配置；41项浏览器覆盖工作台部分失败恢复及旧创作/安装路径；两名medium实际代码交叉评审通过。 |
| 6. 正式复用与回退 | 同卡可见预览/安装/正式授权/Claw CAS/新会话执行 V2；同源更新V1、回退原不可变V2由公开API补验，源摘要和命令版本核对通过。 |

最新桌面原始结果59/60，另有无模型请求的原生结果补验，不改写为原始全通过。完整npm test在最后增量前的冻结基线通过，最新增量按受影响范围验证；准确计数与限制见交付记录。

## 官方能力与实际边界

- [创建 Mod](https://code.claude.com/docs/zh-CN/plugins/mods/create)：内置
  `plugin-authoring` Skill，按当前构建的接口写入会话开发目录；用户启用本会话热重载后，
  在修改轮次结束时加载。开发目录与版本化安装目录是两条生命周期。
- [概览](https://code.claude.com/docs/zh-CN/plugins/mods/overview)：Mods 是 Plugin 中的
  函数扩展，可以与 Skill、MCP 一起发布。内置创作插件本身提供 Skill；并非所有内置功能
  都已变成可以任意替换的 Mod。
- [事件](https://code.claude.com/docs/zh-CN/plugins/mods/events)：`next` 链支持观察、改写及
  自行返回结果。替换具体操作不意味着获得宿主权限；正常工具执行仍经过宿主检查。
- [界面](https://code.claude.com/docs/zh-CN/plugins/mods/interface)：通过约定的渲染位置
  增加面板或改绘消息、工具行、加载状态等，不是任意接管整个应用窗口。

## 当前源码核对

| 能力 | 现状与依据 |
| --- | --- |
| 自然语言创作 Mod | 缺少完整链路。`src/main/ipc/mods-authoring.ts` 的 generate 直接调用 `createAuthoringTemplate`；`src/main/mods/devtools/authoring-templates.ts` 把需求序列化为模板文字，没有模型生成代码。`ModCreator.tsx` 是模板与源码编辑器。 |
| 内置创作 Skill | 在本工程随包 Skill、插件与主进程源码中未找到 Mods 专用创作 Skill 及配套创作工具注册。现有 `skills/skill-creator` 与 Skill 优化评测不能等同于 Mods 创作。 |
| TypeScript 改变运行行为 | 已有实质能力。`src/main/mods/v2/dispatcher.ts` 有事件链；当前 `compatibility-catalog.ts` 将工具、命令、提示词、模型等实际适配标为 bounded，而不是全量兼容。 |
| 改绘界面 | 已有真实桌面接点。`FunctionSite.tsx`、`FunctionPanes.tsx`、`FunctionToolDisplay.tsx` 等接入聊天、工具、问答和面板；宿主原生控件可保留。并非只能显示一个独立插件页面，也不是任意加载 React 到整个窗口。 |
| 替换内置行为 | 事件范围内已有接管基础；不能据此说整个 Agent、权限引擎或所有 UAT 功能可替换。需逐一标明支持的事件、结果契约与保留的宿主约束。 |
| 保存、校验、预览、安装、回退 | 已有草稿版本、隔离预览、不可变安装版本及回退。应复用，无需重做。 |
| 当前会话自动热重载 | 未形成官方式开发闭环。`manager.ts` 的 `reloadUserConfig` 是明确的配置重载；创作安装 `authoring-install-service.ts` 通过目录锁及 idle 检查执行，之后还需授权与应用。不能把配置重载称作自动源码热更新。 |
| Plugin 转为 Mods | 已有 Skill/MCP 来源复用与 Claw 组合能力，也有迁移说明；未发现面向用户的分析、生成适配、验证和试用的一体化迁移器。 |
| 作者 SDK | 已有类型检查，但 `authoring-declarations.ts` 明确只提供封闭子集，标注参考 2.1.283；不能让模型默认照当前官网任意调用。当前运行时能力比该作者声明更广。 |
| 普通/创作者模式 | `customize-mode.ts` 明确是自定义页导航偏好；不是完整的聊天创作工作台或独立执行模式。 |

旧迁移文档含历史版本限制，不用于证明最新接口仍缺失；本次以当前源码为准。
本次为静态核对，没有重新运行产品测试，也没有验证真实模型的创作质量。

## 设计方向

### 1. 对话创作入口与宿主工具

新增随应用发布的 Mods 创作 Skill；可配迁移 Skill 或将迁移作为同一 Skill 的工作流。
用户在当前聊天描述需求即可启动，创作者界面提供“创建组件”“改造已有插件”入口，源码为高级选项。
普通使用继续保留 UAT 行为；创作模式本身不增加权限。

给当前模型提供受控工具：查询本构建能力与例子、创建/读取/修改草稿、校验、隔离预览、
请求本会话试用、读取生效与错误回执。模型通过工具结果修复代码；设置迭代、时间、token 上限，
取消后停止。复用原对话执行器，不新建第二套模型主循环。
技能文档负责工作方法，宿主服务负责执行与授权，不能仅添加 SKILL.md 后声称闭环完成。

### 2. 会话开发版本与自动应用

在应用数据目录中为 workspace/thread 建独立开发空间，复用草稿版本快照。
同一轮多次修改合并为一个候选；生成过程中不运行半成品。
在轮次结束并确认实际任务空闲后，依次完成编译、静态能力差异、候选初始化及切换。
用户首次确认本会话开发权限；后续权限范围内的修改自动更新，新增文件、网络、进程等能力
触发增量授权。开发授权与当前正式版 digest 授权分开设计，不能简单跳过源码变化检查。

编译或切换前失败时保留旧版本；旧异步回调不能更新新版本界面。
切换后的初始化若可能已有外部副作用，记录失败/未知并停止，不能声称副作用自动回滚。
监听器、定时器、面板、子任务须按版本清理，状态迁移显式声明。
确认满意后再“保存为正式组件”，进入已有版本安装/更新/回退链，供其他会话使用。

### 3. 存量 Plugin 增量适配

先扫描清单、Skill、MCP、命令、传统 Hook、脚本及设置，展示可直接复用、需适配和不支持项。
以副本或适配层产生草稿，保留原包和普通模式入口。

- Skill/MCP：保留原资产与身份，按需增加 Claw 选择及结构化动作声明。
- 命令/脚本：仅在需要可编排或可接管时生成 TypeScript 适配，明确输入、输出和失败语义。
- 传统 Hook：保留原逻辑，人工可核对地映射事件，避免旧、新路径重复触发同一副作用。
- 依赖任意 Node 包、外部连接或复杂脚本的功能不能只改 manifest 后宣称转换完成。

首个示范选择具有明确回归用例的真实存量插件；旧入口与适配后入口比较结果和副作用次数。
连接真实业务前用本地夹具验证，避免迁移检查执行用户业务。

### 4. 作者契约与可替换范围

建立本构建支持能力的统一目录，关联事件提供者、参数/结果类型、权限、渲染位置、例子和验证。
从共同定义派生作者声明与 Skill 参考资料，补齐当前运行时已有而作者声明缺少的能力。
首期优先覆盖实际创作场景，不以追平官网接口数量作为验收标准。

将已实现的 `tool.call`、`command.run`、`prompt.compose`、`ui.render` 等接管能力做成可运行范例，
包括禁用后恢复原生实现。保持宿主统一审批、凭据、存储和执行记录。
不以“替换内置功能”为由重写全部 UAT 内核或开放任意 Electron DOM 注入。

### 5. 接上现有 Harness 评测

复用已有运行记录、固定任务集、基线/候选比较、检查结果与版本回退。
预览证明模块可运行；正式保存前按变化范围运行验收场景。
运行错误和验收结果反馈给创作模型修复，需明确区分确定性校验与模型质量判断。
已有 Skill 评测仍保留原用途，不当作已完成的 Mods 自我创作能力。

## 成组实施与验收

建议将下一轮作为一个“对话创作闭环”版本连续实现，依次接上作者能力目录/Skill/宿主工具、
会话开发版本与更新、存量 Plugin 适配和聊天工作台。各环节只做必要的窄检查与边界回归，
整组接通后由两名 medium 评审分别检视运行时与产品/UAT 兼容，再集中类型检查、构建、
完整回归和 Electron 端到端验收。失败先定位和修复受影响范围，不因每个小改动重跑全仓。

验收必须覆盖用户路径：

1. “在输入框上方显示工具调用次数”：生成、校验、授权后本会话出现真实计数。
2. “改成按钮，点击打开明细”：同会话更新，无重复事件或丢失聊天；坏代码仍保留旧版本。
3. “把某个已有插件做成可组合组件”：生成差异报告，旧入口可用，新入口输出一致，副作用不重复。
4. “把默认工具结果行换成摘要卡片”：真正的渲染接点生效，禁用后恢复原界面。
5. 取消、重启、跨会话、并发生成、权限升级、初始化失败和旧回调都有可解释的结果。
6. 固定任务验证候选后保存正式版，在新会话使用，并可回退至已验证版本。

最终用户看到的是“描述 → 自动制作和检查 → 当前对话试用 → 继续描述修改 → 保存复用”，
不是依次操作草稿、版本、安装、授权、Claw 等多个管理页面。

## 运行时实施合同（独立评审后补充）

以下为本轮实现约束，不代表已有产品能力。独立运行时方案结论为 **PASS（按本合同实施）**；代码接线及真实生命周期仍需后续评审。

### 私有身份、公开请求及批准

新增宿主 `ConversationAuthoringService`，只有真实 Agent invocation 可以获得创作工具上下文。
公开 IPC/工具只传 draftId、expectedRevision、sourceDigest、操作参数；workspace/thread/incarnation
由宿主实际会话推导并前后复核。定义下列逻辑接口（名称可按工程风格调整）：

```ts
interface DevelopmentScope {
  workspace: string // host canonical key
  threadId: string
  incarnation: ThreadIncarnation
  componentId: string // host-created UUID, not a plugin's chosen name
}
interface DevelopmentRevision {
  draftId: string
  revision: number
  sourceDigest: string
}
// 以下 proof/context 只在主进程私有 registry 中有效，不能从 JSON 恢复。
requestTrial(context: AuthoringInvocation, revision: DevelopmentRevision): TrialRequest
approveTrial(trustedUserAction: UserApproval, requestId: string,
  expectedRevision: DevelopmentRevision, envelope: DevelopmentEnvelope): TrialReceipt
revokeDevelopment(trustedUserAction: UserApproval, componentId: string): void
queueRevision(context: AuthoringInvocation, revision: DevelopmentRevision): TrialReceipt
observeDevelopment(scope: DevelopmentScope): DevelopmentStatus
```

模型只能请求试用及范围内的下一候选；用户批准来自可信 IPC 的当前窗口/主 frame 与真实确认动作。
创作者导航不是 UserApproval。批准同时展示自动应用新代码的范围。持久记录绑定完整 scope、
批准 epoch、能力 envelope、所选组件；每次候选另绑定 revision/digest/activationId。
进程重启不自动复活私有执行 proof；默认需要重新确认会话开发运行，未知副作用不得重放。

`DevelopmentEnvelope` 是宿主可执行的能力集合与参数范围，而非只有 SDK 方法名数组：
文件根/读写、网络目标、进程、模型预算、敏感配置、宿主工具分别约束。无表达能力的类型直接
拒绝并给出需扩展合同的原因，不能当成通配。只读预检/静态 capability scan 不授予权限。
所有实际调用仍经宿主审批与现有执行记录；更新不得继承正式插件 secret grant。

### 当前来源和授权接点

当前 `FunctionModsManager.sources(selection?)`（约1359行）只读 `host.plugins()`，没有
workspace/thread；`hasSources` 也只看正式来源。不要改全局 `host.plugins()` 让开发组件泄漏。
新增 `sessionSources(workspace, threadId, selection, privateCandidate?)` 作为明确的运行时来源合成：
保持原 `sources()` 给正式目录、安装、配置管理使用；只有 session discovery/buildEntry、
configurationSources/freshness、registered tools/commands/panes 的真实 session 路径读取合成源。
合成源是 `{ kind: installed | development, ... }`，开发项由私有 registry 返回 immutable
source snapshot 与独立 component selection；不得写入全局 Claw。来源 fingerprint 包括开发
scope incarnation、revision/digest、approval epoch、selectionDigest。重名一律拒绝，不静默覆盖
正式插件或 builtin；UI 用稳定 componentId 显示更新前后同一开发组件。

当前 `Snapshot.grant` 与 `ControlStore.getGrant/assertGrant` 均为 workspace 级正式授权。
不得将开发授权伪造成 ModGrant 存入 mods_grants，也不得给所有开发源码开放 assertGrant 例外。
新增内部 discriminated authorization：installed 分支仍逐字保留现有 grant 校验；development
分支持有私有 proof，并在 `assertSnapshotAuthorization` 检查 scope/epoch/digest/当前 generation。
所有宿主 effect 接点必须明确分流：开发 adapter 在调用同一个宿主执行核心之前校验 proof/envelope，
普通 adapter 保留 ModGrant；不能把仅有形状相同的对象传入现有正式 host 方法冒充授权。
这包括模型/注册工具/命令/UI action、fs/process/MCP、持久存储与敏感配置。首批只开放实际
完成这个分流的能力，未接能力应在创作能力目录和工具反馈中明确不可用。

`buildEntry`（约2080行）的 readiness、selection digest、source compile、configuredOptions、
snapshot 构建及后续各个 `store.assertGrant(snapshot.grant)` 必须系统性通过上述分支接入；
正式状态查询/授权 IPC 保持只看正式来源。新增开发配置和 store namespace 至少按 scope+
componentId 隔离，不共用同名正式插件的 userConfig/secret/store。此处不是只替换一处 grant。

### 真实轮次结算及最小调度

`turnComplete`（约4257行）继续完全属于旧 session。新增宿主私有
`noteAuthoringTurnSettled(scope, turnId, outcome)`，仅在真实 Agent finally 完成输出保存、
子工具/stream/回调清理后记录；不是模型终止消息，也不是任意 SDK turn.complete 自报。
失败/取消仍可保存草稿，但默认不自动应用该轮尚未接受的候选。

复用 `thread-run-lease.ts:onLocalThreadRunLeaseReleased`（已有 queueMicrotask 通知）与
manager 的 `host.onConfigurationIdle` 接点，回调只调度并返回，不等待自身持有的资源。
调度同时要求对应 turn 的 settled 标记，lease release 单独不是“整轮完成”的证据。
`configuration-reload-lease.ts:claimConfigurationReload` 已可独占真实 thread lease、无handoff，
开发切换可复用其模式。领取失败保留 pending 等下次真实 idle；领取后每个 await 前后检查
原始 lease identity、scope/incarnation、批准 epoch、候选 revision、旧 generation、正式来源。
同一线程新 turn 与切换依赖相同真实 lease，旧 release 迟到不能触发旧候选覆盖新版本。
每 scope 只有一个 application，连续修改 coalesce 到最新 CAS revision；迟到的预检只产历史回执。

### 准备、退休、交换状态机

`queued → preflight → candidate-ready → retiring → activating → active`。
编译/类型/隔离预览在既有 Worker/utility 中执行并完整 drain。
候选使用 `FunctionSessionInitializer(candidate)`，只有本地注册/已允许只读方法；
捕获的旧 admission 不能因 activate 获得后来权限。默认不允许启动副作用；需这类启动的
候选明确返回 requires-explicit-restart，而非静默执行或永远显示 pending。

借鉴 `applyConfigurationIfIdle` 的候选集合和最终 fence，但不改变普通配置重载：
先完成无副作用准备，取得真实 thread lease 后同步关闭旧 generation 的新 operation/action
admission；已进入工作必须真实排空。常驻 timer/监听器/pane/子任务提供宿主所有权的
retireAndDrain，不能只用 foregroundSize==0。重绘等待可取消，但清理的实际终止 ACK 仍需等。
建立独立 application token 纳入全局 catalog gate，阻止正式安装在开发准备/切换中改共享来源；
此流程不调用要求全局 activeCount==0 的 commit，因此不会自锁。

最后无 await 的 scope/auth/source/revision CAS 后交换 session 指针并激活；所有新注册和 UI
绑定 activationId，旧 generation 的 act/render/event 结果一律拒绝。交换后仍须完成旧 runtime
实际停止，未排空不可报告完整成功。只保留旧源码/状态快照，不让两个版本并行接新事件。

失败语义：pre-retirement 失败保留旧运行版本；一旦取消旧资源/开始退休，失败进入 stopped
或 unknown，不声称原样恢复旧实例。允许副作用的显式 restart 必须先写 durable activating
intent，副作用失败/崩溃为 unknown，需要用户核对；不得自动重试、自动“回滚世界”。
保留 active/previous/pending/unknown 引用的不可变源码，retention 不删除这些版本。
状态迁移只能通过有界显式 schema/version 数据，不能序列化 listener、closure 或运行权。

### 正式保存及实施顺序

“保存复用”将已选择开发 revision 交给现有 AuthoringInstallService，仍执行正式准备、
全局空闲 CAS、正式 digest 授权及 Claw 选择。可由一个对话确认串联用户操作，但开发授权
不升级为其他会话授权。先实现 authoring 工具/批准和来源 adapter，再实现结算调度/安全切换，
随后接 UI 与迁移示例；各批必要窄回归，整组连通后统一类型、构建、全量与 Electron 验收。
