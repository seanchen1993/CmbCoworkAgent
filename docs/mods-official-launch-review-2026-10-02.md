# Mods 正式发布后的独立方案评审

评审日期：2026-10-02。工作区：`C:\ai\CmbCoworkAgent-mods-v2`，分支：`codex/mods-v2`。
本次只读本工程生产代码与官方资料，新增本评审文件；未改 UAT、生产代码或第三方实现，
未运行 build、Electron、重型测试。本文是方案与静态接线评审，不是运行验收报告。

## 结论

**有条件通过现有基础架构，要求调整下一轮交付范围；当前不能通过“已跟进正式 Mods、
内置能力可替换”的完成验收。** Claw、组件选择、宿主 Flow、旧 Plugin/Harness 适配与真实
检查回执可以继续使用。需要把正式版本核验、实际系统提示词组成和至少一项真实内置能力
的停用/替换加入交付主线。只增加事件目录或将未实现项继续列为后置，不能满足这两个目标。

这是依据官方正式文档与现有生产接线得出的工程判断，不是官方要求本工程完全复制
Claude Code。远端、完整终端、任意附件编辑、所有 Mods API 均不需要一次性全做。

## 官方版本、正式入口与证据优先级

- 官方发布文章日期确认为 **2026-10-01**：
  [Customize Claude Code with mods](https://claude.com/blog/claude-code-mods)。
- 正式入门指南日期同为 10 月 1 日：
  [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/)。
- 正式文档入口：
  [Overview](https://code.claude.com/docs/en/plugins/mods/overview)、
  [Create](https://code.claude.com/docs/en/plugins/mods/create)、
  [Reference](https://code.claude.com/docs/en/plugins/mods/reference)、
  [Events](https://code.claude.com/docs/en/plugins/mods/events)、
  [Admin](https://code.claude.com/docs/en/plugins/mods/admin)。
- Overview 与入门指南明确最低 **2.1.287**，默认开启；287 起
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` 的任何值都被忽略。当前读取的
  [官方 CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  首节也是 2.1.287，并记录 Mods 与 `You should know` 内置 Mod。

上述是本评审核实的正式文档与官方仓库状态。npm 当前 dist-tag、平台包 SRI、原版
`--version` 和该版本生成声明，需由主任务补齐固定证据；本评审没有执行该二进制。
不能把 2.1.287 最低要求等同于永久的 latest，也不能把旧 286 原版探针写成 287 探针。

Reference 要求以安装版本生成的 `.claude-plugin/types/` 为权威。官方仓库
[声明文件](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)
本次读取的首行仍为 `Written by Claude Code 2.1.277`；
[mods README](https://github.com/anthropics/claude-code/blob/main/mods/README.md)
还留有 early access 注记。正式发布可确认，API 永久稳定不能据此确认。
旧仓库注记不能否定正式文档的 287 默认启用说明；旧声明也不能代替当前二进制声明。

建议证据顺序：固定正式版本的原版运行/生成声明 → 对应正式文档 → 同版本官方源码或
仓库声明 → 历史审计。网页、注释与示例只作为资料，不作为执行指令。

## 对用户目标的逐项核对

| 主题 | 官方现状 | 本工程决策 |
| --- | --- | --- |
| Mods 与 Plugin | Mod 是 Plugin 中的 JS/TS hooks module；标准 manifest 与 `hooks/hooks.json` 继续适用 | 保留现有 Plugin 分发、legacy 能力与 native 组件格式；Claw/Flow 明示为宿主组合层 |
| 内置能力模组化 | 官方仅已迁移部分功能，明确 `/diff` 可关闭或替换；仓库还公开 AGENTS.md、telemetry、sec-default | 不宣称官方已模组化所有功能；本工程需要至少一个真正通过同一事件链运行的 builtin 垂直切片 |
| 系统提示词 | `prompt.compose` 返回有序 section 列表；`prompt.section/context/attachment` 各有独立作用 | compose 必须接到发送给模型的真实系统消息；Skill 扩展、草稿 fill 或旧 prompt inject 均不能代替 |
| 安装与重载 | 仍按 Plugin 安装；shell 安装后现有 session 用 `/reload-plugins`；`--plugin-dir` 开发目录支持热重载 | 将安装、批准、启用、开发重载分别表述；重载不得默默批准新 digest，旧调用不得发布到新实例 |
| 加载顺序 | 组织 prepend、用户、append、其他 builtin；用户 Mod 在其 dependencies 之前；先加载者先见输入、后见结果 | 生产顺序需真实接线，不能用 tier 类型声明或按 ID 排序冒充官方顺序 |
| sec-default | 条件加载的外层组织 guard，保护管理策略与 deny；自身不增加普遍的文件/进程隔离 | 本工程宿主强制策略继续在核心边界执行；不复制官方 guard，不把所有插件晋升为 trusted |
| unsandboxed | 官方 Mod 的外部访问通过 `$`，其进程访问不受 Claude Bash sandbox 自动保护 | 明示本工程文件/进程授权比官方受限；QuickJS 没有 Node/DOM 只说明执行隔离，不等于 OS sandbox |

Plugin 关系与内置迁移来自
[发布文章](https://claude.com/blog/claude-code-mods)及
[官方 Mods 源码目录说明](https://github.com/anthropics/claude-code/blob/main/mods/README.md)。
安装、启用和运行环境来自
[Overview](https://code.claude.com/docs/en/plugins/mods/overview)。
顺序、settings hooks 的位置与可恢复失败来自
[Events](https://code.claude.com/docs/en/plugins/mods/events)。
组织 guard 的条件与边界来自
[Admin](https://code.claude.com/docs/en/plugins/mods/admin)。

## 必须处理的发现

### P1：286 的历史审计不能继续承担正式版本基线

现有实施契约 73–75 行、作者说明第 3 行仍以 286 为本轮参考；286 审计使用 early-access
开关进行探针。这些记录在当时成立，保留原值和日志即可。正式发布后继续据此报告“最新
官方 Mods 已核验”会混淆版本。本工程 `src/shared/mods/v2/contracts.ts:4` 的 profile 仍是
`claude-code/2.1.278`，更不能只改成 287 就声称补齐了新增行为。

通过条件：固定当前正式包、保存完整性/版本证据、生成声明并与 286 对比；补跑新增契约的
原版窄探针，更新参考版本与逐项支持边界。宿主历史 profile 与上游 reference 可以分开
记录，必要的协议迁移必须显式处理。

### P1：整份系统提示词组成没有生产 provider

`src/shared/mods/v2/compatibility-catalog.ts:127` 起仍把 `prompt.submit/section/context/compose`
列为 unavailable；`src/shared/mods/v2/presentation-events.ts:4` 仅接 Skill 与工具说明。
生产 `src/main/agent/runtime.ts:5838` 从宿主函数生成字符串，5918、5921、5937、7298 行
分别追加 Plugin、AGENTS、额外指令与用户上下文；2421 行又组装 BASE_PROMPT/output style。
此外 Skills、memory 和动态提醒通过 middleware 加入，见 2451 行附近与 3335 行附近。
`src/main/agent/mods-model-boundary.ts:505` 在 provider 前扩展工具说明，随后仍直接发送
原来的 `messages`。因此不是“已经组成好，只缺声明”，而是实际系统消息路径尚无该扩展点。

参考契约见 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，精确字段
最终以新固定版本声明核对：facts 应来自当前请求真实 model/promptModel、surfaces、tools、
outputStyle、traits；返回 sections 各有唯一非空 id、text、shared/session scope。
共享段在会话段之前，缓存标记由引擎/provider 适配器放置，不能把个人上下文误标为 shared。

通过条件：同一份结构化 section 数据同时驱动默认提示词、实际 provider 消息与预览；
外部 Mod 能追加、删除、替换、重排宿主公开的 section，直接返回列表可替换全部可扩展正文。
下游重新拼接 BASE_PROMPT、Skills、memory 或提醒不能复活刚删除的正文。当前无 Mod 时保持
原行为；强制权限仍由宿主执行。若某类管理指令必须保护，明确该宿主差异和保护机制，
不能把受限组成器描述为官方任意替换。

至少用真实请求捕获验证主对话、一个宿主子 Agent/Flow Skill、模型切换以及 compaction 后
的输入。只手工 dispatch compose 的 fixture、改变预览或累计 token 统计都不构成通过。
如果第一轮暂不开放 context/attachment，须给出实际边界且不让这些路径绕过已承诺的
系统提示词替换效果。

### P2：tier、依赖顺序与 builtin 仍停留在局部接口

`src/shared/mods/v2/contracts.ts:7` 声明五层；dispatcher:81–84 会按层排序且固定 dispatch
快照，这是可复用基础。但 `src/main/mods/v2/manager.ts:455` 的生产来源按 ID 字典序排列，
876 行加载的每个 Mod 均为 `user`。loader:161 把 dependencies 交给作者类型读取，未形成
这里的生产链依赖顺序。类型、测试用 tier 和 native 组件数量不能证明内置功能可替换。

通过条件：宿主控制的 builtin 来源进入同一 chain；按来源确定 tier，外部 manifest、Claw
输入或 renderer 不能自授 prepend/builtin。明确同层顺序与依赖规则，缺失/循环依赖有明确
失败结果。至少一项现有用户可感知能力可独立关闭，另一个已批准 Mod 可接管该能力，默认
实现不再重复运行。UI、默认开关、旧项目与无 Mod 情况均需真实验收。

若仅提供宿主简化顺序，兼容矩阵必须明确差异，依赖该上游语义的包不能被静默当成兼容。
不用一次性移走所有内置功能，也不用将官方产品的所有 builtin 名称直接搬进本工程。

### P2：热重载的代际能力不能被写成完整开发流程

manager:717 的 invalidate 会中止检查、关闭旧会话/进程并撤销 scope；881 行起保留 host
named state，session:777 在新实例构建后触发 session.start。这些设计可支持安全的重载
生命周期，但本次没有发现对应官方 `--plugin-dir` 式自动 watch 的完整生产证明。
全工作区 invalidate 也不等于只重载修改的那个 Mod。

通过条件：先明确宿主支持手动 reload 还是另有开发 watch；文案与实际入口一致。
旧 dispatch 固定 chain，重载后调用只能到新实例；旧 UI action、模型返回和进程结果均
不能穿越代际。具名 state 按已声明合同保留，模块局部状态重置；重载失败有可见原因，
不绕过源码 digest 批准与组件选择。自动开发 watch 可分期，不能虚写已完成。

### P2：组织 guard 和执行 sandbox 必须区分

官方 sec-default 在有 managed settings 或 Team/Enterprise 身份时默认最外层加载；
managed prepend 列表会替代默认，需要显式列入 guard 才保留。它保护管理策略和 deny
规则，却不把 Mod 自己的 `$.fs/$.process` 纳入 Bash 工具的规则，详情见
[Admin 的默认行为](https://code.claude.com/docs/en/plugins/mods/admin#know-what-happens-by-default)。
入门文档的模块 compute sandbox/no Node 与官方声明的 unsandboxed 不矛盾：前者是计算
运行时，后者是外部系统访问。不能用“QuickJS 沙箱”推导所有 host 进程已经受 OS 隔离。

本工程在 manager:3012、runtime-tool-access.ts、file-access.ts 与 process 授权边界已有
宿主强制检查，应继续保留。插件可组合性无需通过移除这些检查实现。通过条件是明确
本工程 bounded-host 差异，并测试 compose/顺序/重载不能扩大权限；精确依赖官方
unsandboxed 行为的插件需要准确的不兼容说明，不能自动提供无限制宿主访问。

### P1：旧四方向的未完成运行验收依然是交付阻塞

统一交付报告仍写最终验证进行中；架构评审记录 Autobiz 真修复旅程审批被取消、尚待原场景
复跑。新增正式能力不能覆盖这个阻塞，也不能把已列出的全量失败改写成全绿。
上述来自现有本地报告，本次未重新运行，因此不推断当前运行问题仍然存在或已经修复。

通过条件：主任务完成原承诺的真实修复/复测、旧 Plugin/Harness、完成证据、取消和草稿
保护旅程；新增功能经过窄回归后统一冻结，再串行执行最终检查。既有环境失败与新增失败
逐项比较，原始日志保留。计划、代码评审与测试脚本存在不能替代结果。

## 建议的修订实施顺序与验收门槛

1. 固定正式版本并补原版契约核验。将此次已验证的正式 URL、启用方式、安装/重载入口与
   版本分层写入作者指南和兼容矩阵；286 历史报告保留。
2. 建立宿主结构化 prompt section 的一个数据源，先打通生产 compose/section 与 provider，
   再整理主/子运行、Skills/memory、动态提醒和预览。每项行为更改都有真正的边界回归。
3. 把一项真实宿主内置能力迁入同一 builtin 链，补可信来源、选择/关闭/替换与明确顺序。
   保留 Claw、Flow 和旧 Plugin，避免把新的模块化能力变成另一套平行配置。
4. 整合实际开发重载边界与权限差异。中间件普通失败恢复仍遵循已有规则；强制宿主策略
   必须在 core/capability 保持有效，不能只依赖一个可能被跳过的可选 hook。
5. 完成原四方向与新增模块化的一次最终交付：实际模型请求证据、真实 UI 操作、默认兼容、
   卸载/撤权/取消/重载反例、同负载性能与最终检查原日志。

方案复审可以在 1–4 的契约、实现落点和可执行验收用例明确后通过；完成验收必须等上述
用例实际运行并关闭新增失败。不要求第三方实现复制，不接受“事件已注册”作为功能完成。

## 对主任务修订方案的追加评审

主任务提出保留 Claw/Flow 与受限授权内核、固定 287 正式基线，本轮补 compose/section，
尊重已应用 Claw 数组顺序，并将 output-style 做可信 builtin。**这一最小修订方向通过，
实际完成仍取决于下列条件。**

1. 最终发送边界放在 model-boundary 的 provider core。先解析 `turn.step` 实际模型和
   工具说明，再读取当前请求的系统消息、运行 compose/section、重新组成请求，最后对
   变换后的 messages/tools 检查输入预算并发送。不能只拦 runtime 初始字符串。模型事实
   来自已经解析的当前请求，插件不能改成与实际 provider 无关的值。
2. 从宿主数据组装稳定 section，避免从已经拼好的正文按标题或正则拆出“memory/AGENTS”。
   保留来源与需要的非文本 block；无法安全支持的形状明确拒绝，不能悄悄丢 block 或转成
   `[object Object]`。compose/section 先后与新增 section 行为须由 287 原版窄探针确认，
   不由 reference 的简述自造完整语义。
3. 进 guest 前和返回后各做内容保护；取消、撤权、失效不能退回原文。实际发送与预览用
   同一最终快照。自动事件 provider 与 `$.prompt.compose()` 主动 helper 分别登记支持；
   主动组成本身不发送模型/写 session，hook 自己显式调用模型仍须按原账本和权限执行。
4. 来源明确属于企业 managed 的文本可以单独保护。普通项目 AGENTS/CLAUDE、Plugin
   prompt inject 与显式选择 Skill 的说明不因位于项目中自动成为 managed。项目绑定、
   完成底线、阶段许可与工具权限在 host 状态保持强制执行。`managedExecution` 是后台
   执行模式，不是企业 managed 指令的证据。若本工程没有这种可信来源，不应凭空发明
   一个 managed section 将全部项目规则锁住。
5. output-style builtin 必须统一拥有风格 identity、正文和每轮 reminder。目前
   `createOutputStyleTurnReminderMiddleware` 通常往 HumanMessage 或 ToolMessage 追加，
   仅异常形状退为 SystemMessage；只在 compose 删除风格正文仍会留下风格提醒。关闭
   builtin 后三者都应停止；用户 hook 接管后的替换范围必须明确，默认行为保持一致。
   不按标题删除历史消息、不改用户真实正文，动态提醒只处理本次宿主组成的内容。
6. builtin 来源是宿主代码固定身份，tier 不能由外部 manifest、renderer 或 Claw 输入
   自授。数组顺序可作为宿主明确支持的组合顺序；若 dependencies、managed prepend/
   append 尚未实现，仍保留对应兼容差异，不能把修复字典序写成完整官方加载顺序。
7. 新模块验收至少覆盖主对话与一条 Flow 子 Agent 请求、风格关闭/替换、两插件输入/
   输出顺序、模型切换、缓存 scope、重载后旧结果、取消/撤权及无 Mod 默认路径。
   原 Autobiz 真修复失败链路继续由主任务串行处理，不被追加范围替代。

## 已读本地资料与未做事项

完整阅读本轮实施契约、统一交付报告、286 原版审计，并核对架构评审、作者说明与兼容
矩阵相关条目。静态追踪了 loader、manager、dispatcher、session、prompt SDK、生产
runtime、model boundary、presentation events、runtime 工具授权和 native Flow finalize。

本评审未执行任何构建、产品启动或测试；文中代码行号对应评审时工作副本，主任务继续
修改后应以符号和路径复核。所有网页仅使用 Anthropic 官方站点或 `anthropics` 仓库作为
结论来源。搜索引擎偶尔返回第三方条目，未引用或据其实施。

## 287 精确范围的二次独立审核

以上“未执行”描述对应首次评审时点。随后主任务授权本评审 agent 实施内置上下文计量、
Claw 保存顺序和相应测试；生产 prompt/session/provider 边界仍由主任务实施。当前契约为
`docs/mods-launch-adjustment-contract-2026-10-02.md`，本节覆盖此前 output-style builtin
建议：**改用全新的 context-meter 作为第一项可信 builtin，方向通过，不要求本轮迁移
多路径 output-style。代码落地与真实验收仍为条件通过。**

原版 287 的最终探针结果为 **无 flag 24/24、带 flag 24/24**，两次退出码均为 0；
20/20 是早期探针数量。已读取 `probe-results.json` 及两份实际日志，不将其代替本工程
的实际运行证据。最新明确事实是 `prompt.compose` 返回 `{sections}`，`prompt.section`
是 Hook，独立 `$.prompt.section()` 不属于实际官方插件 SDK。本工程 SDK 只承诺
`$.prompt.compose()`，新增段不需要在 compose 返回后再次通过 section Hook。

已静态检查的新落点：

- Provider core 先解析 `turn.step` 实际模型、描述实际工具，再组合完整系统消息和重新
  计量最终 messages/tools；无变更保留原对象，非文本内容变更明确拒绝，发送后不会
  在此边界再次追加旧 system prompt。`cmb:system:<index>` 是实际消息边界的 identity，
  不宣称已区分每种 memory/output-style/project contributor。
- 全部项目规则保持普通可组合文本；工具权限、完成底线、运行租约和组织内容保护仍在
  host 强制执行。仓库没有可信企业 managed prompt 来源的证据，不能临时把所有项目
  规则改称 managed 后锁住。将来接入 managed 来源时必须有明确来源字段和核心保护。
- Notification 新增的 `functionSessionId` 只从宿主运行的真实 child thread 设置，Function
  Hook 使用 child scope，旧 command/http Hook 仍收到原 approval owner 的 context。
  静态检查未发现此字段来自 toolArgs 或 guest 输出，也未将父线程批准转授给 child。
- 内置源码为应用固定实现，单独记录可信 plugin 对象，tier 为 builtin，仅开放 usage 和
  必要 UI 方法；外部 manifest 仍为 user，保留名称被拒绝，不能通过输入自授 builtin。
- `ClawProfile.builtins.contextMeter` 保存和应用快照默认为关闭。没有上传插件也能发现
  ready，并经相同 guest/dispatcher/AbovePrompt 管线启动；不生成虚假外部批准 grant。
  `$.session.usage()` 使用宿主当前 response 的上下文输入用量，缺失时让出，未改成累计量。
- 已校验来源按 capabilities 的数组加载；无 Claw 的旧路径保持来源 id 顺序。状态检查
  仍核对 source id/name/digest 和批准，不因排序改变绕过组件或强制完成策略。

本次生产 prompt 静态审核提出并跟踪的验收项：

1. SDK `args.model` 不能成为新的 pinned 基线而覆盖绑定的真实请求 model。应明确拒绝
   与绑定 model 不一致的值，并有实际 SDK 调用的反例。
2. 绑定 core 闭包必须在入口及返回前无条件检查原运行租约和 signal；不能只在逐个
   section 的循环内检查。空系统消息请求也必须在原运行失效后拒绝 SDK 调用。
3. 新增代码的定向回归、独立页面脚本、Electron focus 和完整集成尚须实际运行；本 agent
   按主任务串行资源限制未启动构建、Electron 或测试。测试脚本存在不是通过证据。

已准备 `builtin-context-meter.test.ts`、`claw-order.test.ts`、Claw IPC/upgrade 回归、
`tests/mods-builtin-claw-browser.spec.ts` 和 `builtin-context-meter` Electron focus，覆盖
零上传、真实 usage、旧绘制回收、user 直接替换/next 包装、保存顺序与外部 tier 声明。
当上述两项 prompt 边界反例闭合且定向/真实运行全部通过，再给最终通过结论。

后续静态复核：主任务已经为第 1 项加入 `input.model !== request.input.model` 的明确
拒绝及 SDK 反例；第 2 项已在 core 入口/返回前无条件 assert，并增加捕获空系统 core 后
原 authority 失效的反例。两项代码阻塞已闭合，实际回归结果和统一验收仍由主任务记录。
首轮 builtin 窄测的真实渲染、next 包装与保存顺序通过。fixture 最终修正为 usageArgs
默认 `{}`、在原 5 秒预算内等待异步 UI 刷新；tier 检查通过实际 `$.tool.register()` 注册
`claim_tool`，再由 `tool.describe` 读取宿主映射的 `provider.tier` 并断言 `user`。
外部 manifest 声明 builtin/prepend 不改变该事实。用户 tier 无权使用 `next.to(...,
"builtin")`，因此此前这种测试方案已撤回；保留首次失败以供结果比较。

## 最终静态代码评审结论（2026-10-03）

**本轮 287 精确调整范围的代码评审通过。** 提示词模型事实、空系统消息的旧请求租约、
最终输入预算与预览落点均已复核；可信 builtin 固定来源、默认关闭的 Claw 应用快照、
无外部 grant 的独立启动、用户替换/包装与能力数组加载顺序符合已批准契约。
本次复核未发现仍需阻塞上述代码范围的缺陷。

已确认的运行证据限于以下范围：

- 原版 2.1.287：`output/claude-code-2.1.287-launch-analysis-2026-10-02/` 中
  `no-flag-probe.log` 与 `with-flag-probe.log` 均为 24 pass / 0 fail。
- 本工程 builtin 单元回归：主任务串行运行报告 **8/8 通过**。实际 tool provider tier
  用例使用上述最终版本，并非已撤回的 tier 跳转用例。
- 本工程真实 Electron：`output/mods-launch-final-validation/electron-builtin-context-meter.json`
  退出码 0；`output/mods-validation/e2e-builtin-context-meter/result.json` 记录 **5 项通过**：
  Mods 默认关闭、零上传插件启动及真实 usage、保存/应用后停用清除、user next 包装，
  以及保存顺序变化后的直接替换。对应日志已只读核对，未重新启动产品。
- 独立 Claw 页面：`output/mods-builtin-claw-browser/report.json` 的启用/停用快照与顺序
  编辑两项检查通过，页面 errors 为空。

以上支持本轮代码评审通过，**不代表完整集成交付已全量通过**。其他最终类型、lint、
构建、性能、Autobiz 真修复以及旧 Plugin/Harness 实机回检结果由主任务交付报告记录。
Feature 页面导航等待曾把实际 `role="tab"` 的“项目模式”按 button 查询；截图和源码
确认是测试选择器问题，已交由主任务按原预算修改并复测，不据此宣称路由或 UI 已损坏。
本评审 agent 仅完成静态复核和本文件更新，未运行构建、Electron、npm 或重型测试。

## Flow 独立子 Agent 请求补充评审（2026-10-03）

后续真实 Autobiz 验收发现新的接线缺口：已批准并应用的 report 组件完成了跨插件汇报，
但实际携带 tools 的 Flow 子 Agent HTTP 请求缺少其 `prompt.compose` marker。
`output/mods-autobiz-e2e/failure.json` 保留此失败证据；此前主对话和 builtin 验收不能
代替这条子请求的验证。根因是生产模型 wrapper 和 `functionModelStream` 都曾只允许
`agentId === "main"`。不是完成规则 owner 排除了其他 Hook：临时完成策略仅选择
`completion.check` 的参与者，不改 active Claw、已加载插件或组件投影。

**当前独立子 Agent 修复的静态代码评审通过；此前提出的代码阻塞已闭合。** 复核范围为
宿主通过真实 authority 创建的独立 child runtime，包括 Native Flow 的子线程请求：

- 非 metadata runtime 可以安装相同 provider wrapper。factory 使用实际 authority 的
  agent/turn identity，调用方传入的标识不能替代宿主事实。实际模型和 tools 之后仍执行
  compose，变换后的 messages/tools 仍接受最终输入预算检查。
- child 仍进入 Function manager 的同一受保护 stream scope，仅由 host-only
  `dispatchHooks=false` 关闭 `turn.step` guest dispatch；main 保持 true。会话生命周期、
  snapshot grant、session generation、根配置 epoch 和 exact authority 都保留检查。
  source/Claw 数组及临时完成规则 owner 没有因此扩大或缩窄。
- Function session 合并生命周期 signal，`assertTransportLive()` 只供宿主调用；每次
  provider pull 前后及异步 publication 返回后重新检查 scope 和 signal，再交给消费者。
  不通过裸 empty dispatcher 绕过已有撤权与内容保护。
- SDK 绑定改为以真实 `ModRuntimeAuthority` 对象为键的 WeakMap；内层 composing frame
  也必须匹配同一 owner。未绑定、过期、不同 owner 和不同 model 明确拒绝；调用 signal
  与原请求合并，core 和 SDK 返回再次检查 owner，不能借用同线程其他 Agent 的请求。
- child 初始化与 pull 在自己的 fresh host scope 内进行；return/throw/asyncDispose
  通过宿主 facade 完成 cleanup。失效后的清理退出祖先 calls、modCallContext 和
  writeLease，保留 `active=false` 的原 owner tombstone，SDK 报
  `MODS_CALL_SCOPE_EXPIRED`，不会回落为 main 或获得新的授权。
- child model activation 不更新主会话模型；前置 preview middleware 和最终 preview
  都限制于 main authority。metadata/catalogue assembly 保留原行为。

本 agent 新增 `src/main/mods/manager-child-model-stream.test.ts`，第一轮 8 个案例覆盖
main/child 的真实 authority 和 dispatchHooks 分流、child consumer return/throw 的
cleanup owner、失效 cleanup 不借用 main、精确 authority replacement 主动取消 pending
provider、关闭及重新启用 Mods 后旧配置流不得恢复。主任务上一轮定向运行报告为
52 pass / 2 fail，两项失败是本文件错误码期待与既有 host fence 不一致，已精确修正为
`MODS_CALL_SCOPE_CHANGED`。主任务随后实际串行运行的
`output/mods-launch-child-unit-final.log` 已只读核对：**14 个测试文件、180 项全部通过**，
包括本文件增强后的 **8/8** 和 `prompt-owner-isolation.test.ts` 的 **8/8**。
Node/Web typecheck 与 E2E build 通过由主任务报告；本 agent 自身未运行这些命令。

**共享 thread 的 task 子 Agent 尚未由本轮真实验收确认。** deepagents 共享模型、共享
线程并行 task、注册角色及其动态模型选择需要独立验证，不能从独立 Flow child 的
wrapper 扩展推断它们已完成相同接线，也不能宣称已覆盖 Claude 的全部 child/teammate
分支。按 authority 隔离的 SDK 请求结构为这种并行提供必要边界，但不是运行证据。
上述补充评审时，原始 Flow HTTP marker 失败的真实 Autobiz 复测尚在主任务执行中；
最终通过证据见以下主任务运行补记和冻结复核。本节不撤销失败证据，不删除断言，不宣称
完整交付绿色。本 agent 未启动任何测试、构建、Electron 或 npm，只编辑所拥有的
独立测试和本评审文档。

## 主任务最终运行补记（2026-10-03）

本节由主任务根据冻结后的实际运行记录补记，不代表本评审 agent 自行执行了测试。
原版 2.1.287 的无 flag/有旧 flag 探针各 24/24、SDK section 边界 1/1，与本工程的
运行证据分开记录。

`output/mods-launch-final-validation/final-selected-report.json` 记录 10 套 Electron、
81 项检查，5 套浏览器交互和 3 套性能专项全部通过。曾失败的 main compose/UI log
及独立 Flow child HTTP marker 已真实复测通过，保留第一次失败和原断言。20 文件、
254 项定向测试通过，增强后的 `manager-child-model-stream.test.ts` 共 11 项通过；
`prompt-owner-isolation.test.ts` 8 项通过。Windows 清理/主子 owner 的后续 20 项及
provider 协议 14 项复核通过。类型检查、定向 lint、普通构建通过；九条 standalone
链另行全部通过，普通产物无 E2E 宿主入口。

全量结果仍如实保留：713 文件中 708 通过、5 失败；5,751 项通过、12 失败、5 跳过，
无未处理错误。11 项存量失败未修改；历史 Windows 测试临时 EXE 清理 EBUSY 增加
有界重试后 9 项定向通过，不冒称又一次全量绿色。全仓 lint 仍有存量错误。此补记不
扩大审批范围到共享 thread task 或全部 complete/classify/fork 提示词贡献管线。
完整结果和限制见[最终报告](mods-official-launch-implementation-2026-10-02.md)。

## 独立冻结静态复核结论（2026-10-03）

**冻结后的 main 与独立 Flow child 请求边界静态评审通过，无剩余代码阻塞。**
本评审 agent 再次只读核对生产代码及夹具，并确认此前 main SDK compose/UI log
缺口已经通过宿主真实请求入口修复；该结论的范围没有扩大到共享 task 或其他模型调用。

- `functionModelStream` 的初始化、每次 pull 和 live cleanup 统一进入
  `withFunctionTransportExecution`，owner 固定为宿主提供并在注册表核验的真实
  authority。该专用入口退出祖先 calls、modCallContext 和 writeLease，再创建
  fresh scope；`userInitiated=false`，不能继承调用方的用户写入授权。普通 Agent
  入口未被替换，也没有放宽原 `assertWriteLease`。
- main 保留 `dispatchHooks=true`，独立 child 仅关闭主请求 `turn.step` guest Hook。
  两者仍通过同一 v2 lifecycle，保留 exact authority、配置 epoch、snapshot grant、
  session generation、signal 和异步 publication 后检查。真实 factory 固定 agent/turn；
  child 不覆盖主会话模型或 preview。
- facade 的 return/throw/asyncDispose 保留资源回收；live cleanup 使用自己的 owner。
  expired cleanup 清除祖先 receipt 和 writeLease 后使用原 owner 的 closed tombstone，
  SDK 明确报 `MODS_CALL_SCOPE_EXPIRED`，不会回落到 main 或重获授权。
- SDK compose 的请求绑定仍按真实 authority 对象隔离；未绑定、过期、跨 owner 和
  model 不匹配的调用拒绝。compose 与 section 返回继续走内容保护和最终输入预算。
  本轮没有把 completion.check owner 误作 Hook 能力筛选，也未放宽 Claw/source 选择。
- Windows missing-bootstrap 夹具只在 finally 清理加入已有的有界 rm 重试。
  126、空 stdout、缺 bootstrap 和不得进入 shell-start 路径的断言及原预算保留；
  重试耗尽仍抛错。provider 夹具的三个空 assertScope/assertLive 改为 `vi.fn()`
  仍返回 undefined，不改变协议行为、失败断言或执行期限。

只读核对 `output/mods-launch-final-unit.log` 确认 **20 文件、254 项通过**，本 agent
拥有的 owner/cleanup/writeLease 测试已增强为 **11/11**；provider 后续日志为 **14/14**。
presentation 真实日志及快照包含 compose facts 和完整 Skill body 的 head/tail 标记，
原 `bodyLogs.length > 0`、HTTP compose policy 和 Flow child marker 断言都保留。
其他冻结运行证据见主任务补记；本 agent 未重新执行测试、构建、Electron 或 npm。

**共享 thread task 子 Agent，以及独立 complete/classify/fork 的全面 compose 管线仍未覆盖。**
不得由 main 与独立 Flow 的通过推断这些分支完成接线。全量 npm 的 12 项失败与全仓
lint 的存量错误继续保留，不把后续窄测通过改写为全量绿色。主任务最终报告确认冻结
类型检查再次通过；全仓 error-only lint 实际仍有 **100 errors**，按文件、规则、消息与
`output/claw-sources-full-lint.json` 基线逐项比较为 **新增错误 0**。这不是 lint 通过，
也不能由 error-only 输出推断 warnings 消失。
