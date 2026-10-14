# 实际 ToolRequest 的 Human 旁行保留点

日期：2026-10-05。状态：Root 与 Legacy 两位正式设计 PASS；来源基础冻结后已获
Official 与 Legacy 独立 SOURCE PASS。Root 串行实际运行本案 15 项全部 PASS；同批
Tools 17、Node 18、ledger 23、projection read 68 合计 141 项 PASS，日志为
`output/stage23-native-disposition-tool-foundation-first.log`。这些证据仅覆盖来源基础，
未接 Host 或新增 Human 写权限。本案延续已通过评审的 ToolRequest/NativeNode Work
来源合同。

## 真实完成地址与当前缺口

本机 `langchain/dist/agents/nodes/ToolNode.js` 的 `runTool` 返回真实 ToolMessage 或
Command；`run` 对各实际调用 await/Promise.all 后保留 Command update、goto、graph 等
控制信息。Command.update.messages 可以包含新 HumanMessage。不能按公开 call ID、
tool 名称、role 或 metadata 扫描 graph history 来选择这些旁行。

`function-conversation-native-tools.ts` 已在已知 createAgent 的实际 tools runnable
原 runTool 接缝捕获原 NativeNode Work ALS。它固定 original request、实际 config/read、
原 input history 地址、输出中的确切路径；`read(slot)` 还核同 Work 与 completed slot。
每个新 Human 获独立 opaque ToolReturn receipt、稳定 UUID、原请求 policy，以及固定
`{kind:"tool",tool:originalRequestedTool}` / `door:"tool-message"`。

Host.finalize 当前仍只收 ToolMessage（Host 第85行附近），因此合法 Human 会在 Keeper
前拒绝。现 Human presentation 工厂只收 NativeInput；直接借这个工厂会伪造输入来源。
已有 Human variant 的 prepare 缺 baseline 又报 WRITE_INTENT_REQUIRED，必须给本生产者
单独、完整且可执行的 fresh 行合同，不能以 generic source bits 绕过。

## 私有 ToolReturn 来源的最小扩展

在 Tools 模块新增全局私有 WeakMap，仅原 runTool 成功输出登记处可 mint。示意 API：

```ts
readFunctionConversationNativeToolReturn(
  receipt: FunctionNativeToolReturn,
  slot: FunctionConversationNativeNodeSlot,
  originalRuntime: FunctionNativeConversationRuntime
): FunctionNativeToolReturnView
```

reader 固定 original installed Tools owner、原 options.runtime 地址、request/Work/output
路径、actual completed slot 与 exact original message，核 `.read(slot)` 原所有事实，并
要求 actual Manager runtime/policy capsule 匹配。结构相同的 tools handle、相等 config、
普通 token、历史 Human、clone/同 UUID 都不能通过。runtime/target/source 检查前后及最后
纯 owner/path/Work/slot/closed/signal 尾仍保持。这个 reader 不授 target/SDK 权限、不 mint
completed slot、也不替代 Keeper receipt；泛型 fixture runtime 不能启用 Human presentation。

ToolReturn receipt 只读同次输出。每旁行独立 occurrence/once latch 在第一回调前安装，
paired Tool 的 seal 不得阻止同 request 其它已捕获 Human 的合法一次保留，也不能让
任一行失败重跑完成的原工具。unknown COMMIT 只原 claim/full row/readback，不重执行。

来源 helper `captureFunctionConversationNativeToolHuman({receipt,slot,runtime})` 在第一
回调前固定绝对 `expiresAtNs=hrtime+30s`，其所有后续 typed/raw 数据核验使用同一 cut。
`readFunctionConversationNativeToolHuman(token)` 返回私有来源的完整读取与纯 data-tail、
原 signal、policy 和这个 cut。Host 后续 Keeper 必须复用该期限，不因读取或每字段工作
延长预算；该来源不包含 saved/ACK/presentation 或提交权限。
signal 合并 runtime/target 与真 completed slot 的原 invocation cut，独立调用取消不必
等待物理运行退休；原 config/Work/slot 地址结构检查继续拒绝替换或重建 signal。

## 专用 presentation 与保护

新增 host-only `captureFunctionConversationNativeToolHumanPresentation`，参数只接上面
actual receipt+slot+runtime、actual protector、原 producer/occurrence。从 private reader
取得固定 UUID/origin/door/policy；不得接受 caller 提供的 origin、visible、Goal 或列权。
它与 Input presentation 共用纯正文 formatter 和 actual result 注册机制，来源工厂独立。

原 Human 首先通过 occurrence typed capture；missing/reused provider ID 只由这次真实
ToolReturn 的稳定 UUID 适配。before any codec/prototype method，保 Proxy/getter/method0
与 full data digest。first/final protection 的原 exact result/receipt/message/producer/policy
分别登记；最终 candidate 必须已有 actual protection receipt 才能 project/prepare。

本轮支持普通 Human side content。若带 augmented/visible user metadata，则明确拒绝本
presentation；它不是 Input source，不可据公开 metadata 读取增强可见正文。后续若真实
工具能生产增强 Human，需另有原 ToolRequest 的实际 formatter receipt，再两审接入。
无原 presentation 时不输出 raw，不用截串或完整 hidden content 代替显示。

public Hook message 的 type 为 user、door 为 tool-message、origin 为原请求工具。完整
native content/metadata/UUID/class 经原 Keeper 保存；呈现改字与 model content 的分层
保持原 Human 合同，first-protected facts 作为后续 fixed baseline。

## 新 UI 行、固定来源与原子采用

ToolReturn Human 没有原用户 submission 的 baseline。专用 private Human variant 增加
只由该工厂开启的 fresh-tool-side 模式，允许原 Keeper txn 分配真实 bucket ordinal：

- id/role 固定为该旁行 UUID/user；created_at 固定 canonical row.createdAt。
- content 来自 final protected ordinary Human 的纯 user formatter；stamp 来自真实 row。
- 使用专用、固定的 native tool-side writer 来源位，不借用户/Goal/composer priority。
- reasoning/tool_calls/call/name/status/is_error、prompt_origin、Goal/window 均按此 user
  producer 的明确空值合同，不从 Human metadata 或当前 thread 猜，也不借 paired Tool
  的真实执行 status/artifact。recovery_integrity 由实际 formatter 完整性决定。

本案提出的 fresh 23 列固定值如下，须在两审中明确批准，不由 generic Human 默认值
或公开 flags 提供：

| 列 | 实际来源或固定值 |
| --- | --- |
| thread_id | 原 actual runtime.destination.threadId |
| message_id / role | 原 ToolReturn UUID / `user` |
| content_json | 最终 safe ordinary Human 的一次 user formatter |
| function_row_json | 原 actual canonical row stamp |
| stream_authority | `7`，只因该 actual completed Node 提供三种完整 snapshot 来源 |
| recovery_integrity | formatter 完整为 `1`，截短为 `0` |
| created_at | 原 canonical row.createdAt |
| ordinal | 原 Keeper same-txn bucket 分配 |
| provider_source_id / provider_occurrence | `null` / `null`，不冒充模型 provider occurrence |
| prompt_origin_json / reasoning / tool_calls_json / tool_call_id | 均 `null` |
| name / status / is_error / content_priority | 均 `null` |
| goal_id / active_window_id / start_at / end_at | 均 `null` |

完整23列由原 canonical/projection receipt 同 Keeper txn 验证，fragments/state=0。已有相同
UUID/raw/alias 行仅 exact actual producer 的完整 receipt 才能幂等采用，其他行拒，不能
把“缺 baseline 允许 fresh”作为通用 Human 权限。固定 fresh source 的值不由公开 Hook
修改，ToolHuman 不使用 NativeInput noBubble ledger，不把空正文当隐藏能力。

NativeAdoption 收实际 ToolHuman presentation；private variant 在 capture/prepare/claim/
verify 与当前 target/run/producer/occurrence/row origin/door/nativePayload 逐项核对。
write/verify/unknown COMMIT/final ACK 使用同 immutable plan，COMMIT 后实际 verify 才释放
held，公开取消不能早返 mutation credit。Host 每 slot Keeper.whenDrained 真终态后返回
safe Human，原 NativeNode 只替换该确切输出地址，原 graph writer 才可看到新对象。

## Command、历史与其它 class

Command 的 update 旁其它字段、goto、graph、resume，以及 RemoveMessage 原控制语义
保持；原 input history same instance 不成为新 producer。不复制历史来造 receipt。
paired ToolMessage 保原 call ID/status/artifact/execution，工具 effect 恰一次。

新 AI/System side messages 当前原 Tools ledger 明确拒绝。ToolNode 原框架能容纳某类
BaseMessage 并不代表它已有 appendix door、固定 native/rendering adapter 与合法来源。
本案不扩大到这些 class；下一独立设计应确认其真实契约与显示/protection，再接原地址。

## 所有权与真实门禁

Latest owns Tools private reader/新 ToolHuman source helper与测试；Legacy owns新 presentation
variant/纯 formatter/Adoption/Projection 窄分支；Root owns Host finalization与实际 runtime
安装；Official display/serializer 按原真实 Keeper/projection registry 读取完整 sealed 行。
已批准具体 fresh23列值和接口，避免并行写。来源基础有15个展开测试定义，使用真实
AppDB/Manager/physical lease/ToolNode/createAgent/Saver；这些尚未运行，也未接保护与
Keeper，原测试明确 canonical high-water=0，不代称完整门验收。

必须真实 createAgent+ToolNode+AppDB/Manager/physical lease+Worker protection+Keeper+Saver：
paired Tool+Human Command→tool effect1/provider2；Human Hook rewrite+full codec/23 receipt；
tool origin/request name 和两行 UUID 精确关联；并行相同 call ID 不混；历史/Remove/控制
保持；missing ID、clone/raw methods/getter/Proxy、wrong Work/slot/runtime/policy拒；增强
metadata拒不 raw fallback；held finalization→messages/values/CP无 raw side行；取消/unknown
COMMIT/最终 verify failure 0重跑；actual UI/HTTP class与完整内容再由 Root 产品门验证。
